import {
  createAdminClient,
  downloadAndUploadShort,
  isNoVercelSourceError,
  TEMP_VIDEOS_BUCKET,
} from "@/lib/storage";
import {
  buildInstagramCaption,
  buildThreadsCaption,
  isFacebookAutoPublishEnabled,
  isInstagramAutoPublishEnabled,
  isThreadsAutoPublishEnabled,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publishFacebookPagePost,
  publishFacebookReels,
  publishInstagramReel,
  publishThreadsPost,
} from "@/lib/meta";
import { getVideoDurationSeconds } from "@/lib/youtube";
import {
  isBotBlockError,
  notifyBotBlockIfNeeded,
} from "@/lib/youtube-bot-detect";
import { ensureMetaTokenLoaded } from "@/lib/meta-token";
import {
  isPastLocalWorkerGrace,
  LOCAL_WORKER_GRACE_MINUTES,
} from "@/lib/download-grace";
import { getMaxVideoAgeDays, recencyCutoffIso } from "@/lib/video-recency";

/**
 * ============================================================
 * lib/pipeline/publish-meta.ts
 * ------------------------------------------------------------
 * 파이프라인 [Step 2.5] — Meta 자동 발행
 *
 * 동작 흐름:
 *   1) youtube_videos 테이블에서 processed=true 인 최근 영상 N개 조회
 *   2) 각 영상별로 social_publishes 를 확인해
 *        - 인스타에 아직 성공 기록이 없으면 → 릴스 발행
 *        - 페북에 아직 성공 기록이 없으면   → Reels 네이티브 영상 발행
 *   3) 인스타 발행은 영상이 필요하므로 Supabase Storage 업로드까지 수행
 *   4) 한 영상/플랫폼이 실패해도 다른 건은 계속 처리(try-catch 개별화)
 *
 * 반환값은 /api/pipeline/run 에서 step 응답에 그대로 사용된다.
 * ============================================================
 */

export interface PublishMetaResult {
  ok: boolean;
  /** 이번 실행에서 검사한 영상 수 */
  processed_videos_count: number;
  /** 인스타 릴스 발행 성공 건수 */
  instagram_published_count: number;
  /** 인스타 릴스 발행 실패 건수 */
  instagram_failed_count: number;
  /** 인스타 스킵 건수 (이미 발행됨 / 비활성 / 콘텐츠 없음) */
  instagram_skipped_count: number;
  /** 페북 게시 성공 건수 */
  facebook_published_count: number;
  /** 페북 게시 실패 건수 */
  facebook_failed_count: number;
  /** 페북 스킵 건수 */
  facebook_skipped_count: number;
  /** 스레드 발행 성공 건수 */
  threads_published_count: number;
  /** 스레드 발행 실패 건수 */
  threads_failed_count: number;
  /** 스레드 스킵 건수 */
  threads_skipped_count: number;
  errors: string[];
}

/** SELECT 단에서 가져올 영상 수. alreadySuccess 영상을 제외하고도 후보가 남도록
 *  넉넉히 가져온다. (이전엔 3 — 5+ 영상 백로그가 영원히 자동 회복 안 되던 원인) */
const SELECT_PAGE_SIZE = 20;
/** 실제로 한 사이클에서 발행 시도할 미발행 영상 최대 개수.
 *  Vercel maxDuration=300s + 영상당 ~60-90s 처리 시간 고려해 안전선. */
const MAX_VIDEOS_PER_RUN = 3;
/** download_attempts 가 이 값 이상이면 인라인 다운로드도 포기 (cron 의 MAX_ATTEMPTS 와 동일) */
const INLINE_DOWNLOAD_MAX_ATTEMPTS = 5;
/**
 * IG Reels / FB Reels 짧은-폼 자동 발행 시 허용할 최대 영상 길이(초).
 * 인스타 Reels 컨테이너는 90초 한도 안에 FINISHED 되어야 하며, 그 이상은
 * "컨테이너가 90초 내에 FINISHED 상태가 되지 않았습니다." 오류로 매번 실패한다.
 * env `MAX_SHORT_PUBLISH_SECONDS` 로 덮어쓰기 가능 (기본 120 = 2분).
 */
const DEFAULT_MAX_SHORT_PUBLISH_SECONDS = 120;

type VideoRow = {
  id: string;
  video_id: string;
  title: string;
  video_url: string | null;
  storage_path: string | null;
  download_attempts: number | null;
  duration_seconds: number | null;
  created_at: string | null;
};

type ContentRow = {
  channel_type: string;
  body: string;
  hashtags: string | null;
};

type SocialPublishStatus = "pending" | "success" | "failed";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getPendingTtlMinutes(): number {
  const raw = process.env.PUBLISH_PENDING_TTL_MINUTES;
  if (!raw) return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.floor(parsed);
}

function getMaxShortPublishSeconds(): number {
  const raw = process.env.MAX_SHORT_PUBLISH_SECONDS;
  if (!raw) return DEFAULT_MAX_SHORT_PUBLISH_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SHORT_PUBLISH_SECONDS;
  }
  return Math.floor(parsed);
}

