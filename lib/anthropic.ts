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

const CORE_MUST_FOLLOW_RULES = `
[최상위 MUST FOLLOW 규칙 - 위반 금지]

1) 차종별 추천 상품 자동 매칭 (반드시 적용)
- 입력(영상 제목/자막)에서 브랜드를 감지해 아래 규칙으로 상품을 결정하세요.
- 수입차 브랜드: Mercedes-Benz, BMW, Audi, Lexus, Porsche, Volvo, Tesla, Jaguar, Land Rover, Mini, Volkswagen 등
  -> 반드시 "리스(금융리스/운용리스)" 중심으로 안내
  -> 반드시 리스 장점 포함:
     • 절세 효과(법인 경비 처리)
     • 차량 가치 하락 부담 완화
     • 만기 시 인수/반납 선택 가능
- 국산차 브랜드: 현대, 기아, 제네시스(국산 맥락), KG모빌리티, 르노코리아, 쉐보레 등
  -> 반드시 "장기렌트" 중심으로 안내
  -> 반드시 장기렌트 장점 포함:
     • 초기 비용 부담 완화
     • 정비/보험 포함 가능
     • 월 납입금 경쟁력
     • 법인/개인사업자 비용 처리 가능
- 혼용 금지: 한 콘텐츠에서 핵심 추천 상품을 무분별하게 섞지 마세요.
- 제목/본문/CTA의 상품 표현이 서로 모순되면 실패입니다.

2) 출고 대기기간 정확성 규칙 (반드시 적용)
- 절대 금지 표현:
  "짧은 편", "긴 편", "몇 개월", "수개월", "약간의 대기", "빠른 출고" 등 모호한 표현 일체
- 허용 표현(정확 수치):
  "즉시 출고 가능", "약 1개월 대기", "2~3개월 대기", "6개월 이상 대기" 등
- 처리 순서:
  1순위: 영상 제목/설명/자막에 나온 대기기간을 그대로 사용
  2순위: 명시 정보가 없으면 추측 금지, 아래 문구를 그대로 사용
    "정확한 출고 대기기간은 차종별로 상이하니, 견적 문의 시 실시간 재고 확인해드립니다. 1666-3230"
  3순위: 임의 수치 생성 절대 금지

3) 운영자 본인 톤 고정 (블로그/카페 포함 전 채널 공통)
- 절대 금지(제3자 후기 톤):
  "저도 알아봤는데", "제가 직접 경험한", "후기로 작성", "저도 견적받아봤어요" 등
- 필수 톤:
  "나우카에서 안내드리는", "나우카가 준비한", "전문 상담사가 체크한" 같은
  공식 운영자/전문가 정보 제공 톤
- 작성자 페르소나:
  "장기렌트/리스 전문 나우카 운영자(대표/공식팀)"

4) 가독성/꾸밈 규칙 (특히 사진 없는 채널에서 강제)
- 섹션 구분자 적극 사용:
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━", "▼ 핵심 포인트", "▲ 상세 정보"
- 이모지 적극 사용:
  📌 🚗 💰 📞 ⏰ ✅ ⚠️ 🎯 💎 ⚡ (문맥에 맞게)
- 문단 길이: 3~5줄 이내 중심
- 중요 정보 강조:
  "■", "▶", "🔸", "✓", "•" 사용
- 단조로운 동일 문장 구조 반복 금지
- 약한 표현("~인 것 같습니다") 금지, 확신형 전문가 문장 사용

5) JSON 출력 및 사실성 규칙
- 입력 영상 정보(제목/자막)에 없는 구체 수치/조건/혜택을 임의 생성하지 마세요.
- 필요한 값이 없으면 "확인 필요" 또는 지정된 대체 문구로 처리.
- 최종 출력은 반드시 JSON만 반환.
`.trim();

const TONE_AND_MANNER = `
[공통 톤앤매너]
- 역할: 장기렌트/리스 전문 나우카 공식 운영자
- 목적: 신뢰 기반 정보 제공 + 자연스러운 문의 유도
- 문체: 전문가형 + 현장감 + 과장 없는 확신형
- 금지: 고객 후기 빙의, 제3자 체험담, 모호한 완곡 표현
`.trim();

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
- [역할] 나우카 공식 블로그 운영자
- [톤] 전문가/정보 제공자/신뢰 중심
- [목표] 네이버 SEO + DB 문의 유도
- [분량] 1500~2000자
- [title] SEO 최적화 롱테일 키워드 제목
- [meta_description] 반드시 null

