import { createAdminClient } from "./storage";

/**
 * ============================================================
 * lib/meta.ts
 * ------------------------------------------------------------
 * Meta Graph API 를 사용한 자동 발행 모듈.
 *
 *   - Instagram Reels:
 *       1) media 컨테이너 생성 (POST /{ig_user_id}/media)
 *       2) 컨테이너 상태 폴링 (GET /{container_id}?fields=status_code)
 *       3) 발행 (POST /{ig_user_id}/media_publish)
 *
 *   - Facebook 페이지 텍스트 게시:
 *       POST /{page_id}/feed
 *
 * 발행 이력은 social_publishes 테이블에 기록하고,
 * 실패 시 Gmail(EMAIL_USER) 로 관리자 알림을 보낸다.
 * ============================================================
 */

/** Graph API 버전 (2026년 기준 안정 버전) */
const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/* ------------------------------------------------------------
 * 공통 타입
 * ---------------------------------------------------------- */

export interface InstagramPublishInput {
  /** 원본 유튜브 video_id (social_publishes 에 기록용) */
  videoId: string;
  /** Meta 서버가 접근 가능한 공개 mp4 URL (Supabase public URL) */
  videoUrl: string;
  /** 인스타 캡션 전체 (캡션 + 해시태그) */
  caption: string;
  /** Supabase Storage 경로 (선택, DB 기록용) */
  storagePath?: string;
}

export interface FacebookPublishInput {
  /** 원본 유튜브 video_id (social_publishes 에 기록용) */
  videoId: string;
  /** 페북 피드에 올릴 본문 전체 */
  message: string;
}

export interface PublishResult {
  success: boolean;
  platform: "instagram" | "facebook";
  /** 발행 성공 시 Meta 가 돌려준 리소스 ID */
  externalId?: string;
  /** 실패 시 에러 메시지 */
  errorMessage?: string;
}

/* ------------------------------------------------------------
 * 환경변수 로더
 * ---------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[meta] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

function getMetaAccessToken(): string {
  return requireEnv("META_ACCESS_TOKEN");
}

function getInstagramAccountId(): string {
  return requireEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID");
}

function getFacebookPageId(): string {
  return requireEnv("FACEBOOK_PAGE_ID");
}

/**
 * 선택 환경변수:
 * - 설정되어 있으면 가장 안정적인 고정 Page Token으로 사용
 * - 없으면 USER 토큰으로 /me/accounts 조회하여 동적으로 추출
 */
function getOptionalFacebookPageAccessToken(): string | null {
  const value = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  return value && value.length > 0 ? value : null;
}

/** 자동 발행 ON/OFF 스위치 */
export function isInstagramAutoPublishEnabled(): boolean {
  return process.env.AUTO_PUBLISH_INSTAGRAM === "true";
}

export function isFacebookAutoPublishEnabled(): boolean {
  return process.env.AUTO_PUBLISH_FACEBOOK === "true";
}

/* ------------------------------------------------------------
 * Graph API 호출 헬퍼
 * ---------------------------------------------------------- */

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface MeAccountsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    access_token?: string;
    perms?: string[];
  }>;
}

/**
 * 페이스북 페이지 발행용 토큰을 구한다.
 *
 * 우선순위:
 * 1) META_PAGE_ACCESS_TOKEN (권장)
 * 2) USER 토큰으로 /me/accounts 조회 후 해당 PAGE_ID 의 access_token 추출
 */
let cachedPageAccessToken: string | null = null;
async function getFacebookPageAccessToken(): Promise<string> {
  if (cachedPageAccessToken) {
    return cachedPageAccessToken;
  }

  const fromEnv = getOptionalFacebookPageAccessToken();
  if (fromEnv) {
    console.log("[meta] 🔐 META_PAGE_ACCESS_TOKEN 사용");
    cachedPageAccessToken = fromEnv;
    return fromEnv;
  }

  const pageId = getFacebookPageId();
  const userToken = getMetaAccessToken();

  console.log("[meta] 🔍 /me/accounts 로 Page Access Token 자동 조회");
  const accounts = await callGraphApi<MeAccountsResponse>("GET", "/me/accounts", {
    fields: "id,name,access_token,perms",
    access_token: userToken,
  });

  const matched = (accounts.data ?? []).find((page) => page.id === pageId);
  const pageToken = matched?.access_token;
  if (!pageToken) {
    throw new Error(
      `페이지 토큰을 찾지 못했습니다. FACEBOOK_PAGE_ID(${pageId})가 현재 USER 토큰 계정의 페이지 목록에 없거나 권한이 부족합니다. META_PAGE_ACCESS_TOKEN 환경변수 설정을 권장합니다.`,
    );
  }

  console.log(
    `[meta] ✅ 페이지 토큰 자동 조회 성공: ${matched?.name ?? "unknown"} (${pageId})`,
  );
  cachedPageAccessToken = pageToken;
  return pageToken;
}

