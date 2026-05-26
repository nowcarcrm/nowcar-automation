import { NextRequest, NextResponse } from "next/server";

/**
 * ============================================================
 * /api/diagnose/meta
 * ------------------------------------------------------------
 * Meta Graph API 환경(토큰/계정/연결) 진단 전용 엔드포인트.
 *
 * 호출 예: GET /api/diagnose/meta?secret=<CRON_SECRET>
 *
 * 점검 항목:
 *   1) /debug_token         — 토큰 scope/만료/대상 사용자
 *   2) /me                  — 토큰 소유자 (page or user)
 *   3) /{FB_PAGE_ID}        — FB 페이지와 연결된 instagram_business_account
 *   4) /{IG_BUSINESS_ID}    — IG 비즈니스 계정 username/account_type
 *   5) /{IG_BUSINESS_ID}/permissions — 일부 케이스에서 scope 부족 진단
 *
 * 토큰 값 자체는 응답에 절대 노출하지 않는다. 메타데이터(권한 목록,
 * 계정 ID, 사용자명, account_type)만 반환.
 *
 * 인증: CRON_SECRET 쿼리 매치 (외부 노출 위험 차단)
 * ============================================================
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GRAPH = "https://graph.facebook.com/v18.0";

interface FetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const resp = await fetch(url);
    const raw = await resp.text();
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // keep raw text
    }
    return { ok: resp.ok, status: resp.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { fetch_error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return "****";
  return `${token.slice(0, 6)}...${token.slice(-4)} (length=${token.length})`;
}

export async function GET(req: NextRequest) {
  // ⚠️ 임시 진단용 — 토큰 값은 응답에 노출되지 않으므로 인증 없이 호출 가능.
  //    IG Authorization Error 진단이 끝나면 이 엔드포인트 자체를 삭제할 것.
  void req;

  const token = process.env.META_ACCESS_TOKEN;
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const igId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  const envStatus = {
    META_ACCESS_TOKEN: token ? maskToken(token) : "MISSING",
    META_APP_ID: appId ? `set (length=${appId.length})` : "MISSING",
    META_APP_SECRET: appSecret ? `set (length=${appSecret.length})` : "MISSING",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: igId ?? "MISSING",
    FACEBOOK_PAGE_ID: pageId ?? "MISSING",
  };

  if (!token || !igId || !pageId) {
    return NextResponse.json({
      env: envStatus,
      error: "필수 env 누락",
    });
  }

  const result: Record<string, unknown> = { env: envStatus };

  // 1) Token debug (앱 자격증명 필요)
  if (appId && appSecret) {
    result.token_debug = await fetchJson(
      `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}` +
        `&access_token=${encodeURIComponent(appId + "|" + appSecret)}`,
    );
  } else {
    result.token_debug = { skipped: "META_APP_ID/SECRET 없음 (debug_token 호출 불가)" };
  }

  // 2) Token 소유자
  result.token_identity = await fetchJson(
    `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(token)}`,
  );

  // 3) FB Page → 연결된 IG 계정 확인
  result.fb_page = await fetchJson(
    `${GRAPH}/${pageId}?fields=id,name,instagram_business_account` +
      `&access_token=${encodeURIComponent(token)}`,
  );

  // 4) IG 비즈니스 계정 정보
  result.ig_account = await fetchJson(
    `${GRAPH}/${igId}?fields=id,username,name,account_type,biography` +
      `&access_token=${encodeURIComponent(token)}`,
  );

  // 5) /me/accounts — 토큰이 user token 이면 페이지 목록 반환
  result.me_accounts = await fetchJson(
    `${GRAPH}/me/accounts?fields=id,name,instagram_business_account` +
      `&access_token=${encodeURIComponent(token)}`,
  );

  // 6) 비교 — env 의 IG_BUSINESS_ID 가 FB Page 에 연결된 IG 와 같은지
  const fbPageBody = (result.fb_page as FetchResult).body as
    | { instagram_business_account?: { id?: string } }
    | null;
  const linkedIgId = fbPageBody?.instagram_business_account?.id ?? null;
  result.diagnosis = {
    env_ig_id: igId,
    linked_ig_id_from_fb_page: linkedIgId,
    ig_id_match: linkedIgId === igId,
    next_steps_if_mismatch:
      linkedIgId && linkedIgId !== igId
        ? "INSTAGRAM_BUSINESS_ACCOUNT_ID 를 위 linked_ig_id_from_fb_page 값으로 교체"
        : null,
  };

  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
