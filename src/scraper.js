'use strict';

const { chromium } = require('playwright');
const { canonicalFull } = require('./classify');

const ORIGIN = 'https://newsac.kosac.re.kr';
// 사람이 보는 목록 페이지 (참고용)
const LIST_URL = `${ORIGIN}/?operationStatusCode=C1101,C1102`;
// JS로 로딩되는 실제 데이터 소스 (JSON API). 목록 페이지가 내부적으로 호출한다.
const API_PATH = '/newsac/api/v1/programs/user';
// 프로그램 상세 API (신청기간 시각/차시/신청대상 등). programId 로 조회.
const DETAIL_API = '/newsac/api/v1/programs';
const DETAIL_BASE = `${ORIGIN}/public/program/thumb`;

// ---- 사이트 API 스펙 (2026-08 변경 대응) ----------------------------------
// 사이트가 목록 API 호출에 season(시즌 연도) + version(API 버전) 을 함께 보내도록
// 바뀌었다. 이 둘이 빠진 호출은 "인증 필요" 로 거절될 수 있으므로 항상 붙인다.
// - season : 연도가 바뀌면 SEASON_YEAR 환경변수만 교체하면 된다 (코드 수정 불필요)
// - version: 현재 사이트가 쓰는 값 'v2'. v2 는 지난 시즌 잔여분을 걸러낸
//            "사이트 화면과 동일한" 모집 목록을 돌려준다.
const API_VERSION = 'v2';
function seasonYear() {
  return String(process.env.SEASON_YEAR || '2026');
}

// 코드 → 사람이 읽는 값 매핑 (사이트 실제 값 기준)
const STATUS_MAP = {
  C1101: '모집 예정',
  C1102: '모집 중',
  C1103: '모집 완료',
};
const TYPE_MAP = {
  C0101: '방문형',
  C0102: '집합형',
};
// 프로그램 수준(G004) — 사이트 필터 UI 실측값. 프로그램당 반드시 1개다.
// 감시 조건에서는 제외한다(요청 파라미터 미전송) → 기본·특화·AI특화 전부 통과.
// 수준은 프로그램당 하나뿐이라 여러 개를 AND 로 걸면 결과가 0건이 되기 때문.
// 훗날 설정에 노출한다면 '단일 선택(라디오)' + 기본값 '전체' 로 만들 것.
const LEVEL_MAP = {
  C0401: '기본',
  C0402: '특화',
  C0403: 'AI특화',
};
// 프로그램 소양(G003) — 사이트 필터 UI 실측값. 역시 감시 조건에 쓰지 않고 표기용으로만 보관.
const COMPETENCE_MAP = {
  C0301: '컴퓨팅 사고력',
  C0302: '인공지능 소양',
  C0303: '디지털 리터러시',
  C0304: '데이터 소양',
};

