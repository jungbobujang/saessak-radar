# 멀티 리전 배포 준비 조사 보고

- 대상 저장소: `Downloads/projects/saessak-radar` (origin `git@github.com:jungbobujang/saessak-radar.git`)
- 조사 시점 브랜치: `oom-fix` / HEAD `59d8ba2`
- 조사일: 2026-08-26
- **코드 변경 없음** (조사·보고 전용)

---

## 0. 한 줄 결론

감시 조건은 **환경변수가 아니라 런타임 설정 파일**(`DATA_DIR/settings.json`, 웹 UI에서 편집)에 있다.
`data/` 는 `.gitignore` 되어 있어 레포에 조건이 박혀 있지 않다.
→ **두 번째 리전 서비스를 띄우는 데 코드 변경은 필수가 아니다.** 볼륨을 새로 붙이고 배포 후
설정 화면에서 권역만 바꾸면 동작한다.

다만 **첫 부팅 시 기본값이 `서울·인천권` 으로 하드코딩**(`src/storage.js:134`)되어 있어,
설정을 사람이 바꾸기 전까지 2번 서비스가 **서울·인천권 알림을 잘못 발송**한다.
이 창(window)을 없애는 것이 `REGION_FILTER` 도입의 실질적 이유다.

---

## 1. 감시 조건이 어디에 정의돼 있는가

감시 조건 5종은 **한 곳(`settings`)에 모여** 있고, 저장소는 **JSON 파일**이다. 환경변수 아님.

| 조건 | 설정 키 | 판정 코드 |
|---|---|---|
| 프로그램 유형 | `programType` | `src/watcher.js:110` |
| 운영권역 | `regions` | `src/watcher.js:112-116` |
| 학교급 | `schoolLevels` | `src/watcher.js:118-121` |
| 모집상태 | `statuses` | `src/watcher.js:104` |
| 교육대상(키워드 태그) | `targets` | `src/watcher.js:123-141` (`classify.canonicalKey` 정규화 후 비교) |

### 계층 (우선순위 높은 순)

1. **런타임 저장본** — `DATA_DIR/settings.json`
   - `src/storage.js:6` → `DATA_DIR = process.env.DATA_DIR || './data'`
   - Docker/Railway 에서는 `/data` (볼륨). `Dockerfile:14` 에 `ENV DATA_DIR=/data`
   - `getSettings()` (`storage.js:194`)는 `{...DEFAULT_SETTINGS, ...저장본}` — **저장본이 항상 이긴다**
2. **웹 UI** — 설정 페이지 체크박스 → `POST /api/settings` (`server.js:2870`) → `saveSettings()`
   - 서버는 값 화이트리스트 검증을 하지 않는다. 배열/불리언 정규화만 한다 (`storage.js:216-233`)
3. **코드 하드코딩 기본값** — `src/storage.js:133-165` `DEFAULT_SETTINGS`
   - `settings.json` 이 **없을 때만**(첫 배포 · 볼륨 미부착 · 볼륨 유실) 쓰인다
   - 여기에 `regions: ['서울·인천권']` 이 박혀 있다 → **2번 서비스의 오발송 위험 지점**

### 환경변수는 감시 조건에 전혀 관여하지 않는다

조건에 영향을 주는 env 는 `SEASON_YEAR`(수집 시즌) 하나뿐이고, 이것도 권역과 무관하다.
스크래퍼는 **권역·학교급·교육대상 필터를 서버에 보내지 않고 전량 수집**한 뒤 앱에서 거른다
(`src/scraper.js:214-217` 주석). 즉 **리전을 나눠도 수집 트래픽은 서비스당 동일**하다.

> ⚠ 비용/부하 함의: 서비스 2개 = 사이트 요청 2배. 수집 자체는 권역을 안 가리므로
> "권역별로 나눠 긁는" 효과가 없다. 순수하게 알림 대상만 분리된다.

---

## 2. `REGION_FILTER` 로 빼는 데 바꿔야 할 파일·규모

### 최소안 (A) — "첫 부팅 기본값만 env 로" · **권장**

기존 UI/저장 구조를 그대로 두고, 볼륨이 빈 상태의 초기값만 env 로 받는다.

