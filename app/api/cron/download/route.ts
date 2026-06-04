import { after, NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  downloadAndUploadShort,
  isNoVercelSourceError,
} from "@/lib/storage";
import { runDetectStep } from "@/lib/pipeline/detect";
import {
  isBotBlockError,
  notifyBotBlockIfNeeded,
} from "@/lib/youtube-bot-detect";
import { ensureMetaTokenLoaded } from "@/lib/meta-token";
import { localWorkerGraceCutoffIso } from "@/lib/download-grace";
import { runPipelineHealthCheck } from "@/lib/pipeline-health";
import { recencyCutoffIso } from "@/lib/video-recency";

/**
 * ============================================================
 * /api/cron/download
 * ------------------------------------------------------------
 * 매일 19:00 KST(= 10:00 UTC) Vercel Cron 이 자동 호출. 로컬 워커
 * (C:\nowcar-worker\worker.js)와 동일한 책임을 Vercel 서버에서 수행한다.
 * PC 가 꺼져 있어도 인스타/페북 자동 발행이 끊기지 않게 하기 위함.
 *
 * Hobby 플랜은 cron 이 1일 1회만 허용되므로 일 1회 스케줄.
 * 영상 등록 시각(보통 17:40 KST/08:40 UTC)을 지나친 19:00 KST 에 실행
 * → 같은 날 cleanup(03:00 KST/18:00 UTC) 이전에 IG/FB 발행 가능.
 *
 * 동작:
 *   1) CRON_SECRET 헤더 검증 (외부 오남용 차단)
 *   2) YouTube 신규 영상 detect → DB에 행 삽입(storage_path=null).
 *      PC OFF 상태에서도 cron 만으로 신규 영상 수집이 가능해진다.
 *   3) youtube_videos 에서 storage_path IS NULL & download_attempts<MAX
 *      대상 조회 (created_at 오름차순). 방금 detect 한 행도 함께 포함된다.
 *   4) 각 영상에 대해 ytdl-core 로 다운로드 → Supabase Storage 업로드
 *      → youtube_videos.storage_path / downloaded_at 갱신
 *   5) 실패 시 download_attempts++ 와 download_error/last_download_error 저장
 *   6) 응답 직후 `after()` 로 /api/pipeline/run 을 트리거 →
 *      발행/카페/메일 파이프라인을 같은 Vercel 환경에서 이어 실행한다.
 *      이 시점에는 storage_path 가 채워져 있어 IG/FB 도 같은 사이클에 발행된다.
 *      (Hobby 플랜에서 추가 cron 없이 PC OFF 상태로도 자동 발행 가능)
 *
 * 시간 예산:
 *   - 영상 1개당 다운로드+업로드 평균 30~60s 가정 → BATCH_SIZE 2 로 제한
 *   - 백로그가 누적되면 ?secret= 쿼리로 수동 호출하거나 로컬 워커 가동
 * ============================================================
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ATTEMPTS = 5;
/** 한 번에 처리할 최대 영상 수 (300s 타임아웃 안에 안전하게 끝나도록) */
const BATCH_SIZE = 2;
/**
 * (B 안) attempts 도달로 좀비가 된 영상에 자동 복구 기회를 주는 윈도우.
 * 최근 N 일 내 영상은 매 cron 진입 시 attempts >= MAX 이면 0 으로 한 번 풀어
 * 쿠키 재갱신 같은 외부 변경이 자동으로 반영되도록 한다.
 *
 * A 안(봇차단 감지 → attempts 증가 안 함) 이 정상 작동하면 거의 발동되지
 * 않지만, 패턴이 빠진 에러나 다른 일시 장애에도 자가 회복하도록 belt-and-
 * suspenders 로 둔다.
 */
const STALE_ATTEMPTS_RESET_WINDOW_DAYS = 7;

interface PendingVideo {
  id: string;
  video_id: string;
  title: string | null;
  download_attempts: number | null;
}

