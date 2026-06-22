# 다담 동기화 설정 (Supabase + GitHub Pages)

여러 기기(모바일 포함)에서 데이터를 동기화하기 위한 1회 설정. 약 10분.

---

## 1단계 — Supabase 프로젝트 만들기

1. https://supabase.com 가입 → **New project** 생성 (지역은 `Northeast Asia (Seoul)` 권장).
2. 프로젝트가 준비되면 좌측 **Project Settings → API** 에서 두 값을 복사:
   - **Project URL** (예: `https://abcd1234.supabase.co`)
   - **anon public** key (긴 `eyJ...` 문자열)
3. 이 두 값을 [`sync.js`](sync.js) 맨 위 두 줄에 붙여넣기:
   ```js
   const SUPABASE_URL = "https://abcd1234.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOiJ...";
   ```

> anon key는 공개돼도 되는 키입니다(아래 RLS 정책이 데이터를 보호). 비밀번호가 아닙니다.

---

## 2단계 — 테이블 + 보안정책(RLS) 만들기

Supabase 좌측 **SQL Editor → New query** 에 아래를 붙여넣고 **Run**:

```sql
-- 사용자별 데이터 한 줄(JSON 통째로 저장)
create table public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 행 수준 보안: 본인 데이터만 접근
alter table public.user_data enable row level security;

create policy "own select" on public.user_data
  for select using (auth.uid() = user_id);
create policy "own insert" on public.user_data
  for insert with check (auth.uid() = user_id);
create policy "own update" on public.user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 실시간 동기화(다른 기기 변경 즉시 반영)용 publication 등록
alter publication supabase_realtime add table public.user_data;
```

---

## 3단계 — 이메일 로그인 + 허용 URL 설정

1. **Authentication → Providers → Email** 이 켜져 있는지 확인(기본 켜짐).
2. **Authentication → URL Configuration** 에서:
   - **Site URL**: 배포한 GitHub Pages 주소 (예: `https://내아이디.github.io/dadam/`)
   - **Redirect URLs** 에도 같은 주소 추가 (로컬 테스트용 `http://localhost:4321` 도 함께 넣어두면 편함)

> 이 주소가 등록돼 있어야 로그인 메일의 링크가 정상 작동합니다.

---

## 4단계 — GitHub Pages 배포

1. GitHub에 새 저장소 생성 (예: `dadam`).
2. 이 폴더의 파일들을 push:
   ```bash
   git init
   git add .
   git commit -m "다담 + 클라우드 동기화"
   git branch -M main
   git remote add origin https://github.com/내아이디/dadam.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main** / **/(root)** → Save
4. 1~2분 뒤 `https://내아이디.github.io/dadam/` 으로 접속.
5. 이 주소를 **3단계의 Site URL / Redirect URLs** 에 넣었는지 다시 확인.

---

## 사용법

- PC·폰에서 같은 주소 접속 → 우상단 **로그인** 버튼 → 이메일 입력 → 받은 메일 링크 클릭.
- 같은 이메일로 로그인한 모든 기기가 자동 동기화됩니다.
- 버튼 옆 점 색: 🟢 동기화됨 · 🟠 저장 중/대기 · 🔴 오류.
- 폰에서 브라우저 메뉴 → **홈 화면에 추가** 하면 앱처럼 쓸 수 있어요(PWA).

## 참고

- 충돌 처리는 **마지막 저장 우선**(단일 사용자 가정). 두 기기에서 동시에 다른 내용을 편집하면 나중 저장분이 이깁니다.
- 미설정 상태(`sync.js`에 값 안 넣음)에서는 기존처럼 **로컬 전용**으로 동작합니다.
- 인터넷이 끊겨도 로컬에 저장되고, 다시 연결되면 다음 편집 때 올라갑니다.