| 파일 | 위치 | 작업 | 규모 |
|---|---|---|---|
| `src/storage.js` | 134 | `regions: parseRegions(process.env.REGION_FILTER) ?? ['서울·인천권']` + 파서 헬퍼 | +8~12줄 |
| `.env.example` | 신규 항목 | `REGION_FILTER=` 주석 | +4줄 |
| `README.md` | 44-49 표 / 182- Railway 절 | 변수 표 1행 + 2번째 서비스 절차 | +15줄 |

**합계 ≈ 3파일 / 30줄 미만.** 위험 낮음 — 기존 볼륨엔 영향 0(저장본이 우선이므로).

### 전체안 (B) — "env 가 UI 를 잠근다"

2번 서비스에서 사람이 실수로 권역을 바꾸는 것까지 막으려면 추가로:

| 파일 | 위치 | 작업 | 규모 |
|---|---|---|---|
| `src/server.js` | 1149-1158 | 권역 체크박스 렌더 시 `REGION_FILTER` 값 외 `disabled` + 잠금 안내 | +15줄 |
| `src/server.js` | 2870-2878 | `POST /api/settings` 에서 `regions` 강제 덮어쓰기(서버측 방어) | +5줄 |
| `src/storage.js` | 216-233 | `saveSettings` 정규화 단계에서 동일 강제 | +5줄 |
| `src/watcher.js` | 532 | 테스트 알림 더미 카드 `regions` 를 설정값에서 가져오기 | 1줄 |
| `src/server.js` | 3218 주석 | 조건 요약 예시 문구 갱신 | 1줄 |

**합계 ≈ 4파일 / 60~70줄.**

### 곁들여 필요해 보이는 것 (서비스 식별)

두 서비스가 **같은 문구로 텔레그램을 보낸다** → 어느 권역 알림인지 구분 불가.
`SERVICE_LABEL` 같은 env 로 머리말에 꼬리표를 붙이는 편이 안전하다.
해당 지점: `server.js:380`(정지 경보), `server.js:672,676,3794`(대시보드 제목),
`watcher.js:293`(수집 실패 경보), `watcher.js:529`(테스트 알림 제목) — **5곳 / 약 10줄**.

---

## 3. 텔레그램 토큰·챗ID의 서비스별 분리 가능성

**결론: 코드 수정 없이 완전히 분리 가능하다.**

- 읽는 곳이 `src/watcher.js` 단 3줄뿐이다 — `146`(설정 여부 판정), `192-193`(발송 시 조회)
- 둘 다 `process.env` 직독. 파일/DB/설정 UI 어디에도 캐시하거나 저장하지 않는다
- 발송 함수는 `sendTelegram()` (`watcher.js:191-236`) 하나로 단일화되어 있고,
  모든 알림 경로(모집 시작·신규·리마인더·정보 변경·테스트·수집 실패 경보·정지 경보)가 이 함수를 탄다
  → **env 만 갈아끼우면 전 경로가 함께 갈린다. 누락 경로 없음.**

가능한 조합:

| 조합 | 설정 | 비고 |
|---|---|---|
| 같은 봇 · 다른 채팅방 | `TELEGRAM_BOT_TOKEN` 공유, `TELEGRAM_CHAT_ID` 만 분리 | 가장 간단. 권역별 방 분리 |
| 같은 봇 · 같은 방 | 둘 다 공유 | 한 방에 섞여 옴 → §2 `SERVICE_LABEL` 없으면 구분 불가 |
| 다른 봇 · 다른 방 | 둘 다 분리 | 완전 격리. 봇 이름으로 자연 구분 |

> ⚠ 미설정 시 동작: 토큰/챗ID 가 없으면 예외 없이 **콘솔 출력만 하고 조용히 넘어간다**
> (`watcher.js:194-198`). 2번 서비스에 변수를 빠뜨려도 배포는 성공하고 알림만 안 온다 —
> 배포 직후 설정 화면의 "알림 리허설"로 실제 발송을 반드시 확인할 것.

---

## 4. "서울·인천권" 하드코딩 전수 검색

검색: `grep -rn "서울·인천권" --include=*.js --include=*.json --include=*.md --exclude-dir=node_modules --exclude-dir=.git`

### (A) 반드시 손봐야 하는 곳 — 동작에 영향

