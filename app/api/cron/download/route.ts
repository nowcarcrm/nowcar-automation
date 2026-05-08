import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, downloadAndUploadShort } from "@/lib/storage";

/**
 * ============================================================
 * /api/cron/download
 * ------------------------------------------------------------
 * 매일 19:00 KST(= 10:00 UTC) Vercel Cron 이 자동 호출. 로컬 워커
 * (C:\nowcar-worker\worker.js)와 동일한 책임을 Vercel 서버에서 수행한다.
 * PC 가 꺼져 있어도 인스타/페북 자동 발행이 끊기지 않게 하기 위함.
 *
 * Hobby 플랜은 cron 이 1일 1회만 허용되므로 일 1회 스케줄.
 * 영상 등록 시각(보통 17:40 KST/08:40 UTC)을 지나친 19:00 KST 에 실행
 * → 같은 날 cleanup(03:00 KST/18:00 UTC) 이전에 IG/FB 발행 가능.
 *
 * 동작:
 *   1) CRON_SECRET 헤더 검증 (외부 오남용 차단)
 *   2) youtube_videos 에서 storage_path IS NULL & download_attempts<MAX
 *      대상 조회 (created_at 오름차순)
 *   3) 각 영상에 대해 ytdl-core 로 다운로드 → Supabase Storage 업로드
 *      → youtube_videos.storage_path / downloaded_at 갱신
 *   4) 실패 시 download_attempts++ 와 download_error 저장
 *
 * 시간 예산:
 *   - 영상 1개당 다운로드+업로드 평균 30~60s 가정 → BATCH_SIZE 2 로 제한
 *   - 백로그가 누적되면 ?secret= 쿼리로 수동 호출하거나 로컬 워커 가동
 * ============================================================
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_ATTEMPTS = 5;
/** 한 번에 처리할 최대 영상 수 (300s 타임아웃 안에 안전하게 끝나도록) */
const BATCH_SIZE = 2;

interface PendingVideo {
  id: string;
  video_id: string;
  title: string | null;
  download_attempts: number | null;
}

interface DownloadResponse {
  success: boolean;
  timestamp: string;
  duration_seconds: number;
  summary: string;
  processed_count: number;
  success_count: number;
  failed_count: number;
  successes: Array<{ video_id: string; storage_path: string }>;
  failures: Array<{ video_id: string; reason: string }>;
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function verifyAuth(req: NextRequest): { ok: boolean; reason?: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: "CRON_SECRET 환경변수 미설정" };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader === `Bearer ${secret}`) {
    return { ok: true };
  }

  const querySecret = req.nextUrl.searchParams.get("secret");
  if (querySecret && querySecret === secret) {
    return { ok: true };
  }

  return { ok: false, reason: "Authorization 헤더 또는 secret 쿼리 불일치" };
}

async function fetchPendingVideos(): Promise<PendingVideo[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, download_attempts")
    .is("storage_path", null)
    .lt("download_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw new Error(`youtube_videos 조회 실패: ${error.message}`);
  }

  return (data ?? []) as PendingVideo[];
}

async function markDownloaded(
  videoUuid: string,
  storagePath: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("youtube_videos")
    .update({
      storage_path: storagePath,
      downloaded_at: new Date().toISOString(),
      download_error: null,
    })
    .eq("id", videoUuid);

  if (error) {
    throw new Error(`storage_path 업데이트 실패: ${error.message}`);
  }
}

async function markFailed(
  videoUuid: string,
  errorMessage: string,
  prevAttempts: number | null,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("youtube_videos")
    .update({
      download_attempts: (prevAttempts ?? 0) + 1,
      download_error: errorMessage.slice(0, 500),
    })
    .eq("id", videoUuid);

  if (error) {
    console.warn(
      `[cron/download] 실패 기록 중 에러(진행은 계속): ${error.message}`,
    );
  }
}

async function handleDownload(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const successes: Array<{ video_id: string; storage_path: string }> = [];
  const failures: Array<{ video_id: string; reason: string }> = [];

  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📥 나우카 YouTube 다운로드 워커 시작 (Vercel cron)");
  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 1) 인증
  const auth = verifyAuth(req);
  if (!auth.ok) {
    console.warn(`[cron/download] ❌ 인증 실패: ${auth.reason}`);
    return NextResponse.json(
      { success: false, error: "Unauthorized", reason: auth.reason },
      { status: 401 },
    );
  }
  console.log("[cron/download] ✅ 인증 통과");

  // 2) 처리 대상 조회
  let pending: PendingVideo[] = [];
  try {
    pending = await fetchPendingVideos();
  } catch (error) {
    const msg = toErrorMessage(error);
    console.error(`[cron/download] ❌ 대상 조회 실패: ${msg}`);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }

  if (pending.length === 0) {
    const summary = "✨ 다운로드 대기 영상 없음 → 정상 종료";
    console.log(`[cron/download] ${summary}`);
    const responseBody: DownloadResponse = {
      success: true,
      timestamp: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
      summary,
      processed_count: 0,
      success_count: 0,
      failed_count: 0,
      successes: [],
      failures: [],
      errors: [],
    };
    return NextResponse.json(responseBody);
  }

  console.log(`[cron/download] 🎬 다운로드 대기 ${pending.length}건 처리`);

  // 3) 영상별 처리 — 한 건 실패해도 다음 건은 계속
  for (const video of pending) {
    const label = `${video.video_id}${video.title ? ` (${video.title.slice(0, 30)})` : ""}`;
    try {
      console.log(`[cron/download] ▶ 시작: ${label}`);
      const uploaded = await downloadAndUploadShort(video.video_id);
      await markDownloaded(video.id, uploaded.path);
      successes.push({
        video_id: video.video_id,
        storage_path: uploaded.path,
      });
      console.log(`[cron/download] ✅ 완료: ${label} → ${uploaded.path}`);
    } catch (error) {
      const msg = toErrorMessage(error);
      failures.push({ video_id: video.video_id, reason: msg });
      errors.push(`[${video.video_id}] ${msg}`);
      console.error(`[cron/download] ❌ 실패: ${label} - ${msg}`);
      await markFailed(video.id, msg, video.download_attempts);
    }
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const summary = `📥 다운로드 ${successes.length}/${pending.length} 성공 (실패 ${failures.length})`;

  console.log(`[cron/download] ${summary} (${durationSeconds}s)`);
  console.log("📥 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const responseBody: DownloadResponse = {
    success: true,
    timestamp: new Date().toISOString(),
    duration_seconds: durationSeconds,
    summary,
    processed_count: pending.length,
    success_count: successes.length,
    failed_count: failures.length,
    successes,
    failures,
    errors,
  };

  return NextResponse.json(responseBody);
}

export async function GET(req: NextRequest) {
  return handleDownload(req);
}

export async function POST(req: NextRequest) {
  return handleDownload(req);
}
