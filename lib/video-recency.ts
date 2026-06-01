/**
 * ============================================================
 * lib/video-recency.ts
 * ------------------------------------------------------------
 * "신규로 인정할 영상" 의 recency(나이) 게이트.
 *
 * 배경(2026-06-01 사고):
 *   YouTube Data API search.list(order=date) 가 어떤 이유로든(메타데이터
 *   수정/재인덱싱 등) 1년 전 영상을 결과에 다시 끼워 넣는 일이 있다.
 *   감지 단계(youtube/check)는 "DB 에 없는 video_id" 인지만 보고 신규로
 *   저장했기 때문에, 2025-02 ~ 2025-11 에 올라온 옛날 영상이 2026-06-01 에
 *   신규로 잡혀 IG/FB/Threads 에 실제로 재발행되는 사고가 발생했다.
 *
 *   → published_at 이 이 윈도우보다 오래된 영상은 감지/발행 단계에서 모두
 *     제외한다. 신규 업로드는 cron(매일) + 로컬 워커가 하루 안에 잡으므로
 *     14일 윈도우면 PC-off 백로그까지 안전하게 커버하면서, 수개월 전 영상의
 *     재발행은 확실히 차단한다.
 *
 * env `DETECT_MAX_AGE_DAYS` 로 윈도우(일)를 덮어쓸 수 있다(기본 14).
 * ============================================================
 */

export const DEFAULT_MAX_VIDEO_AGE_DAYS = 14;

/** recency 윈도우(일). env DETECT_MAX_AGE_DAYS 우선, 없으면 기본 14. */
export function getMaxVideoAgeDays(): number {
  const raw = process.env.DETECT_MAX_AGE_DAYS;
  if (!raw) return DEFAULT_MAX_VIDEO_AGE_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_VIDEO_AGE_DAYS;
  return Math.floor(parsed);
}

/** 지금 시각 - 윈도우(ms). 내부 비교용. */
function cutoffMs(): number {
  return Date.now() - getMaxVideoAgeDays() * 24 * 60 * 60 * 1000;
}

/**
 * recency cutoff 의 ISO 문자열. Supabase 쿼리에서
 * `.gte("published_at", recencyCutoffIso())` 형태로 쓴다.
 */
export function recencyCutoffIso(): string {
  return new Date(cutoffMs()).toISOString();
}

/**
 * publishedAt 이 cutoff 이후(=충분히 최신)면 true.
 * - null/빈값/파싱 불가 → 보수적으로 false(제외). 신규 영상은 youtube/check 가
 *   snippet.publishedAt 을 항상 저장하므로 null 은 사실상 레거시 행에 한정된다.
 */
export function isWithinRecency(
  publishedAt: string | null | undefined,
): boolean {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return false;
  return t >= cutoffMs();
}