| # | 위치 | 맥락 | 영향 |
|---|---|---|---|
| 1 | `src/storage.js:134` | `DEFAULT_SETTINGS.regions` | **첫 부팅 기본 감시 권역. 2번 서비스 오발송의 유일한 원인** |

### (B) 알림 계열 — 사실상 무해하나 혼동 유발

| # | 위치 | 맥락 | 영향 |
|---|---|---|---|
| 2 | `src/watcher.js:532` | 테스트 알림(리허설) 더미 카드 `regions: ['서울·인천권']` | 경기권 서비스에서 리허설 시 메시지에 "서울·인천권"으로 찍힘 → 설정이 잘못됐다고 오해할 소지. `state.json` 에는 반영 안 됨(실제 감지 무영향) |

### (C) UI 선택지 — 5개 권역 전부 나열, 하드코딩이지만 정상

| # | 위치 | 맥락 |
|---|---|---|
| 3 | `src/server.js:1152` | 설정 화면 권역 체크박스 "서울·인천권" |
| 4 | `src/server.js:1153-1156` | 나머지 4개(경기권 / 강원·충청권 / 경상권 / 호남·제주권) — 목록은 완비돼 있음 |

→ 권역 목록 자체는 5개가 다 있으므로 **UI에서 즉시 다른 권역 선택 가능**. 이 부분은 변경 불필요.

### (D) 연습 페이지(신청 연습) — 가상 데이터, 무해

| # | 위치 | 맥락 |
|---|---|---|
| 5 | `src/server.js:1567` | `PRACTICE_PROGRAMS[0]` 더미 프로그램 `운영권역: '서울·인천권'` |
| 6 | `src/server.js:1585` | `PRACTICE_PROGRAMS[1]` `운영권역: '경기권'` |
| 7 | `src/server.js:1603` | `PRACTICE_PROGRAMS[2]` `운영권역: '강원·충청권'` |
| 8 | `src/server.js:1631~` | `PRACTICE_ADDRESSES` 더미 주소가 서울·경기·인천 위주 |

→ 연습 화면은 외부 통신 없는 순수 타자연습용이고 권역이 이미 3종 섞여 있다. **변경 불필요.**

### (E) 문서·주석 — 예시 문구

| # | 위치 | 맥락 |
|---|---|---|
| 9 | `src/server.js:3218` | `conditionChips` 주석 예시 "방문형 · 초등 · 서울·인천권 · …" |
| 10 | `src/scraper.js:168` | 권역 파싱 주석 예시 `"서울·인천권,경기권,..."` |
| 11 | `README.md:370` | 설정 JSON 예시 `"regions": ["서울·인천권"]` |

### (F) 런타임 데이터 — 코드 아님

| # | 위치 | 맥락 |
|---|---|---|
| 12 | `data/settings.json:6` | 로컬 개발 저장본. **`.gitignore` 대상 → 레포·이미지에 안 들어감** |
| 13 | `data/state.json` (22개 항목) | 수집 스냅샷. 감시 *결과*이지 조건이 아님. 볼륨별로 독립 |

### "관측" 키워드 확인

`grep -rn "관측"` 결과 3건 — `server.js:1556` 은 연습용 더미 프로그램명("한여름 밤의 AI 별자리 관측단"),
`server.js:2951`·`3636` 은 "이번 사이클에 관측된 프로그램" 이라는 서술어.
**권역과 무관, 조치 불필요.**

**총 13개소. 동작 영향은 `storage.js:134` 단 1곳.**

---

## 5. Railway 2번째 서비스 환경변수 전체 목록

코드 전수 조사(`grep -rn "process.env" src/`) 기준 앱이 읽는 변수 **21개** 전체.

### 필수 (안 넣으면 오동작)

| 변수 | 값 예 | 이유 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (봇 토큰) | 없으면 알림이 콘솔로만 나가고 조용히 실패 |
| `TELEGRAM_CHAT_ID` | (권역별 채팅방 ID) | 위와 동일. **1번 서비스와 다른 방 권장** |
| `DATA_DIR` | `/data` | Dockerfile 에 기본 주입돼 있으나 명시 권장. **볼륨을 반드시 별도로 새로 붙일 것** |

