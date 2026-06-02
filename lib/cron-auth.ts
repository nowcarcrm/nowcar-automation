import type { NextRequest } from "next/server";

/**
 * ============================================================
 * lib/cron-auth.ts
 * ------------------------------------------------------------
 * 파이프라인/생성 HTTP 엔드포인트 인증(감사 C-1/C-2/M-5).
 *
 * 배경: /api/pipeline/run, /api/content/generate, /api/test 가 인증 없이
 * 누구나 호출 가능해 무제한 Claude/Whisper 비용·무단 발행·정보노출 위험이 있었다.
 *
 * 두 가지 호출 경로를 구분한다:
 *  - 내부 호출: 서버 모듈(lib/pipeline/*)이 route 의 GET 을 직접 import 해 인자 없이
 *    호출한다. 이때 req 가 undefined 이므로 면제한다(이미 서버 내부 신뢰 경계).
 *  - HTTP 직접 호출: req 가 있으므로 CRON_SECRET 을 요구한다.
 *    Authorization: Bearer <secret> 또는 ?secret=<secret>.
 *    CRON_SECRET 미설정 시 외부 호출을 보수적으로 차단한다.
 * ============================================================
 */
export function isPipelineRequestAuthorized(req?: NextRequest): boolean {
  if (!req) return true; // 내부 함수 호출(서버 신뢰 경계) — 면제
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}
