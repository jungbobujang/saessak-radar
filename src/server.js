'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

// ---- .env 자동 로더 ----
// - .env 파일이 없으면 조용히 스킵 (Railway 등 프로덕션은 호스트가 env를 주입)
// - 이미 설정된 환경변수는 절대 덮어쓰지 않음 (호스트/셸 주입값 우선)
(function loadDotenv() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const key = s.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue; // 기존값 유지
      let val = s.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1); // 감싼 따옴표 제거
      }
      process.env[key] = val;
    }
  } catch (_) {
    // 로딩 실패는 조용히 무시 — env는 호스트에서 주입될 수 있음
  }
})();

const storage = require('./storage');
const classify = require('./classify');
const { migrate } = require('./migrate');
const {
  checkOnce,
  checkReminders,
  runtime,
  sendTestAlert,
  sendTelegram,
  fmtKstDateTime,
  ddayKst,
  notifyPayload,
  isTelegramConfigured,
} = require('./watcher');
const { withTimeout } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const bootMs = Date.now(); // 워치독이 부팅 직후 헛발질하지 않도록 기준점으로 쓴다

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============ 설정 비밀번호 보호 (HMAC 서명 쿠키, 외부 라이브러리 없이 crypto만) ============
// ADMIN_PASSWORD 미설정 시 보호 없음(로컬 개발 편의).
const AUTH_COOKIE = 'sr_auth';
const AUTH_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30일

function authEnabled() {
  return !!process.env.ADMIN_PASSWORD;
}

// 서명 키: ADMIN_PASSWORD 로 HMAC → 비번을 바꾸면 기존 쿠키 자동 무효화
function signPayload(payload) {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || '')
    .update(payload)
    .digest('hex');
}

function makeToken() {
  const payload = String(Date.now() + AUTH_MAX_AGE_SEC * 1000); // 만료 시각(ms)
  return payload + '.' + signPayload(payload);
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const dot = tok.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  const expected = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false; // 서명 검증 (timing-safe)
  const exp = parseInt(payload, 10);
  return Number.isFinite(exp) && exp > Date.now(); // 만료 확인
}

function passwordMatches(input) {
  const pw = String(process.env.ADMIN_PASSWORD || '');
  const a = Buffer.from(String(input == null ? '' : input));
  const b = Buffer.from(pw);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // 길이 불일치도 상수시간 비교 후 실패
    return false;
  }
  return crypto.timingSafeEqual(a, b); // timingSafeEqual 로 비밀번호 비교
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    }
  });
  return out;
}

function isAuthed(req) {
  return verifyToken(parseCookies(req)[AUTH_COOKIE]);
}

function cookieString(name, val, maxAgeSec) {
  return `${name}=${encodeURIComponent(val)}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; SameSite=Lax`;
}

// next 파라미터는 내부 경로만 허용 (오픈 리다이렉트 방지)
function safeNext(n) {
  if (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) return n;
  return '/settings';
}

// 보호 미들웨어: 미설정이면 통과, 미인증이면 페이지는 로그인으로 / API는 401
function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: '인증이 필요합니다. 설정 페이지에서 로그인하세요.' });
  }
  return res.redirect('/auth?next=' + encodeURIComponent(req.originalUrl || '/settings'));
}

// ---- 정기 수집 스케줄러 (자기예약 방식 + 단일 실행 락 + 워치독) ----
// setInterval/cron 처럼 "고정 주기 발화"는 이전 수집이 안 끝났을 때 겹쳐서 chromium 을
// 다중 launch → spawn EAGAIN 을 유발한다. 그래서 ① isCollecting 락으로 중복 실행을 막고,
// ② 수집이 "끝난 뒤"에야 다음 주기를 setTimeout 으로 예약해 겹침을 원천 차단한다.
//
// 이 방식의 급소는 "끝난 뒤"다. 한 사이클이 영영 안 끝나면 다음 주기를 예약하는 줄에
// 도달하지 못해 감시가 통째로 죽는다 (2026-08-18 실제 사고: 사이트 응답이 안 와
// page.evaluate 가 매달림 → 2시간 정지). 그래서 세 겹으로 막는다.
//   ① 사이클 자체에 상한(CYCLE_TIMEOUT_MS) — 끝나지 않는 사이클을 강제로 끝낸다
//   ② 예약은 finally 에서 — 사이클이 어떻게 끝나든 다음 주기는 반드시 잡힌다
//   ③ 워치독 — 그래도 활동이 끊기면(프로세스 정지·타이머 유실) 스스로 되살린다
// 기본값이 운영값이다. 환경변수는 검증·비상 조정용 (분 단위).
const envMin = (name, def) => {
  const v = parseFloat(process.env[name]);
  return (Number.isFinite(v) && v > 0 ? v : def) * 60000;
};
// 사이클 상한은 스크래퍼가 스스로 끊는 시간(최악 약 6.3분: launch/goto/evaluate 상한의 합)
// 보다 커야 한다. 더 짧으면 스크래퍼가 browser.close() 로 정리하기 전에 락이 풀려
// 다음 사이클의 크로뮴과 겹친다(예전 spawn EAGAIN 의 원인). 여기는 최후의 그물이다.
// 상한들은 서로 사슬로 묶여 있다. 안쪽이 먼저 끊겨야 바깥이 헛돌지 않는다.
//   스크래퍼 1회(90초) < 사이클 상한(4분) < 죽은 락 판정(5분) < 워치독(30분)
// 이 순서가 깨지면 사고가 난다 — 죽은 락 판정이 사이클 상한보다 짧으면
// 살아 있는 수집을 죽은 것으로 오인해 크로뮴이 겹쳐 뜬다(spawn EAGAIN).
const CYCLE_TIMEOUT_MS = envMin('CYCLE_TIMEOUT_MIN', 4);     // 한 사이클 상한 (scrape+상세 합계)
const WATCHDOG_TICK_MS = envMin('WATCHDOG_TICK_MIN', 1);     // 워치독 점검 주기
const WATCHDOG_STALL_MS = envMin('WATCHDOG_STALL_MIN', 30);  // 이만큼 활동이 없으면 루프를 재시작
// 진행 중 플래그가 이 시간을 넘겨 잡혀 있으면 죽은 락으로 보고 강제 해제한다.
// 사이클 상한보다 반드시 커야 한다 — 설정을 잘못 줘도 아래 보정으로 지켜진다.
const STALE_LOCK_MS = Math.max(envMin('STALE_LOCK_MIN', 5), CYCLE_TIMEOUT_MS + 60000);

let currentInterval = null;  // 대시보드/요약 노출용(현재 적용 간격)
let isCollecting = false;    // 단일 실행 락 — 수집(scrape+fetchDetails) 1건만 진행
let collectStartedMs = 0;    // 그 락을 언제 잡았는지 (죽은 락 판정용)
let staleUnlocks = 0;        // 죽은 락을 강제로 푼 누적 횟수
let pendingManualCheck = false; // 수집 중에 눌린 '즉시 확인' — 끝나면 한 번 이어서 돈다
let nextTimer = null;        // 다음 주기 예약 타이머 핸들
let stallAlertedMs = 0;      // 같은 정지 구간에서 텔레그램 도배 방지

// 하트비트 — 메모리 사본. 파일(heartbeat.json)과 함께 간다.
// 재배포·재시작해도 '마지막 확인'이 '확인 전'으로 리셋되지 않게 파일에서 되읽는다.
const heartbeat = {
  lastStartAt: null,   // 사이클 시작 시각
  lastFinishAt: null,  // 사이클 종료 시각 ← 상태바의 '마지막 확인'
  lastOk: null,
  lastError: null,
  lastReason: null,
  lastMs: null,
  restarts: 0,         // 워치독이 되살린 누적 횟수
  failStreak: 0,       // 연속 수집 실패 횟수 (성공하면 0)
  staleUnlocks: 0,     // 죽은 락을 강제로 푼 누적 횟수
};

function loadHeartbeat() {
  try {
    Object.assign(heartbeat, storage.getHeartbeat() || {});
  } catch (e) {
    console.error('[heartbeat] 이전 기록 읽기 실패(무시):', e.message);
  }
}

// 하트비트 기록은 절대 감시를 방해하면 안 된다 — 쓰기 실패해도 삼킨다.
function beat(patch) {
  Object.assign(heartbeat, patch);
  try {
    storage.saveHeartbeat(heartbeat);
  } catch (e) {
    console.error('[heartbeat] 기록 실패(무시):', e.message);
  }
}

// 마지막 '활동' = 시작이든 종료든 가장 최근에 살아 있었다는 증거
function lastActivityMs() {
  const t = [heartbeat.lastStartAt, heartbeat.lastFinishAt]
    .map((x) => (x ? new Date(x).getTime() : 0))
    .filter((x) => !isNaN(x));
  return Math.max(0, ...t);
}

// 모든 수집 진입점(정기·시작·수동·워치독)은 이 함수를 통과한다 → 락이 전역으로 걸린다.
// 어떤 경로로 끝나든(성공·에러·타임아웃) finally 에서 락을 반드시 해제 → 다음 주기 정상 진행.
async function runCollectCycle(reason) {
  if (isCollecting) {
    // 락이 언제부터 잡혀 있었는지 본다. 정상 사이클은 길어야 CYCLE_TIMEOUT_MS 안에 끝나므로,
    // STALE_LOCK_MS 를 넘겼다면 그 사이클은 죽은 것이다(프로세스 정지·크롬 hang 등).
    // 이 검사가 없으면 락이 영영 안 풀려 이후 모든 수집이 '이미 진행 중' 으로 거부된다.
    // — 2026-08-18 실제로 6시간 멈췄다. 워치독(30분)만으로는 첫 30분을 못 살린다.
    const heldMs = collectStartedMs ? Date.now() - collectStartedMs : Infinity;
    if (heldMs < STALE_LOCK_MS) {
      // 살아 있는 수집이 돌고 있다.
      //  · 수동 확인은 '거부' 대신 '예약' 한다 — 사람이 누른 것이라 그냥 버리면
      //    아무 일도 안 일어난 것처럼 보인다. 끝나는 즉시 한 번 이어서 돈다.
      //    여러 번 눌러도 예약은 하나뿐이다(플래그라 중복이 쌓이지 않는다).
      //  · 정기·워치독 주기는 예전대로 건너뛴다. 어차피 곧 다음 주기가 온다.
      if (reason === 'manual') {
        pendingManualCheck = true;
        console.log(
          `[scheduler] 수집 진행 중(${Math.round(heldMs / 1000)}초 경과) — 수동 확인을 예약합니다`
        );
        return { ok: false, queued: true, error: null };
      }
      console.log(
        `[scheduler] 이전 수집이 아직 진행 중(${Math.round(heldMs / 1000)}초 경과) — 이번 주기(${reason}) 건너뜀`
      );
      return { ok: false, skipped: true, error: '이미 수집이 진행 중입니다.' };
    }
    staleUnlocks += 1;
    console.error(
      `[scheduler] 진행 중 플래그가 ${Math.round(heldMs / 60000)}분째 잡혀 있습니다 — ` +
        `죽은 락으로 보고 강제 해제 후 재실행 (누적 ${staleUnlocks}회)`
    );
    beat({ staleUnlocks });
    isCollecting = false;
  }
  isCollecting = true;
  const startedMs = Date.now();
  collectStartedMs = startedMs;
  beat({ lastStartAt: new Date(startedMs).toISOString(), lastReason: reason });
  try {
    console.log(`[scheduler] 정기 수집 시작 (reason=${reason})`);
    // 상한을 넘기면 예외. race 는 매달린 쪽을 취소하지 못하지만, 스크래퍼가 자기
    // 타임아웃으로 browser.close() 까지 해 주므로 크로뮴이 남지 않는다.
    const r = await withTimeout(checkOnce({ reason }), CYCLE_TIMEOUT_MS, '수집 사이클');
    beat({
      lastFinishAt: new Date().toISOString(),
      lastOk: r && r.ok !== false,
      lastError: r && r.ok === false ? r.error || '알 수 없음' : null,
      lastMs: Date.now() - startedMs,
      // 연속 실패 횟수 — 성공하면 0 으로 되돌린다. 상태바가 이 값을 보여 준다.
      failStreak: r && r.ok !== false ? 0 : (heartbeat.failStreak || 0) + 1,
    });
    return r;
  } catch (e) {
    // launch 타임아웃 등 예외는 이 주기만 실패로 두고 삼킨다(다음 주기에 자동 재시도).
    console.error(`[scheduler] 수집 예외 (${reason}):`, e.message);
    beat({
      lastFinishAt: new Date().toISOString(),
      lastOk: false,
      lastError: e.message,
      lastMs: Date.now() - startedMs,
      failStreak: (heartbeat.failStreak || 0) + 1,
    });
    return { ok: false, error: e.message };
  } finally {
    // 어떤 경로로 끝나든(성공·에러·타임아웃) 여기서 반드시 푼다.
    isCollecting = false;
    collectStartedMs = 0;

    // 도는 동안 눌린 '즉시 확인' 이 있으면 여기서 이어서 한 번 돈다.
    // 플래그를 먼저 내리는 이유: 이어지는 수집 중에 또 누르면 그때 다시 켜져야 한다.
    // 이 재실행 자체는 reason='manual' 이라, 만에 하나 또 겹치면 다시 예약될 뿐이다.
    // await 하지 않는다 — 지금 이 함수는 앞선 요청의 응답을 붙들고 있는 중일 수 있다.
    if (pendingManualCheck) {
      pendingManualCheck = false;
      console.log('[scheduler] 예약된 수동 확인을 이어서 실행합니다');
      setImmediate(() => {
        runCollectCycle('manual').catch((e) =>
          console.error('[scheduler] 예약 수동 확인 실패:', e.message)
        );
      });
    }
  }
}

// 수집이 끝난 뒤 다음 주기를 예약. 매번 설정에서 간격을 다시 읽어 변경을 자동 반영한다.
// 이 함수 안에서 던지면 체인이 영구히 끊긴다 → 설정 읽기 실패도 기본값으로 넘어간다.
function scheduleNext() {
  let m = 10;
  try {
    const s = storage.getSettings();
    m = Math.max(1, parseInt(s.intervalMinutes, 10) || 10);
    currentInterval = m;
  } catch (e) {
    console.error(`[scheduler] 설정 읽기 실패 — 기본 ${m}분으로 예약:`, e.message);
  }
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(async () => {
    try {
      await runCollectCycle('cron'); // 락으로 보호 — 실행 중이면 즉시 스킵
    } catch (e) {
      // runCollectCycle 은 스스로 삼키지만, 만에 하나를 위해 한 겹 더 둔다.
      console.error('[scheduler] 주기 실행 예외(무시하고 계속):', e.message);
    } finally {
      scheduleNext(); // 무슨 일이 있어도 다음 주기는 예약한다
    }
  }, m * 60000);
  console.log(`[scheduler] 다음 정기 수집 예약: ${m}분 후`);
}

// ---- 워치독 ----
// 위 두 겹을 다 뚫고도 활동이 끊기는 경우가 있다: 프로세스가 통째로 얼었다 깨어난 뒤
// (Railway 절전·호스트 정지) 타이머가 유실되거나, 락이 참인 채로 남는 경우.
// '마지막 활동'이 30분 넘게 갱신되지 않으면 락을 풀고 예약을 새로 잡고 즉시 1회 수집한다.
// 정지 판정 임계값. 30분 고정으로 두면 수집 간격을 30분 이상으로 설정한 순간
// 매 점검마다 오발동해 수집을 계속 덧돌린다. 간격의 3배와 30분 중 큰 값을 쓴다.
// (상태바·/health/watch 도 같은 잣대를 써야 화면과 워치독이 어긋나지 않는다)
function stallThresholdMs() {
  const interval = currentInterval || 10;
  return Math.max(WATCHDOG_STALL_MS, interval * 3 * 60000);
}

function watchdogTick() {
  const now = Date.now();
  const last = lastActivityMs();
  // 부팅 직후(기록 없음)에는 시작 시각을 기준으로 삼아 헛발질을 막는다
  const base = last || bootMs;
  const idleMs = now - base;
  if (idleMs < stallThresholdMs()) return;

  const mins = Math.round(idleMs / 60000);
  heartbeat.restarts += 1;
  console.error(
    `[watchdog] ${mins}분간 수집 활동 없음 — 감시 루프 재시작 #${heartbeat.restarts} ` +
      `(isCollecting=${isCollecting}, timer=${nextTimer ? '있음' : '없음'})`
  );

  // 사이클 상한(5분)의 6배가 지났다 → 살아 있는 수집일 수 없다. 락을 강제로 푼다.
  isCollecting = false;
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = null;
  beat({ restarts: heartbeat.restarts });

  // 같은 정지 구간에서 매분 보내지 않도록 임계값 간격으로 한 번만 알린다.
  if (now - stallAlertedMs > stallThresholdMs()) {
    stallAlertedMs = now;
    sendTelegram(
      '⚠️ <b>새싹 레이더 감시 정지 감지</b>\n' +
        `${mins}분간 수집이 멈춰 있어 루프를 자동 재시작했습니다.`
    ).catch(() => {});
  }

  scheduleNext();
  runCollectCycle('watchdog').catch((e) =>
    console.error('[watchdog] 재시작 수집 예외:', e.message)
  );
}

// ---- Railway 절전 대비 자체 keep-alive ----
// Railway 의 App Sleeping(서버리스)이 켜져 있으면 인바운드 요청이 없을 때 앱이 잠든다.
// 잠들면 타이머가 서지 않아 감시가 통째로 멈춘다. 자기 공개 URL 을 주기적으로 때리면
// 그게 인바운드 트래픽이라 유휴 타이머가 계속 초기화된다.
//   · 한계: 이미 잠든 뒤에는 스스로 깨우지 못한다 → 절전 자체를 끄는 게 정답이고,
//     이건 보조 수단이다. 외부 모니터(UptimeRobot 등)로 /health 를 때리면 확실하다.
const KEEPALIVE_MS = envMin('KEEPALIVE_MIN', 5);

function keepAliveUrl() {
  const explicit = process.env.KEEPALIVE_URL || process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, '') + '/health';
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN; // Railway 가 자동 주입
  if (domain) return `https://${domain}/health`;
  return null;
}

function startKeepAlive() {
  const url = keepAliveUrl();
  if (!url) {
    console.log(
      '[keepalive] 공개 URL 을 알 수 없어 자체 핑을 생략합니다 ' +
        '(Railway 절전을 끄거나 KEEPALIVE_URL 을 설정하세요)'
    );
    return;
  }
  console.log(`[keepalive] ${KEEPALIVE_MS / 60000}분 간격 자체 핑: ${url}`);
  setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) console.warn('[keepalive] 응답 상태', res.status);
    } catch (e) {
      console.warn('[keepalive] 실패(무시):', e.message);
    }
  }, KEEPALIVE_MS);
}

function rescheduleIfChanged() {
  const s = storage.getSettings();
  if (s.intervalMinutes !== currentInterval) {
    console.log(
      `[scheduler] 간격 변경 감지 ${currentInterval} → ${s.intervalMinutes}분, 재예약`
    );
    scheduleNext(); // 대기 중 타이머를 새 간격으로 교체(실행 중이면 다음 주기부터 적용)
  }
}