> ⚠ **볼륨 공유 금지.** 두 서비스가 같은 볼륨을 보면 `settings.json`·`state.json`·`log.json` 을
> 서로 덮어써서 권역 설정이 튀고 diff 가 깨진다. Railway Volume 은 서비스당 1개씩 새로 생성.

### 강력 권장

| 변수 | 값 예 | 이유 |
|---|---|---|
| `ADMIN_PASSWORD` | (비밀번호) | 설정 변경·알림 발송 보호 (`server.js:67,73,99`). **`.env.example` 에 누락돼 있음 — README 표에만 있다** |
| `SEASON_YEAR` | `2026` | 미설정 시 코드 기본 `2026` (`scraper.js:23`). 1번 서비스와 값 일치시킬 것 |

### 도입 시 추가 (§2)

| 변수 | 값 예 | 상태 |
|---|---|---|
| `REGION_FILTER` | `경기권` | **미구현.** 구현 전에는 배포 후 UI 에서 수동 설정 |
| `SERVICE_LABEL` | `경기` | **미구현.** 알림 발신 서비스 구분용 |

### Railway 가 자동 주입 — 손대지 말 것

| 변수 | 비고 |
|---|---|
| `PORT` | `server.js:54`, 기본 3000 |
| `RAILWAY_PUBLIC_DOMAIN` | keep-alive 자동 동작 (`server.js:558`) |
| `NODE_ENV` | Dockerfile 에서 `production` 고정 |

### 선택 — keep-alive

| 변수 | 기본값 | 비고 |
|---|---|---|
| `KEEPALIVE_URL` (또는 `PUBLIC_URL`) | — | Railway 면 보통 비워 둠 (`server.js:556`) |
| `KEEPALIVE_MIN` | 5 | `server.js:553` |

### 선택 — 감시 루프 안전장치 (비우면 기본값, 평소 불필요)

순서 제약: 스크래퍼(90초) < 사이클(4분) < 죽은 락(5분) < 워치독(30분)

| 변수 | 기본값 | 위치 |
|---|---|---|
| `SCRAPE_TIMEOUT_MS` | 90000 | `scraper.js:69` |
| `CYCLE_TIMEOUT_MIN` | 4 | `server.js:169` |
| `WATCHDOG_TICK_MIN` | 1 | `server.js:170` |
| `WATCHDOG_STALL_MIN` | 30 | `server.js:171` |
| `STALE_LOCK_MIN` | 5 | `server.js:174` (자동으로 `max(값, 사이클+1분)` 보정) |

### 선택 — 프로세스 자체 재기동

| 변수 | 기본값 | 위치 |
|---|---|---|
| `RESTART_EXIT_CODE` | **1** | `server.js:409` — ⚠ 0 이면 Railway `ON_FAILURE` 정책상 재기동 안 됨 |
| `MAINTENANCE_HOUR` | 4 (KST, -1=비활성) | `server.js:410` |
| `MAINTENANCE_WINDOW_MIN` | 20 | `server.js:411` |
| `MAINTENANCE_MIN_UPTIME_MIN` | 60 | `server.js:412` |
| `FAIL_RESTART_STREAK` | 5 | `server.js:413` |
| `RESTART_ALERT_PER_DAY` | 3 | `server.js:414` |

> 💡 `MAINTENANCE_HOUR` 는 두 서비스를 **다르게** 주는 편이 낫다(예: 1번 4시, 2번 5시).
> 같은 시각에 동시에 예방 재기동하면 두 서비스가 같이 비어 있는 창이 생긴다.

### 서비스 설정 (변수 아님, 콘솔에서)

- **Settings → Serverless / App Sleeping = OFF** (필수. 켜져 있으면 감시 루프가 통째로 멈춤)
- **Volume 신규 생성 → 마운트 `/data`**
- 외부 모니터(UptimeRobot 등)로 `/health` 또는 `/health/watch` 5분 간격 호출 권장

---

## 6. 배포 절차 요약 (코드 변경 없이 지금 바로 가능한 경로)

