'use strict';

const storage = require('./storage');
const { scrape, fetchDetails } = require('./scraper');
const classify = require('./classify');

const ORIGIN = 'https://newsac.kosac.re.kr';

let consecutiveFailures = 0;
let failAlertSent = false;

// ---- KST 날짜/시각 헬퍼 ----
function kstYmd(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}
function kstHour(ms) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'hour');
  return p ? parseInt(p.value, 10) % 24 : 0;
}
// KST "7/1(화) 00:00" 표기
function fmtKstDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t) => (parts.find((x) => x.type === t) || {}).value || '';
  return `${g('month')}/${g('day')}(${g('weekday')}) ${g('hour')}:${g('minute')}`;
}
// D-day (0=D-DAY, 양수=D-n, 음수=지남) — KST 날짜 기준
function ddayKst(iso, nowMs) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const da = Date.parse(kstYmd(t) + 'T00:00:00+09:00');
  const db = Date.parse(kstYmd(nowMs) + 'T00:00:00+09:00');
  return Math.round((da - db) / 86400000);
}
// 신청 시작일 "전날 21:00"(KST) 의 ms
function prevDay21Kst(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const prevMs = Date.parse(kstYmd(t) + 'T00:00:00+09:00') - 86400000;
  return Date.parse(kstYmd(prevMs) + 'T21:00:00+09:00');
}