// ---- 타임아웃 ------------------------------------------------------------
// page.evaluate 는 기본 타임아웃이 없다. 페이지 안 fetch 가 응답을 영원히 안 주면
// evaluate 가 영원히 매달리고, 그러면 scrape → checkOnce → 스케줄러 체인이 통째로
// 멈춘다(다음 주기를 예약하는 코드에 도달하지 못한다). 실제로 그렇게 감시가 죽었다.
// 그래서 ① 페이지 안 fetch 마다 AbortSignal 로 개별 타임아웃을 걸고,
//        ② evaluate 전체에도 상한을 둔다. 상한을 넘기면 예외로 끝나 finally 의
//           browser.close() 가 돌고(= 매달린 evaluate 도 함께 죽는다) 다음 주기가 산다.
const IN_PAGE_FETCH_TIMEOUT_MS = 20000; // 사이트 API 1건당 상한
const LIST_EVAL_TIMEOUT_MS = 60000;     // 목록 페이지네이션 전체 상한
const DETAIL_EVAL_TIMEOUT_MS = 60000;   // 상세 순차 조회 전체 상한
const LAUNCH_TIMEOUT_MS = 30000;        // 크롬 기동
const GOTO_TIMEOUT_MS = 30000;          // page.goto
const IDLE_TIMEOUT_MS = 20000;          // networkidle 대기(넘겨도 계속 진행)
// 스크래퍼 1회(기동+접속+수집+정리) 전체 상한. 안쪽 상한들의 합보다 작게 잡아
// 무엇이 늦든 90초 안에는 반드시 끝나게 한다. 서버의 사이클 상한(4분)보다 훨씬 짧아야
// 사이클이 끊기기 전에 스크래퍼가 스스로 브라우저를 닫는다.
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS) || 90000;

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    const human = ms >= 1000 ? `${Math.round(ms / 1000)}초` : `${ms}ms`;
    timer = setTimeout(() => reject(new Error(`${label} 타임아웃 (${human} 초과)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---- 크로뮴 launch 인자 --------------------------------------------------
// 헤드리스 수집에만 쓰는 브라우저다. 화면에 그릴 일도, 사람이 볼 일도 없다.
// 그래서 '띄우지 않아도 되는 부속' 만 끈다. 여기 있는 것은 전부 페이지의 DOM·네트워크·
// JS 실행에 관여하지 않는다 — 수집 결과가 달라질 여지가 없다.
//
// 일부러 쓰지 않는 것들. 메모리는 더 줄지만, 수집 결과나 실패 양상을 바꿀 수 있어서
// 실사이트로 검증하기 전에는 배포에 태우지 않는다.
//   · --single-process        : 감량폭이 가장 크지만 크로뮴이 자주 죽는다.
//   · --renderer-process-limit=1 : 같은 프로세스 모델 조작 계열. 페이지 하나만 열므로
//     실질 영향은 없어 보이지만, 사이트 구성이 바뀌면 얘기가 달라진다.
//   · --blink-settings=imagesEnabled=false : 이미지 디코딩 메모리를 크게 줄인다.
//     데이터는 페이지 안 fetch(JSON)로 받으니 이론상 무관하고 실제로 카드 317건이
//     완전히 같게 나온 적도 있지만, 페이지가 무엇을 기다리는지를 바꾸는 옵션이다.
//   · --js-flags=--max-old-space-size=... : 렌더러 V8 힙 상한. 페이로드가 커지면
//     수집이 성공하던 자리에서 렌더러가 죽는 새 실패 경로가 생긴다.
// 되살릴 때는 반드시 실사이트 수집 결과를 감량 전과 대조한 뒤에.
//
// 주의: --disable-features=... 를 직접 넘기지 않는다. Playwright 가 이미 자체 목록을
//       넘기고 있고, 같은 스위치를 또 주면 뒤엣것이 앞엣것을 통째로 덮어써서
//       Playwright 가 끈 기능들이 되살아난다.
// 주의: --disable-dev-shm-usage 는 Playwright 기본값에도 이미 있다. 의도 표시로 남긴다.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // GPU 프로세스를 아예 띄우지 않는다. 헤드리스라 쓰지도 않는데 프로세스 하나를 통째로 먹는다.
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-accelerated-2d-canvas',
  // 켜 둘 이유가 없는 부속
  '--disable-sync',
  '--mute-audio',
];

// 정리(close) 한 건당 상한. 이미 죽은 프로세스를 닫으려다 여기서 매달리면
// 다음 수집이 막히므로 반드시 상한을 건다.
const CLOSE_TIMEOUT_MS = 15000;
// 앞선 수집이 브라우저를 놓기를 기다리는 상한. 스크래퍼 1회 상한보다 넉넉히 크게 잡아
// 정상 수집을 억울하게 죽이지 않는다.
const GATE_WAIT_MS = SCRAPE_TIMEOUT_MS + 15000;

// ---- 살아 있는 브라우저 장부 ----------------------------------------------
// 강제 종료(죽은 락 해제·워치독 재시작) 때 '기존 크로뮴을 확실히 죽이고 새로 띄우기'
// 위해 필요하다. 이 장부가 없으면 새 사이클이 헌 크로뮴 위에 겹쳐 떠서 메모리가 두 배가 된다.
const liveBrowsers = new Set();

// 닫기에 실패한 브라우저의 누적 실패 횟수. 두 번 실패하면 마지막 수단(SIGKILL)을 쓴다.
const closeFailures = new Map();

/**
 * 닫기를 시도하고 '실제로 닫혔는지' 를 돌려준다.
 * 예전에는 결과를 버렸는데, 그러면 호출자가 "닫혔다고 치고" 장부에서 지워 버려
 * 못 닫은 크로뮴이 추적 불가능한 고아가 된다(≈334MB). 그래서 성공 여부를 반드시 돌려준다.
 */
async function closeQuietly(label, what, obj) {
  if (!obj) return true;
  try {
    await withTimeout(Promise.resolve(obj.close()), CLOSE_TIMEOUT_MS, `${label} ${what}.close`);
    return true;
  } catch (e) {
    // 이미 죽은 프로세스를 닫으려는 경우가 대부분이다. 다음 주기를 막을 이유가 없다.
    console.warn(`[scraper] ${label} ${what}.close 실패(무시): ${e.message}`);
    return false;
  }
}

// 마지막 수단. close() 가 두 번 실패한 브라우저는 OS 에게 직접 죽여 달라고 한다.
// playwright 의 browser.process() 는 로컬 기동일 때만 자식 프로세스를 준다(원격이면 null).
function hardKill(browser) {
  try {
    const proc = typeof browser.process === 'function' ? browser.process() : null;
    if (proc && typeof proc.kill === 'function') {
      proc.kill('SIGKILL');
      return true;
    }
  } catch (e) {
    console.error(`[scraper] SIGKILL 실패: ${e.message}`);
  }
  return false;
}

/**
 * 지금 살아 있는 크로뮴을 전부 닫는다. 실제로 정리된 개수를 돌려준다.
 * 스케줄러가 '죽은 락' 을 강제로 풀거나 워치독이 루프를 재시작할 때, 새 수집을 띄우기
 * 전에 반드시 이걸 먼저 부른다. 매달린 page.evaluate 도 브라우저가 죽으면 함께 끝난다.
 *
 * 닫기에 실패한 브라우저는 장부에 남겨 둔다 — 다음 기회에 다시 시도하기 위해서다.
 * 두 번째 실패부터는 SIGKILL 로 끝낸다(그래도 안 죽으면 장부에 남겨 계속 시도한다).
 */
async function closeAllBrowsers(reason) {
  const list = Array.from(liveBrowsers);
  if (list.length === 0) return 0;
  console.warn(`[scraper] 살아 있는 브라우저 ${list.length}개를 강제로 닫습니다 (${reason})`);
  let cleaned = 0;
  await Promise.all(
    list.map(async (b) => {
      const ok = await closeQuietly('강제 정리', 'browser', b);
      if (ok) {
        liveBrowsers.delete(b);
        closeFailures.delete(b);
        cleaned += 1;
        return;
      }
      const fails = (closeFailures.get(b) || 0) + 1;
      closeFailures.set(b, fails);
      if (fails >= 2) {
        const killed = hardKill(b);
        console.error(
          `[scraper] 브라우저 닫기 ${fails}회 실패 — ` +
            (killed ? 'SIGKILL 로 강제 종료했습니다' : 'SIGKILL 도 불가(장부에 남겨 재시도)')
        );
        if (killed) {
          liveBrowsers.delete(b);
          closeFailures.delete(b);
          cleaned += 1;
          return;
        }
      }
      console.warn(
        `[scraper] 브라우저를 닫지 못했습니다(${fails}회) — 장부에 남겨 다음 기회에 다시 시도합니다`
      );
    })
  );
  return cleaned;
}

// 지금 장부에 남아 있는(=아직 못 닫은) 브라우저 수. /health 가 읽어 '터지기 전'을 보여 준다.
function liveBrowserCount() {
  return liveBrowsers.size;
}

// ---- 브라우저 단일화 게이트 ------------------------------------------------
// 크로뮴은 인스턴스끼리 메모리를 나눠 쓰지 않는다. 실측상 1개 ≈ 334MB, 2개 ≈ 654MB 로
// 정직하게 두 배다. 그래서 "이 프로세스 안에서 크로뮴은 언제나 1개" 를 여기서 강제한다.
//
// 앞 순번이 끝나기를 기다리되 무한정 기다리지는 않는다. GATE_WAIT_MS 를 넘기면
// 앞 순번을 강제로 죽이고 진행한다 — 기다리기만 하면 2026-08-18 의 '감시 정지' 가 재현된다.
let gateTail = Promise.resolve();

function acquireGate(label) {
  const prev = gateTail;
  let release;
  const mine = new Promise((r) => {
    release = r;
  });
  // 다음 대기자는 '내 차례가 끝난 뒤' 를 기다린다 → 대기자가 여럿이어도 한 줄로 선다.
  gateTail = prev.then(() => mine, () => mine);

  // 이 함수는 절대로 거절(reject)되면 안 된다.
  // 거절되면 호출자가 release 를 받지 못한 채 빠져나가는데, gateTail 은 이미 mine 을
  // 기다리도록 바뀐 뒤라 그 mine 이 영영 안 풀린다 → 이후 모든 수집이 게이트에서 막힌다.
  // 그래서 본문 전체를 감싸고, 무슨 일이 있어도 release 를 돌려준다.
  return (async () => {
    try {
      let timer;
      const timedOut = await Promise.race([
        prev.then(() => false, () => false),
        new Promise((r) => {
          timer = setTimeout(() => r(true), GATE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        console.error(
          `[scraper] ${label}: 앞선 수집이 ${Math.round(GATE_WAIT_MS / 1000)}초째 브라우저를 놓지 않습니다 — ` +
            '강제 종료하고 진행합니다'
        );
        await closeAllBrowsers(`${label} 대기 초과`);
        // 브라우저가 죽으면 앞 순번은 곧 예외로 끝나며 게이트를 놓는다.
        // 그래도 안 풀리는 경우까지 여기서 붙들리지 않도록 짧게만 더 기다린다.
        await Promise.race([
          prev.then(() => null, () => null),
          new Promise((r) => setTimeout(r, 10000)),
        ]);
      }
    } catch (e) {
      console.error(`[scraper] ${label}: 게이트 대기 중 예외(무시하고 진행): ${e.message}`);
    }
    return release;
  })();
}

// 브라우저를 띄우고 → 일을 시키고 → 무슨 일이 있어도 닫는다.
//
// 이 함수가 지키는 것 네 가지:
//  ① 단일화. 게이트를 통과한 하나만 크로뮴을 띄운다 (동시 2개 → 메모리 두 배 차단).
//  ② 전체 상한(SCRAPE_TIMEOUT_MS). 어느 단계가 매달려도 90초 안에 예외로 끝난다.
//  ③ 정리. page → context → browser 를 finally 에서 순서대로 닫는다. 앞엣것이 실패해도
//     뒤엣것을 반드시 시도하고, 각각에 상한이 걸려 있어 정리 중에 매달리지 않는다.
//     타임아웃으로 빠져나갈 때도 여기를 지나므로 매달린 page.evaluate 도 함께 죽는다.
//  ④ 게이트 반납. launch 가 실패해도 finally 에서 반드시 놓는다 — 안 놓으면 이후 수집이
//     전부 게이트에서 막힌다.
//
// 수집 1회마다 새로 띄우고 끝나면 완전히 종료한다. 브라우저를 재사용하면 세션·메모리가
// 쌓이고, 한 번 이상해진 인스턴스가 이후 모든 주기를 오염시킨다.
async function runInBrowser(label, fn) {
  const release = await acquireGate(label);
  let browser;
  let context;
  let page;
  try {
    browser = await chromium.launch({
      headless: true,
      args: LAUNCH_ARGS,
      timeout: LAUNCH_TIMEOUT_MS,
    });
    liveBrowsers.add(browser);
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1366, height: 900 },
    });
    page = await context.newPage();
    return await withTimeout(fn(page), SCRAPE_TIMEOUT_MS, `스크래퍼(${label})`);
  } finally {
    await closeQuietly(label, 'page', page);
    await closeQuietly(label, 'context', context);
    if (browser) {
      // 순서가 중요하다. 예전에는 장부에서 먼저 지우고 닫았는데, close 가 15초 상한을
      // 넘겨 실패하면 그 크로뮴은 장부에 없으니 closeAllBrowsers 가 영영 못 찾는
      // 고아(≈334MB)가 됐다. 실제로 닫힌 것만 장부에서 뺀다.
      const ok = await closeQuietly(label, 'browser', browser);
      if (ok) {
        liveBrowsers.delete(browser);
        closeFailures.delete(browser);
      } else {
        console.error(
          `[scraper] ${label}: 브라우저를 닫지 못해 장부에 남겨 둡니다 — ` +
            '다음 closeAllBrowsers 에서 다시 시도합니다'
        );
      }
    }
    release();
  }
}

function pad2(x) {
  return String(x == null ? '' : x).padStart(2, '0');
}

// 날짜(YYYY-MM-DDT...) + HH + mm → KST ISO 문자열 (시각까지 정확)
function buildAt(dateStr, HH, mm) {
  const ymd = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return `${ymd}T${pad2(HH != null ? HH : '00')}:${pad2(mm != null ? mm : '00')}:00+09:00`;
}

// 상세 API 응답 → 표준 detail 객체
function mapDetail(programId, b) {
  const targetNames = (b.target || [])
    .map((t) => t.codeInfo && t.codeInfo.codeName)
    .filter(Boolean)
    .map(canonicalFull); // 구 분류 라벨 → 새 정식 라벨 정규화(비분류 값은 원문 유지)
  const grades = (b.elementarySchool || [])
    .concat(b.middleSchool || [], b.highSchool || [])
    .map((x) => x.codeInfo && x.codeInfo.codeName)
    .filter(Boolean);
  return {
    id: 'p_' + programId,
    programId,
    institution: (b.institution && b.institution.institutionName) || b.institutionName || '',
    status: STATUS_MAP[b.operationStatusCode] || '',
    applyStartAt: buildAt(b.applyStartDate, b.applyStartHH, b.applyStartmm),
    applyEndAt: buildAt(b.applyEndDate, b.applyEndHH, b.applyEndmm),
    eduStartAt: buildAt(b.educationStartDate, b.educationStartHH, b.educationStartmm),
    eduEndAt: buildAt(b.educationEndDate, b.educationEndHH, b.educationEndmm),
    totalChapters: b.totalEducationClassChapter != null ? b.totalEducationClassChapter : null, // 총 차시
    capacityClasses: b.courseCnt != null ? b.courseCnt : null, // 정원(모집 학급)
    approvedClasses: b.courseApprovedCount != null ? b.courseApprovedCount : null, // 승인
    pendingClasses: b.coursePendingCount != null ? b.coursePendingCount : null, // 대기
    targetNames, // 신청 대상
    grades,
    levelCode: b.levelCode || '',
    level: LEVEL_MAP[b.levelCode] || b.levelCode || '',
    competenceCode: b.competenceCode || '',
    competence: COMPETENCE_MAP[b.competenceCode] || b.competenceCode || '',
    fetchedAt: new Date().toISOString(),
  };
}

function mapItem(item) {
  const status = STATUS_MAP[item.operationStatusCode] || '';
  const type = TYPE_MAP[item.programTypeCode] || '';

  // 권역: "서울·인천권,경기권,..." 복수 표기 → 배열
  const regions = String(item.programRegionName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 학교급: 학교급 카운트 필드로 판정 (초/중/고)
  const levels = [];
  if ((item.elementarySchoolCnt || 0) > 0) levels.push('초등학교');
  if ((item.middleSchoolCnt || 0) > 0) levels.push('중학교');
  if ((item.highSchoolCnt || 0) > 0) levels.push('고등학교');

  // 교육대상 태그: "일반형,사회적 배려형(도서벽지)" → 배열
  // 개편 대응: 구 라벨은 새 정식 라벨로 정규화. 알 수 없는 신설 라벨은 원문 유지
  // (수집은 그대로 하되, 매칭/표기 계층에서 '미분류'로 취급하고 별도 알림).
  const tags = String(item.targetName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(canonicalFull);

  const id = item.programId ? 'p_' + item.programId : null;
  const link = item.programId ? `${DETAIL_BASE}/${item.programId}` : LIST_URL;

  return {
    id,
    programId: item.programId || null,
    title: (item.programName || '').trim() || '(제목 미상)',
    status,
    type,
    regions,
    levels,
    tags,
    institution: item.institutionName || '',
    link,
    // 모집 학급 수치 (목록 API에 이미 존재 → 매 사이클 최신 유지)
    capacityClasses: item.courseCnt != null ? item.courseCnt : null, // 정원(모집 학급)
    approvedClasses: item.courseApprovedCount != null ? item.courseApprovedCount : null, // 승인
    pendingClasses: item.coursePendingCount != null ? item.coursePendingCount : null, // 대기
  };
}

/**
 * 페이지 컨텍스트 안에서 API를 페이지네이션하며 전부 수집한다.
 * (브라우저 세션/헤더/오리진을 그대로 물려받으므로 차단 위험이 낮다.)
 *
 * 교육대상(targetCode)·권역·학교급 필터는 일부러 서버에 보내지 않는다.
 * 전량을 받아 watcher 쪽에서 설정으로 거르는 구조라야
 *  ① 설정을 바꿔도 재수집이 필요 없고 ② 신설/변경된 분류를 '미분류'로 잡아낼 수 있다.
 * (모집 상태만 C1101,C1102 로 좁혀 응답량을 줄인다.)
 */
async function fetchAllInPage(page, apiPath, season, version) {
  const work = page.evaluate(
    async ({ apiPath, season, version, fetchTimeoutMs }) => {
      const size = 100; // 페이지당 최대치. 아래에서 끝까지 순회한다.
      let pageNo = 1;
      let all = [];
      let guard = 0;
      while (guard++ < 50) {
        const url =
          apiPath +
          `?operationStatusCode=C1101,C1102&page=${pageNo}&size=${size}` +
          `&season=${encodeURIComponent(season)}&version=${encodeURIComponent(version)}`;
        // 응답이 영영 안 오는 경우(오픈 직후 사이트 폭주 등)를 끊는다.
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        if (!res.ok) throw new Error('API 응답 오류 status=' + res.status);
        const j = await res.json();
        const content = j.content || [];
        all = all.concat(content);

        const totalCount =
          j.totalCount != null ? j.totalCount : j.totalElements != null ? j.totalElements : null;
        const totalPages =
          j.totalPageCount != null ? j.totalPageCount : j.totalPages != null ? j.totalPages : null;

        if (content.length < size) break;
        if (totalCount != null && all.length >= totalCount) break;
        if (totalPages != null && pageNo >= totalPages) break;
        pageNo++;
      }
      return all;
    },
    { apiPath, season, version, fetchTimeoutMs: IN_PAGE_FETCH_TIMEOUT_MS }
  );
  return await withTimeout(work, LIST_EVAL_TIMEOUT_MS, '목록 API 수집');
}

/**
 * 메인 진입점. 성공 시 카드 배열 반환.
 * 카드가 0개면 에러를 던져 잘못된 "전부 사라짐" diff 방지.
 */
async function scrape() {
  return await runInBrowser('목록 수집', async (page) => {
    console.log('[scraper] 접속:', LIST_URL);
    // 세션/오리진 확보 (SPA 부트스트랩). networkidle까지 대기.
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {
      console.log('[scraper] networkidle 타임아웃 — 계속 진행');
    });

    const season = seasonYear();
    console.log(`[scraper] 시즌: ${season} (version=${API_VERSION})`);

    const rawItems = await fetchAllInPage(page, API_PATH, season, API_VERSION);
    const cards = rawItems
      .map(mapItem)
      .filter((c) => c.id && c.status && c.status !== '모집 완료');
    // (API에 C1101,C1102만 요청하므로 완료는 거의 없지만 방어적으로 제외)

    console.log(
      `[scraper] 프로그램 ${rawItems.length}건 수신 → 유효 카드 ${cards.length}개`
    );

    if (!cards || cards.length === 0) {
      throw new Error('카드를 0개 수집함 (API/렌더링 문제 가능) — diff 스킵');
    }

    return cards;
  });
}

/**
 * 지정한 programId 들의 상세 정보만 수집한다. (조건 통과분만 넘어오므로 요청량이 작다)
 * 하나의 브라우저 세션에서 SPA 부트스트랩 후 상세 API를 순차 호출한다.
 * @param {number[]} programIds
 * @returns {Object<string, detail>} id('p_<pid>') → detail 맵
 */
async function fetchDetails(programIds) {
  const ids = Array.from(new Set((programIds || []).filter((x) => x != null)));
  if (ids.length === 0) return {};

  return await runInBrowser('상세 수집', async (page) => {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});

    // 상세 API 는 현재 season·version 없이도 동일한 응답을 준다(실측 확인).
    // 다만 목록 API 처럼 언제든 필수가 될 수 있어 같은 파라미터를 함께 보낸다.
    const detailWork = page.evaluate(
      async ({ apiBase, ids, season, version, fetchTimeoutMs }) => {
        const qs = `?season=${encodeURIComponent(season)}&version=${encodeURIComponent(version)}`;
        const out = {};
        for (const pid of ids) {
          try {
            // 1건이 매달리면 전체가 매달린다. 건마다 상한을 걸고 실패는 그 건만 버린다.
            const r = await fetch(apiBase + '/' + pid + qs, {
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(fetchTimeoutMs),
            });
            out[pid] = r.ok ? await r.json() : { __error: 'status ' + r.status };
          } catch (e) {
            out[pid] = { __error: String(e && e.message ? e.message : e) };
          }
        }
        return out;
      },
      {
        apiBase: DETAIL_API,
        ids,
        season: seasonYear(),
        version: API_VERSION,
        fetchTimeoutMs: IN_PAGE_FETCH_TIMEOUT_MS,
      }
    );
    const bodies = await withTimeout(detailWork, DETAIL_EVAL_TIMEOUT_MS, '상세 API 수집');

    const result = {};
    for (const pid of ids) {
      const b = bodies[pid];
      if (!b || b.__error) {
        console.warn(`[scraper] 상세 수집 실패 pid=${pid}:`, b && b.__error);
        continue;
      }
      const d = mapDetail(pid, b);
      result[d.id] = d;
    }
    console.log(`[scraper] 상세 수집 ${Object.keys(result).length}/${ids.length}건`);
    return result;
  });
}

module.exports = {
  scrape,
  fetchDetails,
  closeAllBrowsers,
  liveBrowserCount,
  closeQuietly,
  // 브라우저 수명주기(단일화 게이트·강제 종료·정리)를 사이트 없이 검증하기 위해 노출한다.
  // 수집 로직에서 이걸 직접 부를 일은 없다 — scrape/fetchDetails 를 쓴다.
  runInBrowser,
  // 고아 크로뮴 회수를 가짜 browser 객체로 검증하기 위한 장부 자체. 테스트 전용이다.
  liveBrowsers,
  withTimeout,
  mapDetail,
  seasonYear,
  API_VERSION,
  LIST_URL,
  STATUS_MAP,
  TYPE_MAP,
  LEVEL_MAP,
  COMPETENCE_MAP,
};
