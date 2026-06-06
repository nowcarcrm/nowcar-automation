import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

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

/**
 * 시크릿 비교용 상수시간 문자열 비교.
 *
 * 평문 `===` 는 첫 불일치 바이트에서 단락되어 이론상 응답시간으로 시크릿을 한 바이트씩
 * 추정하는 타이밍 공격에 노출된다. CRON_SECRET 은 유료·발행 엔드포인트를 지키는 단일
 * 게이트이므로, 모든 검증 지점(여기 + cron/download + cron/cleanup)을 상수시간 비교로
 * 통일한다. 길이가 다르면 즉시 false(timingSafeEqual 은 동일 길이 버퍼를 요구).
 * 정답/오답에 대한 동작은 `===` 와 완전히 동일하므로 기존 인증 흐름을 깨지 않는다.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function isPipelineRequestAuthorized(req?: NextRequest): boolean {
  if (!req) return true; // 내부 함수 호출(서버 신뢰 경계) — 면제
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") ?? "";
  if (timingSafeStrEqual(authHeader, `Bearer ${secret}`)) return true;
  return timingSafeStrEqual(
    req.nextUrl.searchParams.get("secret") ?? "",
    secret,
  );
}
