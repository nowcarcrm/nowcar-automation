-- generated_contents.email_sent 기본값 및 기존 데이터 보정
alter table public.generated_contents
  alter column email_sent set default false;

-- 이미 생성된 pending 콘텐츠가 true로 잘못 들어간 경우 발송 대기 상태로 복구
update public.generated_contents
set email_sent = false
where status = 'pending'
  and email_sent = true;
