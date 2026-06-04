import { NextRequest, NextResponse } from "next/server";
import { getLatestVideos, getVideoTranscript } from "@/lib/youtube";
import { saveVideo, supabase } from "@/lib/supabase";
import { getMaxVideoAgeDays, isWithinRecency } from "@/lib/video-recency";
import { isPipelineRequestAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface NewVideoResult {
  video_id: string;
  title: string;
  published_at: string | null;
  has_transcript: boolean;
  transcript_length: number;
}

interface CheckResponse {
  success: boolean;
  timestamp: string;
  total_checked: number;
  new_videos_count: number;
  existing_videos_count: number;
  new_videos: NewVideoResult[];
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류";
}

export async function GET(request?: NextRequest) {
  // M16: 무인증이면 익명이 YouTube API 쿼터를 소모하고 youtube_videos 에 write 를
  // 유발할 수 있다. 내부 호출(detect 의 runYoutubeCheck())은 request 미전달로 면제.
  if (!isPipelineRequestAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const errors: string[] = [];
  const newVideos: NewVideoResult[] = [];

  try {
    console.log("[youtube/check] 최신 영상 10개 조회 시작");
    const latestVideos = await getLatestVideos(10);
    const totalChecked = latestVideos.length;

    if (totalChecked === 0) {
      console.log("[youtube/check] 조회된 영상이 없습니다.");
      const emptyResponse: CheckResponse = {
        success: true,
        timestamp: new Date().toISOString(),
        total_checked: 0,
        new_videos_count: 0,
        existing_videos_count: 0,
        new_videos: [],
        errors: [],
      };
      return NextResponse.json(emptyResponse);
    }

    const videoIds = latestVideos.map((video) => video.videoId);
    const { data: existingRows, error: existingError } = await supabase
      .from("youtube_videos")
      .select("video_id")
      .in("video_id", videoIds);

    if (existingError) {
      throw new Error(`기존 영상 대조 실패: ${existingError.message}`);
    }

    const existingVideoIdSet = new Set((existingRows ?? []).map((row) => row.video_id));
    const unseenCandidates = latestVideos.filter(
      (video) => !existingVideoIdSet.has(video.videoId),
    );

    // recency 게이트: published_at 이 윈도우(기본 14일)보다 오래된 영상은
    // 신규로 잡혔더라도 저장하지 않는다. YouTube search.list 가 옛날 영상을
    // 결과에 다시 끼워 넣어 1년 전 영상이 SNS 에 재발행되던 사고(2026-06-01)
    // 의 근본 차단. 자세한 배경은 lib/video-recency.ts 참고.
    const maxAgeDays = getMaxVideoAgeDays();
    const staleCandidates = unseenCandidates.filter(
      (video) => !isWithinRecency(video.publishedAt),
    );
    const newCandidates = unseenCandidates.filter((video) =>
      isWithinRecency(video.publishedAt),
    );
    const existingCount = totalChecked - unseenCandidates.length;

    if (staleCandidates.length > 0) {
      console.log(
        `[youtube/check] ⏭ 오래된 영상 ${staleCandidates.length}개 제외(>${maxAgeDays}일): ` +
          staleCandidates
            .map((v) => `${v.videoId}(${v.publishedAt ?? "?"})`)
            .join(", "),
      );
    }

    console.log(
      `[youtube/check] 신규 영상 ${newCandidates.length}개 발견, 기존 영상 ${existingCount}개, 오래됨 ${staleCandidates.length}개 제외`,
    );

    for (const video of newCandidates) {
      try {
        console.log(`[youtube/check] 자막 추출 중: ${video.title}`);
        const transcript = await getVideoTranscript(video.videoId);
        const hasTranscript = transcript !== null;
        const transcriptText =
          transcript && transcript.trim().length > 0 ? transcript : video.description;

        // 쇼츠에서 자막이 없을 때를 대비해 description을 fallback으로 저장
        await saveVideo({
          video_id: video.videoId,
          title: video.title,
          description: video.description,
          transcript: transcriptText,
          thumbnail_url: video.thumbnailUrl,
          video_url: video.videoUrl,
          published_at: video.publishedAt,
          processed: false,
          duration_seconds: video.durationSeconds,
        });

        newVideos.push({
          video_id: video.videoId,
          title: video.title,
          published_at: video.publishedAt,
          has_transcript: hasTranscript,
          transcript_length: transcriptText?.length ?? 0,
        });

        if (hasTranscript) {
          console.log(`[youtube/check] 저장 완료(자막 사용): ${video.title}`);
        } else {
          console.log(`[youtube/check] 저장 완료(description fallback): ${video.title}`);
        }
      } catch (error) {
        const message = `[video_id=${video.videoId}] 영상 처리 실패: ${toErrorMessage(error)}`;
        errors.push(message);
        console.error(`[youtube/check] ${message}`);
      }
    }

    const responseBody: CheckResponse = {
      success: errors.length === 0,
      timestamp: new Date().toISOString(),
      total_checked: totalChecked,
      new_videos_count: newCandidates.length,
      existing_videos_count: existingCount,
      new_videos: newVideos,
      errors,
    };

    return NextResponse.json(responseBody);
  } catch (error) {
    const message = `전체 처리 실패: ${toErrorMessage(error)}`;
    errors.push(message);
    console.error(`[youtube/check] ${message}`);

    const failedResponse: CheckResponse = {
      success: false,
      timestamp: new Date().toISOString(),
      total_checked: 0,
      new_videos_count: 0,
      existing_videos_count: 0,
      new_videos: [],
      errors,
    };

    return NextResponse.json(failedResponse, { status: 500 });
  }
}
