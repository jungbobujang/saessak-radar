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
  fmtKstDateTime,
  ddayKst,
} = require('./watcher');

const app = express();
const PORT = process.env.PORT || 3000;

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

// ---- 정기 수집 스케줄러 (자기예약 방식 + 단일 실행 락) ----
// setInterval/cron 처럼 "고정 주기 발화"는 이전 수집이 안 끝났을 때 겹쳐서 chromium 을
// 다중 launch → spawn EAGAIN 을 유발한다. 그래서 ① isCollecting 락으로 중복 실행을 막고,
// ② 수집이 "끝난 뒤"에야 다음 주기를 setTimeout 으로 예약해 겹침을 원천 차단한다.
let currentInterval = null;  // 대시보드/요약 노출용(현재 적용 간격)
let isCollecting = false;    // 단일 실행 락 — 수집(scrape+fetchDetails) 1건만 진행
let nextTimer = null;        // 다음 주기 예약 타이머 핸들

// 모든 수집 진입점(정기·시작·수동)은 이 함수를 통과한다 → 락이 전역으로 걸린다.
// 어떤 경로로 끝나든(성공·에러·타임아웃) finally 에서 락을 반드시 해제 → 다음 주기 정상 진행.
async function runCollectCycle(reason) {
  if (isCollecting) {
    console.log(`[scheduler] 이전 수집이 아직 진행 중 — 이번 주기(${reason}) 건너뜀`);
    return { ok: false, skipped: true, error: '이미 수집이 진행 중입니다.' };
  }
  isCollecting = true;
  try {
    console.log(`[scheduler] 정기 수집 시작 (reason=${reason})`);
    return await checkOnce({ reason });
  } catch (e) {
    // launch 타임아웃 등 예외는 이 주기만 실패로 두고 삼킨다(다음 주기에 자동 재시도).
    console.error(`[scheduler] 수집 예외 (${reason}):`, e.message);
    return { ok: false, error: e.message };
  } finally {
    isCollecting = false;
  }
}

