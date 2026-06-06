import type { NextConfig } from "next";

// 전 응답에 적용할 기본 보안 헤더(DEPS-3).
// 순수 가산 설정 — 인증/크론/발행 경로의 동작을 바꾸지 않는다. CSP 는 의도적으로 제외:
// 대시보드가 inline 스타일을 쓰므로 잘못된 CSP 가 화면을 깨뜨릴 수 있어 별도 검토 후 추가.
const SECURITY_HEADERS = [
  // HTTPS 강제(2년, 서브도메인 포함). Vercel 은 항상 HTTPS 이므로 안전.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Content-Type 스니핑 차단(공개 temp-videos mp4 가 다른 타입으로 해석되는 것 방지).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 클릭재킹 방지 — 이 앱을 iframe 으로 띄울 정당한 이유가 없음.
  { key: "X-Frame-Options", value: "DENY" },
  // 외부 이동 시 전체 URL referrer 유출 축소(?secret= 같은 쿼리 유출 방지에도 기여).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // 불필요한 브라우저 기능 전면 차단.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // 서버 기술 스택 노출 축소.
  poweredByHeader: false,
  // TypeScript 에러가 있어도 빌드 진행
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: true,
  // 유튜브 썸네일 외부 이미지 허용
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "i.ytimg.com",
      },
      {
        protocol: "https",
        hostname: "img.youtube.com",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
