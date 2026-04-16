import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import { supabase } from "@/lib/supabase";
import { getLatestVideos } from "@/lib/youtube";

type ServiceStatus = "ok" | "error";
type OverallStatus = "healthy" | "partial" | "failed";

interface EnvVarDetails {
  YOUTUBE_API_KEY: "OK" | "MISSING";
  YOUTUBE_CHANNEL_ID: "OK" | "MISSING";
  ANTHROPIC_API_KEY: "OK" | "MISSING";
  NEXT_PUBLIC_SUPABASE_URL: "OK" | "MISSING";
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "OK" | "MISSING";
  EMAIL_USER: "OK" | "MISSING";
  EMAIL_PASS: "OK" | "MISSING";
}

interface EnvResult {
  status: ServiceStatus;
  message: string;
  details: EnvVarDetails;
}

interface ServiceResult {
  status: ServiceStatus;
  message: string;
}

interface TestResponse {
  timestamp: string;
  overall_status: OverallStatus;
  results: {
    env_vars: EnvResult;
    supabase: ServiceResult;
    youtube: ServiceResult;
    claude: ServiceResult;
    gmail: ServiceResult;
  };
}

function getEnvStatus(name: keyof EnvVarDetails): "OK" | "MISSING" {
  return process.env[name] ? "OK" : "MISSING";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

const CLAUDE_MODEL = "claude-sonnet-4-6";

export async function GET() {
  const envDetails: EnvVarDetails = {
    YOUTUBE_API_KEY: getEnvStatus("YOUTUBE_API_KEY"),
    YOUTUBE_CHANNEL_ID: getEnvStatus("YOUTUBE_CHANNEL_ID"),
    ANTHROPIC_API_KEY: getEnvStatus("ANTHROPIC_API_KEY"),
    NEXT_PUBLIC_SUPABASE_URL: getEnvStatus("NEXT_PUBLIC_SUPABASE_URL"),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: getEnvStatus("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    EMAIL_USER: getEnvStatus("EMAIL_USER"),
    EMAIL_PASS: getEnvStatus("EMAIL_PASS"),
  };

  const missingCount = Object.values(envDetails).filter(
    (value) => value === "MISSING",
  ).length;

  const envResult: EnvResult =
    missingCount === 0
      ? {
          status: "ok",
          message: "환경변수 확인 완료: 필수 7개 항목이 모두 설정되어 있습니다.",
          details: envDetails,
        }
      : {
          status: "error",
          message: `환경변수 확인 결과: ${missingCount}개 항목이 비어 있습니다. .env.local 값을 확인해주세요.`,
          details: envDetails,
        };

  const supabaseResult: ServiceResult = {
    status: "error",
    message: "Supabase 테스트를 실행하지 못했습니다.",
  };
  const youtubeResult: ServiceResult = {
    status: "error",
    message: "YouTube API 테스트를 실행하지 못했습니다.",
  };
  const claudeResult: ServiceResult = {
    status: "error",
    message: "Claude API 테스트를 실행하지 못했습니다.",
  };
  const gmailResult: ServiceResult = {
    status: "error",
    message: "Gmail SMTP 테스트를 실행하지 못했습니다.",
  };

  // 2) Supabase 연결 테스트
  try {
    const { count, error } = await supabase
      .from("youtube_videos")
      .select("*", { count: "exact", head: true });

    if (error) {
      throw error;
    }

    supabaseResult.status = "ok";
    supabaseResult.message = `연결 OK, 현재 저장된 영상 수: ${count ?? 0}`;
  } catch (error) {
    supabaseResult.status = "error";
    supabaseResult.message = `Supabase 연결 실패: ${toErrorMessage(error)}`;
  }

  // 3) YouTube API 테스트
  try {
    const latestVideos = await getLatestVideos(1);
    if (latestVideos.length === 0) {
      youtubeResult.status = "ok";
      youtubeResult.message =
        "나우카 채널 연결은 정상입니다. 다만 조회된 최신 영상이 없습니다.";
    } else {
      youtubeResult.status = "ok";
      youtubeResult.message = `나우카 채널 확인 OK, 최근 영상 제목: ${latestVideos[0].title}`;
    }
  } catch (error) {
    youtubeResult.status = "error";
    youtubeResult.message = `YouTube API 연결 실패: ${toErrorMessage(error)}`;
  }

  // 4) Claude API 테스트 (저비용 단문 테스트)
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY가 비어 있습니다.");
    }

    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 50,
      temperature: 0,
      messages: [
        {
          role: "user",
          content:
            "안녕하세요, 연결 테스트입니다 라고만 간단히 답변해줘. 다른 말은 하지 마.",
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();

    claudeResult.status = "ok";
    claudeResult.message = `Claude API 연결 OK (${CLAUDE_MODEL}), 응답: ${text || "(빈 응답)"}`;
  } catch (error) {
    claudeResult.status = "error";
    claudeResult.message = `Claude API 연결 실패: ${toErrorMessage(error)}`;
  }

  // 5) Gmail SMTP 테스트 (verify만 수행, 실제 발송 없음)
  try {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
      throw new Error("EMAIL_USER 또는 EMAIL_PASS가 비어 있습니다.");
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });

    await transporter.verify();
    gmailResult.status = "ok";
    gmailResult.message = "Gmail SMTP 연결 OK";
  } catch (error) {
    gmailResult.status = "error";
    gmailResult.message = `Gmail SMTP 연결 실패: ${toErrorMessage(error)}`;
  }

  const serviceStatuses: ServiceStatus[] = [
    envResult.status,
    supabaseResult.status,
    youtubeResult.status,
    claudeResult.status,
    gmailResult.status,
  ];
  const okCount = serviceStatuses.filter((status) => status === "ok").length;

  const overallStatus: OverallStatus =
    okCount === serviceStatuses.length
      ? "healthy"
      : okCount === 0
        ? "failed"
        : "partial";

  const responseBody: TestResponse = {
    timestamp: new Date().toISOString(),
    overall_status: overallStatus,
    results: {
      env_vars: envResult,
      supabase: supabaseResult,
      youtube: youtubeResult,
      claude: claudeResult,
      gmail: gmailResult,
    },
  };

  return NextResponse.json(responseBody);
}
