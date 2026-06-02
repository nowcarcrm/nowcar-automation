import { google, youtube_v3 } from "googleapis";
import { YoutubeTranscript } from "youtube-transcript";

export interface LatestVideoItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  videoUrl: string;
  durationSeconds: number | null;
}

export interface VideoDetails {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  videoUrl: string;
  durationSeconds: number | null;
}

// ISO 8601 duration(PT#H#M#S) → 초. 파싱 실패 시 null.
export function parseIsoDurationToSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  const total = hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total)) return null;
  return Math.round(total);
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

    const baseList = items
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
          durationSeconds: null as number | null,
        } satisfies LatestVideoItem;
      })
      .filter((item): item is LatestVideoItem => item !== null);

    // search.list 는 contentDetails 를 지원하지 않으므로
    // videos.list 로 duration 을 한 번 더 보강한다(요청 1회 추가).
    const durationMap = await fetchDurationsSeconds(
      baseList.map((v) => v.videoId),
    );
    for (const v of baseList) {
      v.durationSeconds = durationMap.get(v.videoId) ?? null;
    }
    return baseList;
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[youtube] 최신 영상 조회 실패: ${message}`);
  }
}

/**
 * 채널 업로드 재생목록 ID. YouTube 규약상 채널 ID(UCxxxx)의 접두사 UC 를 UU 로
 * 바꾸면 그 채널의 "업로드" 재생목록 ID 가 된다. 이 재생목록을 playlistItems.list
 * (1 유닛)로 조회하면 search.list(100 유닛)와 동일하게 최신 업로드를 최신순으로
 * 얻을 수 있어 쿼터 비용이 100배 저렴하다.
 */
function uploadsPlaylistId(): string | null {
  if (channelId.startsWith("UC") && channelId.length > 2) {
    return `UU${channelId.slice(2)}`;
  }
  return null;
}

/**
 * search.list(100 유닛) 대신 playlistItems.list(1 유닛)로 최신 업로드를 조회한다.
 * publishedAt 은 재생목록 추가 시각이 아닌 실제 영상 게시 시각
 * (contentDetails.videoPublishedAt)을 사용해 recency 게이트와 정합성을 맞춘다.
 */
export async function getLatestVideosViaPlaylist(
  maxResults = 10,
): Promise<LatestVideoItem[]> {
  const playlistId = uploadsPlaylistId();
  if (!playlistId) {
    throw new Error(
      `[youtube] 업로드 재생목록 ID 도출 실패(channelId=${channelId}, UC 접두사 아님)`,
    );
  }

  try {
    const response = await youtube.playlistItems.list({
      part: ["snippet", "contentDetails"],
      playlistId,
      maxResults,
    });

    const items = response.data.items ?? [];

    const baseList = items
      .map((item) => {
        const videoId =
          item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        const snippet = item.snippet;
        if (!videoId || !snippet?.title) {
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
          // 실제 게시 시각 우선(재생목록 추가 시각 fallback).
          publishedAt:
            item.contentDetails?.videoPublishedAt ??
            snippet.publishedAt ??
            null,
          videoUrl: buildVideoUrl(videoId),
          durationSeconds: null as number | null,
        } satisfies LatestVideoItem;
      })
      .filter((item): item is LatestVideoItem => item !== null);

    const durationMap = await fetchDurationsSeconds(
      baseList.map((v) => v.videoId),
    );
    for (const v of baseList) {
      v.durationSeconds = durationMap.get(v.videoId) ?? null;
    }
    return baseList;
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[youtube] 최신 영상 조회 실패(playlist): ${message}`);
  }
}

/**
 * videos.list(part=contentDetails) 로 여러 영상의 duration(초) 을 일괄 조회한다.
 * 실패한 경우 해당 ID 는 Map 에서 제외(상위에서 null 처리).
 */
async function fetchDurationsSeconds(
  videoIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (videoIds.length === 0) return result;

  try {
    const response = await youtube.videos.list({
      part: ["contentDetails"],
      id: videoIds,
      maxResults: videoIds.length,
    });
    for (const item of response.data.items ?? []) {
      const id = item.id;
      const iso = item.contentDetails?.duration ?? null;
      const seconds = parseIsoDurationToSeconds(iso);
      if (id && seconds !== null) {
        result.set(id, seconds);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.warn(`[youtube] duration 일괄 조회 실패(진행은 계속): ${message}`);
  }
  return result;
}

export async function getVideoDetails(videoId: string): Promise<VideoDetails | null> {
  try {
    const response = await youtube.videos.list({
      part: ["snippet", "contentDetails"],
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
      durationSeconds: parseIsoDurationToSeconds(
        video.contentDetails?.duration ?? null,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[youtube] 영상 상세 조회 실패(${videoId}): ${message}`);
  }
}

/**
 * videoId 한 개의 duration(초) 만 조회 (publish 단계 lazy backfill 용).
 * 조회 실패 또는 파싱 실패 시 null 반환.
 */
export async function getVideoDurationSeconds(
  videoId: string,
): Promise<number | null> {
  try {
    const response = await youtube.videos.list({
      part: ["contentDetails"],
      id: [videoId],
      maxResults: 1,
    });
    const iso = response.data.items?.[0]?.contentDetails?.duration ?? null;
    return parseIsoDurationToSeconds(iso);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.warn(
      `[youtube] duration 단건 조회 실패(${videoId}, 진행은 계속): ${message}`,
    );
    return null;
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
