import { NextResponse } from "next/server";
import { sendContentEmail, type EmailContentItem } from "@/lib/mailer";
import { markContentEmailSent, supabase, type ChannelType } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PendingContentRow {
  id: string;
  video_id: string;
  channel_type: ChannelType;
  title: string | null;
  body: string;
  hashtags: string | null;
  meta_description: string | null;
}

interface VideoRow {
  id: string;
  title: string;
  video_url: string | null;
  thumbnail_url: string | null;
}

interface EmailResultItem {
  video_id: string;
  video_title: string;
  email_sent: boolean;
  contents_count: number;
}

interface EmailResponse {
  success: boolean;
  timestamp: string;
  total_videos_to_email: number;
  emails_sent_count: number;
  emails_failed_count: number;
  results: EmailResultItem[];
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류";
}

export async function GET() {
  const errors: string[] = [];
  const results: EmailResultItem[] = [];
  let sentCount = 0;

  try {
    console.log("[content/email] 1차 조회: email_sent=false AND status=pending");
    const { data, error } = await supabase
      .from("generated_contents")
      .select("id,video_id,channel_type,title,body,hashtags,meta_description,status,email_sent")
      .eq("email_sent", false)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`대기 콘텐츠 조회 실패: ${error.message}`);
    }

    let pendingContents = (data ?? []) as PendingContentRow[];
    console.log(`[content/email] 1차 조회 결과: ${pendingContents.length}건`);

    // 디버깅: 실제 DB의 status/email_sent 분포 확인
    const { data: debugRows, error: debugError } = await supabase
      .from("generated_contents")
      .select("status,email_sent");
    if (debugError) {
      console.warn(`[content/email] 분포 조회 실패: ${debugError.message}`);
    } else {
      const distribution = new Map<string, number>();
      for (const row of debugRows ?? []) {
        const status = String((row as { status: string | null }).status ?? "null");
        const sent = Boolean((row as { email_sent: boolean | null }).email_sent);
        const key = `${status}|email_sent=${sent}`;
        distribution.set(key, (distribution.get(key) ?? 0) + 1);
      }
      console.log(
        `[content/email] status/email_sent 분포: ${JSON.stringify(
          Object.fromEntries(distribution),
        )}`,
      );
    }

    // 1차 결과가 0건이면 status 조건을 완화하여 재시도
    if (pendingContents.length === 0) {
      console.log(
        "[content/email] 2차 조회(fallback): status 조건 없이 email_sent=false 만 조회",
      );
      const { data: fallbackData, error: fallbackError } = await supabase
        .from("generated_contents")
        .select("id,video_id,channel_type,title,body,hashtags,meta_description")
        .eq("email_sent", false)
        .order("created_at", { ascending: true });

      if (fallbackError) {
        throw new Error(`fallback 조회 실패: ${fallbackError.message}`);
      }

      pendingContents = (fallbackData ?? []) as PendingContentRow[];
      console.log(`[content/email] 2차 조회 결과: ${pendingContents.length}건`);
    }

    if (pendingContents.length === 0) {
      const emptyResponse: EmailResponse = {
        success: true,
        timestamp: new Date().toISOString(),
        total_videos_to_email: 0,
        emails_sent_count: 0,
        emails_failed_count: 0,
        results: [],
        errors: [],
      };
      return NextResponse.json(emptyResponse);
    }

    // video_id(유튜브 테이블 UUID) 기준 그룹핑
    const groupedByVideo = new Map<string, PendingContentRow[]>();
    for (const content of pendingContents) {
      const current = groupedByVideo.get(content.video_id) ?? [];
      current.push(content);
      groupedByVideo.set(content.video_id, current);
    }

    const videoIds = Array.from(groupedByVideo.keys());
    const { data: videoRows, error: videoError } = await supabase
      .from("youtube_videos")
      .select("id,title,video_url,thumbnail_url")
      .in("id", videoIds);

    if (videoError) {
      throw new Error(`영상 메타데이터 조회 실패: ${videoError.message}`);
    }

    const videoMap = new Map<string, VideoRow>();
    for (const row of (videoRows ?? []) as VideoRow[]) {
      videoMap.set(row.id, row);
    }

    console.log(`[content/email] 발송 대상 영상 ${videoIds.length}개`);

    for (const [videoId, contents] of groupedByVideo.entries()) {
      const videoInfo = videoMap.get(videoId);
      if (!videoInfo) {
        const message = `[video_id=${videoId}] youtube_videos 정보가 없어 이메일 발송을 건너뜁니다.`;
        errors.push(message);
        console.error(`[content/email] ${message}`);
        results.push({
          video_id: videoId,
          video_title: "(영상 정보 없음)",
          email_sent: false,
          contents_count: contents.length,
        });
        continue;
      }

      const emailContents: EmailContentItem[] = contents.map((item) => ({
        id: item.id,
        channel_type: item.channel_type,
        title: item.title,
        body: item.body,
        hashtags: item.hashtags,
        meta_description: item.meta_description,
      }));

      try {
        console.log(`[content/email] 이메일 발송 중: ${videoInfo.title}`);
        await sendContentEmail(
          videoInfo.title,
          videoInfo.video_url ?? `https://www.youtube.com/watch?v=${videoId}`,
          emailContents,
          videoInfo.thumbnail_url,
        );

        // 발송 성공한 콘텐츠만 email_sent=true
        for (const content of contents) {
          await markContentEmailSent(content.id);
        }

        sentCount += 1;
        results.push({
          video_id: videoId,
          video_title: videoInfo.title,
          email_sent: true,
          contents_count: contents.length,
        });
        console.log(
          `[content/email] 발송 완료 + 상태 업데이트 완료: ${videoInfo.title} (${contents.length}건)`,
        );
      } catch (error) {
        const message = `[video_id=${videoId}] 이메일 발송 실패: ${toErrorMessage(error)}`;
        errors.push(message);
        console.error(`[content/email] ${message}`);
        results.push({
          video_id: videoId,
          video_title: videoInfo.title,
          email_sent: false,
          contents_count: contents.length,
        });
      }
    }

    const responseBody: EmailResponse = {
      success: errors.length === 0,
      timestamp: new Date().toISOString(),
      total_videos_to_email: groupedByVideo.size,
      emails_sent_count: sentCount,
      emails_failed_count: groupedByVideo.size - sentCount,
      results,
      errors,
    };

    return NextResponse.json(responseBody);
  } catch (error) {
    const message = `전체 처리 실패: ${toErrorMessage(error)}`;
    errors.push(message);
    console.error(`[content/email] ${message}`);

    const failedResponse: EmailResponse = {
      success: false,
      timestamp: new Date().toISOString(),
      total_videos_to_email: 0,
      emails_sent_count: sentCount,
      emails_failed_count: 0,
      results,
      errors,
    };

    return NextResponse.json(failedResponse, { status: 500 });
  }
}
