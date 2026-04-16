import { GET as runContentGenerate } from "@/app/api/content/generate/route";

export interface GenerateResult {
  ok: boolean;
  processed_videos_count: number;
  total_contents_generated: number;
  errors: string[];
}

export async function runGenerateStep(): Promise<GenerateResult> {
  const response = await runContentGenerate();
  const data = (await response.json()) as {
    success?: boolean;
    processed_videos_count?: number;
    total_contents_generated?: number;
    errors?: string[];
  };

  return {
    ok: Boolean(data.success ?? true),
    processed_videos_count: data.processed_videos_count ?? 0,
    total_contents_generated: data.total_contents_generated ?? 0,
    errors: data.errors ?? [],
  };
}