// ---- 페이지: 대시보드 ----
app.get('/', (req, res) => {
  const s = storage.getSettings();
  const log = storage.getLog();
  const today = new Date().toISOString().slice(0, 10);
  // 테스트(리허설) 알림은 "오늘 보낸 알림" 카운트에서 제외
  const todayCount = log.filter(
    (l) => (l.at || '').slice(0, 10) === today && l.sent && l.kind !== 'test'
  ).length;

  const chips = [];
  for (const v of s.programType) chips.push(v);
  for (const v of s.schoolLevels) chips.push(v);
  for (const v of s.regions) chips.push(v);
  for (const v of s.statuses) chips.push(v);
  for (const v of s.targets) chips.push('#' + classify.shortOf(v));

  const chipsHtml = chips
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
    .join('');

  const badgeMap = {
    test: '<span class="badge badge-test">테스트</span>',
    start: '<span class="badge badge-start">모집 시작</span>',
    new: '<span class="badge badge-new">신규</span>',
    reminder: '<span class="badge badge-reminder">리마인더</span>',
    change: '<span class="badge badge-change">정보 변경</span>',
    'new-label': '<span class="badge badge-newlabel">새 분류</span>',
  };
  const logRows = log
    .slice(0, 20)
    .map((l) => {
      const badge = badgeMap[l.kind] || badgeMap.new;
      const time = relativeTime(l.at, Date.now());
      const hasLink = !!l.link;
      const gonow = hasLink ? '<span class="gonow">↗ 이동</span>' : '';
      // 로그 줄에서는 [운영기관] 프로그램명을 말줄임 처리 (logtitle 에서 ellipsis)
      const inner = `${badge}${ratingOf(l.institution, s).mark}
        <span class="logtitle">${escapeHtml(instLabel(l.institution, l.title))}</span>
        <span class="logtime">${escapeHtml(time)}</span>
        ${gonow}`;
      // 링크 있는 항목: 줄 전체를 새 탭 링크로. 링크 없는 항목(테스트 등)은 클릭 비활성.
      return hasLink
        ? `<a class="logrow logrow-link" href="${escapeHtml(l.link)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="logrow logrow-disabled">${inner}</div>`;
    })
    .join('');

  const nowMs = Date.now();
  const w = watchStatus(nowMs);
  const rel = w.rel;
  const okText = w.text;
  const dotClass = w.dot;
  const condChips = conditionChips(s);
  const planner = renderPlanner();

  // '지금 즉시 확인' 은 크로미움을 띄워 수집을 돌리는 버튼이라 관리자만 쓴다.
  // 대시보드 자체는 공개라 로그인 안 한 사람도 이 화면을 본다 — 그 사람에게는
  // 버튼을 비활성 톤으로 보여 주고, 눌러도 실패가 아니라 안내가 나가게 한다.
  // 비밀번호를 걸지 않은 로컬에서는 모두가 관리자다(authEnabled() === false).
  const canRunCheck = !authEnabled() || isAuthed(req);
  const checkIntervalMin = currentInterval || s.intervalMinutes;

  // 섹션 자동 우선순위: 오픈일시 확인된 예정 프로그램이 1개 이상이면 플래너를 위로
  const recentSection = `
    <div class="card">
      <div class="row-between">
        <div class="card-title">최근 감지</div>
        ${canRunCheck
          ? '<button id="checkBtn" class="btn btn-green btn-sm">지금 즉시 확인</button>'
          : `<button id="checkBtn" class="btn btn-sm btn-locked" title="관리자 전용"
               aria-label="지금 즉시 확인 (관리자 전용)">🔒 지금 즉시 확인</button>`}
      </div>
      <div id="checkResult" class="muted small"></div>
      <div class="loglist">${logRows || '<div class="muted small">아직 감지된 항목이 없습니다.</div>'}</div>
    </div>`;
  const sections =
    planner.openReady >= 1 ? planner.html + recentSection : recentSection + planner.html;

  res.send(pageShell('새싹 레이더', `
    <div class="header">
      <!-- 이미 대시보드다 → 눌러도 이동이 아니라 새로고침. href 는 그대로 두어
           JS 가 죽어도, 새 탭으로 열어도 대시보드로 가게 한다. -->
      <a class="logo" href="/" id="logoHome" title="새로고침" aria-label="대시보드 새로고침">🌱 새싹 레이더</a>
      ${navTabs('home')}
    </div>

    <div class="statusbar">
      <span class="sdot ${dotClass}"></span>
      <span class="sb-main">${escapeHtml(okText)}</span>
      <span class="sb-sep">·</span><span>${escapeHtml(rel)} 확인</span>
      <span class="sb-sep">·</span><span>${currentInterval || s.intervalMinutes}분 간격</span>
      <span class="sb-sep">·</span><span>일치 ${runtime.lastMatchCount}건</span>
      <span class="sb-sep">·</span><span>오늘 알림 ${todayCount}건</span>
      <span class="sb-sep">·</span><span id="permInline" class="sb-perm"></span>
    </div>
    <div class="condbar">
      <span class="condlabel">감시 조건</span>
      ${condChips || '<span class="muted">조건 없음</span>'}
    </div>

    ${sections}

    ${(heartbeat.lastError || runtime.lastError) ? `<div class="card err">
      마지막 오류: ${escapeHtml(heartbeat.lastError || runtime.lastError)}
      ${w.streak > 1 ? ` · <b>${w.streak}회 연속 실패</b>` : ''}
      ${heartbeat.staleUnlocks ? ` · 죽은 락 해제 ${heartbeat.staleUnlocks}회` : ''}
    </div>` : ''}

    <script>
      // 제목을 누르면 새로고침한다. 이미 대시보드라 '/' 로 이동시켜도 되지만,
      // 그러면 브라우저가 캐시된 화면을 그대로 보여 줄 수 있어 reload 로 최신을 받는다.
      // 새 탭/가운데 클릭·수정키 조합은 가로채지 않는다 (href 가 그대로 살아 있다).
      const logo = document.getElementById('logoHome');
      if (logo) {
        logo.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          location.reload();
        });
      }

      const btn = document.getElementById('checkBtn');
      const out = document.getElementById('checkResult');
      const BTN_IDLE = '지금 즉시 확인';
      // 서버가 이 화면을 그릴 때의 로그인 상태. 세션이 만료되면 아래에서 false 로 내린다.
      let canRun = ${canRunCheck ? 'true' : 'false'};
      const ADMIN_ONLY =
        '관리자 전용 기능이에요. 감시는 ${checkIntervalMin}분마다 자동으로 돌고 있으니 그대로 보시면 됩니다 😊';

      function setResult(text, kind) {
        // kind: 'ok' | 'wait'(예약·안내) | 'lock'(관리자 전용 안내) | 'err'(진짜 실패)
        out.textContent = text;
        out.className = 'small check-result check-' + kind;
      }
      function releaseBtn() {
        btn.disabled = false;
        btn.textContent = BTN_IDLE;
      }
      // 세션이 만료된 채로 화면만 열려 있던 경우. 눌러 본 뒤에야 알 수 있으므로
      // 그 자리에서 버튼을 잠금 모양으로 바꿔 둔다 (다음에 또 헛수고하지 않게).
      function lockBtn() {
        canRun = false;
        btn.disabled = false;
        btn.textContent = '🔒 ' + BTN_IDLE;
        btn.title = '관리자 전용';
        btn.classList.remove('btn-green');
        btn.classList.add('btn-locked');
      }

      btn.addEventListener('click', async () => {
        // 관리자가 아니면 요청 자체를 보내지 않는다 — 어차피 401 이고,
        // 안 되는 이유를 '실패' 로 알릴 일이 아니라 안내로 알릴 일이다.
        if (!canRun) { setResult(ADMIN_ONLY, 'lock'); return; }

        btn.disabled = true;
        btn.textContent = '확인 중...';
        out.textContent = '';
        out.className = 'muted small';
        try {
          const r = await fetch('/api/check-now', { method: 'POST' });
          if (r.status === 401) { setResult(ADMIN_ONLY, 'lock'); lockBtn(); return; }
          const d = await r.json();
          if (d.ok) {
            setResult('완료: 전체 ' + d.total + '건 / 일치 ' + d.matched + '건 / 알림 ' + d.notified + '건. 새로고침합니다…', 'ok');
            setTimeout(() => location.reload(), 1200);
          } else if (d.queued) {
            // 실패가 아니다. 지금 도는 수집이 끝나는 대로 서버가 한 번 더 돈다.
            setResult('확인 예약됨 — 현재 수집이 끝나는 대로 실행합니다', 'wait');
            releaseBtn();
          } else {
            setResult('수집 실패: ' + (d.error || '알 수 없음'), 'err');
            releaseBtn();
          }
        } catch (e) {
          setResult('요청 오류: ' + e.message, 'err');
          releaseBtn();
        }
      });

      // ---- 브라우저 알림 / 토스트 ----
      // 실제 구현은 pageShell 의 saessak 하나뿐이다 (설정 화면과 완전히 공유).
      function showBrowserNotification(opts) { return saessak.fireNotification(opts) === 'sent'; }
      function toast(msg) { return saessak.toast(msg); }

      // ---- 알림 자동 발사(폴링) ----
      // 서버가 감지해 로그에 남긴 항목을 브라우저 알림으로 띄우는 '실제 경로'.
      // 탭이 열려 있는 동안만 동작한다 — 탭을 닫아도 오는 알림은 텔레그램 쪽이다.
      // 마지막으로 띄운 시각을 localStorage 에 남겨 중복 발사를 막는다.
      var NOTIF_SEEN_KEY = 'saessak:lastNotifiedAt';
      var NOTIF_POLL_MS = 60000;

      async function pollNotifications() {
        if (saessak.permission() !== 'granted') return; // 권한 없으면 조용히 대기
        try {
          var r = await fetch('/api/notifications?limit=10', { cache: 'no-store' });
          if (!r.ok) return;
          var d = await r.json();
          var items = (d.items || []).filter(function (it) { return it.at; });
          if (!items.length) return;

          // 최신순으로 온다 → 발사는 오래된 것부터
          items = items.slice().reverse();
          var newest = items[items.length - 1].at;
          var seen = localStorage.getItem(NOTIF_SEEN_KEY);

          // 첫 방문(기준 없음)에는 기존 로그를 몰아서 띄우지 않고 기준선만 잡는다.
          if (!seen) { localStorage.setItem(NOTIF_SEEN_KEY, newest); return; }

          var fresh = items.filter(function (it) { return it.at > seen; });
          for (var i = 0; i < fresh.length; i++) saessak.fireNotification(fresh[i]);
          if (newest > seen) localStorage.setItem(NOTIF_SEEN_KEY, newest);
        } catch (_) { /* 네트워크 실패는 다음 주기에 다시 시도 */ }
      }

      setInterval(pollNotifications, NOTIF_POLL_MS);
      pollNotifications();
      // 탭으로 돌아왔을 때 즉시 한 번 (백그라운드에서 타이머가 눌린 경우 대비)
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) pollNotifications();
      });

      // ---- 브라우저 알림 권한(상태바 인라인) ----
      // permission 상태에 따라 상태바에 표시. requestPermission 은 "알림 켜기" 버튼 클릭에서만.
      function renderPermInline() {
        var el = document.getElementById('permInline');
        if (!el) return;
        var perm = saessak.permission();
        // Notification.permission 원값을 그대로 함께 노출한다 (문제 판별용).
        var raw = '<code class="permraw">' + perm + '</code>';
        if (perm === 'unsupported') { el.innerHTML = '<span class="perm-bad">알림 미지원</span>'; return; }
        if (perm === 'granted') { el.innerHTML = '<span class="perm-ok">🔔 브라우저 알림 켜짐</span> ' + raw; return; }
        if (perm === 'denied') {
          el.innerHTML = '<span class="perm-bad" title="주소창 자물쇠 → 알림 → 허용으로 변경 후 새로고침">🔕 알림 차단됨 (자물쇠→알림→허용)</span> ' + raw;
          return;
        }
        el.innerHTML = '<button id="permBtn" class="btn btn-amber btn-xs">🔔 알림 켜기</button> ' + raw;
        var pb = document.getElementById('permBtn');
        if (pb) {
          pb.addEventListener('click', function () {
            Notification.requestPermission().then(function (p) {
              renderPermInline();
              if (p === 'granted') {
                showBrowserNotification({ title: '🌱 새싹 레이더', body: '새싹 레이더 알림이 켜졌습니다' });
                toast('브라우저 알림이 켜졌습니다');
              } else if (p === 'denied') {
                toast('알림이 차단되었습니다 — 주소창 자물쇠에서 변경할 수 있어요');
              }
            });
          });
        }
      }
      renderPermInline();
    </script>
  `));
});

// 종합점수 내림차순 (미평가는 맨 아래, 동점이면 가나다)
function sortByScore(a, b) {
  const av = a.score == null ? -1 : a.score;
  const bv = b.score == null ? -1 : b.score;
  if (av !== bv) return bv - av;
  return a.name.localeCompare(b.name, 'ko');
}

// ---- 설정 페이지: 기관 평가 섹션 ----
// 56개 기관을 아코디언으로 펼쳐 평가하고, 표식 노출 여부(showRatings)를 토글한다.
function institutionsSection(s) {
  const list = institutionsCached();
  const done = list.filter((r) => r.evaluated).length;

  // 접힌 상태 요약: 판정 색점 · ★강사구성 · 하트 · 종합점수 배지
  const summaryOf = (r) => {
    if (!r.evaluated) return '<span class="muted small">미평가</span>';
    const bits = [];
    if (VERDICT_LABEL[r.verdict]) {
      bits.push(
        `<span class="vchip v-${r.verdict}">${markDot(r.verdict)}${VERDICT_LABEL[r.verdict]}</span>`
      );
    }
    if (r.staffScore != null) bits.push(markStar(r.staffScore));
    if (r.heart) bits.push(markHeart());
    if (r.score != null) {
      bits.push(
        `<span class="sbadge s-${r.verdict || 'none'}" title="종합점수 ${r.score}/100">${r.score}</span>`
      );
    }
    return bits.join(' ');
  };

  const sel = (name, value, opts) =>
    `<select class="ifield" data-k="${name}">
      <option value=""${value == null || value === '' ? ' selected' : ''}>미평가</option>
      ${opts
        .map(
          ([v, label]) =>
            `<option value="${escapeHtml(String(v))}"${
              String(value) === String(v) ? ' selected' : ''
            }>${escapeHtml(label)}</option>`
        )
        .join('')}
    </select>`;

  // 기본 정렬: 종합점수 높은 순 (미평가는 아래). 나머지 정렬은 클라이언트에서 재배치.
  const sorted = list.slice().sort((a, b) => sortByScore(a, b));

  const rows = sorted
    .map(
      (r) => `<details class="irow${r.evaluated ? '' : ' irow-todo'}"
      data-name="${escapeHtml(r.name)}"
      data-eval="${r.evaluated ? '1' : '0'}" data-verdict="${escapeHtml(r.verdict || '')}"
      data-score="${r.score == null ? -1 : r.score}"
      data-staff="${r.staffScore == null ? -1 : r.staffScore}">
      <summary>
        <span class="iname">${escapeHtml(r.name)}</span>
        <span class="isum">${summaryOf(r)}</span>
      </summary>
      <div class="iedit">
        <div class="ifields">
          <label class="ifl ifl-staff">강사구성${sel(
            'staffScore',
            r.staffScore,
            storage.STAFF_STEPS.map(([v, label]) => [v, `${label} (${v})`])
          )}</label>
          <label class="ifl" title="강사료 기준 7.5만원">강사료${sel('pay', r.pay, [
            ['over', '초과 (20)'],
            ['avg', '평균 7.5만 (18)'],
            ['under', '이하 (15)'],
          ])}</label>
          <label class="ifl" title="산출물 요구·행정 부담 등 운영 편의">운영 편의${sel('ops', r.ops, [
            ['easy', '편함 (10)'],
            ['normal', '보통 (9)'],
            ['hard', '까다로움 (8)'],
          ])}</label>
          <label class="ifl" title="교구를 업체가 가져오는지">교구${sel('material', r.material, [
            ['yes', '있음 (10)'],
            ['no', '없음 (8)'],
          ])}</label>
          <label class="ifl" title="참고용 항목입니다 — 종합점수에 반영되지 않습니다">
            연수 <span class="noscore">참고·점수 미반영</span>
            ${sel(
              'training',
              r.training,
              [
                ['live', '라이브'],
                ['video', '동영상'],
                ['live_then_video', '초반 라이브→후반 동영상'],
              ]
                // 예전에 저장해 둔 값(온라인/오프라인)이 있으면 지워지지 않게 선택지에 남긴다
                .concat(
                  r.training === 'online' || r.training === 'offline'
                    ? [[r.training, r.training === 'online' ? '온라인(구 표기)' : '오프라인(구 표기)']]
                    : []
                )
            )}
          </label>
          <label class="ifl">간식${sel('snack', r.snack, [
            ['twice', '2번 이상 (10)'],
            ['once', '1번 (9)'],
            ['no', '안 줌 (8)'],
          ])}</label>
          <label class="ifl" title="사람이 내리는 결론 — 종합점수에 반영되지 않습니다">
            종합판정 <span class="noscore">점수 미반영</span>
            ${sel('verdict', r.verdict, [
              ['strong', '강력추천'],
              ['ok', '추천'],
              ['no', '비추천'],
            ])}
          </label>
          <label class="ifl ifl-heart" title="승인을 잘해주는 기관 (참고용 — 종합점수 미반영)">
            <input type="checkbox" class="ifield" data-k="heart" ${r.heart ? 'checked' : ''}>
            <span>${markHeart()} 승인 잘해줌</span>
          </label>
        </div>
        <div class="iskip muted small"${r.staffScore === 0 ? '' : ' hidden'}>
          강사구성 0 — <b>신청 대상 제외</b>로 보고 종합점수 0점 · 종합판정 '비추천'으로 고정합니다.
        </div>
        <label class="ifl ifl-wide">신청결과 메모
          <input type="text" class="ifield" data-k="approvalNote" maxlength="500"
            placeholder="예: 신청한 것 다 해줌" value="${escapeHtml(r.approvalNote || '')}">
        </label>
        <label class="ifl ifl-wide">자유 메모
          <textarea class="ifield" data-k="memo" rows="2" maxlength="500"
            placeholder="정성 평가·특이사항">${escapeHtml(r.memo || '')}</textarea>
        </label>
        <div class="iactions">
          <button type="button" class="btn btn-green btn-sm isave">저장</button>
          <span class="imsg muted small"></span>
        </div>
      </div>
    </details>`
    )
    .join('');

  return `
    <div class="card" id="institutions">
      <div class="card-title">🏢 기관 평가</div>
      <label class="opt ${s.showRatings ? 'on' : ''}" id="showRatingsOpt">
        <input type="checkbox" id="showRatings" ${s.showRatings ? 'checked' : ''}>
        <span>플래너에 표시</span>
      </label>
      <div class="muted small" style="margin-top:8px;">
        켜면 플래너·최근 감지 카드의 업체명 앞에 표식이 붙습니다.
        끄면 아래 개별 선택과 무관하게 <b>전부 숨김</b>이고, 이 설정 페이지에서만 보입니다.
        (텔레그램 메시지는 영향 없음)
      </div>
      <div class="submarks${s.showRatings ? '' : ' submarks-off'}">
        <div class="muted small" style="margin-bottom:6px;">표시할 표식 고르기</div>
        <div class="opts">
          ${[
            ['showVerdict', `${markVerdict('strong')} 판정 문구 배지`],
            ['showScore', `<span class="imk-score">100점</span> 종합점수`],
            ['showHeart', `${markHeart()} 승인 잘해줌`],
            ['dimSkip', `${markVerdict('no')} 기관 흐리게`],
          ]
            .map(
              ([key, label]) => `<label class="opt ${s[key] ? 'on' : ''}">
              <input type="checkbox" class="markopt" data-k="${key}" ${s[key] ? 'checked' : ''}>
              <span>${label}</span>
            </label>`
            )
            .join('')}
        </div>
      </div>
      <div class="muted small istats" style="margin-top:10px;">
        전체 <b>${list.length}</b> · 평가완료 <b class="idone">${done}</b> ·
        미평가 <b class="itodo">${list.length - done}</b>
      </div>
      <div class="muted small" style="margin-top:4px;">
        종합점수(100점) = 강사구성 ${storage.SCORE_WEIGHTS.staffMax} ·
        강사료 ${storage.SCORE_WEIGHTS.pay.over} ·
        운영 편의 ${storage.SCORE_WEIGHTS.ops.easy} ·
        교구 ${storage.SCORE_WEIGHTS.material.yes} ·
        간식 ${storage.SCORE_WEIGHTS.snack.twice} ·
        <b>종합판정·연수·승인 0(미반영)</b>
        &nbsp;/&nbsp; 강사구성 0은 무조건 0점
      </div>
      <div class="ifilters">
        <button type="button" class="fchip on" data-f="all">전체</button>
        <button type="button" class="fchip" data-f="done">평가완료</button>
        <button type="button" class="fchip" data-f="todo">미평가</button>
        <button type="button" class="fchip" data-f="strong">강력추천만</button>
      </div>
      <div class="ifilters isorts">
        <span class="muted small" style="align-self:center;">정렬</span>
        <button type="button" class="fchip on" data-s="score">종합점수 높은 순</button>
        <button type="button" class="fchip" data-s="staff">강사구성 높은 순</button>
        <button type="button" class="fchip" data-s="name">가나다 순</button>
        <button type="button" class="fchip" data-s="done">평가완료 우선</button>
      </div>
      <div class="ilist">${rows}</div>
    </div>`;
}

