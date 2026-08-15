'use strict';

// ============================================================================
// 저장 데이터 마이그레이션 (서버 시작 시 1회 실행, 멱등)
// ①~③ 교육대상 분류 개편 · ④ 기관 평가 배점/판정 개편
// ----------------------------------------------------------------------------
// 저장된 JSON(settings/state/details)의 구(舊) 분류 라벨을 새 정식 라벨로 이관한다.
//   다문화        → 사회적 배려형(이주배경(구 다문화))
//   도서벽지      → 사회적 배려형(도서벽지)
//   특수          → 사회적 배려형(특수교육)
// (일반형은 그대로. 신설 농어촌/교복우는 신규 수집분부터 자연 반영.)
// canonicalFull 은 매칭되지 않는 값(학년 라벨 등)은 원문 그대로 두므로 안전하다.
// ============================================================================
const storage = require('./storage');
const { canonicalFull, normalizeList } = require('./classify');

function arrEq(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function migrate() {
  const report = { settings: null, stateChanged: 0, detailsChanged: 0, institutionsChanged: 0 };

  // 1) 알림 설정의 관심 분류(targets) 이관
  try {
    const s = storage.getSettings();
    const before = (s.targets || []).slice();
    const after = normalizeList(before);
    if (!arrEq(before, after)) {
      storage.saveSettings({ targets: after });
      report.settings = { before, after };
    }
  } catch (e) {
    console.error('[migrate] settings 이관 실패:', e.message);
  }

  // 2) 감시 스냅샷(state)의 카드 tags 이관
  try {
    const state = storage.getState();
    let changed = 0;
    for (const id of Object.keys(state)) {
      const e = state[id];
      if (Array.isArray(e.tags)) {
        const nt = e.tags.map(canonicalFull);
        if (!arrEq(nt, e.tags)) {
          e.tags = nt;
          changed++;
        }
      }
    }
    if (changed) {
      storage.saveState(state);
      report.stateChanged = changed;
    }
  } catch (e) {
    console.error('[migrate] state 이관 실패:', e.message);
  }

  // 3) 상세 캐시(details)의 targetNames 이관
  try {
    const details = storage.getDetails();
    let changed = 0;
    for (const id of Object.keys(details)) {
      const d = details[id];
      if (Array.isArray(d.targetNames)) {
        const nt = d.targetNames.map(canonicalFull);
        if (!arrEq(nt, d.targetNames)) {
          d.targetNames = nt;
          changed++;
        }
      }
    }
    if (changed) {
      storage.saveDetails(details);
      report.detailsChanged = changed;
    }
  } catch (e) {
    console.error('[migrate] details 이관 실패:', e.message);
  }

  // 4) 기관 평가(institutions)의 구 배점·판정 라벨 이관
  //    강사구성 5점척도 → 단계점수(50/48/45/40/30/0) · pay good|poor → over|under
  //    snack yes|unknown → once|null · verdict redo|skip → strong|no
  try {
    const r = storage.migrateInstitutionsFile();
    if (r.changed) report.institutionsChanged = r.changed;
  } catch (e) {
    console.error('[migrate] institutions 이관 실패:', e.message);
  }

  const touched =
    report.settings || report.stateChanged || report.detailsChanged || report.institutionsChanged;
  if (touched) {
    console.log('[migrate] 저장 데이터 이관 완료:', JSON.stringify(report, null, 0));
  } else {
    console.log('[migrate] 이관 대상 없음(이미 최신)');
  }
  return report;
}

module.exports = { migrate };