async function callGraphApi<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);

  const init: RequestInit = { method };
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  } else {
    const body = new URLSearchParams(params);
    init.body = body;
    init.headers = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  const response = await fetch(url.toString(), init);
  const raw = await response.text();

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const errBody = (parsed as GraphErrorBody | null)?.error;
    const message = errBody?.message ?? raw ?? `HTTP ${response.status}`;

    // 토큰 만료 / 권한 문제를 한글로 좀 더 명확히 알려주기
    const friendly = normalizeGraphError(message, errBody?.code);
    throw new Error(friendly);
  }

  return parsed as T;
}

function normalizeGraphError(message: string, code?: number): string {
  if (code === 190 || /access token/i.test(message)) {
    return `Meta 액세스 토큰 오류: ${message} (META_ACCESS_TOKEN 재발급 필요 가능성)`;
  }
  if (code === 100) {
    return `Meta 파라미터 오류: ${message}`;
  }
  if (code === 10 || code === 200) {
    return `Meta 권한 오류: ${message} (앱 권한/페이지 권한 확인 필요)`;
  }
  return `Meta API 오류: ${message}`;
}

/* ------------------------------------------------------------
 * 1) 인스타그램 Reels 발행 - 내부 3단계
 * ---------------------------------------------------------- */

/** 1단계: Reels 컨테이너 생성 */
async function createReelsContainer(
  videoUrl: string,
  caption: string,
): Promise<string> {
  const igUserId = getInstagramAccountId();
  const accessToken = getMetaAccessToken();

  console.log(`[meta] 📦 [1/3] 인스타 Reels 컨테이너 생성 중...`);

  const data = await callGraphApi<{ id: string }>(
    "POST",
    `/${igUserId}/media`,
    {
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      access_token: accessToken,
    },
  );

  if (!data?.id) {
    throw new Error("컨테이너 ID 를 응답에서 찾을 수 없습니다.");
  }

  console.log(`[meta] ✅ [1/3] 컨테이너 생성 완료 - id=${data.id}`);
  return data.id;
}

