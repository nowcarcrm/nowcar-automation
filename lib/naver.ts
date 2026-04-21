type NaverApiMethod = "GET" | "POST";

interface NaverErrorBody {
  error?: string;
  error_description?: string;
  message?: string;
}

export class NaverTokenError extends Error {
  public readonly rawBody: string;
  public readonly status: number;

  constructor(message: string, status: number, rawBody: string) {
    super(message);
    this.name = "NaverTokenError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

export class NaverApiError extends Error {
  public readonly rawBody: string;
  public readonly status: number;
  public readonly endpoint: string;
  public readonly method: NaverApiMethod;

  constructor(params: {
    message: string;
    status: number;
    rawBody: string;
    endpoint: string;
    method: NaverApiMethod;
  }) {
    super(params.message);
    this.name = "NaverApiError";
    this.status = params.status;
    this.rawBody = params.rawBody;
    this.endpoint = params.endpoint;
    this.method = params.method;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[naver] 환경변수 ${name} 가 설정되지 않았습니다.`);
  return value;
}

export function isNaverCafeAutoPublishEnabled(): boolean {
  return process.env.AUTO_PUBLISH_NAVER_CAFE === "true";
}

function stringifyField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeNaverError(rawBody: string, status: number): string {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown> | null;
    const extractedMessage =
      stringifyField(parsed?.errorMessage) ||
      stringifyField(parsed?.error_description) ||
      stringifyField(parsed?.message) ||
      stringifyField(parsed?.error) ||
      (parsed ? JSON.stringify(parsed) : rawBody);
    const errorCode =
      stringifyField(parsed?.errorCode) ||
      stringifyField(parsed?.error_code) ||
      "";
    const codeStr = errorCode ? ` [errorCode=${errorCode}]` : "";
    return `Naver API 오류(HTTP ${status})${codeStr}: ${extractedMessage}`;
  } catch {
    return `Naver API 오류(HTTP ${status}): ${rawBody}`;
  }
}

export async function callNaverApi<T>(params: {
  method: NaverApiMethod;
  endpoint: string;
  body?: Record<string, string>;
  accessToken?: string;
}): Promise<T> {
  const init: RequestInit = { method: params.method };

  if (params.body) {
    init.headers = {
      ...(init.headers ?? {}),
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    };
    init.body = Object.entries(params.body)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
  }

  if (params.accessToken) {
    init.headers = {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${params.accessToken}`,
    };
  }

  const response = await fetch(params.endpoint, init);
  const raw = await response.text();

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!response.ok) {
    throw new NaverApiError({
      message: normalizeNaverError(raw, response.status),
      status: response.status,
      rawBody: raw,
      endpoint: params.endpoint,
      method: params.method,
    });
  }

  return parsed as T;
}

interface NaverTokenResponse {
  access_token?: string;
}

export async function refreshNaverAccessToken(): Promise<string> {
  const clientId = requireEnv("NAVER_CLIENT_ID");
  const clientSecret = requireEnv("NAVER_CLIENT_SECRET");
  const refreshToken = requireEnv("NAVER_REFRESH_TOKEN");

  const endpoint = "https://nid.naver.com/oauth2.0/token";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });

  const raw = await response.text();
  let parsed: NaverTokenResponse | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as NaverTokenResponse) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const msg = normalizeNaverError(raw, response.status);
    throw new NaverTokenError(
      `${msg} (Refresh Token 재발급 필요 가능성)`,
      response.status,
      raw,
    );
  }

  const accessToken = parsed?.access_token;
  if (!accessToken) {
    throw new NaverTokenError(
      "네이버 토큰 응답에 access_token 이 없습니다. (Refresh Token 재발급 필요 가능성)",
      response.status,
      raw,
    );
  }

  return accessToken;
}

export interface PublishNaverCafeInput {
  subject: string;
  contentText: string;
}

export interface NaverPublishResult {
  success: boolean;
  platform: "naver_cafe";
  externalId?: string;
  articleUrl?: string;
  raw?: Record<string, unknown>;
  errorMessage?: string;
}

function truncateSubject(subject: string): string {
  const trimmed = subject.trim();
  return trimmed.length > 100 ? trimmed.slice(0, 100).trimEnd() : trimmed;
}

function truncateContent(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 10000 ? trimmed.slice(0, 10000).trimEnd() : trimmed;
}

export async function publishNaverCafeArticle(
  input: PublishNaverCafeInput,
): Promise<NaverPublishResult> {
  if (!isNaverCafeAutoPublishEnabled()) {
    return {
      success: false,
      platform: "naver_cafe",
      errorMessage: "AUTO_PUBLISH_NAVER_CAFE=true 가 아니므로 스킵",
    };
  }

  const clubId = requireEnv("NAVER_CAFE_CLUB_ID");
  const menuId = requireEnv("NAVER_CAFE_MENU_ID");

  const accessToken = await refreshNaverAccessToken();
  const subject = truncateSubject(input.subject);
  const contenttext = truncateContent(input.contentText);

  const endpoint = `https://openapi.naver.com/v1/cafe/${clubId}/menu/${menuId}/articles`;
  const data = await callNaverApi<Record<string, unknown>>({
    method: "POST",
    endpoint,
    accessToken,
    body: {
      subject,
      content: contenttext,
    },
  });

  // 요청사항: 응답 구조 파악용 성공 raw 로그
  console.log(`[publish-naver-cafe] ✅ 네이버 카페 응답 raw: ${JSON.stringify(data)}`);

  const externalId =
    (data.articleId as string | undefined) ??
    (data.id as string | undefined) ??
    undefined;
  const articleUrl =
    (data.url as string | undefined) ??
    (externalId
      ? `https://cafe.naver.com/ca-fe/cafes/${clubId}/articles/${externalId}`
      : undefined);

  return {
    success: true,
    platform: "naver_cafe",
    externalId,
    articleUrl,
    raw: data,
  };
}
