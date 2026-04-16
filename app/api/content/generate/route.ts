import { NextResponse } from "next/server";
import {
  generateContentWithUsage,
  type GeneratedDraftWithUsage,
} from "@/lib/anthropic";
import {
  getUnprocessedVideos,
  markVideoProcessed,
  saveGeneratedContents,
  type ChannelType,
} from "@/lib/supabase";

type ChannelResult = {
  success: boolean;
  length: number;
  validation: {
    passed: boolean;
    missing: string[];
  };
};

type VideoProcessResult = {
  video_id: string;
  video_title: string;
  contents: Record<ChannelType, ChannelResult>;
};

interface GenerateResponse {
  success: boolean;
  timestamp: string;
  processed_videos_count: number;
  total_contents_generated: number;
  results: VideoProcessResult[];
  errors: string[];
}

const CHANNEL_TYPES: ChannelType[] = [
  "naver_blog",
  "tistory",
  "instagram",
  "threads",
  "naver_cafe",
];
const CTA_REQUIRED_TOKENS = ["www.나우카.com", "초대박신차의성지", "유튜브"] as const;
const MAX_CTA_RETRY = 2;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류";
}

function createDefaultChannelResult(): Record<ChannelType, ChannelResult> {
  return {
    naver_blog: { success: false, length: 0, validation: { passed: false, missing: [] } },
    tistory: { success: false, length: 0, validation: { passed: false, missing: [] } },
    instagram: { success: false, length: 0, validation: { passed: false, missing: [] } },
    threads: { success: false, length: 0, validation: { passed: false, missing: [] } },
    naver_cafe: { success: false, length: 0, validation: { passed: false, missing: [] } },
  };
}

function validateCta(body: string): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!body.includes("www.나우카.com") && !body.includes("나우카.com")) {
    missing.push("www.나우카.com");
  }
  if (!body.includes("초대박신차의성지")) {
    missing.push("초대박신차의성지");
  }
  if (!body.includes("유튜브")) {
    missing.push("유튜브");
  }
  return { valid: missing.length === 0, missing: [...missing] };
}

async function generateWithCtaRetry(
  baseText: string,
  title: string,
  channelType: ChannelType,
): Promise<GeneratedDraftWithUsage> {
  let last: GeneratedDraftWithUsage | null = null;

  for (let attempt = 0; attempt <= MAX_CTA_RETRY; attempt += 1) {
    const generated = await generateContentWithUsage(baseText, title, channelType);
    last = generated;
    const validation = validateCta(generated.draft.body);

    if (validation.valid) {
      console.log(
        `[content/generate] CTA 검증 통과(${channelType}) - 시도 ${attempt + 1}회`,
      );
      return generated;
    }

    console.warn(
      `[content/generate] CTA 누락 경고(${channelType}) - 시도 ${attempt + 1}회, 누락: ${validation.missing.join(", ")}`,
    );
  }

  return last as GeneratedDraftWithUsage;
}