// 런타임 상태 (대시보드 노출용)
const runtime = {
  lastCheckAt: null,
  lastCheckOk: null,
  lastMatchCount: 0,
  lastError: null,
  totalCards: 0,
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "[운영기관] 프로그램명" 라벨 (기관명 없으면 프로그램명만)
function withInst(institution, title) {
  const inst = String(institution || '').trim();
  const t = String(title || '');
  return inst ? `[${inst}] ${t}` : t;
}

// ---- 감시 조건 판정 ----
//
// 판정 규칙 (설정 UI 안내문과 동일):
//  · 카테고리 안 = 합집합(OR). 체크한 값 중 하나라도 카드에 있으면 통과.
//    → 여러 개 체크하면 조건이 좁아지는 게 아니라 '넓어진다'.
//  · 카테고리 사이 = AND. 5개 카테고리를 모두 통과해야 최종 통과.
//  · 빈 배열(전부 해제) = 조건 없음 → 그 카테고리는 전체 통과.
//  · 프로그램 수준(기본/특화/AI특화)은 조건에서 제외 → 전부 통과.
//    수준은 프로그램당 하나뿐이라 여러 개를 AND 로 걸면 0건이 되는 사이트 동작 때문.
//    훗날 노출한다면 단일 선택(라디오) + 기본값 '전체' 로 만들 것.
function matchesSettings(card, settings) {
  // 모집 완료는 항상 제외
  if (card.status === '모집 완료') return false;

  // 모집상태: 카드 값(단일)이 체크 목록에 포함되면 통과 (OR)
  if (settings.statuses.length && !settings.statuses.includes(card.status)) {
    return false;
  }

  // 프로그램 유형: 카드 값(단일)이 체크 목록에 포함되면 통과 (OR)
  if (settings.programType.length) {
    if (!card.type || !settings.programType.includes(card.type)) return false;
  }

  // 운영권역: 카드 권역(복수 가능) 중 하나라도 체크 목록에 포함되면 통과 (OR)
  if (settings.regions.length) {
    const hit = (card.regions || []).some((r) => settings.regions.includes(r));
    if (!hit) return false;
  }

  // 학교급: 카드 학교급(복수 가능) 중 하나라도 체크 목록에 포함되면 통과 (OR)
  if (settings.schoolLevels.length) {
    const hit = (card.levels || []).some((l) => settings.schoolLevels.includes(l));
    if (!hit) return false;
  }

  // 교육대상 태그: OR. 표준 key 로 정규화해 비교(구 라벨/축약/공백 흔들림 흡수).
  // 설정에 '미분류'가 포함돼 있으면 알 수 없는(신설/변경) 라벨 카드도 통과.
  if (settings.targets.length) {
    const wantKeys = new Set();
    let wantUnknown = false;
    for (const t of settings.targets) {
      const k = classify.canonicalKey(t);
      if (k) wantKeys.add(k);
      else if (classify.stripWs(t) === classify.stripWs(classify.UNCLASSIFIED))
        wantUnknown = true;
    }
    const hit = (card.tags || []).some((tag) => {
      const k = classify.canonicalKey(tag);
      return k ? wantKeys.has(k) : wantUnknown;
    });
    if (!hit) return false;
  }

  return true;
}

function isTelegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// ---- 텔레그램 발송 ----
// opts.link 이 있으면 본문 링크는 그대로 두고, 인라인 키보드 버튼("🔗 신청 페이지 열기")을 함께 붙인다.
async function sendTelegram(html, opts = {}) {
  const { link } = opts;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[watcher] TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 — 발송 생략');
    console.log('[미발송 메시지]\n' + html.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const payload = {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };
    if (link) {
      // 버튼 미지원 클라이언트 대비: 본문 링크는 buildMessage 에 그대로 유지된다.
      payload.reply_markup = {
        inline_keyboard: [[{ text: '🔗 신청 페이지 열기', url: link }]],
      };
    }
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[watcher] 텔레그램 발송 실패:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[watcher] 텔레그램 발송 예외:', err.message);
    return false;
  }
}

// 실질 잔여 = 정원 - 승인 - 대기 (음수는 0).
// 대기 학급이 이미 앞줄을 차지하므로 빼야 "지금 신청해서 될 자리"가 된다.
// 대시보드(server.js capacityOf)와 같은 기준. 정원 미공개면 빈 문자열.
function capacityText(card) {
  const cap = card.capacityClasses;
  if (cap == null || cap <= 0) return '';
  const app = card.approvedClasses || 0;
  const pend = card.pendingClasses || 0;
  const real = Math.max(0, cap - app - pend);
  return `실질 잔여 ${real}학급 (정원 ${cap}·승인 ${app}·대기 ${pend})`;
}

function buildMessage(kind, card) {
  // kind: 'start' (모집 시작) | 'new' (새 프로그램)
  const head = kind === 'start' ? '🔴 <b>[모집 시작]</b>' : '🟡 <b>[새 프로그램]</b>';
  // 교육대상은 한 번만, 최대 3개까지 (+ '외 N'). 줄이 길어지는 걸 막는다.
  const metaParts = [
    card.type,
    (card.regions || []).join(','),
    (card.levels || []).join(','),
    classify.summarize(card.tags, 3, '#'),
  ].filter((x) => x && x.length);

  const cap = capacityText(card);
  return (
    `${head}\n` +
    `<b>${escapeHtml(withInst(card.institution, card.title))}</b>\n` +
    `${escapeHtml(metaParts.join(' · '))}\n` +
    (cap ? `${escapeHtml(cap)}\n` : '') +
    `${escapeHtml(card.link)}`
  );
}

// ---- 1회 수집 + diff + 알림 ----
async function checkOnce({ reason } = {}) {
  const settings = storage.getSettings();
  runtime.lastCheckAt = new Date().toISOString();

  let cards;
  try {
    cards = await scrape();
    consecutiveFailures = 0;
    failAlertSent = false;
    runtime.lastCheckOk = true;
    runtime.lastError = null;
    runtime.totalCards = cards.length;
  } catch (err) {
    consecutiveFailures += 1;
    runtime.lastCheckOk = false;
    runtime.lastError = err.message;
    console.error(
      `[watcher] 수집 실패 (${consecutiveFailures}회 연속):`,
      err.message
    );
    // 3회 연속 실패 시 1회만 텔레그램 경보
    if (consecutiveFailures >= 3 && !failAlertSent) {
      await sendTelegram('⚠️ <b>새싹 레이더 수집 실패 중</b>\n연속 3회 이상 수집에 실패했습니다.');
      failAlertSent = true;
    }
    return { ok: false, error: err.message };
  }

  // ---- 알 수 없는(신설/변경) 분류 라벨 감지 → 미분류 수집 + 1회 텔레그램 알림 ----
  // 수집 자체는 이미 전체를 대상으로 하므로 별도 필터 없이 '발견 보고'만 담당한다.
  try {
    const metaU = storage.getMeta();
    const alerted = new Set(metaU.alertedLabels || []);
    const freshUnknown = [];
    const seenThisCycle = new Set();
    for (const c of cards) {
      for (const tag of c.tags || []) {
        const t = String(tag || '').trim();
        if (!t || classify.canonicalKey(t)) continue; // 알려진 분류는 통과
        if (seenThisCycle.has(t)) continue;
        seenThisCycle.add(t);
        if (!alerted.has(t)) freshUnknown.push(t);
      }
    }
    if (freshUnknown.length) {
      for (const t of freshUnknown) alerted.add(t);
      metaU.alertedLabels = Array.from(alerted);
      storage.saveMeta(metaU);
      const html =
        '🆕 <b>[새 분류 발견]</b>\n' +
        freshUnknown.map((t) => '• ' + escapeHtml(t)).join('\n') +
        '\n\n알 수 없는 교육대상 분류입니다. <b>미분류</b>로 수집 중이니 ' +
        '레이더 매핑/설정 확인이 필요할 수 있습니다.';
      await sendTelegram(html);
      for (const t of freshUnknown) {
        storage.appendLog({
          at: new Date().toISOString(),
          kind: 'new-label',
          title: '새 분류 발견: ' + t,
          institution: '',
          status: '',
          link: '',
          sent: true,
        });
      }
      console.log('[watcher] 새 분류 발견:', freshUnknown.join(', '));
    }
  } catch (e) {
    console.error('[watcher] 새 분류 감지 실패:', e.message);
  }

  const state = storage.getState();
  const now = new Date().toISOString();
  const notifications = [];

  // 조건 통과 카드만 관심 대상
  const matched = cards.filter((c) => matchesSettings(c, settings));
  runtime.lastMatchCount = matched.length;

  for (const card of matched) {
    const prev = state[card.id];

    if (!prev) {
      // 신규
      if (card.status === '모집 예정') {
        notifications.push({ kind: 'new', card });
      } else if (card.status === '모집 중') {
        notifications.push({ kind: 'start', card });
      }
    } else if (prev.status === '모집 예정' && card.status === '모집 중') {
      // 전환 (가장 중요)
      notifications.push({ kind: 'start', card });
    }
    // 같은 id+상태로는 중복 알림 없음 (아래 스냅샷 갱신으로 보장)
  }

  // 알림 발송 + 로그 기록 (유형별 토글 반영: 로그·플래너는 항상, 텔레그램만 게이트)
  let notified = 0;
  for (const n of notifications) {
    const wantSend =
      n.kind === 'start' ? settings.notifyStart : settings.notifyNew;
    let sent = false;
    if (wantSend) {
      const html = buildMessage(n.kind, n.card);
      sent = await sendTelegram(html, { link: n.card.link });
      if (sent) notified += 1;
    }
    storage.appendLog({
      at: now,
      kind: n.kind, // 'start' | 'new'
      title: n.card.title,
      institution: n.card.institution || '',
      status: n.card.status,
      link: n.card.link,
      sent,
    });
    console.log(
      `[watcher] 감지(${n.kind}): ${n.card.title} [${n.card.status}] send=${wantSend} sent=${sent}`
    );
  }

  // ---- 상세 수집 (조건 통과분만, 캐시 기반으로 요청 최소화) ----
  const details = storage.getDetails();
  const meta = storage.getMeta();
  const nowMs = Date.now();
  const todayKst = kstYmd(nowMs);
  // 하루 1회 새벽(04시 이후) 전체 갱신
  const dailyDue = meta.lastFullRefreshDate !== todayKst && kstHour(nowMs) >= 4;

  const detailIds = [];
  for (const card of matched) {
    if (!card.programId) continue;
    const prev = state[card.id];
    const need =
      !details[card.id] || // 신규
      (prev && prev.status !== card.status) || // 상태 변경
      dailyDue; // 하루 1회 전체
    if (need) detailIds.push(card.programId);
  }

  let refreshed = 0;
  let changeCount = 0;
  if (detailIds.length) {
    console.log(`[watcher] 상세 갱신 대상 ${detailIds.length}건 (dailyDue=${dailyDue})`);
    const fetched = await fetchDetails(detailIds);
    for (const id of Object.keys(fetched)) {
      const newD = fetched[id];
      const oldD = details[id];
      if (oldD) {
        const changes = diffDetail(oldD, newD);
        if (changes.length) {
          changeCount += 1;
          const title = (state[id] && state[id].title) || newD.id;
          const institution = (state[id] && state[id].institution) || newD.institution || '';
          const link = (state[id] && state[id].link) || '';
          const desc = changes
            .map((c) => `${c.field} ${c.from || '-'}→${c.to || '-'}`)
            .join(', ');
          storage.appendLog({
            at: now,
            kind: 'change',
            title,
            institution,
            status: newD.status,
            link,
            sent: false,
            changes: desc,
          });
          console.log(`[watcher] 정보 변경: ${withInst(institution, title)} — ${desc}`);
          // 신청 시작 일시 변경 → 텔레그램 알림 + 리마인더 재예약
          if ((oldD.applyStartAt || '') !== (newD.applyStartAt || '')) {
            const html =
              `📅 <b>[신청일정 변경]</b>\n` +
              `<b>${escapeHtml(withInst(institution, title))}</b>\n` +
              `신청 시작: ${escapeHtml(fmtKstDateTime(oldD.applyStartAt) || '미공지')} → ` +
              `<b>${escapeHtml(fmtKstDateTime(newD.applyStartAt) || '미공지')}</b>\n` +
              `${escapeHtml(link)}`;
            await sendTelegram(html, { link });
            const rem = storage.getReminders();
            delete rem[id + ':pre_day'];
            delete rem[id + ':pre_10min'];
            storage.saveReminders(rem);
          }
        }
      }
      details[id] = newD;
      refreshed += 1;
    }
    storage.saveDetails(details);
  }
  if (dailyDue) {
    meta.lastFullRefreshDate = todayKst;
    storage.saveMeta(meta);
  }

  // 스냅샷 갱신: 조건 통과한 카드만 상태 추적 (전환 감지 + 플래너용 필드 포함)
  const nextState = { ...state };
  for (const card of matched) {
    const prev = nextState[card.id];
    nextState[card.id] = {
      title: card.title,
      institution: card.institution || '',
      status: card.status,
      link: card.link,
      type: card.type,
      tags: card.tags,
      levels: card.levels,
      regions: card.regions,
      capacityClasses: card.capacityClasses, // 정원(모집 학급)
      approvedClasses: card.approvedClasses, // 승인
      pendingClasses: card.pendingClasses, // 대기
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now,
    };
  }
  storage.saveState(nextState);

  return {
    ok: true,
    total: cards.length,
    matched: matched.length,
    notified,
    refreshed,
    changed: changeCount,
  };
}

// 상세 필드 diff: 신청기간·정원·차시·신청대상 변경만 추적
function diffDetail(oldD, newD) {
  const changes = [];
  const cmp = (field, a, b) => {
    if (String(a == null ? '' : a) !== String(b == null ? '' : b)) {
      changes.push({ field, from: a, to: b });
    }
  };
  cmp('신청시작', fmtKstDateTime(oldD.applyStartAt), fmtKstDateTime(newD.applyStartAt));
  cmp('신청종료', fmtKstDateTime(oldD.applyEndAt), fmtKstDateTime(newD.applyEndAt));
  cmp('정원', oldD.capacityClasses, newD.capacityClasses);
  cmp('차시', oldD.totalChapters, newD.totalChapters);
  cmp('신청대상', (oldD.targetNames || []).join(','), (newD.targetNames || []).join(','));
  return changes;
}

// ---- 알림 리허설 (테스트 알림) ----
// 가짜 프로그램 1건을 실제 발송 함수(buildMessage + sendTelegram)에 그대로 태운다.
// - 텔레그램 설정 시 인라인 버튼까지 실제와 동일하게 발송
// - 로그에는 kind:'test' 로 기록 (대시보드에서 "오늘 보낸 알림" 카운트·조건 일치 수에서 제외)
// - state.json(감시 스냅샷)에는 절대 반영하지 않는다 → 실제 전환 감지에 영향 없음
async function sendTestAlert() {
  const card = {
    id: 'test',
    title: '[테스트] 새싹 레이더 알림 점검',
    status: '모집 중',
    type: '방문형',
    regions: ['서울·인천권'],
    levels: ['초등학교'],
    tags: ['일반형'], // buildMessage 가 '#' 를 붙여 #일반형 으로 렌더
    link: 'https://newsac.kosac.re.kr/',
    // 실제 알림과 같은 모양이 나오도록 정원 수치도 넣는다 (실질 잔여 = 12-2-7 = 3)
    capacityClasses: 12,
    approvedClasses: 2,
    pendingClasses: 7,
  };

  const tgConfigured = isTelegramConfigured();
  const html = buildMessage('start', card);
  const sent = await sendTelegram(html, { link: card.link });
  const telegram = !tgConfigured ? 'unset' : sent ? 'sent' : 'failed';

  storage.appendLog({
    at: new Date().toISOString(),
    kind: 'test',
    title: card.title,
    status: card.status,
    link: card.link,
    sent,
  });
  console.log(`[watcher] 테스트 알림 발송 telegram=${telegram}`);

  return { ok: true, telegram, card };
}

// ---- 오픈 리마인더 (사이트 요청 없음, 1분 간격 경량 체크) ----
// 신청 시작 일시가 확인된 '모집 예정' 프로그램에 대해 텔레그램 리마인더 2회:
//  ① 전날 21:00  ② 시작 10분 전. 발송 이력(reminders.json)으로 중복 방지.
async function checkReminders() {
  const settings = storage.getSettings();
  if (!settings.notifyReminder) return { ok: true, sent: 0, off: true };

  const details = storage.getDetails();
  const state = storage.getState();
  const reminders = storage.getReminders();
  const nowMs = Date.now();
  let sent = 0;
  let changed = false;

  for (const id of Object.keys(details)) {
    const d = details[id];
    const st = state[id];
    const status = (st && st.status) || d.status;
    if (status !== '모집 예정') continue;
    if (!d.applyStartAt) continue;

    const startMs = new Date(d.applyStartAt).getTime();
    if (isNaN(startMs) || startMs <= nowMs) continue; // 이미 지난 건 제외

    const t10 = startMs - 10 * 60000;
    // ② 시작 10분 전
    if (nowMs >= t10 && nowMs < startMs && !reminders[id + ':pre_10min']) {
      const ok = await sendReminder('pre_10min', id, d, st);
      reminders[id + ':pre_10min'] = { at: new Date(nowMs).toISOString(), applyStartAt: d.applyStartAt, sent: ok };
      sent += 1;
      changed = true;
    }
    // ① 전날 21:00 (10분 전 창에 들어오기 전까지만)
    const preDayMs = prevDay21Kst(d.applyStartAt);
    if (preDayMs != null && nowMs >= preDayMs && nowMs < t10 && !reminders[id + ':pre_day']) {
      const ok = await sendReminder('pre_day', id, d, st);
      reminders[id + ':pre_day'] = { at: new Date(nowMs).toISOString(), applyStartAt: d.applyStartAt, sent: ok };
      sent += 1;
      changed = true;
    }
  }

  if (changed) storage.saveReminders(reminders);
  return { ok: true, sent };
}

async function sendReminder(kind, id, d, st) {
  const title = (st && st.title) || d.id;
  const institution = (st && st.institution) || d.institution || '';
  const label = withInst(institution, title);
  const link =
    (st && st.link) ||
    (d.programId ? `${ORIGIN}/public/program/thumb/${d.programId}` : ORIGIN);
  const when = fmtKstDateTime(d.applyStartAt);
  const head = kind === 'pre_10min' ? '⏰ <b>[10분 뒤 오픈!]</b>' : '🔔 <b>[내일 오픈 예정]</b>';
  const line =
    kind === 'pre_10min'
      ? `10분 뒤 <b>${escapeHtml(when)}</b> 신청이 열립니다.`
      : `내일 <b>${escapeHtml(when)}</b> 신청이 열립니다.`;
  const html = `${head}\n<b>${escapeHtml(label)}</b>\n${line}\n${escapeHtml(link)}`;
  const ok = await sendTelegram(html, { link });
  storage.appendLog({
    at: new Date().toISOString(),
    kind: 'reminder',
    title: `${kind === 'pre_10min' ? '[10분전]' : '[전날]'} ${title}`,
    institution,
    status: '모집 예정',
    link,
    sent: ok,
  });
  console.log(`[watcher] 리마인더(${kind}): ${label} sent=${ok}`);
  return ok;
}

module.exports = {
  checkOnce,
  checkReminders,
  matchesSettings,
  runtime,
  sendTelegram,
  fmtKstDateTime,
  ddayKst,
  sendTestAlert,
  isTelegramConfigured,
};
