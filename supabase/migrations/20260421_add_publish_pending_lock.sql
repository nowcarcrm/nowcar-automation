-- =========================================================
-- social_publishes race-condition lock migration
-- 실행 전 안내:
--   1) "중복 정리 SQL"을 먼저 실행해 (video_id, platform) 중복을 soft delete 처리
--   2) 이 마이그레이션 SQL을 실행
-- =========================================================

-- 1) updated_at 컬럼 보강 (TTL 기준 시각)
alter table if exists public.social_publishes
  add column if not exists updated_at timestamptz not null default now();

update public.social_publishes
set updated_at = coalesce(updated_at, created_at, now())
where updated_at is null;

-- 2) status 체크 제약 보강 (pending/success/failed)
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint pc
    join pg_class t on pc.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'social_publishes'
      and pc.contype = 'c'
      and pg_get_constraintdef(pc.oid) ilike '%status%'
  loop
    execute format('alter table public.social_publishes drop constraint if exists %I', c.conname);
  end loop;
end $$;

alter table public.social_publishes
  add constraint social_publishes_status_check
  check (status in ('pending', 'success', 'failed'));

-- 3) active row unique 보장 (soft delete 제외)
create unique index if not exists ux_social_publishes_video_platform_active
  on public.social_publishes (video_id, platform)
  where deleted_at is null;

