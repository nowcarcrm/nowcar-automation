import { createAdminClient } from "@/lib/storage";
import { sendMetaTokenRefreshFailedAlert } from "@/lib/mailer";

/**
 * ============================================================
 * lib/meta-token.ts
 * ------------------------------------------------------------
 * Meta Graph API long-lived token 자동 갱신.
 *
 * 동작:
 *   1) 핸들러 진입 시 ensureMetaTokenLoaded() 호출
 *   2) system_tokens.meta_user 행이 있고 만료까지 14일 이상 남았으면
 *      → DB 값으로 process.env.META_ACCESS_TOKEN 만 갱신 후 종료
 *   3) 만료 임박 또는 DB 행 없음 → fb_exchange_token API 로 새 long-lived
 *      token 교환 → DB 저장 → process.env 갱신
 *   4) refresh 실패 시 메일 알림(12h cooldown)
 *
 * 호출 시점:
 *   - /api/cron/download 진입부 (매일 1회)
 *   - lib/pipeline/publish-meta.ts runPublishMetaStep() 진입부
 *     (after-hook 으로 도는 pipeline/run 에서 메타 발행 직전 prime)
 *
 * 우아한 폴백:
 *   - META_APP_ID / META_APP_SECRET 미설정 → 그냥 종료 (기존 env 토큰 사용)
 *   - DB 조회 실패 → 그냥 종료 (기존 env 토큰 사용)
 *   - exchange 실패 → 알림 발송, 기존 env 토큰 사용 (서비스 다운 X)
 * ============================================================
 */

const TOKEN_TYPE_META_USER = "meta_user";
/** 만료 N일 전부터 사전 refresh. 60일 만료 토큰의 경우 46일째부터 갱신 시도. */
const REFRESH_BEFORE_EXPIRY_DAYS = 14;
const REFRESH_FAIL_ALERT_TYPE = "meta_token_refresh_failed";
const REFRESH_FAIL_ALERT_COOLDOWN_HOURS = 12;
const GRAPH_VERSION = "v18.0";
/** expires_in 누락(never-expire 토큰) 시 60일 후로 가정 */
const FALLBACK_EXPIRES_SECONDS = 60 * 24 * 60 * 60;

interface MetaTokenRow {
  token_type: string;
  value: string;
  refreshed_at: string;
  expires_at: string;
}

export type EnsureStatus =
  | "no_app_creds"
  | "no_env_token"
  | "non_user_token_skip"
  | "db_fresh"
  | "refreshed_from_db"
  | "bootstrapped_from_env"
  | "refresh_failed_fallback_env";

/** refresh 실패 원인 분류(M-7): 운영자 트리아지용. */
export type MetaErrorKind = "expired" | "invalid_creds" | "transient" | "other";

export interface EnsureResult {
  status: EnsureStatus;
  expiresAt: string | null;
  note?: string;
  /** refresh 실패 시 원인 분류(M-7). */
  errorKind?: MetaErrorKind;
  /** 현재 활성 토큰이 만료된 것으로 추정되는지(H-6/M-8). true 면 발행 시 코드190 위험. */
  tokenExpired?: boolean;
}

/** Meta 에러 메시지를 원인별로 분류(M-7). */
function classifyMetaError(message: string): MetaErrorKind {
  const m = message.toLowerCase();
  if (
    m.includes("expired") ||
    m.includes("session has expired") ||
    m.includes('"code":190') ||
    m.includes("invalid_grant")
  ) {
    return "expired";
  }
  if (
    m.includes("invalid") &&
    (m.includes("client") || m.includes("secret") || m.includes("app"))
  ) {
    return "invalid_creds";
  }
  if (
    m.includes("timeout") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    /http 5\d\d/.test(m) ||
    m.includes("network")
  ) {
    return "transient";
  }
  return "other";
}

function getMetaAppCreds(): { appId: string; appSecret: string } | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

async function fetchTokenRow(): Promise<MetaTokenRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("system_tokens")
    .select("token_type, value, refreshed_at, expires_at")
    .eq("token_type", TOKEN_TYPE_META_USER)
    .maybeSingle();
  if (error) {
    console.warn(`[meta-token] DB 조회 실패(env 토큰 사용): ${error.message}`);
    return null;
  }
  return (data as MetaTokenRow | null) ?? null;
}

