'use strict';
// fix/stability-3 검증 러너.
//   1) 텔레그램 선택 기능 (NOTIFY_TELEGRAM)
//   2) 켜졌을 때의 안전장치 (10초 상한 · 429 재시도 · 사이클 60초 예산)
//   3) 알림 실패가 failStreak 를 올리지 않는가
//   4) '새 소식' 목록 (200건 상한 · 읽음 처리 · 필터/검색)
//   5) 프로세스 보호 (unhandledRejection 생존 · SIGTERM exit 0)
//   6) 고아 크로뮴 (close 타임아웃 → 장부 유지 → SIGKILL)
//
// 실사이트·실텔레그램을 부르지 않는다. 가짜 HTTP 서버와 가짜 browser 객체만 쓴다.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = path.join(os.tmpdir(), 'saessak-stability3');
fs.mkdirSync(ROOT, { recursive: true });

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}

function freshDir(name) {
  const d = path.join(ROOT, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 모듈 캐시를 비우고 DATA_DIR 을 바꿔 다시 불러온다 (storage 가 로드 시점에 경로를 잡는다).
// patchScraper 는 watcher 가 로드되기 '전에' 불린다.
// watcher.js 가 `const { scrape } = require('./scraper')` 로 참조를 집어가므로,
// watcher 를 먼저 불러 버리면 나중에 scraper.scrape 를 갈아끼워도 소용이 없다
// (그러면 테스트가 실사이트를 때린다 — .oomfix/harness.js 가 같은 순서를 지키는 이유다).
function loadFresh(dataDir, env = {}, patchScraper) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(REPO, 'src'))) delete require.cache[k];
  }
  process.env.DATA_DIR = dataDir;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  const scraper = require(path.join(REPO, 'src', 'scraper.js'));
  if (patchScraper) patchScraper(scraper);
  return {
    scraper,
    watcher: require(path.join(REPO, 'src', 'watcher.js')),
    storage: require(path.join(REPO, 'src', 'storage.js')),
  };
}

// ---- 가짜 텔레그램 서버 ----------------------------------------------------
// mode: 'ok' | 'hang'(응답 안 함) | '429'(1회만 429 후 ok)
function fakeTelegram(mode) {
  let hits = 0;
  let sent429 = false;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (mode === 'hang') return; // 응답을 영영 보내지 않는다
    if (mode === '429' && !sent429) {
      sent429 = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, hits: () => hits });
    });
  });
}

// watcher 는 api.telegram.org 로 보낸다. global.fetch 를 갈아끼워 가짜 서버로 돌린다.
function redirectFetch(port, counter) {
  const real = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      if (counter) counter.calls += 1;
      return real(u.replace('https://api.telegram.org', `http://127.0.0.1:${port}`), opts);
    }
    return real(url, opts);
  };
  return () => { global.fetch = real; };
}