interface DownloadResponse {
  success: boolean;
  timestamp: string;
  duration_seconds: number;
  summary: string;
  processed_count: number;
  success_count: number;
  failed_count: number;
  successes: Array<{ video_id: string; storage_path: string }>;
  failures: Array<{ video_id: string; reason: string }>;
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function verifyAuth(req: NextRequest): { ok: boolean; reason?: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: "CRON_SECRET 환경변수 미설정" };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader === `Bearer ${secret}`) {
    return { ok: true };
  }

  const querySecret = req.nextUrl.searchParams.get("secret");
  if (querySecret && querySecret === secret) {
    return { ok: true };
  }

  return { ok: false, reason: "Authorization 헤더 또는 secret 쿼리 불일치" };
}

async function fetchPendingVideos(): Promise<PendingVideo[]> {
  const supabase = createAdminClient();

  // "로컬 워커 우선" 게이트: 감지 직후 GRACE(분) 동안은 Vercel ytdl 대상에서
  // 제외해 가정용 IP 의 로컬 워커(C:\nowcar-worker\worker.js, 10분 주기)에게
  // 먼저 양보한다. GRACE 를 넘기도록 storage_path 가 비어 있는 영상만 Vercel
  // ytdl 폴백 대상이 된다(= 로컬 워커가 PC off/장애로 처리 못 한 경우).
  // 데이터센터 IP ytdl 봇차단 → 쿠키 경고 메일이 정상 운영 중 발송되는 것을
  // 원천 차단하기 위함. 자세한 배경은 lib/download-grace.ts 참고.
  // M2: worker.js 와 동일 가드. storage_path IS NULL 만 보면, cleanup 이 발행 후
  // 파일을 지우며 storage_path 를 NULL 로 되돌린 '이미 발행 완료' 옛 영상을 '다운로드
  // 필요' 로 오인해 매일 다시 받는다(treadmill) → 신규 영상이 굶음. 그래서
  //  (a) recency 윈도우 밖(어차피 publish recency 게이트에 막힘) 제외,
  //  (b) 이미 인스타 발행 성공한 영상(=mp4 더 불필요) 제외.
  const { data: published } = await supabase
    .from("social_publishes")
    .select("video_id")
    .eq("platform", "instagram")
    .eq("status", "success");
  const doneIds = new Set((published ?? []).map((r) => r.video_id));

  const { data, error } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, download_attempts")
    .is("storage_path", null)
    .lt("download_attempts", MAX_ATTEMPTS)
    .lt("created_at", localWorkerGraceCutoffIso())
    .gte("published_at", recencyCutoffIso())
    // M3/L15: 롱폼(>MAX) 제외 — Meta 발행 불가 영상은 받지 않는다(duration NULL 은 허용).
    .or(
      `duration_seconds.is.null,duration_seconds.lte.${parseInt(process.env.MAX_SHORT_PUBLISH_SECONDS || "120", 10)}`,
    )
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE * 4); // doneIds 제외 후에도 BATCH_SIZE 를 채우도록 여유분

  if (error) {
    throw new Error(`youtube_videos 조회 실패: ${error.message}`);
  }

  return ((data ?? []) as PendingVideo[])
    .filter((v) => !doneIds.has(v.video_id))
    .slice(0, BATCH_SIZE);
}

async function markDownloaded(
  videoUuid: string,
  storagePath: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("youtube_videos")
    .update({
      storage_path: storagePath,
      downloaded_at: new Date().toISOString(),
      download_error: null,
    })
    .eq("id", videoUuid);

  if (error) {
    throw new Error(`storage_path 업데이트 실패: ${error.message}`);
  }
}

