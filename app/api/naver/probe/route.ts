import { NextRequest, NextResponse } from "next/server";
import { isPipelineRequestAuthorized } from "@/lib/cron-auth";
import {
  NaverApiError,
  NaverTokenError,
  publishNaverCafeArticle,
} from "@/lib/naver";
import { createAdminClient } from "@/lib/storage";

/**
 * ============================================================
 * /api/naver/probe  (1회용 진단 엔드포인트 — 999 차단 해제 확인)
 * ------------------------------------------------------------
 * 배경: 2026-05-27 이후 카페가 HTTP 403/code 999(봇감지 차단)로 막혀
 * kill switch(NAVER_CAFE_AUTO_PUBLISH_PAUSED)로 자동발행을 완전히 OFF 한 상태.
 * 차단이 풀렸는지는 실제 1회 POST 해봐야만 알 수 있다. 이 엔드포인트는
 * CRON_SECRET 보호하에 최신 영상의 naver_cafe 콘텐츠 1건을 실제 카페에 올려
 * 999/성공 여부를 즉시 반환한다.
 *
 *  - kill switch 와 무관하게 동작(진단 목적): 핸들러 내에서만 게이트를 강제
 *    개방하고 finally 에서 원래 env 로 복원한다(다른 invocation 오염 방지).
 *  - 성공 시 social_publishes 에 success 1행 기록(정상 파이프라인 중복발행 방지).
 *  - 차단 확인이 끝나면 이 라우트는 제거 예정.
 * ============================================================
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isPipelineRequestAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const supabase = createAdminClient();

  // 최신 영상 1건 (recency 무관, 진단용)
  const { data: videos, error: videosError } = await supabase
    .from("youtube_videos")
    .select("id, video_id, title, video_url")
    .eq("processed", true)
    .order("published_at", { ascending: false })
    .limit(1);

  if (videosError) {
    return NextResponse.json(
      { success: false, error: `youtube_videos 조회 실패: ${videosError.message}` },
      { status: 500 },
    );
  }

  const video = videos?.[0];
  if (!video) {
    return NextResponse.json(
      { success: false, error: "처리된 영상이 없습니다." },
      { status: 404 },
    );
  }

  const { data: contents } = await supabase
    .from("generated_contents")
    .select("title, body")
    .eq("video_id", video.id)
    .eq("channel_type", "naver_cafe")
    .neq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(1);

  const content = contents?.[0];
  if (!content?.body) {
    return NextResponse.json(
      { success: false, error: `naver_cafe 콘텐츠 없음(video_id=${video.video_id})` },
      { status: 404 },
    );
  }

  const subject = (content.title?.trim() || video.title).slice(0, 100);
  const contentText = video.video_url
    ? `${content.body.trim()}\n\n🎬 영상 보기: ${video.video_url}`
    : content.body.trim();

  // kill switch 우회: probe 동안만 게이트 강제 개방, finally 에서 원복.
  const prevForce = process.env.NAVER_CAFE_FORCE_RESUME;
  const prevAuto = process.env.AUTO_PUBLISH_NAVER_CAFE;
  process.env.NAVER_CAFE_FORCE_RESUME = "true";
  process.env.AUTO_PUBLISH_NAVER_CAFE = "true";

  try {
    const result = await publishNaverCafeArticle({ subject, contentText });

    if (result.success) {
      const nowIso = new Date().toISOString();
      const { error: insertError } = await supabase
        .from("social_publishes")
        .insert({
          video_id: video.video_id,
          platform: "naver_cafe",
          status: "success",
          external_id: result.externalId ?? null,
          caption_preview: contentText.slice(0, 200),
          created_at: nowIso,
          updated_at: nowIso,
        });
      if (insertError) {
        console.warn(
          `[naver/probe] success 기록 실패(발행 자체는 성공): ${insertError.message}`,
        );
      }
    }

    return NextResponse.json({
      probe: true,
      video_id: video.video_id,
      subject,
      success: result.success,
      externalId: result.externalId ?? null,
      articleUrl: result.articleUrl ?? null,
      error: result.errorMessage ?? null,
      raw: result.raw ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof NaverApiError ? err.status : undefined;
    const rawBody =
      err instanceof NaverApiError ? err.rawBody : undefined;
    const kind =
      err instanceof NaverTokenError
        ? "token"
        : err instanceof NaverApiError
          ? "api"
          : "unknown";
    console.error(`[naver/probe] ❌ ${kind} 실패: ${msg}`);
    return NextResponse.json({
      probe: true,
      video_id: video.video_id,
      subject,
      success: false,
      kind,
      http_status: status ?? null,
      error: msg,
      raw_body: rawBody ?? null,
    });
  } finally {
    if (prevForce === undefined) delete process.env.NAVER_CAFE_FORCE_RESUME;
    else process.env.NAVER_CAFE_FORCE_RESUME = prevForce;
    if (prevAuto === undefined) delete process.env.AUTO_PUBLISH_NAVER_CAFE;
    else process.env.AUTO_PUBLISH_NAVER_CAFE = prevAuto;
  }
}