export async function GET() {
  const errors: string[] = [];
  const results: VideoProcessResult[] = [];
  let totalGeneratedCount = 0;

  try {
    console.log("[content/generate] 미처리 영상 조회 시작");
    const unprocessedVideos = await getUnprocessedVideos();
    const targetVideos = unprocessedVideos.slice(0, 3);

    console.log(
      `[content/generate] 전체 ${unprocessedVideos.length}개 중 ${targetVideos.length}개 영상 처리 시작(최대 3개 제한)`,
    );

    for (const video of targetVideos) {
      console.log(`[content/generate] 영상 처리 시작: ${video.title} (${video.video_id})`);
      const channelResults = createDefaultChannelResult();

      // 자막이 비어있으면 설명으로 대체해 생성 입력을 보장
      const baseText =
        video.transcript?.trim() || video.description?.trim() || video.title;

      const settledResults = await Promise.allSettled(
        CHANNEL_TYPES.map(async (channelType) => {
          const generated = await generateWithCtaRetry(
            baseText,
            video.title,
            channelType,
          );
          return { channelType, generated };
        }),
      );

      const rowsToInsert: Array<{
        video_id: string;
        channel_type: ChannelType;
        title: string | null;
        body: string;
        hashtags: string | null;
        meta_description: string | null;
        status: "pending" | "failed" | "cta_incomplete";
        email_sent: boolean;
      }> = [];

      for (let index = 0; index < settledResults.length; index += 1) {
        const channelType = CHANNEL_TYPES[index];
        const settled = settledResults[index];

        if (settled.status === "fulfilled") {
          const { generated } = settled.value as {
            channelType: ChannelType;
            generated: GeneratedDraftWithUsage;
          };
          const bodyLength = generated.draft.body.length;
          const validation = validateCta(generated.draft.body);

          channelResults[channelType] = {
            success: true,
            length: bodyLength,
            validation: {
              passed: validation.valid,
              missing: validation.missing,
            },
          };

          totalGeneratedCount += 1;

          rowsToInsert.push({
            video_id: video.id,
            channel_type: channelType,
            title: generated.draft.title,
            body: generated.draft.body,
            hashtags: generated.draft.hashtags,
            meta_description: generated.draft.meta_description,
            status: validation.valid ? "pending" : "cta_incomplete",
            // 이메일 발송 API가 잡아갈 수 있도록 생성 시점에는 반드시 false
            email_sent: false,
          });

          if (!validation.valid) {
            const warnMessage = `[${channelType}] CTA 누락: ${validation.missing.join(", ")}`;
            errors.push(warnMessage);
            console.warn(warnMessage);
          }

          console.log(
            `[content/generate] 생성 완료(${channelType}) - 길이 ${bodyLength}자, 토큰 in/out: ${generated.usage.input_tokens}/${generated.usage.output_tokens}`,
          );
        } else {
          const errorMessage = toErrorMessage(settled.reason);
          errors.push(
            `[video_id=${video.video_id}] 채널 ${channelType} 생성 실패: ${errorMessage}`,
          );

          rowsToInsert.push({
            video_id: video.id,
            channel_type: channelType,
            title: null,
            body: `콘텐츠 생성 실패: ${errorMessage}`,
            hashtags: null,
            meta_description: null,
            status: "failed",
            // 실패 콘텐츠도 재처리/분석을 위해 미발송 상태로 저장
            email_sent: false,
          });

          channelResults[channelType] = {
            success: false,
            length: 0,
            validation: {
              passed: false,
              missing: [...CTA_REQUIRED_TOKENS],
            },
          };

          console.error(
            `[content/generate] 생성 실패(${channelType}) - ${video.title}: ${errorMessage}`,
          );
        }
      }

      try {
        await saveGeneratedContents(rowsToInsert);
        console.log(
          `[content/generate] generated_contents 저장 완료: ${video.title} (5건)`,
        );
      } catch (error) {
        const message = toErrorMessage(error);
        errors.push(`[video_id=${video.video_id}] 콘텐츠 저장 실패: ${message}`);
        console.error(`[content/generate] DB 저장 실패: ${video.title} - ${message}`);
      }

      try {
        await markVideoProcessed(video.id);
        console.log(`[content/generate] 영상 처리 완료 표시: ${video.title}`);
      } catch (error) {
        const message = toErrorMessage(error);
        errors.push(`[video_id=${video.video_id}] processed 업데이트 실패: ${message}`);
        console.error(
          `[content/generate] processed 업데이트 실패: ${video.title} - ${message}`,
        );
      }

      results.push({
        video_id: video.video_id,
        video_title: video.title,
        contents: channelResults,
      });
    }

    const responseBody: GenerateResponse = {
      success: errors.length === 0,
      timestamp: new Date().toISOString(),
      processed_videos_count: results.length,
      total_contents_generated: totalGeneratedCount,
      results,
      errors,
    };

    return NextResponse.json(responseBody);
  } catch (error) {
    const message = `전체 처리 실패: ${toErrorMessage(error)}`;
    errors.push(message);
    console.error(`[content/generate] ${message}`);

    const failedResponse: GenerateResponse = {
      success: false,
      timestamp: new Date().toISOString(),
      processed_videos_count: results.length,
      total_contents_generated: totalGeneratedCount,
      results,
      errors,
    };

    return NextResponse.json(failedResponse, { status: 500 });
  }
}