// 수집이 끝난 뒤 다음 주기를 예약. 매번 설정에서 간격을 다시 읽어 변경을 자동 반영한다.
function scheduleNext() {
  const s = storage.getSettings();
  const m = Math.max(1, parseInt(s.intervalMinutes, 10) || 10);
  currentInterval = m;
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = setTimeout(async () => {
    await runCollectCycle('cron');   // 락으로 보호 — 실행 중이면 즉시 스킵
    scheduleNext();                  // 끝난 뒤에야 다음 주기 예약 → 겹침 불가
  }, m * 60000);
  console.log(`[scheduler] 다음 정기 수집 예약: ${m}분 후`);
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
      const inner = `${badge}
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
  const rel = relativeTime(runtime.lastCheckAt, nowMs);
  const okText =
    runtime.lastCheckOk === null ? '대기 중' : runtime.lastCheckOk ? '감시 정상' : '수집 실패';
  const dotClass =
    runtime.lastCheckOk === false ? 'dot-bad' : runtime.lastCheckOk === null ? 'dot-wait' : 'dot-ok';
  const condChips = conditionChips(s);
  const planner = renderPlanner();

  // 섹션 자동 우선순위: 오픈일시 확인된 예정 프로그램이 1개 이상이면 플래너를 위로
  const recentSection = `
    <div class="card">
      <div class="row-between">
        <div class="card-title">최근 감지</div>
        <button id="checkBtn" class="btn btn-green btn-sm">지금 즉시 확인</button>
      </div>
      <div id="checkResult" class="muted small"></div>
      <div class="loglist">${logRows || '<div class="muted small">아직 감지된 항목이 없습니다.</div>'}</div>
    </div>`;
  const sections =
    planner.openReady >= 1 ? planner.html + recentSection : recentSection + planner.html;

  res.send(pageShell('새싹 레이더', `
    <div class="header">
      <div class="logo">🌱 새싹 레이더</div>
      <a class="navlink" href="/settings">⚙️ 설정</a>
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

    ${runtime.lastError ? `<div class="card err">마지막 오류: ${escapeHtml(runtime.lastError)}</div>` : ''}

    <script>
      const btn = document.getElementById('checkBtn');
      const out = document.getElementById('checkResult');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '수집 중…';
        out.textContent = '';
        try {
          const r = await fetch('/api/check-now', { method: 'POST' });
          const d = await r.json();
          if (d.ok) {
            out.textContent = '완료: 전체 ' + d.total + '건 / 일치 ' + d.matched + '건 / 알림 ' + d.notified + '건. 새로고침합니다…';
            setTimeout(() => location.reload(), 1200);
          } else {
            out.textContent = '수집 실패: ' + (d.error || '알 수 없음');
            btn.disabled = false;
            btn.textContent = '지금 즉시 확인';
          }
        } catch (e) {
          out.textContent = '요청 오류: ' + e.message;
          btn.disabled = false;
          btn.textContent = '지금 즉시 확인';
        }
      });

      // ---- 브라우저 알림: 클릭 시 상세페이지 새 탭 열기 ----
      // 권한이 granted 일 때만 발송한다. 자동으로 requestPermission 을 호출하지 않는다
      // (사용자 제스처 없는 요청은 크롬이 무시하므로 권한 버튼에서만 요청).
      function showBrowserNotification(opts) {
        if (!('Notification' in window)) return false;
        if (Notification.permission !== 'granted') return false;
        try {
          var n = new Notification(opts.title, { body: opts.body || '', icon: '/favicon.ico' });
          n.onclick = function (e) {
            e.preventDefault();
            if (opts.link) window.open(opts.link, '_blank', 'noopener');
            window.focus();
            n.close();
          };
          return true;
        } catch (_) { return false; }
      }

      // ---- 토스트 ----
      function toast(msg) {
        var t = document.getElementById('toast');
        if (!t) {
          t = document.createElement('div');
          t.id = 'toast';
          t.className = 'toast';
          document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('show'); }, 3500);
      }

      // ---- 브라우저 알림 권한(상태바 인라인) ----
      // permission 상태에 따라 상태바에 표시. requestPermission 은 "알림 켜기" 버튼 클릭에서만.
      function renderPermInline() {
        var el = document.getElementById('permInline');
        if (!el) return;
        if (!('Notification' in window)) { el.innerHTML = '<span class="perm-bad">알림 미지원</span>'; return; }
        var perm = Notification.permission;
        if (perm === 'granted') { el.innerHTML = '<span class="perm-ok">🔔 브라우저 알림 켜짐</span>'; return; }
        if (perm === 'denied') {
          el.innerHTML = '<span class="perm-bad" title="주소창 자물쇠 → 알림 → 허용으로 변경 후 새로고침">🔕 알림 차단됨 (자물쇠→알림→허용)</span>';
          return;
        }
        el.innerHTML = '<button id="permBtn" class="btn btn-amber btn-xs">🔔 알림 켜기</button>';
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
      <div class="logo">🌱 감시 조건 설정</div>
      <a class="navlink" href="/">← 대시보드</a>
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

    <div class="card">
      <div class="card-title">🔔 알림 리허설</div>
      <div class="muted small" style="margin-bottom:12px;">
        실제 알림 경로(브라우저 알림 + 텔레그램)를 그대로 사용해 테스트 알림 1건을 발송합니다.
        조건 일치 수·오늘 보낸 알림 카운트·감시 스냅샷(state)에는 반영되지 않습니다.
      </div>
      <button id="testBtn" class="btn btn-green">테스트 알림 보내기</button>
    </div>

    <script>
      const form = document.getElementById('settingsForm');
      const msg = document.getElementById('saveMsg');

      // ---- 공용: 브라우저 알림 + 토스트 ----
      function showBrowserNotification(opts) {
        if (!('Notification' in window)) return false;
        if (Notification.permission !== 'granted') return false;
        try {
          var n = new Notification(opts.title, { body: opts.body || '', icon: '/favicon.ico' });
          n.onclick = function (e) {
            e.preventDefault();
            if (opts.link) window.open(opts.link, '_blank', 'noopener');
            window.focus();
            n.close();
          };
          return true;
        } catch (_) { return false; }
      }
      function toast(m) {
        var t = document.getElementById('toast');
        if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
        t.textContent = m;
        t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('show'); }, 3500);
      }

      // ---- 알림 리허설 버튼 ----
      var testBtn = document.getElementById('testBtn');
      if (testBtn) {
        testBtn.addEventListener('click', async function () {
          testBtn.disabled = true;
          var orig = testBtn.textContent;
          testBtn.textContent = '발송 중…';
          try {
            var r = await fetch('/api/test-alert', { method: 'POST' });
            var d = await r.json();
            if (d.ok) {
              var c = d.card || {};
              var meta = [c.type, (c.regions || []).join(','), (c.levels || []).join(',')]
                .filter(Boolean).join(' · ');
              var label = (c.institution ? '[' + c.institution + '] ' : '') + (c.title || '');
              var browserOk = showBrowserNotification({
                title: '🔴 [모집 시작] ' + label,
                body: meta,
                link: c.link,
              });
              var tgText = d.telegram === 'sent' ? '텔레그램 O'
                : d.telegram === 'failed' ? '텔레그램 X(실패)'
                : '텔레그램 미설정';
              toast('발송됨: 브라우저 ' + (browserOk ? 'O' : 'X') + ' / ' + tgText);
            } else {
              toast('발송 실패: ' + (d.error || '알 수 없음'));
            }
          } catch (e) {
            toast('요청 오류: ' + e.message);
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = orig;
          }
        });
      }

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

