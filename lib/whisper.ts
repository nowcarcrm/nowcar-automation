import { createAdminClient, TEMP_VIDEOS_BUCKET } from "./storage";

const WHISPER_MODEL = "whisper-1";
const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[whisper] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

export interface WhisperTranscribeResult {
  text: string;
}

async function callWhisperApi(file: Blob, filename: string): Promise<string> {
  const apiKey = requireEnv("OPENAI_API_KEY");

  const form = new FormData();
  form.append("file", file, filename);
  form.append("model", WHISPER_MODEL);
  form.append("language", "ko");
  form.append("response_format", "json");

  const response = await fetch(WHISPER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[whisper] OpenAI API 오류(${response.status}): ${errorText.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as { text?: string };
  const text = (json.text ?? "").trim();

  if (text.length === 0) {
    throw new Error("[whisper] STT 결과가 비어 있음");
  }

  return text;
}

/**
 * 메모리 Buffer 를 Whisper 에 직접 전달.
 * 다운로드 워커가 mp4 를 supabase storage 에 업로드하기 전에 generate 가
 * 먼저 실행되는 race 가 빈번해서 ytdl-core 로 곧장 다운로드한 Buffer 를
 * 이 함수로 넣을 수 있도록 분리.
 */
export async function transcribeFromBuffer(
  buffer: Buffer,
  filename = "video.mp4",
): Promise<WhisperTranscribeResult> {
  const blob = new Blob([buffer], { type: "video/mp4" });
  const text = await callWhisperApi(blob, filename);
  return { text };
}

/**
 * Supabase Storage(temp-videos) 에 저장된 mp4 를 OpenAI Whisper 로
 * 한국어 STT. Whisper API 가 mp4 컨테이너에서 오디오 트랙을 자동 추출한다.
 *
 * 제약:
 *   - 단일 파일 25MB 이하 (Whisper API 제한)
 *   - 영상당 한 번만 호출되도록 호출 측에서 transcript 길이 가드 필수
 */
export async function transcribeFromStoragePath(
  storagePath: string,
): Promise<WhisperTranscribeResult> {
  const supabase = createAdminClient();

  const { data: blob, error: dlError } = await supabase.storage
    .from(TEMP_VIDEOS_BUCKET)
    .download(storagePath);

  if (dlError || !blob) {
    throw new Error(
      `[whisper] storage 다운로드 실패(${storagePath}): ${dlError?.message ?? "blob 없음"}`,
    );
  }

  const filename = storagePath.split("/").pop() ?? "video.mp4";
  const text = await callWhisperApi(blob, filename);
  return { text };
}
