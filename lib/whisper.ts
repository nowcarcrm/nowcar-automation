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
  const apiKey = requireEnv("OPENAI_API_KEY");
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
  const form = new FormData();
  form.append("file", blob, filename);
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

  return { text };
}