// ---- 페이지: 설정 (보호) ----
app.get('/settings', requireAuth, (req, res) => {
  const s = storage.getSettings();

  const cb = (group, value, label, checked) => `
    <label class="opt ${checked ? 'on' : ''}">
      <input type="checkbox" name="${group}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(label)}</span>
    </label>`;

  const has = (arr, v) => arr.includes(v);

  // 모든 조건 카테고리는 합집합(OR) 판정이다.
  // 체크를 늘릴수록 조건이 '넓어져' 더 많이 잡힌다는 걸 카드마다 명시해 오조작을 막는다.
  const orTag = (extra) =>
    `<span class="muted small">(여러 개 선택 = 넓어짐 · OR${extra ? ' · ' + extra : ''})</span>`;

  res.send(pageShell('감시 조건 설정', `
    <div class="header">
      <a class="logo" href="/" title="홈으로" aria-label="대시보드로 이동">🌱 감시 조건 설정</a>
      ${navTabs('settings')}
    </div>

    <div class="card" style="border-left:3px solid #2f855a;">
      <div class="card-title">조건 판정 방식</div>
      <div class="muted small">
        아래 5개 카테고리는 모두 <b>합집합(OR)</b> 입니다 — 체크한 값 중 <b>하나라도</b> 카드에 있으면 통과.
        여러 개를 체크하면 조건이 <b>좁아지는 게 아니라 넓어집니다</b>.<br>
        카테고리끼리는 AND 로 묶입니다 (예: 유형 통과 <b>그리고</b> 권역 통과 …).
        한 카테고리를 전부 해제하면 그 항목은 <b>조건 없음(전체 통과)</b> 으로 처리됩니다.<br>
        <b>프로그램 수준</b>(기본 / 특화 / AI특화) 은 감시 조건에서 <b>제외</b> 되어 전부 통과합니다.
      </div>
    </div>

    <form id="settingsForm">
      <div class="card" id="conditions" style="scroll-margin-top:16px;">
        <div class="card-title">프로그램 유형 ${orTag()}</div>
        <div class="opts">
          ${cb('programType', '방문형', '방문형', has(s.programType, '방문형'))}
          ${cb('programType', '집합형', '집합형', has(s.programType, '집합형'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">학교급 ${orTag()}</div>
        <div class="opts">
          ${cb('schoolLevels', '초등학교', '초등학교', has(s.schoolLevels, '초등학교'))}
          ${cb('schoolLevels', '중학교', '중학교', has(s.schoolLevels, '중학교'))}
          ${cb('schoolLevels', '고등학교', '고등학교', has(s.schoolLevels, '고등학교'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">운영권역 ${orTag()}</div>
        <div class="opts">
          ${cb('regions', '서울·인천권', '서울·인천권', has(s.regions, '서울·인천권'))}
          ${cb('regions', '경기권', '경기권', has(s.regions, '경기권'))}
          ${cb('regions', '강원·충청권', '강원·충청권', has(s.regions, '강원·충청권'))}
          ${cb('regions', '경상권', '경상권', has(s.regions, '경상권'))}
          ${cb('regions', '호남·제주권', '호남·제주권', has(s.regions, '호남·제주권'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">모집상태 ${orTag()}</div>
        <div class="opts">
          ${cb('statuses', '모집 예정', '모집 예정 (신규 등록 감지)', has(s.statuses, '모집 예정'))}
          ${cb('statuses', '모집 중', '모집 중 (전환 감지)', has(s.statuses, '모집 중'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">교육대상 ${orTag('마우스를 올리면 전체 이름')}</div>
        <div class="opts">
          ${classify.CATEGORIES.map((c) => {
            const checked = has(s.targets, c.full);
            return `<label class="opt ${checked ? 'on' : ''}" title="${escapeHtml(c.full)}">
              <input type="checkbox" name="targets" value="${escapeHtml(c.full)}" ${checked ? 'checked' : ''}>
              <span>${escapeHtml(c.short)}</span>
            </label>`;
          }).join('')}
          ${(() => {
            const checked = has(s.targets, classify.UNCLASSIFIED);
            return `<label class="opt ${checked ? 'on' : ''}" title="알 수 없는 신설/변경 분류(미분류)까지 알림 대상에 포함">
              <input type="checkbox" name="targets" value="${escapeHtml(classify.UNCLASSIFIED)}" ${checked ? 'checked' : ''}>
              <span>미분류</span>
            </label>`;
          })()}
        </div>
      </div>

      <div class="card">
        <div class="card-title">알림 유형</div>
        <div class="opts">
          <label class="opt ${s.notifyStart ? 'on' : ''}">
            <input type="checkbox" id="notifyStart" ${s.notifyStart ? 'checked' : ''}>
            <span>모집 시작 전환 알림</span>
          </label>
          <label class="opt ${s.notifyNew ? 'on' : ''}">
            <input type="checkbox" id="notifyNew" ${s.notifyNew ? 'checked' : ''}>
            <span>신규 모집예정 등록 알림</span>
          </label>
          <label class="opt ${s.notifyReminder ? 'on' : ''}">
            <input type="checkbox" id="notifyReminder" ${s.notifyReminder ? 'checked' : ''}>
            <span>오픈 리마인더</span>
          </label>
        </div>
        <div class="muted small" style="margin-top:8px;">
          '신규 모집예정 등록 알림'을 꺼도 신청 플래너에는 항상 표시됩니다.
        </div>
      </div>

      <div class="card">
        <div class="card-title">확인 간격</div>
        <div class="interval">
          <input type="number" id="intervalMinutes" name="intervalMinutes" min="1" max="1440" value="${s.intervalMinutes}">
          <span>분마다 확인</span>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-green btn-lg">저장</button>
        <span id="saveMsg" class="muted"></span>
      </div>
    </form>

    ${institutionsSection(s)}

    <div class="card">
      <div class="card-title">🔔 알림 리허설</div>
      <div class="muted small" style="margin-bottom:12px;">
        실제 알림 경로(브라우저 알림 + 텔레그램)를 그대로 사용해 테스트 알림 1건을 발송합니다.
        제목·본문·클릭 시 이동 경로는 서버의 알림 빌더가 실제 감지와 똑같이 만듭니다.<br>
        조건 일치 수·오늘 보낸 알림 카운트·감시 스냅샷(state)에는 반영되지 않습니다.
      </div>

      <div class="permstate">
        <div class="permstate-row">
          <span class="permstate-k">Notification.permission</span>
          <code id="permRaw" class="permraw permraw-lg">확인 중…</code>
          <span id="permHint" class="muted small"></span>
        </div>
        <div class="permstate-row">
          <span class="permstate-k">텔레그램 설정</span>
          <code class="permraw permraw-lg">${isTelegramConfigured() ? 'configured' : 'unset'}</code>
          <span class="muted small">${isTelegramConfigured()
            ? '탭을 닫아도 이 채널로 알림이 옵니다.'
            : 'TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID 미설정 — 콘솔 출력만 됩니다.'}</span>
        </div>
        <div id="permAction" style="margin-top:8px;"></div>
      </div>

      <button id="testBtn" class="btn btn-green">🔔 테스트 알림 보내기</button>
      <div id="testResult" class="small check-result"></div>
    </div>

    ${notifyLogSection()}

    <script>
      const form = document.getElementById('settingsForm');
      const msg = document.getElementById('saveMsg');

      // ---- 브라우저 알림 / 토스트 ----
      // 실제 구현은 pageShell 의 saessak 하나뿐이다 (대시보드와 완전히 공유).
      function showBrowserNotification(opts) { return saessak.fireNotification(opts) === 'sent'; }
      function toast(m) { return saessak.toast(m); }

      // ---- 알림 권한 상태 (원값 그대로 노출) ----
      var PERM_HINT = {
        granted: '이 브라우저에서 알림을 띄울 수 있습니다.',
        denied: '차단됨 — 주소창 자물쇠 → 알림 → 허용으로 바꾼 뒤 새로고침하세요.',
        default: '아직 허용/차단을 고르지 않았습니다.',
        unsupported: '이 브라우저는 Notification API 를 지원하지 않습니다.',
      };
      function renderPerm() {
        var perm = saessak.permission();
        var raw = document.getElementById('permRaw');
        var hint = document.getElementById('permHint');
        var act = document.getElementById('permAction');
        if (raw) raw.textContent = perm;
        if (hint) hint.textContent = PERM_HINT[perm] || '';
        if (!act) return;
        act.innerHTML = perm === 'default'
          ? '<button id="permBtn" class="btn btn-amber btn-xs">🔔 알림 권한 요청</button>'
          : '';
        var pb = document.getElementById('permBtn');
        if (pb) {
          pb.addEventListener('click', function () {
            Notification.requestPermission().then(function () { renderPerm(); });
          });
        }
      }
      renderPerm();

      // ---- 알림 리허설 버튼 ----
      // 서버가 실제 감지와 동일한 로그 엔트리를 만들고, 같은 notifyPayload() 로
      // 제목·본문·링크를 뽑아 준다. 클라이언트는 그걸 그대로 실제 발사 함수에 넘긴다
      // (여기서 문자열을 다시 조립하면 '실제와 같은지'를 검증할 수 없다).
      var testBtn = document.getElementById('testBtn');
      var testOut = document.getElementById('testResult');
      function setTestResult(text, kind) {
        if (!testOut) return;
        testOut.textContent = text;
        testOut.className = 'small check-result check-' + kind;
      }
      if (testBtn) {
        testBtn.addEventListener('click', async function () {
          testBtn.disabled = true;
          var orig = testBtn.textContent;
          testBtn.textContent = '발송 중…';
          setTestResult('', 'ok');
          try {
            var r = await fetch('/api/test-alert', { method: 'POST' });
            var d = await r.json();
            if (d.ok && d.notification) {
              var fire = saessak.fireNotification(d.notification);
              var browserText = fire === 'sent' ? '브라우저 O'
                : fire === 'denied' ? '브라우저 X(권한 차단)'
                : fire === 'default' ? '브라우저 X(권한 미허용)'
                : fire === 'unsupported' ? '브라우저 X(미지원)'
                : '브라우저 X(오류)';
              var tgText = d.telegram === 'sent' ? '텔레그램 O'
                : d.telegram === 'failed' ? '텔레그램 X(발송 실패)'
                : '텔레그램 미설정';
              var okAny = fire === 'sent' || d.telegram === 'sent';
              setTestResult(
                browserText + ' / ' + tgText + ' — 발송 제목: ' + d.notification.title,
                okAny ? 'ok' : 'err'
              );
              toast(browserText + ' / ' + tgText);
              renderPerm();
              // 로그에 방금 기록이 남았으므로 표를 갱신해서 바로 확인할 수 있게 한다.
              setTimeout(function () { location.reload(); }, 2500);
            } else {
              setTestResult('발송 실패: ' + (d.error || '알 수 없음'), 'err');
              toast('발송 실패');
            }
          } catch (e) {
            setTestResult('요청 오류: ' + e.message, 'err');
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = orig;
          }
        });
      }

      // ---- 기관 평가: 표시 토글 / 필터 / 개별 저장 ----
      (function institutions() {
        var box = document.getElementById('institutions');
        if (!box) return;

        // 표시 토글은 즉시 저장 (감시 조건 폼과 별개)
        var sw = document.getElementById('showRatings');
        sw.addEventListener('change', async () => {
          document.getElementById('showRatingsOpt').classList.toggle('on', sw.checked);
          try {
            const r = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ showRatings: sw.checked }),
            });
            const d = await r.json();
            toast(d.ok ? (sw.checked ? '플래너에 평가 표식 표시' : '평가 표식 숨김') : '저장 실패');
          } catch (e) { toast('오류: ' + e.message); }
        });

        // 개별 표식 체크박스 (마스터가 OFF면 아무 효과 없음 — 안내를 위해 흐리게만)
        box.querySelectorAll('.markopt').forEach((cb) => {
          cb.addEventListener('change', async () => {
            cb.closest('.opt').classList.toggle('on', cb.checked);
            var payload = {}; payload[cb.dataset.k] = cb.checked;
            try {
              const r = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const d = await r.json();
              toast(d.ok ? '표식 설정 저장됨' : '저장 실패');
            } catch (e) { toast('오류: ' + e.message); }
          });
        });
        // 마스터 토글에 따라 개별 옵션 영역을 흐리게
        sw.addEventListener('change', () => {
          box.querySelector('.submarks').classList.toggle('submarks-off', !sw.checked);
        });

        // 필터 칩
        box.querySelectorAll('.ifilters:not(.isorts) .fchip').forEach((chip) => {
          chip.addEventListener('click', () => {
            box.querySelectorAll('.ifilters:not(.isorts) .fchip').forEach((c) => c.classList.remove('on'));
            chip.classList.add('on');
            var f = chip.dataset.f;
            box.querySelectorAll('.irow').forEach((row) => {
              var ok = f === 'all'
                || (f === 'done' && row.dataset.eval === '1')
                || (f === 'todo' && row.dataset.eval === '0')
                || (f === 'strong' && row.dataset.verdict === 'strong');
              row.hidden = !ok;
            });
          });
        });

        // 정렬 칩 — DOM 재배치
        var listEl = box.querySelector('.ilist');
        box.querySelectorAll('.isorts .fchip').forEach((chip) => {
          chip.addEventListener('click', () => {
            box.querySelectorAll('.isorts .fchip').forEach((c) => c.classList.remove('on'));
            chip.classList.add('on');
            var k = chip.dataset.s;
            var rows = Array.from(box.querySelectorAll('.irow'));
            rows.sort((a, b) => {
              var an = a.dataset.name, bn = b.dataset.name;
              if (k === 'name') return an.localeCompare(bn, 'ko');
              if (k === 'staff') {
                var d = (+b.dataset.staff) - (+a.dataset.staff);
                return d || an.localeCompare(bn, 'ko');
              }
              if (k === 'done') {
                var e = (+b.dataset.eval) - (+a.dataset.eval);
                if (e) return e;
                var sd = (+b.dataset.score) - (+a.dataset.score);
                return sd || an.localeCompare(bn, 'ko');
              }
              var s2 = (+b.dataset.score) - (+a.dataset.score);
              return s2 || an.localeCompare(bn, 'ko');
            });
            rows.forEach((r) => listEl.appendChild(r));
          });
        });

        // 강사구성 0 → 종합판정 '비추천' 고정 + 안내
        box.addEventListener('change', (e) => {
          var f = e.target.closest('.ifield');
          if (!f || f.dataset.k !== 'staffScore') return;
          var row = f.closest('.irow');
          var zero = f.value === '0';
          var verdict = row.querySelector('[data-k="verdict"]');
          if (zero) { verdict.value = 'no'; }
          verdict.disabled = zero;
          row.querySelector('.iskip').hidden = !zero;
        });

        // 개별 저장
        box.querySelectorAll('.isave').forEach((btn) => {
          btn.addEventListener('click', async () => {
            var row = btn.closest('.irow');
            var msg = row.querySelector('.imsg');
            var payload = {};
            row.querySelectorAll('.ifield').forEach((f) => {
              payload[f.dataset.k] = f.type === 'checkbox' ? f.checked : f.value;
            });
            btn.disabled = true; msg.textContent = '저장 중…';
            try {
              const r = await fetch('/api/institutions/' + encodeURIComponent(row.dataset.name), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const d = await r.json();
              if (!d.ok) { msg.textContent = '저장 실패: ' + (d.error || ''); return; }
              msg.textContent = '저장됨 ✓';
              applySaved(row, d.institution);
            } catch (e) {
              msg.textContent = '오류: ' + e.message;
            } finally { btn.disabled = false; }
          });
        });

        // 저장 결과를 접힌 요약·필터 속성·통계에 반영
        function applySaved(row, r) {
          row.dataset.eval = r.evaluated ? '1' : '0';
          row.dataset.verdict = r.verdict || '';
          row.dataset.score = r.score == null ? -1 : r.score;
          row.dataset.staff = r.staffScore == null ? -1 : r.staffScore;
          row.classList.toggle('irow-todo', !r.evaluated);
          // 표식 조각은 서버와 같은 SVG 를 그대로 내려받아 쓴다 (이모지 금지)
          var MK = ${JSON.stringify({
            dot: { strong: markDot('strong'), ok: markDot('ok'), no: markDot('no') },
            star: icon('star-filled', 11),
            heart: markHeart(),
          })};
          var LBL = ${JSON.stringify(VERDICT_LABEL)};
          var STAFF = ${JSON.stringify(storage.STAFF_LABEL)};
          var html = '';
          if (!r.evaluated) {
            html = '<span class="muted small">미평가</span>';
          } else {
            var bits = [];
            if (LBL[r.verdict]) bits.push('<span class="vchip v-' + r.verdict + '">' + MK.dot[r.verdict] + LBL[r.verdict] + '</span>');
            if (r.staffScore !== null && r.staffScore !== undefined) {
              var st = STAFF[r.staffScore] ? ' (' + STAFF[r.staffScore] + ')' : '';
              bits.push('<span class="imk-star" title="강사구성 ' + r.staffScore + '점' + st + '">' + MK.star + '<b>' + r.staffScore + '</b></span>');
            }
            if (r.heart) bits.push(MK.heart);
            if (r.score !== null && r.score !== undefined) bits.push('<span class="sbadge s-' + (r.verdict || 'none') + '" title="종합점수 ' + r.score + '/100">' + r.score + '</span>');
            html = bits.join(' ');
          }
          row.querySelector('.isum').innerHTML = html;
          // 강사구성 0 저장 시 서버가 판정을 '비추천'으로 바꾸므로 화면도 맞춘다
          row.querySelector('[data-k="verdict"]').value = r.verdict || '';
          var rows = box.querySelectorAll('.irow');
          var done = box.querySelectorAll('.irow[data-eval="1"]').length;
          box.querySelector('.idone').textContent = done;
          box.querySelector('.itodo').textContent = rows.length - done;
        }
      })();

      // 체크 시각적 토글
      form.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
          e.target.closest('.opt').classList.toggle('on', e.target.checked);
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const groups = ['programType','schoolLevels','regions','statuses','targets'];
        const payload = {};
        for (const g of groups) {
          payload[g] = Array.from(form.querySelectorAll('input[name="'+g+'"]:checked')).map(i => i.value);
        }
        payload.intervalMinutes = parseInt(form.querySelector('#intervalMinutes').value, 10) || 10;
        payload.notifyStart = form.querySelector('#notifyStart').checked;
        payload.notifyNew = form.querySelector('#notifyNew').checked;
        payload.notifyReminder = form.querySelector('#notifyReminder').checked;
        msg.textContent = '저장 중…';
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (d.ok) {
            msg.textContent = '저장됨 ✓ 다음 주기부터 적용됩니다.';
          } else {
            msg.textContent = '저장 실패';
          }
        } catch (err) {
          msg.textContent = '오류: ' + err.message;
        }
      });
    </script>
  `));
});

// ============ 페이지: 신청 연습 (연습 전용) ============
//
// 원칙 — 이 화면은 실제 디지털새싹 사이트와 어떤 통신도 하지 않는다.
//  · 외부 도메인으로의 fetch / iframe / 링크 없음 (아래 프로그램은 전부 가상)
//  · 사용자가 넣는 값은 서버로 보내지 않는다. 채점도 기록도 브라우저 안에서만 한다.
//  · 목적은 신청 폼 작성 '속도를 스스로 연습' 하는 것이다 (타자 연습장과 같은 성격).
//    제출 자동화 도구가 아니며, 그렇게 쓰일 수 있는 경로를 만들지 않는다.
//
// 더미 프로그램: 기관·프로그램명 모두 가상이다. 실제 공고와 헷갈리지 않도록
// 실존 기관명을 쓰지 않는다.
const PRACTICE_PROGRAMS = [
  {
    id: 'p1',
    title: '한여름 밤의 AI 별자리 관측단',
    institution: '가상새싹연구소 (예시)',
    fields: {
      신청기간: '2026-09-01(화) 10:00 ~ 2026-09-12(금) 17:00',
      교육기간: '2026-10-05(월) ~ 2026-11-27(금)',
      교육대상: '초등학교 4~6학년',
      프로그램수준: '기본',
      프로그램소양: 'AI 리터러시',
      총교육차시: '12차시 (주 1회 2차시)',
      교육장소: '신청 학교 교실 (방문형)',
      운영권역: '서울·인천권',
      신청대상: '학급 단위 신청 (담임교사)',
      모집학급: '18학급',
    },
  },
  {
    id: 'p2',
    title: '우리 마을 데이터 탐정단',
    institution: '예시교육협동조합 (가상)',
    fields: {
      신청기간: '2026-09-03(목) 09:00 ~ 2026-09-19(금) 18:00',
      교육기간: '2026-10-12(월) ~ 2026-12-04(금)',
      교육대상: '중학교 1~3학년',
      프로그램수준: '특화',
      프로그램소양: '데이터 과학 · 문제해결',
      총교육차시: '16차시 (주 2회 2차시)',
      교육장소: '운영기관 실습실 (집합형)',
      운영권역: '경기권',
      신청대상: '학급 단위 신청 (교과 담당교사)',
      모집학급: '10학급',
    },
  },
  {
    id: 'p3',
    title: '로봇 팔로 배우는 자동화 원리',
    institution: '샘플과학교육센터 (가상)',
    fields: {
      신청기간: '2026-09-07(월) 14:00 ~ 2026-09-25(목) 17:00',
      교육기간: '2026-10-19(월) ~ 2026-12-11(금)',
      교육대상: '초등학교 5~6학년 / 중학교 1학년',
      프로그램수준: 'AI 특화',
      프로그램소양: '피지컬 컴퓨팅',
      총교육차시: '20차시 (주 2회 2차시)',
      교육장소: '신청 학교 과학실 (방문형)',
      운영권역: '강원·충청권',
      신청대상: '학급 단위 신청 (담임 또는 교과교사)',
      모집학급: '24학급',
    },
  },
];

// 주소 검색 모달용 더미 도로명 주소.
// 카카오/도로명주소 API 를 쓰지 않는다 — 이 목록 안에서만 필터링한다(외부 통신 없음).
// 실존 학교 주소가 아니라 형태만 맞춘 가상 주소다.
const PRACTICE_ADDRESSES = [
  { zip: '06134', road: '서울특별시 강남구 테헤란로 152', jibun: '역삼동 737' },
  { zip: '04524', road: '서울특별시 중구 세종대로 110', jibun: '태평로1가 31' },
  { zip: '07995', road: '서울특별시 양천구 목동동로 375', jibun: '목동 917' },
  { zip: '08826', road: '서울특별시 관악구 관악로 1', jibun: '신림동 산56-1' },
  { zip: '02841', road: '서울특별시 성북구 안암로 145', jibun: '안암동5가 1-2' },
  { zip: '05006', road: '서울특별시 광진구 능동로 209', jibun: '화양동 98' },
  { zip: '01811', road: '서울특별시 노원구 화랑로 621', jibun: '공릉동 172' },
  { zip: '13529', road: '경기도 성남시 분당구 판교역로 235', jibun: '삼평동 681' },
  { zip: '16489', road: '경기도 수원시 영통구 월드컵로 206', jibun: '원천동 산5' },
  { zip: '10390', road: '경기도 고양시 일산서구 킨텍스로 217', jibun: '대화동 2600' },
  { zip: '14059', road: '경기도 안양시 동안구 시민대로 235', jibun: '관양동 1591' },
  { zip: '11759', road: '경기도 의정부시 시민로 1', jibun: '의정부동 220' },
  { zip: '17058', road: '경기도 용인시 처인구 명지로 116', jibun: '남동 산38-2' },
  { zip: '21554', road: '인천광역시 남동구 예술로 152', jibun: '구월동 1131' },
  { zip: '24341', road: '강원특별자치도 춘천시 중앙로 1', jibun: '봉의동 15' },
  { zip: '34126', road: '대전광역시 유성구 대학로 291', jibun: '구성동 373-1' },
  { zip: '28644', road: '충청북도 청주시 서원구 충대로 1', jibun: '개신동 12' },
  { zip: '61186', road: '광주광역시 북구 첨단과기로 123', jibun: '오룡동 1', },
  { zip: '42601', road: '대구광역시 달서구 달구벌대로 1095', jibun: '신당동 1095' },
  { zip: '46241', road: '부산광역시 금정구 부산대학로63번길 2', jibun: '장전동 30' },
  { zip: '52828', road: '경상남도 진주시 진주대로 501', jibun: '가좌동 900' },
  { zip: '63243', road: '제주특별자치도 제주시 제주대학로 102', jibun: '아라일동 1' },
];

// 문제 생성 요소 — 연습 시작마다 랜덤 조합된다.
const PRACTICE_QUIZ = {
  sessions: [8, 12, 16],
  // 모집 학년 범위는 초등학교로만 뽑는다 (중·고 범위는 문제로 내지 않는다).
  ranges: [
    { label: '초등학교 1~6학년 전체', row: 'elem' },
    { label: '초등학교 1~4학년', row: 'elem' },
    { label: '초등학교 5~6학년', row: 'elem' },
    { label: '초등학교 3~6학년', row: 'elem' },
    { label: '초등학교 1~2학년', row: 'elem' },
  ],
  // 체크박스 행은 실제 폼과 똑같이 3줄을 그대로 둔다. 중·고 행은 늘 비활성이지만,
  // 실전에서 그 줄을 건너뛰는 눈동자 움직임까지 연습 대상이라 지우지 않는다.
  gradeRows: [
    { key: 'elem', label: '초등학교 1~6학년' },
    { key: 'mid', label: '중학교 1~3학년' },
    { key: 'high', label: '고등학교 1~3학년' },
  ],
  // 교육대상 — 실제 폼에 있는 7개를 그대로 둔다. 하나도 지우거나 잠그지 않는다.
  // 우리 학교가 신청할 수 있는 건 일반형·배려형(이주배경)·교복우 셋뿐이고,
  // 나머지 4개는 화면에는 똑같이 보이되 고르면 오답이다 (판정에서만 갈린다).
  // 라벨은 classify.js 의 short 표기를 그대로 써서 대시보드 표기와 어긋나지 않게 한다.
  eduTargets: [
    ...classify.CATEGORIES.map((c) => ({
      key: c.key,
      label: c.short,
      ok: c.key === 'general' || c.key === 'migrant' || c.key === 'welfare',
    })),
    { key: 'unknown', label: classify.UNCLASSIFIED, ok: false },
  ],
  opTimes: [
    '비교과 자유학기제',
    '비교과 창체 진로',
    '비교과 창체 동아리',
    '비교과 창체 자율',
    '방과후 주중',
    '방과후 주말',
  ],
  // 실전 요령 연습용 정형문구 (요청사항에 한 번에 붙여넣는다)
  boilerplate:
    '– 교육 대상: 본교 재학생 학급 단위\n' +
    '– 희망 시간대: 정규 수업 종료 후 (교내 협의 완료)\n' +
    '– 준비물: 노트북·태블릿 교내 보유분 활용 가능\n' +
    '– 주차: 교내 방문객 주차 가능 (사전 연락 요망)\n' +
    '– 담당자 연락 가능 시간: 평일 09:00~16:30',
};