/**
 * 영상의 duration_seconds 를 보장한다.
 * - 이미 채워져 있으면 그 값으로 게이트 판정
 * - NULL 이면 YouTube API 단건 조회로 백필 시도
 * - 백필 결과가 NULL(API 실패) 이면 fail-open: 게이트 통과 (기존 동작 유지)
 *   → 신규 영상은 youtube/check 단계에서 미리 duration 을 저장하므로
 *      NULL 케이스는 레거시 영상에 한정. 레거시 영상은 대부분 이미 발행 완료라
 *      alreadySuccess set 으로 자연스럽게 스킵된다.
 */
async function ensureDurationWithinLimit(
  video: VideoRow,
  maxSeconds: number,
): Promise<{ ok: boolean; seconds: number | null; backfilled: boolean }> {
  if (video.duration_seconds != null) {
    return {
      ok: video.duration_seconds <= maxSeconds,
      seconds: video.duration_seconds,
      backfilled: false,
    };
  }

  const seconds = await getVideoDurationSeconds(video.video_id);
  if (seconds == null) {
    console.warn(
      `[publish-meta] ⚠️ duration 백필 실패(video_id=${video.video_id}) → 게이트 통과(레거시 동작)`,
    );
    return { ok: true, seconds: null, backfilled: false };
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("youtube_videos")
      .update({ duration_seconds: seconds })
      .eq("id", video.id);
    if (error) {
      console.warn(
        `[publish-meta] duration 백필 DB 업데이트 실패(${video.video_id}, 진행은 계속): ${error.message}`,
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[publish-meta] duration 백필 예외(${video.video_id}, 진행은 계속): ${msg}`,
    );
  }

  return { ok: seconds <= maxSeconds, seconds, backfilled: true };
}

/**
 * storage_path 가 비어 있으면 인라인으로 다운로드/업로드 시도.
 * Vercel cron(/api/cron/download) drift, PC-off 등으로 다운로드가 늦어져도
 * 매 10분 사이클의 publish-meta 단계에서 자가 회복되도록 하기 위함.
 *
 * 반환값:
 *   - 성공/이미 존재: 사용 가능한 storage_path
 *   - 실패: null (호출자가 스킵)
 */
async function ensureVideoDownloaded(video: VideoRow): Promise<string | null> {
  if (video.storage_path) {
    return video.storage_path;
  }

  const attempts = video.download_attempts ?? 0;
  if (attempts >= INLINE_DOWNLOAD_MAX_ATTEMPTS) {
    console.warn(
      `[publish-meta] ⏭ 인라인 다운로드 포기: video_id=${video.video_id}, attempts=${attempts}`,
    );
    return null;
  }

  // "로컬 워커 우선" 게이트: 감지 직후 GRACE(분) 내 영상은 Vercel ytdl 을
  // 시도하지 않고 로컬 워커(가정용 IP, 10분 주기)에게 양보한다. 데이터센터 IP
  // 에서 ytdl 을 때리면 봇차단에 걸려 쿠키 경고 메일이 발송되는데, 정상 운영
  // 중에는 로컬 워커가 곧 받아주므로 이 인라인 시도는 메일만 유발하고 무의미하다.
  // 다음 사이클에 storage_path 가 채워지면 그때 발행된다(IG/FB/Threads 는
  // 이미 storage_path 없으면 skip). 자세한 배경은 lib/download-grace.ts 참고.
  if (!isPastLocalWorkerGrace(video.created_at)) {
    console.log(
      `[publish-meta] ⏳ grace 내(${LOCAL_WORKER_GRACE_MINUTES}분) → 인라인 다운로드 보류, 로컬 워커 대기: video_id=${video.video_id}`,
    );
    return null;
  }

  console.log(
    `[publish-meta] 📥 storage_path 비어있음 → 인라인 다운로드 시도: video_id=${video.video_id}, prev_attempts=${attempts}`,
  );

  const supabase = createAdminClient();
  try {
    // Vercel 은 Drive 원본만 사용하고 ytdl 은 시도하지 않는다 → 봇차단/쿠키 경고메일
    // 원천 차단. ytdl 다운로드는 사무실 PC 로컬 워커가 전담.
    const uploaded = await downloadAndUploadShort(video.video_id, {
      allowYtdlFallback: false,
    });
    const { error } = await supabase
      .from("youtube_videos")
      .update({
        storage_path: uploaded.path,
        downloaded_at: new Date().toISOString(),
        download_error: null,
      })
      .eq("id", video.id);

    if (error) {
      console.warn(
        `[publish-meta] storage_path 업데이트 실패(진행은 계속): ${error.message}`,
      );
    }

    console.log(
      `[publish-meta] ✅ 인라인 다운로드 완료: ${uploaded.path} (${(uploaded.sizeBytes / 1024 / 1024).toFixed(2)} MB)`,
    );
    return uploaded.path;
  } catch (error) {
    // Drive 원본도 없는 경우 = 로컬 워커가 받을 때까지 대기. 실패/메일/ attempts 증가 아님.
    if (isNoVercelSourceError(error)) {
      console.log(
        `[publish-meta] ⏳ Drive 원본 없음 → 로컬 워커 대기(스킵): video_id=${video.video_id}`,
      );
      return null;
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[publish-meta] ❌ 인라인 다운로드 실패: ${msg}`);

    // A 안: 봇차단(쿠키 만료) 의심 → attempts 증가 안 함 + 알림 발송(throttled).
    const botBlock = isBotBlockError(msg);
    const nextAttempts = botBlock ? attempts : attempts + 1;
    const truncated = msg.slice(0, 500);
    const { error: updateError } = await supabase
      .from("youtube_videos")
      .update({
        download_attempts: nextAttempts,
        download_error: truncated,
        last_download_error: truncated,
        last_download_error_at: new Date().toISOString(),
      })
      .eq("id", video.id);

    if (updateError) {
      console.warn(
        `[publish-meta] 다운로드 실패 기록도 실패(진행은 계속): ${updateError.message}`,
      );
    }

    if (botBlock) {
      console.warn(
        `[publish-meta] 🍪 봇차단 감지(${video.video_id}) → attempts 유지(${nextAttempts}). 쿠키 갱신 시 자동 재시도.`,
      );
      const alertResult = await notifyBotBlockIfNeeded({
        failedVideos: [{ video_id: video.video_id, title: video.title }],
        sampleError: msg,
      });
      console.log(
        `[publish-meta] 🍪 봇차단 알림 처리: sent=${alertResult.sent} reason=${alertResult.reason}`,
      );
    }
    return null;
  }
}

async function cleanupStalePendingPublishes(
  ttlMinutes: number,
): Promise<void> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
  const { error } = await supabase
    .from("social_publishes")
    .update({
      status: "failed",
      error_message: "pending timeout",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "pending")
    .is("deleted_at", null)
    .lt("updated_at", cutoff);

  if (error) {
    console.warn(
      `[publish-meta] stale pending 정리 실패(진행은 계속): ${error.message}`,
    );
    return;
  }

  console.log(
    `[publish-meta] 🧹 stale pending 정리 완료 (ttl_minutes=${ttlMinutes})`,
  );
}

async function tryAcquirePublishPendingLock(params: {
  videoId: string;
  platform: "instagram" | "facebook" | "threads";
  storagePath: string | null;
  captionPreview: string | null;
}): Promise<boolean> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("social_publishes").insert({
    video_id: params.videoId,
    platform: params.platform,
    status: "pending" as SocialPublishStatus,
    external_id: null,
    storage_path: params.storagePath,
    caption_preview: params.captionPreview,
    error_message: null,
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
  });

  if (!error) return true;

  if ((error as { code?: string }).code === "23505") {
    return false;
  }

  throw new Error(`pending 선점 실패: ${error.message}`);
}

