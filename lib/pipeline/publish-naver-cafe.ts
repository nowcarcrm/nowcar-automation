import {
  NaverApiError,
  NaverTokenError,
  isNaverCafeAutoPublishEnabled,
  publishNaverCafeArticle,
} from "@/lib/naver";
import { createAdminClient } from "@/lib/storage";
import { recencyCutoffIso } from "@/lib/video-recency";
import {
  CAFE_BLOCK_BACKOFF_HOURS,
  getNaverCafeBlockState,
  isNaverCafe999Error,
  notifyNaverCafeBlockIfNeeded,
} from "@/lib/naver-cafe-block";

export interface PublishNaverCafeResult {
  ok: boolean;
  processed_videos_count: number;
  naver_cafe_published_count: number;
  naver_cafe_failed_count: number;
  naver_cafe_skipped_count: number;
  errors: string[];
}

/** SELECT 단에서 가져올 영상 수. 실제 처리(발행 시도)는 한 사이클 1건 cap.
 *  SELECT 를 넉넉히 가져와 alreadySuccess 영상을 제외하고도 후보가 남도록 한다.
 *  (3 → 20 으로 변경. 5+ 영상 백로그도 자동 회복하기 위함) */
const SELECT_PAGE_SIZE = 20;
/** 한 사이클에 카페 발행 시도하는 영상 최대 개수.
 *  Naver 999 "연속 등록 불가" 응답을 피하려고 1건 hard cap. */
const MAX_PUBLISH_PER_RUN = 1;
/** 영상 감지 시각 이후 발행까지 더할 무작위 지연(상한). 매일 같은 시각에
 *  같은 포맷으로 글 올라가는 패턴을 깨서 네이버 어뷰징 감지기를 회피한다. */
const PUBLISH_JITTER_MAX_MINUTES = 120;
/** 마지막 카페 발행 성공 후 이 시간이 지나야 다음 발행 시도(=하루 1건 cap). */
const MIN_INTERVAL_HOURS = 18;

type VideoRow = {
  id: string;
  video_id: string;
  title: string;
  video_url: string | null;
  created_at: string;
};

type ContentRow = {
  title: string | null;
  body: string;
};

type SocialPublishStatus = "pending" | "success" | "failed";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getPendingTtlMinutes(): number {
  // M-9: publish-meta 와 기본값 통일(이전 10분 → 20분). 동일 env 미설정 시 플랫폼별
  // cleanup 타이밍이 달라 H-3/H-4 레이스 윈도가 달라지던 불일치 제거.
  const raw = process.env.PUBLISH_PENDING_TTL_MINUTES;
  if (!raw) return 20;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.floor(parsed);
}

function buildCafeSubject(contentTitle: string | null, videoTitle: string): string {
  const base = contentTitle?.trim() ? contentTitle.trim() : videoTitle.trim();
  return base.length > 100 ? base.slice(0, 100).trimEnd() : base;
}

/** video.id(UUID) 를 32-bit 정수 hash 로 변환. 결정적이라 같은 영상은 항상 같은 값. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h * 31) + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 영상 감지 후 발행까지 추가로 둘 지연(분). 영상마다 다른 값(0~PUBLISH_JITTER_MAX). */
function getPublishDelayMinutes(videoUuid: string): number {
  return hashSeed(videoUuid) % (PUBLISH_JITTER_MAX_MINUTES + 1);
}

/** 배열을 seed 기반으로 결정적 회전. 같은 영상은 항상 같은 회전, 영상마다 다른 순서. */
function rotateBySeed<T>(arr: readonly T[], seed: string): T[] {
  if (arr.length === 0) return [];
  const offset = hashSeed(seed) % arr.length;
  return [...arr.slice(offset), ...arr.slice(0, offset)];
}

const HASHTAG_POOL = [
  "#신차장기렌트",
  "#장기렌트",
  "#리스",
  "#신차리스",
  "#법인리스",
  "#개인리스",
  "#즉시출고",
  "#신차프로모션",
  "#신차할인",
  "#장기렌트견적",
  "#리스견적",
  "#국산차장기렌트",
  "#수입차리스",
  "#나우카",
] as const;

const VIDEO_LABEL_POOL = [
  "🎬 영상 보기",
  "📹 영상 확인",
  "🎥 자세히 영상으로",
  "🎞️ 영상 링크",
  "▶️ 영상으로 보기",
] as const;

const TAG_LABEL_POOL = [
  "🔖 태그",
  "🏷️ 관련 태그",
  "📌 키워드",
  "#️⃣ 태그",
] as const;