// /settings 와 같은 방식으로 보호한다. ADMIN_PASSWORD 미설정 환경에서는
// authEnabled() 가 false 라 requireAuth 가 그대로 통과시킨다(로컬 개발 편의 유지).
app.get('/practice', requireAuth, (req, res) => {
  res.send(pageShell('신청 연습', `
    <div class="header">
      <a class="logo" href="/" title="홈으로" aria-label="대시보드로 이동">🏃 신청 연습</a>
      ${navTabs('practice')}
    </div>

    <div class="pr-notice" role="note">
      <span class="pr-notice-ico" aria-hidden="true">🛡️</span>
      <span><b>연습용 화면입니다.</b> 실제 신청과 무관하며 어떤 데이터도 전송되지 않습니다.</span>
    </div>

    <div class="card">
      <div class="row-between">
        <div class="card-title" style="margin-bottom:0;">연습 진행</div>
        <button id="prStart" class="btn btn-green btn-sm">연습 시작</button>
      </div>
      <div id="prStatus" class="pr-status">
        <b>대기 중</b> — [연습 시작] 을 누르면 모집 상태가 <b>모집 중</b> 으로 바뀝니다.
        바뀌는 즉시 아래 <b>신청하기</b> 를 누르세요.
      </div>
      <div id="prResult" class="pr-result" hidden></div>
    </div>

    <div class="card pr-card">
      <div class="pr-detail">
        <!-- 썸네일 자리: 실제 이미지를 쓰지 않는다 (외부 리소스 요청 금지) -->
        <div class="pr-thumb" id="prThumb" aria-hidden="true">
          <span class="pr-thumb-tag">이미지 자리</span>
          <span class="pr-thumb-name" id="prThumbName"></span>
        </div>
        <div class="pr-main">
          <span class="pr-badge pr-badge-soon" id="prBadge">모집 예정</span>
          <h2 class="pr-title" id="prTitle">—</h2>
          <div class="pr-inst" id="prInst">—</div>
          <dl class="pr-table" id="prTable"></dl>
        </div>
      </div>

      <div class="pr-apply-wrap">
        <!-- disabled 속성 대신 aria-disabled 를 쓴다: 진짜 disabled 면 클릭 이벤트가
             오지 않아 '헛클릭' 을 셀 수 없다. 동작은 JS 에서 막는다. -->
        <button id="prApply" class="pr-apply is-locked" aria-disabled="true">신청하기</button>
        <div id="prApplyMsg" class="pr-applymsg" role="status"></div>
      </div>
    </div>

    <div class="card" id="prFormCard" hidden>
      <div class="card-title">신청서 작성 <span class="muted small">(계측 중 — 아래 [신청] 까지)</span></div>

      <!-- 프로그램 기본정보: 실전처럼 '위를 보고 아래를 채우는' 구조 -->
      <div class="pf-info">
        <div class="pf-info-title">📋 프로그램 기본정보</div>
        <dl class="pf-info-list" id="pfInfoList"></dl>
        <div class="pf-info-hint" id="pfInfoHint"></div>
      </div>

      <!-- 1) 담당자 정보 — 고정 더미, 계측 대상 아님 -->
      <section class="pf-sec">
        <div class="pf-legend">1. 담당자 정보
          <span class="pf-tag">자동 입력 · 수정 불가 · 계측 제외</span>
        </div>
        <div class="pf-grid2">
          <label class="pf-field"><span class="pf-label">현장 담당자명</span>
            <input class="pf-in" value="홍길동" readonly tabindex="-1"></label>
          <label class="pf-field"><span class="pf-label">연락처</span>
            <input class="pf-in" value="010-1234-5678" readonly tabindex="-1"></label>
          <label class="pf-field"><span class="pf-label">이메일</span>
            <input class="pf-in" value="hong@naver.com" readonly tabindex="-1"></label>
          <label class="pf-field"><span class="pf-label">소속학교</span>
            <input class="pf-in" value="○○초등학교" readonly tabindex="-1"></label>
        </div>
        <div class="muted small" style="margin-top:7px;">
          전부 고정 더미값입니다. 실제 개인정보를 넣지 마세요.
        </div>
      </section>

      <!-- 2) 교육 장소 주소 -->
      <section class="pf-sec">
        <div class="pf-legend">2. 교육 장소 주소 <b class="pf-req">*</b></div>
        <div class="pf-addr-row">
          <input class="pf-in" id="pfAddr" placeholder="주소 검색으로 입력하세요" readonly>
          <button type="button" class="btn btn-sm btn-ghost" id="pfAddrBtn">주소 검색</button>
        </div>
        <input class="pf-in" id="pfAddrDetail" placeholder="상세주소 (선택 — 비워도 됩니다)" style="margin-top:7px;">
      </section>

      <!-- 3) 신청 교육 대상 -->
      <section class="pf-sec">
        <div class="pf-legend">3. 신청 교육 대상 <b class="pf-req">*</b></div>
        <select class="pf-in" id="pfTarget">
          <option value="">선택</option>
          <option value="일반학교">일반학교</option>
          <option value="초등돌봄·교육(구 늘봄학교)">초등돌봄·교육(구 늘봄학교)</option>
          <option value="특성화·마이스터고등학교">특성화·마이스터고등학교</option>
          <option value="학교밖(대안학교, 센터 등)">학교밖(대안학교, 센터 등)</option>
        </select>
      </section>

      <!-- 4) 신청 가능 대상 -->
      <section class="pf-sec">
        <div class="pf-legend">4. 신청 가능 대상 <b class="pf-req">*</b>
          <span class="pf-tag">모집 학년 범위에 해당하는 항목만 선택 가능</span>
        </div>
        <div class="pf-grades" id="pfGrades"></div>
      </section>

      <!-- 5) 교육대상 — 7개 전부 선택 가능. 맞고 틀림은 채점에서만 갈린다. -->
      <section class="pf-sec">
        <div class="pf-legend">5. 교육대상 <b class="pf-req">*</b>
          <span class="pf-tag">해당하는 것을 고르세요</span>
        </div>
        <div class="pf-edus" id="pfEdus"></div>
      </section>

      <!-- 6~7) 신청 인원 / 총 교육 차시 -->
      <section class="pf-sec">
        <div class="pf-grid2">
          <label class="pf-field"><span class="pf-label">6. 신청 인원 <b class="pf-req">*</b></span>
            <input class="pf-in" id="pfCount" type="number" min="1" max="99" inputmode="numeric" placeholder="명"></label>
          <label class="pf-field"><span class="pf-label">7. 총 교육 차시 <b class="pf-req">*</b></span>
            <input class="pf-in" id="pfSessions" type="number" min="1" max="99" inputmode="numeric" placeholder="차시"></label>
        </div>
      </section>

      <!-- 8) 교육 시작일 / 종료일 -->
      <section class="pf-sec">
        <div class="pf-legend">8. 교육 시작일 / 종료일 <b class="pf-req">*</b>
          <span class="pf-tag">형식만 채우면 통과 · 앞뒤 순서 안 봄</span>
        </div>
        <div class="pf-datewrap">
          <span class="pf-label">시작</span>
          <div class="pf-daterow">
            <input class="pf-in" id="pfStartDate" type="date">
            <button type="button" class="btn btn-sm btn-ghost pf-today" id="pfStartToday">오늘</button>
            <select class="pf-in pf-in-sm" id="pfStartH"></select>
            <select class="pf-in pf-in-sm" id="pfStartM"></select>
          </div>
        </div>
        <div class="pf-datewrap" style="margin-top:8px;">
          <span class="pf-label">종료</span>
          <div class="pf-daterow">
            <input class="pf-in" id="pfEndDate" type="date">
            <button type="button" class="btn btn-sm btn-ghost pf-today" id="pfEndToday">오늘</button>
            <select class="pf-in pf-in-sm" id="pfEndH"></select>
            <select class="pf-in pf-in-sm" id="pfEndM"></select>
          </div>
        </div>
        <div class="muted small" style="margin-top:7px;">
          날짜칸에 숫자만 이어서 쳐도 됩니다 (예: 20260901). 시·분은 09시 00분이 미리 들어가 있습니다.
        </div>
      </section>

      <!-- 9) 운영시간 -->
      <section class="pf-sec">
        <div class="pf-legend">9. 운영시간 <b class="pf-req">*</b></div>
        <select class="pf-in" id="pfOpTime"></select>
      </section>

      <!-- 10) 요청사항 -->
      <section class="pf-sec">
        <div class="pf-legend">10. 요청사항 <span class="pf-tag">선택 — 비워도 통과</span></div>
        <textarea class="pf-in pf-ta" id="pfNote" rows="4" placeholder="운영기관에 전달할 요청사항"></textarea>
        <button type="button" class="btn btn-sm btn-ghost" id="pfBoiler" style="margin-top:7px;">
          📋 정형문구 붙여넣기
        </button>
      </section>

      <!-- 11) 약관 동의 -->
      <section class="pf-sec">
        <div class="pf-legend">11. 약관 동의 <b class="pf-req">*</b></div>
        <label class="pf-agree pf-agree-all">
          <input type="checkbox" id="pfAgreeAll"><span><b>전체 동의</b></span>
        </label>
        <label class="pf-agree">
          <input type="checkbox" id="pfAgree1"><span><b class="pf-must">[필수]</b> 개인정보 수집 및 이용 동의</span>
        </label>
        <label class="pf-agree">
          <input type="checkbox" id="pfAgree2"><span><b class="pf-must">[필수]</b> 개인정보 제3자 제공 동의</span>
        </label>
      </section>

      <div class="pf-submitmsg" id="pfSubmitMsg" role="status"></div>
      <div class="pf-actions">
        <button type="button" class="btn btn-ghost" id="pfCancel">취소</button>
        <button type="button" class="btn btn-green" id="pfSubmit">신청</button>
      </div>
    </div>

    <!-- 주소 검색 모달 — 자체 더미 목록만 쓴다 (외부 API 호출 없음) -->
    <div class="pf-modal" id="pfModal" hidden>
      <div class="pf-modal-back" id="pfModalBack"></div>
      <div class="pf-modal-box" role="dialog" aria-modal="true" aria-labelledby="pfModalTitle">
        <div class="pf-modal-head">
          <b id="pfModalTitle">주소 검색</b>
          <button type="button" class="pf-modal-x" id="pfModalX" aria-label="닫기">✕</button>
        </div>
        <div class="muted small" style="margin-bottom:9px;">
          연습용 더미 주소 목록입니다. 외부 주소 API 를 호출하지 않습니다.
        </div>
        <input class="pf-in" id="pfSearch" placeholder="도로명·지역명 두 글자 이상 입력" autocomplete="off">
        <div class="pf-results" id="pfResults"></div>
      </div>
    </div>

    <div class="card">
      <div class="row-between">
        <div class="card-title" style="margin-bottom:0;">📊 내 기록 <span class="muted small">(최근 20회)</span></div>
        <button id="prReset" class="btn btn-sm btn-ghost">기록 초기화</button>
      </div>
      <div class="pr-best" id="prBest"></div>
      <div class="pr-reclist" id="prRecords"></div>
    </div>

    <script>
      // ============ 신청 연습 ============
      // 전부 클라이언트에서만 동작한다. 서버·외부로 나가는 요청이 하나도 없다.
      var PROGRAMS = ${JSON.stringify(PRACTICE_PROGRAMS)};
      var ADDRESSES = ${JSON.stringify(PRACTICE_ADDRESSES)};
      var QUIZ = ${JSON.stringify(PRACTICE_QUIZ)};
      // v2: 기록 항목이 '반응시간' 에서 '폼 작성 총시간' 으로 바뀌어 키를 올렸다.
      var STORE_KEY = 'saessak:practice:v2';
      var MAX_RECORDS = 20;
      var SEG_LABELS = ['주소 입력까지', '대상·인원·차시까지', '날짜·운영시간까지', '약관·제출까지'];

      var el = {
        start: document.getElementById('prStart'),
        status: document.getElementById('prStatus'),
        result: document.getElementById('prResult'),
        badge: document.getElementById('prBadge'),
        title: document.getElementById('prTitle'),
        inst: document.getElementById('prInst'),
        table: document.getElementById('prTable'),
        thumbName: document.getElementById('prThumbName'),
        apply: document.getElementById('prApply'),
        applyMsg: document.getElementById('prApplyMsg'),
        formCard: document.getElementById('prFormCard'),
        best: document.getElementById('prBest'),
        records: document.getElementById('prRecords'),
        reset: document.getElementById('prReset'),
        // 폼
        infoList: document.getElementById('pfInfoList'),
        infoHint: document.getElementById('pfInfoHint'),
        addr: document.getElementById('pfAddr'),
        addrDetail: document.getElementById('pfAddrDetail'),
        addrBtn: document.getElementById('pfAddrBtn'),
        target: document.getElementById('pfTarget'),
        grades: document.getElementById('pfGrades'),
        edus: document.getElementById('pfEdus'),
        count: document.getElementById('pfCount'),
        sessions: document.getElementById('pfSessions'),
        startDate: document.getElementById('pfStartDate'),
        startToday: document.getElementById('pfStartToday'),
        endToday: document.getElementById('pfEndToday'),
        startH: document.getElementById('pfStartH'),
        startM: document.getElementById('pfStartM'),
        endDate: document.getElementById('pfEndDate'),
        endH: document.getElementById('pfEndH'),
        endM: document.getElementById('pfEndM'),
        opTime: document.getElementById('pfOpTime'),
        note: document.getElementById('pfNote'),
        boiler: document.getElementById('pfBoiler'),
        agreeAll: document.getElementById('pfAgreeAll'),
        agree1: document.getElementById('pfAgree1'),
        agree2: document.getElementById('pfAgree2'),
        submitMsg: document.getElementById('pfSubmitMsg'),
        cancel: document.getElementById('pfCancel'),
        submit: document.getElementById('pfSubmit'),
        // 주소 모달
        modal: document.getElementById('pfModal'),
        modalBack: document.getElementById('pfModalBack'),
        modalX: document.getElementById('pfModalX'),
        search: document.getElementById('pfSearch'),
        results: document.getElementById('pfResults'),
      };

      // ---- 상태 ----
      var phase = 'idle';   // 'idle' | 'open' | 'form' | 'done'
      var openedAt = 0;     // 모집 중으로 바뀐 시각 (performance.now)
      var formAt = 0;       // [신청하기] 를 누른 시각 = 폼 계측 시작점
      var missCount = 0;    // 헛클릭 (열리기 전 클릭)
      var reactionMs = 0;   // 모집 중 → 신청하기 반응시간
      var current = null;
      var quiz = null;      // 이번 회차 문제
      var segAt = [];       // 구간 경계 시각 (performance.now)

      function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
      function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

      // ---- 문제 생성 ----
      function makeQuiz() {
        // 인원 상한: 90% 20명, 10% 22~25명 (후자는 안내문에 'N명 이상 모집' 표기)
        var over = Math.random() < 0.1;
        var cap = over ? randInt(22, 25) : 20;
        var weekend = Math.random() < 0.5;
        return {
          sessions: rand(QUIZ.sessions),
          range: rand(QUIZ.ranges),
          cap: cap,
          capOver: over,
          weekend: weekend,
          opAnswer: weekend ? '방과후 주말' : '방과후 주중',
        };
      }

      // ---- 기본정보 박스 ----
      function renderQuizInfo() {
        el.infoList.innerHTML = '';
        var rows = [
          ['총 교육 차시', quiz.sessions + '차시'],
          ['모집 학년 범위', quiz.range.label],
          ['모집 인원', quiz.capOver ? quiz.cap + '명 이상 모집' : quiz.cap + '명'],
          ['운영 구분', quiz.weekend ? '주말 운영' : '평일(주중) 운영'],
        ];
        rows.forEach(function (r) {
          var dt = document.createElement('dt');
          dt.textContent = r[0];
          var dd = document.createElement('dd');
          dd.textContent = r[1];
          el.infoList.appendChild(dt);
          el.infoList.appendChild(dd);
        });
        el.infoHint.textContent = quiz.weekend
          ? '※ 이 프로그램은 주말에 운영됩니다. 운영시간 항목을 그에 맞게 고르세요.'
          : '※ 이 프로그램은 평일(주중) 방과후에 운영됩니다. 운영시간 항목을 그에 맞게 고르세요.';
      }

      // ---- 저장소 (localStorage 전용) ----
      // best 는 records 와 따로 둔다. 목록은 최근 10회만 남기므로, 최고기록을
      // 목록에서 계산하면 좋은 기록이 목록 밖으로 밀릴 때 최고기록이 되레 나빠진다.
      function load() {
        try {
          var raw = localStorage.getItem(STORE_KEY);
          if (!raw) return { best: null, records: [] };
          var d = JSON.parse(raw);
          var records = Array.isArray(d.records) ? d.records : [];
          var best = typeof d.best === 'number' ? d.best : minOf(records); // 구 저장본 보정
          var total = typeof d.total === 'number' ? d.total : records.length;
          return { best: best, total: total, records: records };
        } catch (_) { return { best: null, total: 0, records: [] }; }
      }
      function save(d) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch (_) { /* 저장 불가 시 이번 회차만 표시 */ }
      }
      function minOf(records) {
        // 실격 회차는 최고기록 후보가 아니다
        return records.reduce(function (m, r) {
          if (r.dq) return m;
          return (m == null || r.ms < m) ? r.ms : m;
        }, null);
      }

      // ---- 프로그램 렌더 ----
      function pickProgram() {
        return PROGRAMS[Math.floor(Math.random() * PROGRAMS.length)];
      }
      function renderProgram(p) {
        current = p;
        el.title.textContent = p.title;
        el.inst.textContent = p.institution;
        el.thumbName.textContent = p.title;
        el.table.innerHTML = '';
        Object.keys(p.fields).forEach(function (k) {
          var dt = document.createElement('dt');
          dt.textContent = k;
          var dd = document.createElement('dd');
          dd.textContent = p.fields[k];
          el.table.appendChild(dt);
          el.table.appendChild(dd);
        });
      }

      // ---- 화면 상태 ----
      function setPhase(next) {
        phase = next;
        if (next === 'idle') {
          el.badge.textContent = '모집 예정';
          el.badge.className = 'pr-badge pr-badge-soon';
          el.apply.classList.add('is-locked');
          el.apply.setAttribute('aria-disabled', 'true');
          el.formCard.hidden = true;
          el.applyMsg.textContent = '';
          el.applyMsg.className = 'pr-applymsg';
        } else if (next === 'open') {
          el.badge.textContent = '모집 중';
          el.badge.className = 'pr-badge pr-badge-open';
          el.apply.classList.remove('is-locked');
          el.apply.setAttribute('aria-disabled', 'false');
          el.applyMsg.textContent = '';
          el.applyMsg.className = 'pr-applymsg';
        } else if (next === 'form') {
          // 폼 작성 중. 상세의 신청하기는 다시 잠근다.
          el.apply.classList.add('is-locked');
          el.apply.setAttribute('aria-disabled', 'true');
          el.formCard.hidden = false;
        } else if (next === 'done') {
          // 신청을 마친 상태. 뱃지는 '모집 중' 그대로 두되(실제 사이트도 그렇다)
          // 버튼은 다시 잠근다 — 활성처럼 보이는데 누르면 헛클릭이 오르는 걸 막는다.
          el.apply.classList.add('is-locked');
          el.apply.setAttribute('aria-disabled', 'true');
          el.formCard.hidden = true;
        }
      }

      function setStatus(html) { el.status.innerHTML = html; }

      // ================= 폼 =================

      // ---- 폼 초기화 (회차마다) ----
      function buildForm() {
        // 시/분 셀렉트
        function fill(sel, list, ph) {
          sel.innerHTML = '';
          var o0 = document.createElement('option');
          o0.value = ''; o0.textContent = ph;
          sel.appendChild(o0);
          list.forEach(function (v) {
            var o = document.createElement('option');
            o.value = v; o.textContent = v;
            sel.appendChild(o);
          });
        }
        var hours = [], mins = [];
        for (var h = 8; h <= 20; h++) hours.push((h < 10 ? '0' : '') + h);
        for (var m = 0; m < 60; m += 10) mins.push((m < 10 ? '0' : '') + m);
        fill(el.startH, hours, '시'); fill(el.startM, mins, '분');
        fill(el.endH, hours, '시'); fill(el.endM, mins, '분');

        // 운영시간
        el.opTime.innerHTML = '';
        var o0 = document.createElement('option');
        o0.value = ''; o0.textContent = '선택';
        el.opTime.appendChild(o0);
        QUIZ.opTimes.forEach(function (v) {
          var o = document.createElement('option');
          o.value = v; o.textContent = v;
          el.opTime.appendChild(o);
        });

        // 신청 가능 대상 — 이번 문제 범위에 해당하는 행만 활성화
        el.grades.innerHTML = '';
        QUIZ.gradeRows.forEach(function (row) {
          var on = row.key === quiz.range.row;
          var lab = document.createElement('label');
          lab.className = 'pf-grade' + (on ? '' : ' is-off');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'pf-gradecb';
          cb.value = row.key;
          // 잠긴 행은 실제로 못 켜게 한다 (aria-disabled 로 안내 + change 에서 되돌림)
          if (!on) {
            cb.setAttribute('aria-disabled', 'true');
            cb.addEventListener('click', function (e) { e.preventDefault(); });
          }
          var sp = document.createElement('span');
          sp.textContent = row.label + (on ? '' : ' — 이번 모집 범위 아님');
          lab.appendChild(cb); lab.appendChild(sp);
          el.grades.appendChild(lab);
        });

        // 교육대상 — 7개를 전부 그대로, 전부 선택 가능하게 그린다.
        // 신청 가능 대상(학년)과 달리 잠그지 않는다. 실전 폼이 그렇기 때문이고,
        // 고를 수는 있되 틀린 걸 고르면 채점에서 걸러지는 게 이 연습의 요점이다.
        el.edus.innerHTML = '';
        QUIZ.eduTargets.forEach(function (t) {
          var lab = document.createElement('label');
          lab.className = 'pf-edu';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'pf-educb';
          cb.value = t.key;
          var sp = document.createElement('span');
          sp.textContent = t.label;
          lab.appendChild(cb); lab.appendChild(sp);
          el.edus.appendChild(lab);
        });

        // 값 비우기
        el.addr.value = ''; el.addrDetail.value = '';
        el.target.value = '';
        el.count.value = ''; el.sessions.value = '';
        el.startDate.value = ''; el.endDate.value = '';
        // 시·분은 09:00 을 미리 넣어 둔다. 실전에서도 날짜는 승인 후 협의로 조정되니
        // 여기서 셀렉트를 두 번 여는 시간이 아깝다 — 손대지 않고 넘어가도 통과한다.
        el.startH.value = '09'; el.startM.value = '00';
        el.endH.value = '09'; el.endM.value = '00';
        el.opTime.value = '';
        el.note.value = '';
        el.agreeAll.checked = false; el.agree1.checked = false; el.agree2.checked = false;
        el.submitMsg.textContent = ''; el.submitMsg.className = 'pf-submitmsg';
        clearMarks();
      }

      function clearMarks() {
        var marked = el.formCard.querySelectorAll('.pf-bad');
        for (var i = 0; i < marked.length; i++) marked[i].classList.remove('pf-bad');
      }

      // ---- 구간 계측 ----
      // 구간 k 는 '그룹 1..k 가 모두 채워진 시점' 에 닫는다. 누적 판정이라
      // 순서를 바꿔 입력해도 구간 길이가 음수가 되지 않는다.
      function groupDone(i) {
        if (i === 0) return !!el.addr.value;
        if (i === 1) {
          return !!el.target.value &&
            el.grades.querySelectorAll('.pf-gradecb:checked').length > 0 &&
            el.edus.querySelectorAll('.pf-educb:checked').length > 0 &&
            el.count.value !== '' && el.sessions.value !== '';
        }
        if (i === 2) {
          return !!el.startDate.value && !!el.startH.value && !!el.startM.value &&
            !!el.endDate.value && !!el.endH.value && !!el.endM.value && !!el.opTime.value;
        }
        return false;
      }
      function checkSegments() {
        if (phase !== 'form') return;
        for (var k = 0; k < 3; k++) {
          if (segAt[k] != null) continue;
          var all = true;
          for (var j = 0; j <= k; j++) if (!groupDone(j)) { all = false; break; }
          if (!all) break;          // 앞 구간이 안 닫혔으면 뒤도 닫지 않는다
          segAt[k] = performance.now();
        }
      }

      // 폼 안의 모든 입력 변화에 구간 판정을 건다
      ['input', 'change'].forEach(function (ev) {
        el.formCard.addEventListener(ev, checkSegments);
      });

      // ---- 주소 검색 모달 (더미 목록 필터링 · 외부 통신 없음) ----
      function openModal() {
        el.modal.hidden = false;
        el.search.value = '';
        renderResults('');
        el.search.focus();
      }
      function closeModal() { el.modal.hidden = true; }
      function renderResults(q) {
        var term = String(q || '').trim();
        if (term.length < 2) {
          el.results.innerHTML = '<div class="pf-results-ph">두 글자 이상 입력하면 목록이 나타납니다.</div>';
          return;
        }
        var hits = ADDRESSES.filter(function (a) {
          return a.road.indexOf(term) >= 0 || a.jibun.indexOf(term) >= 0 || a.zip.indexOf(term) >= 0;
        }).slice(0, 6);
        if (!hits.length) {
          el.results.innerHTML = '<div class="pf-results-ph">검색 결과가 없습니다. (연습용 더미 목록)</div>';
          return;
        }
        el.results.innerHTML = hits.map(function (a) {
          return '<button type="button" class="pf-result" data-road="' + escAttr(a.road) + '">' +
            '<span class="pf-zip">' + a.zip + '</span>' +
            '<span class="pf-road">' + a.road + '</span>' +
            '<span class="pf-jibun">' + a.jibun + '</span>' +
            '</button>';
        }).join('');
      }
      function escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      }

      el.addrBtn.addEventListener('click', openModal);
      el.modalBack.addEventListener('click', closeModal);
      el.modalX.addEventListener('click', closeModal);
      el.search.addEventListener('input', function () { renderResults(el.search.value); });
      el.results.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.pf-result') : null;
        if (!b) return;
        el.addr.value = b.getAttribute('data-road');
        el.addr.classList.remove('pf-bad');
        closeModal();
        checkSegments();
        el.addrDetail.focus();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !el.modal.hidden) closeModal();
      });

      // ---- [오늘] 버튼 ----
      // 실전에서 날짜는 승인 뒤 협의로 조정된다. 정확한 날을 고르느라 달력을 뒤지는 대신
      // 오늘로 찍고 넘어가는 게 빠르다 — 그 요령을 버튼으로 만들어 둔다.
      function todayYmd() {
        var d = new Date();
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      }
      function setToday(input) {
        input.value = todayYmd();
        input.classList.remove('pf-bad');
        // 직접 값을 넣으면 input 이벤트가 안 나므로 구간 계측용으로 직접 쏜다
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.startToday.addEventListener('click', function () { setToday(el.startDate); });
      el.endToday.addEventListener('click', function () { setToday(el.endDate); });

      // ---- 날짜칸 숫자 입력 (20260901 → 2026-09-01) ----
      // input[type=date] 는 숫자 키를 그냥 흘려버린다(실측 확인). 그래서 자리 이동 없이
      // 여덟 자리를 이어 치는 실전 요령이 안 먹는다. 키를 가로채서 직접 채운다.
      // type=date 는 그대로 두므로 달력 선택기와 [오늘] 버튼은 함께 살아 있다.
      function attachDigitEntry(input) {
        var buf = '';
        function reset() { buf = ''; }
        input.addEventListener('focus', reset);
        input.addEventListener('blur', reset);
        input.addEventListener('keydown', function (e) {
          if (e.ctrlKey || e.metaKey || e.altKey) return;   // 복사·붙여넣기 등은 건드리지 않는다
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            reset();
            if (input.value) {
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
          }
          if (e.key < '0' || e.key > '9' || e.key.length !== 1) return; // 숫자만 가로챈다
          e.preventDefault();
          buf += e.key;
          if (buf.length < 8) return;
          var ymd = buf.slice(0, 4) + '-' + buf.slice(4, 6) + '-' + buf.slice(6, 8);
          reset();
          // 말이 안 되는 날짜(13월 등)는 value 세터가 알아서 '' 로 되돌린다.
          input.value = ymd;
          input.classList.remove('pf-bad');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      attachDigitEntry(el.startDate);
      attachDigitEntry(el.endDate);

      // ---- 정형문구 ----
      el.boiler.addEventListener('click', function () {
        el.note.value = ${JSON.stringify(PRACTICE_QUIZ.boilerplate)};
        el.note.focus();
      });

      // ---- 전체동의 ----
      el.agreeAll.addEventListener('change', function () {
        el.agree1.checked = el.agreeAll.checked;
        el.agree2.checked = el.agreeAll.checked;
        syncAgreeAll();
      });
      function syncAgreeAll() {
        el.agreeAll.checked = el.agree1.checked && el.agree2.checked;
        if (el.agree1.checked && el.agree2.checked) {
          [el.agree1, el.agree2].forEach(function (x) { x.closest('.pf-agree').classList.remove('pf-bad'); });
        }
      }
      el.agree1.addEventListener('change', syncAgreeAll);
      el.agree2.addEventListener('change', syncAgreeAll);

      // ---- 채점 ----
      // 반환: 틀린 항목 목록. 빈 배열이면 통과.
      function grade() {
        var bad = [];
        function fail(node, msg) {
          if (node) node.classList.add('pf-bad');
          bad.push(msg);
        }
        if (!el.addr.value) fail(el.addr, '교육 장소 주소를 입력하지 않았습니다');
        if (el.target.value !== '일반학교') {
          fail(el.target, '신청 교육 대상이 다릅니다 (정답: 일반학교)');
        }
        var checked = el.grades.querySelectorAll('.pf-gradecb:checked');
        if (!checked.length) {
          fail(el.grades, '신청 가능 대상을 하나도 고르지 않았습니다');
        } else {
          for (var i = 0; i < checked.length; i++) {
            if (checked[i].value !== quiz.range.row) {
              fail(el.grades, '모집 범위 밖의 학년을 선택했습니다');
              break;
            }
          }
        }
        // 교육대상 — 우리 학교가 신청할 수 있는 셋 중 하나 이상, 그 밖의 것은 하나도 없어야 한다
        var eduChecked = el.edus.querySelectorAll('.pf-educb:checked');
        if (!eduChecked.length) {
          fail(el.edus, '교육대상을 하나도 고르지 않았습니다');
        } else {
          var okKeys = {};
          QUIZ.eduTargets.forEach(function (t) { if (t.ok) okKeys[t.key] = true; });
          var wrong = [];
          var hasOk = false;
          for (var e = 0; e < eduChecked.length; e++) {
            if (okKeys[eduChecked[e].value]) hasOk = true;
            else wrong.push(eduChecked[e].value);
          }
          if (wrong.length) {
            var names = QUIZ.eduTargets
              .filter(function (t) { return wrong.indexOf(t.key) >= 0; })
              .map(function (t) { return t.label; })
              .join(', ');
            fail(el.edus, '해당 학교가 신청할 수 없는 대상입니다 (' + names + ')');
          } else if (!hasOk) {
            fail(el.edus, '해당 학교가 신청할 수 없는 대상입니다');
          }
        }
        if (Number(el.count.value) !== quiz.cap) {
          fail(el.count, '신청 인원이 다릅니다 (정답: ' + quiz.cap + '명)');
        }
        if (Number(el.sessions.value) !== quiz.sessions) {
          fail(el.sessions, '총 교육 차시가 다릅니다 (정답: ' + quiz.sessions + '차시)');
        }
        // 날짜·시각은 '채워졌는가' 만 본다.
        // 값의 타당성은 보지 않는다 — 종료일이 시작일보다 앞서도 통과시킨다.
        // 실전에서도 막지 않고, 승인 뒤 협의로 조정되기 때문이다.
        // 비었을 때는 어느 칸이 비었는지 짚어 준다 (날짜/시/분).
        function checkDateTrio(which, dateEl, hEl, mEl) {
          var missing = [];
          if (!dateEl.value) missing.push('날짜');
          if (!hEl.value) missing.push('시');
          if (!mEl.value) missing.push('분');
          if (!missing.length) return;
          // 비어 있는 칸만 붉게 표시한다
          if (!dateEl.value) dateEl.classList.add('pf-bad');
          if (!hEl.value) hEl.classList.add('pf-bad');
          if (!mEl.value) mEl.classList.add('pf-bad');
          bad.push('교육 ' + which + '의 ' + missing.join('·') + ' 칸이 비었습니다');
        }
        checkDateTrio('시작일시', el.startDate, el.startH, el.startM);
        checkDateTrio('종료일시', el.endDate, el.endH, el.endM);
        if (el.opTime.value !== quiz.opAnswer) {
          fail(el.opTime, '운영시간이 다릅니다 (정답: ' + quiz.opAnswer + ')');
        }
        return bad;
      }

      // ---- 제출 ----
      el.submit.addEventListener('click', function () {
        if (phase !== 'form') return;
        clearMarks();

        // 필수 약관은 유일한 '제출 차단' 조건이다 (실제 사이트와 같다)
        if (!el.agree1.checked || !el.agree2.checked) {
          [el.agree1, el.agree2].forEach(function (x) {
            if (!x.checked) x.closest('.pf-agree').classList.add('pf-bad');
          });
          el.submitMsg.textContent = '필수 약관 2개에 모두 동의해야 신청할 수 있습니다.';
          el.submitMsg.className = 'pf-submitmsg pf-submitmsg-warn';
          return;
        }

        var endAt = performance.now();
        segAt[3] = endAt;
        // 아직 안 닫힌 앞 구간은 제출 시점으로 닫는다 (건너뛴 채 제출한 경우)
        for (var k = 0; k < 3; k++) if (segAt[k] == null) segAt[k] = endAt;

        var bad = grade();
        var totalMs = endAt - formAt;
        setPhase('done');
        recordRun(totalMs, bad);
      });

      el.cancel.addEventListener('click', function () {
        // 기록하지 않고 대기 상태로 되돌린다
        setPhase('idle');
        setStatus('연습을 취소했습니다. [다시 연습] 을 누르면 새 문제로 시작합니다.');
      });

      // ---- 연습 시작 ----
      el.start.addEventListener('click', function () {
        renderProgram(pickProgram());
        quiz = makeQuiz();          // 회차마다 새 문제
        renderQuizInfo();
        buildForm();
        segAt = [null, null, null, null];
        // missCount 는 여기서 지우지 않는다. 버튼이 잠겨 있는 구간은 '연습 시작' 이전이라,
        // 여기서 리셋하면 헛클릭이 어느 회차에도 기록되지 못한다. 기다리는 동안의
        // 헛클릭은 뒤이은 회차의 것으로 본다 (기록 후 recordRun 에서 0으로 되돌린다).
        el.result.hidden = true;
        setPhase('open');
        setStatus('<b class="pr-open">모집 중으로 열렸습니다!</b> — 지금 <b>신청하기</b> 를 누르세요.');
        el.start.textContent = '다시 연습';
        openedAt = performance.now();
        el.apply.focus({ preventScroll: true });
      });

      // ---- 신청하기 ----
      el.apply.addEventListener('click', function () {
        if (phase === 'done') {
          // 이미 신청을 마쳤다. 조급해서 누른 게 아니므로 헛클릭으로 세지 않는다.
          el.applyMsg.textContent = '이미 신청했습니다 — [다시 연습] 을 누르세요';
          el.applyMsg.className = 'pr-applymsg';
          return;
        }
        if (phase !== 'open') {
          // 열리기 전 클릭 = 헛클릭
          missCount += 1;
          el.applyMsg.textContent = '아직 열리지 않았습니다 (헛클릭 ' + missCount + '회)';
          el.applyMsg.className = 'pr-applymsg pr-applymsg-warn';
          return;
        }
        // 여기부터가 폼 계측 시작점이다 (신청하기 클릭 → 최종 [신청] 클릭).
        formAt = performance.now();
        reactionMs = Math.round(formAt - openedAt);
        setPhase('form');
        setStatus('<b>작성 중</b> — 위 <b>프로그램 기본정보</b> 를 보고 아래 폼을 채운 뒤 [신청] 을 누르세요. ' +
          '<span class="muted small">(모집 반응 ' + reactionMs + 'ms)</span>');
        el.formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      // ---- 기록 ----
      function fmtSec(ms) { return (ms / 1000).toFixed(2); }

      function recordRun(totalMs, bad) {
        var dq = bad.length > 0;   // 실격 — 시간은 남기되 최고기록 경쟁에서 뺀다

        // 구간 길이
        var durs = [];
        var prev = formAt;
        for (var k = 0; k < 4; k++) {
          durs.push(Math.max(0, segAt[k] - prev));
          prev = segAt[k];
        }
        var worstIdx = 0;
        for (var i = 1; i < 4; i++) if (durs[i] > durs[worstIdx]) worstIdx = i;

        var d = load();
        var prevBest = d.best;
        // 실격 회차는 최고기록 갱신 대상이 아니다
        var isBest = !dq && (prevBest == null || totalMs < prevBest);

        d.records.unshift({
          at: new Date().toISOString(),
          ms: totalMs,
          dq: dq,
          worst: SEG_LABELS[worstIdx],
          segs: durs.map(function (x) { return Math.round(x); }),
          reaction: reactionMs,
          miss: missCount,
        });
        d.records = d.records.slice(0, MAX_RECORDS);
        d.total = (d.total || 0) + 1;
        if (isBest) d.best = totalMs;
        save(d);
        missCount = 0; // 이번 회차에 반영했으므로 초기화

        // ---- 결과 화면 ----
        var segHtml = durs.map(function (x, i) {
          return '<div class="pr-seg' + (i === worstIdx ? ' pr-seg-worst' : '') + '">' +
            '<span class="pr-seg-label">' + SEG_LABELS[i] + '</span>' +
            '<span class="pr-seg-bar"><i style="width:' +
              (totalMs > 0 ? Math.round((x / totalMs) * 100) : 0) + '%"></i></span>' +
            '<span class="pr-seg-val">' + fmtSec(x) + 's</span>' +
            '</div>';
        }).join('');

        // 날짜 구간(3구간)이 전체의 40% 이상이면 요령을 한 줄 붙인다.
        // 정확한 날짜를 고르느라 시간을 쓰는 게 이 구간이 길어지는 전형적 이유다.
        var DATE_SEG = 2;
        var dateShare = totalMs > 0 ? durs[DATE_SEG] / totalMs : 0;
        var tipHtml = dateShare >= 0.4
          ? '<div class="pr-tip">💡 날짜는 승인 후 협의로 조정됩니다. 형식만 채우고 넘어가는 게 빠릅니다. ' +
            '<span class="muted small">(날짜·운영시간 구간이 전체의 ' + Math.round(dateShare * 100) + '%)</span></div>'
          : '';

        var badHtml = dq
          ? '<div class="pr-badlist"><b>틀린 항목 ' + bad.length + '개</b><ul>' +
            bad.map(function (b) { return '<li>' + b + '</li>'; }).join('') +
            '</ul></div>'
          : '';

        el.result.hidden = false;
        el.result.className = 'pr-result pr-result-block' +
          (isBest ? ' pr-result-best' : '') + (dq ? ' pr-result-dq' : '');
        el.result.innerHTML =
          '<div class="pr-resulthead">' +
            '<span class="pr-ms">' + fmtSec(totalMs) + '<span class="pr-ms-u">초</span></span>' +
            (dq ? '<span class="pr-dqtag">실격 — 순위 미포함</span>' : '') +
            (isBest ? '<span class="pr-besttag">🏆 개인 최고기록!</span>' : '') +
            (missCount ? '' : '') +
            (!isBest && !dq && prevBest != null
              ? '<span class="muted small">최고기록 ' + fmtSec(prevBest) + '초</span>' : '') +
            '<span class="muted small">모집 반응 ' + reactionMs + 'ms</span>' +
          '</div>' +
          '<div class="pr-segs">' + segHtml + '</div>' +
          '<div class="pr-worst">⏱ <b>' + SEG_LABELS[worstIdx] + '</b> 에서 가장 많이 지체됐습니다 (' +
            fmtSec(durs[worstIdx]) + '초)</div>' +
          tipHtml +
          badHtml;

        setStatus(dq
          ? '틀린 항목이 있어 <b>실격</b> 처리됐습니다. 시간은 기록에 남습니다. [다시 연습] 으로 새 문제를 받으세요.'
          : '<b class="pr-open">전부 정답입니다.</b> [다시 연습] 을 누르면 새 문제로 이어서 연습합니다.');
        el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        renderRecords();
      }

      function fmtWhen(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        var p = function (n) { return String(n).padStart(2, '0'); };
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      function renderRecords() {
        var d = load();
        var best = d.best;

        el.best.innerHTML = best == null
          ? '<span class="muted small">아직 완주 기록이 없습니다. (실격 회차는 최고기록에 넣지 않습니다)</span>'
          : '개인 최고기록 <b class="pr-bestnum">' + fmtSec(best) + '초</b>' +
            ' <span class="muted small">· 누적 ' + (d.total || d.records.length) + '회</span>';

        if (!d.records.length) {
          el.records.innerHTML = '<div class="muted small" style="padding:10px 0;">연습을 한 번 해 보세요.</div>';
          return;
        }
        el.records.innerHTML =
          '<div class="pr-rechead"><span>일시</span><span>총시간</span><span>결과</span><span>최대 지체 구간</span></div>' +
          d.records.map(function (r) {
            var isBest = !r.dq && r.ms === best;
            return '<div class="pr-recrow' + (isBest ? ' pr-recrow-best' : '') +
                (r.dq ? ' pr-recrow-dq' : '') + '">' +
              '<span class="pr-recwhen">' + fmtWhen(r.at) + '</span>' +
              '<span class="pr-recms">' + fmtSec(r.ms) + '초' + (isBest ? ' 🏆' : '') + '</span>' +
              '<span class="pr-recdq">' + (r.dq ? '실격' : '완주') + '</span>' +
              '<span class="pr-recworst">' + (r.worst || '—') + '</span>' +
              '</div>';
          }).join('');
      }

      el.reset.addEventListener('click', function () {
        save({ best: null, records: [] });
        missCount = 0;
        el.result.hidden = true;
        renderRecords();
        saessak.toast('기록을 초기화했습니다');
      });

      // ---- 초기화 ----
      renderProgram(pickProgram());
      setPhase('idle');
      renderRecords();
    </script>
  `));
});

