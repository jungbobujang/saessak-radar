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

// ---- 정원 표시 (잔여 중심) ----
// 목록 API 값(state)이 가장 최신이고, 없으면 상세(detail) 값으로 보완한다.
//   cap=정원(모집 학급) · app=승인 · pend=대기
// 반환: { text, cls } · 정원 자체가 미공개면 null (표시 생략)
function capacityLabel(x, opts = {}) {
  const d = x.detail || {};
  const pick = (a, b) => (a != null ? a : b != null ? b : null);
  const cap = pick(x.capacityClasses, d.capacityClasses);
  const app = pick(x.approvedClasses, d.approvedClasses);
  const pend = pick(x.pendingClasses, d.pendingClasses);

  if (cap == null || cap <= 0) return null; // 정원 미공개 → 표시 생략
  const wait = pend != null && pend > 0 ? ` (대기 ${pend})` : '';

  // 승인 수치가 아직 없으면 정원만 담백하게
  if (app == null) return { text: `정원 ${cap}학급${wait}`, cls: 'cap-plain' };
  // 오픈 예정: 대개 승인 0 → 잔여를 강조할 게 아니라 정원만
  if (opts.preOpen && app === 0) return { text: `정원 ${cap}학급 (오픈 전)${wait}`, cls: 'cap-plain' };

  const rem = Math.max(0, cap - app);
  if (rem === 0) return { text: `마감 임박 · 대기만 가능${wait}`, cls: 'cap-full' };
  return { text: `${cap}학급 중 ${rem}개 남음${wait}`, cls: 'cap-remain' };
}

