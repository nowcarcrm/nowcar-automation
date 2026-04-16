import { GET as runYoutubeCheck } from "@/app/api/youtube/check/route";

export interface DetectResult {
  ok: boolean;
  new_videos_count: number;
  existing_videos_count: number;
  errors: string[];
}

export async function runDetectStep(): Promise<DetectResult> {
  const response = await runYoutubeCheck();
  const data = (await response.json()) as {
    success?: boolean;
    new_videos_count?: number;
    existing_videos_count?: number;
    errors?: string[];
  };

  return {
    ok: Boolean(data.success ?? true),
    new_videos_count: data.new_videos_count ?? 0,
    existing_videos_count: data.existing_videos_count ?? 0,
    errors: data.errors ?? [],
  };
}
