-- =========================================================
-- social_publishes 의 active unique 제약을 완화
-- ---------------------------------------------------------
-- 배경:
--   기존 ux_social_publishes_video_platform_active 는
--   (video_id, platform) WHERE deleted_at IS NULL 로 정의되어
--   *실패한 행* 도 같은 (video_id, platform) 신규 insert 를 막아왔다.
--   결과적으로 한 번 실패한 발행은 (예: 네이버 카페 999 일시 오류)
--   영구히 재시도 불가 상태가 되었다.
--
-- 변경:
--   pending / success 상태인 active 행만 unique 로 강제하고,
--   failed 행은 신규 pending 선점을 막지 않도록 한다.
--   - alreadySuccess 체크(코드 쪽) 가 success 재발행을 막아주므로,
--     unique 보호는 "발행 진행 중(pending) 혹은 이미 성공"에만 필요.
-- =========================================================

drop index if exists public.ux_social_publishes_video_platform_active;

create unique index ux_social_publishes_video_platform_active
  on public.social_publishes (video_id, platform)
  where deleted_at is null
    and status in ('pending', 'success');
