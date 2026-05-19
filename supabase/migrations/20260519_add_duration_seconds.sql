-- =========================================================
-- youtube_videos.duration_seconds 컬럼 추가
-- ---------------------------------------------------------
-- 배경:
--   2026-05-18 업로드된 가로영상(cWm1hSoopIs, 540초)이
--   인스타 Reels 90초 컨테이너 한도를 초과해 매 10분 발행
--   재시도 + 메일 알람이 발생.
-- 목적:
--   영상 길이를 메타데이터로 저장해 IG/FB 자동 발행 시
--   너무 긴 영상은 SQL 단계에서 미리 제외한다.
-- =========================================================

alter table public.youtube_videos
  add column if not exists duration_seconds integer;

create index if not exists idx_youtube_videos_duration_seconds
  on public.youtube_videos (duration_seconds);

comment on column public.youtube_videos.duration_seconds is
  '유튜브 영상 길이(초). IG Reels/FB 자동 발행 시 짧은-폼 한도 게이트에 사용. NULL이면 미수집(레거시).';
