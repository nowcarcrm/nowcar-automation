-- youtube_videos: 마지막 다운로드 실패 사유를 영구 보존하기 위한 컬럼
-- 생성일: 2026-05-11
--
-- 배경:
--   download_error 는 다운로드 성공 시 NULL 로 클리어되어, Vercel Hobby 의
--   1시간 로그 보존과 합쳐지면 주말 다운로드 실패의 원인 추적이 불가능했다.
--   last_download_error / _at 은 성공해도 보존하여 사후 진단을 가능케 한다.

alter table public.youtube_videos
  add column if not exists last_download_error text,
  add column if not exists last_download_error_at timestamptz;
