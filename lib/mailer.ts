import nodemailer from "nodemailer";
import { marked } from "marked";
import type { ChannelType, GeneratedContent } from "./supabase";

export interface EmailContentItem {
  id?: string;
  channel_type: ChannelType;
  title: string | null;
  body: string;
  hashtags: string | null;
  meta_description: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[mailer] 환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

const emailUser = requireEnv("EMAIL_USER");
const emailPass = requireEnv("EMAIL_PASS");
const tistoryEmail = process.env.TISTORY_EMAIL ?? "";
const autoPublishTistory = process.env.AUTO_PUBLISH_TISTORY === "true";

// Gmail SMTP 전송기
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: emailUser,
    pass: emailPass,
  },
});

const CHANNEL_ORDER: ChannelType[] = [
  "naver_blog",
  "tistory",
  "instagram",
  "threads",
  "naver_cafe",
];

const CHANNEL_META: Record<
  ChannelType,
  { emoji: string; label: string; subtitle: string; bg: string; border: string }
> = {
  naver_blog: {
    emoji: "📝",
    label: "네이버 블로그용",
    subtitle: "1,xxx자",
    bg: "#ecfdf3",
    border: "#22c55e",
  },
  tistory: {
    emoji: "📝",
    label: "티스토리용",
    subtitle: "2,xxx자, 구글 SEO",
    bg: "#fefce8",
    border: "#eab308",
  },
  instagram: {
    emoji: "📱",
    label: "인스타그램 캡션",
    subtitle: "",
    bg: "#fdf2f8",
    border: "#ec4899",
  },
  threads: {
    emoji: "💬",
    label: "스레드",
    subtitle: "",
    bg: "#f3f4f6",
    border: "#4b5563",
  },
  naver_cafe: {
    emoji: "💬",
    label: "네이버 카페용",
    subtitle: "",
    bg: "#f7fee7",
    border: "#84cc16",
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDivider(): string {
  return `<hr style="border:none;border-top:1px solid #d1d5db;margin:18px 0;" />`;
}

function renderContentSection(index: number, content: EmailContentItem): string {
  const meta = CHANNEL_META[content.channel_type];
  const titlePart = content.title
    ? `<p style="margin:6px 0 0 0;"><b>제목:</b> ${escapeHtml(content.title)}</p>`
    : "";
  const metaPart = content.meta_description
    ? `<p style="margin:6px 0 0 0;"><b>메타 설명:</b> ${escapeHtml(content.meta_description)}</p>`
    : "";
  const hashtagPart = content.hashtags
    ? `<p style="margin:6px 0 0 0;"><b>해시태그:</b> ${escapeHtml(content.hashtags)}</p>`
    : "";
  const lengthLabel = `${content.body.length.toLocaleString()}자`;
  const subtitle = meta.subtitle ? `${lengthLabel}, ${meta.subtitle}` : lengthLabel;

  return `
    ${renderDivider()}
    <section style="margin:16px 0;padding:16px;border:1px solid ${meta.border};border-radius:12px;background:${meta.bg};">
      <h2 style="margin:0;font-size:18px;">
        ${meta.emoji} ${index}. ${meta.label} ${subtitle ? `(${escapeHtml(subtitle)})` : ""}
      </h2>
      ${titlePart}
      ${metaPart}
      ${hashtagPart}
      <pre style="margin-top:12px;padding:12px;border-radius:8px;background:#ffffff;white-space:pre-wrap;word-break:break-word;font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.5;">${escapeHtml(content.body)}</pre>
      <p style="margin:8px 0 0 0;color:#374151;font-size:12px;">📋 길게 눌러 복사해서 바로 사용하세요.</p>
    </section>
  `;
}

export async function sendContentEmail(
  videoTitle: string,
  videoUrl: string,
  contents: EmailContentItem[],
  thumbnailUrl?: string | null,
): Promise<void> {
  try {
    const contentMap = new Map(contents.map((item) => [item.channel_type, item]));
    const orderedContents = CHANNEL_ORDER.map((type) => contentMap.get(type)).filter(
      (item): item is EmailContentItem => Boolean(item),
    );

    const html = `
      <div style="max-width:900px;margin:0 auto;padding:24px;color:#111827;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;">
        <div style="border:1px solid #d1d5db;border-radius:12px;padding:18px;background:#ffffff;">
          <h1 style="margin:0 0 8px 0;font-size:22px;">🎬 나우카 콘텐츠 자동화 시스템</h1>
          ${renderDivider()}
          <h2 style="margin:0 0 8px 0;font-size:18px;">📺 원본 영상</h2>
          <p style="margin:0 0 4px 0;"><b>제목:</b> ${escapeHtml(videoTitle)}</p>
          <p style="margin:0 0 4px 0;">
            <b>링크:</b>
            <a href="${escapeHtml(videoUrl)}" target="_blank" rel="noreferrer">${escapeHtml(videoUrl)}</a>
          </p>
          ${
            thumbnailUrl
              ? `<img src="${escapeHtml(thumbnailUrl)}" alt="썸네일" style="margin-top:10px;width:100%;max-width:420px;border-radius:10px;border:1px solid #e5e7eb;" />`
              : ""
          }

          ${orderedContents
            .map((content, idx) => renderContentSection(idx + 1, content))
            .join("\n")}

          ${renderDivider()}
          <h3 style="margin:0 0 8px 0;font-size:17px;">✅ 발행 체크리스트</h3>
          <p style="margin:0;line-height:1.8;">
            □ 네이버 블로그 → nowcar.blog.me 에 업로드<br />
            □ 티스토리 → nowcarautomation.tistory.com 에 업로드<br />
            □ 인스타그램 → 릴스로 업로드 + 캡션 붙여넣기<br />
            □ 스레드 → 복사 붙여넣기 발행<br />
            □ 네이버 카페 → 관련 카페에 게시
          </p>
          ${renderDivider()}
          <p style="margin:0;color:#374151;">💡 팁: 모바일에서 각 섹션별로 "길게 눌러 복사" 하시면 편합니다.</p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"Nowcar Auto" <${emailUser}>`,
      to: emailUser,
      subject: `[나우카 자동화] 신규 콘텐츠 5종 - ${videoTitle}`,
      html,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[mailer] 이메일 발송 실패: ${message}`);
  }
}

export async function sendToTistory(content: GeneratedContent): Promise<void> {
  if (!autoPublishTistory) {
    throw new Error(
      "[mailer] AUTO_PUBLISH_TISTORY가 true가 아니어서 티스토리 발행을 건너뜁니다.",
    );
  }

  if (!tistoryEmail) {
    throw new Error("[mailer] TISTORY_EMAIL 환경변수가 설정되지 않았습니다.");
  }

  const subject = content.title?.trim() || "나우카 티스토리 자동 발행 콘텐츠";
  const htmlBody = marked.parse(content.body) as string;

  const html = `
    <div style="max-width:900px;margin:0 auto;padding:16px;font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;">
      <h1 style="font-size:22px;margin-bottom:8px;">${escapeHtml(subject)}</h1>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />
      <div>${htmlBody}</div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Nowcar Auto" <${emailUser}>`,
      to: tistoryEmail,
      subject,
      html,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    throw new Error(`[mailer] 티스토리 이메일 발송 실패: ${message}`);
  }
}
