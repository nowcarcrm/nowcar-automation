import { NextRequest, NextResponse } from "next/server";
import { runDetectStep } from "@/lib/pipeline/detect";
import { runGenerateStep } from "@/lib/pipeline/generate";
import { runEmailStep } from "@/lib/pipeline/email";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StepStatus = "ok" | "skipped" | "error";

interface DetectStepResult {
  status: StepStatus;
  new_videos_count: number;
  existing_videos_count: number;
  duration_seconds: number;
}

interface GenerateStepResult {
  status: StepStatus;
  processed_videos_count: number;
  total_contents_generated: number;
  duration_seconds: number;
}

interface EmailStepResult {
  status: StepStatus;
  emails_sent_count: number;
  emails_failed_count: number;
  duration_seconds: number;
}

interface PipelineResponse {
  success: boolean;
  timestamp: string;
  total_duration_seconds: number;
  pipeline_id: string;
  steps: {
    step1_detect: DetectStepResult;
    step2_generate: GenerateStepResult;
    step3_email: EmailStepResult;
  };
  summary: string;
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류";
}

export async function GET(request: NextRequest) {
  const pipelineId = crypto.randomUUID();
  const skipEmail = request.nextUrl.searchParams.get("skip_email") === "true";
  const force = request.nextUrl.searchParams.get("force") === "true";
  const startedAt = Date.now();
  const errors: string[] = [];

  console.log("🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚀 나우카 자동화 파이프라인 시작");
  console.log("🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[pipeline] pipeline_id=${pipelineId}, skip_email=${skipEmail}, force=${force}`);

  const step1: DetectStepResult = {
    status: "skipped",
    new_videos_count: 0,
    existing_videos_count: 0,
    duration_seconds: 0,
  };
  const step2: GenerateStepResult = {
    status: "skipped",
    processed_videos_count: 0,
    total_contents_generated: 0,
    duration_seconds: 0,
  };
  const step3: EmailStepResult = {
    status: "skipped",
    emails_sent_count: 0,
    emails_failed_count: 0,
    duration_seconds: 0,
  };

  // [1/3] YouTube 영상 감지
  const step1StartedAt = Date.now();
  try {
    console.log("[1/3] 🎬 YouTube 영상 감지 중...");
    const data = await runDetectStep();
    step1.status = "ok";
    step1.new_videos_count = data.new_videos_count ?? 0;
    step1.existing_videos_count = data.existing_videos_count ?? 0;
    if ((data.errors.length ?? 0) > 0) {
      errors.push(...data.errors.map((error) => `[step1_detect] ${error}`));
    }
    step1.duration_seconds = Math.round((Date.now() - step1StartedAt) / 1000);
    console.log(
      `[1/3] ✅ 신규 영상 ${step1.new_videos_count}개 발견 (소요: ${step1.duration_seconds}s)`,
    );
  } catch (error) {
    step1.status = "error";
    step1.duration_seconds = Math.round((Date.now() - step1StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step1_detect] ${message}`);
    console.error(`[pipeline] step1 실패: ${message}`);
  }

  // [2/3] 콘텐츠 생성 (조건부)
  const step2StartedAt = Date.now();
  try {
    if (!force && step1.new_videos_count === 0) {
      console.log("[2/3] ⏭️ 신규 영상이 없어 콘텐츠 생성을 건너뜁니다.");
      step2.status = "skipped";
      step2.processed_videos_count = 0;
      step2.total_contents_generated = 0;
      step2.duration_seconds = Math.round((Date.now() - step2StartedAt) / 1000);
    } else {
      console.log("[2/3] ✨ Claude 5종 콘텐츠 생성 중...");
      const data = await runGenerateStep();

      step2.status = "ok";
      step2.processed_videos_count = data.processed_videos_count ?? 0;
      step2.total_contents_generated = data.total_contents_generated ?? 0;
      if ((data.errors.length ?? 0) > 0) {
        errors.push(...data.errors.map((error) => `[step2_generate] ${error}`));
      }
      step2.duration_seconds = Math.round((Date.now() - step2StartedAt) / 1000);
      console.log(
        `[2/3] ✅ ${step2.processed_videos_count}개 영상 처리, ${step2.total_contents_generated}개 콘텐츠 생성 (소요: ${step2.duration_seconds}s)`,
      );
    }
  } catch (error) {
    step2.status = "error";
    step2.duration_seconds = Math.round((Date.now() - step2StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step2_generate] ${message}`);
    console.error(`[pipeline] step2 실패: ${message}`);
  }

  // [3/3] 이메일 발송
  const step3StartedAt = Date.now();
  try {
    if (skipEmail) {
      console.log("[3/3] ⏭️ skip_email=true 설정으로 이메일 단계를 건너뜁니다.");
      step3.status = "skipped";
      step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
    } else {
      console.log("[3/3] 📧 이메일 발송 중...");
      const data = await runEmailStep();

      if (!data.has_pending_email) {
        step3.status = "skipped";
        step3.emails_sent_count = 0;
        step3.emails_failed_count = 0;
        step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
        console.log(
          `[3/3] ⏭️ 이메일 발송 대상이 없어 건너뜀 (소요: ${step3.duration_seconds}s)`,
        );
      } else {
        step3.status = "ok";
        step3.emails_sent_count = data.emails_sent_count ?? 0;
        step3.emails_failed_count = data.emails_failed_count ?? 0;
        if ((data.errors.length ?? 0) > 0) {
          errors.push(...data.errors.map((error) => `[step3_email] ${error}`));
        }
        step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
        console.log(
          `[3/3] ✅ ${step3.emails_sent_count}통 이메일 발송 완료 (소요: ${step3.duration_seconds}s)`,
        );
      }
    }
  } catch (error) {
    step3.status = "error";
    step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step3_email] ${message}`);
    console.error(`[pipeline] step3 실패: ${message}`);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const failedStepCount = [step1.status, step2.status, step3.status].filter(
    (status) => status === "error",
  ).length;
  const success = failedStepCount < 3;

  const summary = success
    ? `✅ 신규 영상 ${step1.new_videos_count}개 감지 → ${step2.total_contents_generated}개 콘텐츠 생성 → ${step3.emails_sent_count}개 이메일 발송 완료`
    : "❌ 모든 단계가 실패했습니다. 로그와 errors를 확인해주세요.";

  console.log("✅ 전체 완료");

  const responseBody: PipelineResponse = {
    success,
    timestamp: new Date().toISOString(),
    total_duration_seconds: elapsedSeconds,
    pipeline_id: pipelineId,
    steps: {
      step1_detect: step1,
      step2_generate: step2,
      step3_email: step3,
    },
    summary,
    errors,
  };

  console.log("✅ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ 전체 완료 (총 소요: ${elapsedSeconds}s)`);
  console.log("✅ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return NextResponse.json(responseBody, { status: success ? 200 : 500 });
}
