'use strict';

// ============================================================================
// 교육대상 분류 단일 소스 (2026 개편 반영)
// ----------------------------------------------------------------------------
// newsac.kosac.re.kr 리스트 API 의 targetName / 상세 API 의 target[].codeInfo
// 실측값(2026 시즌, 코드그룹 G006 "교육대상") 기준:
//   C0601 일반형
//   C0602 사회적 배려형(도서벽지)
//   C0603 사회적 배려형(이주배경(구 다문화))
//   C0604 사회적 배려형(특수교육)
//   C0605 농어촌 학교
//   C0606 교육복지우선지원사업 학교
//
// code  : 사이트 필터 코드(G006). 목록 API targetCode 파라미터 값과 동일
// full  : API 가 실제로 내려주는 정식 라벨(매칭·저장 기준값)
// short : 대시보드/텔레그램 축약 표기 (툴팁으로 full 노출)
// chip  : 플래너 색칩용 최단 표기 ('사회적 배려형(...)' 껍데기를 벗긴 핵심어)
// aliases: 구(舊) 라벨·짧은 라벨 등 같은 분류로 취급할 표기들(공백 무시 비교)
// ============================================================================
const CATEGORIES = [
  {
    key: 'general',
    code: 'C0601',
    full: '일반형',
    short: '일반형',
    chip: '일반형',
    aliases: ['일반형', '일반'],
  },
  {
    key: 'island',
    code: 'C0602',
    full: '사회적 배려형(도서벽지)',
    short: '배려형(도서벽지)',
    chip: '도서벽지',
    aliases: ['사회적 배려형(도서벽지)', '도서벽지'],
  },
  {
    key: 'migrant',
    code: 'C0603',
    full: '사회적 배려형(이주배경(구 다문화))',
    short: '배려형(이주배경)',
    chip: '이주배경',
    // 구 명칭 '다문화' 및 중간 표기 전부 이주배경으로 흡수
    aliases: [
      '사회적 배려형(이주배경(구 다문화))',
      '사회적 배려형(이주배경)',
      '사회적 배려형(다문화)',
      '이주배경',
      '다문화',
    ],
  },
  {
    key: 'special',
    code: 'C0604',
    full: '사회적 배려형(특수교육)',
    short: '배려형(특수교육)',
    chip: '특수교육',
    aliases: ['사회적 배려형(특수교육)', '특수교육', '특수'],
  },
  {
    key: 'rural',
    code: 'C0605',
    full: '농어촌 학교',
    short: '농어촌',
    chip: '농어촌',
    aliases: ['농어촌 학교', '농어촌학교', '농어촌'],
  },
  {
    key: 'welfare',
    code: 'C0606',
    full: '교육복지우선지원사업 학교',
    short: '교복우',
    chip: '교복우',
    aliases: [
      '교육복지우선지원사업 학교',
      '교육복지우선지원사업',
      '교육복지',
      '교복우',
    ],
  },
];

const UNCLASSIFIED = '미분류';

const BY_KEY = {};
for (const c of CATEGORIES) BY_KEY[c.key] = c;

// 코드(C06xx) → 카테고리
const BY_CODE = {};
for (const c of CATEGORIES) BY_CODE[c.code] = c;

// 사이트 목록 API targetCode 에 넣을 전체 코드 목록 (전량 수집 기준)
const ALL_TARGET_CODES = CATEGORIES.map((c) => c.code);

// 공백 제거(라벨 표기 흔들림 흡수)
function stripWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

// 라벨 → 표준 key (모르면 null → '미분류' 취급)
function canonicalKey(label) {
  const k = stripWs(label);
  if (!k) return null;
  for (const c of CATEGORIES) {
    for (const a of c.aliases) {
      if (stripWs(a) === k) return c.key;
    }
  }
  return null;
}

// 라벨 → 정식(full) 라벨. 모르는 라벨은 원문 유지(수집은 하되 미분류로 취급).
function canonicalFull(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].full : String(label == null ? '' : label).trim();
}

// 라벨 → 축약 표기. 모르는 라벨은 원문(트림) 그대로 노출.
function shortOf(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].short : String(label == null ? '' : label).trim();
}

// 라벨 → 색칩용 최단 표기. 모르는 라벨은 원문(트림) 그대로 노출.
function chipOf(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].chip : String(label == null ? '' : label).trim();
}

// 코드(C06xx) → 정식 라벨. 모르는 코드는 코드 그대로 보존(미분류 취급).
function fullOfCode(code) {
  const c = BY_CODE[String(code || '').trim()];
  return c ? c.full : String(code == null ? '' : code).trim();
}

// 라벨 → 코드(C06xx). 모르면 null.
function codeOf(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].code : null;
}

// 알려진 분류인가?
function isKnown(label) {
  return canonicalKey(label) != null;
}

// 교육대상 목록 → 한 줄 요약. 축약 표기로 최대 max 개까지만 노출하고 나머지는 '외 N'.
// (메타 줄이 길어지는 걸 막는다. 전체 목록은 사이트 상세에서 확인)
function summarize(list, max = 3, prefix = '') {
  const items = normalizeList(list).map((f) => prefix + shortOf(f));
  if (!items.length) return '';
  const sep = prefix ? ' ' : '·';
  if (items.length <= max) return items.join(sep);
  return items.slice(0, max).join(sep) + ` 외 ${items.length - max}`;
}

// 배열을 정식 라벨로 정규화 + 중복 제거(순서 보존)
function normalizeList(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const f = canonicalFull(x);
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

module.exports = {
  CATEGORIES,
  BY_CODE,
  ALL_TARGET_CODES,
  UNCLASSIFIED,
  stripWs,
  canonicalKey,
  canonicalFull,
  fullOfCode,
  codeOf,
  shortOf,
  chipOf,
  summarize,
  isKnown,
  normalizeList,
};
