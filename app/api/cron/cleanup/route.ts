import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, deleteExpiredVideos } from "@/lib/storage";

/**
 * ============================================================
 * /api/cron/cleanup
 * ------------------------------------------------------------
 * 매일 새벽 3시(KST) = UTC 18:00 에 Vercel Cron 이 자동 호출.
 *
 * 동작:
 *   1) CRON_SECRET 헤더 검증 (외부 오남용 차단)
 *   2) Supabase Storage(temp-videos) 에서 24h 이상 경과한 mp4 파일 일괄 삭제
 *   3) social_publishes.deleted_at 을 지금 시각으로 업데이트
 *   4) 요약 결과 JSON 반환
 *
 * 실패 원칙:
 *   - 파일 1개 삭제 실패해도 나머지 계속
 *   - DB 업데이트 실패해도 전체 중단하지 않음
 * ============================================================
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Storage 파일이 많아질 수 있으므로 여유 있는 타임아웃
export const maxDuration = 60;

/** 24h 지난 파일만 삭제 */
const EXPIRY_HOURS = 24;

interface CleanupResponse {
  success: boolean;
  timestamp: string;
  duration_seconds: number;
  summary: string;
  storage: {
    listed_expired_count: number;
    deleted_count: number;
    failed_count: number;
    deleted_files: string[];
    failures: Array<{ name: string; reason: string }>;
  };
  database: {
    updated_count: number;
    failed_count: number;
  };
  errors: string[];
}

/** Vercel Cron 또는 수동 호출 인증 검증 */
function verifyAuth(req: NextRequest): {
  ok: boolean;
  reason?: string;
} {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, reason: "CRON_SECRET 환경변수 미설정" };
  }

  // Vercel Cron 은 Authorization: Bearer <CRON_SECRET> 을 자동 첨부한다.
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader === `Bearer ${secret}`) {
    return { ok: true };
  }

  // 수동 테스트용 - ?secret=... 쿼리로도 허용 (대표님 편의)
  const querySecret = req.nextUrl.searchParams.get("secret");
  if (querySecret && querySecret === secret) {
    return { ok: true };
  }

  return { ok: false, reason: "Authorization 헤더 또는 secret 쿼리 불일치" };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handleCleanup(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const errors: string[] = [];

  console.log("🧹 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🧹 나우카 Storage 자동 정리 시작");
  console.log("🧹 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // 1) 인증 검증
  const auth = verifyAuth(req);
  if (!auth.ok) {
    console.warn(`[cron/cleanup] ❌ 인증 실패: ${auth.reason}`);
    return NextResponse.json(
      {
        success: false,
        error: "Unauthorized",
        reason: auth.reason,
      },
      { status: 401 },
    );
  }
  console.log("[cron/cleanup] ✅ 인증 통과");

  // 2) 24h 지난 파일 일괄 삭제
  let deleteResult: {
    deleted: string[];
    failed: Array<{ name: string; reason: string }>;
  } = { deleted: [], failed: [] };

  try {
    console.log(`[cron/cleanup] 🔍 ${EXPIRY_HOURS}h 이상 경과 파일 검색/삭제...`);
    deleteResult = await deleteExpiredVideos(EXPIRY_HOURS);
    console.log(
      `[cron/cleanup] 🗑️  삭제 완료 - 성공 ${deleteResult.deleted.length}개, 실패 ${deleteResult.failed.length}개`,
    );
  } catch (error) {
    const msg = toErrorMessage(error);
    errors.push(`[storage_delete] ${msg}`);
    console.error(`[cron/cleanup] ❌ Storage 삭제 전체 실패: ${msg}`);
  }

  // 3) social_publishes.deleted_at 업데이트 (개별 실패해도 계속)
  const dbUpdates = { success: 0, failed: 0 };
  if (deleteResult.deleted.length > 0) {
    const supabase = createAdminClient();
    const nowIso = new Date().toISOString();

    for (const storagePath of deleteResult.deleted) {
      try {
        const { error } = await supabase
          .from("social_publishes")
          .update({ deleted_at: nowIso })
          .eq("storage_path", storagePath)
          .is("deleted_at", null);

        if (error) {
          throw new Error(error.message);
        }
        dbUpdates.success += 1;
      } catch (error) {
        dbUpdates.failed += 1;
        const msg = toErrorMessage(error);
        errors.push(`[db_update][${storagePath}] ${msg}`);
        console.error(
          `[cron/cleanup] ⚠️  DB 업데이트 실패(${storagePath}): ${msg}`,
        );
      }
    }
    console.log(
      `[cron/cleanup] 📝 DB 업데이트 완료 - 성공 ${dbUpdates.success}, 실패 ${dbUpdates.failed}`,
    );
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const summary =
    deleteResult.deleted.length === 0 && deleteResult.failed.length === 0
      ? "✨ 삭제 대상 파일이 없어 정리 완료"
      : `🗑️ 파일 ${deleteResult.deleted.length}개 삭제 (실패 ${deleteResult.failed.length}) / DB ${dbUpdates.success}건 업데이트`;

  console.log(`[cron/cleanup] ✅ ${summary}`);
  console.log(`[cron/cleanup] ⏱️  총 소요 시간: ${durationSeconds}s`);
  console.log("🧹 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const responseBody: CleanupResponse = {
    success: true,
    timestamp: new Date().toISOString(),
    duration_seconds: durationSeconds,
    summary,
    storage: {
      listed_expired_count:
        deleteResult.deleted.length + deleteResult.failed.length,
      deleted_count: deleteResult.deleted.length,
      failed_count: deleteResult.failed.length,
      deleted_files: deleteResult.deleted,
      failures: deleteResult.failed,
    },
    database: {
      updated_count: dbUpdates.success,
      failed_count: dbUpdates.failed,
    },
    errors,
  };

  return NextResponse.json(responseBody);
}

export async function GET(req: NextRequest) {
  return handleCleanup(req);
}

export async function POST(req: NextRequest) {
  return handleCleanup(req);
}