// 교육대상 요약 (상세의 신청대상 우선, 없으면 목록 태그). 최대 3개 + '외 N'.
// 같은 값을 텍스트와 #해시태그로 두 번 찍지 않기 위해 이 한 곳에서만 만든다.
function targetSummary(x) {
  const names =
    x.detail && x.detail.targetNames && x.detail.targetNames.length
      ? x.detail.targetNames
      : x.tags || [];
  return classify.summarize(names, 3);
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

  // 그룹 B: 잔여(정원-승인) 많은 순
  const remain = (x) => (x.capacityClasses || 0) - (x.approvedClasses || 0);
  live.sort((a, b) => remain(b) - remain(a));

  const openRows = open
    .map((x) => {
      const start = x.detail && x.detail.applyStartAt;
      const when = start ? fmtKstDateTime(start) : '';
      const dd = start ? ddayKst(start, nowMs) : null;
      const ddChip =
        dd == null
          ? ''
          : dd <= 0
          ? '<span class="dchip dchip-now">D-DAY</span>'
          : `<span class="dchip">D-${dd}</span>`;
      const whenHtml = when
        ? `<span class="plan-when">${escapeHtml(when)}</span> ${ddChip}`
        : '<span class="badge badge-unknown">일시 미공지</span>';
      const chapters =
        x.detail && x.detail.totalChapters != null ? x.detail.totalChapters + '차시' : '';
      // 교육대상은 한 번만 (텍스트형). #해시태그 중복 표기는 제거했다.
      const targets = targetSummary(x);
      const capInfo = capacityLabel(x, { preOpen: true });
      const metaHtml = [
        chapters ? escapeHtml(chapters) : '',
        capInfo ? `<span class="${capInfo.cls}">${escapeHtml(capInfo.text)}</span>` : '',
        targets ? escapeHtml(targets) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<a class="planrow" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        <div class="plan-main">
          <div class="plan-open">${whenHtml}</div>
          <div class="plan-title">${escapeHtml(instLabel(x.institution, x.title))}</div>
          ${metaHtml ? `<div class="plan-meta">${metaHtml}</div>` : ''}
        </div>
        <span class="plan-go">상세 ↗</span>
      </a>`;
    })
    .join('');

  const liveRows = live
    .map((x) => {
      const cap = x.capacityClasses || 0;
      const app = x.approvedClasses || 0;
      const rem = Math.max(0, cap - app);
      const pct = cap > 0 ? Math.min(100, Math.round((app / cap) * 100)) : 0;
      // 잔여 문구는 배지 하나로만 (게이지 + 배지 + "승인 n/m" 3중 표기 제거)
      const capInfo = capacityLabel(x);
      const capBadge = capInfo
        ? `<span class="badge ${capInfo.cls === 'cap-full' ? 'badge-full' : 'badge-remain'}">${escapeHtml(
            capInfo.text
          )}</span>`
        : '';
      const end = x.detail && x.detail.applyEndAt ? fmtKstDateTime(x.detail.applyEndAt) : '';
      // 교육대상은 한 번만 (텍스트형). #해시태그 중복 표기는 제거했다.
      const targets = targetSummary(x);
      const meta = [end ? '마감 ' + end : '', targets].filter(Boolean).join(' · ');
      return `<a class="planrow" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        <div class="plan-main">
          <div class="plan-title">${escapeHtml(instLabel(x.institution, x.title))} ${capBadge}</div>
          ${cap > 0 ? `<div class="gauge"><div class="gauge-fill ${rem === 0 ? 'gauge-full' : ''}" style="width:${pct}%"></div></div>` : ''}
          ${meta ? `<div class="plan-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
        <span class="plan-go">상세 ↗</span>
      </a>`;
    })
    .join('');

  const changeLogs = storage.getLog().filter((l) => l.kind === 'change').slice(0, 5);
  const changeRows = changeLogs
    .map(
      (l) => `<div class="planrow planrow-static">
        <div class="plan-main">
          <div class="plan-title"><span class="badge badge-change">정보 변경</span> ${escapeHtml(instLabel(l.institution, l.title))}</div>
          <div class="plan-meta">${escapeHtml(l.changes || '')}</div>
        </div>
      </div>`
    )
    .join('');

  const html = `
    <div class="card planner">
      <div class="card-title">🗂️ 신청 플래너</div>
      <div class="plan-group">
        <div class="plan-group-title">🕐 신청 오픈 예정 <span class="muted small">${open.length}</span></div>
        ${openRows || '<div class="muted small">예정된 프로그램이 없습니다.</div>'}
      </div>
      <div class="plan-group">
        <div class="plan-group-title">🔥 지금 신청 가능 <span class="muted small">${live.length}</span></div>
        ${liveRows || '<div class="muted small">신청 가능한 프로그램이 없습니다.</div>'}
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
  :root { --green:#22a95f; --green-d:#178a4c; --bg:#f6f9f6; --ink:#1c2a22; --muted:#8a988f; --line:#e6ede8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    line-height:1.5; }
  .wrap { max-width: 780px; margin:0 auto; padding: 18px 16px 60px; }
  .header { display:flex; align-items:center; justify-content:space-between; margin: 8px 0 18px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing:-0.02em; }
  .navlink { color:var(--green-d); text-decoration:none; font-weight:600; font-size:14px;
    background:#fff; padding:8px 12px; border-radius:10px; border:1px solid var(--line); }
  .navlink:hover { background:#f0f7f2; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:14px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin-bottom:10px; }
  .card-title { font-weight:700; font-size:15px; margin-bottom:9px; }
  /* v3 상태바 */
  .statusbar { display:flex; align-items:center; flex-wrap:wrap; gap:7px; background:#fff;
    border:1px solid var(--line); border-radius:12px; padding:10px 14px; margin-bottom:8px;
    font-size:13px; color:#405046; }
  .sdot { width:9px; height:9px; border-radius:50%; flex:none; }
  .dot-ok { background:var(--green); box-shadow:0 0 0 3px #d9f0e2; }
  .dot-bad { background:#d9534f; box-shadow:0 0 0 3px #f7d9d8; }
  .dot-wait { background:#c9a227; box-shadow:0 0 0 3px #f5ecc9; }
  .sb-main { font-weight:800; color:var(--ink); }
  .sb-sep { color:#cdd6d0; }
  .sb-perm { display:inline-flex; align-items:center; }
  .perm-ok { color:var(--green-d); font-weight:700; }
  .perm-bad { color:#d9534f; font-weight:700; cursor:help; }
  .condbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    padding:2px 4px 0; margin-bottom:14px; }
  .condlabel { font-size:11px; color:#8a978d; font-weight:600; margin-right:2px; }
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
  .logrow-link:hover { background:#eef7f1; }
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
  .plan-group-title { font-size:13px; font-weight:800; color:#3a4a41; margin-bottom:8px; }
  .planrow { display:flex; align-items:center; gap:12px; padding:11px 12px; margin:0 -12px;
    border-radius:11px; text-decoration:none; color:inherit; transition:background .12s; }
  .planrow:hover { background:#eef7f1; }
  .planrow-static, .planrow-static:hover { background:transparent; cursor:default; }
  .plan-main { flex:1; min-width:0; }
  .plan-title { font-size:13px; font-weight:700; margin-top:2px; word-break:break-word; }
  .plan-open { margin-top:3px; display:flex; align-items:center; gap:8px; }
  .plan-when { font-size:15px; font-weight:800; letter-spacing:-0.01em; color:var(--ink); }
  .plan-meta { margin-top:3px; color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .plan-go { color:var(--green-d); font-size:12px; font-weight:700; white-space:nowrap; opacity:.35; transition:opacity .12s; }
  .planrow:hover .plan-go { opacity:1; }
  .dchip { background:#eaf1ff; color:#2a52be; border:1px solid #d3e0fb; padding:2px 9px; border-radius:999px;
    font-size:12px; font-weight:800; white-space:nowrap; }
  .dchip-now { background:#ffecec; color:#d9534f; border-color:#f6cccc; }
  .gauge { margin-top:6px; height:8px; background:#eef2ef; border-radius:999px; overflow:hidden; max-width:280px; }
  .gauge-fill { height:100%; background:var(--green); border-radius:999px; }
  .gauge-fill.gauge-full { background:#d9534f; }
  .badge-change { background:#f0e9fb; color:#7c3aed; }
  .badge-unknown { background:#eef0f2; color:#7a848c; }
  .badge-remain { background:#eaf6ef; color:var(--green-d); }
  .badge-full { background:#fdeaea; color:#d9534f; }
  /* 정원 표시(잔여 중심) — 마감 임박만 빨강, 나머지는 기본 색 */
  .cap-full { color:#d9534f; font-weight:700; }
  .cap-remain { color:inherit; font-weight:600; }
  .cap-plain { color:inherit; }
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
  .opt { display:inline-flex; align-items:center; gap:7px; background:#f4f8f5; border:1px solid var(--line);
    padding:9px 13px; border-radius:11px; cursor:pointer; font-size:14px; user-select:none; }
  .opt.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); font-weight:600; }
  .opt input { accent-color: var(--green); width:16px; height:16px; }
  .interval { display:flex; align-items:center; gap:10px; }
  .interval input { width:90px; padding:9px 12px; border:1px solid var(--line); border-radius:10px; font-size:15px; }
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
