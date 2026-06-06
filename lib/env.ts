/**
 * ============================================================
 * lib/env.ts
 * ------------------------------------------------------------
 * 환경변수 정수 파서의 단일 출처.
 *
 * 코드베이스 곳곳(video-recency.ts, download-grace.ts, publish-meta.ts 등)에
 * "env 읽고 NaN/미설정/<=0 이면 기본값" 로직이 미묘하게 다른 규칙으로 중복돼 있다.
 * 신규 사용처는 이 헬퍼로 통일한다. 기존 파서는 동작 동일성이 확인된 뒤 점진적으로
 * 이전한다(이번 변경은 신규 사용처에만 적용 — 기존 동작은 건드리지 않음).
 *
 * 규칙(기본):
 *   - 미설정 / 공백 / 숫자 아님(NaN) → fallback
 *   - 0 이하 → fallback (allowZero 로 0 허용 가능)
 *   - 정수화(floor) 기본 적용, floor:false 로 소수 허용
 * ============================================================
 */
export function envInt(
  name: string,
  fallback: number,
  opts: { floor?: boolean; allowZero?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;

  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;

  if (opts.allowZero) {
    if (n < 0) return fallback;
  } else if (n <= 0) {
    return fallback;
  }

  return opts.floor === false ? n : Math.floor(n);
}
