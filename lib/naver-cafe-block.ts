import { createAdminClient } from "@/lib/storage";
import { sendNaverCafeBlockedAlert } from "@/lib/mailer";

/**
 * ============================================================
 * lib/naver-cafe-block.ts
 * ------------------------------------------------------------
 * 네이버 카페 글쓰기 차단(code 999) 서킷 브레이커 + 알림.
 *
 * 배경(2026-06-01 진단): 2026-05-27 20:20 마지막 성공 이후 모든 카페 게시가
 * HTTP 403 / code 999 로 거부됨(최근·옛 영상 무관). 토큰이 아니라 계정/카페
 * 차원의 글쓰기 제한으로 추정. 그런데 영상당 5회 재시도 + 신규 영상마다 재시작
 * 이라 차단 상태에서도 네이버를 계속 때려 차단을 연장시키는 문제가 있었다.
 *
 *  - isNaverCafe999Error(): 999 차단 패턴 매치
 *  - getNaverCafeBlockState(): 최근 시도가 999 실패이고 backoff 윈도우 내면
 *      blocked=true → 이번 사이클 발행 보류. 윈도우를 넘기면 1회 probe 허용해
 *      자동 복구를 시도(성공하면 brake 해제).
 *  - notifyNaverCafeBlockIfNeeded(): system_alerts cooldown(6h)으로 중복 메일 방지.
 * ============================================================
 */

const ALERT_TYPE_CAFE_BLOCKED = "naver_cafe_blocked";
const ALERT_COOLDOWN_HOURS = 6;

/**
 * 마지막 999 실패가 이 시간 내면 "차단 중"으로 보고 발행을 보류한다.
 * 윈도우를 넘기면 다음 사이클에 1회 probe 를 허용 → 차단이 풀렸으면 자동 복구.
 */
export const CAFE_BLOCK_BACKOFF_HOURS = 6;

const BLOCK_PATTERNS: RegExp[] = [
  /"code"\s*:\s*"?999"?/, // {"error":{"code":"999",...}}
  /\b999\b/,
];

export function isNaverCafe999Error(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return BLOCK_PATTERNS.some((re) => re.test(message));
}

export interface CafeBlockState {
  blocked: boolean;
  lastError: string | null;
  lastFailedAt: string | null;
}

/**
 * 카페가 현재 차단 중인지 판정.
 * 가장 최근 naver_cafe 시도(success|failed)를 보고:
 *   - success → 차단 아님(정상)
 *   - 999 failed 이고 backoff 윈도우 내 → blocked(발행 보류)
 *   - 999 failed 이지만 윈도우 밖 → blocked=false(1회 probe 허용)
 *   - 999 아닌 failed → 차단으로 보지 않음(개별 실패는 기존 5회 cap 으로 처리)
 */
export async function getNaverCafeBlockState(): Promise<CafeBlockState> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("social_publishes")
      .select("status, error_message, updated_at")
      .eq("platform", "naver_cafe")
      .in("status", ["success", "failed"])
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) {
      return { blocked: false, lastError: null, lastFailedAt: null };
    }

    const last = data[0] as {
      status: string;
      error_message: string | null;
      updated_at: string | null;
    };

    if (last.status !== "failed" || !isNaverCafe999Error(last.error_message)) {
      return { blocked: false, lastError: null, lastFailedAt: null };
    }

    const cutoff = Date.now() - CAFE_BLOCK_BACKOFF_HOURS * 60 * 60 * 1000;
    const lastMs = last.updated_at ? Date.parse(last.updated_at) : NaN;
    const blocked = Number.isFinite(lastMs) && lastMs >= cutoff;
    return {
      blocked,
      lastError: last.error_message ?? null,
      lastFailedAt: last.updated_at ?? null,
    };
  } catch (error) {
    // 판정 실패 시 보수적으로 차단 아님으로 둬 정상 흐름을 막지 않는다.
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[cafe-block] 차단 상태 판정 실패(차단 아님으로 진행): ${msg}`);
    return { blocked: false, lastError: null, lastFailedAt: null };
  }
}

/**
 * 카페 999 차단이 감지됐을 때 호출. system_alerts cooldown(6h) 내면 메일 생략.
 * 호출자 흐름이 깨지지 않도록 내부에서 모든 예외를 흡수.
 */
export async function notifyNaverCafeBlockIfNeeded(params: {
  sampleError: string;
}): Promise<{ sent: boolean; reason: string }> {
  try {
    const supabase = createAdminClient();
    const cutoff = new Date(
      Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: existing, error: selectError } = await supabase
      .from("system_alerts")
      .select("alert_type, last_sent_at")
      .eq("alert_type", ALERT_TYPE_CAFE_BLOCKED)
      .maybeSingle();

    if (selectError) {
      console.warn(
        `[cafe-block] system_alerts 조회 실패(메일은 그래도 보냄): ${selectError.message}`,
      );
    } else if (existing && existing.last_sent_at >= cutoff) {
      return {
        sent: false,
        reason: `cooldown(last_sent_at=${existing.last_sent_at})`,
      };
    }

    await sendNaverCafeBlockedAlert(params.sampleError);

    const nowIso = new Date().toISOString();
    const { error: upsertError } = await supabase.from("system_alerts").upsert(
      {
        alert_type: ALERT_TYPE_CAFE_BLOCKED,
        last_sent_at: nowIso,
        last_message: params.sampleError.slice(0, 500),
        metadata: {},
      },
      { onConflict: "alert_type" },
    );

    if (upsertError) {
      console.warn(
        `[cafe-block] system_alerts upsert 실패(메일은 발송됨): ${upsertError.message}`,
      );
    }

    return { sent: true, reason: "alert sent" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[cafe-block] 알림 처리 중 예외(무시): ${msg}`);
    return { sent: false, reason: `error: ${msg}` };
  }
}
