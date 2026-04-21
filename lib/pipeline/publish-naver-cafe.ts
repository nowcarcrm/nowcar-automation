import {
  NaverApiError,
  NaverTokenError,
  isNaverCafeAutoPublishEnabled,
  publishNaverCafeArticle,
} from "@/lib/naver";
import { createAdminClient } from "@/lib/storage";

export interface PublishNaverCafeResult {
  ok: boolean;
  processed_videos_count: number;
  naver_cafe_published_count: number;
  naver_cafe_failed_count: number;
  naver_cafe_skipped_count: number;
  errors: string[];
}

const MAX_VIDEOS_PER_RUN = 3;

type VideoRow = {
  id: string;
  video_id: string;
  title: string;
  video_url: string | null;
};

type ContentRow = {
  title: string | null;
  body: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildCafeSubject(contentTitle: string | null, videoTitle: string): string {
  const base = contentTitle?.trim() ? contentTitle.trim() : videoTitle.trim();
  return base.length > 100 ? base.slice(0, 100).trimEnd() : base;
}

function buildCafeBody(contentBody: string, videoUrl: string | null): string {
  const hashtags =
    "#신차장기렌트 #장기렌트 #리스 #신차리스 #법인리스 #개인리스 #즉시출고 #신차프로모션 #신차할인 #장기렌트견적 #리스견적 #국산차장기렌트 #수입차리스 #나우카";

  const withVideoLink = videoUrl
    ? `${contentBody.trim()}\n\n🎬 영상 보기: ${videoUrl}`
    : contentBody.trim();

  const withHashtags = `${withVideoLink}\n\n🔖 태그\n${hashtags}`;

  return withHashtags.length > 10000
    ? withHashtags.slice(0, 10000).trimEnd()
    : withHashtags;
}

async function recordNaverCafePublish(input: {
  videoId: string;
  status: "success" | "failed";
  externalId: string | null;
  captionPreview: string | null;
  errorMessage: string | null;
}): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("social_publishes").insert({
      video_id: input.videoId,
      platform: "naver_cafe",
      status: input.status,
      external_id: input.externalId,
      storage_path: null,
      caption_preview: input.captionPreview,
      error_message: input.errorMessage,
    });

    if (error) {
      console.error(
        `[publish-naver-cafe] social_publishes 기록 실패: ${error.message}`,
      );
    }
  } catch (error) {
    console.error(
      `[publish-naver-cafe] social_publishes 기록 중 예외: ${toErrorMessage(error)}`,
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

  const supabase = createAdminClient();

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
    console.log("[publish-naver-cafe] 처리 대상 영상이 없어 스킵");
    return result;
  }

  result.processed_videos_count = videos.length;

  const videoIds = videos.map((v) => v.video_id);
  const { data: publishedRows, error: publishedError } = await supabase
    .from("social_publishes")
    .select("video_id, platform, status")
    .in("video_id", videoIds)
    .eq("platform", "naver_cafe")
    .eq("status", "success");

  if (publishedError) {
    console.warn(
      `[publish-naver-cafe] social_publishes 조회 실패(진행은 계속): ${publishedError.message}`,
    );
  }

  const alreadySuccess = new Set((publishedRows ?? []).map((row) => row.video_id));

  for (const video of videos as VideoRow[]) {
    if (alreadySuccess.has(video.video_id)) {
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
    const contentText = buildCafeBody(content.body, video.video_url);

    try {
      const publishResult = await publishNaverCafeArticle({
        subject,
        contentText,
      });

      if (publishResult.success) {
        result.naver_cafe_published_count += 1;
        await recordNaverCafePublish({
          videoId: video.video_id,
          status: "success",
          externalId: publishResult.externalId ?? null,
          captionPreview: contentText.slice(0, 200),
          errorMessage: null,
        });
      } else {
        result.naver_cafe_failed_count += 1;
        const msg = publishResult.errorMessage ?? "알 수 없는 발행 실패";
        result.errors.push(`[naver_cafe][${video.video_id}] ${msg}`);
        await recordNaverCafePublish({
          videoId: video.video_id,
          status: "failed",
          externalId: null,
          captionPreview: contentText.slice(0, 200),
          errorMessage: msg,
        });
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

      await recordNaverCafePublish({
        videoId: video.video_id,
        status: "failed",
        externalId: null,
        captionPreview: contentText.slice(0, 200),
        errorMessage: msg,
      });
    }
  }

  const totalTried =
    result.naver_cafe_published_count + result.naver_cafe_failed_count;
  result.ok = totalTried === 0 || result.naver_cafe_published_count > 0;

  return result;
}
