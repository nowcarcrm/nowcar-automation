-- =========================================================
-- Nowcar Auto: system_alerts / system_tokens 스키마 명문화
-- 생성일: 2026-06-06
-- ---------------------------------------------------------
-- 배경: 이 두 테이블은 운영 DB 에 직접 생성돼 사용 중이지만 마이그레이션에는
-- 누락돼 있었다(버전관리 밖). DB 재구축/복원-from-migration 시 자동화 알림
-- cooldown(쿠키만료·카페999·헬스·Meta토큰)과 Meta 토큰 자동갱신이 조용히
-- 깨질 수 있다. 현재 코드가 실제 사용하는 컬럼을 IF NOT EXISTS 로 명문화한다.
--   - 기존 운영 DB: 테이블이 이미 있으므로 no-op(컬럼 변경 없음).
--   - 신규/복원 DB: 테이블 생성.
-- 운영 코드/스케줄에 영향 없음(이 파일은 운영자가 수동 적용, 자동 실행 아님).
-- =========================================================

-- ---------------------------------------------------------
-- system_alerts : 알림 cooldown/dedup 상태 (alert_type 별 1행)
--   공유 사용처: lib/youtube-bot-detect.ts, lib/naver-cafe-block.ts,
--               lib/pipeline-health.ts, lib/meta-token.ts (모두 onConflict: alert_type)
-- ---------------------------------------------------------
create table if not exists public.system_alerts (
  alert_type text primary key,
  last_sent_at timestamptz,
  last_message text,
  metadata jsonb default '{}'::jsonb
);

comment on table public.system_alerts is '운영 알림 cooldown/dedup 상태(alert_type 별 1행). 중복 알림 메일 방지용.';
comment on column public.system_alerts.alert_type is '알림 종류 키(pipeline_health / cookie_expired / cafe_blocked / meta_token_refresh_failed 등). upsert 충돌 키.';
comment on column public.system_alerts.last_sent_at is '마지막 알림 발송 시각. cooldown 비교 기준.';
comment on column public.system_alerts.last_message is '마지막 알림 요약 메시지.';
comment on column public.system_alerts.metadata is '부가 메타데이터(jsonb).';

-- ---------------------------------------------------------
-- system_tokens : 자동 갱신 토큰 저장 (token_type 별 1행)
--   사용처: lib/meta-token.ts (meta_user long-lived token), lib/pipeline-health.ts(만료 점검)
-- ---------------------------------------------------------
create table if not exists public.system_tokens (
  token_type text primary key,
  value text,
  refreshed_at timestamptz,
  expires_at timestamptz,
  metadata jsonb default '{}'::jsonb
);

comment on table public.system_tokens is '자동 갱신 대상 토큰(token_type 별 1행). 예: meta_user long-lived 토큰.';
comment on column public.system_tokens.token_type is '토큰 종류 키. upsert 충돌 키.';
comment on column public.system_tokens.value is '토큰 값.';
comment on column public.system_tokens.refreshed_at is '마지막 갱신 시각.';
comment on column public.system_tokens.expires_at is '만료 시각. 만료 14일 전부터 fb_exchange_token 자동 교환.';
comment on column public.system_tokens.metadata is '부가 메타데이터(jsonb). 예: { expires_in_seconds }. lib/meta-token.ts upsertTokenRow 가 기록.';

-- ---------------------------------------------------------
-- RLS: 운영 DB(2026-06-02 RLS 하드닝)와 동일하게 deny-by-default 로 켠다.
--   서버는 service_role 키로 접근하므로 RLS 를 우회한다 → 앱 동작 무영향.
--   정책을 만들지 않으므로 anon/authenticated 키로는 접근 불가(토큰/알림 보호).
--   이미 활성화돼 있으면 no-op.
-- ---------------------------------------------------------
alter table public.system_alerts enable row level security;
alter table public.system_tokens enable row level security;
