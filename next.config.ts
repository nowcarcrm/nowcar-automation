import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TypeScript 에러가 있어도 빌드 진행
  typescript: {
    ignoreBuildErrors: true,
  },
  // ESLint 에러가 있어도 빌드 진행
  eslint: {
    ignoreDuringBuilds: true,
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
};

export default nextConfig;
