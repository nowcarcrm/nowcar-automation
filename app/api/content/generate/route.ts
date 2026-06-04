import { NextResponse, type NextRequest } from "next/server";
import { isPipelineRequestAuthorized } from "@/lib/cron-auth";
import {
  generateContentWithUsage,
  type GeneratedDraftWithUsage,
} from "@/lib/anthropic";
import {
  getUnprocessedVideos,
  markVideoProcessed,
  bumpVideoGenerationAttempts,
  saveGeneratedContents,
  updateVideoTranscript,
  type ChannelType,
} from "@/lib/supabase";
import {
  transcribeFromBuffer,
  transcribeFromStoragePath,
} from "@/lib/whisper";
import { downloadYouTubeVideo } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
// H1: 채널 일부가 'failed' 면 processed 를 보류하고 다음 사이클에 재생성한다.
// 단 영구 실패 영상이 무한 재생성(비용 폭주)되지 않도록 이 횟수까지만 재시도하고
// 도달 시 포기(processed=true + 경보)한다.
const MAX_GENERATE_ATTEMPTS = 3;
// transcript 가 이 임계값보다 짧으면 description fallback 으로 채워진 것이므로
// Whisper STT 로 영상 음성을 직접 받아 보강한다.
const TRANSCRIPT_MIN_CHARS = 200;
// M4: 이 길이(초)를 넘는 롱폼은 ytdl 로 영상 전체를 버퍼에 받아도 Whisper 25MB
// 한도에 막혀 매번 다운로드·대역폭만 낭비되므로 STT 자체를 스킵하고 description 폴백.
const MAX_STT_SECONDS = parseInt(process.env.MAX_STT_SECONDS || "600", 10);

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

/**
 * Threads/Instagram 은 시청자/팬·마케터 톤 채널이라 5종 정보 박스(전화·카톡·
 * 홈페이지·유튜브·카페) 강제 검증을 면제한다. 광고문체 회피를 위해 본문에
 * 한 줄짜리 가벼운 안내만 들어가도록 채널 프롬프트에서 명시.
 * 카페·블로그·티스토리는 운영자 톤이라 5종 토큰 검증 유지(영업 끈 보장).
 */
function isCtaExemptChannel(channelType: ChannelType): boolean {
  return channelType === "threads" || channelType === "instagram";
}

