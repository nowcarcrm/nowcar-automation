import Anthropic from "@anthropic-ai/sdk";
import type { ChannelType } from "./supabase";
import { NOWCAR_INFO, CTA_FULL, CTA_SHORT, CTA_CAFE } from "./constants";

export interface GeneratedDraft {
  channel_type: ChannelType;
  title: string | null;
  body: string;
  hashtags: string | null;
  meta_description: string | null;
}

export interface GeneratedDraftWithUsage {
  draft: GeneratedDraft;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

const MODEL = "claude-sonnet-4-6";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[anthropic] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

const anthropic = new Anthropic({
  apiKey: requireEnv("ANTHROPIC_API_KEY"),
});

const BRAND_INFO = `
[브랜드 정보]
- 회사명: ${NOWCAR_INFO.companyName}
- 사업: ${NOWCAR_INFO.business} (중고차 아님)
- 차별점: ${NOWCAR_INFO.uniqueValue}
- 대표전화: ${NOWCAR_INFO.phone}
- 카카오톡 채널: ${NOWCAR_INFO.kakaoChannel}
- 홈페이지: ${NOWCAR_INFO.website}
- 유튜브: ${NOWCAR_INFO.youtube} (검색 키워드: ${NOWCAR_INFO.youtubeSearchKeyword})
- 네이버 카페: ${NOWCAR_INFO.naverCafeName} (${NOWCAR_INFO.naverCafe})
`;

const TONE_AND_MANNER = `
[공통 톤앤매너]
- 광고 같지 않지만 결과적으로 문의가 오게 만들 것
- 구조: 불안 자극 -> 문제 제기 -> 분석 -> 해결 -> CTA
- 대표/업계 전문가 톤
- 너무 딱딱하지 않고 현장감 있게 작성
- "지금 이걸 모르면 손해", "요즘 반응이 갈리는 이유" 같은 감정 자극 허용
- "안녕하세요 오늘은" 같은 평범한 도입 문장 금지
- 실전 영업 현장 감각이 느껴지는 표현 사용
`;

const REQUIRED_CTA_SYSTEM_RULE = `
본문 작성 후 반드시 아래 5가지 채널 정보를 모두 포함해야 합니다.
어느 하나도 누락되면 안 됩니다:

📞 견적 상담: 1666-3230
💬 카카오톡 채널 '나우카' 검색
🌐 홈페이지: www.나우카.com
🎬 유튜브: '나우카' 검색
☕ 네이버 카페: '초대박신차의성지'

이 5가지는 모든 채널의 필수 요소입니다.
`.trim();

const CHANNEL_PROMPTS: Record<ChannelType, string> = {
  naver_blog: `
[채널: 네이버 블로그]
- 분량: 1500~2000자
- title: SEO 최적화 롱테일 키워드 제목
- 네이버 C-Rank를 고려해 전문성과 실제 사례 느낌을 강화
- ⚠️ 절대 지켜야 할 규칙:
본문 마지막에 반드시 아래 CTA를 그대로 포함하세요. 
생략하거나 축약하면 안 됩니다.

${CTA_FULL}

이 CTA는 필수이며, 누락되면 콘텐츠가 잘못된 것으로 간주됩니다.
- meta_description은 반드시 null
`,
  tistory: `
[채널: 티스토리]
- 분량: 2500자 이상
- 네이버 블로그 결과물과 문체/표현/흐름이 완전히 다르게 작성
- H2/H3 구조의 마크다운 문법 사용
- 더 분석적이고 논리적인 톤으로 작성
- title: 구글 상위노출을 노린 키워드 조합
- meta_description: 150자 이내
- ⚠️ 반드시 본문 마지막에 아래 CTA를 포함하세요:

${CTA_FULL}

누락 금지, 축약 금지.
`,
  instagram: `
[채널: 인스타그램]
- 500자 이내
- title은 반드시 null
- 첫 3줄은 강한 후킹으로 구성(모바일 더보기 유도)
- hashtags는 자동차/렌트/리스 관련 15개 생성
- ⚠️ 본문 끝에 반드시 아래 내용을 포함:

${CTA_SHORT}
`,
  threads: `
[채널: 스레드]
- 500자 이내
- title은 반드시 null
- 더 캐주얼하고 날카로운 톤
- 강한 후킹 + 짧은 본문 + 간접 CTA("아시는 분은 아실 듯")
- hashtags는 5~7개
- ⚠️ 본문 끝에 반드시 아래 내용을 포함:

${CTA_SHORT}
`,
  naver_cafe: `
[채널: 네이버 카페]
- 1500자 내외
- title: 경험담 스타일 제목
- 경험담/정보공유 톤(광고 티 최소화)
- "최근에 알아보다가", "업체 여러 곳 비교해봤는데" 같은 자연스러운 접근
- 자동차/재테크 카페 분위기의 반말/존댓말 섞인 말투 허용
- ⚠️ 네이버 카페 규칙:
- 영업 멘트 금지 (연락주세요, 상담받아보세요 등 X)
- 정보 공유/경험담 톤 유지
- 본문 마지막에 반드시 아래 내용을 포함:

${CTA_CAFE}
`,
};

const CHANNEL_MAX_TOKENS: Record<ChannelType, number> = {
  naver_blog: 4000,
  tistory: 4500,
  instagram: 900,
  threads: 900,
  naver_cafe: 3200,
};

function buildPrompt(
  videoTranscript: string,
  videoTitle: string,
  channelType: ChannelType,
): string {
  const channelGuide = CHANNEL_PROMPTS[channelType];

  return `
당신은 자동차 금융/장기렌트 시장을 오래 다룬 콘텐츠 전략가입니다.
아래 정보를 바탕으로 ${channelType} 채널용 콘텐츠 1개를 생성하세요.

${BRAND_INFO}
${TONE_AND_MANNER}
${REQUIRED_CTA_SYSTEM_RULE}
${channelGuide}

[공통 CTA 원문(필수 정보 확인용)]
${CTA_FULL}

[입력 영상 정보]
- 영상 제목: ${videoTitle}
- 영상 자막:
${videoTranscript}

[출력 규칙]
- 아래 JSON 형식만 출력하고, 설명 문장/마크다운 코드블록은 절대 출력하지 마세요.
- title/body/hashtags/meta_description 키를 반드시 포함하세요.
- 채널에 필요 없는 값은 null로 반환하세요.

{
  "title": "string 또는 null",
  "body": "string",
  "hashtags": "string 또는 null",
  "meta_description": "string 또는 null"
}
`.trim();
}

function extractTextFromResponse(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function safeJsonParse(rawText: string): {
  title: string | null;
  body: string;
  hashtags: string | null;
  meta_description: string | null;
} {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as {
    title?: unknown;
    body?: unknown;
    hashtags?: unknown;
    meta_description?: unknown;
  };

  if (typeof parsed.body !== "string" || parsed.body.trim().length === 0) {
    throw new Error("body 필드가 비어 있습니다.");
  }

  return {
    title: typeof parsed.title === "string" ? parsed.title : null,
    body: parsed.body,
    hashtags: typeof parsed.hashtags === "string" ? parsed.hashtags : null,
    meta_description:
      typeof parsed.meta_description === "string" ? parsed.meta_description : null,
  };
}

export async function generateContent(
  videoTranscript: string,
  videoTitle: string,
  channelType: ChannelType,
): Promise<GeneratedDraft> {
  const { draft } = await generateContentWithUsage(
    videoTranscript,
    videoTitle,
    channelType,
  );
  return draft;
}

export async function generateContentWithUsage(
  videoTranscript: string,
  videoTitle: string,
  channelType: ChannelType,
): Promise<GeneratedDraftWithUsage> {
  try {
    const prompt = buildPrompt(videoTranscript, videoTitle, channelType);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: CHANNEL_MAX_TOKENS[channelType],
      temperature: 0.8,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const rawText = extractTextFromResponse(response);
    const parsed = safeJsonParse(rawText);

    return {
      draft: {
        channel_type: channelType,
        title: parsed.title,
        body: parsed.body,
        hashtags: parsed.hashtags,
        meta_description: parsed.meta_description,
      },
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[anthropic] ${channelType} 콘텐츠 생성 실패: ${message}`);
  }
}

export async function generateAllContents(
  videoTranscript: string,
  videoTitle: string,
): Promise<GeneratedDraft[]> {
  const channelTypes: ChannelType[] = [
    "naver_blog",
    "tistory",
    "instagram",
    "threads",
    "naver_cafe",
  ];

  return Promise.all(
    channelTypes.map((channelType) =>
      generateContent(videoTranscript, videoTitle, channelType),
    ),
  );
}
