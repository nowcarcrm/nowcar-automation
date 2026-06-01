/**
 * ============================================================
 * lib/download-grace.ts
 * ------------------------------------------------------------
 * "로컬 워커 우선" 정책의 유예시간(grace) 헬퍼.
 *
 * 배경:
 *   영상 다운로드는 PC 로컬 워커(C:\nowcar-worker\worker.js)가 yt-dlp 로
 *   가정용 IP 에서 수행한다 — YouTube 봇차단이 사실상 없다.
 *   Vercel(/api/cron/download, publish-meta 인라인) 의 ytdl 은 데이터센터 IP
 *   라 거의 항상 봇차단("Sign in to confirm you're not a bot")에 걸리고,
 *   그때마다 운영자에게 쿠키 갱신 경고 메일이 발송된다.
 *
 *   기존 버그: Vercel cron 이 detect 로 새 영상을 넣자마자 같은 사이클에
 *   Vercel ytdl 로 받으려다 봇차단 → 메일. 로컬 워커가 그 영상을 가져갈
 *   틈조차 없었다.
 *
 * 정책:
 *   영상이 감지된 직후 GRACE 시간 동안은 Vercel ytdl 을 시도하지 않고
 *   로컬 워커(10분 주기) 에게 양보한다. GRACE 를 넘기도록 storage_path 가
 *   비어 있으면 = 로컬 워커가 (PC off/장애 등으로) 처리하지 못한 것이므로
 *   그때 비로소 Vercel ytdl 을 폴백으로 시도한다. 이 경우의 봇차단 메일은
 *   "실제로 운영자 조치(예: Drive 업로드)가 필요한" 정당한 알림이다.
 * ============================================================
 */

/**
 * 로컬 워커가 영상을 가져갈 수 있도록 Vercel ytdl 을 보류하는 시간(분).
 * 로컬 워커는 약 10분 주기로 도므로, 기본 30분 = 약 3 사이클의 기회를 준다.
 *
 * env LOCAL_WORKER_GRACE_MINUTES 로 재배포 없이 조정 가능(잘못된 값/0 이하는
 * 기본값으로 폴백). 값을 키우면 PC-on 상태에서 로컬 워커가 일시적으로 몇
 * 사이클 밀려도 Vercel 폴백/경고메일이 덜 뜨고, 줄이면 로컬 워커 장애를 더
 * 빨리 폴백/알림한다.
 */
const DEFAULT_GRACE_MINUTES = 30;

function resolveGraceMinutes(): number {
  const raw = process.env.LOCAL_WORKER_GRACE_MINUTES;
  if (!raw) return DEFAULT_GRACE_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GRACE_MINUTES;
  return parsed;
}

export const LOCAL_WORKER_GRACE_MINUTES = resolveGraceMinutes();

/**
 * Supabase 쿼리 필터용: "이 시각보다 먼저 생성된 영상만 Vercel ytdl 대상" 컷오프.
 * 예) .lt("created_at", localWorkerGraceCutoffIso())
 */
export function localWorkerGraceCutoffIso(): string {
  return new Date(
    Date.now() - LOCAL_WORKER_GRACE_MINUTES * 60 * 1000,
  ).toISOString();
}

/**
 * 개별 행 판정용: 생성 시각이 grace 를 넘겼는가(= Vercel ytdl 폴백 허용).
 * created_at 을 알 수 없으면(legacy/누락) 안전하게 폴백을 허용한다.
 */
export function isPastLocalWorkerGrace(
  createdAtIso: string | null | undefined,
): boolean {
  if (!createdAtIso) return true;
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return true;
  return Date.now() - createdMs >= LOCAL_WORKER_GRACE_MINUTES * 60 * 1000;
}
