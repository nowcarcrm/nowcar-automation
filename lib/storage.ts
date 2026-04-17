import ytdl from "@distube/ytdl-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * ============================================================
 * lib/storage.ts
 * ------------------------------------------------------------
 * 유튜브 쇼츠 영상을 내려받아 Supabase Storage(temp-videos) 버킷에
 * 임시 저장하고, Meta(Instagram/Facebook) 업로드용 공개 URL을
 * 돌려주기 위한 유틸리티.
 *
 * 사용 버킷: temp-videos (Public)
 * 저장 수명: 약 24시간 (cleanup cron 에서 주기적으로 삭제)
 * ============================================================
 */

/** Supabase Storage 버킷 이름 (Step 1 SQL에서 만든 버킷) */
export const TEMP_VIDEOS_BUCKET = "temp-videos";

/** 업로드 결과 */
export interface UploadedVideo {
  /** Supabase Storage 내부 경로 (예: "abcd1234_1713345600000.mp4") */
  path: string;
  /** Meta 서버가 접근할 수 있는 공개 URL */
  publicUrl: string;
  /** 업로드된 파일 크기 (bytes) */
  sizeBytes: number;
}

/** 스토리지 내 파일 메타데이터 */
export interface StorageObject {
  name: string;
  createdAt: string | null;
  sizeBytes: number | null;
}

/* ------------------------------------------------------------
 * 환경변수 헬퍼
 * ---------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[storage] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

/**
 * Service Role 권한을 가진 Supabase 클라이언트를 생성한다.
 *
 * 일반 anon 키로는 Storage 업로드/삭제가 불가능하므로(RLS 정책상)
 * 서버 전용 Service Role 키를 사용해야 한다.
 * → 반드시 서버 코드(route handler, cron)에서만 호출할 것.
 *
 * 다른 서버 모듈(lib/meta.ts 의 DB 기록 등)에서도 재사용할 수 있도록 export.
 */
export function createAdminClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/* ------------------------------------------------------------
 * 재시도 헬퍼
 * ---------------------------------------------------------- */

/**
 * 네트워크 기반 작업(다운로드/업로드)은 일시적으로 실패할 수 있으므로
 * 최대 N회 재시도한다. (지수 백오프)
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[storage] ${label} 실패 (시도 ${attempt}/${attempts}): ${message}`,
      );

      if (attempt < attempts) {
        const delay = baseDelayMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const finalMessage =
    lastError instanceof Error ? lastError.message : "알 수 없는 오류";
  throw new Error(`[storage] ${label} 최종 실패(${attempts}회 시도): ${finalMessage}`);
}

/* ------------------------------------------------------------
 * 1) 유튜브 쇼츠 영상 다운로드
 * ---------------------------------------------------------- */

/**
 * videoId 로부터 유튜브 영상 파일(mp4)을 다운로드해 Buffer 로 반환한다.
 *
 * - Meta(Instagram Reels / Facebook) 업로드에 적합한 포맷(mp4, 비디오+오디오 포함)
 *   만 선택한다.
 * - Shorts 특성상 길이가 짧아 메모리 버퍼링(~30MB 이하)으로 충분하다.
 */
export async function downloadYouTubeVideo(videoId: string): Promise<Buffer> {
  return withRetry(`YouTube 다운로드(${videoId})`, async () => {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const info = await ytdl.getInfo(watchUrl);

    // 1순위: mp4 + 비디오+오디오 함께 있는 포맷(Meta 업로드에 가장 안전)
    // 2순위: mp4 비디오 only (오디오가 분리된 경우)
    const format =
      ytdl.chooseFormat(info.formats, {
        quality: "highest",
        filter: (f) => f.container === "mp4" && f.hasVideo && f.hasAudio,
      }) ??
      ytdl.chooseFormat(info.formats, {
        quality: "highest",
        filter: (f) => f.container === "mp4" && f.hasVideo,
      });

    if (!format) {
      throw new Error(
        `다운로드 가능한 mp4 포맷을 찾지 못했습니다(${videoId}).`,
      );
    }

    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = ytdl.downloadFromInfo(info, { format });

      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

      stream.on("error", (error: Error) => {
        reject(new Error(error.message));
      });
    });
  });
}

/* ------------------------------------------------------------
 * 2) Supabase Storage 업로드
 * ---------------------------------------------------------- */

/**
 * 영상 Buffer 를 temp-videos 버킷에 업로드하고 공개 URL 을 돌려준다.
 *
 * 파일명 규칙: `${videoId}_${timestamp}.mp4`
 * - videoId 가 같아도 타임스탬프 덕분에 충돌이 나지 않음
 * - 업로드 시점을 파일명에서 역추적할 수 있어 24h 만료 계산에도 유리
 */