async function markFailed(
  videoUuid: string,
  errorMessage: string,
  prevAttempts: number | null,
): Promise<void> {
  const supabase = createAdminClient();
  const truncated = errorMessage.slice(0, 500);
  // A 안: 봇차단(쿠키 만료)이 의심되면 download_attempts 를 증가시키지 않는다.
  // 쿠키 갱신 + 재배포만 하면 다음 cron 사이클에 자동 재시도되어 별도 SQL
  // 리셋이 불필요하다. 에러 정보는 그대로 보존해 진단/알림 용도로 사용.
  const botBlock = isBotBlockError(errorMessage);
  const nextAttempts = botBlock
    ? (prevAttempts ?? 0)
    : (prevAttempts ?? 0) + 1;

  // download_error 는 다음 성공 시 클리어되지만 last_download_error 는 영구 보존.
  // Hobby 의 1시간 로그 보존을 우회해 주말 실패 사유를 다음 영업일에도 진단하기 위함.
  const { error } = await supabase
    .from("youtube_videos")
    .update({
      download_attempts: nextAttempts,
      download_error: truncated,
      last_download_error: truncated,
      last_download_error_at: new Date().toISOString(),
    })
    .eq("id", videoUuid);

  if (error) {
    console.warn(
      `[cron/download] 실패 기록 중 에러(진행은 계속): ${error.message}`,
    );
  }

  if (botBlock) {
    console.warn(
      `[cron/download] 🍪 봇차단 감지 → attempts 유지(${nextAttempts}). 쿠키 갱신 시 자동 재시도.`,
    );
  }
}

/**
 * (B 안) 좀비 영상 자동 부활 가드.
 * STALE_ATTEMPTS_RESET_WINDOW_DAYS 일 내 등록된 영상 중 storage_path IS NULL
 * & attempts >= MAX 인 행을 attempts=0 으로 풀어준다. cron 진입부에서 1회 호출.
 */