function validateCta(
  body: string,
  channelType: ChannelType,
): { valid: boolean; missing: string[] } {
  if (isCtaExemptChannel(channelType)) {
    return { valid: true, missing: [] };
  }
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
    const validation = validateCta(generated.draft.body, channelType);

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

/**
 * M-6: IG/스레드 시청자·마케터 톤 정책의 코드 백스톱(비차단).
 * 프롬프트에만 의존하던 톤 강제를, 생성 후 금지 표현(공식 운영자/광고 문체)
 * 탐지로 보강한다. 위반 시 발행을 막지는 않고(status=pending 유지) errors+warn 으로
 * 노출해 운영자 스팟체크를 유도한다. (블로그/티스토리/카페는 운영자 톤이라 제외.)
 */
const VIEWER_TONE_BANNED = [
  "안녕하세요",
  "저희 나우카",
  "저희 브랜드",
  "고객님",
  "전문 상담사",
  "운영자가 안내",
  "많은 관심 부탁",
  "지금 바로 연락",
  "문의 주세요",
  "문의주세요",
] as const;

function detectToneDrift(channelType: ChannelType, body: string): string[] {
  if (channelType !== "instagram" && channelType !== "threads") return [];
  return VIEWER_TONE_BANNED.filter((p) => body.includes(p));
}

export async function GET(request?: NextRequest) {
  // C-2: HTTP 직접 호출은 CRON_SECRET 요구(무제한 Claude/Whisper 비용 방지).
  // 내부 파이프라인 호출(runContentGenerate(), request 미전달)은 면제.
  if (!isPipelineRequestAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
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

      // 1) transcript 길이 점검. 자막이 부실(쇼츠 description fallback 등)이면
      //    Whisper STT 로 영상 음성을 받아 보강한다.
      //    - storage_path 가 있으면 supabase storage 에서 다운로드 (빠름)
      //    - 없으면 (다운로드 워커가 아직 처리 못 한 흔한 race) ytdl-core 로 직접 다운로드
      let baseText = video.transcript?.trim() ?? "";

      const isLongformForStt =
        video.duration_seconds != null &&
        video.duration_seconds > MAX_STT_SECONDS;
      if (baseText.length < TRANSCRIPT_MIN_CHARS && isLongformForStt) {
        // M4: 롱폼은 Whisper 25MB 한도에 막혀 STT 가 실패할 게 뻔하므로 다운로드 자체를
        // 생략하고 description 폴백으로 진행(대역폭/시간 낭비 차단).
        console.warn(
          `[content/generate] ⏭ 롱폼(${video.duration_seconds}s) Whisper STT 스킵 → description 폴백: ${video.title}`,
        );
      } else if (baseText.length < TRANSCRIPT_MIN_CHARS) {
        console.log(
          `[content/generate] transcript 부족(${baseText.length}자) → Whisper STT 시도: ${video.title}`,
        );
        try {
          let sttText: string;
          if (video.storage_path) {
            ({ text: sttText } = await transcribeFromStoragePath(
              video.storage_path,
            ));
          } else {
            console.log(
              `[content/generate] storage_path 없음 → ytdl-core 로 직접 다운로드: ${video.video_id}`,
            );
            const buffer = await downloadYouTubeVideo(video.video_id);
            ({ text: sttText } = await transcribeFromBuffer(
              buffer,
              `${video.video_id}.mp4`,
            ));
          }

          baseText = sttText;
          try {
            await updateVideoTranscript(video.id, sttText);
          } catch (updateError) {
            const updateMsg =
              updateError instanceof Error
                ? updateError.message
                : String(updateError);
            console.warn(
              `[content/generate] transcript DB 업데이트 실패(진행은 계속): ${updateMsg}`,
            );
          }
          console.log(
            `[content/generate] Whisper STT 완료: ${sttText.length}자`,
          );
        } catch (sttError) {
          const sttMsg =
            sttError instanceof Error ? sttError.message : String(sttError);
          console.error(`[content/generate] Whisper STT 실패: ${sttMsg}`);
          errors.push(`[video_id=${video.video_id}] STT 실패: ${sttMsg}`);
        }
      }

      // 2) 그래도 비어있으면 description → title 순으로 최종 fallback
      if (!baseText.trim()) {
        baseText = video.description?.trim() || video.title;
      }

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
          const validation = validateCta(generated.draft.body, channelType);

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

          // M-6: 톤 드리프트 비차단 점검(IG/스레드만).
          const toneHits = detectToneDrift(channelType, generated.draft.body);
          if (toneHits.length > 0) {
            const toneMsg = `[${channelType}] 톤 위반 의심(시청자/마케터 톤): ${toneHits.join(", ")}`;
            errors.push(toneMsg);
            console.warn(`[content/generate] ⚠️ ${toneMsg}`);
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

      // Bug fix: 콘텐츠 저장이 실패하면 markVideoProcessed 도 호출하지 않는다.
      // 그렇지 않으면 generated_contents 0건이지만 processed=true 인 영구 누락
      // 상태가 됨 (2026-05-21~24 영상 4건이 그렇게 사라졌던 사고).
      let savedOk = false;
      try {
        await saveGeneratedContents(rowsToInsert);
        savedOk = true;
        console.log(
          `[content/generate] generated_contents 저장 완료: ${video.title} (${rowsToInsert.length}건)`,
        );
      } catch (error) {
        const message = toErrorMessage(error);
        errors.push(`[video_id=${video.video_id}] 콘텐츠 저장 실패: ${message}`);
        console.error(
          `[content/generate] DB 저장 실패 → processed 마킹 보류(다음 사이클 재시도): ${video.title} - ${message}`,
        );
      }

      if (savedOk) {
        // H1: 채널 일부라도 status='failed' 면 processed=true 로 찍지 않는다.
        // 찍으면 getUnprocessedVideos 가 이 영상을 다시 안 줘서 실패 채널이
        // 영구 누락된다(2026-05-21~24 사고의 부분실패형 잔존). 대신 다음 사이클에
        // 재생성하되, generation_attempts 로 MAX_GENERATE_ATTEMPTS 회까지만
        // 재시도하고 한도 도달 시 포기(processed=true)하며 경보를 남긴다.
        const hasFailedChannel = rowsToInsert.some((r) => r.status === "failed");
        const priorAttempts =
          (video as { generation_attempts?: number }).generation_attempts ?? 0;
        const giveUp = priorAttempts + 1 >= MAX_GENERATE_ATTEMPTS;

        if (hasFailedChannel && !giveUp) {
          try {
            await bumpVideoGenerationAttempts(video.id, priorAttempts + 1);
            console.warn(
              `[content/generate] ↻ 채널 일부 실패 → processed 보류, 재시도(${priorAttempts + 1}/${MAX_GENERATE_ATTEMPTS}): ${video.title}`,
            );
          } catch (error) {
            const message = toErrorMessage(error);
            errors.push(
              `[video_id=${video.video_id}] generation_attempts 증가 실패: ${message}`,
            );
            console.error(
              `[content/generate] generation_attempts 증가 실패: ${video.title} - ${message}`,
            );
          }
        } else {
          if (hasFailedChannel) {
            const failedChannels = rowsToInsert
              .filter((r) => r.status === "failed")
              .map((r) => r.channel_type)
              .join(", ");
            const giveUpMsg = `[video_id=${video.video_id}] 생성 ${MAX_GENERATE_ATTEMPTS}회 실패로 포기(processed 처리) — 누락 채널: ${failedChannels}`;
            errors.push(giveUpMsg);
            console.error(`[content/generate] ⛔ ${giveUpMsg}`);
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
        }
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
