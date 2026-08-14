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
// 프로그램 수준/소양 코드 (코드명 API가 막혀 있어 알려진 값만 매핑, 미상은 코드 그대로 보존)
const LEVEL_MAP = {
  C0401: '입문',
  C0402: '기초',
  C0403: '심화',
};
const COMPETENCE_MAP = {
  C0301: 'AI·데이터',
  C0302: '피지컬컴퓨팅',
  C0303: '디지털콘텐츠',
};

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
  return await page.evaluate(
    async ({ apiPath, season, version }) => {
      const size = 100; // 페이지당 최대치. 아래에서 끝까지 순회한다.
      let pageNo = 1;
      let all = [];
      let guard = 0;
      while (guard++ < 50) {
        const url =
          apiPath +
          `?operationStatusCode=C1101,C1102&page=${pageNo}&size=${size}` +
          `&season=${encodeURIComponent(season)}&version=${encodeURIComponent(version)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
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
    { apiPath, season, version }
  );
}

/**
 * 메인 진입점. 성공 시 카드 배열 반환.
 * 카드가 0개면 에러를 던져 잘못된 "전부 사라짐" diff 방지.
 */
async function scrape() {
  // launch에 timeout(30초) — 크롬 기동이 멈춰도 그 주기는 예외로 끝나고 다음 주기에 재시도.
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    timeout: 30000,
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    console.log('[scraper] 접속:', LIST_URL);
    // 세션/오리진 확보 (SPA 부트스트랩). networkidle까지 대기.
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
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
  } finally {
    // close 자체가 실패해도(이미 죽은 프로세스 등) 다음 주기를 막지 않도록 삼켜서 처리.
    try {
      await browser.close();
    } catch (e) {
      console.warn('[scraper] scrape browser.close 실패(무시):', e.message);
    }
  }
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

  // launch에 timeout(30초) — 상세 수집용 크롬 기동이 멈춰도 예외로 끝나 다음 주기에 재시도.
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    timeout: 30000,
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    // 상세 API 는 현재 season·version 없이도 동일한 응답을 준다(실측 확인).
    // 다만 목록 API 처럼 언제든 필수가 될 수 있어 같은 파라미터를 함께 보낸다.
    const bodies = await page.evaluate(
      async ({ apiBase, ids, season, version }) => {
        const qs = `?season=${encodeURIComponent(season)}&version=${encodeURIComponent(version)}`;
        const out = {};
        for (const pid of ids) {
          try {
            const r = await fetch(apiBase + '/' + pid + qs, {
              headers: { Accept: 'application/json' },
            });
            out[pid] = r.ok ? await r.json() : { __error: 'status ' + r.status };
          } catch (e) {
            out[pid] = { __error: String(e && e.message ? e.message : e) };
          }
        }
        return out;
      },
      { apiBase: DETAIL_API, ids, season: seasonYear(), version: API_VERSION }
    );

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
  } finally {
    // close 실패가 다음 주기를 막지 않도록 삼켜서 처리.
    try {
      await browser.close();
    } catch (e) {
      console.warn('[scraper] fetchDetails browser.close 실패(무시):', e.message);
    }
  }
}

module.exports = {
  scrape,
  fetchDetails,
  mapDetail,
  seasonYear,
  API_VERSION,
  LIST_URL,
  STATUS_MAP,
  TYPE_MAP,
  LEVEL_MAP,
  COMPETENCE_MAP,
};