async function updatePublishPendingToFinal(params: {
  videoId: string;
  platform: "instagram" | "facebook" | "threads";
  status: "success" | "failed";
  externalId: string | null;
  errorMessage: string | null;
  captionPreview: string | null;
}): Promise<void> {
  const supabase = createAdminClient();
  // H3: 플랫폼 발행은 성공했는데 이 finalize(pending→success) DB 갱신만 실패하면
  // 행이 pending 으로 남고, cleanupStalePendingPublishes(TTL) 가 그걸 failed 로
  // 플립해 멱등성 레코드가 파괴된다 → 다음 사이클 중복 발행. 일시적 DB 오류로
  // success 가 묻히는 창을 줄이기 위해 최대 3회 재시도한다(특히 status='success').
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("social_publishes")
      .update({
        status: params.status,
        external_id: params.externalId,
        error_message: params.errorMessage,
        caption_preview: params.captionPreview,
        updated_at: new Date().toISOString(),
      })
      .eq("video_id", params.videoId)
      .eq("platform", params.platform)
      .eq("status", "pending")
      .is("deleted_at", null)
      .select("id");

    if (!error) {
      if (!data || data.length === 0) {
        console.warn(
          `[publish-meta] ⚠️ pending 행 미발견 (race condition 가능): video=${params.videoId}, platform=${params.platform}, target=${params.status}`,
        );
      }
      return;
    }

    lastError = error;
    console.warn(
      `[publish-meta] finalize 갱신 실패(재시도 ${attempt + 1}/3, target=${params.status}): ${error.message}`,
    );
  }

  throw new Error(
    `pending -> ${params.status} 상태 업데이트 실패(3회): ${lastError?.message ?? "알 수 없음"}`,
  );
}

/**
 * 파이프라인 Step 2.5: Meta 자동 발행
 */
