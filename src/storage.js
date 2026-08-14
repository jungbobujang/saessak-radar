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
  staffScore: null, // 강사구성: 0 | 3 | 4 | 4.5 | 5 | null
  pay: null, // 강사료: good | avg | poor | null
  training: null, // 연수: online | offline | null
  snack: null, // 간식: yes | no | unknown | null
  heart: false, // 정성 호감
  verdict: null, // 종합: redo | ok | skip | null
  approvalNote: '', // 신청 결과 맥락 메모
  memo: '', // 자유 메모
  evaluated: false,
};

const INST_ENUMS = {
  staffScore: [0, 3, 4, 4.5, 5],
  pay: ['good', 'avg', 'poor'],
  training: ['online', 'offline'],
  snack: ['yes', 'no', 'unknown'],
  verdict: ['redo', 'ok', 'skip'],
};

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
  // 기관 평가 표식을 플래너/최근감지에 노출할지 (기본 OFF — 나만 설정에서 봄)
  showRatings: false,
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
  for (const key of ['notifyStart', 'notifyNew', 'notifyReminder', 'showRatings']) {
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
  // 시드에서 빠진(이름이 바뀐 등) 저장본도 잃지 않고 뒤에 붙인다
  const seedNames = new Set(INSTITUTION_SEED.map((s) => s.name));
  for (const name of Object.keys(byName)) {
    if (!seedNames.has(name)) merged.push({ ...DEFAULT_INSTITUTION, ...byName[name] });
  }
  return merged;
}

// 하나라도 채워졌으면 '평가완료'로 본다 (플래그를 따로 관리하면 어긋나기 쉬움)
function isEvaluated(r) {
  return !!(
    r.staffScore != null ||
    r.pay ||
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
  for (const key of ['pay', 'training', 'snack', 'verdict']) {
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
  // 강사구성 0 = 신청 대상 제외 → 종합판정을 '거르기'로 고정
  if (next.staffScore === 0) next.verdict = 'skip';
  next.evaluated = isEvaluated(next);

  list[idx] = next;
  writeJson(INSTITUTIONS_PATH, list);
  return next;
}

module.exports = {
  DATA_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_INSTITUTION,
  INST_ENUMS,
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