1. Railway → New Service → 같은 GitHub 레포(`saessak-radar`) 선택
2. **Volume 신규 생성** → 마운트 `/data`
3. Variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`(새 방), `DATA_DIR=/data`, `ADMIN_PASSWORD`, `SEASON_YEAR=2026`
4. Settings → App Sleeping **OFF**
5. Deploy → **배포 직후 즉시** 공개 도메인 접속 → 설정 화면에서 권역을 목표 권역으로 변경
   - ⚠ 이 사이(첫 부팅 ~ 설정 변경)에 사이클이 돌면 **서울·인천권 알림이 잘못 발송된다** (`storage.js:134`)
   - 회피책: 배포 직후 바로 설정 변경, 또는 §2-A `REGION_FILTER` 를 먼저 구현
6. 설정 화면 "알림 리허설"로 새 채팅방 수신 확인

---

## 7. 질문 필요 (판단 보류 — 결정에 따라 작업이 달라짐)

1. **`REGION_FILTER` 의 성격** — 첫 부팅 기본값만 정하는 것(A안, 3파일/30줄)인지,
   UI 를 잠그는 강제값(B안, 4파일/70줄)인지. 동작과 규모가 크게 다르다.
2. **`REGION_FILTER` 값 형식** — 단일 권역(`경기권`)만 허용할지, 콤마 다중(`경기권,강원·충청권`)을
   허용할지. 권역명에 가운뎃점(`·`)이 들어가므로 구분자 선택에 주의가 필요하다.
3. **권역 외 조건(학교급·유형·교육대상)도 env 로 뺄지** — 이번 조사 범위는 권역 중심이었다.
   전부 뺄 거면 `SETTINGS_JSON` 같은 통짜 env 가 더 단순할 수 있다.
4. **텔레그램 방 분리 방식** — 같은 봇/다른 방 vs 다른 봇. §3 표 참고. 코드 영향은 없고 운영 선택.
5. **`SERVICE_LABEL` 도입 여부** — 두 서비스 알림이 현재 완전히 동일한 문구다. 도입 시 5곳 수정.
6. **1번 서비스(서울·인천권)에도 `REGION_FILTER` 를 넣을지** — 기존 볼륨엔 `settings.json` 이
   이미 있어 A안이면 아무 영향이 없다. B안이면 기존 UI 가 잠기므로 사전 합의가 필요하다.

### 7-1. 결정 결과 (2026-08-26 확정)

| # | 항목 | 결정 |
|---|---|---|
| 1 | `REGION_FILTER` 성격 | **A안** — 첫 부팅 기본값만. UI 잠그지 않음 |
| 2 | 값 형식 | **콤마 다중** · 각 값 trim · 구분자는 콤마만 |
| 3 | 권역 외 조건도 env 로 뺄지 | **현행 유지** — 빼지 않는다 |
| 4 | 텔레그램 분리 방식 | **같은 봇 + 다른 챗ID** |
| 5 | `SERVICE_LABEL` 도입 | **도입** (§9) |
| 6 | 1번 서비스에도 `REGION_FILTER` | **명시한다** — README 에 적힌 대로 |
| — | `.env.example` 의 `ADMIN_PASSWORD` 누락 | **보완** — `PRACTICE_PASSWORD` 와 함께 추가 (§10) |

미결 항목은 없다.

---

## 8. 브랜치 상태 — ⚠ oom-fix 는 main 에 머지돼 있지 않다

작업 착수 전 확인 결과, **`oom-fix` 는 `main` 에 머지·push 되지 않았다.**
그래서 새 브랜치를 따지 않고 **`oom-fix` 위에서 그대로 진행**했다.

```
git fetch origin
git cherry -v origin/main oom-fix
+ 59d8ba2 프로세스 자체 재기동: 예방 정비·연속 실패·반복 재기동 경보 (7·8·9겹)
```

`+` 표시 = **patch 동등한 커밋이 origin/main 에 없다**(단순 조상 관계가 아니라 내용 기준으로도 없음).

### 확인된 사실

| 항목 | 값 |
|---|---|
| 로컬 `oom-fix` | `59d8ba2` |
| 로컬 `main` | `9d2f5d8` (**origin/main 보다 15 커밋 뒤처짐**) |
| `origin/main` | `b28cb5f` |
| `origin/oom-fix` | `b28cb5f` (= origin/main 과 동일 커밋) |
| 공통 조상 | `9d2f5d8` |
| oom-fix 가 앞선 커밋 | 1개 (`59d8ba2`) |
| main 이 앞선 커밋 | 15개 |

### ⚠ 위험 — 다른 세션의 작업과 갈라져 있다

`origin/main` 의 15개 커밋은 **다른 세션이 진행한 OOM 방어·감량 작업**이다
(`b28cb5f` 커밋 메시지가 "리포트 복원 + **다른 세션의** 진단·감량 작업 덧붙임").
그 중 `eef3f2d "OOM 3종 방어: 새벽 정기 재기동 · 연속 실패 자가재기동 · 하루 상한 초과 경보"` 는
로컬 `59d8ba2` 와 **같은 문제를 각자 다르게 구현한 것**으로 보인다.

`git diff origin/main oom-fix` 는 9파일 / +348 −1437 이고, `oom-fix` 쪽에서 보면
`.oomfix/harness.js`·`.oomfix/run-all.js`·`REPORT.md` 가 통째로 없고
`src/server.js` 가 864줄, `src/scraper.js` 가 172줄 어긋난다.

또한 원격 브랜치 이름 `oom-fix` 가 **로컬 `oom-fix` 와 다른 커밋**(`b28cb5f`)을 가리킨다.
→ `git push origin oom-fix` 는 non-fast-forward 로 거부되고, 강제 push 하면
**origin 의 그 15개 작업을 덮어쓴다.**

### 그래서 하지 않은 것 (질문 필요)

**`main` 머지와 `main` push 는 건너뛰었다.** 지금 머지하면 다른 세션의 OOM 방어 작업과
대규모 충돌이 나거나, 해결을 잘못하면 되돌려 버린다. 되돌리기 어려운 쪽이라 판단을 미뤘다.

대신 **비파괴 경로**를 택했다 — 커밋은 `oom-fix` 위에 쌓고, 원격에는
**새 브랜치 `multi-region`** 으로 push 했다(아무것도 덮어쓰지 않는다).

**결정 필요 (택 1):**

| 선택지 | 내용 | 비고 |
|---|---|---|
| ① rebase | `git rebase origin/main` 으로 `59d8ba2` + 이번 작업을 최신 main 위로 옮긴다 | `59d8ba2` 가 `eef3f2d` 와 중복이면 그 커밋은 drop 해야 한다 |
| ② 이번 작업만 이식 | 최신 `origin/main` 에서 새 브랜치를 따고 이번 5개 변경만 cherry-pick | 가장 안전. `59d8ba2` 의 처분은 따로 결정 |
| ③ 머지 | `main` 을 `origin/main` 으로 맞춘 뒤 `multi-region` 을 머지 | 충돌 수동 해결 필요 (`server.js` 864줄) |

②가 가장 덜 파괴적이다. 어느 쪽이든 **`59d8ba2` 와 `eef3f2d` 가 같은 기능인지**를
먼저 확인해야 한다 — 이 판단은 두 구현을 다 아는 사람이 해야 한다.

### 8-1. 처리 결과 — ② 이식안 실행 (2026-08-26)

`origin/main`(`b28cb5f`)에서 **`multi-region-v2`** 를 따고 이번 작업분만 cherry-pick 했다.

```
git checkout -b multi-region-v2 origin/main
git cherry-pick 2997661
Auto-merging .env.example / README.md / src/server.js   ← 충돌 0건
```

`src/storage.js`·`src/watcher.js` 는 두 브랜치에서 애초에 동일해서 그대로 붙었고,
나머지 3개도 자동 병합됐다. **origin/main 쪽 구조를 그대로 유지**한다.

**`59d8ba2` 와 `eef3f2d` 는 역시 같은 기능의 다른 구현**이었다 — 환경변수 이름이 다르다.

| oom-fix (`59d8ba2`) | origin/main (`eef3f2d` 계열) |
|---|---|
| `MAINTENANCE_HOUR` | `DAILY_RESTART_HOUR` |
| `MAINTENANCE_WINDOW_MIN` | `DAILY_RESTART_WINDOW_MIN` |
| `MAINTENANCE_MIN_UPTIME_MIN` | `DAILY_RESTART_MIN_UPTIME_MIN` |
| `FAIL_RESTART_STREAK` | `SELF_RESTART_AFTER_FAILS` |
| `RESTART_ALERT_PER_DAY` | `SELF_RESTART_MAX_PER_DAY` |
| `RESTART_EXIT_CODE` | (없음 — `exit(1)` 고정) |
| — | `SELF_RESTART_MIN_UPTIME_MIN`, `BACKOFF_AFTER_FAILS`, `BACKOFF_MAX_MIN`, `NODE_MAX_OLD_SPACE_MB` |

**origin/main 쪽이 더 나아가 있다**(백오프·Node 힙 상한·최소 생존 시간까지 있음).
`59d8ba2` 는 이식하지 않고 버렸다 — 중복 구현이라 가져오면 같은 기능이 두 벌이 된다.

> ⚠ **§5 의 환경변수 목록 중 재기동 관련 6개는 이제 위 표의 오른쪽 이름을 쓴다.**
> `MAINTENANCE_*`·`FAIL_RESTART_STREAK`·`RESTART_ALERT_PER_DAY`·`RESTART_EXIT_CODE` 는
> `origin/main` 계열에 존재하지 않는다. 최신 목록은 `.env.example` 을 볼 것.

**보관**: `oom-fix` → `oom-fix-stale`, `origin/multi-region` → `origin/multi-region-stale`
로 이름만 바꿔 남겼다(커밋 `2997661`). 삭제하지 않았다 — **2026-09-02 이후 정리 예정.**

---

## 9. 구현 기록 (A안 — 기본값만, UI 잠금 없음)

`oom-fix` 위에서 5개 파일을 고쳤다.

| 파일 | 변경 |
|---|---|
| `src/storage.js` | `envRegions()` 헬퍼 추가 + `DEFAULT_SETTINGS.regions` 를 `envRegions() \|\| ['서울·인천권']` 로 |
| `src/watcher.js` | `SERVICE_LABEL`·`labelPrefix()` 추가 · `sendTelegram()` 에서 접두 · 테스트 카드 권역 중립화 · `SERVICE_LABEL` export |
| `src/server.js` | `SERVICE_LABEL` import · `labelTag()` 추가 · `<title>`·대시보드 로고·설정 로고에 적용 |
| `.env.example` | `REGION_FILTER`·`SERVICE_LABEL` 항목 + 주의사항 |
| `README.md` | 환경변수 표 2행 + "두 번째 리전 서비스 만들기" 절 (볼륨 공유 금지 경고 포함) |

### 설계 판단

- **`REGION_FILTER` 는 `DEFAULT_SETTINGS` 에만 반영한다.** 저장본 우선순위(`getSettings` 전개 순서)는
  손대지 않았다 → 운영 중인 1번 서비스에 이 변수를 넣어도 **감시 조건이 바뀌지 않는다**.
- **파싱 규칙**: 콤마 분리 · 각 값 `trim` · 빈 값 제거. 결과가 비면 미설정으로 보고 현행 기본값.
  권역명에 가운뎃점(`·`)이 있어 구분자는 콤마만 쓴다.
- **`SERVICE_LABEL` 접두는 `sendTelegram()` 한 곳에서만 붙인다.** 모든 알림 경로가 이 함수를
  통과하므로 경로가 늘어도 자동으로 따라오고, 지금 누락된 경로도 없다.
- **미설정 시 문구가 100% 현행과 동일**하다 — 기존 서비스에 배포해도 보이는 변화가 없다.
- 테스트 알림 더미 카드 권역: `SERVICE_LABEL || '감시 대상 권역'`.

### 검증 (18건 전부 통과)

`node --check` 4파일 통과 + 자식 프로세스 기동 방식 자동 검증(임시 `DATA_DIR` 사용, 실제 볼륨·
텔레그램·사이트 접속 없음):

- **REGION_FILTER 파싱 7건** — 미설정/단일/콤마 다중+공백/빈 문자열/콤마만/꼬리 콤마/가운뎃점 보존
- **저장본 우선순위 3건** — 저장본이 env 를 이김 · 첫 부팅 시 `settings.json` 기록 · 다른 조건 불변
- **SERVICE_LABEL 텔레그램 5건** — 접두 부착 · 본문 유지 · 미설정 시 접두 없음 · 공백만일 때 `[]` 안 붙음
- **테스트 카드 3건** — 라벨 반영 · 중립 문구 · `서울·인천권` 제거 확인

추가로 **실제 서버를 띄워(포트 3999, 임시 `DATA_DIR`, 첫 수집 30초 전에 종료 → 사이트 무접속)**
`SERVICE_LABEL=경기 REGION_FILTER=경기권` 으로 확인:

- 대시보드 `<title>` → `[경기] 새싹 레이더 · 새싹 레이더`
- 대시보드 로고 → `🌱 [경기] 새싹 레이더`
- 설정 페이지 → `<title>[경기] 감시 조건 설정 · 새싹 레이더`, 로고 `🌱 [경기] 감시 조건 설정`
- 설정 화면 권역 체크박스 → **경기권만 `checked`**, 나머지 4개 해제
- 생성된 `settings.json` → `"regions": ["경기권"]`

### 이식 후 재검증 (23건 전부 통과)

`multi-region-v2`(= origin/main 구조) 에서 위 18건을 다시 돌리고, **3종 방어와의 접점 5건을
추가**했다. `node --check` 4파일 통과.

**[5] origin/main 3종 방어(자가 재기동) 계열과의 접점**

- `server.js` 가 `api.telegram.org` 를 직접 호출하지 않는다 → 우회 발송 경로 없음
- `server.js` 는 `watcher` 의 `sendTelegram` 을 import 한다
- `server.js` 의 `sendTelegram` 호출 **3곳** — 재기동 알림 · 반복 재기동 경보 · 감시 정지 감지
- `withTimeout(sendTelegram(html), 10000, '재기동 알림')` **감싼 호출에도 접두가 붙는다**
  (`notifyBeforeExit` 과 같은 호출 모양으로 실제 실행해 확인)
- 재기동 알림 본문은 그대로 유지

→ 접두를 `sendTelegram()` 한 곳에만 붙인 설계 덕분에, **다른 세션이 나중에 추가한
3종 방어 알림 3개도 코드를 더 고치지 않고 라벨을 달았다.** 어긋나는 지점 없음.

**실서버 기동 재확인** (포트 3998, 임시 `DATA_DIR`, 첫 수집 30초 전 종료 → 사이트 무접속).
`SERVICE_LABEL=경기 REGION_FILTER='경기권,강원·충청권' DAILY_RESTART_HOUR=-1`:

- 기동 로그 정상 — `[restart] 자가 재기동 설정 — 정기 재기동 끔 · 연속 실패 5회 · 하루 상한 3회`
- `<title>` `[경기] 새싹 레이더 · 새싹 레이더` / 로고 `🌱 [경기] 새싹 레이더`
- 설정 페이지 `[경기] 감시 조건 설정`
- **권역 체크박스 경기권·강원·충청권 둘 다 `checked`**, 나머지 3개 해제 (콤마 다중 실동작 확인)
- `settings.json` → `"regions": ["경기권", "강원·충청권"]`

### 남은 자잘한 것

- 대시보드 `<title>` 이 `새싹 레이더 · 새싹 레이더` 로 중복된다. **이번 변경 이전부터 있던 것**이고
  (`pageShell('새싹 레이더', …)` + pageShell 이 붙이는 `· 새싹 레이더`), 범위 밖이라 두었다.

---

## 10. 문서 보완 — `.env.example` 누락 (§7-1 마지막 줄)

`ADMIN_PASSWORD`·`PRACTICE_PASSWORD` 둘 다 코드는 읽고 있는데(`server.js` `authEnabled()` /
`practiceEnabled()`) `.env.example` 에는 항목이 없었다. `ADMIN_PASSWORD` 는 README 표에만
있었고, `PRACTICE_PASSWORD` 는 표에도 없어 **두 등급 구조 자체가 문서에서 보이지 않았다.**

- `.env.example` — 두 변수 추가. `ADMIN_PASSWORD` 는 보호 대상·공개 유지 목록까지 적었다
  (비우면 보호가 통째로 꺼지는 값이라 배포에서 빠뜨리면 설정·수집 버튼이 그대로 열린다)
- `README.md` 환경변수 표 — `PRACTICE_PASSWORD` 행 추가
