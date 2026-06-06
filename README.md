# Nowcar 콘텐츠 자동화 시스템

나우카 유튜브 채널에 신규 쇼츠가 올라오면 자동 감지 → 영상 다운로드 → Whisper 자막 추출
→ Claude 로 5종 채널 콘텐츠 생성 → 인스타/페북/스레드(+네이버 카페) 자동 발행 → 나머지는
이메일로 전달하는 무인 파이프라인입니다.

- **운영 URL:** https://nowcar-automation.vercel.app
- **호스팅:** Vercel (Hobby 플랜)

## 기술 스택

- Next.js 16.2.4 (App Router, Turbopack) / React 19 / TypeScript / Tailwind CSS 4
- Supabase (PostgreSQL + Storage, service_role 접근, RLS 적용)
- Claude API (`claude-sonnet-4-6`) — 콘텐츠 생성
- OpenAI Whisper — 자막(STT)
- YouTube Data API v3 + `@distube/ytdl-core` — 감지·다운로드
- Meta Graph API (Instagram Reels / Facebook / Threads), Naver Cafe API
- Nodemailer (Gmail SMTP), Google Drive (다운로드 우회 소스)

## 1) 환경변수

모든 환경변수의 목록·용도·필수여부는 **[`.env.example`](./.env.example)** 에 정리돼 있습니다
(약 30개). 로컬은 루트 `.env.local`, 운영은 Vercel **Settings → Environment Variables** 에
설정합니다. 실제 시크릿은 절대 커밋하지 마세요(`.gitignore` 가 `.env*` 를 무시, `.env.example`
만 예외).

> **CRON_SECRET 이 핵심입니다.** 모든 cron(`/api/cron/*`), `/api/content/*`,
> `/api/youtube/check`, `/api/test` 의 인증 게이트입니다. 미설정/오설정 시 외부 호출이 전부
> 401 → 다운로드·발행이 멈춥니다.

## 2) 로컬 실행

```bash
npm install
# .env.local 작성 (.env.example 참고)
npm run dev      # http://localhost:3000
npm run build    # 프로덕션 빌드 (env 가 있어야 page data 수집 단계 통과)
```

## 3) 프로젝트 구조

```text
app/api/
  cron/download    # [Vercel Cron 매일 10:00 UTC=19:00 KST] 감지+다운로드 → after()로 pipeline/run 트리거
  cron/cleanup     # [Vercel Cron 매일 18:00 UTC=03:00 KST] 24h 지난 temp 영상/행 정리
  pipeline/run     # 발행 파이프라인(detect→generate→meta→cafe→email). ⚠️ 현재 무인증
  content/generate # 콘텐츠 생성(인증)
  content/email    # 이메일 발송(인증)
  youtube/check    # 감지 점검(인증)
  test             # 진단(무인증: commit SHA만 / 인증: 전체 서비스 점검)
lib/                # supabase·anthropic·youtube·whisper·meta·naver·storage·mailer·pipeline-health 등
lib/pipeline/       # detect / generate / email / publish-meta / publish-naver-cafe 단계
supabase/migrations # DB 스키마 마이그레이션
```

## 4) 운영(Operations)

### 자동 스케줄
- **다운로드 cron** (`vercel.json` crons): 매일 19:00 KST. 신규 영상 감지 → mp4 확보
  (Drive 원본 우선, 사무실 PC 로컬 워커가 ytdl 담당) → 응답 직후 `after()` 로 `/api/pipeline/run`
  자동 트리거(발행·메일).
- **정리 cron**: 매일 03:00 KST. Supabase Storage(temp-videos)에서 24h 지난 mp4 삭제.

### 수동 트리거 / 점검 (CRON_SECRET 필요)
```bash
# 파이프라인 수동 실행
curl "https://nowcar-automation.vercel.app/api/pipeline/run?secret=$CRON_SECRET"
# 전체 서비스 진단(무인증이면 commit SHA만 반환)
curl "https://nowcar-automation.vercel.app/api/test?secret=$CRON_SECRET"
```
> 쿼리 `?secret=` 는 Vercel 액세스 로그/브라우저 히스토리에 남습니다. 가능하면
> `Authorization: Bearer $CRON_SECRET` 헤더를 사용하세요.

### 발행 토글 / kill switch
- `AUTO_PUBLISH_INSTAGRAM` / `AUTO_PUBLISH_FACEBOOK` / `AUTO_PUBLISH_THREADS` — `"true"` 일 때만 발행.
- **네이버 카페:** 코드 레벨 kill switch(`lib/naver.ts` 의 `NAVER_CAFE_AUTO_PUBLISH_PAUSED`)로
  현재 **일시정지**(999 차단). 계정 정상화 후 해당 상수를 `false` 로 되돌리거나
  `NAVER_CAFE_FORCE_RESUME=true` env 로 즉시 재개.
- `?skip_email=true` — pipeline/run 에서 이메일 단계 스킵.

### 모니터링
- `lib/pipeline-health.ts` 가 다운로드 cron 안에서 매일 1회 "조용한 고장"(멈춘 pending,
  미다운로드 백로그, 발행 실패 급증, 토큰 만료 임박)을 점검해 12h cooldown 다이제스트 메일을
  발송. 임계값은 `HEALTH_*` env 로 튜닝 가능(미설정 시 기본값).
- Hobby 플랜은 로그를 ~1h 만 보존하므로, 영구 진단은 DB(`youtube_videos.last_download_error`,
  `social_publishes.error_message`, `system_alerts`)에 저장됩니다.

## 5) 배포 (Vercel)

1. GitHub 연결 → Vercel Import (Framework: Next.js 기본값).
2. Settings → Environment Variables 에 `.env.example` 의 키를 전부 등록(특히 `CRON_SECRET`,
   `SUPABASE_SERVICE_ROLE_KEY`, Meta/Naver/Drive 시크릿).
3. `vercel.json` 의 cron 스케줄이 자동 등록됩니다(Hobby 는 1일 1회 제한).
4. 배포 확인: `GET /api/test` 의 `commit` 필드가 최신 커밋 SHA 인지 확인.