/** 2단계: 컨테이너가 FINISHED 될 때까지 상태 폴링 */
async function waitForContainerReady(
  containerId: string,
  opts: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? 60_000; // 60초
  const intervalMs = opts.intervalMs ?? 5_000; // 5초
  const accessToken = getMetaAccessToken();
  const start = Date.now();

  console.log(`[meta] ⏳ [2/3] 컨테이너 상태 폴링 시작 (최대 ${maxWaitMs / 1000}초)`);

  while (Date.now() - start < maxWaitMs) {
    const data = await callGraphApi<{ status_code?: string; status?: string }>(
      "GET",
      `/${containerId}`,
      {
        fields: "status_code,status",
        access_token: accessToken,
      },
    );

    const statusCode = data.status_code ?? data.status ?? "UNKNOWN";
    console.log(`[meta]    - status=${statusCode}`);

    if (statusCode === "FINISHED") {
      console.log(`[meta] ✅ [2/3] 컨테이너 준비 완료`);
      return;
    }

    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(
        `컨테이너 처리 실패 - status=${statusCode} (영상 URL 접근 불가 또는 포맷 문제 가능성)`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `컨테이너가 ${maxWaitMs / 1000}초 내에 FINISHED 상태가 되지 않았습니다.`,
  );
}

/** 3단계: 컨테이너 발행 */
async function publishContainer(containerId: string): Promise<string> {
  const igUserId = getInstagramAccountId();
  const accessToken = getMetaAccessToken();

  console.log(`[meta] 🚀 [3/3] 인스타 Reels 발행 중...`);

  const data = await callGraphApi<{ id: string }>(
    "POST",
    `/${igUserId}/media_publish`,
    {
      creation_id: containerId,
      access_token: accessToken,
    },
  );

  if (!data?.id) {
    throw new Error("발행된 미디어 ID 를 응답에서 찾을 수 없습니다.");
  }

  console.log(`[meta] ✅ [3/3] 인스타 Reels 발행 완료 - media_id=${data.id}`);
  return data.id;
}

/* ------------------------------------------------------------
 * 1) 인스타그램 Reels 발행 - 퍼블릭 API
 * ---------------------------------------------------------- */

/**
 * 인스타그램 릴스를 자동 발행한다.
 *   - 실패 시 social_publishes 에 failed 로그를 남기고 Gmail 알림 전송
 *   - 성공 시 external_id(미디어 ID) 기록
 */
export async function publishInstagramReel(
  input: InstagramPublishInput,
): Promise<PublishResult> {
  if (!isInstagramAutoPublishEnabled()) {
    const msg = "AUTO_PUBLISH_INSTAGRAM=true 가 아니므로 스킵";
    console.log(`[meta] ⏭  ${msg}`);
    return { success: false, platform: "instagram", errorMessage: msg };
  }

  try {
    const containerId = await createReelsContainer(input.videoUrl, input.caption);
    await waitForContainerReady(containerId);
    const mediaId = await publishContainer(containerId);

    await recordPublish({
      videoId: input.videoId,
      platform: "instagram",
      status: "success",
      externalId: mediaId,
      storagePath: input.storagePath ?? null,
      captionPreview: input.caption.slice(0, 200),
      errorMessage: null,
    });

    return {
      success: true,
      platform: "instagram",
      externalId: mediaId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meta] ❌ 인스타 Reels 발행 실패: ${message}`);

    await recordPublish({
      videoId: input.videoId,
      platform: "instagram",
      status: "failed",
      externalId: null,
      storagePath: input.storagePath ?? null,
      captionPreview: input.caption.slice(0, 200),
      errorMessage: message,
    });

    await sendMetaFailureAlert({
      platform: "instagram",
      videoId: input.videoId,
      errorMessage: message,
    }).catch((err) => {
      console.error(`[meta] 알림 메일 발송도 실패: ${String(err)}`);
    });

    return {
      success: false,
      platform: "instagram",
      errorMessage: message,
    };
  }
}

/* ------------------------------------------------------------
 * 2) 페이스북 페이지 텍스트 게시
 * ---------------------------------------------------------- */

/**
 * 페이스북 페이지 피드에 텍스트를 게시한다.
 *   - 영상 업로드가 아닌 "텍스트 게시" 용도 (요구사항 기준)
 *   - 실패 시 social_publishes 기록 + Gmail 알림
 */
export async function publishFacebookPagePost(
  input: FacebookPublishInput,
): Promise<PublishResult> {
  if (!isFacebookAutoPublishEnabled()) {
    const msg = "AUTO_PUBLISH_FACEBOOK=true 가 아니므로 스킵";
    console.log(`[meta] ⏭  ${msg}`);
    return { success: false, platform: "facebook", errorMessage: msg };
  }

  const pageId = getFacebookPageId();

  console.log(`[meta] 📘 페이스북 페이지 게시 시도 - page_id=${pageId}`);

  try {
    const pageAccessToken = await getFacebookPageAccessToken();
    const data = await callGraphApi<{ id: string }>(
      "POST",
      `/${pageId}/feed`,
      {
        message: input.message,
        access_token: pageAccessToken,
      },
    );

    if (!data?.id) {
      throw new Error("게시 ID 를 응답에서 찾을 수 없습니다.");
    }

    console.log(`[meta] ✅ 페이스북 게시 완료 - post_id=${data.id}`);

    await recordPublish({
      videoId: input.videoId,
      platform: "facebook",
      status: "success",
      externalId: data.id,
      storagePath: null,
      captionPreview: input.message.slice(0, 200),
      errorMessage: null,
    });

    return {
      success: true,
      platform: "facebook",
      externalId: data.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meta] ❌ 페이스북 게시 실패: ${message}`);

    await recordPublish({
      videoId: input.videoId,
      platform: "facebook",
      status: "failed",
      externalId: null,
      storagePath: null,
      captionPreview: input.message.slice(0, 200),
      errorMessage: message,
    });

    await sendMetaFailureAlert({
      platform: "facebook",
      videoId: input.videoId,
      errorMessage: message,
    }).catch((err) => {
      console.error(`[meta] 알림 메일 발송도 실패: ${String(err)}`);
    });

    return {
      success: false,
      platform: "facebook",
      errorMessage: message,
    };
  }
}

