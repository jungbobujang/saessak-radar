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

// 브라우저를 띄우고 → 일을 시키고 → 무슨 일이 있어도 닫는다.
//
// 이 함수가 지키는 것 두 가지:
//  ① 전체 상한(SCRAPE_TIMEOUT_MS). 어느 단계가 매달려도 90초 안에 예외로 끝난다.
//  ② 정리. 컨텍스트·브라우저를 finally 에서 닫는다. 타임아웃으로 빠져나갈 때도 여기를
//     지나므로, 매달린 page.evaluate 는 브라우저가 닫히면서 함께 죽는다.
//     닫기가 실패해도(이미 죽은 프로세스 등) 삼킨다 — 다음 주기를 막을 이유가 없다.
//
// 수집 1회마다 새로 띄우고 끝나면 완전히 종료한다. 브라우저를 재사용하면 세션·메모리가
// 쌓이고, 한 번 이상해진 인스턴스가 이후 모든 주기를 오염시킨다.
async function runInBrowser(label, fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    timeout: LAUNCH_TIMEOUT_MS,
  });
  let context;
  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    return await withTimeout(fn(page), SCRAPE_TIMEOUT_MS, `스크래퍼(${label})`);
  } finally {
    try {
      if (context) await context.close();
    } catch (e) {
      console.warn(`[scraper] ${label} context.close 실패(무시):`, e.message);
    }
    try {
      await browser.close();
    } catch (e) {
      console.warn(`[scraper] ${label} browser.close 실패(무시):`, e.message);
    }
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
