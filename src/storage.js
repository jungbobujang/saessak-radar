'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_PATH = path.join(DATA_DIR, 'log.json');
const DETAILS_PATH = path.join(DATA_DIR, 'details.json'); // 프로그램 상세 캐시
const META_PATH = path.join(DATA_DIR, 'meta.json'); // 마지막 전체 갱신일 등
const REMINDERS_PATH = path.join(DATA_DIR, 'reminders.json'); // 오픈 리마인더 발송 이력
const INSTITUTIONS_PATH = path.join(DATA_DIR, 'institutions.json'); // 기관 평가(사용자 입력)

// 기관 목록 시드. 레포에 포함되고, 사용자 평가만 DATA_DIR 에 따로 저장한다.
// (DATA_DIR 은 볼륨이라 재배포해도 평가가 유지되고, 기관이 추가되면 시드만 고치면 된다)
const INSTITUTION_SEED = require('./institutions.seed.json');

const DEFAULT_INSTITUTION = {
  name: '',
  staffScore: null, // 강사구성 단계 점수: 50 | 48 | 45 | 40 | 30 | 0 | null
  pay: null, // 강사료: over(초과) | avg(7.5만) | under(이하) | null
  ops: null, // 운영 편의: easy | normal | hard | null
  material: null, // 교구: yes | no | null
  training: null, // 연수(참고, 점수 미반영): live | video | live_then_video | null
  //         (구 표기 online/offline 도 그대로 보존한다)
  snack: null, // 간식: twice(2번+) | once(1번) | no(안 줌) | null
  heart: false, // 승인 잘해줌 (참고, 점수 미반영)
  verdict: null, // 종합: strong(강력추천) | ok(추천) | no(비추천) | null
  approvalNote: '', // 신청 결과 맥락 메모
  memo: '', // 자유 메모
  evaluated: false,
};

// 강사구성 6단계 — 단계 자체가 곧 배점이다(최대 50).
// 라벨은 설정 화면 드롭다운과 툴팁에서 함께 쓴다.
const STAFF_STEPS = [
  [50, '주+보조+안전 모두 학교'],
  [48, '주+보조 학교'],
  [45, '주+보조 학교, 안전만 외부'],
  [40, '주강사만 학교'],
  [30, '보조강사만 학교'],
  [0, '신청 대상 제외'],
];
const STAFF_LABEL = Object.fromEntries(STAFF_STEPS);

// 종합점수 가중치 (최대 합계 100점). 기준을 바꾸고 싶으면 이 표만 고치면 된다.
//  강사구성 50 + 강사료 20 + 운영 편의 10 + 교구 10 + 간식 10 = 100
//  종합판정·연수·하트는 점수에 반영하지 않는다 — 판정은 사람이 내리는 결론이고,
//  연수/하트는 참고 항목이라 점수에 섞으면 같은 근거를 두 번 세게 된다.
const SCORE_WEIGHTS = {
  staff: Object.fromEntries(STAFF_STEPS.map(([v]) => [v, v])), // 단계 점수 = 배점
  staffMax: 50,
  pay: { over: 20, avg: 18, under: 15 },
  ops: { easy: 10, normal: 9, hard: 8 },
  material: { yes: 10, no: 8 },
  snack: { twice: 10, once: 9, no: 8 },
  verdict: null, // 점수 미반영 (사람이 내리는 결론)
  heart: null, // 점수 미반영 (참고 항목)
  training: null, // 점수 미반영 (참고 항목)
};

// 종합점수 0~100. 아직 안 채운 항목은 0점으로 둔다(비율 환산하면 한두 항목만
// 채운 기관이 과대평가된다). 아예 미평가면 null → 랭킹 맨 아래.
function scoreOf(r) {
  if (!r || !isEvaluated(r)) return null;
  if (r.staffScore === 0) return 0; // 신청 대상 제외 → 무조건 0점
  let sum = 0;
  if (r.staffScore != null && SCORE_WEIGHTS.staff[r.staffScore] != null) {
    sum += SCORE_WEIGHTS.staff[r.staffScore];
  }
  // 연수(training)·하트·종합판정은 의도적으로 계산하지 않는다 — 참고 항목
  for (const key of ['pay', 'ops', 'material', 'snack']) {
    const table = SCORE_WEIGHTS[key];
    if (r[key] && table[r[key]] != null) sum += table[r[key]];
  }
  return Math.max(0, Math.min(100, Math.round(sum)));
}

