-- generated_contents.status 허용값에 cta_incomplete 추가
alter table public.generated_contents
  drop constraint if exists generated_contents_status_check;

alter table public.generated_contents
  add constraint generated_contents_status_check
  check (status in ('pending', 'approved', 'published', 'failed', 'cta_incomplete'));
