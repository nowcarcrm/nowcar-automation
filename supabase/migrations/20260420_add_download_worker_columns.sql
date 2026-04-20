-- youtube_videos: 로컬 다운로드 워커 지원 컬럼 추가
-- 생성일: 2026-04-20

alter table public.youtube_videos
  add column if not exists storage_path text,
  add column if not exists downloaded_at timestamptz,
  add column if not exists download_attempts integer not null default 0,
  add column if not exists download_error text;

create index if not exists idx_youtube_videos_download_queue
  on public.youtube_videos (processed, storage_path, download_attempts)
  where processed = false and storage_path is null;
