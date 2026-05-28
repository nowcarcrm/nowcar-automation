import { Readable } from "node:stream";
import { google, drive_v3 } from "googleapis";

/**
 * ============================================================
 * lib/gdrive.ts
 * ------------------------------------------------------------
 * Google Drive 우회 다운로드.
 *
 * YouTube ytdl 다운로드는 데이터센터 IP 차단 + 쿠키 회전 때문에
 * 구조적으로 깨지기 쉽다. 운영자가 YouTube 업로드 시 원본 mp4 사본을
 * Drive 폴더(GDRIVE_SOURCE_FOLDER_ID)에 같이 올려두면 이 모듈이
 * 파일을 찾아 다운로드하고 처리 완료 후 영구 삭제한다.
 *
 * 파일 매칭 규칙: 파일명이 `${videoId}.{mp4|mov|webm|m4v}` 또는
 *   `${videoId}.${anyExt}` 형태. videoId 가 정확히 들어 있으면 매칭.
 *
 * 필수 env:
 *   - GOOGLE_SERVICE_ACCOUNT_JSON: 서비스 계정 JSON 키 통째로
 *   - GDRIVE_SOURCE_FOLDER_ID    : Drive 폴더 ID (URL 끝)
 *
 * 두 env 가 모두 없으면 Drive 우회는 비활성. 호출자(storage.ts)가
 * findVideoFile 의 null 반환을 받아 ytdl 폴백으로 떨어진다.
 * ============================================================
 */

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

export interface DriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
}

let cachedDrive: drive_v3.Drive | null | undefined;

function getDriveClient(): drive_v3.Drive | null {
  if (cachedDrive !== undefined) return cachedDrive;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const folderId = process.env.GDRIVE_SOURCE_FOLDER_ID?.trim();
  if (!raw || !folderId) {
    cachedDrive = null;
    return null;
  }

  try {
    const credentials = JSON.parse(raw);
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: DRIVE_SCOPES,
    });
    cachedDrive = google.drive({ version: "v3", auth });
    console.log(
      `[gdrive] ✅ Drive 클라이언트 활성화 (folder=${folderId.slice(0, 12)}…, account=${credentials.client_email})`,
    );
    return cachedDrive;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[gdrive] ⚠️ GOOGLE_SERVICE_ACCOUNT_JSON 파싱 실패(Drive 우회 비활성, ytdl 폴백): ${msg}`,
    );
    cachedDrive = null;
    return null;
  }
}

export function isGoogleDriveEnabled(): boolean {
  return getDriveClient() !== null;
}

/**
 * videoId 로 시작하는 파일을 폴더에서 찾는다.
 * - 파일명이 `${videoId}.mp4` `${videoId}.mov` 등 어떤 확장자든 매칭
 * - 여러 개면 가장 최근 modifiedTime
 * - 못 찾으면 null
 */
export async function findVideoFile(
  videoId: string,
): Promise<DriveVideoFile | null> {
  const drive = getDriveClient();
  if (!drive) return null;

  const folderId = process.env.GDRIVE_SOURCE_FOLDER_ID!.trim();

  // videoId 가 파일명에 정확히 들어있고, 휴지통 제외, 폴더 소속
  // contains 매칭은 false positive 가능성이 있어 prefix(name starts with) 도 시도
  // → 우선 startsWith videoId. 매칭 없으면 contains 로 한 번 더.
  const escaped = videoId.replace(/['\\]/g, (m) => `\\${m}`);
  const baseQuery = `'${folderId}' in parents and trashed = false`;

  const tryFetch = async (extraQuery: string) => {
    const res = await drive.files.list({
      q: `${baseQuery} and ${extraQuery}`,
      fields: "files(id,name,mimeType,size,modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 10,
      spaces: "drive",
    });
    return res.data.files ?? [];
  };

  let files = await tryFetch(`name contains '${escaped}'`);
  if (files.length === 0) {
    return null;
  }

  // 정확 매칭 우선: 파일명에서 확장자 떼고 videoId 와 같으면 1순위
  const exact = files.find((f) => {
    const name = f.name ?? "";
    const stem = name.replace(/\.[^./]+$/, "");
    return stem === videoId;
  });

  const picked = exact ?? files[0]!;
  return {
    id: picked.id!,
    name: picked.name ?? videoId,
    mimeType: picked.mimeType ?? "application/octet-stream",
    sizeBytes:
      picked.size != null ? Number(picked.size) : null,
  };
}

/** Drive 파일을 메모리 Buffer 로 다운로드 */
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const drive = getDriveClient();
  if (!drive) {
    throw new Error("[gdrive] Drive 클라이언트 비활성");
  }

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );

  const stream = res.data as Readable;
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err: Error) =>
      reject(new Error(`[gdrive] 다운로드 실패: ${err.message}`)),
    );
  });
}

/**
 * Drive 파일을 영구 삭제. (휴지통 거치지 않음 — files.delete)
 * 멱등 호출 안전: 이미 없으면 404 를 무시하고 조용히 끝낸다.
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) return;

  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
    console.log(`[gdrive] 🗑️  파일 영구 삭제 완료: ${fileId}`);
  } catch (error) {
    const status = (error as { code?: number }).code;
    if (status === 404) {
      console.log(`[gdrive] ℹ️ 이미 삭제됨(404 무시): ${fileId}`);
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`[gdrive] 파일 삭제 실패(${fileId}): ${msg}`);
  }
}