function buildCafeBody(
  contentBody: string,
  videoUrl: string | null,
  seed: string,
): string {
  const hashtags = rotateBySeed(HASHTAG_POOL, seed).join(" ");
  const videoLabel = VIDEO_LABEL_POOL[hashSeed(seed) % VIDEO_LABEL_POOL.length];
  const tagLabel = TAG_LABEL_POOL[hashSeed(`${seed}-tag`) % TAG_LABEL_POOL.length];

  const withVideoLink = videoUrl
    ? `${contentBody.trim()}\n\n${videoLabel}: ${videoUrl}`
    : contentBody.trim();

  const withHashtags = `${withVideoLink}\n\n${tagLabel}\n${hashtags}`;

  return withHashtags.length > 10000
    ? withHashtags.slice(0, 10000).trimEnd()
    : withHashtags;
}

async function tryAcquireNaverCafePendingLock(params: {
  videoId: string;
  captionPreview: string | null;
}): Promise<boolean> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("social_publishes").insert({
    video_id: params.videoId,
    platform: "naver_cafe",
    status: "pending" as SocialPublishStatus,
    external_id: null,
    storage_path: null,
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

async function updateNaverCafePendingToFinal(params: {
  videoId: string;
  status: "success" | "failed";
  externalId: string | null;
  errorMessage: string | null;
  captionPreview: string | null;
}): Promise<void> {
  const supabase = createAdminClient();
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
    .eq("platform", "naver_cafe")
    .eq("status", "pending")
    .is("deleted_at", null)
    .select("id");

  if (error) {
    throw new Error(`pending -> ${params.status} 상태 업데이트 실패: ${error.message}`);
  }
  // H-4: 0행 매칭(pending 이 cleanup/TTL 정리로 사라졌거나 동시성 레이스) 시 경고.
  // 발행 결과가 DB 에 반영 안 됐을 수 있어 모니터링에 노출한다(이전엔 조용히 통과).
  if (!data || data.length === 0) {
    console.warn(
      `[publish-naver-cafe] ⚠️ pending→${params.status} 0행 매칭(video_id=${params.videoId}). cleanup/레이스로 발행 결과 미반영 가능성.`,
    );
  }
}

export async function runPublishNaverCafeStep(): Promise<PublishNaverCafeResult> {
  const result: PublishNaverCafeResult = {
    ok: true,
    processed_videos_count: 0,
    naver_cafe_published_count: 0,
    naver_cafe_failed_count: 0,
    naver_cafe_skipped_count: 0,
    errors: [],
  };

  if (!isNaverCafeAutoPublishEnabled()) {
    console.log(
      "[publish-naver-cafe] ⏭ AUTO_PUBLISH_NAVER_CAFE=true 가 아니므로 스킵",
    );
    return result;
  }

  const pendingTtlMinutes = getPendingTtlMinutes();
  const supabase = createAdminClient();

  // 999 차단 서킷 브레이커: 최근 카페 시도가 999 실패이고 backoff 윈도우(기본 6h)
  // 내면 이번 사이클은 발행을 아예 시도하지 않는다. 차단 상태에서 반복 호출이
  // 네이버 측 제한을 연장시키는 것을 막기 위함. 윈도우를 넘기면 brake 가 풀려
  // 1회 probe 가 허용되고, 그 시도가 성공하면 자동 재개된다. 배경: lib/naver-cafe-block.ts
  const blockState = await getNaverCafeBlockState();
  if (blockState.blocked) {
    console.warn(
      `[publish-naver-cafe] ⛔ 999 차단 감지 → 이번 사이클 발행 보류(backoff ${CAFE_BLOCK_BACKOFF_HOURS}h, last_failed_at=${blockState.lastFailedAt}). 네이버 계정 글쓰기 제한 여부 확인 필요.`,
    );
    const alert = await notifyNaverCafeBlockIfNeeded({
      sampleError: blockState.lastError ?? "naver_cafe 999 block",
    });
    console.log(
      `[publish-naver-cafe] 🔔 차단 알림 처리: sent=${alert.sent} reason=${alert.reason}`,
    );
    return result;
  }

  // 하루 1건 hard cap: 최근 MIN_INTERVAL_HOURS 내에 카페 발행 성공이 있으면
  // 이번 사이클은 통째로 스킵. 네이버 카페 어뷰징 감지기에 "하루 1회 이하"
  // 패턴으로 보이게 해서 차단 위험을 낮춘다.
  const minIntervalCutoff = new Date(
    Date.now() - MIN_INTERVAL_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { count: recentSuccessCount, error: recentError } = await supabase
    .from("social_publishes")
    .select("*", { count: "exact", head: true })
    .eq("platform", "naver_cafe")
    .eq("status", "success")
    .gte("updated_at", minIntervalCutoff);

  if (recentError) {
    console.warn(
      `[publish-naver-cafe] 최근 발행 조회 실패(보수적으로 스킵): ${recentError.message}`,
    );
    return result;
  }

  if ((recentSuccessCount ?? 0) >= 1) {
    console.log(
      `[publish-naver-cafe] ⏭ 최근 ${MIN_INTERVAL_HOURS}h 내 이미 발행 성공 → 하루 1건 cap 적용, 스킵`,
    );
    return result;
  }

  // recency 게이트(방어선): published_at 이 윈도우(기본 14일)보다 오래된 영상은
  // 카페 발행 후보에서 제외. 감지 단계에서 1차 차단하지만, 게이트 도입 전에
  // 이미 저장된 옛날 영상의 재발행까지 막는다. 배경: lib/video-recency.ts
  const { data: videos, error: videosError } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, video_url, created_at")
    .eq("processed", true)
    .gte("published_at", recencyCutoffIso())
    .order("created_at", { ascending: false })
    .limit(SELECT_PAGE_SIZE);

  if (videosError) {
    throw new Error(`youtube_videos 조회 실패: ${videosError.message}`);
  }

  if (!videos || videos.length === 0) {
    console.log("[publish-naver-cafe] 처리 대상 영상이 없어 스킵");
    return result;
  }

  result.processed_videos_count = videos.length;

  // 이미 success 거나, TTL 내 pending 인 (video_id, naver_cafe) 조합 → 중복 발행 방지
  //   deleted_at 필터를 적용하지 않는 이유는 publish-meta 와 동일:
  //   cleanup 으로 storage 파일이 사라져도 "발행 성공" 사실은 그대로 유지되어야 한다.
  const videoIds = videos.map((v) => v.video_id);
  const pendingCutoff = new Date(
    Date.now() - pendingTtlMinutes * 60_000,
  ).toISOString();
  const { data: publishedRows, error: publishedError } = await supabase
    .from("social_publishes")
    .select("video_id, status, updated_at, deleted_at")
    .in("video_id", videoIds)
    .eq("platform", "naver_cafe")
    .in("status", ["success", "pending"]);

  if (publishedError) {
    console.warn(
      `[publish-naver-cafe] social_publishes 조회 실패(진행은 계속): ${publishedError.message}`,
    );
  }

  const alreadyBlocked = new Set<string>(
    (publishedRows ?? [])
      .filter((r) => {
        if (r.status === "success") return true;
        const updatedAt = (r as { updated_at?: string | null }).updated_at;
        if (!updatedAt) return false;
        return updatedAt >= pendingCutoff;
      })
      .map((r) => r.video_id),
  );

  const MAX_NAVER_FAIL_RETRIES = 5;
  const { data: failedRows } = await supabase
    .from("social_publishes")
    .select("video_id")
    .in("video_id", videoIds)
    .eq("platform", "naver_cafe")
    .eq("status", "failed")
    .is("deleted_at", null);
  const failCountByVideo = new Map<string, number>();
  for (const r of failedRows ?? []) {
    failCountByVideo.set(r.video_id, (failCountByVideo.get(r.video_id) ?? 0) + 1);
  }

  for (const video of videos as VideoRow[]) {
    if (alreadyBlocked.has(video.video_id)) {
      result.naver_cafe_skipped_count += 1;
      continue;
    }

    const failCount = failCountByVideo.get(video.video_id) ?? 0;
    if (failCount >= MAX_NAVER_FAIL_RETRIES) {
      console.log(
        `[publish-naver-cafe] ⏭ skip: video_id=${video.video_id}, reason=failed ${failCount} times (max=${MAX_NAVER_FAIL_RETRIES})`,
      );
      result.naver_cafe_skipped_count += 1;
      continue;
    }

    // 시각 jitter: 같은 시각에 매일 발행되는 패턴을 깨기 위해
    // 영상 감지(created_at) 후 video.id 해시 기반 결정적 지연을 적용.
    // earliestPublishAt 이전이면 이번 사이클에선 건너뛰고 다음에 다시.
    const delayMinutes = getPublishDelayMinutes(video.id);
    const earliestPublishAt =
      new Date(video.created_at).getTime() + delayMinutes * 60_000;
    if (Date.now() < earliestPublishAt) {
      const remainingMin = Math.ceil((earliestPublishAt - Date.now()) / 60_000);
      console.log(
        `[publish-naver-cafe] ⏰ video_id=${video.video_id} 발행 지연 중 (총 ${delayMinutes}분 jitter, 남은 ${remainingMin}분)`,
      );
      result.naver_cafe_skipped_count += 1;
      continue;
    }

    const { data: contentsRaw, error: contentsError } = await supabase
      .from("generated_contents")
      .select("title, body")
      .eq("video_id", video.id)
      .eq("channel_type", "naver_cafe")
      .neq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1);

    if (contentsError) {
      const msg = `generated_contents 조회 실패(${video.video_id}): ${contentsError.message}`;
      console.error(`[publish-naver-cafe] ❌ ${msg}`);
      result.errors.push(msg);
      result.naver_cafe_failed_count += 1;
      continue;
    }

    const content = (contentsRaw?.[0] ?? null) as ContentRow | null;
    if (!content?.body) {
      const msg = `네이버 카페 스킵(${video.video_id}): naver_cafe 콘텐츠가 없음`;
      console.warn(`[publish-naver-cafe] ⚠️ ${msg}`);
      result.errors.push(msg);
      result.naver_cafe_skipped_count += 1;
      continue;
    }

    const subject = buildCafeSubject(content.title, video.title);
    const contentText = buildCafeBody(content.body, video.video_url, video.id);
    const captionPreview = contentText.slice(0, 200);

    let lockAcquired = false;
    try {
      lockAcquired = await tryAcquireNaverCafePendingLock({
        videoId: video.video_id,
        captionPreview,
      });
    } catch (lockError) {
      const msg = toErrorMessage(lockError);
      console.error(`[publish-naver-cafe] ❌ pending lock 선점 예외: ${msg}`);
      result.errors.push(`[naver_cafe][${video.video_id}] ${msg}`);
      result.naver_cafe_failed_count += 1;
      continue;
    }

    if (!lockAcquired) {
      console.log(
        `[publish-naver-cafe] ⏭ skip: video_id=${video.video_id}, reason=pending/success lock exists`,
      );
      result.naver_cafe_skipped_count += 1;
      continue;
    }

    try {
      const publishResult = await publishNaverCafeArticle({
        subject,
        contentText,
      });

      if (publishResult.success) {
        result.naver_cafe_published_count += 1;
        await updateNaverCafePendingToFinal({
          videoId: video.video_id,
          status: "success",
          externalId: publishResult.externalId ?? null,
          errorMessage: null,
          captionPreview,
        });
        // 한 사이클 1건 hard cap — Naver 의 "연속 등록 불가(999)" 봇감지
        // 응답을 피하기 위해 한 영상 발행 성공 직후 종료한다.
        if (result.naver_cafe_published_count >= MAX_PUBLISH_PER_RUN) {
          console.log(
            `[publish-naver-cafe] ✅ ${MAX_PUBLISH_PER_RUN}건 발행 완료 → 하루 1건 cap 으로 사이클 종료`,
          );
          break;
        }
      } else {
        result.naver_cafe_failed_count += 1;
        const msg = publishResult.errorMessage ?? "알 수 없는 발행 실패";
        result.errors.push(`[naver_cafe][${video.video_id}] ${msg}`);
        await updateNaverCafePendingToFinal({
          videoId: video.video_id,
          status: "failed",
          externalId: null,
          errorMessage: msg,
          captionPreview,
        });
        // probe 시도가 다시 999 면 차단 지속 → 알림(throttled) + 다음 사이클부터
        // 서킷 브레이커가 재차단(backoff)한다.
        if (isNaverCafe999Error(msg)) {
          await notifyNaverCafeBlockIfNeeded({ sampleError: msg });
        }
      }
    } catch (error) {
      const msg = toErrorMessage(error);
      if (error instanceof NaverTokenError) {
        console.error(
          `[publish-naver-cafe] ❌ 토큰 갱신 실패(재발급 필요 가능성): ${msg}`,
        );
      } else if (error instanceof NaverApiError) {
        console.error(
          `[publish-naver-cafe] ❌ API 호출 실패: status=${error.status}, endpoint=${error.endpoint}, message=${msg}`,
        );
      } else {
        console.error(`[publish-naver-cafe] ❌ 발행 실패: ${msg}`);
      }

      result.errors.push(`[naver_cafe][${video.video_id}] ${msg}`);
      result.naver_cafe_failed_count += 1;

      try {
        await updateNaverCafePendingToFinal({
          videoId: video.video_id,
          status: "failed",
          externalId: null,
          errorMessage: msg,
          captionPreview,
        });
      } catch (updateError) {
        console.error(
          `[publish-naver-cafe] pending → failed 업데이트 실패: ${toErrorMessage(updateError)}`,
        );
      }

      // probe 시도가 다시 999 면 차단 지속 → 알림(throttled).
      if (isNaverCafe999Error(msg)) {
        await notifyNaverCafeBlockIfNeeded({ sampleError: msg });
      }
    }
  }

  const totalTried =
    result.naver_cafe_published_count + result.naver_cafe_failed_count;
  result.ok = totalTried === 0 || result.naver_cafe_published_count > 0;

  return result;
}
