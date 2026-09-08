# 작업 리포트 — 모션 피드백 4종

- 작업: 2026-09-08
- 저장소: `jungbobujang/saessak-radar`
- 브랜치: `main` (직접 작업)
- 기준 커밋: `ec8faee`
- 검증 방식: 실제 `src/server.js` 를 그대로 띄우고(포트 4399), 임시 계측 페이지를
  `public/_probe.html` 에 두어 **`<iframe width=375>`** 안에 `/` 와 `/practice` 를 띄운 뒤
  헤드리스 크롬으로 찍었다. 판정은 전부 브라우저 런타임 값이다 —
  `document.getAnimations()` · `getComputedStyle().width` · `getBoundingClientRect()`.
  소스 grep 만으로 "됐다" 고 적은 항목은 없다. 계측 페이지는 확인 후 삭제했다.

## 한 줄 요약

4종 중 **3종 구현 · 1종은 대상이 없어 건너뜀**(로딩 스켈레톤이 애초에 없다).
움직임 켠 상태에서 `sr-pulse` · `sr-shake` · `sr-bounce` + 게이지 전환이 전부 관측되고,
`prefers-reduced-motion` 에서는 **두 화면 모두 실행 중 애니메이션 0개**로 떨어진다.

---

## 1. pulse — '모집 중' 뱃지 · D-DAY 칩

`@keyframes sr-pulse` (2s · `scale(1) → 1.04` · `ease-in-out` · infinite), 거는 곳은 딱 두 군데다.

```css
.pr-badge-open,
.rail-dday-now.rail-pulse { animation: sr-pulse 2s ease-in-out infinite; }
```

**"동시에 3개 넘으면 실패" 를 실제로 어겼다 — 그래서 상한을 코드로 박았다.**
착수 시점 데이터로 그려 보니 `rail-dday-now`(오늘 오픈) 가 **6개** 나왔다.
D-day 계산은 지난 날짜도 `dd <= 0` 으로 접기 때문에, 오픈일시가 지난 건이 쌓이면
D-DAY 레일이 계속 늘어난다. 화면에서 여섯 개가 같이 뛰면 신호가 아니라 소음이다.

`renderPlanner()` 에서 **가장 임박한 3개까지만** `rail-pulse` 를 붙인다.
`open` 배열이 이미 신청 시작 오름차순이라 앞에서부터 세면 임박한 순이 된다.

```
서버 출력 검증: 마크업 rail-dday-now = 6개 · rail-pulse = 3개
```

'신규' · '정보 변경' · '모집 시작' · D-N 레일에는 걸지 않았다.
선택자를 `.rail-dday-now.rail-pulse` 로 못박아, 클래스 없는 D-DAY 레일은 안 뛴다.

```
주입 검증(브라우저): rail-pulse 붙은 D-DAY = 1개 뜀 · 안 붙은 D-DAY = 0개
```

## 2. 잔여 게이지 차오름 (0 → 실제값 400ms)

서버는 지금까지처럼 인라인 `style="width:63%"` 를 그대로 심는다. 로드 직후 JS 가
한 프레임 `0%` 로 눌렀다가 `.g3-anim`(`transition: width 400ms ease-out`) 을 붙여 되돌린다.

**JS 가 죽어도 인라인 값이 남으므로 수치는 틀어지지 않는다** — 차오르는 연출만 사라진다.
서버 렌더 값을 0 으로 내보내고 JS 로 채우는 방식은 스크립트가 실패하면 게이지가
빈 채로 굳어 잔여를 0 으로 오독하게 만들어서 쓰지 않았다.

```
계산된 폭 실측: 30ms 18.6px → 120ms 67.4px → 260ms 116.4px → 700ms 137.97px
```

원칙(`transform`·`opacity` 만)에서 벗어나는 유일한 항목이다. 지시에 `(width transition)`
이 명시돼 있고, 기존 `.g3` 가 `overflow:hidden` 안에 두 조각을 `flex` 로 붙여 놓은 구조라
`scaleX` 로 바꾸면 두 조각의 경계와 둥근 끝이 같이 늘어난다. 기존 구조를 덜 건드리는 쪽을 골랐다.

## 3. shake · bounce — 신청 연습

- **헛클릭**: 잠긴 `[신청하기]` 를 누르면 `shakeOnce()` 로 300ms 1회.
- **오답 항목**: 채점에서 틀린 칸마다 300ms 1회.
- **신기록**: 결과 화면이 신기록이면 기록 숫자(`.pr-ms`)만 `sr-bounce` 520ms 1회.
  트로피 태그는 가만히 둔다 (한 줄에서 둘이 같이 튀면 장식이 된다).