// ---- 페이지: 비밀번호 입력 (로그인) ----
function authPage(next, failed) {
  const nextVal = safeNext(next);
  return pageShell('설정 로그인', `
    <div class="header">
      <div class="logo">🔒 설정 로그인</div>
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

app.post('/api/check-now', requireAuth, async (req, res) => {
  try {
    // 수동 확인도 동일 락을 통과 → 정기 수집과 겹쳐 chromium 이 중복 launch 되지 않음.
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
        ok: runtime.lastCheckOk === true,
        lastCheckedAt: runtime.lastCheckAt || null,
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

app.get('/health', (req, res) => res.send('ok'));

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

// 상대시각 "N분 전" (초 단위 제거)
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
};
function icon(name) {
  const paths = ICON_PATHS[name];
  if (!paths) return ''; // 폴백: 아이콘 없으면 텍스트만
  return `<svg class="ti ti-${name}" width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${paths}</svg>`;
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
      <div class="rail-label">뒤 오픈</div></div>`;
}

// 3단 게이지 + 우측 수치 텍스트 ("N정원 · 승인n · 대기k")
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
      <span class="g3-text">${c.cap}정원 · 승인${c.app} · 대기${c.pend}</span>
    </div>`;
}

// 교육대상 색칩 (B안 — 우리 학교 해당 대상만 강조, 나머지는 회색으로 누름)
//  · 정렬: 우리 학교 대상 먼저, 그 외는 뒤 (각 그룹 안에서는 원래 순서 유지)
//  · 최대 3개까지 노출 + 초과분은 회색 '외 N'.
//    단 우리 학교 대상이 3개를 넘더라도 그 칩들은 잘리지 않는다.
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
  const ordered = mine.concat(rest);
  const limit = Math.max(3, mine.length); // 우리 학교 대상은 잘리지 않게
  const shown = ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;

  const chips = shown.map(
    (i) =>
      `<span class="tchip ${i.mine ? i.cls : 'tc-other'}" title="${escapeHtml(i.full)}">${escapeHtml(
        i.label
      )}</span>`
  );
  if (hidden > 0) chips.push(`<span class="tchip tc-other">외 ${hidden}</span>`);
  return `<span class="tchips">${chips.join('')}</span>`;
}

// 카드 1행: [업체명] 프로그램명 + 우측 chevron
function cardHead(x) {
  const inst = String(x.institution || '').trim();
  return `<div class="pi-head">
      ${inst ? `<span class="pi-inst">[${escapeHtml(inst)}]</span>` : ''}
      <span class="pi-name">${escapeHtml(x.title || '')}</span>
      <span class="pi-go" aria-hidden="true">${icon('chevron-right')}</span>
    </div>`;
}

// ---- 신청 플래너 → { html, openReady } (openReady: 오픈일시 확인된 예정 프로그램 수) ----
function renderPlanner() {
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
      return `<a class="planrow" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        ${railDdayHtml(dd)}
        <div class="pi-body">
          ${cardHead(x)}
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
      return `<a class="planrow ${c && c.full ? 'planrow-dim' : ''}" href="${escapeHtml(
        x.link || '#'
      )}" target="_blank" rel="noopener">
        ${railHtml(c)}
        <div class="pi-body">
          ${cardHead(x)}
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
    /* 정원 게이지 — 진초록=승인 · 연초록=대기 · 빨강=실질 잔여 0 */
    --gauge-ok:#1D9E75; --gauge-app:#1D9E75; --gauge-pend:#9FE1CB; --gauge-full:#E24B4A;
    /* 좌측 잔여 레일 (여유 / 임박 / 마감·대기만 / D-day) */
    --rail-ok-bg:#E1F5EE;   --rail-ok-fg:#085041;
    --rail-soon-bg:#FAEEDA; --rail-soon-fg:#633806;
    --rail-full-bg:#FCEBEB; --rail-full-fg:#791F1F;
    --rail-dday-bg:#EAF1FF; --rail-dday-fg:#2A52BE;
    /* 교육대상 진한 색칩 (우리 학교 대상) — 라이트 기준 */
    --tc-general-bg:#E6F1FB; --tc-general-fg:#0C447C;
    --tc-migrant-bg:#EEEDFE; --tc-migrant-fg:#26215C;
    --tc-welfare-bg:#E1F5EE; --tc-welfare-fg:#085041;
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
      --gauge-pend:#3E7C68;
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    line-height:1.5; }
  .wrap { max-width: 780px; margin:0 auto; padding: 18px 16px 60px; }
  .header { display:flex; align-items:center; justify-content:space-between; margin: 8px 0 18px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing:-0.02em; }
  .navlink { color:var(--green-d); text-decoration:none; font-weight:600; font-size:14px;
    background:var(--surface-2); padding:8px 12px; border-radius:10px; border:1px solid var(--line); }
  .navlink:hover { background:var(--surface-1); }
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
  .btn-lg { padding:12px 26px; font-size:15px; }
  .btn-sm { padding:7px 12px; font-size:13px; }
  .btn-xs { padding:3px 10px; font-size:12px; border-radius:8px; }
  .badge-reminder { background:#eaf1ff; color:#2a52be; }
  .opts { display:flex; flex-wrap:wrap; gap:9px; }
  .opt { display:inline-flex; align-items:center; gap:7px; background:var(--surface-1); border:1px solid var(--line);
    padding:9px 13px; border-radius:11px; cursor:pointer; font-size:14px; user-select:none; }
  .opt.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); font-weight:600; }
  .opt input { accent-color: var(--green); width:16px; height:16px; }
  .interval { display:flex; align-items:center; gap:10px; }
  .interval input { width:90px; padding:9px 12px; border:1px solid var(--line); border-radius:10px; font-size:15px; }
  /* 입력창도 표면 토큰을 따라가야 다크에서 흰 배경 + 흰 글자가 되지 않는다 */
  input[type="text"], input[type="number"], input[type="password"] {
    background:var(--surface-2); color:var(--ink); }
  .actions { display:flex; align-items:center; gap:14px; margin: 6px 0 20px; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .err { background:#fdeaea; color:#a33; border-color:#f3caca; }
  @media (max-width:560px){
    .grid { grid-template-columns: 1fr; }
    .stat-num { font-size:26px; }
  }
</style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

// ---- 시작 ----
app.listen(PORT, () => {
  console.log(`[server] 새싹 레이더 실행 중 → http://localhost:${PORT}`);
  // 교육대상 분류 개편 이관(멱등) — 저장된 구 분류 라벨을 새 정식 라벨로 정규화
  try {
    migrate();
  } catch (e) {
    console.error('[server] 분류 이관 실패(계속 진행):', e.message);
  }
  // 정기 수집 스케줄 시작(설정 간격 기준). 이후 매 주기는 '끝난 뒤' 스스로 재예약.
  scheduleNext();

  // 오픈 리마인더: 1분 간격 경량 체크 (사이트 요청 없음, 스케줄 도달 여부만 판정)
  setInterval(() => {
    checkReminders().catch((e) => console.error('[reminder] 예외:', e.message));
  }, 60000);
  console.log('[server] 오픈 리마인더 스케줄 등록 (1분 간격)');

  // 서버 시작 30초 후 첫 수집 — 동일 락을 통과(예약 주기와 겹쳐도 하나만 실행).
  setTimeout(() => {
    console.log('[server] 첫 수집 시작 (시작 30초 후)');
    runCollectCycle('startup');
  }, 30000);
});
