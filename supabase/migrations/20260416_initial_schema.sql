-- =========================================================
-- Nowcar Auto: Initial Schema
-- 생성일: 2026-04-16
-- =========================================================

-- UUID 생성을 위한 확장 (Supabase 기본 제공 환경에서도 안전하게 선언)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 1) youtube_videos
-- ---------------------------------------------------------
create table if not exists public.youtube_videos (
  id uuid primary key default gen_random_uuid(),
  video_id text not null unique,
  title text not null,
  description text,
  transcript text,
  thumbnail_url text,
  video_url text,
  published_at timestamptz,
  processed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.youtube_videos is '유튜브 영상 원본 정보를 저장하는 테이블';
comment on column public.youtube_videos.id is '내부 식별용 UUID 기본 키';
comment on column public.youtube_videos.video_id is '유튜브 영상 고유 ID';
comment on column public.youtube_videos.title is '유튜브 영상 제목';
comment on column public.youtube_videos.description is '유튜브 영상 설명';
comment on column public.youtube_videos.transcript is '유튜브 자막 전체 텍스트';
comment on column public.youtube_videos.thumbnail_url is '유튜브 썸네일 이미지 URL';
comment on column public.youtube_videos.video_url is '유튜브 영상 전체 URL';
comment on column public.youtube_videos.published_at is '유튜브 업로드 시각';
comment on column public.youtube_videos.processed is '콘텐츠 생성 완료 여부';
comment on column public.youtube_videos.created_at is '레코드 생성 시각';
comment on column public.youtube_videos.updated_at is '레코드 최종 수정 시각';

-- ---------------------------------------------------------
-- 2) generated_contents
-- ---------------------------------------------------------
create table if not exists public.generated_contents (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.youtube_videos(id) on delete cascade,
  channel_type text not null check (
    channel_type in ('naver_blog', 'tistory', 'instagram', 'threads', 'naver_cafe')
  ),
  title text,
  body text not null,
  hashtags text,
  meta_description text,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'published', 'failed', 'cta_incomplete')
  ),
  email_sent boolean not null default false,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

comment on table public.generated_contents is 'AI 생성 콘텐츠(채널별 결과물)를 저장하는 테이블';
comment on column public.generated_contents.id is '생성 콘텐츠 레코드 UUID 기본 키';
comment on column public.generated_contents.video_id is '원본 유튜브 영상(youtube_videos.id) 참조';
comment on column public.generated_contents.channel_type is '콘텐츠 채널 유형';
comment on column public.generated_contents.title is '콘텐츠 제목(주로 블로그용)';
comment on column public.generated_contents.body is '콘텐츠 본문';
comment on column public.generated_contents.hashtags is '해시태그(인스타그램/스레드용)';
comment on column public.generated_contents.meta_description is 'SEO 메타 디스크립션(티스토리용)';
comment on column public.generated_contents.status is '콘텐츠 처리 상태';
comment on column public.generated_contents.email_sent is '이메일 발송 완료 여부';
comment on column public.generated_contents.created_at is '레코드 생성 시각';
comment on column public.generated_contents.published_at is '콘텐츠 게시 시각';

-- ---------------------------------------------------------
-- 인덱스
-- ---------------------------------------------------------
create index if not exists idx_youtube_videos_video_id
  on public.youtube_videos(video_id);

create index if not exists idx_youtube_videos_processed
  on public.youtube_videos(processed);

create index if not exists idx_generated_contents_video_id
  on public.generated_contents(video_id);

create index if not exists idx_generated_contents_status
  on public.generated_contents(status);

-- ---------------------------------------------------------
-- updated_at 자동 갱신 트리거 (youtube_videos)
-- ---------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_youtube_videos_set_updated_at on public.youtube_videos;

create trigger trg_youtube_videos_set_updated_at
before update on public.youtube_videos
for each row
execute function public.set_updated_at();

-- 참고:
-- RLS(Row Level Security)는 현재 내부 자동화 목적에 따라 활성화하지 않음.
