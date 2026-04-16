import { NextResponse } from "next/server";
import { getLatestVideos, getVideoTranscript } from "@/lib/youtube";
import { saveVideo, supabase } from "@/lib/supabase";

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

export async function GET() {
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
    const newCandidates = latestVideos.filter(
      (video) => !existingVideoIdSet.has(video.videoId),
    );
    const existingCount = totalChecked - newCandidates.length;

    console.log(
      `[youtube/check] 신규 영상 ${newCandidates.length}개 발견, 기존 영상 ${existingCount}개`,
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
