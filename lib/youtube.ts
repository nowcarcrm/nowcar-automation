import { google, youtube_v3 } from "googleapis";
import { YoutubeTranscript } from "youtube-transcript";

export interface LatestVideoItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  videoUrl: string;
}

export interface VideoDetails {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  videoUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[youtube] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

const apiKey = requireEnv("YOUTUBE_API_KEY");
const channelId = requireEnv("YOUTUBE_CHANNEL_ID");

const youtube = google.youtube({
  version: "v3",
  auth: apiKey,
});

function buildVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function getLatestVideos(maxResults = 10): Promise<LatestVideoItem[]> {
  try {
    const response = await youtube.search.list({
      part: ["snippet"],
      channelId,
      order: "date",
      type: ["video"],
      maxResults,
    });

    const items = response.data.items ?? [];

    return items
      .map((item) => {
        const videoId = item.id?.videoId;
        const snippet = item.snippet;
        if (!videoId || !snippet?.title) {
          return null;
        }

        return {
          videoId,
          title: snippet.title,
          description: snippet.description ?? "",
          // 요구사항에 맞춰 medium 썸네일을 우선 사용
          thumbnailUrl:
            snippet.thumbnails?.medium?.url ??
            snippet.thumbnails?.high?.url ??
            snippet.thumbnails?.default?.url ??
            null,
          publishedAt: snippet.publishedAt ?? null,
          videoUrl: buildVideoUrl(videoId),
        } satisfies LatestVideoItem;
      })
      .filter((item): item is LatestVideoItem => item !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[youtube] 최신 영상 조회 실패: ${message}`);
  }
}

export async function getVideoDetails(videoId: string): Promise<VideoDetails | null> {
  try {
    const response = await youtube.videos.list({
      part: ["snippet"],
      id: [videoId],
      maxResults: 1,
    });

    const video = response.data.items?.[0];
    const snippet = video?.snippet as youtube_v3.Schema$VideoSnippet | undefined;

    if (!video || !snippet?.title) {
      return null;
    }

    return {
      videoId,
      title: snippet.title,
      description: snippet.description ?? "",
      thumbnailUrl:
        snippet.thumbnails?.medium?.url ??
        snippet.thumbnails?.high?.url ??
        snippet.thumbnails?.default?.url ??
        null,
      publishedAt: snippet.publishedAt ?? null,
      videoUrl: buildVideoUrl(videoId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[youtube] 영상 상세 조회 실패(${videoId}): ${message}`);
  }
}

export async function getVideoTranscript(videoId: string): Promise<string | null> {
  try {
    // 자막이 있으면 텍스트를 이어붙여 반환
    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    const transcript = transcriptItems.map((item) => item.text).join(" ").trim();
    return transcript.length > 0 ? transcript : null;
  } catch {
    // 자막이 없거나 차단된 경우 null 반환 후 상위 로직에서 title/description fallback 사용
    return null;
  }
}
