import { NextRequest, NextResponse } from "next/server";
import { isPipelineRequestAuthorized } from "@/lib/cron-auth";
import { runDetectStep } from "@/lib/pipeline/detect";
import { runGenerateStep } from "@/lib/pipeline/generate";
import { runEmailStep } from "@/lib/pipeline/email";
import { runPublishMetaStep } from "@/lib/pipeline/publish-meta";
import { runPublishNaverCafeStep } from "@/lib/pipeline/publish-naver-cafe";
import { sendToTistory } from "@/lib/mailer";
import { getPendingTistoryContents, markContentPublished } from "@/lib/supabase";

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
  tistory_published_count: number;
  tistory_failed_count: number;
  duration_seconds: number;
}

interface PublishNaverCafeStepResult {
  status: StepStatus;
  processed_videos_count: number;
  naver_cafe_published_count: number;
  naver_cafe_failed_count: number;
  naver_cafe_skipped_count: number;
  duration_seconds: number;
}

interface PublishMetaStepResult {
  status: StepStatus;
  processed_videos_count: number;
  instagram_published_count: number;
  instagram_failed_count: number;
  instagram_skipped_count: number;
  facebook_published_count: number;
  facebook_failed_count: number;
  facebook_skipped_count: number;
  threads_published_count: number;
  threads_failed_count: number;
  threads_skipped_count: number;
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
    step3_publish_meta: PublishMetaStepResult;
    step4_publish_naver_cafe: PublishNaverCafeStepResult;
    step5_email: EmailStepResult;
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
  // C-1: 무인증 외부 트리거 차단. 내부 트리거(cron/download)는 Authorization 헤더로
  // CRON_SECRET 을 전달한다. 외부 uptime 모니터(cron-job.org)는 ?secret= 필요.
  if (!isPipelineRequestAuthorized(request)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  const pipelineId = crypto.randomUUID();
  const skipEmail = request.nextUrl.searchParams.get("skip_email") === "true";
  const startedAt = Date.now();
  const errors: string[] = [];

  console.log("🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🚀 나우카 자동화 파이프라인 시작");
  console.log("🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[pipeline] pipeline_id=${pipelineId}, skip_email=${skipEmail}`);

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
  const step3: PublishMetaStepResult = {
    status: "skipped",
    processed_videos_count: 0,
    instagram_published_count: 0,
    instagram_failed_count: 0,
    instagram_skipped_count: 0,
    facebook_published_count: 0,
    facebook_failed_count: 0,
    facebook_skipped_count: 0,
    threads_published_count: 0,
    threads_failed_count: 0,
    threads_skipped_count: 0,
    duration_seconds: 0,
  };
  const step4: EmailStepResult = {
    status: "skipped",
    emails_sent_count: 0,
    emails_failed_count: 0,
    tistory_published_count: 0,
    tistory_failed_count: 0,
    duration_seconds: 0,
  };
  const step5: PublishNaverCafeStepResult = {
    status: "skipped",
    processed_videos_count: 0,
    naver_cafe_published_count: 0,
    naver_cafe_failed_count: 0,
    naver_cafe_skipped_count: 0,
    duration_seconds: 0,
  };

  // [1/4] YouTube 영상 감지
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

  // [2/5] 콘텐츠 생성
  //   - 이전에는 step1.new_videos_count > 0 일 때만 돌렸는데, 그 run 의 generate 가
  //     실패하면 영상은 processed=false 로 남고 이후 사이클은 new_videos_count=0
  //     이라 영원히 재시도되지 않아 발행이 영구 누락되는 문제가 있었다.
  //   - 항상 runGenerateStep 을 호출하고, 내부의 getUnprocessedVideos 가 빈 배열이면
  //     스스로 빠르게 끝낸다. (force 플래그는 호환성을 위해 유지하지만 게이트 의미는 없음)
  const step2StartedAt = Date.now();
  try {
    console.log("[2/5] ✨ Claude 5종 콘텐츠 생성 중...");
    const data = await runGenerateStep();

    step2.processed_videos_count = data.processed_videos_count ?? 0;
    step2.total_contents_generated = data.total_contents_generated ?? 0;
    step2.status = step2.processed_videos_count === 0 ? "skipped" : "ok";
    if ((data.errors.length ?? 0) > 0) {
      errors.push(...data.errors.map((error) => `[step2_generate] ${error}`));
    }
    step2.duration_seconds = Math.round((Date.now() - step2StartedAt) / 1000);
    console.log(
      `[2/5] ✅ ${step2.processed_videos_count}개 영상 처리, ${step2.total_contents_generated}개 콘텐츠 생성 (소요: ${step2.duration_seconds}s)`,
    );
  } catch (error) {
    step2.status = "error";
    step2.duration_seconds = Math.round((Date.now() - step2StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step2_generate] ${message}`);
    console.error(`[pipeline] step2 실패: ${message}`);
  }

  // [3/4] Meta 자동 발행 (인스타 Reels + 페북 페이지)
  //   - step2 가 error 여도 기존 미발행 영상이 있을 수 있으므로 계속 시도
  //   - 내부에서 영상/플랫폼 단위 try-catch 로 보호되어 있어 전체를 멈추지 않음
  const step3StartedAt = Date.now();
  try {
    console.log("[3/4] 📱 Meta 자동 발행(인스타 Reels + 페북 페이지) 시작...");
    const data = await runPublishMetaStep();

    step3.processed_videos_count = data.processed_videos_count;
    step3.instagram_published_count = data.instagram_published_count;
    step3.instagram_failed_count = data.instagram_failed_count;
    step3.instagram_skipped_count = data.instagram_skipped_count;
    step3.facebook_published_count = data.facebook_published_count;
    step3.facebook_failed_count = data.facebook_failed_count;
    step3.facebook_skipped_count = data.facebook_skipped_count;
    step3.threads_published_count = data.threads_published_count;
    step3.threads_failed_count = data.threads_failed_count;
    step3.threads_skipped_count = data.threads_skipped_count;

    // H-1: Threads 를 상태계산에 포함. 이전엔 IG/FB 만 합산해 Threads-only 장애가
    // totalTried=0 → status='skipped' 로 은폐됐다.
    const totalTried =
      data.instagram_published_count +
      data.instagram_failed_count +
      data.facebook_published_count +
      data.facebook_failed_count +
      data.threads_published_count +
      data.threads_failed_count;
    const totalSucceeded =
      data.instagram_published_count +
      data.facebook_published_count +
      data.threads_published_count;

    if (totalTried === 0) {
      step3.status = "skipped";
    } else if (totalSucceeded === 0) {
      step3.status = "error";
    } else {
      step3.status = "ok";
    }

    if (data.errors.length > 0) {
      errors.push(...data.errors.map((error) => `[step3_publish_meta] ${error}`));
    }

    step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
    console.log(
      `[3/4] ✅ 발행 요약 - 인스타 ${step3.instagram_published_count}/${step3.instagram_published_count + step3.instagram_failed_count}, 페북 ${step3.facebook_published_count}/${step3.facebook_published_count + step3.facebook_failed_count}, 스레드 ${step3.threads_published_count}/${step3.threads_published_count + step3.threads_failed_count} (소요: ${step3.duration_seconds}s)`,
    );
  } catch (error) {
    step3.status = "error";
    step3.duration_seconds = Math.round((Date.now() - step3StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step3_publish_meta] ${message}`);
    console.error(`[pipeline] step3 실패: ${message}`);
  }

  // [4/5] 네이버 카페 자동 발행
  const step4StartedAt = Date.now();
  try {
    console.log("[4/5] ☕ 네이버 카페 자동 발행 시작...");
    const data = await runPublishNaverCafeStep();

    step5.processed_videos_count = data.processed_videos_count;
    step5.naver_cafe_published_count = data.naver_cafe_published_count;
    step5.naver_cafe_failed_count = data.naver_cafe_failed_count;
    step5.naver_cafe_skipped_count = data.naver_cafe_skipped_count;

    const totalTried =
      data.naver_cafe_published_count + data.naver_cafe_failed_count;
    if (totalTried === 0) {
      step5.status = "skipped";
    } else if (data.naver_cafe_published_count === 0) {
      step5.status = "error";
    } else {
      step5.status = "ok";
    }

    if (data.errors.length > 0) {
      errors.push(
        ...data.errors.map((error) => `[step4_publish_naver_cafe] ${error}`),
      );
    }

    step5.duration_seconds = Math.round((Date.now() - step4StartedAt) / 1000);
    console.log(
      `[4/5] ✅ 네이버 카페 발행 요약 - ${step5.naver_cafe_published_count}/${step5.naver_cafe_published_count + step5.naver_cafe_failed_count} (소요: ${step5.duration_seconds}s)`,
    );
  } catch (error) {
    step5.status = "error";
    step5.duration_seconds = Math.round((Date.now() - step4StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step4_publish_naver_cafe] ${message}`);
    console.error(`[pipeline] step4(네이버 카페) 실패: ${message}`);
  }

  // [5/5] 이메일 발송 (대표님 메일 + 티스토리)
  const step5StartedAt = Date.now();
  try {
    if (skipEmail) {
      console.log("[5/5] ⏭️ skip_email=true 설정으로 이메일 단계를 건너뜁니다.");
      step4.status = "skipped";
      step4.duration_seconds = Math.round((Date.now() - step5StartedAt) / 1000);
    } else {
      console.log("[5/5] 📧 이메일 발송 중...");
      // Bug fix: AUTO_PUBLISH_TISTORY=false 면 tistory pending 자체를 가져오지 않는다.
      // 안 그러면 매 사이클마다 모든 tistory pending row 가 sendToTistory 의 가드에서
      // throw → errors 배열에 수십 개 누적되는 노이즈가 쌓인다. 정책상 off 면 실제로
      // 시도조차 하지 말 것.
      const tistoryEnabled = process.env.AUTO_PUBLISH_TISTORY === "true";
      const tistoryCandidates = tistoryEnabled
        ? await getPendingTistoryContents()
        : [];
      if (!tistoryEnabled) {
        console.log(
          "[5/5] ⏭ AUTO_PUBLISH_TISTORY != true — 티스토리 발행 단계 자체 스킵",
        );
      }
      const data = await runEmailStep();

      if (!data.has_pending_email) {
        step4.status = "skipped";
        step4.emails_sent_count = 0;
        step4.emails_failed_count = 0;
        step4.duration_seconds = Math.round((Date.now() - step5StartedAt) / 1000);
        console.log(
          `[5/5] ⏭️ 이메일 발송 대상이 없어 건너뜀 (소요: ${step4.duration_seconds}s)`,
        );
      } else {
        step4.status = "ok";
        step4.emails_sent_count = data.emails_sent_count ?? 0;
        step4.emails_failed_count = data.emails_failed_count ?? 0;
        if ((data.errors.length ?? 0) > 0) {
          errors.push(...data.errors.map((error) => `[step5_email] ${error}`));
        }
        step4.duration_seconds = Math.round((Date.now() - step5StartedAt) / 1000);
        console.log(
          `[5/5] ✅ ${step4.emails_sent_count}통 이메일 발송 완료 (소요: ${step4.duration_seconds}s)`,
        );
      }

      // 티스토리 전용 이메일 발행 (대표님 메일 발송과 독립 처리)
      if (tistoryCandidates.length > 0) {
        console.log(`[5/5] 📨 티스토리 이메일 발행 시도: ${tistoryCandidates.length}건`);
      }

      for (const content of tistoryCandidates) {
        try {
          await sendToTistory(content);
          await markContentPublished(content.id);
          step4.tistory_published_count += 1;
        } catch (error) {
          step4.tistory_failed_count += 1;
          const message = toErrorMessage(error);
          errors.push(`[step4_email][tistory:${content.id}] ${message}`);
          console.error(`[pipeline] 티스토리 발행 실패(${content.id}): ${message}`);
        }
      }
    }
  } catch (error) {
    step4.status = "error";
    step4.duration_seconds = Math.round((Date.now() - step5StartedAt) / 1000);
    const message = toErrorMessage(error);
    errors.push(`[step5_email] ${message}`);
    console.error(`[pipeline] step5(이메일) 실패: ${message}`);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const stepStatuses = [
    step1.status,
    step2.status,
    step3.status,
    step5.status, // 변수명 step5 는 실제 카페 단계 (가독성 부채, 추후 리네이밍)
    step4.status, // 변수명 step4 는 실제 이메일 단계
  ];
  const failedStepCount = stepStatuses.filter((s) => s === "error").length;
  // body.success 는 엄격하게: 한 개라도 error 면 false (이메일/모니터링 신뢰도용).
  const success = failedStepCount === 0;

  // HTTP status 는 body.success 와 분리한다.
  //   배경(2026-06-01): 외부 uptime 크론(cron-job.org)이 /api/pipeline/run 을
  //   주기 호출하는데, 부분 실패(예: 네이버 카페 999 일시 차단, Meta 일시 오류)
  //   하나만 나도 500 을 받으면 "엔드포인트 다운" 으로 간주 → 연속 실패 누적 시
  //   크론 자체를 자동 비활성화해버려 발행이 통째로 멈춘다(실제 27회 실패로 disable됨).
  //   → 파이프라인이 끝까지 돌았다면(각 단계 try-catch 로 보호됨) 200 을 반환해
  //     크론을 살려둔다. 모든 단계가 error 인 "진짜 마비" 일 때만 500 으로 알린다.
  //   부분 실패 추적은 body.success / errors[] / 이메일 리포트로 한다.
  const allStepsFailed =
    failedStepCount > 0 && failedStepCount === stepStatuses.length;
  const httpStatus = allStepsFailed ? 500 : 200;

  const summary = success
    ? `✅ 신규 영상 ${step1.new_videos_count}개 → 콘텐츠 ${step2.total_contents_generated}개 생성 → 인스타 ${step3.instagram_published_count}건/페북 ${step3.facebook_published_count}건/스레드 ${step3.threads_published_count}건 발행 → 카페 ${step5.naver_cafe_published_count}건 발행 → 이메일 ${step4.emails_sent_count}통 발송`
    : "❌ 모든 단계가 실패했습니다. 로그와 errors를 확인해주세요.";

  const responseBody: PipelineResponse = {
    success,
    timestamp: new Date().toISOString(),
    total_duration_seconds: elapsedSeconds,
    pipeline_id: pipelineId,
    steps: {
      step1_detect: step1,
      step2_generate: step2,
      step3_publish_meta: step3,
      step4_publish_naver_cafe: step5,
      step5_email: step4,
    },
    summary,
    errors,
  };

  console.log("✅ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ 전체 완료 (총 소요: ${elapsedSeconds}s)`);
  console.log("✅ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return NextResponse.json(responseBody, { status: httpStatus });
}