export async function runPublishMetaStep(): Promise<PublishMetaResult> {
  const result: PublishMetaResult = {
    ok: true,
    processed_videos_count: 0,
    instagram_published_count: 0,
    instagram_failed_count: 0,
    instagram_skipped_count: 0,
    facebook_published_count: 0,
    facebook_failed_count: 0,
    facebook_skipped_count: 0,
    threads_published_count: 0,
    threads_failed_count: 0,
    threads_skipped_count: 0,
    errors: [],
  };

  const igEnabled = isInstagramAutoPublishEnabled();
  const fbEnabled = isFacebookAutoPublishEnabled();
  const thEnabled = isThreadsAutoPublishEnabled();
  const pendingTtlMinutes = getPendingTtlMinutes();
  const maxShortSeconds = getMaxShortPublishSeconds();

  if (!igEnabled && !fbEnabled && !thEnabled) {
    console.log(
      "[publish-meta] ⏭  AUTO_PUBLISH_INSTAGRAM/FACEBOOK/THREADS 모두 비활성 → 전체 스킵",
    );
    return result;
  }

  // Meta long-lived token prime/refresh. cron/download 진입부에서도 호출하지만,
  // pipeline/run 이 cron 외 경로로 트리거됐을 때를 대비해 여기서도 한 번.
  // 같은 invocation 안에서 두 번 호출되어도 DB 캐시 hit 로 비용은 작음.
  try {
    const tokenResult = await ensureMetaTokenLoaded();
    console.log(
      `[publish-meta] 🔑 Meta token: status=${tokenResult.status} expiresAt=${tokenResult.expiresAt ?? "-"}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[publish-meta] ⚠ Meta token prime 단계 실패(env 토큰 사용): ${msg}`,
    );
  }

  const supabase = createAdminClient();

  await cleanupStalePendingPublishes(pendingTtlMinutes);

  // 1) 대상 영상 조회 — SELECT 는 넉넉히 (백로그 자동 회복용), 처리는 MAX_VIDEOS_PER_RUN.
  //    duration 게이트: duration_seconds 가 채워져 있으면서 max 를 초과한 영상은
  //    SQL 단계에서 아예 제외한다. NULL(레거시/미수집) 은 통과시키고 영상 loop
  //    안에서 lazy backfill 후 다시 판정한다.
  // recency 게이트(방어선): published_at 이 윈도우(기본 14일)보다 오래된 영상은
  // 발행 후보에서 제외한다. 감지 단계(youtube/check)에서 이미 1차로 막지만,
  // 게이트 도입 전에 이미 저장돼 아직 미발행 상태로 남은 옛날 영상이 다음
  // 사이클에 SNS 로 나가는 것까지 차단하기 위함. 배경: lib/video-recency.ts
  const recencyCutoff = recencyCutoffIso();
  const { data: candidateVideos, error: videosError } = await supabase
    .from("youtube_videos")
    .select(
      "id, video_id, title, video_url, storage_path, download_attempts, duration_seconds, created_at",
    )
    .eq("processed", true)
    .gte("published_at", recencyCutoff)
    .or(`duration_seconds.is.null,duration_seconds.lte.${maxShortSeconds}`)
    .order("created_at", { ascending: false })
    .limit(SELECT_PAGE_SIZE);

  if (videosError) {
    throw new Error(`youtube_videos 조회 실패: ${videosError.message}`);
  }

  if (!candidateVideos || candidateVideos.length === 0) {
    console.log("[publish-meta] 처리 대상 영상이 없어 스킵");
    return result;
  }

  console.log(
    `[publish-meta] 📋 후보 영상 ${candidateVideos.length}개 (ig=${igEnabled}, fb=${fbEnabled}, th=${thEnabled}, max_seconds=${maxShortSeconds}, max_age_days=${getMaxVideoAgeDays()}, max_per_run=${MAX_VIDEOS_PER_RUN})`,
  );

  // 2) 이미 성공했거나, TTL 내 pending인 (video_id, platform) 조합 조회 → 중복 발행 방지
  //    중요: deleted_at 은 storage 파일이 cleanup 으로 삭제됐다는 의미일 뿐
  //    "발행 사실 자체"는 보존되어야 하므로 deleted_at 필터를 적용하지 않는다.
  //    (없으면 24h 후 cleanup → 다음 사이클이 "안 했네" 라며 재시도 → 파일 사라져 실패)
  const candidateVideoIds = candidateVideos.map((v) => v.video_id);
  const pendingCutoff = new Date(
    Date.now() - pendingTtlMinutes * 60_000,
  ).toISOString();
  const { data: publishedRows, error: publishedError } = await supabase
    .from("social_publishes")
    .select("video_id, platform, status, updated_at, deleted_at")
    .in("video_id", candidateVideoIds)
    .in("status", ["success", "pending"]);

  if (publishedError) {
    // M6/M13: 이 조회는 "이미 발행된 (video, platform)" = 중복방지의 진실원천이다.
    // 실패 시 빈 set 으로 계속 진행하면 모든 후보를 '미발행'으로 오인해 recency
    // 윈도우 전체를 재발행할 수 있다(중복 발행 대량 사고). fail-closed: 이번
    // 사이클 발행을 통째로 중단한다.
    const msg = `social_publishes 조회 실패 → 중복방지 불가로 발행 사이클 중단(fail-closed): ${publishedError.message}`;
    console.error(`[publish-meta] ❌ ${msg}`);
    result.ok = false;
    result.errors.push(msg);
    return result;
  }

  const successKey = (videoId: string, platform: string) =>
    `${videoId}::${platform}`;
  const alreadySuccess = new Set<string>(
    (publishedRows ?? [])
      .filter((r) => {
        if (r.status === "success") return true;
        const updatedAt = (r as { updated_at?: string | null }).updated_at;
        if (!updatedAt) return false;
        return updatedAt >= pendingCutoff;
      })
      .map((r) => successKey(r.video_id, r.platform)),
  );

  // M14: (video, platform) 별 누적 실패 횟수 cap. 영구 실패 영상이 매 사이클
  // 무한 재발행 시도(비용/로그/DB 오염, 또 cleanup 의 pending→failed 플립과 결합 시
  // 중복발행 재시도)하는 것을 막는다. 한도 도달 시 해당 (video, platform) 은 스킵.
  const MAX_META_FAIL_RETRIES = 5;
  const { data: failedRows, error: failedError } = await supabase
    .from("social_publishes")
    .select("video_id, platform")
    .in("video_id", candidateVideoIds)
    .eq("status", "failed")
    .is("deleted_at", null);
  if (failedError) {
    // fail-open: 실패 카운트를 못 구하면 cap 미적용(기존 동작). 중복방지의
    // 진실원천이 아니므로 발행을 막지는 않는다.
    console.warn(
      `[publish-meta] 실패 카운트 조회 실패(cap 미적용으로 진행): ${failedError.message}`,
    );
  }
  const failCount = new Map<string, number>();
  for (const r of failedRows ?? []) {
    const k = successKey(r.video_id, r.platform);
    failCount.set(k, (failCount.get(k) ?? 0) + 1);
  }
  const overFailCap = (videoId: string, platform: string) =>
    (failCount.get(successKey(videoId, platform)) ?? 0) >= MAX_META_FAIL_RETRIES;

  // 2.5) 후보 영상에서 모든 enabled 플랫폼이 alreadySuccess 인 영상은 미리 제외 →
  //     백로그 영상이 매번 같은 최신 3개에 가려져 영원히 처리 못 되던 문제 해결.
  const pendingVideos = (candidateVideos as VideoRow[]).filter((v) => {
    const needIg =
      igEnabled &&
      !alreadySuccess.has(successKey(v.video_id, "instagram")) &&
      !overFailCap(v.video_id, "instagram");
    const needFb =
      fbEnabled &&
      !alreadySuccess.has(successKey(v.video_id, "facebook")) &&
      !overFailCap(v.video_id, "facebook");
    const needTh =
      thEnabled &&
      !alreadySuccess.has(successKey(v.video_id, "threads")) &&
      !overFailCap(v.video_id, "threads");
    return needIg || needFb || needTh;
  });

  const videos = pendingVideos.slice(0, MAX_VIDEOS_PER_RUN);

  if (videos.length === 0) {
    console.log(
      `[publish-meta] ⏭  후보 ${candidateVideos.length}개 모두 이미 발행 완료 → 스킵`,
    );
    return result;
  }

  result.processed_videos_count = videos.length;
  console.log(
    `[publish-meta] 🎯 미발행 ${pendingVideos.length}개 중 ${videos.length}개 처리 시작`,
  );

  // 3) 영상별 반복 처리 — 하나 실패해도 다음 건은 계속
  for (const video of videos) {
    console.log(
      `\n[publish-meta] ━━━ 영상 처리 시작: ${video.title} (${video.video_id})`,
    );

    const needIg =
      igEnabled &&
      !alreadySuccess.has(successKey(video.video_id, "instagram")) &&
      !overFailCap(video.video_id, "instagram");
    const needFb =
      fbEnabled &&
      !alreadySuccess.has(successKey(video.video_id, "facebook")) &&
      !overFailCap(video.video_id, "facebook");
    const needTh =
      thEnabled &&
      !alreadySuccess.has(successKey(video.video_id, "threads")) &&
      !overFailCap(video.video_id, "threads");

    if (!needIg && !needFb && !needTh) {
      console.log(
        `[publish-meta] ⏭  이미 발행 완료/실패한도 도달 영상 → 스킵`,
      );
      if (igEnabled) result.instagram_skipped_count += 1;
      if (fbEnabled) result.facebook_skipped_count += 1;
      if (thEnabled) result.threads_skipped_count += 1;
      continue;
    }

    // 3.0) duration 게이트
    //      duration_seconds 가 NULL 이면 YouTube API 로 lazy backfill 후 판정.
    //      max 초과 시 IG/FB/Threads 모두 스킵 + DB 백필 → 다음 사이클부터는 SQL 필터로 자동 제외.
    const gate = await ensureDurationWithinLimit(video, maxShortSeconds);
    if (!gate.ok) {
      console.warn(
        `[publish-meta] ⏭ duration 게이트 차단: video_id=${video.video_id}, seconds=${gate.seconds ?? "?"}, max=${maxShortSeconds}`,
      );
      if (needIg) result.instagram_skipped_count += 1;
      if (needFb) result.facebook_skipped_count += 1;
      if (needTh) result.threads_skipped_count += 1;
      continue;
    }

    // 3.5) storage_path 가 없으면 인라인 다운로드 시도.
    //      성공하면 video.storage_path 를 갱신해 (A)/(B) 가 그대로 사용한다.
    const resolvedStoragePath = await ensureVideoDownloaded(video);
    if (!resolvedStoragePath) {
      // 다운로드 자체가 실패/한도 초과면 이번 사이클은 스킵하고 다음에 재시도
      if (needIg) result.instagram_skipped_count += 1;
      if (needFb) result.facebook_skipped_count += 1;
      if (needTh) result.threads_skipped_count += 1; // M-1: Threads 스킵 집계 누락 보정
      continue;
    }
    video.storage_path = resolvedStoragePath;

    // 4) 이 영상에 속한 generated_contents 조회
    //    → instagram 캡션/해시태그, threads 본문을 가져온다(naver_blog 폴백 제거됨).
    //    status 가 'failed' 또는 'cta_incomplete' 인 행은 발행 부적합이므로 제외.
    //    (cta_incomplete 는 CTA 키워드가 빠진 미완성 콘텐츠 — 발행되면 운영자
    //     톤/안내 정보가 누락된 채 SNS 에 올라가므로 차단)
    const { data: contentsRaw, error: contentsError } = await supabase
      .from("generated_contents")
      .select("channel_type, body, hashtags")
      .eq("video_id", video.id)
      .in("channel_type", ["instagram", "threads"])
      .not("status", "in", "(failed,cta_incomplete)");

    if (contentsError) {
      const msg = `generated_contents 조회 실패(${video.video_id}): ${contentsError.message}`;
      console.error(`[publish-meta] ❌ ${msg}`);
      result.errors.push(msg);
      if (needIg) result.instagram_failed_count += 1;
      if (needFb) result.facebook_failed_count += 1;
      if (needTh) result.threads_failed_count += 1;
      continue;
    }

    const contents = (contentsRaw ?? []) as ContentRow[];
    const igContent = contents.find((c) => c.channel_type === "instagram");
    const thContent = contents.find((c) => c.channel_type === "threads");

    // ────────────────────────────────────
    // (A) 인스타그램 Reels 발행
    // ────────────────────────────────────
    let storagePath: string | null = null;
    if (needIg) {
      if (!igContent?.body) {
        const msg = `인스타 스킵(${video.video_id}): instagram 채널 콘텐츠가 없음`;
        console.warn(`[publish-meta] ⚠️  ${msg}`);
        result.errors.push(msg);
        result.instagram_skipped_count += 1;
      } else {
        try {
          const storagePathFromDb = video.storage_path;
          if (!storagePathFromDb) {
            console.warn(
              `[publish-meta] ⏭  instagram skip: video_id=${video.video_id}, reason=storage_path not set by local worker`,
            );
            result.instagram_skipped_count += 1;
          } else {
            storagePath = storagePathFromDb;

            const { data: publicUrlData } = supabase.storage
              .from(TEMP_VIDEOS_BUCKET)
              .getPublicUrl(storagePathFromDb);
            const publicUrl = publicUrlData?.publicUrl;
            if (!publicUrl) {
              throw new Error(
                `스토리지 공개 URL 생성 실패(video_id=${video.video_id}, path=${storagePathFromDb})`,
              );
            }

            // 2) 캡션 조립
            const caption = buildInstagramCaption(
              igContent.body,
              igContent.hashtags,
            );

            let lockAcquired = false;
            lockAcquired = await tryAcquirePublishPendingLock({
              videoId: video.video_id,
              platform: "instagram",
              storagePath: storagePathFromDb,
              captionPreview: caption.slice(0, 200),
            });
            if (!lockAcquired) {
              console.log(
                `[publish-meta] ⏭  instagram skip: video_id=${video.video_id}, reason=pending/success lock exists`,
              );
              result.instagram_skipped_count += 1;
            } else {
              const publishResult = await publishInstagramReel({
                videoId: video.video_id,
                videoUrl: publicUrl,
                caption,
                storagePath: storagePathFromDb,
                recordResult: false,
              });

              if (publishResult.success) {
                await updatePublishPendingToFinal({
                  videoId: video.video_id,
                  platform: "instagram",
                  status: "success",
                  externalId: publishResult.externalId ?? null,
                  errorMessage: null,
                  captionPreview: caption.slice(0, 200),
                });
                result.instagram_published_count += 1;
              } else {
                await updatePublishPendingToFinal({
                  videoId: video.video_id,
                  platform: "instagram",
                  status: "failed",
                  externalId: null,
                  errorMessage:
                    publishResult.errorMessage ?? "instagram publish failed",
                  captionPreview: caption.slice(0, 200),
                });
                result.instagram_failed_count += 1;
                if (publishResult.errorMessage) {
                  result.errors.push(
                    `[instagram][${video.video_id}] ${publishResult.errorMessage}`,
                  );
                }
              }
            }
          }
        } catch (error) {
          const msg = toErrorMessage(error);
          try {
            await updatePublishPendingToFinal({
              videoId: video.video_id,
              platform: "instagram",
              status: "failed",
              externalId: null,
              errorMessage: msg,
              captionPreview: igContent?.body
                ? buildInstagramCaption(igContent.body, igContent.hashtags).slice(
                    0,
                    200,
                  )
                : null,
            });
          } catch (pendingErr) {
            // H-2: pending→final 갱신 실패를 조용히 삼키지 않고 노출한다.
            console.error(
              `[publish-meta] ⚠️ pending 상태 업데이트 실패(무시됨): ${toErrorMessage(pendingErr)}`,
            );
          }
          console.error(`[publish-meta] ❌ 인스타 처리 중 예외: ${msg}`);
          result.errors.push(`[instagram][${video.video_id}] ${msg}`);
          result.instagram_failed_count += 1;
        }
      }
    } else if (igEnabled) {
      // 이미 발행된 경우
      result.instagram_skipped_count += 1;
    }

    // ────────────────────────────────────
    // (B) 페이스북 Reels 네이티브 영상 발행
    //    → 캡션은 instagram 본문만 사용(FB 릴스도 IG 와 동일한 시청자/팬 톤).
    //    → storage_path 가 없으면 로컬 워커 완료까지 스킵
    // ────────────────────────────────────
    // C-3 픽스: 라벨을 달아 FB 내부 가드가 `continue`(=루프 다음 영상으로) 대신
    // `break fbBlock`(=FB 블록만 탈출)하게 한다. FB 스킵/실패가 같은 영상의 Threads
    // 발행(아래 (C) 블록)을 통째로 건너뛰던 데이터 손실 버그를 막는다.
    fbBlock: if (needFb) {
      const storagePathFromDb = video.storage_path;
      if (!storagePathFromDb) {
        console.warn(
          `[publish-meta] ⏭  facebook skip: video_id=${video.video_id}, reason=storage_path not set by local worker`,
        );
        result.facebook_skipped_count += 1;
      } else {
        // FB 릴스는 IG 와 동일한 시청자/팬 톤이 필수. naver_blog 본문(운영자 톤 +
        // 5종 CTA 박스 + 2000자)으로 폴백하면 톤 정책 위반 → Threads 와 동일하게
        // 폴백 금지하고 스킵. (데이터 2026-06-02: 블로그 폴백은 FB 발행 51건 중
        // 0건 발동한 dead path 였음 — 잠재 톤 위반 리스크만 제거.)
        const caption = igContent?.body
          ? buildInstagramCaption(igContent.body, igContent.hashtags)
          : null;

        if (!caption) {
          const msg = `페북 스킵(${video.video_id}): instagram 채널 콘텐츠가 없거나 생성 실패. naver_blog 폴백은 톤 정책 위반이라 사용하지 않음.`;
          console.warn(`[publish-meta] ⚠️  ${msg}`);
          result.errors.push(msg);
          result.facebook_skipped_count += 1;
          break fbBlock;
        }

        const { data: publicUrlData } = supabase.storage
          .from(TEMP_VIDEOS_BUCKET)
          .getPublicUrl(storagePathFromDb);
        const publicUrl = publicUrlData?.publicUrl;
        if (!publicUrl) {
          const msg = `페북 실패(${video.video_id}): 스토리지 공개 URL 생성 실패(path=${storagePathFromDb})`;
          console.error(`[publish-meta] ❌ ${msg}`);
          result.errors.push(msg);
          result.facebook_failed_count += 1;
          break fbBlock;
        }

        try {
          const lockAcquired = await tryAcquirePublishPendingLock({
            videoId: video.video_id,
            platform: "facebook",
            storagePath: storagePathFromDb,
            captionPreview: caption.slice(0, 200),
          });
          if (!lockAcquired) {
            console.log(
              `[publish-meta] ⏭  facebook skip: video_id=${video.video_id}, reason=pending/success lock exists`,
            );
            result.facebook_skipped_count += 1;
          } else {
            const publishResult = await publishFacebookReels({
              videoId: video.video_id,
              videoUrl: publicUrl,
              caption,
              storagePath: storagePathFromDb,
              recordResult: false,
            });

            if (publishResult.success) {
              await updatePublishPendingToFinal({
                videoId: video.video_id,
                platform: "facebook",
                status: "success",
                externalId: publishResult.externalId ?? null,
                errorMessage: null,
                captionPreview: caption.slice(0, 200),
              });
              result.facebook_published_count += 1;
            } else {
              await updatePublishPendingToFinal({
                videoId: video.video_id,
                platform: "facebook",
                status: "failed",
                externalId: null,
                errorMessage:
                  publishResult.errorMessage ?? "facebook reels publish failed",
                captionPreview: caption.slice(0, 200),
              });
              result.facebook_failed_count += 1;
              if (publishResult.errorMessage) {
                result.errors.push(
                  `[facebook][${video.video_id}] ${publishResult.errorMessage}`,
                );
              }
            }
          }
        } catch (error) {
          const msg = toErrorMessage(error);
          try {
            await updatePublishPendingToFinal({
              videoId: video.video_id,
              platform: "facebook",
              status: "failed",
              externalId: null,
              errorMessage: msg,
              captionPreview: caption.slice(0, 200),
            });
          } catch (pendingErr) {
            // H-2: pending→final 갱신 실패를 조용히 삼키지 않고 노출한다.
            console.error(
              `[publish-meta] ⚠️ pending 상태 업데이트 실패(무시됨): ${toErrorMessage(pendingErr)}`,
            );
          }
          console.error(`[publish-meta] ❌ 페북 처리 중 예외: ${msg}`);
          result.errors.push(`[facebook][${video.video_id}] ${msg}`);
          result.facebook_failed_count += 1;
        }
      }
    } else if (fbEnabled) {
      result.facebook_skipped_count += 1;
    }

    // ────────────────────────────────────
    // (C) 스레드 발행 (graph.threads.net)
    //    → 캡션 우선순위: threads 채널 본문 > instagram 본문
    //    → storage_path 가 없으면 로컬 워커 완료까지 스킵 (IG/FB 와 동일)
    // ────────────────────────────────────
    if (needTh) {
      const storagePathFromDb = video.storage_path;
      if (!storagePathFromDb) {
        console.warn(
          `[publish-meta] ⏭  threads skip: video_id=${video.video_id}, reason=storage_path not set by local worker`,
        );
        result.threads_skipped_count += 1;
      } else {
        // Threads 는 자체 마케터 톤(반말·4단 구조)이 필수. 인스타 캡션으로
        // 폴백하면 톤 정책 위반(존댓말·CTA·이모지 박스 등) → 스킵 + 에러 로깅.
        // [[project_threads_auto_marketer_tone]], [[feedback_threads_marketer_prompt]]
        const caption = thContent?.body
          ? buildThreadsCaption(thContent.body, thContent.hashtags)
          : null;

        if (!caption) {
          const msg = `스레드 스킵(${video.video_id}): threads 채널 콘텐츠가 없거나 생성 실패. 인스타 캡션 폴백은 톤 정책 위반이라 사용하지 않음.`;
          console.warn(`[publish-meta] ⚠️  ${msg}`);
          result.errors.push(msg);
          result.threads_skipped_count += 1;
        } else {
          const { data: publicUrlData } = supabase.storage
            .from(TEMP_VIDEOS_BUCKET)
            .getPublicUrl(storagePathFromDb);
          const publicUrl = publicUrlData?.publicUrl;
          if (!publicUrl) {
            const msg = `스레드 실패(${video.video_id}): 스토리지 공개 URL 생성 실패(path=${storagePathFromDb})`;
            console.error(`[publish-meta] ❌ ${msg}`);
            result.errors.push(msg);
            result.threads_failed_count += 1;
          } else {
            try {
              const lockAcquired = await tryAcquirePublishPendingLock({
                videoId: video.video_id,
                platform: "threads",
                storagePath: storagePathFromDb,
                captionPreview: caption.slice(0, 200),
              });
              if (!lockAcquired) {
                console.log(
                  `[publish-meta] ⏭  threads skip: video_id=${video.video_id}, reason=pending/success lock exists`,
                );
                result.threads_skipped_count += 1;
              } else {
                const publishResult = await publishThreadsPost({
                  videoId: video.video_id,
                  videoUrl: publicUrl,
                  caption,
                  storagePath: storagePathFromDb,
                  recordResult: false,
                });

                if (publishResult.success) {
                  await updatePublishPendingToFinal({
                    videoId: video.video_id,
                    platform: "threads",
                    status: "success",
                    externalId: publishResult.externalId ?? null,
                    errorMessage: null,
                    captionPreview: caption.slice(0, 200),
                  });
                  result.threads_published_count += 1;
                } else {
                  await updatePublishPendingToFinal({
                    videoId: video.video_id,
                    platform: "threads",
                    status: "failed",
                    externalId: null,
                    errorMessage:
                      publishResult.errorMessage ?? "threads publish failed",
                    captionPreview: caption.slice(0, 200),
                  });
                  result.threads_failed_count += 1;
                  if (publishResult.errorMessage) {
                    result.errors.push(
                      `[threads][${video.video_id}] ${publishResult.errorMessage}`,
                    );
                  }
                }
              }
            } catch (error) {
              const msg = toErrorMessage(error);
              try {
                await updatePublishPendingToFinal({
                  videoId: video.video_id,
                  platform: "threads",
                  status: "failed",
                  externalId: null,
                  errorMessage: msg,
                  captionPreview: caption.slice(0, 200),
                });
              } catch (pendingErr) {
                // H-2: pending→final 갱신 실패를 조용히 삼키지 않고 노출한다.
                console.error(
                  `[publish-meta] ⚠️ pending 상태 업데이트 실패(무시됨): ${toErrorMessage(pendingErr)}`,
                );
              }
              console.error(`[publish-meta] ❌ 스레드 처리 중 예외: ${msg}`);
              result.errors.push(`[threads][${video.video_id}] ${msg}`);
              result.threads_failed_count += 1;
            }
          }
        }
      }
    } else if (thEnabled) {
      result.threads_skipped_count += 1;
    }

    // 디버깅용 영상 요약 로그
    console.log(
      `[publish-meta] ✔︎ 영상 ${video.video_id} 처리 종료 (ig_need=${needIg}, fb_need=${needFb}, th_need=${needTh}, storage=${storagePath ?? "-"})`,
    );
  }

  // 전체 실패 여부 판단(발행 시도는 있었으나 전부 실패한 경우 ok=false)
  const totalTried =
    result.instagram_published_count +
    result.instagram_failed_count +
    result.facebook_published_count +
    result.facebook_failed_count +
    result.threads_published_count +
    result.threads_failed_count;
  const totalSucceeded =
    result.instagram_published_count +
    result.facebook_published_count +
    result.threads_published_count;

  result.ok = totalTried === 0 || totalSucceeded > 0;

  return result;
}