const INST_ENUMS = {
  staffScore: STAFF_STEPS.map(([v]) => v),
  pay: ['over', 'avg', 'under'],
  ops: ['easy', 'normal', 'hard'],
  material: ['yes', 'no'],
  // 연수 형태. 앞 3개가 현행 선택지이고, online/offline 은 예전에 저장된 값이라
  // 지우지 않고 계속 허용한다(사용자가 다시 고르기 전까지 값이 사라지지 않게).
  training: ['live', 'video', 'live_then_video', 'online', 'offline'],
  snack: ['twice', 'once', 'no'],
  verdict: ['strong', 'ok', 'no'],
};

// ---- 구(舊) 평가 스키마 → 신(新) 스키마 이관 (읽을 때마다 적용, 멱등) ----
// 구 값과 신 값이 겹치지 않게 짜여 있어서(예: 구 staffScore 는 0~5, 신 단계는 0·30~50)
// 몇 번을 다시 돌려도 결과가 같다. 저장본을 못 고치는 상황(볼륨 읽기전용 등)에서도
// 화면·점수는 항상 새 체계로 보이게 하려고 getInstitutions() 에서도 통과시킨다.
const LEGACY_STAFF = { 5: 50, 4.5: 45, 4: 40, 3: 30, 0: 0 };
const LEGACY_PAY = { good: 'over', poor: 'under' }; // avg 는 뜻이 같아 그대로
const LEGACY_SNACK = { yes: 'once', unknown: null }; // '줌'은 횟수 미상 → 보수적으로 1번
const LEGACY_VERDICT = { redo: 'strong', skip: 'no' }; // ok 는 뜻이 같아 그대로

// 한 건을 새 스키마로 옮긴다. { rec, changed } 반환 (changed=false 면 이미 최신)
function migrateInstitutionRecord(row) {
  const rec = { ...row };
  let changed = false;
  // 강사구성: 구 5점 척도(0~5)만 단계 점수로 환산한다. 신 단계(30~50)는 건드리지 않음.
  if (rec.staffScore != null && rec.staffScore > 0 && rec.staffScore <= 5) {
    const v = LEGACY_STAFF[rec.staffScore];
    if (v != null) {
      rec.staffScore = v;
      changed = true;
    }
  }
  for (const [key, table] of [
    ['pay', LEGACY_PAY],
    ['snack', LEGACY_SNACK],
    ['verdict', LEGACY_VERDICT],
  ]) {
    if (rec[key] != null && Object.prototype.hasOwnProperty.call(table, rec[key])) {
      rec[key] = table[rec[key]];
      changed = true;
    }
  }
  // 강사구성 0(신청 대상 제외) → 종합판정 '비추천' 고정
  if (rec.staffScore === 0 && rec.verdict !== 'no') {
    rec.verdict = 'no';
    changed = true;
  }
  return { rec, changed };
}

