import { createAdminClient, downloadAndUploadShort } from "@/lib/storage";
import {
  buildInstagramCaption,
  isFacebookAutoPublishEnabled,
  isInstagramAutoPublishEnabled,
  publishFacebookPagePost,
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
 *        - 페북에 아직 성공 기록이 없으면   → 페이지 텍스트 게시
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
};

type ContentRow = {
  channel_type: string;
  body: string;
  hashtags: string | null;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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

  if (!igEnabled && !fbEnabled) {
    console.log(
      "[publish-meta] ⏭  AUTO_PUBLISH_INSTAGRAM/FACEBOOK 둘 다 비활성 → 전체 스킵",
    );
    return result;
  }

  const supabase = createAdminClient();

  // 1) 대상 영상 조회
  const { data: videos, error: videosError } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, video_url")
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

  // 2) 이미 성공한 (video_id, platform) 조합 조회 → 중복 발행 방지
  const videoIds = videos.map((v) => v.video_id);
  const { data: publishedRows, error: publishedError } = await supabase
    .from("social_publishes")
    .select("video_id, platform, status")
    .in("video_id", videoIds)
    .eq("status", "success");

  if (publishedError) {
    console.warn(
      `[publish-meta] social_publishes 조회 실패(진행은 계속): ${publishedError.message}`,
    );
  }

  const successKey = (videoId: string, platform: string) =>
    `${videoId}::${platform}`;
  const alreadySuccess = new Set<string>(
    (publishedRows ?? []).map((r) => successKey(r.video_id, r.platform)),
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
          // 1) 유튜브 → Supabase Storage 업로드
          const uploaded = await downloadAndUploadShort(video.video_id);
          storagePath = uploaded.path;

          // 2) 캡션 조립
          const caption = buildInstagramCaption(
            igContent.body,
            igContent.hashtags,
          );

          // 3) 실제 발행
          const publishResult = await publishInstagramReel({
            videoId: video.video_id,
            videoUrl: uploaded.publicUrl,
            caption,
            storagePath: uploaded.path,
          });

          if (publishResult.success) {
            result.instagram_published_count += 1;
          } else {
            result.instagram_failed_count += 1;
            if (publishResult.errorMessage) {
              result.errors.push(
                `[instagram][${video.video_id}] ${publishResult.errorMessage}`,
              );
            }
          }
        } catch (error) {
          const msg = toErrorMessage(error);
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
    // (B) 페이스북 페이지 텍스트 게시
    //    → 영상 파일 불필요, 텍스트만 올림
    //    → 우선순위: naver_blog 본문 > instagram 본문
    // ────────────────────────────────────
    if (needFb) {
      const fbMessageSource = blogContent?.body ?? igContent?.body ?? null;

      if (!fbMessageSource) {
        const msg = `페북 스킵(${video.video_id}): 사용 가능한 콘텐츠가 없음`;
        console.warn(`[publish-meta] ⚠️  ${msg}`);
        result.errors.push(msg);
        result.facebook_skipped_count += 1;
      } else {
        // 원본 영상 링크를 하단에 덧붙여 트래픽 유도
        const youtubeLink = video.video_url
          ? `\n\n🎬 원본 영상: ${video.video_url}`
          : "";
        const fbMessage = `${fbMessageSource.trim()}${youtubeLink}`;

        try {
          const publishResult = await publishFacebookPagePost({
            videoId: video.video_id,
            message: fbMessage,
          });

          if (publishResult.success) {
            result.facebook_published_count += 1;
          } else {
            result.facebook_failed_count += 1;
            if (publishResult.errorMessage) {
              result.errors.push(
                `[facebook][${video.video_id}] ${publishResult.errorMessage}`,
              );
            }
          }
        } catch (error) {
          const msg = toErrorMessage(error);
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