/**
 * 토큰 타입(User/Page/System)을 debug_token API 로 확인한다.
 * fb_exchange_token 은 User Access Token 에만 적용 가능 — Page Access Token
 * 을 넘기면 Meta 가 다른 user-level 토큰을 반환하는데, 그 토큰은 IG 비즈니스
 * 계정 발행 권한을 잃는 케이스가 있어 publish-meta 가 Authorization Error.
 * 그래서 refresh 전에 type 을 사전 확인하고 USER 가 아니면 skip 한다.
 */
async function getTokenType(
  inputToken: string,
  appId: string,
  appSecret: string,
): Promise<string | null> {
  try {
    const url = new URL(
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token`,
    );
    url.searchParams.set("input_token", inputToken);
    url.searchParams.set("access_token", `${appId}|${appSecret}`);
    const resp = await fetch(url.toString(), { method: "GET" });
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: { type?: string; is_valid?: boolean };
    };
    if (body.data?.is_valid === false) return null;
    return body.data?.type ?? null;
  } catch {
    return null;
  }
}

async function deleteTokenRow(): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("system_tokens")
    .delete()
    .eq("token_type", TOKEN_TYPE_META_USER);
  if (error) {
    console.warn(
      `[meta-token] 잘못된 system_tokens row 삭제 실패(진행은 계속): ${error.message}`,
    );
  }
}

async function exchangeForLongLivedToken(
  currentToken: string,
  appId: string,
  appSecret: string,
): Promise<{ token: string; expiresInSeconds: number }> {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
  );
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", currentToken);

  const resp = await fetch(url.toString(), { method: "GET" });
  const raw = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `fb_exchange_token HTTP ${resp.status}: ${raw.slice(0, 300)}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(
      `fb_exchange_token 응답 JSON 파싱 실패: ${raw.slice(0, 200)}`,
    );
  }

  const obj = body as { access_token?: unknown; expires_in?: unknown };
  if (typeof obj.access_token !== "string" || !obj.access_token) {
    throw new Error(
      `fb_exchange_token 응답에 access_token 없음: ${raw.slice(0, 200)}`,
    );
  }
  const expiresInRaw = Number(obj.expires_in);
  const expiresInSeconds = Number.isFinite(expiresInRaw) && expiresInRaw > 0
    ? expiresInRaw
    : FALLBACK_EXPIRES_SECONDS;
  return { token: obj.access_token, expiresInSeconds };
}

async function upsertTokenRow(
  token: string,
  expiresInSeconds: number,
): Promise<string> {
  const supabase = createAdminClient();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
  const { error } = await supabase.from("system_tokens").upsert(
    {
      token_type: TOKEN_TYPE_META_USER,
      value: token,
      refreshed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      metadata: { expires_in_seconds: expiresInSeconds },
    },
    { onConflict: "token_type" },
  );
  if (error) {
    throw new Error(`system_tokens upsert 실패: ${error.message}`);
  }
  return expiresAt.toISOString();
}

async function notifyRefreshFailureIfNeeded(
  errorMessage: string,
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const cutoff = new Date(
      Date.now() - REFRESH_FAIL_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: existing, error: selectError } = await supabase
      .from("system_alerts")
      .select("alert_type, last_sent_at")
      .eq("alert_type", REFRESH_FAIL_ALERT_TYPE)
      .maybeSingle();

    if (!selectError && existing && existing.last_sent_at >= cutoff) {
      return;
    }

    await sendMetaTokenRefreshFailedAlert(errorMessage);

    const { error: upsertError } = await supabase.from("system_alerts").upsert(
      {
        alert_type: REFRESH_FAIL_ALERT_TYPE,
        last_sent_at: new Date().toISOString(),
        last_message: errorMessage.slice(0, 500),
      },
      { onConflict: "alert_type" },
    );

    if (upsertError) {
      console.warn(
        `[meta-token] alert upsert 실패(메일은 발송됨): ${upsertError.message}`,
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[meta-token] 알림 처리 중 예외(무시): ${msg}`);
  }
}

/**
 * 핸들러 진입부에서 호출. process.env.META_ACCESS_TOKEN 을 최신 값으로 prime.
 *
 * 단일 Vercel 함수 invocation 안에서만 mutation 이 일어나므로 동시성 문제 없음.
 * (Node single-thread + 각 lambda invocation 은 격리됨)
 */
export async function ensureMetaTokenLoaded(): Promise<EnsureResult> {
  const creds = getMetaAppCreds();
  if (!creds) {
    return {
      status: "no_app_creds",
      expiresAt: null,
      note: "META_APP_ID/META_APP_SECRET 미설정 — 기존 env 토큰 그대로 사용",
    };
  }

  const envToken = process.env.META_ACCESS_TOKEN;
  if (!envToken) {
    return {
      status: "no_env_token",
      expiresAt: null,
      note: "META_ACCESS_TOKEN env 미설정 — 발행 시도 시 에러 예상",
    };
  }

  // 가드: fb_exchange_token 은 User Access Token 에만 적용. 우리 env 토큰이
  // Page Access Token 이면 변환 시 Meta 가 다른 토큰을 반환하지만 IG 발행
  // 권한이 사라지는 케이스가 확인됨 (2026-05-26 Authorization Error 사고).
  // → type !== "USER" 면 자동 갱신 완전 스킵 + 이전에 잘못 저장된 DB row 도 청소.
  const tokenType = await getTokenType(envToken, creds.appId, creds.appSecret);
  if (tokenType && tokenType !== "USER") {
    await deleteTokenRow();
    return {
      status: "non_user_token_skip",
      expiresAt: null,
      note: `env 토큰 type=${tokenType} — fb_exchange_token 비적용 대상. env 토큰 그대로 사용 + DB row 정리.`,
    };
  }

  const nowMs = Date.now();
  const refreshThresholdMs =
    nowMs + REFRESH_BEFORE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  const row = await fetchTokenRow();

  if (row) {
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs > refreshThresholdMs) {
      process.env.META_ACCESS_TOKEN = row.value;
      return { status: "db_fresh", expiresAt: row.expires_at };
    }
    // DB 토큰 만료 임박 → DB 값을 source 로 refresh
    try {
      const refreshed = await exchangeForLongLivedToken(
        row.value,
        creds.appId,
        creds.appSecret,
      );
      const newExpiresAt = await upsertTokenRow(
        refreshed.token,
        refreshed.expiresInSeconds,
      );
      process.env.META_ACCESS_TOKEN = refreshed.token;
      return { status: "refreshed_from_db", expiresAt: newExpiresAt };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const kind = classifyMetaError(msg);
      // H-6/M-8: DB 토큰이 이미 만료됐는데 refresh 까지 실패하면 stale env 토큰으로
      // 발행되어 Meta 코드190 이 난다. 만료 여부를 명확히 잡아 error 레벨로 노출.
      const tokenExpired = !(Number.isFinite(expiresAtMs) && expiresAtMs > nowMs);
      if (tokenExpired) {
        console.error(
          `[meta-token] ❌ DB 토큰 만료 + refresh 실패(kind=${kind}) — 만료 토큰으로 발행 위험: ${msg}`,
        );
      } else {
        console.warn(
          `[meta-token] DB 토큰 refresh 실패(아직 유효, kind=${kind}): ${msg}`,
        );
      }
      await notifyRefreshFailureIfNeeded(
        `[${kind}]${tokenExpired ? "[EXPIRED]" : ""} DB refresh 실패: ${msg}`,
      );
      // 만료까지 시간 남아있으면 DB 토큰으로 계속 진행
      if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) {
        process.env.META_ACCESS_TOKEN = row.value;
      }
      return {
        status: "refresh_failed_fallback_env",
        expiresAt: row.expires_at,
        note: msg,
        errorKind: kind,
        tokenExpired,
      };
    }
  }

  // DB 행 없음 → 최초 진입. env 토큰을 long-lived 로 exchange 후 DB 저장.
  try {
    const refreshed = await exchangeForLongLivedToken(
      envToken,
      creds.appId,
      creds.appSecret,
    );
    const newExpiresAt = await upsertTokenRow(
      refreshed.token,
      refreshed.expiresInSeconds,
    );
    process.env.META_ACCESS_TOKEN = refreshed.token;
    return { status: "bootstrapped_from_env", expiresAt: newExpiresAt };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const kind = classifyMetaError(msg);
    // 초기 부트스트랩 실패: env 토큰을 long-lived 로 교환 못 함. invalid_creds 면
    // META_APP_ID/SECRET 점검, expired 면 env 토큰 자체가 만료된 것.
    console.error(`[meta-token] ❌ 초기 exchange 실패(kind=${kind}): ${msg}`);
    await notifyRefreshFailureIfNeeded(`[${kind}] 초기 exchange 실패: ${msg}`);
    return {
      status: "refresh_failed_fallback_env",
      expiresAt: null,
      note: msg,
      errorKind: kind,
      // env 토큰의 만료 여부는 알 수 없어 미상으로 둔다(debug_token 은 type 만 확인).
      tokenExpired: kind === "expired" ? true : undefined,
    };
  }
}
