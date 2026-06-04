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
  storage_path: string | null;
  published_at: string | null;
  processed: boolean;
  duration_seconds: number | null;
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

type YouTubeVideoInsert = Omit<
  YouTubeVideo,
  "id" | "created_at" | "storage_path" | "duration_seconds"
> & {
  processed?: boolean;
  storage_path?: string | null;
  duration_seconds?: number | null;
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

// 서버 전용 공유 Supabase 클라이언트.
// 이 모듈의 모든 헬퍼는 서버 라우트/크론에서만 호출된다(브라우저/클라이언트 컴포넌트 사용 0건).
// youtube_videos / generated_contents 에 RLS 를 적용해 public anon 키 접근을 차단하므로
// (2026-06-02 RLS 하드닝), 공개 anon 키가 아니라 service_role 키로 접근해야 한다.
// 빌드 시점에 service role 이 주입되지 않은 환경을 대비해 anon 으로 폴백하지만,
// 런타임(Vercel 서버)에는 SUPABASE_SERVICE_ROLE_KEY 가 항상 존재하므로 service role 로 동작한다.
const supabaseServerKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

export const supabase = createClient(supabaseUrl, supabaseServerKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

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

// H1: 채널 일부 실패로 processed 를 보류할 때 재시도 횟수를 기록한다.
// MAX_GENERATE_ATTEMPTS 도달 전까지 다음 사이클에 재생성되도록 하되, 영구
// 실패 영상이 무한 재생성되는 것을 막는 카운터.
export async function bumpVideoGenerationAttempts(
  videoId: string,
  attempts: number,
): Promise<void> {
  const { error } = await supabase
    .from("youtube_videos")
    .update({ generation_attempts: attempts })
    .eq("id", videoId);

  if (error) {
    throw new Error(
      `[supabase] generation_attempts 업데이트 실패: ${error.message}`,
    );
  }
}

export async function updateVideoTranscript(
  videoId: string,
  transcript: string,
): Promise<void> {
  const { error } = await supabase
    .from("youtube_videos")
    .update({ transcript })
    .eq("id", videoId);

  if (error) {
    throw new Error(`[supabase] transcript 업데이트 실패: ${error.message}`);
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

  // M-4: insert → upsert. (video_id, channel_type) 유니크 인덱스와 함께 멱등성 보장.
  // 같은 영상이 재처리(재시도/cron 재트리거)돼도 채널별 행이 중복 누적되지 않고
  // 기존 행을 갱신한다 → 중복 Tistory 이메일/비용 방지.
  const { data, error } = await supabase
    .from("generated_contents")
    .upsert(normalizedContents, { onConflict: "video_id,channel_type" })
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

export async function getPendingTistoryContents(): Promise<GeneratedContent[]> {
  const { data, error } = await supabase
    .from("generated_contents")
    .select("*")
    .eq("channel_type", "tistory")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`[supabase] 티스토리 대기 콘텐츠 조회 실패: ${error.message}`);
  }

  return (data ?? []) as GeneratedContent[];
}

export async function markContentPublished(contentId: string): Promise<void> {
  const { error } = await supabase
    .from("generated_contents")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", contentId);

  if (error) {
    throw new Error(`[supabase] 발행 완료 상태 업데이트 실패: ${error.message}`);
  }
}