const DEFAULT_SETTINGS = {
  programType: ['방문형'],
  regions: ['서울·인천권'],
  schoolLevels: ['초등학교'],
  statuses: ['모집 예정', '모집 중'],
  // 교육대상 기본값 (사이트 실측 코드: C0601 일반형 · C0603 이주배경 · C0606 교육복지우선지원사업 학교)
  // 저장된 설정이 없을 때(첫 실행·볼륨 유실)만 쓰이는 값이므로, 우리 학교가 해당되는 3종을 모두 넣는다.
  targets: [
    '일반형',
    '사회적 배려형(이주배경(구 다문화))',
    '교육복지우선지원사업 학교',
  ],
  intervalMinutes: 10,
  // 알림 유형 토글
  notifyStart: true, // 모집 시작 전환 알림
  notifyNew: false, // 신규 모집예정 등록 알림 (플래너 반영은 항상)
  notifyReminder: true, // 오픈 리마인더
  // 기관 평가 표식을 플래너/최근감지에 노출할지 (마스터 스위치, 기본 OFF — 나만 설정에서 봄)
  showRatings: false,
  // 마스터가 ON 일 때 어떤 표식을 보일지 (개별 선택)
  showVerdict: true, // 종합판정 색점
  showStaffScore: true, // 강사구성 별점
  showHeart: true, // 하트
  dimSkip: false, // 비추천 기관 카드를 흐리게
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[storage] ${file} 읽기 실패, 기본값 사용:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- settings ----
// 저장된 값이 항상 우선이다. 기본값은 ① settings.json 이 아예 없을 때(첫 실행·볼륨 유실)와
// ② 저장본에 없는 새 필드를 채울 때만 쓰인다. (전개 순서상 s 가 뒤라 기본값을 덮어쓴다)
function getSettings() {
  const s = readJson(SETTINGS_PATH, null);
  if (!s) {
    writeJson(SETTINGS_PATH, DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  // 누락 필드는 기본값으로 보정
  return { ...DEFAULT_SETTINGS, ...s };
}

// 저장 위치 진단 — 재배포 후 "설정이 초기화됐다" 를 로그만 보고 판별할 수 있게 한다.
// 볼륨이 안 붙었으면 매 배포마다 settingsExists:false 로 찍힌다.
function describeStorage() {
  let writable = true;
  try {
    ensureDir();
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    writable = false;
  }
  return {
    dataDir: path.resolve(DATA_DIR),
    settingsExists: fs.existsSync(SETTINGS_PATH),
    writable,
  };
}

function saveSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  // 정규화
  next.intervalMinutes = Math.max(1, parseInt(next.intervalMinutes, 10) || 10);
  for (const key of ['programType', 'regions', 'schoolLevels', 'statuses', 'targets']) {
    if (!Array.isArray(next[key])) next[key] = [];
  }
  for (const key of [
    'notifyStart',
    'notifyNew',
    'notifyReminder',
    'showRatings',
    'showVerdict',
    'showStaffScore',
    'showHeart',
    'dimSkip',
  ]) {
    next[key] = !!next[key];
  }
  writeJson(SETTINGS_PATH, next);
  return next;
}

// ---- state (프로그램 스냅샷) ----
function getState() {
  return readJson(STATE_PATH, {});
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

// ---- 감지 로그 (최근 200건 링버퍼) ----
function getLog() {
  return readJson(LOG_PATH, []);
}

function appendLog(entry) {
  const log = getLog();
  log.unshift(entry);
  const trimmed = log.slice(0, 200);
  writeJson(LOG_PATH, trimmed);
  return trimmed;
}

// ---- 상세 캐시 (details.json) ----
function getDetails() {
  return readJson(DETAILS_PATH, {});
}
function saveDetails(map) {
  writeJson(DETAILS_PATH, map);
}

// ---- 메타 (meta.json: 마지막 전체 갱신일 등) ----
function getMeta() {
  return readJson(META_PATH, {});
}
function saveMeta(meta) {
  writeJson(META_PATH, meta);
}

// ---- 오픈 리마인더 발송 이력 (reminders.json) ----
// 키: `${id}:${kind}` (kind: 'pre_day' | 'pre_10min') → { at, applyStartAt }
function getReminders() {
  return readJson(REMINDERS_PATH, {});
}
function saveReminders(map) {
  writeJson(REMINDERS_PATH, map);
}

// ---- 기관 평가 (institutions.json) ----
// 시드(레포) + 저장본(DATA_DIR)을 병합해 항상 전체 기관 목록을 돌려준다.
// 시드에 기관이 추가되면 자동으로 목록에 들어오고, 기존 평가는 그대로 유지된다.
function getInstitutions() {
  const saved = readJson(INSTITUTIONS_PATH, null);
  const byName = {};
  if (Array.isArray(saved)) {
    for (const r of saved) if (r && r.name) byName[r.name] = r;
  }
  const merged = INSTITUTION_SEED.map((seed) => ({
    ...DEFAULT_INSTITUTION,
    ...seed,
    ...(byName[seed.name] || {}),
    name: seed.name,
  }));
  // 구 스키마 저장본도 항상 새 체계로 보이게 (파일 이관은 migrate 가 따로 한다)
  for (let i = 0; i < merged.length; i++) merged[i] = migrateInstitutionRecord(merged[i]).rec;
  // 종합점수는 저장하지 않고 읽을 때 계산한다 (가중치를 바꾸면 즉시 반영)
  for (const r of merged) r.score = scoreOf(r);
  // 시드에서 빠진(이름이 바뀐 등) 저장본도 잃지 않고 뒤에 붙인다
  const seedNames = new Set(INSTITUTION_SEED.map((s) => s.name));
  for (const name of Object.keys(byName)) {
    if (!seedNames.has(name)) {
      const extra = migrateInstitutionRecord({ ...DEFAULT_INSTITUTION, ...byName[name] }).rec;
      extra.score = scoreOf(extra);
      merged.push(extra);
    }
  }
  return merged;
}

// 하나라도 채워졌으면 '평가완료'로 본다 (플래그를 따로 관리하면 어긋나기 쉬움)
function isEvaluated(r) {
  return !!(
    r.staffScore != null ||
    r.pay ||
    r.ops ||
    r.material ||
    r.training ||
    r.snack ||
    r.heart ||
    r.verdict ||
    (r.approvalNote || '').trim() ||
    (r.memo || '').trim()
  );
}

// 들어온 값 중 아는 필드만, 허용된 값만 통과시킨다
function normalizeInstitution(patch) {
  const out = {};
  if ('staffScore' in patch) {
    const v = patch.staffScore === '' || patch.staffScore == null ? null : Number(patch.staffScore);
    out.staffScore = INST_ENUMS.staffScore.includes(v) ? v : null;
  }
  for (const key of ['pay', 'ops', 'material', 'training', 'snack', 'verdict']) {
    if (key in patch) {
      const v = patch[key] == null ? '' : String(patch[key]);
      out[key] = INST_ENUMS[key].includes(v) ? v : null;
    }
  }
  if ('heart' in patch) out.heart = !!patch.heart;
  for (const key of ['approvalNote', 'memo']) {
    if (key in patch) out[key] = String(patch[key] == null ? '' : patch[key]).slice(0, 500);
  }
  return out;
}

function saveInstitution(name, patch) {
  const list = getInstitutions();
  const idx = list.findIndex((r) => r.name === name);
  if (idx < 0) throw new Error('알 수 없는 기관: ' + name);

  const next = { ...list[idx], ...normalizeInstitution(patch || {}) };
  // 강사구성 0 = 신청 대상 제외 → 종합판정을 '비추천'으로 고정
  if (next.staffScore === 0) next.verdict = 'no';
  next.evaluated = isEvaluated(next);

  list[idx] = next;
  writeJson(INSTITUTIONS_PATH, list.map(({ score, ...rest }) => rest)); // 점수는 파생값이라 저장 안 함
  next.score = scoreOf(next);
  return next;
}

// 저장본(institutions.json)을 새 스키마로 실제로 고쳐 쓴다 (서버 시작 시 1회, 멱등).
// 파일이 없으면(평가를 아직 저장한 적 없음) 아무 것도 하지 않는다 — 시드는 이미 새 체계.
function migrateInstitutionsFile() {
  const saved = readJson(INSTITUTIONS_PATH, null);
  if (!Array.isArray(saved) || !saved.length) return { changed: 0, total: 0 };
  let changed = 0;
  const next = saved.map((row) => {
    const out = migrateInstitutionRecord(row);
    if (out.changed) changed++;
    return out.rec;
  });
  if (changed) writeJson(INSTITUTIONS_PATH, next.map(({ score, ...rest }) => rest));
  return { changed, total: saved.length };
}

module.exports = {
  DATA_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_INSTITUTION,
  INST_ENUMS,
  SCORE_WEIGHTS,
  STAFF_STEPS,
  STAFF_LABEL,
  scoreOf,
  migrateInstitutionRecord,
  migrateInstitutionsFile,
  getInstitutions,
  saveInstitution,
  getSettings,
  saveSettings,
  describeStorage,
  getState,
  saveState,
  getLog,
  appendLog,
  getDetails,
  saveDetails,
  getMeta,
  saveMeta,
  getReminders,
  saveReminders,
};