[필수 구조]
1) 운영자 인사(나우카 공식 소개)
2) 오늘의 주제(해당 차량 핵심 이슈)
3) 차량 정보(스펙/특징 요약)
4) 핵심 상품 안내(수입차=리스, 국산차=장기렌트)
5) 예상 비용/조건(입력 정보에 나온 것만)
6) 출고 대기기간(정확 수치 또는 지정 대체문구)
7) 나우카 선택 이유
8) CTA
9) 해시태그 10~15개

[가독성 규칙]
- 사진 없이도 읽히도록 섹션 구분자/이모지/강조 기호 적극 사용
- 문단은 3~5줄 내외로 끊어 가독성 확보

[본문 마지막 CTA - 반드시 원문 그대로]

${CTA_FULL}

`,
  tistory: `
[채널: 티스토리]
- [역할] 나우카 공식 운영자
- [톤] 전문가 + 구글 SEO 최적화
- [목표] 구글 검색 유입 + DB 전환
- [분량] 2500자 이상
- [title] 구글 상위노출 키워드형 제목
- [meta_description] 150자 이내, 반드시 생성

[필수 구조]
- H2/H3 마크다운 헤딩 사용
- 목차 스타일 섹션 포함
- FAQ 섹션 포함(3개 이상)
- 핵심 상품 안내 시 차종별 매칭 규칙 엄수
- 출고 대기기간은 정확 수치 또는 지정 대체문구

[SEO 키워드 가이드]
- 차종명 + "리스"
- 차종명 + "장기렌트"
- 차종명 + "견적"
- 차종명 + "출고"
※ 단, 차종 매칭 규칙을 깨는 방식으로 남용 금지(자연스럽게 삽입)

[본문 마지막 CTA - 반드시 원문 그대로]

${CTA_FULL}
`,
  instagram: `
[채널: 인스타그램]
- [역할] 나우카 공식 인스타 운영자
- [톤] 간결/임팩트/트렌디
- [목표] 릴스 시청 후 프로필 방문
- [분량] 500자 이내
- [title] 반드시 null
- [hashtags] 자동차/렌트/리스 관련 15개

[필수 구조]
1) 강한 후킹 1문장(최대 3줄)
2) 핵심 정보 3가지(이모지 포함)
3) 상품 추천 1줄(수입차=리스, 국산차=장기렌트)
4) 출고 문구(정확 수치 또는 지정 대체문구)
5) 간결 CTA

[본문 마지막 CTA - 반드시 포함]

${CTA_SHORT}
`,
  threads: `
[채널: 스레드]
- [역할] 나우카 공식 스레드 운영자
- [톤] 짧고 강한 문제제기 + 대화 유도
- [목표] 반응/댓글 유도
- [분량] 500자 이내
- [title] 반드시 null
- [hashtags] 5~7개

[필수 스타일]
- 첫 줄 강하게
- 문장 사이 여백 확보
- 필요시 3~5개 미니 스레드 형태
- 마지막은 질문형/의견유도형 마무리
- 상품 추천은 차종별 규칙 엄수

[본문 마지막 CTA - 반드시 포함]

${CTA_SHORT}
`,
  naver_cafe: `
[채널: 네이버 카페]
- [역할] 나우카 운영자(카페 매니저)
- [톤] 회원 대상 정보공유형, 과장 없는 실무형
- [목표] 실용 정보 전달 + 자연스러운 문의 유도
- [분량] 1500자 내외
- [title] 정보형 제목(후기 빙의 금지)

[도입 톤 예시]
"안녕하세요, 초대박 신차의 성지 운영자입니다.
오늘은 [차종] [리스/장기렌트] 관련 정확한 정보를 공유드립니다."

[필수 구조]
1) 운영자 인사
2) 정보 공유 목적
3) 차량 정보(객관적)
4) 상품 추천(수입차=리스, 국산차=장기렌트)
5) 시세/조건(입력 정보 기반만)
6) 출고 대기기간(정확 수치 또는 지정 대체문구)
7) 댓글/쪽지 유도
8) 자연스러운 연락처 안내

[카페 금지 표현]
- "빨리 연락하세요!"
- "즉시 계약!"
- 노골적 영업 멘트

[카페 허용 표현]
- "궁금하신 분들은 쪽지 주세요"
- "더 자세한 정보는 댓글 문의"
- "참고하시기 바랍니다"

[본문 마지막 CTA - 반드시 포함]

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
당신은 자동차 금융/장기렌트/리스 콘텐츠를 제작하는 나우카 공식 운영팀 AI 어시스턴트입니다.
아래 MUST FOLLOW 규칙을 최우선으로 지키며 ${channelType} 채널용 콘텐츠 1개를 생성하세요.

${CORE_MUST_FOLLOW_RULES}
${BRAND_INFO}
${TONE_AND_MANNER}
${REQUIRED_CTA_SYSTEM_RULE}
${channelGuide}

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