// ---- 페이지: 비밀번호 입력 (로그인) ----
function authPage(next, failed) {
  const nextVal = safeNext(next);
  return pageShell('설정 로그인', `
    <div class="header">
      <a class="logo" href="/" title="홈으로" aria-label="대시보드로 이동">🔒 설정 로그인</a>
      <a class="navlink" href="/">← 대시보드</a>
    </div>
    <form method="POST" action="/auth" class="card" style="max-width:420px;">
      <div class="card-title">관리자 비밀번호</div>
      <div class="muted small" style="margin-bottom:12px;">감시 조건 설정과 알림 발송은 비밀번호로 보호됩니다.</div>
      ${failed ? '<div class="err card" style="margin:0 0 12px;padding:10px 14px;">비밀번호가 올바르지 않습니다.</div>' : ''}
      <input type="hidden" name="next" value="${escapeHtml(nextVal)}">
      <input type="password" name="password" autofocus required
        style="width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;font-size:15px;margin-bottom:12px;">
      <button type="submit" class="btn btn-green btn-lg">로그인</button>
    </form>
  `);
}

app.get('/auth', (req, res) => {
  if (!authEnabled()) return res.redirect('/settings');
  if (isAuthed(req)) return res.redirect(safeNext(req.query.next));
  res.send(authPage(req.query.next, false));
});

app.post('/auth', (req, res) => {
  if (!authEnabled()) return res.redirect('/settings');
  const body = req.body || {};
  if (passwordMatches(body.password)) {
    res.setHeader('Set-Cookie', cookieString(AUTH_COOKIE, makeToken(), AUTH_MAX_AGE_SEC));
    return res.redirect(safeNext(body.next));
  }
  res.status(401).send(authPage(body.next, true));
});