async function resetStaleAttempts(): Promise<number> {
  const supabase = createAdminClient();
  const windowStart = new Date(
    Date.now() - STALE_ATTEMPTS_RESET_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("youtube_videos")
    .update({ download_attempts: 0 })
    .is("storage_path", null)
    .gte("download_attempts", MAX_ATTEMPTS)
    .gte("created_at", windowStart)
    .select("id");

  if (error) {
    console.warn(
      `[cron/download] stale attempts 리셋 실패(진행은 계속): ${error.message}`,
    );
    return 0;
  }

  return data?.length ?? 0;
}

/**
 * 응답 직후 호출되어 `/api/pipeline/run` 을 같은 배포의 별도 invocation 으로
 * 시작시킨다. 새 invocation 은 자체 maxDuration(300s) 을 가지므로 본 다운로드
 * cron 의 남은 시간 예산에 영향을 받지 않는다.
 *
 * 짧은 AbortSignal 로 클라이언트 fetch 만 끊고 빠진다 — Vercel 측 함수는
 * 요청을 이미 받아 실행 중이므로 파이프라인은 끝까지 돈다.
 */
async function triggerPipeline(req: NextRequest): Promise<void> {
  const host = process.env.VERCEL_URL ?? req.headers.get("host");
  if (!host) {
    console.warn("[cron/download] ⚠️ 파이프라인 트리거 스킵: host 정보 없음");
    return;
  }
  const protocol = process.env.VERCEL_URL ? "https" : "http";
  const url = `${protocol}://${host}/api/pipeline/run`;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    console.log(
      `[cron/download] 🔁 파이프라인 트리거 응답 수신: HTTP ${res.status}`,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      console.log(
        "[cron/download] 🔁 파이프라인 트리거 송신 완료(응답 대기 생략)",
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[cron/download] ⚠️ 파이프라인 트리거 실패: ${msg}`);
    }
  }
}

async function handleDownload(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const successes: Array<{ video_id: string; storage_path: string }> = [];
  const failures: Array<{ video_id: string; reason: string }> = [];

  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📥 나우카 YouTube 다운로드 워커 시작 (Vercel cron)");
  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 1) 인증
  const auth = verifyAuth(req);
  if (!auth.ok) {
    console.warn(`[cron/download] ❌ 인증 실패: ${auth.reason}`);
    return NextResponse.json(
      { success: false, error: "Unauthorized", reason: auth.reason },
      { status: 401 },
    );
  }
  console.log("[cron/download] ✅ 인증 통과");

  // 1.4) Meta long-lived token 자동 prime/refresh.
  //      DB 의 system_tokens 에서 최신 값으로 process.env.META_ACCESS_TOKEN 갱신.
  //      만료 14일 전부터는 자동 fb_exchange_token. 실패 시 메일 알림.
  try {
    const tokenResult = await ensureMetaTokenLoaded();
    console.log(
      `[cron/download] 🔑 Meta token: status=${tokenResult.status} expiresAt=${tokenResult.expiresAt ?? "-"}${tokenResult.note ? ` note=${tokenResult.note.slice(0, 80)}` : ""}`,
    );
  } catch (error) {
    const msg = toErrorMessage(error);
    console.warn(
      `[cron/download] ⚠ Meta token prime 단계 실패(env 토큰 사용): ${msg}`,
    );
  }

  // 1.45) 파이프라인 헬스 점검 — "조용한 고장"(멈춘 pending·미다운로드 백로그·
  //       발행 실패 급증·토큰 만료 임박)을 감지해 12h cooldown 으로 다이제스트 알림.
  //       cron 은 PC 와 무관하게 매일 돌므로 신뢰할 수 있는 감시 앵커. 배경:
  //       lib/pipeline-health.ts. 내부에서 모든 예외를 흡수하므로 cron 을 깨지 않는다.
  try {
    const health = await runPipelineHealthCheck();
    console.log(
      `[cron/download] 🩺 헬스 점검: 이상 ${health.anomalies.length}건, 알림 sent=${health.alertSent} (${health.alertReason})`,
    );
  } catch (error) {
    console.warn(
      `[cron/download] ⚠ 헬스 점검 단계 실패(진행은 계속): ${toErrorMessage(error)}`,
    );
  }

  // 1.5) (B 안) 좀비 영상 자동 부활 — attempts 한계 도달한 최근 영상을 풀어준다.
  //      A 안(봇차단 감지) 이 정상 작동하면 발동 거의 안 되지만, 다른 일시 장애
  //      에도 자가 회복되도록 safety net 으로 둔다.
  try {
    const revived = await resetStaleAttempts();
    if (revived > 0) {
      console.log(
        `[cron/download] ♻ stale attempts 리셋: ${revived}개 영상 부활 (window=${STALE_ATTEMPTS_RESET_WINDOW_DAYS}d)`,
      );
    }
  } catch (error) {
    const msg = toErrorMessage(error);
    console.warn(`[cron/download] ⚠ stale 리셋 단계 실패(진행은 계속): ${msg}`);
  }

  // 2) 신규 영상 detect — DB 에 행 삽입(storage_path=null).
  //    실패해도 기존 pending 다운로드는 계속 진행한다.
  try {
    const detect = await runDetectStep();
    console.log(
      `[cron/download] 🔍 detect: 신규 ${detect.new_videos_count}건, 기존 ${detect.existing_videos_count}건`,
    );
    if (detect.errors.length > 0) {
      console.warn(
        `[cron/download] ⚠️ detect 부분 실패: ${detect.errors.join(" | ")}`,
      );
    }
  } catch (error) {
    const msg = toErrorMessage(error);
    console.warn(`[cron/download] ⚠️ detect 단계 실패(진행은 계속): ${msg}`);
  }

  // 3) 처리 대상 조회
  let pending: PendingVideo[] = [];
  try {
    pending = await fetchPendingVideos();
  } catch (error) {
    const msg = toErrorMessage(error);
    console.error(`[cron/download] ❌ 대상 조회 실패: ${msg}`);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }

  if (pending.length === 0) {
    const summary = "✨ 다운로드 대기 영상 없음 → 정상 종료";
    console.log(`[cron/download] ${summary}`);
    const responseBody: DownloadResponse = {
      success: true,
      timestamp: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
      summary,
      processed_count: 0,
      success_count: 0,
      failed_count: 0,
      successes: [],
      failures: [],
      errors: [],
    };
    // 다운로드할 게 없어도 파이프라인은 돌려야 한다.
    // 어제 다운로드 완료된 영상의 IG/FB/카페/메일 발행이 아직 남아 있을 수 있음.
    after(() => triggerPipeline(req));
    return NextResponse.json(responseBody);
  }

  console.log(`[cron/download] 🎬 다운로드 대기 ${pending.length}건 처리`);

  // 3) 영상별 처리 — 한 건 실패해도 다음 건은 계속
  const botBlockFailures: Array<{
    video_id: string;
    title: string | null;
    error: string;
  }> = [];
  for (const video of pending) {
    const label = `${video.video_id}${video.title ? ` (${video.title.slice(0, 30)})` : ""}`;
    try {
      console.log(`[cron/download] ▶ 시작: ${label}`);
      // Vercel 은 Drive 원본만 사용하고 ytdl 은 시도하지 않는다(allowYtdlFallback=false).
      // → 데이터센터 IP 봇차단/쿠키 경고메일을 원천 차단. ytdl 다운로드는 사무실 PC
      //   로컬 워커(C:\nowcar-worker)가 전담한다.
      const uploaded = await downloadAndUploadShort(video.video_id, {
        allowYtdlFallback: false,
      });
      await markDownloaded(video.id, uploaded.path);
      successes.push({
        video_id: video.video_id,
        storage_path: uploaded.path,
      });
      console.log(`[cron/download] ✅ 완료: ${label} → ${uploaded.path}`);
    } catch (error) {
      // Drive 원본도 없는 경우 = 로컬 워커가 받을 때까지 대기. 실패/메일 아님.
      if (isNoVercelSourceError(error)) {
        console.log(
          `[cron/download] ⏳ Drive 원본 없음 → 로컬 워커 대기(스킵): ${label}`,
        );
        continue;
      }
      const msg = toErrorMessage(error);
      failures.push({ video_id: video.video_id, reason: msg });
      errors.push(`[${video.video_id}] ${msg}`);
      console.error(`[cron/download] ❌ 실패: ${label} - ${msg}`);
      await markFailed(video.id, msg, video.download_attempts);
      if (isBotBlockError(msg)) {
        botBlockFailures.push({
          video_id: video.video_id,
          title: video.title,
          error: msg,
        });
      }
    }
  }

  // 봇차단 감지 시 운영자에게 메일 알림 (6h cooldown).
  if (botBlockFailures.length > 0) {
    const sample = botBlockFailures[0]!;
    const alertResult = await notifyBotBlockIfNeeded({
      failedVideos: botBlockFailures.map((f) => ({
        video_id: f.video_id,
        title: f.title,
      })),
      sampleError: sample.error,
    });
    console.log(
      `[cron/download] 🍪 봇차단 알림 처리: sent=${alertResult.sent} reason=${alertResult.reason}`,
    );
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const summary = `📥 다운로드 ${successes.length}/${pending.length} 성공 (실패 ${failures.length})`;

  console.log(`[cron/download] ${summary} (${durationSeconds}s)`);
  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const responseBody: DownloadResponse = {
    success: true,
    timestamp: new Date().toISOString(),
    duration_seconds: durationSeconds,
    summary,
    processed_count: pending.length,
    success_count: successes.length,
    failed_count: failures.length,
    successes,
    failures,
    errors,
  };

  // 응답 송신 후 파이프라인 발행 단계 트리거.
  after(() => triggerPipeline(req));
  return NextResponse.json(responseBody);
}

export async function GET(req: NextRequest) {
  return handleDownload(req);
}

export async function POST(req: NextRequest) {
  return handleDownload(req);
}
