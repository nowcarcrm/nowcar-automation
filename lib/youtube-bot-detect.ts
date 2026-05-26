import { createAdminClient } from "@/lib/storage";
import { sendCookieExpiredAlert } from "@/lib/mailer";

/**
 * ============================================================
 * lib/youtube-bot-detect.ts
 * ------------------------------------------------------------
 * YouTube 데이터센터 IP 봇 감지(=YOUTUBE_COOKIES 만료 신호) 처리.
 *
 *  - isBotBlockError() : 에러 메시지에서 봇차단 패턴 매치
 *  - notifyBotBlockIfNeeded() : system_alerts 테이블 cooldown 으로
 *    중복 메일 방지하며 운영자에게 쿠키 갱신 안내 메일 발송
 *
 * 호출자(cron/download, publish-meta) 는 봇차단으로 판정되면
 *   1) download_attempts 를 증가시키지 않고 (다음 사이클 자동 재시도)
 *   2) 이 모듈로 알림만 한 번 보내준다.
 * ============================================================
 */

const ALERT_TYPE_COOKIE_EXPIRED = "youtube_cookie_expired";
const ALERT_COOLDOWN_HOURS = 6;

/** 봇차단 의심 패턴 — ytdl-core, YouTube 측 에러 문구 모두 커버 */
const BOT_BLOCK_PATTERNS: RegExp[] = [
  /봇이 아님/, // 한국어 ytdl-core 출력
  /Sign in to confirm/i, // 영문 원문
  /not a bot/i,
  /confirm you'?re not a bot/i,
];

export function isBotBlockError(message: string | null | undefined): boolean {
  if (!message) return false;
  return BOT_BLOCK_PATTERNS.some((re) => re.test(message));
}

export interface BotBlockFailedVideo {
  video_id: string;
  title: string | null;
}

/**
 * 봇차단으로 추정되는 다운로드 실패가 발생했을 때 호출.
 * cooldown 내면 메일 발송을 생략한다.
 *
 * 동기 실패(catch)로 인해 호출자 흐름이 깨지지 않도록 내부에서 모든 예외를 흡수.
 */
export async function notifyBotBlockIfNeeded(params: {
  failedVideos: BotBlockFailedVideo[];
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
      .eq("alert_type", ALERT_TYPE_COOKIE_EXPIRED)
      .maybeSingle();

    if (selectError) {
      console.warn(
        `[bot-detect] system_alerts 조회 실패(메일은 그래도 보냄): ${selectError.message}`,
      );
    } else if (existing && existing.last_sent_at >= cutoff) {
      return {
        sent: false,
        reason: `cooldown(last_sent_at=${existing.last_sent_at})`,
      };
    }

    await sendCookieExpiredAlert({
      failedVideos: params.failedVideos,
      sampleError: params.sampleError,
    });

    const nowIso = new Date().toISOString();
    const { error: upsertError } = await supabase.from("system_alerts").upsert(
      {
        alert_type: ALERT_TYPE_COOKIE_EXPIRED,
        last_sent_at: nowIso,
        last_message: params.sampleError.slice(0, 500),
        metadata: { affected_count: params.failedVideos.length },
      },
      { onConflict: "alert_type" },
    );

    if (upsertError) {
      console.warn(
        `[bot-detect] system_alerts upsert 실패(메일은 발송됨): ${upsertError.message}`,
      );
    }

    return { sent: true, reason: "alert sent" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[bot-detect] 알림 처리 중 예외(무시): ${msg}`);
    return { sent: false, reason: `error: ${msg}` };
  }
}
