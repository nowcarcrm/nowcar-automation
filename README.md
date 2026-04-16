# Nowcar 콘텐츠 자동화 시스템

나우카 유튜브 채널에 신규 쇼츠가 업로드되면 자동으로 감지하고, Claude API를 사용해 5종 콘텐츠를 생성한 뒤 이메일로 전달하는 프로젝트입니다.

## 기술 스택

- Next.js 14+ (App Router)
- TypeScript
- Tailwind CSS
- Supabase
- Claude API (`claude-sonnet-4-6`)
- YouTube Data API v3
- Nodemailer

## 1) 로컬 실행 방법

### 필수 준비

- Node.js 18.18 이상(권장: 20 이상)
- npm

### 설치

```bash
npm install
```

### 환경변수 설정

프로젝트 루트의 `.env.local` 파일에 아래 값을 입력합니다.

```env
YOUTUBE_API_KEY=
YOUTUBE_CHANNEL_ID=
ANTHROPIC_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
EMAIL_USER=
EMAIL_PASS=
```

### 개발 서버 실행

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속

## 2) 프로젝트 구조

```text
app/
  api/                # API 라우트(유튜브 감지, 콘텐츠 생성, 메일 발송)
lib/                  # Supabase/Claude/YouTube/메일 클라이언트
supabase/
  migrations/         # DB 스키마 마이그레이션
```

## 3) 설치된 주요 패키지

- `@supabase/supabase-js`
- `@anthropic-ai/sdk`
- `nodemailer`
- `googleapis`
- `youtube-transcript`

## 4) 배포 방법 (Vercel)

1. GitHub에 프로젝트 업로드
2. [Vercel](https://vercel.com/)에서 프로젝트 Import
3. Build/Framework는 Next.js 기본값 사용
4. Vercel Project Settings > Environment Variables에 `.env.local`과 동일한 키 등록
5. 배포 후 도메인 설정에서 `nowcarcrm.com` 연결

## 5) 도메인 연결(`nowcarcrm.com`)

1. Vercel 프로젝트의 Domains 메뉴에서 `nowcarcrm.com` 추가
2. 도메인 관리 업체(DNS)에서 Vercel 안내 레코드(A/CNAME) 설정
3. DNS 전파 후 HTTPS 인증서 자동 발급 확인

## 6) 다음 개발 단계(추천)

1. Supabase 테이블 설계 및 마이그레이션 작성
2. YouTube 신규 쇼츠 감지 API 구현
3. 자막 수집(`youtube-transcript`) + Claude 콘텐츠 생성 로직 구현
4. Nodemailer 발송 API 구현
5. 스케줄링(Cron/Vercel Cron)으로 자동 실행 연결