export async function uploadVideoBuffer(
  videoId: string,
  buffer: Buffer,
): Promise<UploadedVideo> {
  const supabase = createAdminClient();
  const path = `${videoId}_${Date.now()}.mp4`;

  await withRetry(`Supabase 업로드(${path})`, async () => {
    const { error } = await supabase.storage
      .from(TEMP_VIDEOS_BUCKET)
      .upload(path, buffer, {
        contentType: "video/mp4",
        upsert: true,
        cacheControl: "3600",
      });

    if (error) {
      throw new Error(error.message);
    }
  });

  const { data } = supabase.storage
    .from(TEMP_VIDEOS_BUCKET)
    .getPublicUrl(path);

  if (!data?.publicUrl) {
    throw new Error(`[storage] 공개 URL 생성 실패(${path})`);
  }

  return {
    path,
    publicUrl: data.publicUrl,
    sizeBytes: buffer.byteLength,
  };
}

/* ------------------------------------------------------------
 * 3) "다운로드 → 업로드" 를 한 번에
 * ---------------------------------------------------------- */

/**
 * 유튜브 videoId 를 받아서:
 *   1) 영상 파일을 다운로드하고
 *   2) Supabase Storage(temp-videos) 에 업로드한 뒤
 *   3) Meta 업로드에 바로 쓸 수 있는 공개 URL 을 돌려준다.
 *
 * 파이프라인에서 호출하는 가장 상위 API.
 */
export async function downloadAndUploadShort(
  videoId: string,
): Promise<UploadedVideo> {
  console.log(`[storage] 🎬 유튜브 쇼츠 다운로드 시작: ${videoId}`);
  const buffer = await downloadYouTubeVideo(videoId);

  // 0 바이트 파일은 Meta 업로드 시 반드시 실패하므로 사전 차단
  if (buffer.byteLength === 0) {
    throw new Error(`[storage] 다운로드된 영상이 비어 있습니다(${videoId}).`);
  }

  const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`[storage] ✅ 다운로드 완료: ${sizeMb} MB`);

  const uploaded = await uploadVideoBuffer(videoId, buffer);
  console.log(`[storage] ☁️  Supabase 업로드 완료: ${uploaded.path}`);
  console.log(`[storage] 🌐 공개 URL: ${uploaded.publicUrl}`);

  return uploaded;
}

/* ------------------------------------------------------------
 * 4) 개별 파일 삭제
 * ---------------------------------------------------------- */

/**
 * temp-videos 버킷에서 특정 파일을 삭제한다.
 * - Meta 업로드 실패 시 롤백 용도
 * - 크론에서 24h 지난 파일을 지울 때 사용
 */
export async function deleteStorageObject(path: string): Promise<void> {
  const supabase = createAdminClient();

  const { error } = await supabase.storage
    .from(TEMP_VIDEOS_BUCKET)
    .remove([path]);

  if (error) {
    throw new Error(`[storage] 파일 삭제 실패(${path}): ${error.message}`);
  }
}

/* ------------------------------------------------------------
 * 5) 버킷 내 오래된 파일 일괄 삭제 (24h 이상)
 * ---------------------------------------------------------- */

/**
 * temp-videos 버킷에서 `olderThanHours` 시간 이상 지난 파일들을 찾는다.
 * 크론 라우트에서 호출되어 자동 정리 대상 목록을 돌려주는 용도.
 */
export async function listExpiredVideos(
  olderThanHours = 24,
): Promise<StorageObject[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.storage
    .from(TEMP_VIDEOS_BUCKET)
    .list("", {
      limit: 1000,
      sortBy: { column: "created_at", order: "asc" },
    });

  if (error) {
    throw new Error(`[storage] 파일 목록 조회 실패: ${error.message}`);
  }

  const thresholdMs = Date.now() - olderThanHours * 60 * 60 * 1000;

  return (data ?? [])
    .map((obj) => {
      const meta = obj as unknown as {
        name: string;
        created_at?: string | null;
        metadata?: { size?: number | null } | null;
      };
      return {
        name: meta.name,
        createdAt: meta.created_at ?? null,
        sizeBytes: meta.metadata?.size ?? null,
      } satisfies StorageObject;
    })
    .filter((obj) => {
      if (!obj.createdAt) return false;
      const createdAtMs = new Date(obj.createdAt).getTime();
      return Number.isFinite(createdAtMs) && createdAtMs < thresholdMs;
    });
}

/**
 * 24h 이상 지난 파일을 모두 삭제하고, 지워진 파일 이름 배열을 돌려준다.
 * 크론에서 호출되는 최상위 함수.
 */
export async function deleteExpiredVideos(
  olderThanHours = 24,
): Promise<{ deleted: string[]; failed: Array<{ name: string; reason: string }> }> {
  const expired = await listExpiredVideos(olderThanHours);

  if (expired.length === 0) {
    return { deleted: [], failed: [] };
  }

  const supabase = createAdminClient();
  const names = expired.map((obj) => obj.name);

  const { data, error } = await supabase.storage
    .from(TEMP_VIDEOS_BUCKET)
    .remove(names);

  if (error) {
    return {
      deleted: [],
      failed: names.map((name) => ({ name, reason: error.message })),
    };
  }

  const deletedSet = new Set((data ?? []).map((obj) => obj.name));
  const deleted = names.filter((name) => deletedSet.has(name));
  const failed = names
    .filter((name) => !deletedSet.has(name))
    .map((name) => ({ name, reason: "삭제 응답에 포함되지 않음" }));

  return { deleted, failed };
}