/* ------------------------------------------------------------
 * 3) social_publishes DB 기록
 * ---------------------------------------------------------- */

interface RecordPublishInput {
  videoId: string;
  platform: "instagram" | "facebook";
  status: "success" | "failed";
  externalId: string | null;
  storagePath: string | null;
  captionPreview: string | null;
  errorMessage: string | null;
}

async function recordPublish(input: RecordPublishInput): Promise<void> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase.from("social_publishes").insert({
      video_id: input.videoId,
      platform: input.platform,
      status: input.status,
      external_id: input.externalId,
      storage_path: input.storagePath,
      caption_preview: input.captionPreview,
      error_message: input.errorMessage,
    });

    if (error) {
      console.error(`[meta] social_publishes 기록 실패: ${error.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[meta] social_publishes 기록 중 예외: ${message}`);
  }
}

/* ------------------------------------------------------------
 * 4) Meta 발행 실패 시 Gmail 알림
 * ---------------------------------------------------------- */

interface FailureAlertInput {
  platform: "instagram" | "facebook";
  videoId: string;
  errorMessage: string;
}

/**
 * nodemailer 를 동적 import 해서 사용한다.
 *   - 기존 lib/mailer.ts 가 top-level 에서 EMAIL_USER 를 require 하기 때문에,
 *     해당 모듈을 직접 재사용하는 대신 독립된 최소 알림 메일만 전송.
 */
async function sendMetaFailureAlert(input: FailureAlertInput): Promise<void> {
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;

  if (!emailUser || !emailPass) {
    console.warn("[meta] EMAIL_USER/EMAIL_PASS 미설정 → 실패 알림 메일 스킵");
    return;
  }

  const nodemailer = (await import("nodemailer")).default;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: emailUser, pass: emailPass },
  });

  const platformLabel =
    input.platform === "instagram" ? "인스타그램 릴스" : "페이스북 페이지";

  const html = `
    <div style="font-family:'Malgun Gothic',Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#111827;">
      <h2 style="margin:0 0 12px 0;color:#b91c1c;">⚠️ 나우카 자동 발행 실패 알림</h2>
      <p><b>플랫폼:</b> ${platformLabel}</p>
      <p><b>영상 ID:</b> ${input.videoId}</p>
      <p><b>발생 시각:</b> ${new Date().toLocaleString("ko-KR")}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
      <h3 style="margin:0 0 6px 0;">에러 메시지</h3>
      <pre style="padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;white-space:pre-wrap;word-break:break-word;">${input.errorMessage}</pre>
      <p style="margin-top:16px;color:#6b7280;font-size:12px;">
        이 메일은 Meta 자동 발행 실패 시 자동 전송됩니다.<br />
        토큰 만료가 의심되면 META_ACCESS_TOKEN 을 재발급해 주세요.
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Nowcar Auto" <${emailUser}>`,
    to: emailUser,
    subject: `[나우카 자동발행 실패] ${platformLabel} - ${input.videoId}`,
    html,
  });

  console.log(`[meta] 📧 실패 알림 메일 발송 완료`);
}

/* ------------------------------------------------------------
 * 5) 캡션 조립 유틸 (인스타용)
 * ---------------------------------------------------------- */

/**
 * generated_contents.body + hashtags 를 인스타 릴스 캡션으로 합친다.
 * 인스타 캡션 최대 2,200자 제한을 고려해 자른다.
 */
export function buildInstagramCaption(
  body: string,
  hashtags: string | null,
): string {
  const IG_MAX = 2200;
  const combined = hashtags
    ? `${body.trim()}\n\n${hashtags.trim()}`
    : body.trim();

  if (combined.length <= IG_MAX) return combined;

  // 해시태그는 최대한 보존하고 body 를 잘라낸다.
  const tagLen = hashtags ? hashtags.trim().length + 2 : 0;
  const bodyLimit = Math.max(0, IG_MAX - tagLen - 1);
  const truncatedBody = body.trim().slice(0, bodyLimit).trimEnd();
  return hashtags
    ? `${truncatedBody}\n\n${hashtags.trim()}`
    : truncatedBody;
}