// ---- API ----
app.post('/api/settings', requireAuth, (req, res) => {
  try {
    const saved = storage.saveSettings(req.body || {});
    rescheduleIfChanged();
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 기관 평가 API ----
app.get('/api/institutions', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, institutions: storage.getInstitutions() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 기관 1건 저장. 이름은 경로에 담는다(한글이므로 클라이언트에서 encodeURIComponent).
app.post('/api/institutions/:name', requireAuth, (req, res) => {
  try {
    const saved = storage.saveInstitution(req.params.name, req.body || {});
    invalidateInstitutions(); // 표식 캐시 갱신
    res.json({ ok: true, institution: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/check-now', requireAuth, async (req, res) => {
  try {
    // 수동 확인도 동일 락을 통과 → 정기 수집과 겹쳐 chromium 이 중복 launch 되지 않음.
    // 이미 돌고 있으면 거부하지 않고 예약한다({ queued: true }) — 화면은 이것을
    // 실패가 아니라 안내로 보여 준다.
    const result = await runCollectCycle('manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/test-alert', requireAuth, async (req, res) => {
  try {
    const result = await sendTestAlert();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 알림 피드 (공개, 캐시된 로그만) ----
// 브라우저 알림의 '실제 발사 경로'. 대시보드가 이 피드를 주기적으로 읽어
// 마지막으로 본 시각 이후의 항목을 알림으로 띄운다. 테스트 알림도 같은 로그에
// 같은 모양(kind:'test')으로 들어가므로 이 경로를 그대로 탄다.
app.get('/api/notifications', (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const items = storage
      .getLog()
      .slice(0, limit)
      .map((l) => ({
        at: l.at,
        kind: l.kind,
        delivery: deliveryLabelKey(l),
        ...notifyPayload(l),
      }));
    res.json({ ok: true, now: new Date().toISOString(), items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- 읽기 전용 요약 API (공개, 캐시된 데이터만 — 스크래핑 유발 안 함) ----
app.get('/api/summary', (req, res) => {
  try {
    const s = storage.getSettings();
    const state = storage.getState();
    const details = storage.getDetails();
    const nowMs = Date.now();

    // 이번 사이클에 관측된 프로그램만 (renderPlanner 와 동일 기준)
    const ids = Object.keys(state);
    let maxSeen = '';
    for (const id of ids) if ((state[id].lastSeen || '') > maxSeen) maxSeen = state[id].lastSeen;
    const cur = ids
      .filter((id) => maxSeen && (state[id].lastSeen || '') === maxSeen)
      .map((id) => ({ id, ...state[id], detail: details[id] || null }));

    const tagsOf = (x) => (x.tags || []).map((t) => '#' + t);

    // 신청 오픈 예정 — 신청시작 오름차순(미확인은 뒤)
    const upcoming = cur
      .filter((x) => x.status === '모집 예정')
      .map((x) => {
        const applyStartAt = (x.detail && x.detail.applyStartAt) || null;
        return {
          institution: x.institution || '',
          title: x.title || '',
          applyStartAt,
          dday: applyStartAt ? ddayKst(applyStartAt, nowMs) : null,
          chapters: (x.detail && x.detail.totalChapters != null) ? x.detail.totalChapters : null,
          tags: tagsOf(x),
          link: x.link || '',
        };
      })
      .sort((a, b) => {
        const av = a.applyStartAt ? Date.parse(a.applyStartAt) : null;
        const bv = b.applyStartAt ? Date.parse(b.applyStartAt) : null;
        if (av != null && bv != null) return av - bv;
        if (av != null) return -1;
        if (bv != null) return 1;
        return 0;
      });

    // 지금 신청 가능 — 잔여(정원-승인) 많은 순
    const open = cur
      .filter((x) => x.status === '모집 중')
      .map((x) => {
        const capacity = x.capacityClasses || 0;
        const approved = x.approvedClasses || 0;
        return {
          institution: x.institution || '',
          title: x.title || '',
          remaining: capacity - approved,
          capacity,
          approved,
          applyEndAt: (x.detail && x.detail.applyEndAt) || null,
          tags: tagsOf(x),
          link: x.link || '',
        };
      })
      .sort((a, b) => b.remaining - a.remaining);

    // 최근 이벤트 10건 (test 제외)
    const recentEvents = storage
      .getLog()
      .filter((l) => l.kind !== 'test')
      .slice(0, 10)
      .map((l) => ({
        kind: l.kind,
        institution: l.institution || '',
        title: l.title || '',
        at: l.at || '',
        link: l.link || '',
      }));

    res.json({
      status: {
        ok: heartbeat.lastOk === true,
        // 사이클이 "끝난" 시각. 외부 모니터가 이 값으로 정지를 판정할 수 있다.
        lastCheckedAt: heartbeat.lastFinishAt || null,
        lastStartedAt: heartbeat.lastStartAt || null,
        collecting: isCollecting,
        staleMinutes: heartbeat.lastFinishAt
          ? Math.floor((Date.now() - new Date(heartbeat.lastFinishAt).getTime()) / 60000)
          : null,
        lastError: heartbeat.lastError || null,
        lastDurationMs: heartbeat.lastMs != null ? heartbeat.lastMs : null,
        watchdogRestarts: heartbeat.restarts || 0,
        failStreak: heartbeat.failStreak || 0,
        staleUnlocks: heartbeat.staleUnlocks || 0,
        intervalMinutes: currentInterval || s.intervalMinutes,
        matchedCount: runtime.lastMatchCount,
      },
      upcoming,
      open,
      recentEvents,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 프로세스가 살아 있는지만 본다 (keep-alive 핑 대상 · 항상 200).
app.get('/health', (req, res) => res.send('ok'));

// 감시 루프가 실제로 도는지 본다. 멈춰 있으면 503 —
// UptimeRobot 등 외부 모니터를 이 주소로 걸어 두면 감시 정지를 문자로 받을 수 있다.
app.get('/health/watch', (req, res) => {
  const now = Date.now();
  const finishedAt = heartbeat.lastFinishAt;
  const idleMs = finishedAt ? now - new Date(finishedAt).getTime() : now - bootMs;
  const stallMs = stallThresholdMs();
  // 멈춘 것만 문제가 아니다 — 제때 돌면서 계속 실패하는 것도 감시가 안 되는 상태다.
  // 밖에서 보면 둘 다 '알림이 안 온다' 로 같으므로 외부 모니터에는 똑같이 503 으로 알린다.
  const streak = heartbeat.failStreak || 0;
  const stale = idleMs > stallMs || streak >= 3;
  res.status(stale ? 503 : 200).json({
    ok: !stale,
    reason: idleMs > stallMs ? 'stalled' : streak >= 3 ? 'failing' : null,
    lastCheckedAt: finishedAt || null,
    idleMinutes: Math.floor(idleMs / 60000),
    stallMinutes: Math.round(stallMs / 60000),
    collecting: isCollecting,
    watchdogRestarts: heartbeat.restarts || 0,
    failStreak: heartbeat.failStreak || 0,
    staleUnlocks: heartbeat.staleUnlocks || 0,
    lastError: heartbeat.lastError || null,
  });
});

// ---- helpers ----
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  } catch {
    return iso || '';
  }
}

// "[운영기관] 프로그램명" (기관명 없으면 프로그램명만)
function instLabel(institution, title) {
  const inst = String(institution || '').trim();
  const t = String(title || '');
  return inst ? `[${inst}] ${t}` : t;
}

// ---- 알림 발송 결과 표시 ----
// delivery 필드가 없던 시절의 기록은 sent 로 되짚는다. 그때는 '꺼둠'과 '실패'를
// 구분해 저장하지 않았으므로, 실패라고 단정하지 않고 '기록 없음'으로 남긴다.
function deliveryLabelKey(l) {
  if (l && l.delivery) return l.delivery;
  if (l && l.sent) return 'sent';
  return 'unknown';
}
const DELIVERY_LABEL = {
  sent: { text: '✅ 성공', cls: 'dl-ok', title: '텔레그램 발송 성공' },
  failed: { text: '❌ 실패', cls: 'dl-bad', title: '발송을 시도했으나 실패 (토큰·네트워크·차단)' },
  off: { text: '⏸ 꺼둠', cls: 'dl-off', title: '이 알림 유형이 설정에서 꺼져 있어 발송하지 않음' },
  unset: { text: '⚙ 미설정', cls: 'dl-off', title: '텔레그램 토큰/챗ID 미설정 — 콘솔에만 출력' },
  none: { text: '· 기록만', cls: 'dl-off', title: '발송 대상이 아닌 기록' },
  unknown: { text: '? 기록 없음', cls: 'dl-off', title: '구버전 로그 — 발송 결과를 저장하지 않던 시절의 기록' },
};
const KIND_LABEL = {
  start: '모집 시작 전환',
  new: '신규 등록',
  reminder: '오픈 리마인더',
  change: '정보 변경',
  'new-label': '새 분류 발견',
  test: '테스트 발송',
};

// 설정 화면의 알림 로그 표 (최근 20건: 시각 · 프로그램명 · 사유 · 성공/실패)
function notifyLogSection() {
  const log = storage.getLog().slice(0, 20);
  const today = new Date().toISOString().slice(0, 10);
  const todayAll = storage.getLog().filter((l) => (l.at || '').slice(0, 10) === today);
  const todaySent = todayAll.filter((l) => deliveryLabelKey(l) === 'sent').length;
  const todayFailed = todayAll.filter((l) => deliveryLabelKey(l) === 'failed').length;
  const todayOff = todayAll.filter((l) => deliveryLabelKey(l) === 'off').length;

  // "오늘 0건"이 감지가 없어서인지 발송이 막혀서인지 한 줄로 구분해 준다.
  let summary;
  if (!todayAll.length) {
    summary = '오늘 감지된 항목이 <b>0건</b> 입니다 — 발송 실패가 아니라 조건에 맞는 변화가 없었습니다.';
  } else {
    const bits = [`오늘 감지 <b>${todayAll.length}건</b>`, `성공 <b>${todaySent}건</b>`];
    if (todayFailed) bits.push(`<b class="dl-bad-t">실패 ${todayFailed}건</b>`);
    if (todayOff) bits.push(`꺼둠 ${todayOff}건`);
    summary = bits.join(' · ');
  }

  const rows = log
    .map((l) => {
      const key = deliveryLabelKey(l);
      const d = DELIVERY_LABEL[key] || DELIVERY_LABEL.unknown;
      const when = fmtKstDateTime(l.at) || escapeHtml(l.at || '');
      const kind = KIND_LABEL[l.kind] || l.kind || '기타';
      const extra = l.changes ? ` <span class="muted small">(${escapeHtml(l.changes)})</span>` : '';
      return `<div class="nlog-row">
        <span class="nlog-time">${escapeHtml(when)}</span>
        <span class="nlog-title">${escapeHtml(instLabel(l.institution, l.title))}${extra}</span>
        <span class="nlog-kind">${escapeHtml(kind)}</span>
        <span class="nlog-res ${d.cls}" title="${escapeHtml(d.title)}">${escapeHtml(d.text)}</span>
      </div>`;
    })
    .join('');

  return `
    <div class="card">
      <div class="card-title">📜 알림 로그 <span class="muted small">(최근 20건)</span></div>
      <div class="muted small" style="margin-bottom:10px;">${summary}</div>
      <div class="nlog-head">
        <span class="nlog-time">시각(KST)</span>
        <span class="nlog-title">프로그램</span>
        <span class="nlog-kind">사유</span>
        <span class="nlog-res">발송</span>
      </div>
      <div class="nlog">${rows || '<div class="muted small" style="padding:10px 0;">기록된 알림이 없습니다.</div>'}</div>
    </div>`;
}

// 상대시각 "N분 전" (초 단위 제거)
// 상태바 한 줄. '마지막 확인'은 사이클이 "끝난" 시각을 쓴다 —
// 시작 시각을 쓰면 매달려 죽은 사이클이 한동안 '방금 확인'으로 보여 사고를 못 알아챈다.
// 간격의 3배(최소 30분)를 넘겨 멈춰 있으면 정상이 아니라고 못 박는다.
function watchStatus(nowMs) {
  const finishedAt = heartbeat.lastFinishAt;
  const rel = relativeTime(finishedAt, nowMs);
  const idleMs = finishedAt ? nowMs - new Date(finishedAt).getTime() : Infinity;
  const stallMs = stallThresholdMs();

  const streak = heartbeat.failStreak || 0;

  if (isCollecting) return { rel, text: '확인 중', dot: 'dot-wait', streak };
  if (!finishedAt) return { rel, text: '대기 중', dot: 'dot-wait', streak };
  // 간격의 3배(최소 30분)를 넘겨 멈춰 있으면 '정상'이라고 말하지 않는다.
  if (idleMs > stallMs) return { rel, text: '감시 지연', dot: 'dot-bad', streak };
  if (heartbeat.lastOk === false) {
    return {
      rel,
      text: streak > 1 ? `수집 실패 ${streak}회 연속` : '수집 실패',
      dot: 'dot-bad',
      streak,
    };
  }
  return { rel, text: '감시 정상', dot: 'dot-ok', streak };
}

function relativeTime(iso, nowMs) {
  if (!iso) return '확인 전';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '확인 전';
  const diff = Math.max(0, nowMs - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

// 조건 요약 한 줄: "방문형 · 초등 · 서울·인천권 · 예정+중 · #일반형 #다문화"
// 대시보드 조건 요약을 카테고리 색 칩으로 렌더 (설정값에서 동적 생성).
//  · 프로그램 유형 / 학교급 / 운영권역 → 연초록(cc-green)
//  · 모집상태 → 연노랑(cc-yellow, 각 상태 개별 칩)
//  · 교육대상 → 연파랑(cc-blue, # 접두)
function conditionChips(s) {
  const LV = { 초등학교: '초등', 중학교: '중등', 고등학교: '고등' };
  const chips = [];
  for (const v of s.programType) chips.push({ cls: 'cc-green', text: v });
  for (const v of s.schoolLevels) chips.push({ cls: 'cc-green', text: LV[v] || v });
  for (const v of s.regions) chips.push({ cls: 'cc-green', text: v });
  for (const v of s.statuses) chips.push({ cls: 'cc-yellow', text: v });
  // 교육대상: 축약 표기 + 전체명 툴팁
  for (const v of s.targets)
    chips.push({ cls: 'cc-blue', text: '#' + classify.shortOf(v), title: v });
  return chips
    .map(
      (c) =>
        `<span class="condchip ${c.cls}"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${escapeHtml(c.text)}</span>`
    )
    .join('');
}

// ============================================================================
// 플래너 메타 시각화 (v5)
// ============================================================================

// 우리 학교가 해당되는 교육대상 — 이 값만 진한 색칩으로 강조하고 나머지는 회색으로 누른다.
// 학교 사정이 바뀌면 이 배열만 고치면 된다. (감시 조건(settings.targets)과는 별개)
const TARGET_MINE = [
  '일반형',
  '사회적 배려형(이주배경(구 다문화))',
  '교육복지우선지원사업 학교',
];
// 진한 색칩의 색 클래스 (라벨 key → CSS 클래스)
const MINE_CHIP_CLASS = {
  general: 'tc-general', // 파랑
  migrant: 'tc-migrant', // 보라
  welfare: 'tc-welfare', // 초록
};

// ---- 기관 평가 표식 ----
// 평가 데이터는 자주 안 바뀌므로 메모리에 들고 있다가 저장 시에만 비운다.
let _instCache = null;
function institutionsCached() {
  if (!_instCache) _instCache = storage.getInstitutions();
  return _instCache;
}
function invalidateInstitutions() {
  _instCache = null;
}

// 프로그램의 institution 문자열 → 평가 레코드. 정확 매칭 우선, 실패 시 부분 매칭.
// (짧은 이름의 오매칭을 막으려고 부분 매칭은 3글자 이상만 허용)
function lookupInstitution(institution) {
  const q = String(institution || '').trim();
  if (!q) return null;
  const list = institutionsCached();
  const exact = list.find((r) => r.name === q);
  if (exact) return exact;
  const qs = q.replace(/\s+/g, '');
  return (
    list.find((r) => {
      const n = String(r.name || '').replace(/\s+/g, '');
      if (n.length < 3) return false;
      return n === qs || qs.includes(n) || n.includes(qs);
    }) || null
  );
}

const VERDICT_LABEL = { strong: '강력추천', ok: '추천', no: '비추천' };
const PAY_LABEL = { over: '강사료 초과', avg: '강사료 평균(7.5만)', under: '강사료 이하' };
const OPS_LABEL = { easy: '운영 편함', normal: '운영 보통', hard: '운영 까다로움' };
const MATERIAL_LABEL = { yes: '교구 있음', no: '교구 없음' };
const TRAINING_LABEL = {
  live: '연수 라이브',
  video: '연수 동영상',
  live_then_video: '연수 초반 라이브→후반 동영상',
  // 구 표기 (다시 고르기 전까지 그대로 보여준다)
  online: '연수 온라인(구)',
  offline: '연수 오프라인(구)',
};
const SNACK_LABEL = { twice: '간식 2번 이상', once: '간식 1번', no: '간식 안 줌' };

// 업체명 앞 표식 + 카드 흐리게 여부.
//  · 마스터 스위치(showRatings)가 OFF면 개별 옵션과 무관하게 전부 숨김
//  · 개별 옵션(showVerdict/showScore/showHeart)으로 고른 표식만 노출
//  · dimSkip 이 ON이면 '비추천' 기관 카드를 흐리게 (숨기지는 않음)
// 미평가·매칭 실패면 표식 없음 → 카드는 아무 영향 없이 그대로 그려진다.
function ratingOf(institution, s) {
  const off = { mark: '', dim: false };
  if (!s || !s.showRatings) return off;
  const r = lookupInstitution(institution);
  if (!r || !r.evaluated) return off;
  const dim = !!(s.dimSkip && r.verdict === 'no');
  // 표식 순서: 판정 배지 → 종합점수 → 하트 (CSS gap 4px 로 사이 간격 정돈)
  // 강사구성 원점수(★N)는 종합점수에 이미 들어가 있어 카드에서는 따로 보이지 않는다.
  const bits = [];
  if (s.showVerdict) bits.push(markVerdict(r.verdict));
  if (s.showScore && r.score != null) bits.push(markScore(r.score));
  if (s.showHeart && r.heart) bits.push(markHeart());
  if (!bits.filter(Boolean).length) return { mark: '', dim };
  const tip = [
    VERDICT_LABEL[r.verdict],
    r.staffScore != null ? '강사구성 ' + staffText(r.staffScore) : '',
    PAY_LABEL[r.pay],
    OPS_LABEL[r.ops],
    MATERIAL_LABEL[r.material],
    TRAINING_LABEL[r.training],
    SNACK_LABEL[r.snack],
    (r.approvalNote || '').trim(),
    (r.memo || '').trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  const mark = `<span class="imark" title="${escapeHtml(tip)}">${bits.join('')}</span>`;
  // (개별 표식에도 title 이 붙어 있어 마우스를 올린 표식의 설명이 우선 뜬다)
  return { mark, dim };
}

// Tabler 아이콘을 인라인 SVG 로 넣는다.
// 아이콘 폰트(CDN)를 쓰지 않으므로 폰트가 안 뜨는 망(학교 등)에서도 깨지지 않고,
// 혹시 이름이 없으면 빈 문자열을 돌려줘 텍스트만 남는다.
const ICON_PATHS = {
  // ti-clock-hour-4
  'clock-hour-4':
    '<circle cx="12" cy="12" r="9"/><path d="M12 12l3 2"/><path d="M12 7v5"/>',
  // ti-users
  users:
    '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  // ti-calendar-event
  'calendar-event':
    '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/>' +
    '<path d="M4 11h16"/><path d="M8 15h2v2h-2z"/>',
  // ti-chevron-right
  'chevron-right': '<path d="M9 6l6 6l-6 6"/>',
  // ti-star-filled — 설정 화면 기관 목록의 '강사구성' 요약 (카드 표식에는 안 쓴다)
  'star-filled':
    '<path d="M8.243 7.34l-6.38 .925l-.113 .023a1 1 0 0 0 -.44 1.684l4.622 4.499l-1.09 6.355' +
    'l-.013 .11a1 1 0 0 0 1.464 .944l5.706 -3l5.693 3l.1 .046a1 1 0 0 0 1.352 -1.1l-1.091 -6.355' +
    'l4.624 -4.5l.078 -.085a1 1 0 0 0 -.633 -1.62l-6.38 -.926l-2.852 -5.78a1 1 0 0 0 -1.794 0' +
    'l-2.853 5.78z"/>',
  // ti-heart-filled — 기관 평가 '정성 호감' 표식 (이모지 ❤️ 대체)
  'heart-filled':
    '<path d="M6.979 3.074a6 6 0 0 1 4.988 1.425l.037 .033l.034 -.03a6 6 0 0 1 4.733 -1.44l.246 .036' +
    'a6 6 0 0 1 3.364 10.008l-.18 .185l-.048 .041l-7.45 7.379a1 1 0 0 1 -1.313 .082l-.094 -.082' +
    'l-7.493 -7.422a6 6 0 0 1 3.176 -10.215z"/>',
};
// 채움(fill) 아이콘 — 선(stroke) 아이콘과 그리는 방식이 다르다
const FILLED_ICONS = new Set(['star-filled', 'heart-filled']);
function icon(name, size = 13) {
  const paths = ICON_PATHS[name];
  if (!paths) return ''; // 폴백: 아이콘 없으면 텍스트만
  const style = FILLED_ICONS.has(name)
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="ti ti-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" ${style}
    aria-hidden="true" focusable="false">${paths}</svg>`;
}

// ---- 기관 평가 표식 조각 (플래너·최근 감지·설정 화면 공통) ----
// 이모지는 OS/브라우저마다 뭉개져 보여서 전부 인라인 SVG + 색점으로 통일한다.
function markDot(verdict) {
  if (!VERDICT_LABEL[verdict]) return '';
  return `<span class="imk-dot imk-${verdict}" title="${VERDICT_LABEL[verdict]}"></span>`;
}
// 판정 문구 배지 — 카드에서는 색점 대신 이걸 쓴다(색만으로는 뜻이 안 읽히므로)
function markVerdict(verdict) {
  const label = VERDICT_LABEL[verdict];
  if (!label) return '';
  return `<span class="vbadge vb-${verdict}" title="${label}">${label}</span>`;
}
// 종합점수 — 100점 만점(강사구성·강사료·운영·교구·간식 합산)
const SCORE_TIP = '종합점수 %s점 (강사구성·강사료·운영·교구·간식 합산)';
function markScore(score) {
  const tip = SCORE_TIP.replace('%s', String(score));
  return `<span class="imk-score" title="${escapeHtml(tip)}">${escapeHtml(String(score))}점</span>`;
}
// 강사구성 점수 → "45점 (주+보조 학교, 안전만 외부)" 형태의 설명
function staffText(score) {
  const label = storage.STAFF_LABEL[score];
  return `${score}점${label ? ` (${label})` : ''}`;
}
function markStar(score) {
  return `<span class="imk-star" title="강사구성 ${escapeHtml(staffText(score))}">${icon(
    'star-filled',
    11
  )}<b>${escapeHtml(String(score))}</b></span>`;
}
function markHeart() {
  return `<span class="imk-heart" title="승인 잘해줌">${icon('heart-filled', 12)}</span>`;
}

// ---- 정원 계산 (실질 잔여 기준) ----
// 목록 API 값(state)이 가장 최신이고, 없으면 상세(detail) 값으로 보완한다.
//   cap=정원(모집 학급) · app=승인 · pend=대기
//
// 실질 잔여 = 정원 - 승인 - 대기.
// 대기 학급도 이미 앞줄을 차지하고 있으므로 빼야 "지금 신청해서 될 자리"가 나온다.
// (정원-승인 만으로 계산하면 대기가 쌓인 프로그램을 여유 있는 것처럼 보이게 한다)
// 반환: null(정원 미공개) 또는 계산된 수치 묶음.
function capacityOf(x) {
  const d = x.detail || {};
  const pick = (a, b) => (a != null ? a : b != null ? b : null);
  const cap = pick(x.capacityClasses, d.capacityClasses);
  const appRaw = pick(x.approvedClasses, d.approvedClasses);
  const pendRaw = pick(x.pendingClasses, d.pendingClasses);
  if (cap == null || cap <= 0) return null;

  const app = appRaw || 0;
  const pend = pendRaw || 0;
  const realRemain = Math.max(0, cap - app - pend);
  const full = realRemain === 0; // 정원+대기가 정원 이상 → 지금 신청하면 대기만
  return {
    cap,
    app,
    pend,
    hasNumbers: appRaw != null, // 승인 수치가 아직 안 열린 건(오픈 전 등) 구분용
    realRemain,
    full,
    appPct: Math.round((app / cap) * 100),
    pendPct: Math.round((pend / cap) * 100),
  };
}

// 정렬·레일에서 함께 쓰는 실질 잔여 (정원 미공개면 0 취급 → 맨 아래)
function realRemainOf(x) {
  const c = capacityOf(x);
  return c ? c.realRemain : 0;
}

// "~M/D HH:MM" 짧은 날짜 표기 (요일 없이)
function fmtCompact(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

// 차시 표시 (시계 아이콘 + "N차시"). 값이 없으면 빈 문자열.
function chaptersHtml(x) {
  const n = x.detail && x.detail.totalChapters != null ? x.detail.totalChapters : null;
  if (n == null) return '';
  return `<span class="metabit">${icon('clock-hour-4')}${escapeHtml(n + '차시')}</span>`;
}

// 날짜 조각 (달력 아이콘 + "~M/D HH:MM")
// prefix 를 빈 문자열로 주면 접두사 없이 날짜만 — 오픈 예정 카드의 '오픈 일시'는
// 마감이 아니므로 '~' 를 붙이면 안 된다. (기본값은 마감용 '~')
function dateHtml(iso, prefix) {
  const t = fmtCompact(iso);
  if (!t) return '';
  const pre = prefix == null ? '~' : prefix;
  return `<span class="metabit">${icon('calendar-event')}${escapeHtml(pre + t)}</span>`;
}

// 좌측 잔여 레일 (지금 신청 가능): 실질 잔여 크기에 따라 여유/임박/마감
function railHtml(c) {
  if (!c) return `<div class="rail rail-unknown"><div class="rail-num rail-num-sm">정원</div>
      <div class="rail-label">미공개</div></div>`;
  if (c.full) {
    return `<div class="rail rail-full"><div class="rail-num rail-num-sm">마감</div>
      <div class="rail-label">대기만</div></div>`;
  }
  const tone = c.realRemain >= 4 ? 'rail-ok' : 'rail-soon';
  return `<div class="rail ${tone}"><div class="rail-num">${c.realRemain}</div>
      <div class="rail-label">자리 남음</div></div>`;
}

// 좌측 레일 (오픈 예정): D-day 를 그대로 레일에 얹는다 (기존 색 규칙 유지)
function railDdayHtml(dd) {
  if (dd == null) {
    return `<div class="rail rail-unknown"><div class="rail-num rail-num-sm">미정</div>
      <div class="rail-label">일시 미공지</div></div>`;
  }
  if (dd <= 0) {
    return `<div class="rail rail-dday-now"><div class="rail-num rail-num-sm">D-DAY</div>
      <div class="rail-label">오늘 오픈</div></div>`;
  }
  return `<div class="rail rail-dday"><div class="rail-num">D-${dd}</div>
      <div class="rail-label">오픈까지</div></div>`;
}

// 게이지 우측 수치 텍스트. 숫자와 라벨을 띄워 읽기 쉽게, 대기 0이면 항목 자체를 뺀다.
function capText(c) {
  const parts = [`정원 ${c.cap}`, `승인 ${c.app}`];
  if (c.pend > 0) parts.push(`대기 ${c.pend}`);
  return parts.join(' · ');
}

// 3단 게이지 + 우측 수치 텍스트 ("정원 13 · 승인 5 · 대기 1")
//  진초록=승인 · 연초록=대기 · 빈 공간=실질 잔여 / 실질 잔여 0이면 전체 빨강
function gaugeHtml(c) {
  if (!c) return '';
  const bar = c.full
    ? `<div class="g3 g3-full"><div class="g3-app" style="width:100%"></div></div>`
    : `<div class="g3">
        <div class="g3-app" style="width:${c.appPct}%"></div>
        <div class="g3-pend" style="width:${c.pendPct}%"></div>
      </div>`;
  return `<div class="pi-cap">${bar}
      <span class="g3-text">${capText(c)}</span>
    </div>`;
}

// 교육대상 색칩 — 우리 학교 해당 대상(TARGET_MINE)만 진한 색칩으로 노출하고,
// 그 외 대상은 개별 칩으로 늘어놓지 않고 개수만 회색 '외 N' 으로 접는다.
//  · 화면에는 [진한 색칩들] + [회색 '외 N'] 만 남는다 (회색 개별칩 없음)
//  · 우리 대상이 하나도 없고 그 외만 있으면 '외 N' 만 표시
//  · '외 N' 에 마우스를 올리면 접힌 대상 전체 이름이 뜬다
//  · 상세의 신청대상을 우선 쓰고 없으면 목록 태그. 여기 한 곳에서만 만들어 중복 표기를 막는다.
function targetChipsHtml(x) {
  const names =
    x.detail && x.detail.targetNames && x.detail.targetNames.length
      ? x.detail.targetNames
      : x.tags || [];
  const items = classify.normalizeList(names).map((full) => {
    const key = classify.canonicalKey(full);
    return {
      full,
      label: classify.chipOf(full),
      mine: TARGET_MINE.includes(full),
      cls: (key && MINE_CHIP_CLASS[key]) || 'tc-other',
    };
  });
  if (!items.length) return '';

  const mine = items.filter((i) => i.mine);
  const rest = items.filter((i) => !i.mine);

  const chips = mine.map(
    (i) =>
      `<span class="tchip ${i.cls}" title="${escapeHtml(i.full)}">${escapeHtml(i.label)}</span>`
  );
  if (rest.length) {
    const tip = rest.map((i) => i.full).join(', ');
    chips.push(
      `<span class="tchip tc-other" title="${escapeHtml(tip)}">외 ${rest.length}</span>`
    );
  }
  return `<span class="tchips">${chips.join('')}</span>`;
}

// 카드 1행: [기관 평가 표식] [업체명] 프로그램명 + 우측 chevron
function cardHead(x, s) {
  const inst = String(x.institution || '').trim();
  return `<div class="pi-head">
      ${ratingOf(inst, s).mark}
      ${inst ? `<span class="pi-inst">[${escapeHtml(inst)}]</span>` : ''}
      <span class="pi-name">${escapeHtml(x.title || '')}</span>
      <span class="pi-go" aria-hidden="true">${icon('chevron-right')}</span>
    </div>`;
}

// ---- 표식 범례 (플래너 상단) ----
// 표식만 보고는 뜻을 알기 어려우니 접이식 한 줄로 설명을 붙인다.
// 기본 접힘이고, 표식이 켜져 있을 때(showRatings ON)만 나온다.
function legendHtml(s) {
  if (!s || !s.showRatings) return '';
  const items = [];
  if (s.showVerdict) {
    items.push(
      `<span class="lg">${markVerdict('strong')}${markVerdict('ok')}${markVerdict('no')}</span>`,
      '<span class="lg-note">(종합판정)</span>'
    );
  }
  if (s.showScore) {
    items.push(`<span class="lg"><span class="imk-score">100점</span>종합점수</span>`);
  }
  if (s.showHeart) {
    items.push(
      `<span class="lg"><span class="imk-heart">${icon('heart-filled', 12)}</span>승인 잘해줌</span>`
    );
  }
  if (!items.length) return '';
  return `<details class="plan-legend">
      <summary>표식 설명</summary>
      <div class="legend-body">${items.join('<span class="lg-sep">·</span>')}</div>
    </details>`;
}

// ---- 신청 플래너 → { html, openReady } (openReady: 오픈일시 확인된 예정 프로그램 수) ----
function renderPlanner() {
  const s = storage.getSettings();
  const state = storage.getState();
  const details = storage.getDetails();
  const ids = Object.keys(state);
  const nowMs = Date.now();

  // 이번 사이클에 관측된 프로그램만 (가장 최근 lastSeen 기준)
  let maxSeen = '';
  for (const id of ids) if ((state[id].lastSeen || '') > maxSeen) maxSeen = state[id].lastSeen;
  const cur = ids
    .filter((id) => maxSeen && (state[id].lastSeen || '') === maxSeen)
    .map((id) => ({ id, ...state[id], detail: details[id] || null }));

  const open = cur.filter((x) => x.status === '모집 예정');
  const live = cur.filter((x) => x.status === '모집 중');
  const openReady = open.filter((x) => x.detail && x.detail.applyStartAt).length;

  // 그룹 A: 신청 시작 오름차순, 일시 미확인은 맨 아래
  open.sort((a, b) => {
    const as = a.detail && a.detail.applyStartAt ? Date.parse(a.detail.applyStartAt) : null;
    const bs = b.detail && b.detail.applyStartAt ? Date.parse(b.detail.applyStartAt) : null;
    if (as != null && bs != null) return as - bs;
    if (as != null) return -1;
    if (bs != null) return 1;
    return 0;
  });

  // 그룹 B: 실질 잔여(정원-승인-대기) 많은 순.
  // 실질 잔여 0(= 지금 신청하면 대기만)은 자연히 맨 아래로 모인다.
  live.sort((a, b) => realRemainOf(b) - realRemainOf(a));

  // 오픈 예정 카드 — 레일은 D-day, 본문 3행(제목 / 차시·오픈일시·대상칩 / 정원)
  const openRows = open
    .map((x) => {
      const start = x.detail && x.detail.applyStartAt;
      const dd = start ? ddayKst(start, nowMs) : null;
      const c = capacityOf(x);
      const metaHtml = [chaptersHtml(x), dateHtml(start, '')]
        .filter(Boolean)
        .join('<span class="metasep">·</span>');
      // 오픈 전(승인 수치가 없거나 0)이면 게이지 대신 정원만 담백하게
      const preOpen = !c || !c.hasNumbers || c.app + c.pend === 0;
      const capRow = !c
        ? ''
        : preOpen
        ? `<div class="pi-cap"><span class="metabit">${icon('users')}${c.cap}학급 오픈 전</span></div>`
        : gaugeHtml(c);
      const rate = ratingOf(x.institution, s);
      return `<a class="planrow ${rate.dim ? 'planrow-skip' : ''}" href="${escapeHtml(
        x.link || '#'
      )}" target="_blank" rel="noopener">
        ${railDdayHtml(dd)}
        <div class="pi-body">
          ${cardHead(x, s)}
          <div class="pi-meta">${metaHtml}${targetChipsHtml(x)}</div>
          ${capRow}
        </div>
      </a>`;
    })
    .join('');

  // 지금 신청 가능 카드 — 레일은 실질 잔여, 본문 3행(제목 / 차시·마감·대상칩 / 3단 게이지)
  const liveRows = live
    .map((x) => {
      const c = capacityOf(x);
      const end = x.detail && x.detail.applyEndAt;
      const metaHtml = [chaptersHtml(x), dateHtml(end, '~')]
        .filter(Boolean)
        .join('<span class="metasep">·</span>');
      const rate = ratingOf(x.institution, s);
      return `<a class="planrow ${c && c.full ? 'planrow-dim' : ''} ${
        rate.dim ? 'planrow-skip' : ''
      }" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        ${railHtml(c)}
        <div class="pi-body">
          ${cardHead(x, s)}
          <div class="pi-meta">${metaHtml}${targetChipsHtml(x)}</div>
          ${gaugeHtml(c)}
        </div>
      </a>`;
    })
    .join('');

  const changeLogs = storage.getLog().filter((l) => l.kind === 'change').slice(0, 5);
  const changeRows = changeLogs
    .map(
      (l) => `<div class="chgrow">
        <div class="pi-head"><span class="badge badge-change">정보 변경</span>
          <span class="pi-name">${escapeHtml(instLabel(l.institution, l.title))}</span></div>
        <div class="pi-meta">${escapeHtml(l.changes || '')}</div>
      </div>`
    )
    .join('');

  // 섹션 순서: '지금 신청 가능'을 '신청 오픈 예정'보다 위에 둔다.
  // 갑자기 뜬 매물은 그 자리에서 바로 대응해야 하지만, 오픈 예정은 미리 준비할 시간이 있다.
  // 다만 신청 가능이 0건이면 한 줄로 최소화해 오픈 예정이 자연스럽게 위로 올라오게 한다.
  const liveSection = live.length
    ? `<div class="plan-group">
        <div class="plan-group-title">🔥 지금 신청 가능 <span class="muted small">${live.length}</span></div>
        ${liveRows}
      </div>`
    : `<div class="plan-group plan-group-min">
        <div class="plan-group-title">🔥 지금 신청 가능 <span class="muted small">현재 없음</span></div>
      </div>`;

  const html = `
    <div class="card planner">
      <div class="card-title">🗂️ 신청 플래너</div>
      ${legendHtml(s)}
      ${liveSection}
      <div class="plan-group">
        <div class="plan-group-title">🕐 신청 오픈 예정 <span class="muted small">${open.length}</span></div>
        ${openRows || '<div class="muted small">예정된 프로그램이 없습니다.</div>'}
      </div>
      ${
        changeRows
          ? `<div class="plan-group">
        <div class="plan-group-title">🔄 정보 변경 <span class="muted small">${changeLogs.length}</span></div>
        ${changeRows}
      </div>`
          : ''
      }
    </div>`;
  return { html, openReady };
}

// ---- 상단 탭 ----
// active: 'home' | 'practice' | 'settings' | null
function navTabs(active) {
  const tabs = [
    { key: 'home', href: '/', label: '🌱 대시보드' },
    { key: 'practice', href: '/practice', label: '🏃 신청 연습' },
    { key: 'settings', href: '/settings', label: '⚙️ 설정' },
  ];
  return `<nav class="navlinks">${tabs
    .map(
      (t) =>
        `<a class="navlink${t.key === active ? ' on' : ''}" href="${t.href}"${
          t.key === active ? ' aria-current="page"' : ''
        }>${t.label}</a>`
    )
    .join('')}</nav>`;
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 새싹 레이더</title>
<style>
  :root {
    --green:#22a95f; --green-d:#178a4c; --bg:#f6f9f6; --ink:#1c2a22; --muted:#8a988f; --line:#e6ede8;
    /* 표면·글자 토큰 (다크모드에서 이 값들만 갈아끼운다) */
    --surface-1:#f1f6f2;   /* 눌린 배경: 회색칩·게이지 트랙·호버 */
    --surface-2:#ffffff;   /* 카드 배경 */
    --text-secondary:#5c6b62;
    --text-muted:#8a988f;
    /* 정원 게이지 — 진초록=승인 · 주황=대기 · 빈 배경=실질 잔여 · 빨강=실질 잔여 0
       (대기를 연초록으로 두면 승인과 붙어 보여서 색상 계열 자체를 분리했다) */
    --gauge-ok:#1D9E75; --gauge-app:#1D9E75; --gauge-pend:#EF9F27; --gauge-full:#E24B4A;
    /* 좌측 잔여 레일 (여유 / 임박 / 마감·대기만 / D-day) */
    --rail-ok-bg:#E1F5EE;   --rail-ok-fg:#085041;
    --rail-soon-bg:#FAEEDA; --rail-soon-fg:#633806;
    --rail-full-bg:#FCEBEB; --rail-full-fg:#791F1F;
    --rail-dday-bg:#EAF1FF; --rail-dday-fg:#2A52BE;
    /* 교육대상 진한 색칩 (우리 학교 대상) — 라이트 기준 */
    --tc-general-bg:#E6F1FB; --tc-general-fg:#0C447C;
    --tc-migrant-bg:#EEEDFE; --tc-migrant-fg:#26215C;
    --tc-welfare-bg:#E1F5EE; --tc-welfare-fg:#085041;
    /* 기관 평가 표식 — 색점(원+연한 테두리) · 별점 · 하트 */
    --mk-strong:#1D9E75; --mk-strong-ring:#E1F5EE;
    --mk-ok:#EF9F27;   --mk-ok-ring:#FBEED5;
    --mk-no:#E24B4A; --mk-no-ring:#FCE4E3;
    --mk-star:#B7791F; --mk-heart:#E0567B;
    /* 판정 문구 배지 (카드 표식) */
    --vb-strong-bg:#E1F5EE; --vb-strong-fg:#0A6B52;
    --vb-ok-bg:#FBEED5;     --vb-ok-fg:#8A5A08;
    --vb-no-bg:#FCE4E3;     --vb-no-fg:#8A241F;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#121714; --ink:#e6ede8; --muted:#8b9a90; --line:#26302a;
      --surface-1:#1b221e; --surface-2:#171e1a;
      --text-secondary:#a9b8ae; --text-muted:#8b9a90;
      /* 진한 색칩: 배경은 어둡게, 글자는 밝게 뒤집어 대비 확보 */
      --tc-general-bg:#12304f; --tc-general-fg:#BBD9F5;
      --tc-migrant-bg:#2A2760; --tc-migrant-fg:#D5D2FA;
      --tc-welfare-bg:#0E4034; --tc-welfare-fg:#B7E7D6;
      /* 레일도 같은 방식으로 뒤집는다 (게이지 색은 라이트와 동일하게 유지해도 대비가 난다) */
      --rail-ok-bg:#0E4034;   --rail-ok-fg:#B7E7D6;
      --rail-soon-bg:#4A3410; --rail-soon-fg:#F6DFB4;
      --rail-full-bg:#4A1A1A; --rail-full-fg:#F5C4C4;
      --rail-dday-bg:#1B2F55; --rail-dday-fg:#C3D6F7;
      --gauge-pend:#D18A1A;
      /* 표식: 점 색은 그대로 두고 테두리만 어둡게 (밝은 링은 다크에서 튄다) */
      --mk-strong-ring:#123A30; --mk-ok-ring:#43350F; --mk-no-ring:#45201F;
      --mk-star:#D9A64A; --mk-heart:#EF7C9C;
      /* 판정 배지도 배경은 어둡게, 글자는 밝게 뒤집는다 */
      --vb-strong-bg:#0E4034; --vb-strong-fg:#B7E7D6;
      --vb-ok-bg:#4A3410;     --vb-ok-fg:#F6DFB4;
      --vb-no-bg:#4A1A1A;     --vb-no-fg:#F5C4C4;
    }
  }
  * { box-sizing: border-box; }
  /* hidden 속성은 브라우저 기본 스타일시트의 [hidden]{display:none} 으로만 동작한다.
     같은 요소에 클래스로 display 를 선언하면 — 특이도가 같아도 작성자 스타일시트가
     UA 스타일시트를 이기므로 — hidden 이 무시되고 그대로 보인다.
     실제로 .pf-modal{display:flex} 때문에 주소 검색 모달이 첫 화면부터 떠 있었다.
     앞으로 display 를 선언한 요소에 hidden 을 붙여도 같은 사고가 나지 않도록 못을 박는다. */
  [hidden] { display: none !important; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    line-height:1.5; }
  .wrap { max-width: 780px; margin:0 auto; padding: 18px 16px 60px; }
  .header { display:flex; align-items:center; justify-content:space-between; margin: 8px 0 18px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing:-0.02em; }
  /* 제목은 누르는 자리다 — 대시보드에서는 새로고침, 다른 화면에서는 홈으로.
     글자 색·크기는 그대로 두고(제목처럼 보여야 한다) 누를 수 있다는 것만 알린다. */
  a.logo { color:inherit; text-decoration:none; cursor:pointer;
    display:inline-flex; align-items:center; gap:2px;
    padding:4px 8px; margin:-4px -8px; border-radius:10px; /* 여백은 음수 마진으로 상쇄 */
    transition: background .12s ease; }
  a.logo:hover, a.logo:focus-visible { background:var(--surface-2); }
  a.logo:focus-visible { outline:2px solid var(--green-d); outline-offset:1px; }
  a.logo:active { transform: translateY(1px); }
  @media (prefers-reduced-motion: reduce) {
    a.logo { transition:none; }
    a.logo:active { transform:none; }
  }
  .navlink { color:var(--green-d); text-decoration:none; font-weight:600; font-size:14px;
    background:var(--surface-2); padding:8px 12px; border-radius:10px; border:1px solid var(--line);
    white-space:nowrap; }
  .navlink:hover { background:var(--surface-1); }
  /* 상단 탭 묶음 — 좁은 화면에서는 제목 아래로 접힌다 */
  .navlinks { display:flex; align-items:center; gap:7px; flex-wrap:wrap; justify-content:flex-end; }
  .navlink.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); }
  @media (prefers-color-scheme: dark) {
    .navlink.on { background:#17301f; border-color:#2b5c3c; }
  }
  @media (max-width:420px) {
    .header { flex-wrap:wrap; gap:9px; }
    .navlinks { width:100%; justify-content:flex-start; }
    .navlink { font-size:13px; padding:7px 10px; }
  }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:14px; }
  .card { background:var(--surface-2); border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
  .card-title { font-weight:700; font-size:15px; margin-bottom:9px; }
  /* v3 상태바 */
  .statusbar { display:flex; align-items:center; flex-wrap:wrap; gap:7px; background:var(--surface-2);
    border:1px solid var(--line); border-radius:12px; padding:10px 14px; margin-bottom:8px;
    font-size:13px; color:var(--text-secondary); }
  .sdot { width:9px; height:9px; border-radius:50%; flex:none; }
  .dot-ok { background:var(--green); box-shadow:0 0 0 3px #d9f0e2; }
  .dot-bad { background:#d9534f; box-shadow:0 0 0 3px #f7d9d8; }
  .dot-wait { background:#c9a227; box-shadow:0 0 0 3px #f5ecc9; }
  .sb-main { font-weight:800; color:var(--ink); }
  .sb-sep { color:var(--line); }
  .sb-perm { display:inline-flex; align-items:center; }
  .perm-ok { color:var(--green-d); font-weight:700; }
  .perm-bad { color:#d9534f; font-weight:700; cursor:help; }
  .condbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    padding:2px 4px 0; margin-bottom:14px; }
  .condlabel { font-size:11px; color:var(--text-muted); font-weight:600; margin-right:2px; }
  .condchip { font-size:11.5px; padding:2px 9px; border-radius:999px; font-weight:600; line-height:1.7; white-space:nowrap; }
  .cc-green { background:#E1F5EE; color:#085041; }
  .cc-yellow { background:#FAEEDA; color:#633806; }
  .cc-blue { background:#EEF0FE; color:#3F3FBF; }
  .stat { text-align:left; }
  .stat-label { color:var(--muted); font-size:12px; font-weight:600; }
  .stat-num { font-size:30px; font-weight:800; margin:2px 0 4px; letter-spacing:-0.02em; }
  .stat-sub { color:var(--muted); font-size:12px; }
  .stat-ok { color:var(--green-d); }
  .stat-bad { color:#d9534f; }
  .chips { display:flex; flex-wrap:wrap; gap:7px; }
  .chip { background:#eaf6ef; color:var(--green-d); border:1px solid #d4ecdd;
    padding:5px 11px; border-radius:999px; font-size:13px; font-weight:600; }
  .row-between { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
  .loglist { margin-top:6px; }
  .logrow { display:flex; align-items:center; gap:10px; padding:9px 10px; margin:0 -10px;
    border-top:1px solid var(--line); border-radius:9px; }
  .logrow:first-child { border-top:none; }
  .logrow-link { text-decoration:none; color:inherit; transition:background .12s; }
  .logrow-link:hover { background:var(--surface-1); }
  .logrow-disabled { cursor:default; opacity:.62; }
  .logtitle { flex:1; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logtime { color:var(--muted); font-size:12px; white-space:nowrap; }
  .gonow { color:var(--green-d); font-size:12px; font-weight:700; white-space:nowrap;
    opacity:0; transition:opacity .12s; }
  .logrow-link:hover .gonow { opacity:1; }
  .badge { font-size:11px; font-weight:700; padding:3px 8px; border-radius:7px; white-space:nowrap; }
  .badge-start { background:#fdeaea; color:#d9534f; }
  .badge-new { background:#fff6e6; color:#c98a00; }
  .badge-test { background:#f0e9fb; color:#7c3aed; }
  .badge-newlabel { background:#e6f0ff; color:#1d4ed8; }
  .planner { border-color:#d7ebdf; }
  .plan-group { margin-top:6px; }
  .plan-group + .plan-group { margin-top:16px; border-top:1px dashed var(--line); padding-top:12px; }
  .plan-group-title { font-size:13px; font-weight:800; color:var(--text-secondary); margin-bottom:8px; }
  /* 0건일 때의 '지금 신청 가능' — 제목 한 줄만 남기고 자리를 최소화 */
  .plan-group-min .plan-group-title { margin-bottom:0; opacity:.6; font-weight:700; }
  /* ---- 플래너 카드 v6: [좌측 레일 64px] + [본문 3행] ---- */
  .planrow { display:flex; align-items:stretch; margin-bottom:8px; border:1px solid var(--line);
    border-radius:11px; overflow:hidden; text-decoration:none; color:inherit; transition:box-shadow .12s; }
  .planrow:hover { box-shadow:0 2px 10px rgba(0,0,0,.07); }
  .planrow:hover .pi-body { background:var(--surface-1); }
  /* 실질 잔여 0(대기만) — 숨기지 않고 흐리게만 */
  .planrow-dim { opacity:.85; }
  .rail { width:64px; flex:none; display:flex; flex-direction:column; align-items:center;
    justify-content:center; padding:10px 4px; text-align:center; }
  .rail-num { font-size:20px; font-weight:800; line-height:1.1; letter-spacing:-0.03em; }
  .rail-num-sm { font-size:14px; }
  .rail-label { font-size:10px; font-weight:700; margin-top:3px; opacity:.85; line-height:1.2; }
  .rail-ok { background:var(--rail-ok-bg); color:var(--rail-ok-fg); }
  .rail-soon { background:var(--rail-soon-bg); color:var(--rail-soon-fg); }
  .rail-full { background:var(--rail-full-bg); color:var(--rail-full-fg); }
  .rail-dday { background:var(--rail-dday-bg); color:var(--rail-dday-fg); }
  .rail-dday-now { background:var(--rail-full-bg); color:var(--rail-full-fg); }
  .rail-unknown { background:var(--surface-1); color:var(--text-muted); }
  .pi-body { flex:1; min-width:0; padding:10px 12px; transition:background .12s; }
  .pi-head { display:flex; align-items:center; gap:7px; min-width:0; }
  .pi-inst { color:var(--text-muted); font-weight:400; font-size:12px; white-space:nowrap;
    flex:none; max-width:40%; overflow:hidden; text-overflow:ellipsis; }
  .pi-name { font-weight:500; font-size:13.5px; flex:1; min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pi-go { color:var(--text-muted); flex:none; display:inline-flex; opacity:.55; }
  .planrow:hover .pi-go { opacity:1; }
  .pi-meta { margin-top:5px; color:var(--text-secondary); font-size:12px;
    display:flex; align-items:center; flex-wrap:wrap; gap:6px; min-width:0; }
  /* 메타 조각: 아이콘 + 값 한 덩어리 (아이콘이 없어도 텍스트만 정상 표시) */
  .metabit { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .metabit .ti { flex:none; opacity:.75; }
  .metasep { color:var(--text-muted); opacity:.5; }
  /* 교육대상 색칩 — 우리 학교 대상만 진한 색, 나머지는 회색으로 누름 */
  .tchips { display:inline-flex; flex-wrap:wrap; gap:5px; }
  .tchip { font-size:11px; font-weight:700; line-height:1.6; padding:1px 8px; border-radius:999px;
    white-space:nowrap; }
  .tc-general { background:var(--tc-general-bg); color:var(--tc-general-fg); }
  .tc-migrant { background:var(--tc-migrant-bg); color:var(--tc-migrant-fg); }
  .tc-welfare { background:var(--tc-welfare-bg); color:var(--tc-welfare-fg); }
  .tc-other { background:var(--surface-1); color:var(--text-muted); font-weight:600; }
  /* 3단 게이지: 진초록=승인 · 연초록=대기 · 빈 공간=실질 잔여 */
  .pi-cap { margin-top:7px; display:flex; align-items:center; gap:9px; }
  .g3 { flex:1; min-width:70px; max-width:300px; height:7px; border-radius:999px;
    background:var(--surface-1); overflow:hidden; display:flex; }
  .g3-app { background:var(--gauge-app); }
  .g3-pend { background:var(--gauge-pend); }
  .g3-full .g3-app, .g3-full .g3-pend { background:var(--gauge-full); }
  .g3-text { font-size:11px; color:var(--text-muted); white-space:nowrap; }
  /* 기관 평가 표식 (업체명 앞) — 판정 배지 → 종합점수 → 하트, 사이 4px */
  .imark { flex:none; display:inline-flex; align-items:center; gap:4px; cursor:help; }
  /* 판정 문구 배지 — 색만으로는 뜻이 안 읽혀서 카드에는 글자를 그대로 쓴다 */
  .vbadge { flex:none; font-size:10.5px; font-weight:600; line-height:1.5; padding:2px 8px;
    border-radius:5px; white-space:nowrap; }
  .vb-strong { background:var(--vb-strong-bg); color:var(--vb-strong-fg); }
  .vb-ok     { background:var(--vb-ok-bg);     color:var(--vb-ok-fg); }
  .vb-no     { background:var(--vb-no-bg);     color:var(--vb-no-fg); }
  /* 종합점수 (100점 만점) */
  .imk-score { flex:none; font-size:11px; font-weight:600; color:var(--text-secondary);
    letter-spacing:-0.01em; white-space:nowrap; }
  /* 종합판정 색점: 7px 원 + 같은 계열 연한색 테두리 효과 (설정 화면 요약칩에서 사용) */
  .imk-dot { flex:none; width:7px; height:7px; border-radius:50%; margin:0 1px; }
  .imk-strong { background:var(--mk-strong); box-shadow:0 0 0 2px var(--mk-strong-ring); }
  .imk-ok   { background:var(--mk-ok);   box-shadow:0 0 0 2px var(--mk-ok-ring); }
  .imk-no { background:var(--mk-no); box-shadow:0 0 0 2px var(--mk-no-ring); }
  /* 별점 = 아이콘 + 숫자 한 덩어리 · 하트 = 아이콘만 */
  .imk-star { flex:none; display:inline-flex; align-items:center; gap:2px; color:var(--mk-star);
    line-height:1; }
  .imk-star b { font-size:11.5px; font-weight:600; letter-spacing:-0.01em; }
  .imk-heart { flex:none; display:inline-flex; align-items:center; color:var(--mk-heart);
    line-height:1; }
  .imk-star svg, .imk-heart svg, .imk-dot { display:block; }
  /* 표식 범례 (플래너 상단, 기본 접힘) */
  .plan-legend { margin:-2px 0 10px; }
  .plan-legend > summary { list-style:none; cursor:pointer; display:inline-flex; align-items:center;
    gap:3px; font-size:11.5px; font-weight:600; color:var(--text-muted); }
  .plan-legend > summary::-webkit-details-marker { display:none; }
  .plan-legend > summary::after { content:'▾'; font-size:9px; }
  .plan-legend[open] > summary::after { content:'▴'; }
  .plan-legend > summary:hover { color:var(--text-secondary); }
  .legend-body { display:flex; flex-wrap:wrap; align-items:center; gap:3px 9px; margin-top:6px;
    padding:7px 11px; background:var(--surface-1); border-radius:10px;
    font-size:11.5px; color:var(--text-secondary); }
  .lg { display:inline-flex; align-items:center; gap:4px; }
  .lg-note { color:var(--text-muted); }
  .lg-sep { color:var(--text-muted); opacity:.5; }
  /* 기관 평가 섹션 */
  .ifilters { display:flex; flex-wrap:wrap; gap:7px; margin:12px 0 10px; }
  .fchip { background:var(--surface-1); color:var(--text-secondary); border:1px solid var(--line);
    border-radius:999px; padding:5px 13px; font-size:12.5px; font-weight:700; cursor:pointer; }
  .fchip.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); }
  .ilist { border-top:1px solid var(--line); }
  .irow { border-bottom:1px solid var(--line); }
  .irow > summary { display:flex; align-items:center; gap:10px; padding:10px 2px; cursor:pointer;
    list-style:none; font-size:13.5px; }
  .irow > summary::-webkit-details-marker { display:none; }
  .irow > summary::before { content:'▸'; color:var(--text-muted); flex:none; font-size:11px; }
  .irow[open] > summary::before { content:'▾'; }
  .irow-todo > summary { opacity:.55; }
  .iname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .isum { flex:none; display:flex; align-items:center; gap:7px; }
  .vchip { font-size:11px; font-weight:700; padding:1px 8px; border-radius:999px; white-space:nowrap;
    display:inline-flex; align-items:center; gap:6px; }
  .v-strong { background:var(--rail-ok-bg); color:var(--rail-ok-fg); }
  .v-ok { background:var(--rail-soon-bg); color:var(--rail-soon-fg); }
  .v-no { background:var(--rail-full-bg); color:var(--rail-full-fg); }
  /* 점수에 반영되지 않는 참고 항목 표시 */
  .noscore { font-size:10px; font-weight:700; color:var(--text-muted); background:var(--surface-1);
    border-radius:6px; padding:1px 6px; margin-left:2px; }
  /* 종합점수 배지 — 판정 색을 따라간다 */
  .sbadge { font-size:11.5px; font-weight:800; padding:2px 8px; border-radius:8px;
    min-width:32px; text-align:center; background:var(--surface-1); color:var(--text-secondary); }
  .s-strong { background:var(--rail-ok-bg); color:var(--rail-ok-fg); }
  .s-ok { background:var(--rail-soon-bg); color:var(--rail-soon-fg); }
  .s-no { background:var(--rail-full-bg); color:var(--rail-full-fg); }
  /* 개별 표식 선택 — 마스터가 OFF면 흐리게(끄지는 않음, 미리 골라둘 수 있게) */
  .submarks { margin-top:12px; }
  .submarks-off { opacity:.45; }
  /* 비추천 기관 카드 흐리게 (dimSkip) */
  .planrow-skip { opacity:.65; }
  .iedit { padding:4px 2px 14px; }
  .ifields { display:flex; flex-wrap:wrap; gap:10px 14px; }
  .ifl { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-secondary);
    font-weight:600; }
  .ifl-heart { flex-direction:row; align-items:center; gap:6px; align-self:flex-end;
    padding-bottom:7px; cursor:pointer; }
  .ifl-wide { margin-top:10px; }
  .ifl select, .ifl input[type="text"], .ifl textarea { background:var(--surface-2); color:var(--ink);
    border:1px solid var(--line); border-radius:9px; padding:7px 9px; font-size:13px;
    font-family:inherit; }
  .ifl-wide input[type="text"], .ifl-wide textarea { width:100%; }
  .iskip { margin-top:10px; background:var(--rail-full-bg); color:var(--rail-full-fg);
    border-radius:9px; padding:7px 10px; font-weight:600; }
  .iactions { display:flex; align-items:center; gap:10px; margin-top:12px; }
  /* 정보 변경 줄 (레일 없는 단순 행) */
  .chgrow { padding:8px 2px; }
  .chgrow + .chgrow { border-top:1px solid var(--line); }
  .badge-change { background:#f0e9fb; color:#7c3aed; }
  .badge-unknown { background:#eef0f2; color:#7a848c; }
  .badge-remain { background:#eaf6ef; color:var(--green-d); }
  .badge-full { background:#fdeaea; color:#d9534f; }
  .permchip { display:inline-flex; align-items:center; gap:6px; background:#eaf6ef; color:var(--green-d);
    border:1px solid #cfe9d8; padding:7px 13px; border-radius:999px; font-size:13px; font-weight:700;
    margin-bottom:14px; }
  .permbanner { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
    padding:12px 16px; border-radius:12px; margin-bottom:14px; font-size:14px; font-weight:600; }
  .permtext { flex:1; min-width:200px; }
  .perm-default { background:#fff8e6; border:1px solid #f4e3b0; color:#8a6d1a; }
  .perm-denied { background:#fdeaea; border:1px solid #f3caca; color:#a33; }
  .btn-amber { background:#f0ad2e; color:#3a2c05; }
  .btn-amber:hover { background:#e09c1c; }
  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(20px);
    background:#1c2a22; color:#fff; padding:12px 18px; border-radius:12px; font-size:14px; font-weight:600;
    box-shadow:0 8px 24px rgba(0,0,0,.18); opacity:0; pointer-events:none; transition:.25s; z-index:50;
    max-width:90vw; text-align:center; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .btn { border:none; border-radius:10px; padding:10px 16px; font-size:14px; font-weight:700;
    cursor:pointer; }
  .btn-green { background:var(--green); color:#fff; }
  .btn-green:hover { background:var(--green-d); }
  .btn-green:disabled { opacity:.6; cursor:default; }
  /* 관리자 전용 — 비활성 톤이되 진짜 disabled 로 두지는 않는다.
     disabled 버튼은 툴팁도 안 뜨고 눌러도 반응이 없어, 왜 안 되는지 알 길이 없다.
     눌리기는 하되 그 자리에서 '관리자 전용' 안내를 보여 주는 편이 친절하다.
     테두리는 box-shadow 로 그린다 — border 를 쓰면 잠글 때 버튼이 2px 커져 줄이 흔들린다. */
  .btn-locked { background:var(--surface-1); color:var(--muted);
    box-shadow: inset 0 0 0 1px var(--line); cursor:help; }
  .btn-locked:hover { color:var(--text-secondary); }
  .btn-lg { padding:12px 26px; font-size:15px; }
  .btn-sm { padding:7px 12px; font-size:13px; }
  .btn-xs { padding:3px 10px; font-size:12px; border-radius:8px; }
  .badge-reminder { background:#eaf1ff; color:#2a52be; }
  .opts { display:flex; flex-wrap:wrap; gap:9px; }
  .opt { display:inline-flex; align-items:center; gap:7px; background:var(--surface-1); border:1px solid var(--line);
    padding:9px 13px; border-radius:11px; cursor:pointer; font-size:14px; user-select:none; }
  .opt.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); font-weight:600; }
  .opt input { accent-color: var(--green); width:16px; height:16px; }
  /* 표식 아이콘이 섞인 라벨(표식 고르기·정성 호감)도 가운데 정렬 */
  .submarks .opt > span, .ifl-heart > span { display:inline-flex; align-items:center; gap:5px; }
  .interval { display:flex; align-items:center; gap:10px; }
  .interval input { width:90px; padding:9px 12px; border:1px solid var(--line); border-radius:10px; font-size:15px; }
  /* 입력창도 표면 토큰을 따라가야 다크에서 흰 배경 + 흰 글자가 되지 않는다 */
  input[type="text"], input[type="number"], input[type="password"] {
    background:var(--surface-2); color:var(--ink); }
  .actions { display:flex; align-items:center; gap:14px; margin: 6px 0 20px; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .err { background:#fdeaea; color:#a33; border-color:#f3caca; }
  /* '지금 즉시 확인' 결과 줄. 큐 대기(파랑)·관리자 전용(회색)·진짜 실패(빨강)를
     색으로 갈라 놓는다 — 예약이나 권한 안내는 아무것도 잘못되지 않은 상태라
     빨간 글씨를 보여 줄 이유가 없다. */
  .check-result { margin-top:6px; line-height:1.5; }
  .check-ok   { color:var(--green-d); font-weight:600; }
  .check-wait { color:#2b6cb0; font-weight:600; }
  .check-lock { color:var(--text-secondary); font-weight:600; }
  .check-err  { color:#a33; font-weight:600; }
  /* ---- 알림 권한 상태 / 알림 로그 ---- */
  .permraw { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
    background:var(--surface-1); border:1px solid var(--line); color:var(--text-secondary);
    padding:1px 6px; border-radius:6px; }
  .permraw-lg { font-size:12px; padding:3px 9px; font-weight:700; }
  .permstate { background:var(--surface-1); border:1px solid var(--line); border-radius:11px;
    padding:11px 13px; margin-bottom:13px; }
  .permstate-row { display:flex; align-items:center; gap:9px; flex-wrap:wrap; padding:3px 0; }
  .permstate-k { font-size:12px; font-weight:700; color:var(--text-secondary); min-width:150px; }
  .nlog-head, .nlog-row { display:grid; grid-template-columns: 108px 1fr 96px 84px; gap:9px;
    align-items:center; padding:7px 0; }
  .nlog-head { font-size:11px; font-weight:800; color:var(--text-muted);
    border-bottom:1px solid var(--line); padding-bottom:6px; }
  .nlog-row { border-top:1px solid var(--line); font-size:13px; }
  .nlog-row:first-child { border-top:none; }
  .nlog-time { color:var(--text-secondary); font-size:12px; white-space:nowrap; }
  .nlog-title { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nlog-kind { font-size:12px; color:var(--text-secondary); white-space:nowrap; }
  .nlog-res { font-size:12px; font-weight:700; white-space:nowrap; }
  .dl-ok  { color:var(--green-d); }
  .dl-bad { color:#d9534f; }
  .dl-off { color:var(--text-muted); }
  .dl-bad-t { color:#d9534f; }
  /* ================= 신청 연습 ================= */
  /* 상단 고정 안내 — 스크롤해도 '연습용' 이라는 사실이 화면에서 사라지지 않게 한다 */
  .pr-notice { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:9px;
    background:#fff6e6; color:#7a5200; border:1px solid #f0dcae; border-radius:12px;
    padding:11px 14px; margin-bottom:13px; font-size:13px; line-height:1.45; }
  .pr-notice-ico { font-size:16px; flex-shrink:0; }
  .btn-ghost { background:var(--surface-1); color:var(--text-secondary); border:1px solid var(--line); }
  .btn-ghost:hover { background:var(--surface-2); }
  .pr-status { font-size:13px; color:var(--text-secondary); margin-top:9px; line-height:1.5; }
  .pr-open { color:var(--green-d); }
  .pr-result { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:11px;
    padding:11px 13px; border-radius:11px; background:var(--surface-1); border:1px solid var(--line); }
  .pr-result-best { background:#eaf6ef; border-color:#bfe4cd; }
  .pr-ms { font-size:26px; font-weight:800; color:var(--green-d); letter-spacing:-0.02em; }
  .pr-ms-u { font-size:14px; font-weight:700; margin-left:2px; }
  .pr-besttag { font-size:12px; font-weight:800; color:#8a5a08; background:#fbeed5;
    padding:4px 9px; border-radius:999px; }
  .pr-misstag { font-size:12px; font-weight:700; color:#a33; background:#fdeaea;
    padding:4px 9px; border-radius:999px; }
  /* ---- 프로그램 상세 재현 ---- */
  .pr-card { padding:16px; }
  .pr-detail { display:grid; grid-template-columns:132px 1fr; gap:15px; align-items:start; }
  .pr-thumb { aspect-ratio:4/3; border-radius:11px; background:var(--surface-1);
    border:1px dashed var(--line); display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:6px; padding:9px; text-align:center; overflow:hidden; }
  .pr-thumb-tag { font-size:10px; font-weight:700; color:var(--text-muted); letter-spacing:.04em; }
  .pr-thumb-name { font-size:12px; font-weight:700; color:var(--text-secondary); line-height:1.35;
    overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .pr-main { min-width:0; }
  .pr-badge { display:inline-block; font-size:11px; font-weight:800; padding:4px 10px;
    border-radius:999px; margin-bottom:7px; }
  .pr-badge-soon { background:#eef0f2; color:#7a848c; }
  .pr-badge-open { background:#eaf6ef; color:var(--green-d); }
  .pr-title { font-size:17px; font-weight:800; margin:0 0 3px; line-height:1.35;
    letter-spacing:-0.01em; overflow-wrap:anywhere; }
  .pr-inst { font-size:13px; color:var(--text-secondary); margin-bottom:11px; overflow-wrap:anywhere; }
  .pr-table { display:grid; grid-template-columns:92px 1fr; gap:0; margin:0;
    border-top:1px solid var(--line); }
  .pr-table dt { font-size:12px; font-weight:700; color:var(--text-secondary);
    padding:8px 9px 8px 0; border-bottom:1px solid var(--line); }
  .pr-table dd { font-size:13px; margin:0; padding:8px 0; border-bottom:1px solid var(--line);
    overflow-wrap:anywhere; }
  /* ---- 신청하기 ---- */
  .pr-apply-wrap { margin-top:16px; }
  .pr-apply { width:100%; border:none; border-radius:12px; padding:16px; font-size:16px;
    font-weight:800; cursor:pointer; background:var(--green); color:#fff;
    transition:background .12s, opacity .12s; }
  .pr-apply:hover { background:var(--green-d); }
  .pr-apply:focus-visible { outline:2px solid var(--green-d); outline-offset:2px; }
  /* 비활성 — 진짜 disabled 가 아니라 잠금 상태다 (헛클릭을 세야 하므로) */
  .pr-apply.is-locked { background:var(--surface-1); color:var(--text-muted);
    border:1px solid var(--line); cursor:not-allowed; }
  .pr-apply.is-locked:hover { background:var(--surface-1); }
  .pr-applymsg { min-height:18px; margin-top:7px; font-size:12px; text-align:center; }
  .pr-applymsg-warn { color:#a33; font-weight:700; }
  .pr-formph { display:flex; align-items:flex-start; gap:12px; padding:16px;
    border:1px dashed var(--line); border-radius:11px; background:var(--surface-1); }
  .pr-formph-ico { font-size:22px; line-height:1; }
  /* ---- 결과: 구간 분해 ---- */
  .pr-result-block { display:block; }
  .pr-resulthead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pr-result-dq { background:#fdeaea; border-color:#f3caca; }
  .pr-dqtag { font-size:12px; font-weight:800; color:#a33; background:#fff;
    border:1px solid #f3caca; padding:4px 9px; border-radius:999px; }
  .pr-segs { margin-top:12px; display:grid; gap:5px; }
  .pr-seg { display:grid; grid-template-columns:132px 1fr 56px; gap:9px; align-items:center; }
  .pr-seg-label { font-size:12px; color:var(--text-secondary); }
  .pr-seg-bar { height:8px; border-radius:999px; background:var(--surface-2);
    border:1px solid var(--line); overflow:hidden; }
  .pr-seg-bar i { display:block; height:100%; background:var(--green); }
  .pr-seg-val { font-size:12px; font-weight:700; text-align:right; white-space:nowrap; }
  .pr-seg-worst .pr-seg-label { color:#8a5a08; font-weight:700; }
  .pr-seg-worst .pr-seg-bar i { background:var(--gauge-pend); }
  .pr-worst { margin-top:10px; font-size:13px; color:var(--text-secondary); }
  .pr-tip { margin-top:9px; padding:10px 13px; border-radius:10px; font-size:13px; line-height:1.5;
    background:#fff6e6; border:1px solid #f0dcae; color:#7a5200; }
  .pf-today { white-space:nowrap; flex-shrink:0; }
  .pr-badlist { margin-top:11px; padding:11px 13px; border-radius:10px;
    background:#fdeaea; border:1px solid #f3caca; color:#7a2020; font-size:13px; }
  .pr-badlist ul { margin:6px 0 0; padding-left:18px; }
  .pr-badlist li { margin:3px 0; }
  .pr-recrow-dq .pr-recms { color:#a33; }
  .pr-recdq { font-size:12px; font-weight:700; }
  .pr-recrow-dq .pr-recdq { color:#a33; }
  .pr-recworst { font-size:12px; color:var(--text-muted); overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  /* ================= 신청 폼 ================= */
  .pf-info { background:var(--surface-1); border:1px solid var(--line); border-left:3px solid var(--green);
    border-radius:11px; padding:12px 14px; margin-bottom:14px; }
  .pf-info-title { font-size:13px; font-weight:800; margin-bottom:8px; }
  .pf-info-list { display:grid; grid-template-columns:104px 1fr; margin:0; gap:0; }
  .pf-info-list dt { font-size:12px; color:var(--text-secondary); font-weight:700; padding:4px 0; }
  .pf-info-list dd { font-size:13px; font-weight:700; margin:0; padding:4px 0; overflow-wrap:anywhere; }
  .pf-info-hint { margin-top:8px; font-size:12px; color:#8a5a08; font-weight:600; line-height:1.45; }
  .pf-sec { border-top:1px solid var(--line); padding:13px 0 0; margin:0 0 13px; }
  .pf-sec:first-of-type { border-top:none; padding-top:0; }
  .pf-legend { font-size:13px; font-weight:800; margin-bottom:8px; display:flex;
    align-items:center; gap:7px; flex-wrap:wrap; }
  .pf-req { color:#d9534f; }
  .pf-must { color:#d9534f; }
  .pf-tag { font-size:11px; font-weight:600; color:var(--text-muted); background:var(--surface-1);
    border:1px solid var(--line); padding:2px 7px; border-radius:999px; }
  .pf-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
  .pf-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
  .pf-label { font-size:12px; font-weight:700; color:var(--text-secondary); }
  .pf-in { width:100%; min-width:0; font:inherit; font-size:14px; padding:10px 11px;
    border:1px solid var(--line); border-radius:9px; background:var(--surface-2); color:var(--ink); }
  .pf-in:focus { outline:2px solid var(--green); outline-offset:-1px; }
  .pf-in[readonly] { background:var(--surface-1); color:var(--text-muted); cursor:default; }
  .pf-in-sm { max-width:88px; }
  .pf-ta { resize:vertical; line-height:1.5; }
  .pf-bad { border-color:#d9534f !important; background:#fdeaea; }
  .pf-addr-row { display:flex; gap:8px; align-items:center; }
  .pf-addr-row .pf-in { flex:1; }
  .pf-addr-row .btn { white-space:nowrap; }
  .pf-grades { display:grid; gap:7px; }
  .pf-grade { display:flex; align-items:center; gap:9px; padding:10px 12px; border-radius:10px;
    background:var(--surface-1); border:1px solid var(--line); font-size:13px; cursor:pointer; }
  .pf-grade input { accent-color:var(--green); width:16px; height:16px; }
  .pf-grade.is-off { opacity:.45; cursor:not-allowed; }
  .pf-grade.is-off input { cursor:not-allowed; }
  /* 교육대상 7개 — 전부 활성. 잠긴 항목이 없으므로 is-off 대응 규칙도 두지 않는다. */
  .pf-edus { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
  .pf-edu { display:flex; align-items:center; gap:8px; padding:9px 11px; border-radius:10px;
    background:var(--surface-1); border:1px solid var(--line); font-size:13px; cursor:pointer;
    min-width:0; }
  .pf-edu input { accent-color:var(--green); width:16px; height:16px; flex-shrink:0; }
  .pf-edu span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pf-datewrap { display:flex; align-items:center; gap:10px; }
  .pf-datewrap .pf-label { min-width:32px; }
  .pf-daterow { display:flex; gap:7px; flex:1; min-width:0; }
  .pf-daterow .pf-in:first-child { flex:1; min-width:0; }
  .pf-agree { display:flex; align-items:center; gap:9px; padding:10px 12px; border-radius:10px;
    border:1px solid var(--line); font-size:13px; cursor:pointer; margin-bottom:6px; }
  .pf-agree input { accent-color:var(--green); width:16px; height:16px; }
  .pf-agree-all { background:var(--surface-1); font-weight:700; }
  .pf-submitmsg { min-height:18px; font-size:12px; text-align:center; margin:4px 0 8px; }
  .pf-submitmsg-warn { color:#a33; font-weight:700; }
  .pf-actions { display:flex; gap:9px; }
  .pf-actions .btn { flex:1; padding:14px; font-size:15px; }
  /* ---- 주소 검색 모달 ---- */
  .pf-modal { position:fixed; inset:0; z-index:60; display:flex; align-items:center;
    justify-content:center; padding:16px; }
  /* 전역 [hidden] 규칙과 겹치지만 일부러 남긴다 — display 를 선언한 바로 그 자리에서
     "이 요소는 hidden 으로 숨긴다" 를 눈에 보이게 해 두어야 다음 사람이 안 밟는다. */
  .pf-modal[hidden] { display:none; }
  .pr-result[hidden] { display:none; }
  .pf-modal-back { position:absolute; inset:0; background:rgba(0,0,0,.42); }
  .pf-modal-box { position:relative; width:100%; max-width:440px; max-height:82vh; overflow:auto;
    background:var(--surface-2); border:1px solid var(--line); border-radius:14px; padding:16px;
    box-shadow:0 14px 40px rgba(0,0,0,.22); }
  .pf-modal-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
  .pf-modal-x { border:none; background:transparent; font-size:16px; cursor:pointer;
    color:var(--text-muted); padding:4px 8px; border-radius:8px; }
  .pf-modal-x:hover { background:var(--surface-1); }
  .pf-results { margin-top:10px; display:grid; gap:6px; }
  .pf-results-ph { font-size:12px; color:var(--text-muted); padding:14px 4px; text-align:center; }
  .pf-result { display:grid; grid-template-columns:58px 1fr; gap:3px 9px; width:100%; text-align:left;
    padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--surface-1);
    cursor:pointer; font:inherit; color:inherit; }
  .pf-result:hover { background:#eaf6ef; border-color:#bfe4cd; }
  .pf-zip { grid-row:span 2; font-size:11px; font-weight:800; color:var(--text-muted);
    align-self:center; }
  .pf-road { font-size:13px; font-weight:700; overflow-wrap:anywhere; }
  .pf-jibun { font-size:11px; color:var(--text-muted); overflow-wrap:anywhere; }
  @media (prefers-color-scheme: dark) {
    .pr-tip { background:#2a2416; border-color:#4a3f22; color:#e8d7ab; }
    .pf-bad { background:#3a1f1f; }
    .pf-result:hover { background:#17301f; border-color:#2b5c3c; }
    .pr-result-dq { background:#3a1f1f; border-color:#5c2b2b; }
    .pr-dqtag { background:#241414; border-color:#5c2b2b; color:#f0b4b4; }
    .pr-badlist { background:#2a1818; border-color:#5c2b2b; color:#f0c4c4; }
    .pf-info-hint { color:#e0bd7a; }
  }
  /* ---- 기록 ---- */
  .pr-best { font-size:13px; margin:11px 0 9px; }
  .pr-bestnum { color:var(--green-d); font-size:15px; }
  .pr-rechead, .pr-recrow { display:grid; grid-template-columns:1fr 96px 72px; gap:9px;
    align-items:center; }
  .pr-rechead { font-size:11px; font-weight:800; color:var(--text-muted);
    border-bottom:1px solid var(--line); padding-bottom:6px; }
  .pr-recrow { font-size:13px; padding:8px 0; border-top:1px solid var(--line); }
  .pr-recrow:first-of-type { border-top:none; }
  .pr-recrow-best { font-weight:700; }
  .pr-recwhen { color:var(--text-secondary); font-size:12px; }
  .pr-recms { font-weight:700; }
  .pr-recrow-best .pr-recms { color:var(--green-d); }
  .pr-recmiss { color:var(--text-muted); font-size:12px; }
  .pr-rechead span:not(:first-child), .pr-recrow span:not(:first-child) { text-align:right; }
  @media (prefers-color-scheme: dark) {
    .pr-notice { background:#2a2416; color:#e8d7ab; border-color:#4a3f22; }
    .pr-besttag { background:#3a2f14; color:#f0d79a; }
    .pr-misstag { background:#3a1f1f; color:#f0b4b4; }
    .pr-result-best { background:#17301f; border-color:#2b5c3c; }
    .pr-badge-soon { background:#2a3230; color:#9aa8a0; }
    .pr-badge-open { background:#17301f; color:#7fd3a3; }
  }
  /* 375px 대응 — 썸네일을 위로 올리고 표를 2줄 구조로 좁힌다 */
  @media (max-width:480px) {
    .pr-detail { grid-template-columns:1fr; gap:12px; }
    .pr-thumb { aspect-ratio:16/7; flex-direction:row; gap:9px; }
    .pr-thumb-name { -webkit-line-clamp:2; }
    .pr-table { grid-template-columns:80px 1fr; }
    .pr-table dt { font-size:11px; padding-right:7px; }
    .pr-table dd { font-size:12px; }
    .pr-card { padding:13px; }
    .pr-apply { font-size:15px; padding:15px; }
    .pr-ms { font-size:23px; }
    /* 기록 표: 좁은 화면에서는 2열 2줄 구조로 접는다 */
    .pr-rechead { display:none; }
    .pr-recrow { grid-template-columns:1fr auto; row-gap:2px; }
    .pr-recwhen { order:1; }
    .pr-recms { order:2; text-align:right; }
    .pr-recworst { order:3; grid-column:1; text-align:left; }
    .pr-recdq { order:4; grid-column:2; text-align:right; }
    /* 폼 */
    .pf-grid2 { grid-template-columns:1fr; }
    .pf-edus { grid-template-columns:1fr; }
    .pf-info-list { grid-template-columns:88px 1fr; }
    .pf-datewrap { flex-direction:column; align-items:stretch; gap:5px; }
    .pf-datewrap .pf-label { min-width:0; }
    .pf-daterow { flex-wrap:wrap; }
    .pf-daterow .pf-in:first-child { flex:1 1 100%; }
    .pf-in-sm { flex:1; max-width:none; }
    .pf-addr-row { flex-wrap:wrap; }
    .pf-addr-row .pf-in { flex:1 1 100%; }
    .pf-addr-row .btn { width:100%; }
    .pf-actions .btn { padding:13px; font-size:14px; }
    .pf-modal { padding:10px; }
    .pf-modal-box { padding:13px; }
    /* 구간 막대: 라벨을 위로 올리고 막대+값을 아래 줄에 */
    .pr-seg { grid-template-columns:1fr 52px; row-gap:3px; }
    .pr-seg-label { grid-column:1 / -1; }
    .pr-seg-val { text-align:right; }
  }
  @media (max-width:560px){
    .nlog-head { display:none; }
    .nlog-row { grid-template-columns: 1fr auto; row-gap:2px; }
    .nlog-title { grid-column:1 / -1; order:1; }
    .nlog-time { order:2; }
    .nlog-kind { order:3; text-align:right; }
    .nlog-res { grid-column:2; order:4; text-align:right; }
  }
  @media (max-width:560px){
    .grid { grid-template-columns: 1fr; }
    .stat-num { font-size:26px; }
  }
</style>
</head>
<body>
  <script>
    // ============ 공용 알림 유틸 ============
    // 본문보다 먼저 정의한다 — 각 화면의 인라인 스크립트가 파싱 즉시 이걸 부른다.
    // 브라우저 알림을 실제로 띄우는 함수는 이 하나뿐이다. 대시보드의 자동 발사도,
    // 설정 화면의 테스트 버튼도 전부 saessak.fireNotification 을 거친다
    // (테스트가 따로 만든 경로를 타면 검증이 되지 않으므로).
    window.saessak = (function () {
      function permission() {
        if (!('Notification' in window)) return 'unsupported';
        return Notification.permission; // 'granted' | 'denied' | 'default'
      }

      // p: { title, body, link } — 서버 notifyPayload() 가 만든 그대로
      // 반환: 'sent' | 'unsupported' | 'denied' | 'default' | 'error'
      function fireNotification(p) {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission !== 'granted') return Notification.permission;
        try {
          var n = new Notification(p.title, { body: p.body || '', icon: '/favicon.ico' });
          n.onclick = function (e) {
            e.preventDefault();
            if (p.link) window.open(p.link, '_blank', 'noopener');
            window.focus();
            n.close();
          };
          return 'sent';
        } catch (_) { return 'error'; }
      }

      function toast(m) {
        var t = document.getElementById('toast');
        if (!t) {
          t = document.createElement('div');
          t.id = 'toast';
          t.className = 'toast';
          document.body.appendChild(t);
        }
        t.textContent = m;
        t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('show'); }, 3500);
      }

      return { fireNotification: fireNotification, toast: toast, permission: permission };
    })();
  </script>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

// ---- 시작 ----
app.listen(PORT, () => {
  console.log(`[server] 새싹 레이더 실행 중 → http://localhost:${PORT}`);

  // 저장 위치 진단 — 재배포 후 설정이 초기화됐다면 여기서 바로 원인이 보인다.
  // settingsExists=false 가 매 배포마다 찍히면 볼륨이 안 붙은 것(= 저장값 유실).
  try {
    const st = storage.describeStorage();
    console.log(
      `[storage] DATA_DIR=${st.dataDir} · 쓰기가능=${st.writable} · ` +
        `settings.json=${st.settingsExists ? '기존 저장값 로드' : '없음 → 기본값으로 새로 생성'}`
    );
    if (!st.writable) {
      console.error('[storage] ⚠ 데이터 디렉터리에 쓸 수 없습니다 — 설정이 저장되지 않습니다.');
    }
    console.log('[storage] 감시 조건 교육대상:', (storage.getSettings().targets || []).join(', '));
  } catch (e) {
    console.error('[storage] 저장 위치 진단 실패:', e.message);
  }

  // 교육대상 분류 개편 이관(멱등) — 저장된 구 분류 라벨을 새 정식 라벨로 정규화
  try {
    migrate();
  } catch (e) {
    console.error('[server] 분류 이관 실패(계속 진행):', e.message);
  }
  // 이전 프로세스의 하트비트를 되읽는다 — 재배포 직후 '확인 전'으로 보이지 않게.
  loadHeartbeat();
  if (heartbeat.lastFinishAt) {
    console.log(
      `[heartbeat] 이전 기록 로드: 마지막 확인 ${heartbeat.lastFinishAt} ` +
        `(ok=${heartbeat.lastOk}, 워치독 재시작 누적 ${heartbeat.restarts || 0}회)`
    );
  }

  // 정기 수집 스케줄 시작(설정 간격 기준). 이후 매 주기는 '끝난 뒤' 스스로 재예약.
  scheduleNext();

  // 오픈 리마인더: 1분 간격 경량 체크 (사이트 요청 없음, 스케줄 도달 여부만 판정)
  setInterval(() => {
    checkReminders().catch((e) => console.error('[reminder] 예외:', e.message));
  }, 60000);
  console.log('[server] 오픈 리마인더 스케줄 등록 (1분 간격)');

  // 워치독: 수집 활동이 30분 넘게 끊기면 락을 풀고 루프를 되살린다.
  setInterval(() => {
    try {
      watchdogTick();
    } catch (e) {
      console.error('[watchdog] 점검 예외(무시):', e.message);
    }
  }, WATCHDOG_TICK_MS);
  console.log(
    `[server] 워치독 등록 (${WATCHDOG_TICK_MS / 60000}분 간격 점검 · ` +
      `${WATCHDOG_STALL_MS / 60000}분 정지 시 재시작)`
  );

  // Railway 절전 대비 자체 핑 (공개 URL 을 알 때만)
  startKeepAlive();

  // 서버 시작 30초 후 첫 수집 — 동일 락을 통과(예약 주기와 겹쳐도 하나만 실행).
  setTimeout(() => {
    console.log('[server] 첫 수집 시작 (시작 30초 후)');
    runCollectCycle('startup');
  }, 30000);
});
