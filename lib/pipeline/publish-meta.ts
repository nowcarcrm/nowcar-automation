import { createAdminClient, TEMP_VIDEOS_BUCKET } from "@/lib/storage";
import {
  buildInstagramCaption,
  isFacebookAutoPublishEnabled,
  isInstagramAutoPublishEnabled,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publishFacebookPagePost,
  publishFacebookReels,
  publishInstagramReel,
} from "@/lib/meta";

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
  errors: string[];
}

/** 한 번에 처리할 최대 영상 수(백로그 폭주 방지) */
const MAX_VIDEOS_PER_RUN = 3;

type VideoRow = {
  id: string;
  video_id: string;
  title: string;
  video_url: string | null;
  storage_path: string | null;
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
  if (!raw) return 10;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.floor(parsed);
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
  platform: "instagram" | "facebook";
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
  platform: "instagram" | "facebook";
  status: "success" | "failed";
  externalId: string | null;
  errorMessage: string | null;
  captionPreview: string | null;
}): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
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
    .is("deleted_at", null);

  if (error) {
    throw new Error(`pending -> ${params.status} 상태 업데이트 실패: ${error.message}`);
  }
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
    errors: [],
  };

  const igEnabled = isInstagramAutoPublishEnabled();
  const fbEnabled = isFacebookAutoPublishEnabled();
  const pendingTtlMinutes = getPendingTtlMinutes();

  if (!igEnabled && !fbEnabled) {
    console.log(
      "[publish-meta] ⏭  AUTO_PUBLISH_INSTAGRAM/FACEBOOK 둘 다 비활성 → 전체 스킵",
    );
    return result;
  }

  const supabase = createAdminClient();

  await cleanupStalePendingPublishes(pendingTtlMinutes);

  // 1) 대상 영상 조회
  const { data: videos, error: videosError } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, video_url, storage_path")
    .eq("processed", true)
    .order("created_at", { ascending: false })
    .limit(MAX_VIDEOS_PER_RUN);

  if (videosError) {
    throw new Error(`youtube_videos 조회 실패: ${videosError.message}`);
  }

  if (!videos || videos.length === 0) {
    console.log("[publish-meta] 처리 대상 영상이 없어 스킵");
    return result;
  }

  result.processed_videos_count = videos.length;
  console.log(
    `[publish-meta] 📋 대상 영상 ${videos.length}개 (ig=${igEnabled}, fb=${fbEnabled})`,
  );

  // 2) 이미 성공했거나, TTL 내 pending인 (video_id, platform) 조합 조회 → 중복 발행 방지
  const videoIds = videos.map((v) => v.video_id);
  const pendingCutoff = new Date(
    Date.now() - pendingTtlMinutes * 60_000,
  ).toISOString();
  const { data: publishedRows, error: publishedError } = await supabase
    .from("social_publishes")
    .select("video_id, platform, status, updated_at")
    .in("video_id", videoIds)
    .is("deleted_at", null)
    .in("status", ["success", "pending"]);

  if (publishedError) {
    console.warn(
      `[publish-meta] social_publishes 조회 실패(진행은 계속): ${publishedError.message}`,
    );
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

  // 3) 영상별 반복 처리 — 하나 실패해도 다음 건은 계속
  for (const video of videos as VideoRow[]) {
    console.log(
      `\n[publish-meta] ━━━ 영상 처리 시작: ${video.title} (${video.video_id})`,
    );

    const needIg =
      igEnabled && !alreadySuccess.has(successKey(video.video_id, "instagram"));
    const needFb =
      fbEnabled && !alreadySuccess.has(successKey(video.video_id, "facebook"));

    if (!needIg && !needFb) {
      console.log(`[publish-meta] ⏭  이미 발행 완료된 영상 → 스킵`);
      if (igEnabled) result.instagram_skipped_count += 1;
      if (fbEnabled) result.facebook_skipped_count += 1;
      continue;
    }

    // 4) 이 영상에 속한 generated_contents 조회
    //    → instagram 캡션/해시태그, naver_blog 본문을 가져온다.
    const { data: contentsRaw, error: contentsError } = await supabase
      .from("generated_contents")
      .select("channel_type, body, hashtags")
      .eq("video_id", video.id)
      .in("channel_type", ["instagram", "naver_blog"])
      .neq("status", "failed");

    if (contentsError) {
      const msg = `generated_contents 조회 실패(${video.video_id}): ${contentsError.message}`;
      console.error(`[publish-meta] ❌ ${msg}`);
      result.errors.push(msg);
      if (needIg) result.instagram_failed_count += 1;
      if (needFb) result.facebook_failed_count += 1;
      continue;
    }

    const contents = (contentsRaw ?? []) as ContentRow[];
    const igContent = contents.find((c) => c.channel_type === "instagram");
    const blogContent = contents.find((c) => c.channel_type === "naver_blog");

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
          } catch {
            // pending 상태 업데이트 실패는 기존 에러 로그로 추적
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
    //    → 캡션 우선순위: instagram 본문 > naver_blog 본문
    //    → storage_path 가 없으면 로컬 워커 완료까지 스킵
    // ────────────────────────────────────
    if (needFb) {
      const storagePathFromDb = video.storage_path;
      if (!storagePathFromDb) {
        console.warn(
          `[publish-meta] ⏭  facebook skip: video_id=${video.video_id}, reason=storage_path not set by local worker`,
        );
        result.facebook_skipped_count += 1;
      } else {
        const caption = igContent?.body
          ? buildInstagramCaption(igContent.body, igContent.hashtags)
          : blogContent?.body?.trim() ?? null;

        if (!caption) {
          const msg = `페북 스킵(${video.video_id}): instagram/naver_blog 캡션 소스가 없음`;
          console.warn(`[publish-meta] ⚠️  ${msg}`);
          result.errors.push(msg);
          result.facebook_skipped_count += 1;
          continue;
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
          continue;
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
          } catch {
            // pending 상태 업데이트 실패는 기존 에러 로그로 추적
          }
          console.error(`[publish-meta] ❌ 페북 처리 중 예외: ${msg}`);
          result.errors.push(`[facebook][${video.video_id}] ${msg}`);
          result.facebook_failed_count += 1;
        }
      }
    } else if (fbEnabled) {
      result.facebook_skipped_count += 1;
    }

    // 디버깅용 영상 요약 로그
    console.log(
      `[publish-meta] ✔︎ 영상 ${video.video_id} 처리 종료 (ig_need=${needIg}, fb_need=${needFb}, storage=${storagePath ?? "-"})`,
    );
  }

  // 전체 실패 여부 판단(발행 시도는 있었으나 전부 실패한 경우 ok=false)
  const totalTried =
    result.instagram_published_count +
    result.instagram_failed_count +
    result.facebook_published_count +
    result.facebook_failed_count;
  const totalSucceeded =
    result.instagram_published_count + result.facebook_published_count;

  result.ok = totalTried === 0 || totalSucceeded > 0;

  return result;
}
