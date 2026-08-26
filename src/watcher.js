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

// ---- 서비스 라벨 (SERVICE_LABEL) ----
// 리전별 서비스를 여러 개 띄우면 알림 문구가 서로 완전히 똑같아서 어느 서비스가
// 보낸 것인지 구분되지 않는다. 이 값을 주면 모든 텔레그램 메시지 맨 앞에 [라벨] 이 붙는다.
// 미설정이면 아무것도 붙지 않는다 — 단일 서비스 운영과 문구가 100% 동일하다.
const SERVICE_LABEL = String(process.env.SERVICE_LABEL || '').trim();

// 텔레그램 머리말 접두. sendTelegram 한 곳에서만 붙이므로 모든 알림 경로
// (모집 시작·신규·리마인더·정보 변경·새 분류·테스트·수집 실패·감시 정지)가 함께 적용된다.
function labelPrefix() {
  return SERVICE_LABEL ? `[${escapeHtml(SERVICE_LABEL)}] ` : '';
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

// ---- 기록된 스냅샷을 '현재' 조건으로 다시 판정 ----
//
// matchesSettings 는 방금 수집한 카드를 받는다. 아래 둘은 이미 파일에 남은 것
// (state 스냅샷 · 감지 로그 항목)을 지금 설정으로 다시 재는 데 쓴다.
// 조건은 언제든 바뀌는데 기록은 그대로 남기 때문에, 기록을 '지금 기준' 으로
// 다시 보려면 판정을 한 번 더 해야 한다.
//
// 따로 두는 이유는 기록에 필드가 없을 수 있어서다 — 예전 로그는 권역을 아예
// 적지 않았다. 없는 필드로 탈락시키면 '조건 밖' 이 아니라 '모르는 것' 을 숨기게
// 된다. 그래서 아는 항목만 따지고, 모르면 통과시킨다.
//
// 판정 규칙은 matchesSettings 와 같다 — 카테고리 안은 OR, 카테고리끼리는 AND.

// 값 하나 또는 배열이 체크 목록에 걸리는지. 조건이 비었거나 기록이 없으면 통과.
function hitsAny(value, wanted) {
  if (!wanted || !wanted.length) return true; // 조건 없음 → 전체 통과
  if (value == null) return true; // 기록에 없음 → 판정 보류
  const arr = Array.isArray(value) ? value : [value];
  if (!arr.length) return true;
  return arr.some((v) => wanted.includes(v));
}

// 권역·학교급·프로그램 유형만 본다. 교육대상·모집상태는 일부러 뺐다.
//  · 교육대상: 새 분류 감지는 '알 수 없는 태그' 를 찾는 일이라, 태그 조건으로
//    거르면 목적 자체가 사라진다(모르는 태그는 어차피 조건에 없다).
//  · 모집상태: 리마인더는 이미 '모집 예정' 으로 좁힌 뒤에 이 함수를 부른다.
function matchesScope(snap, settings) {
  if (!snap) return true; // 스냅샷이 없으면 판정할 근거가 없다
  return (
    hitsAny(snap.type, settings.programType) &&
    hitsAny(snap.regions, settings.regions) &&
    hitsAny(snap.levels, settings.schoolLevels)
  );
}

// 화면 표시용 판정 — 권역·학교급·유형 + 교육대상.
// 모집상태는 보지 않는다. 로그 한 줄은 '그때 일어난 일' 이지 현재 상태가 아니라서,
// 지금 설정의 모집상태로 지난 기록을 지우면 이력이 이상해진다.
function matchesRecord(snap, settings) {
  if (!snap) return true;
  if (!matchesScope(snap, settings)) return false;
  if (snap.tags != null && settings.targets && settings.targets.length) {
    const tags = Array.isArray(snap.tags) ? snap.tags : [snap.tags];
    if (tags.length) {
      const wantKeys = new Set();
      let wantUnknown = false;
      for (const t of settings.targets) {
        const k = classify.canonicalKey(t);
        if (k) wantKeys.add(k);
        else if (classify.stripWs(t) === classify.stripWs(classify.UNCLASSIFIED))
          wantUnknown = true;
      }
      const hit = tags.some((tag) => {
        const k = classify.canonicalKey(tag);
        return k ? wantKeys.has(k) : wantUnknown;
      });
      if (!hit) return false;
    }
  }
  return true;
}

// 감지 로그 한 줄에서 판정에 쓸 필드만 추린다. 조건 필드가 하나도 없으면
// (예전 로그) null 을 돌려주고, 부르는 쪽에서 '판정 불가' 로 다룬다.
function conditionOf(entry) {
  if (!entry) return null;
  const has =
    entry.type != null || entry.regions != null || entry.levels != null || entry.tags != null;
  if (!has) return null;
  return {
    type: entry.type,
    regions: entry.regions,
    levels: entry.levels,
    tags: entry.tags,
  };
}

function isTelegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// ---- 발송 결과 구분 ----
// sent(boolean) 하나로는 "알림 유형을 꺼 뒀다 / 텔레그램 미설정 / 진짜 실패" 가
// 전부 false 로 뭉개진다. 로그에서 "오늘 0건"의 원인을 가르려면 이 구분이 필요하다.
//   sent   : 발송 성공
//   failed : 보내려 했는데 실패 (토큰·네트워크·차단)
//   off    : 해당 알림 유형이 설정에서 꺼져 있음 (정상 동작)
//   unset  : 텔레그램 미설정 (콘솔에만 출력)
//   none   : 애초에 발송 대상이 아닌 기록 (정보 변경 등)
function deliveryOf(wantSend, sent) {
  if (sent) return 'sent'; // 성공은 다른 무엇보다 우선한다
  if (!wantSend) return 'off';
  return isTelegramConfigured() ? 'failed' : 'unset';
}

// ---- 브라우저 알림 페이로드 (단일 빌더) ----
// 감지 로그 1건 → { title, body, link }. 실제 감지 알림과 테스트 알림이
// '똑같은 형식'이라는 걸 코드로 보장하려고, 양쪽 모두 이 함수 하나만 거친다.
// (텔레그램 buildMessage 의 머리말·라벨 규칙을 그대로 따른다)
const NOTIF_HEAD = {
  start: '🔴 [모집 시작]',
  new: '🟡 [새 프로그램]',
  reminder: '🔔 [오픈 리마인더]',
  change: '📅 [정보 변경]',
  'new-label': '🆕 [새 분류]',
  test: '🔴 [모집 시작]', // 테스트는 '모집 시작' 알림과 완전히 같은 모양으로 나간다
};

function notifyPayload(entry) {
  const e = entry || {};
  const head = NOTIF_HEAD[e.kind] || NOTIF_HEAD.new;
  const label = withInst(e.institution, e.title);
  const body = [e.status, e.changes].filter((x) => x && String(x).length).join(' · ');
  return {
    title: `${head} ${label}`.trim(),
    body,
    link: e.link || '',
  };
}

// ---- 텔레그램 발송 ----
// opts.link 이 있으면 본문 링크는 그대로 두고, 인라인 키보드 버튼("🔗 신청 페이지 열기")을 함께 붙인다.
async function sendTelegram(html, opts = {}) {
  const { link } = opts;
  // 서비스 라벨은 여기 한 곳에서만 붙인다 → 알림 경로가 늘어도 자동으로 따라온다.
  const text = labelPrefix() + html;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[watcher] TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 — 발송 생략');
    console.log('[미발송 메시지]\n' + text.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const payload = {
      chat_id: chatId,
      text,
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
  // 승인 수치가 아직 안 열린 건은 잔여를 단정하지 않는다 (대시보드 capacityOf 와 같은 기준)
  if (card.approvedClasses == null) return `잔여 ${cap}학급 · 미집계 (정원 ${cap})`;
  const app = card.approvedClasses || 0;
  const pend = card.pendingClasses || 0;
  const raw = cap - app - pend;
  const real = Math.max(0, raw);
  const tail = `(정원 ${cap}·승인 ${app}·대기 ${pend})`;
  if (raw < 0) return `잔여 0학급 · 초과 접수 ${-raw} ${tail}`;
  return `잔여 ${real}학급 ${tail}`;
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
  // '발견 보고' 만 담당한다(수집 자체는 이미 전체가 대상이다).
  //
  // 다만 권역·학교급·유형까지 전국으로 열어 두면, 경상권만 보는 서비스가 서울 프로그램의
  // 새 분류를 알려 온다. 그래서 matchesScope 로 내 관심 범위까지만 좁힌다.
  // 교육대상(targets)으로는 거르지 않는다 — 여기서 찾는 건 '조건에 없는 태그' 라서
  // 태그 조건을 걸면 찾을 대상이 통째로 사라진다.
  try {
    const metaU = storage.getMeta();
    const alerted = new Set(metaU.alertedLabels || []);
    const freshUnknown = [];
    const seenThisCycle = new Set();
    for (const c of cards) {
      if (!matchesScope(c, settings)) continue;
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
      const labelSent = await sendTelegram(html);
      for (const t of freshUnknown) {
        storage.appendLog({
          at: new Date().toISOString(),
          kind: 'new-label',
          title: '새 분류 발견: ' + t,
          institution: '',
          status: '',
          link: '',
          sent: labelSent,
          delivery: deliveryOf(true, labelSent),
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
      delivery: deliveryOf(wantSend, sent),
      // 조건 필드 — 나중에 조건이 바뀌었을 때 이 기록을 다시 판정하려면 필요하다.
      // (기록은 지우지 않는다. 화면에서 걸러 보기 위한 재료일 뿐이다)
      id: n.card.id,
      type: n.card.type,
      regions: n.card.regions,
      levels: n.card.levels,
      tags: n.card.tags,
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
          // 신청 시작 일시 변경 → 텔레그램 알림 + 리마인더 재예약
          // (그 외의 변경은 기록만 남기고 발송하지 않는다 → delivery 'none')
          let chgSent = false;
          let chgDelivery = 'none';
          if ((oldD.applyStartAt || '') !== (newD.applyStartAt || '')) {
            const html =
              `📅 <b>[신청일정 변경]</b>\n` +
              `<b>${escapeHtml(withInst(institution, title))}</b>\n` +
              `신청 시작: ${escapeHtml(fmtKstDateTime(oldD.applyStartAt) || '미공지')} → ` +
              `<b>${escapeHtml(fmtKstDateTime(newD.applyStartAt) || '미공지')}</b>\n` +
              `${escapeHtml(link)}`;
            chgSent = await sendTelegram(html, { link });
            chgDelivery = deliveryOf(true, chgSent);
            const rem = storage.getReminders();
            delete rem[id + ':pre_day'];
            delete rem[id + ':pre_10min'];
            storage.saveReminders(rem);
          }
          storage.appendLog({
            at: now,
            kind: 'change',
            title,
            institution,
            status: newD.status,
            link,
            sent: chgSent,
            delivery: chgDelivery,
            changes: desc,
            // 조건 필드는 스냅샷에서 가져온다 (상세 응답에는 권역·학교급이 없다)
            id,
            type: state[id] && state[id].type,
            regions: state[id] && state[id].regions,
            levels: state[id] && state[id].levels,
            tags: state[id] && state[id].tags,
          });
          console.log(`[watcher] 정보 변경: ${withInst(institution, title)} — ${desc}`);
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
    // 특정 권역을 박아 두면 다른 리전 서비스에서 리허설을 돌렸을 때
    // "감시 조건이 잘못됐나" 하는 오해를 부른다. 서비스 라벨을 따르고, 없으면 중립 문구.
    regions: [SERVICE_LABEL || '감시 대상 권역'],
    levels: ['초등학교'],
    tags: ['일반형'], // buildMessage 가 '#' 를 붙여 #일반형 으로 렌더
    link: 'https://newsac.kosac.re.kr/',
    // 실제 알림과 같은 모양이 나오도록 정원 수치도 넣는다 (실질 잔여 = 12-2-7 = 3)
    capacityClasses: 12,
    approvedClasses: 2,
    pendingClasses: 7,
  };

  const html = buildMessage('start', card);
  const sent = await sendTelegram(html, { link: card.link });
  const telegram = deliveryOf(true, sent);

  // 실제 감지와 동일한 형태의 로그 엔트리를 만들고, 그 엔트리를 그대로
  // notifyPayload 에 태워 돌려준다 → 브라우저 알림도 실제 경로와 같은 빌더를 탄다.
  const entry = {
    at: new Date().toISOString(),
    kind: 'test',
    title: card.title,
    institution: card.institution || '',
    status: card.status,
    link: card.link,
    sent,
    delivery: telegram,
    id: card.id,
    type: card.type,
    regions: card.regions,
    levels: card.levels,
    tags: card.tags,
  };
  storage.appendLog(entry);
  console.log(`[watcher] 테스트 알림 발송 telegram=${telegram}`);

  return { ok: true, telegram, card, entry, notification: notifyPayload(entry) };
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
    // 조건이 바뀌어도 details/state 는 지워지지 않는다. 그래서 여기서 한 번 더 잰다 —
    // 이걸 빼면 권역을 바꾼 뒤에도 옛 권역 프로그램의 리마인더가 계속 나간다.
    // (스냅샷이 없어 판정할 수 없는 건은 예전처럼 보낸다)
    if (!matchesScope(st, settings)) continue;

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
    delivery: deliveryOf(true, ok),
    id,
    type: st && st.type,
    regions: st && st.regions,
    levels: st && st.levels,
    tags: st && st.tags,
  });
  console.log(`[watcher] 리마인더(${kind}): ${label} sent=${ok}`);
  return ok;
}

module.exports = {
  SERVICE_LABEL,
  checkOnce,
  checkReminders,
  matchesSettings,
  matchesScope,
  matchesRecord,
  conditionOf,
  runtime,
  sendTelegram,
  fmtKstDateTime,
  ddayKst,
  sendTestAlert,
  isTelegramConfigured,
  notifyPayload,
  deliveryOf,
};