(async () => {
  // ===================================================================== 1
  console.log('\n--- 1. 텔레그램 선택 기능 (NOTIFY_TELEGRAM) ---');
  {
    const d = freshDir('t1-off');
    const { watcher } = loadFresh(d, {
      NOTIFY_TELEGRAM: null,
      TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
      TELEGRAM_CHAT_ID: '99999',
    });
    const counter = { calls: 0 };
    const real = global.fetch;
    global.fetch = (url, opts) => {
      if (String(url).includes('api.telegram.org')) counter.calls += 1;
      return real(url, opts);
    };
    const r = await watcher.sendTelegram('<b>test</b>');
    global.fetch = real;
    check('NOTIFY_TELEGRAM 없으면 false 를 돌려준다', r === false, `r=${r}`);
    check('NOTIFY_TELEGRAM 없으면 fetch 를 한 번도 안 부른다', counter.calls === 0, `호출 ${counter.calls}회`);
    check('isTelegramConfigured() 도 false', watcher.isTelegramConfigured() === false);
  }
  {
    const d = freshDir('t1-on-notoken');
    const { watcher } = loadFresh(d, {
      NOTIFY_TELEGRAM: '1',
      TELEGRAM_BOT_TOKEN: null,
      TELEGRAM_CHAT_ID: null,
    });
    const counter = { calls: 0 };
    const real = global.fetch;
    global.fetch = (url, opts) => {
      if (String(url).includes('api.telegram.org')) counter.calls += 1;
      return real(url, opts);
    };
    const r = await watcher.sendTelegram('x');
    global.fetch = real;
    check('켜졌어도 토큰이 없으면 네트워크를 안 부른다', r === false && counter.calls === 0);
  }

  // ===================================================================== 2
  console.log('\n--- 2. 켜졌을 때의 안전장치 ---');
  {
    const d = freshDir('t2-hang');
    const { watcher } = loadFresh(d, {
      NOTIFY_TELEGRAM: '1',
      TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
      TELEGRAM_CHAT_ID: '99999',
      TELEGRAM_SEND_TIMEOUT_MS: '10000',
    });
    const fake = await fakeTelegram('hang');
    const restore = redirectFetch(fake.port);
    const t0 = Date.now();
    const r = await watcher.sendTelegram('응답 없는 서버');
    const ms = Date.now() - t0;
    restore();
    fake.server.close();
    check('응답 없는 서버 → false 를 돌려준다', r === false, `r=${r}`);
    check('10초 언저리에 끊는다 (9~13초)', ms >= 9000 && ms <= 13000, `${ms}ms`);
  }
  {
    const d = freshDir('t2-429');
    const { watcher } = loadFresh(d, {
      NOTIFY_TELEGRAM: '1',
      TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
      TELEGRAM_CHAT_ID: '99999',
    });
    const fake = await fakeTelegram('429');
    const restore = redirectFetch(fake.port);
    const t0 = Date.now();
    const r = await watcher.sendTelegram('429 테스트');
    const ms = Date.now() - t0;
    restore();
    fake.server.close();
    check('429 + retry_after 2 → 1회 재시도 후 성공', r === true, `r=${r}`);
    check('재시도를 정말 기다렸다 (2초 이상)', ms >= 1900, `${ms}ms`);
    check('요청은 두 번만 갔다', fake.hits() === 2, `${fake.hits()}회`);
  }
  {
    // 사이클 60초 예산: 예산을 아주 작게 줄여 빠르게 검증한다.
    const d = freshDir('t2-budget');
    const { watcher, storage } = loadFresh(d, {
      NOTIFY_TELEGRAM: '1',
      TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
      TELEGRAM_CHAT_ID: '99999',
      TELEGRAM_SEND_TIMEOUT_MS: '1000',
      TELEGRAM_CYCLE_BUDGET_MS: '2000',
    });
    const fake = await fakeTelegram('hang'); // 매 건 1초씩 태운다
    const restore = redirectFetch(fake.port);
    watcher.beginTelegramCycle();
    let deferred = 0;
    let sent = 0;
    for (let i = 0; i < 30; i++) {
      const r = await watcher.sendBudgeted('n' + i, '알림 ' + i, { link: 'https://x/' + i });
      if (r.deferred) deferred += 1;
      if (r.sent) sent += 1;
    }
    restore();
    fake.server.close();
    const box = storage.getOutbox();
    check('예산(2초)을 넘기면 나머지는 이월된다', deferred > 0, `이월 ${deferred}건 · 발송 ${sent}건`);
    check('30건 전부를 태우지 않았다 (예산이 실제로 끊었다)', deferred >= 20, `이월 ${deferred}건`);
    check('이월 큐가 파일에 남았다', box.items.length === deferred, `큐 ${box.items.length}건`);
    // 중복 제거
    watcher.beginTelegramCycle();
    await watcher.sendBudgeted('n0', '알림 0 다시', { link: 'https://x/0' });
    const box2 = storage.getOutbox();
    const n0count = box2.items.filter((x) => x.key === 'n0').length;
    check('같은 key 는 이월 큐에 두 번 안 들어간다', n0count <= 1, `n0 ${n0count}건`);
  }
  {
    // 재기동(프로세스 재시작) 뒤에도 이월분이 남아 있고, 다음 사이클에 발송되는지
    const d = freshDir('t2-flush');
    let { watcher, storage } = loadFresh(d, {
      NOTIFY_TELEGRAM: '1',
      TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
      TELEGRAM_CHAT_ID: '99999',
      TELEGRAM_CYCLE_BUDGET_MS: '60000',
      TELEGRAM_SEND_TIMEOUT_MS: '5000',
    });
    storage.saveOutbox({
      items: [
        { key: 'a', html: 'A', link: '', at: new Date().toISOString(), tries: 0 },
        { key: 'b', html: 'B', link: '', at: new Date().toISOString(), tries: 0 },
      ],
      deferredTotal: 2, sentTotal: 0, droppedTotal: 0,
    });
    // 모듈을 통째로 다시 불러온다 = 프로세스가 재기동된 상황
    ({ watcher, storage } = loadFresh(d, {}));
    const before = storage.getOutbox().items.length;
    const fake = await fakeTelegram('ok');
    const restore = redirectFetch(fake.port);
    watcher.beginTelegramCycle();
    const f = await watcher.flushOutbox();
    restore();
    fake.server.close();
    const after = storage.getOutbox();
    check('재기동 뒤에도 이월분이 남아 있다', before === 2, `${before}건`);
    check('다음 사이클이 이월분을 보낸다', f.sent === 2, `보낸 ${f.sent}건`);
    check('보낸 것은 큐에서 빠진다 (중복 0)', after.items.length === 0, `남은 ${after.items.length}건`);
  }
  {
    const d = freshDir('t2-scrub');
    const { watcher } = loadFresh(d, { TELEGRAM_BOT_TOKEN: '123456:SECRET-TOKEN-VALUE' });
    const s = watcher.scrubToken('요청 실패 https://api.telegram.org/bot123456:SECRET-TOKEN-VALUE/sendMessage');
    check('로그에 토큰이 남지 않는다', !s.includes('SECRET-TOKEN-VALUE'), s.slice(0, 60));
  }

  // ===================================================================== 3
  console.log('\n--- 3. 알림 실패가 수집 실패(failStreak)로 세지지 않는가 ---');
  {
    const d = freshDir('t3');
    // 수집은 성공하고 알림만 전부 실패하는 상황을 만든다.
    // (실사이트를 부르지 않도록 watcher 로드 전에 갈아끼운다)
    const { watcher, storage } = loadFresh(
      d,
      {
        NOTIFY_TELEGRAM: '1',
        TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
        TELEGRAM_CHAT_ID: '99999',
        TELEGRAM_SEND_TIMEOUT_MS: '600',
        TELEGRAM_CYCLE_BUDGET_MS: '1200',
      },
      (scraper) => {
        scraper.scrape = async () => ([
          { id: 'p_1', programId: 1, title: '테스트 프로그램', status: '모집 중', type: '방문형',
            regions: ['경기권'], levels: ['초등학교'], tags: [], institution: '테스트기관',
            link: 'https://example.invalid/1', capacityClasses: 1, approvedClasses: 0, pendingClasses: 0 },
        ]);
        scraper.fetchDetails = async () => ({});
      }
    );
    const s = storage.getSettings();
    s.regions = []; s.levels = []; s.types = []; s.targets = [];
    s.notifyStart = true; s.notifyNew = true;
    storage.saveSettings(s);

    const fake = await fakeTelegram('hang');
    const restore = redirectFetch(fake.port);
    const r = await watcher.checkOnce({ reason: 'test' });
    restore();
    fake.server.close();
    check('알림이 전부 실패해도 사이클은 ok:true', r.ok === true, JSON.stringify(r));
    check('수집 건수는 정상 보고된다', r.total === 1, `total=${r.total}`);
  }

  // ===================================================================== 4
  console.log('\n--- 4. 새 소식 목록 ---');
  {
    const d = freshDir('t4');
    const { storage } = loadFresh(d, {});
    // 과거 시각으로 쌓는다 — 미래 시각이면 '모두 읽음' 기준선보다 뒤라 영원히 안 읽음이 된다.
    const base = Date.now() - 250 * 1000;
    for (let i = 0; i < 250; i++) {
      storage.appendLog({
        at: new Date(base + i * 1000).toISOString(),
        kind: i % 2 ? 'start' : 'new',
        title: '프로그램 ' + i,
        institution: i % 3 ? '가기관' : '나기관',
        status: '모집 중', link: 'https://example.invalid/' + i, sent: false, delivery: 'off', id: 'p_' + i,
      });
    }
    const log = storage.getLog();
    check('로그는 최근 200건만 유지한다', log.length === 200, `${log.length}건`);
    check('가장 최근 것이 맨 앞이다', log[0].title === '프로그램 249', log[0].title);

    const readAt = storage.setNotificationsReadAt(new Date().toISOString());
    check('읽음 시각이 저장된다', !!readAt && storage.getNotificationsReadAt() === readAt);
    const unreadAfter = storage.getLog().filter((l) => l.at > readAt).length;
    check('모두 읽음 뒤 안 읽은 수가 0 이 된다', unreadAfter === 0, `안 읽음 ${unreadAfter}건`);

    // 읽음 뒤에 새 소식이 들어오면 다시 1건이 된다
    storage.appendLog({
      at: new Date(Date.now() + 1000).toISOString(),
      kind: 'start', title: '읽은 뒤 새로 온 것', institution: '', status: '모집 중',
      link: '', sent: false, delivery: 'off', id: 'p_new',
    });
    const unreadNew = storage.getLog().filter((l) => l.at > readAt).length;
    check('읽음 뒤 새로 온 것은 다시 안 읽음으로 잡힌다', unreadNew === 1, `안 읽음 ${unreadNew}건`);
  }

  // ===================================================================== 6
  console.log('\n--- 6. 고아 크로뮴 ---');
  {
    const d = freshDir('t6');
    const { scraper } = loadFresh(d, {});
    let killed = false;
    // close() 가 영영 안 끝나는 가짜 browser. closeQuietly 의 15초 상한에 걸린다.
    const stuck = {
      close: () => new Promise(() => {}),
      process: () => ({ kill: (sig) => { killed = sig === 'SIGKILL'; } }),
    };
    scraper.liveBrowsers.add(stuck);
    const t0 = Date.now();
    const n1 = await scraper.closeAllBrowsers('테스트 1회차');
    check('닫기 실패 시 정리 개수에 안 센다', n1 === 0, `cleaned=${n1}`);
    check('닫기 실패한 브라우저는 장부에 남는다', scraper.liveBrowserCount() === 1,
      `장부 ${scraper.liveBrowserCount()}개`);
    check('close 상한(15초)이 실제로 걸렸다', Date.now() - t0 >= 14000, `${Date.now() - t0}ms`);

    const n2 = await scraper.closeAllBrowsers('테스트 2회차');
    check('두 번째 실패에서 SIGKILL 을 쓴다', killed === true);
    check('SIGKILL 후 장부에서 빠진다', scraper.liveBrowserCount() === 0 && n2 === 1,
      `장부 ${scraper.liveBrowserCount()}개 cleaned=${n2}`);
  }

  // ===================================================================== 5
  console.log('\n--- 5. 프로세스 보호 (자식 프로세스로 검증) ---');
  {
    const d = freshDir('t5-unhandled');
    const script = path.join(ROOT, 'unhandled-probe.js');
    fs.writeFileSync(
      script,
      `process.env.DATA_DIR = ${JSON.stringify(d)};\n` +
        `process.env.PORT = '3987';\n` +
        `process.env.NOTIFY_TELEGRAM = '';\n` +
        `const s = require(${JSON.stringify(path.join(REPO, 'src', 'scraper.js'))});\n` +
        `s.scrape = async () => { throw new Error('probe'); };\n` +
        `s.fetchDetails = async () => ({});\n` +
        `require(${JSON.stringify(path.join(REPO, 'src', 'server.js'))});\n` +
        `setTimeout(() => { Promise.reject(new Error('일부러 터뜨린 거절')); }, 1200);\n` +
        `setTimeout(() => { console.log('ALIVE-AFTER-UNHANDLED'); process.exit(0); }, 3500);\n`,
      'utf8'
    );
    const r = await new Promise((resolve) => {
      const out = [];
      const c = spawn(process.execPath, [script], { cwd: REPO, env: { ...process.env } });
      c.stdout.on('data', (b) => out.push(String(b)));
      c.stderr.on('data', (b) => out.push(String(b)));
      const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: null, out: out.join('') }); }, 12000);
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: out.join('') }); });
    });
    check('unhandledRejection 을 던져도 프로세스가 산다',
      r.out.includes('ALIVE-AFTER-UNHANDLED') && r.code === 0, `code=${r.code}`);
    check('거절 내용이 로그에 남는다', r.out.includes('[unhandled]'),
      r.out.includes('[unhandled]') ? '' : '로그 없음');
  }
  {
    const d = freshDir('t5-sigterm');
    const script = path.join(ROOT, 'sigterm-probe.js');
    // Windows 에서는 child.kill('SIGTERM') 이 잡을 수 있는 신호로 배달되지 않고
    // 프로세스를 그냥 끝낸다(Node 의 알려진 플랫폼 차이). 그래서 자식이 스스로
    // process.emit('SIGTERM') 을 쏴서 '핸들러가 무엇을 하는가' 를 검증한다.
    // 리눅스(운영 환경)에서는 진짜 신호가 같은 핸들러로 들어온다.
    fs.writeFileSync(
      script,
      `process.env.DATA_DIR = ${JSON.stringify(d)};\n` +
        `process.env.PORT = '3988';\n` +
        `process.env.NOTIFY_TELEGRAM = '';\n` +
        `const s = require(${JSON.stringify(path.join(REPO, 'src', 'scraper.js'))});\n` +
        `s.scrape = async () => { throw new Error('probe'); };\n` +
        `s.fetchDetails = async () => ({});\n` +
        `require(${JSON.stringify(path.join(REPO, 'src', 'server.js'))});\n` +
        `console.log('READY');\n` +
        `setTimeout(() => { console.log('SIGNAL-AT:' + Date.now()); process.emit('SIGTERM'); }, 900);\n`,
      'utf8'
    );
    const r = await new Promise((resolve) => {
      const out = [];
      const c = spawn(process.execPath, [script], { cwd: REPO, env: { ...process.env } });
      c.stdout.on('data', (b) => out.push(String(b)));
      c.stderr.on('data', (b) => out.push(String(b)));
      const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: null, out: out.join(''), exitAt: 0 }); }, 40000);
      c.on('exit', (code) => {
        clearTimeout(t);
        resolve({ code, out: out.join(''), exitAt: Date.now() });
      });
    });
    const m = /SIGNAL-AT:(\d+)/.exec(r.out);
    const ms = m && r.exitAt ? r.exitAt - Number(m[1]) : -1;
    check('SIGTERM → exit 0 으로 정상 종료', r.code === 0, `code=${r.code}`);
    check('20초 안에 끝난다', ms >= 0 && ms <= 21000, `${ms}ms`);
    check('정리 로그가 남는다', r.out.includes('[shutdown]'), r.out.includes('[shutdown]') ? '' : '로그 없음');
    check('새 사이클을 막는다는 로그 또는 정상 종료 로그', r.out.includes('정상 종료합니다'),
      r.out.includes('정상 종료합니다') ? '' : '종료 로그 없음');
  }

  // ---- 정리 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 결과: ${results.length - failed.length}/${results.length} 통과 =====`);
  if (failed.length) {
    console.log('실패 항목:');
    for (const f of failed) console.log(` - ${f.label} (${f.detail || ''})`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('러너 자체 예외:', e);
  process.exit(1);
});