**`.pf-bad` 에 애니메이션을 직접 걸면 두 번째 제출부터 안 흔들린다.**
제출 핸들러가 `clearMarks()` 로 `.pf-bad` 를 떼고 같은 태스크 안에서 `grade()` 가 다시 붙이는데,
한 프레임 안의 제거+추가는 애니메이션을 되감지 않는다. 그래서 흔들기는 별도 클래스
`.sr-shake` 로 빼고, `shakeOnce()` 가 `void node.offsetWidth` 로 리플로우를 강제해 되감는다.

표시와 흔들기가 어긋나지 않도록 `markBad(node)` 하나로 묶고, `classList.add('pf-bad')` 를
직접 부르던 4곳(주소·대상·일시 3칸·약관)을 전부 이 함수로 돌렸다.

```
브라우저 실측: 헛클릭 후 sr-shake=true
실행 중 애니메이션 3 {"sr-bounce":1, "sr-pulse":1, "sr-shake":1}
```

## 4. 로딩 스켈레톤 → shimmer — **건너뜀 (대상 없음)**

스켈레톤이 이 앱에 없다. 로딩 표시는 주소 검색의 텍스트 한 줄
(`<div class="pf-results-ph pf-loading">검색 중…</div>`) 이 전부다.
지시가 "있으면 교체" 였으므로 **스켈레톤을 새로 만들지는 않았다** — 없는 UI 를 지어내는 건
모션 작업의 범위가 아니라고 봤다. 스켈레톤을 도입하기로 하면 그때 shimmer 를 같이 넣으면 된다.

---

## 검증 결과

움직임 켠 상태 / `--force-prefers-reduced-motion` 두 번 찍어 대조했다.

| 항목 | 기본 | reduced-motion |
| --- | --- | --- |
| 대시보드 실행 중 애니메이션 | 1 (`sr-pulse`, 주입한 검증용 D-DAY) | **0** |
| 연습 실행 중 애니메이션 | 3 (`sr-bounce`·`sr-pulse`·`sr-shake`) | **0** |
| 게이지 계산폭 (30ms→700ms) | 18.6 → 137.97px (차오름) | 137.97 → 137.97px (즉시) |
| `g3-anim` 클래스 | true | **false** (JS 가 `matchMedia` 로 아예 건너뜀) |
| 헛클릭 `sr-shake` | true | **false** |
| 신기록 숫자 `transform` | 애니메이션 중 | **none** |

`prefers-reduced-motion` 은 CSS(`animation:none`·`transition:none`) 와 JS(`matchMedia` 가드)
양쪽에서 막는다. JS 를 같이 막는 이유는, CSS 로 전환만 끄면 게이지가 `0% → 실제값` 을
한 프레임 안에 점프해 깜빡이기 때문이다.

### 375px 회귀

`<iframe width=375>` 안에서 잰 값이다.

| 화면 | 문서 scrollWidth | 넘치는 요소 |
| --- | --- | --- |
| 대시보드 | 375 | 3 (`SPAN.condchip`) |
| 신청 연습 | 375 | 0 |

`condchip` 3건은 **이번 변경 전에도 똑같이 나온다.** 확인하려고 `src/server.js` 를
`git stash` 로 되돌린 뒤 같은 계측을 다시 돌려 값이 동일한 것을 봤다
(`condchip@394 · @459 · @578`). 감시 조건 칩 줄이 원래 가로 스크롤이고,
문서 `scrollWidth` 는 375 로 유지되므로 화면이 옆으로 밀리지는 않는다. 회귀 아님.

## 못 한 것 / 남는 것

- **4번 shimmer** — 위 4항 참고. 스켈레톤 자체가 없어 건너뛰었다.
- **D-DAY pulse 를 실제 데이터로 화면 확인하지 못함** — 계측 도중 워처가 돌아
  현재 사이클이 '모집 예정 6 / 모집 중 0' 에서 '모집 중 4' 로 바뀌면서 D-DAY 레일이 0개가 됐다.
  그래서 상한 3개는 **서버 출력(6개 중 3개에 클래스)** 으로, 뛰는 동작은 **DOM 주입** 으로
  나눠 확인했다. 실제 D-DAY 건이 있는 날 화면으로 한 번 더 보면 좋다.
- **`ddayKst` 가 지난 날짜를 D-DAY 로 접는 문제** — 이번에 pulse 상한을 넣게 만든 원인이지만
  표기 규칙 자체를 바꾸는 건 모션 작업의 범위 밖이라 손대지 않았다.
  "오늘 오픈" 이라고 적힌 것 중 상당수가 실은 지난 건이라면 따로 볼 문제다.
