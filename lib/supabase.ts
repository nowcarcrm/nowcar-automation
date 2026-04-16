import { createClient } from "@supabase/supabase-js";

export type ChannelType =
  | "naver_blog"
  | "tistory"
  | "instagram"
  | "threads"
  | "naver_cafe";

export interface YouTubeVideo {
  id: string;
  video_id: string;
  title: string;
  description: string | null;
  transcript: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  published_at: string | null;
  processed: boolean;
  created_at: string;
}

export interface GeneratedContent {
  id: string;
  video_id: string;
  channel_type: ChannelType;
  title: string | null;
  body: string;
  hashtags: string | null;
  meta_description: string | null;
  status: "pending" | "approved" | "published" | "failed" | "cta_incomplete";
  email_sent: boolean;
  created_at: string;
}

type YouTubeVideoInsert = Omit<YouTubeVideo, "id" | "created_at"> & {
  processed?: boolean;
};

type GeneratedContentInsert = Omit<GeneratedContent, "id" | "created_at">;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[supabase] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supabaseAnonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

// 서버/스크립트 환경에서 재사용할 Supabase 클라이언트
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function getUnprocessedVideos(): Promise<YouTubeVideo[]> {
  const { data, error } = await supabase
    .from("youtube_videos")
    .select("*")
    .eq("processed", false)
    .order("published_at", { ascending: false });

  if (error) {
    throw new Error(`[supabase] 미처리 영상 조회 실패: ${error.message}`);
  }

  return (data ?? []) as YouTubeVideo[];
}

export async function saveVideo(video: YouTubeVideoInsert): Promise<YouTubeVideo> {
  const payload = {
    ...video,
    processed: video.processed ?? false,
  };

  const { data, error } = await supabase
    .from("youtube_videos")
    .upsert(payload, { onConflict: "video_id" })
    .select("*")
    .single();

  if (error) {
    throw new Error(`[supabase] 영상 저장 실패: ${error.message}`);
  }

  return data as YouTubeVideo;
}

export async function markVideoProcessed(videoId: string): Promise<void> {
  const { error } = await supabase
    .from("youtube_videos")
    .update({ processed: true })
    .eq("id", videoId);

  if (error) {
    throw new Error(`[supabase] 영상 처리 완료 업데이트 실패: ${error.message}`);
  }
}

export async function saveGeneratedContents(
  contents: GeneratedContentInsert[],
): Promise<GeneratedContent[]> {
  // 생성 직후 콘텐츠는 항상 미발송 상태로 시작하도록 강제
  const normalizedContents = contents.map((content) => ({
    ...content,
    email_sent: false,
  }));

  const { data, error } = await supabase
    .from("generated_contents")
    .insert(normalizedContents)
    .select("*");

  if (error) {
    throw new Error(`[supabase] 생성 콘텐츠 저장 실패: ${error.message}`);
  }

  return (data ?? []) as GeneratedContent[];
}

export async function getPendingContents(): Promise<GeneratedContent[]> {
  const { data, error } = await supabase
    .from("generated_contents")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`[supabase] 대기 콘텐츠 조회 실패: ${error.message}`);
  }

  return (data ?? []) as GeneratedContent[];
}

export async function markContentEmailSent(contentId: string): Promise<void> {
  const { error } = await supabase
    .from("generated_contents")
    .update({ email_sent: true })
    .eq("id", contentId);

  if (error) {
    throw new Error(`[supabase] 이메일 발송 상태 업데이트 실패: ${error.message}`);
  }
}
