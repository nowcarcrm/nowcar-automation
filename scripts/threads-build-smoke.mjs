function stripThreadsDecorations(text) {
  return text
    .replace(/[\p{Extended_Pictographic}‍︎️\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[─-╿]/g, "")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCtaLinesFromEnd(text) {
  const ctaPatterns = [
    /1666[\s-]?3230/,
    /www\.나우카\.com|나우카\.com/,
    /카톡[^\n]*나우카/,
    /유튜브[^\n]*나우카/,
    /네이버\s*카페|초대박신차의성지/,
  ];
  const lines = text.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === "") { lines.pop(); continue; }
    if (ctaPatterns.some((re) => re.test(last))) { lines.pop(); continue; }
    break;
  }
  return lines.join("\n").trimEnd();
}

function buildThreadsCaption(body, hashtags) {
  void hashtags;
  const TH_MAX = 500;
  const stripped = stripThreadsDecorations(body);
  const withoutCta = stripCtaLinesFromEnd(stripped).trim();
  return withoutCta.length <= TH_MAX
    ? withoutCta
    : withoutCta.slice(0, TH_MAX).trimEnd();
}

const sampleBody = `2026 전기차 보조금, 바뀐다고요?
그럼 지금 타이밍이 핵심입니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ 보조금 정책 변경 전 즉시출고 가능 차량
나우카에서 지금 바로 확인하세요.

📌 전기차 장기렌트 핵심 체크포인트
✅ 즉시출고 가능 재고 보유량 1위
✅ 보조금 적용 조건 실시간 확인
✅ 초기 비용 부담 없이 월 납입금으로 해결

━━━━━━━━━━━━━━━━━━━━━━━━━━━

여러분은 2026 보조금 변경 소식 들으셨나요?
어떤 전기차 고민 중이신지 댓글로 알려주세요 👇

📞 1666-3230
💬 카톡 '나우카'
🌐 www.나우카.com
🎬 유튜브 '나우카'
☕ 네이버카페 '초대박신차의성지'`;

console.log("=== CASE 1: 실데이터 ===");
const out1 = buildThreadsCaption(sampleBody, "#hashtag");
console.log(out1);
console.log("--- checks ---");
console.log("len=" + out1.length + " (max 500)");
console.log("no footer (no homepage at end): " + !out1.endsWith("www.나우카.com"));
console.log("no cafe URL: " + !out1.includes("https://cafe.naver.com/fktkaus"));
console.log("no leftover ⚡: " + !out1.includes("⚡"));
console.log("no leftover ━: " + !out1.includes("━"));
console.log("no leftover #: " + !out1.includes("#"));
console.log("no leftover 1666-3230: " + !out1.includes("1666-3230"));
console.log("no leftover 카톡 '나우카': " + !out1.includes("카톡 '나우카'"));
console.log("no leftover 초대박신차의성지: " + !out1.includes("초대박신차의성지"));
console.log("question line 보존(댓글로 알려주세요): " + out1.includes("댓글로 알려주세요"));

console.log("\n=== CASE 2: 짧은 본문 ===");
const out2 = buildThreadsCaption("짧은 본문입니다.", null);
console.log(JSON.stringify(out2));
console.log("len=" + out2.length);
console.log("body 그대로: " + (out2 === "짧은 본문입니다."));

console.log("\n=== CASE 3: 빈 본문 ===");
const out3 = buildThreadsCaption("", null);
console.log(JSON.stringify(out3));
console.log("len=" + out3.length);
console.log("empty: " + (out3 === ""));

console.log("\n=== CASE 4: 매우 긴 본문 (500자 컷) ===");
const longBody = "긴본문 ".repeat(200);
const out4 = buildThreadsCaption(longBody, null);
console.log("len=" + out4.length + " (max 500)");
console.log("len <= 500: " + (out4.length <= 500));
