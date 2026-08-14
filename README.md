# 🌱 새싹 레이더 (saessak-radar)

[디지털새싹](https://newsac.kosac.re.kr/) 프로그램 목록을 주기적으로 확인해서
**① 감시 조건에 맞는 새 프로그램 등록**, **② "모집 예정 → 모집 중" 상태 전환**을 감지하면
**텔레그램으로 알림**을 보내는 감시 앱입니다.

목록이 JavaScript로 렌더링되기 때문에 **Playwright(headless Chromium)** 로 읽습니다.

---

## 기능

- 10분(설정 가능) 간격으로 프로그램 목록 자동 수집
- 감시 조건(유형/권역/학교급/상태/교육대상) 매칭
- 신규 등록 → 🟡 `[새 프로그램]`, 모집 시작/전환 → 🔴 `[모집 시작]` 텔레그램 알림
- 같은 프로그램+상태로는 중복 알림 없음
- 수집 3회 연속 실패 시 `⚠️ 수집 실패 중` 경보 1회
- 웹 대시보드: 감시 상태 / 조건 일치 수 / 오늘 알림 수 / 최근 감지 로그 20건 / "즉시 확인" 버튼
- 설정 페이지에서 감시 조건 체크박스로 변경 → 다음 주기부터 적용
- **클릭 이동**: 텔레그램 알림에 `🔗 신청 페이지 열기` 인라인 버튼, 브라우저 알림 클릭 시 상세페이지 새 탭, 대시보드 로그 줄 클릭 시 상세페이지 새 탭
- **알림 리허설**: 대시보드 `테스트 알림 보내기` 버튼(`POST /api/test-alert`)으로 가짜 프로그램 1건을 실제 발송 경로(브라우저+텔레그램, 인라인 버튼 포함)에 태워 점검. 로그에 `test`로만 남고 오늘 알림 카운트·조건 일치 수·감시 스냅샷에는 미반영

---

## 기술 스택

Node.js · Express · Playwright(chromium) · node-cron · JSON 파일 저장

---

## 로컬 실행

```bash
npm install
npx playwright install chromium
cp .env.example .env   # 토큰/챗ID 채우기 (없어도 실행은 됨, 콘솔에만 출력)
npm start
```

- 브라우저에서 http://localhost:3000 접속
- **"지금 즉시 확인"** 버튼을 눌러 1회 수집 실행 → 콘솔에 `카드 N개 수집` 로그로 몇 개 잡히는지 확인
- 카드가 0개면 셀렉터/렌더링 문제 (에러 처리되어 diff는 스킵됨)

환경변수:

| 변수 | 설명 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림 받을 채팅 ID |
| `DATA_DIR` | 상태 저장 경로 (비우면 `./data`) |
| `ADMIN_PASSWORD` | 설정/알림 보호용 관리자 비밀번호 (미설정 시 보호 없음) |
| `SEASON_YEAR` | 수집 대상 시즌 연도 (비우면 `2026`) — 사이트 목록 API 의 `season` 파라미터 |

> `.env` 파일은 서버 시작 시 자동 로드된다(이미 설정된 환경변수는 덮어쓰지 않음). 없으면 조용히 스킵.

### 수집 API 스펙 (2026-08 변경)

목록 API `GET /newsac/api/v1/programs/user` 는 `season`(시즌 연도) + `version`(=`v2`) 를
함께 받도록 바뀌었다. 두 값 없이 호출하면 "인증 필요" 로 거절될 수 있어 항상 붙인다.

- `season` : `SEASON_YEAR` 환경변수 (기본 `2026`) — 연도가 바뀌면 변수만 교체
- `version`: `v2` 고정 — `v2` 는 사이트 화면과 동일한 목록(지난 시즌 잔여분 제외)을 준다
- `size=100` + `page` 순회로 전 페이지 수집 → 조건 일치 누락 방지
- 권역/학교급/교육대상 필터는 **서버에 보내지 않는다**. 전량을 받아 `watcher` 가
  설정으로 거르기 때문에 설정 변경 시 재수집이 필요 없고, 신설 분류도 '미분류'로 잡힌다
- 로그인 쿠키 불필요(공개 데이터). 추가 헤더도 `Accept: application/json` 하나면 충분
- 상세 API `GET /newsac/api/v1/programs/{id}` 는 아직 두 파라미터 없이도 동일 응답이지만,
  같은 변경이 오면 바로 깨지므로 동일하게 붙여 호출한다

교육대상 코드(코드그룹 `G006`) — `src/classify.js` 단일 소스:

| 코드 | 라벨 |
|------|------|
| `C0601` | 일반형 |
| `C0602` | 사회적 배려형(도서벽지) |
| `C0603` | 사회적 배려형(이주배경(구 다문화)) |
| `C0604` | 사회적 배려형(특수교육) |
| `C0605` | 농어촌 학교 |
| `C0606` | 교육복지우선지원사업 학교 |

### 🔒 설정 비밀번호 보호 (`ADMIN_PASSWORD`)

`ADMIN_PASSWORD` 를 설정하면 **감시 조건 설정과 알림 발송**이 비밀번호로 보호된다. 외부 라이브러리 없이 Node 내장 `crypto` 만 사용한다.

- **보호 대상**: `GET /settings`, `POST /api/settings`, `POST /api/test-alert`, `POST /api/check-now`
- **공개 유지**: 대시보드 `/`, `/health` (열람은 로그인 없이 가능)
- **동작**: 비밀번호 입력(`/auth`)이 일치하면 HMAC 서명 쿠키(만료 30일, `HttpOnly`)를 발급하고, 서명 검증 미들웨어가 보호 라우트를 감싼다. 비밀번호 비교는 `crypto.timingSafeEqual` 사용. 비밀번호를 바꾸면 기존 쿠키는 자동 무효화된다.
- **미설정 시**: 보호가 완전히 꺼져 지금처럼 로그인 없이 사용 (로컬 개발 편의).
- 대시보드의 `⚙️ 감시 조건 설정` 버튼은 그대로 두되, 미인증 상태로 누르면 비밀번호 페이지를 경유한다.

```bash
# .env 예시
ADMIN_PASSWORD=원하는비밀번호
```

Railway 등 배포 환경에서는 **Variables** 탭에 `ADMIN_PASSWORD` 를 추가한다.

---

## 텔레그램 봇 만들기 (요약)

1. 텔레그램에서 **@BotFather** 검색 → `/newbot` → 이름/username 지정 → **봇 토큰** 발급
2. 방금 만든 봇에게 아무 메시지나 1개 전송 (봇이 나에게 말 걸 수 있게)
3. **@userinfobot** 에게 말 걸어 내 **chat id**(숫자) 확인
   (그룹으로 받으려면 봇을 그룹에 초대 후 그룹 chat id 사용)
4. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 에 각각 입력

---

## Railway 배포 순서

1. 이 저장소를 GitHub에 push
2. [Railway](https://railway.app) → **New Project → Deploy from GitHub repo** → `saessak-radar` 선택
3. Railway가 **Dockerfile을 자동 인식**해서 빌드 (Playwright 베이스 이미지라 크로뮴 포함)
4. **Variables** 탭에서 환경변수 2개 등록:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. **Volume** 추가 → 마운트 경로를 `/data` 로 설정 → 변수에 `DATA_DIR=/data` 추가
   (재배포/재시작해도 감시 스냅샷과 로그가 유지됨)
6. Deploy 완료 후 도메인 접속 → 대시보드 확인, "즉시 확인"으로 수집 테스트

> Volume을 붙이지 않으면 재시작 때마다 state가 초기화되어, 배포 직후 기존 프로그램들이
> "신규"로 잡혀 알림이 몰려올 수 있습니다. **`/data` Volume 권장.**

---

## 프로젝트 구조

```
saessak-radar/
├─ package.json
├─ Dockerfile
├─ .env.example
├─ src/
│  ├─ server.js    Express 서버 + cron 스케줄 + 대시보드/설정 UI
│  ├─ scraper.js   Playwright 수집 (텍스트 기반 견고 추출)
│  ├─ watcher.js   diff 판정 + 텔레그램 발송
│  └─ storage.js   settings.json / state.json / log.json 읽기쓰기
└─ public/         정적 파일 (선택)
```

## 감시 조건 기본값

```json
{
  "programType": ["방문형"],
  "regions": ["서울·인천권"],
  "schoolLevels": ["초등학교"],
  "statuses": ["모집 예정", "모집 중"],
  "targets": ["일반형", "사회적 배려형(다문화)"],
  "intervalMinutes": 10
}
```

- 유형/권역/학교급: 카드 값이 체크 목록에 **하나라도 포함되면 통과** (복수 표기 권역 지원)
- 교육대상: **OR** — 체크한 대상 중 하나라도 태그에 있으면 통과
- **모집 완료는 항상 제외**
