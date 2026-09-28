// 3종 방어 로컬 검증 러너. 시나리오마다 하네스를 자식 프로세스로 띄우고
// 종료 코드·텔레그램 발신·heartbeat.json 을 확인한다.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HARNESS = path.join(__dirname, 'harness.js');
// 검증 산출물(가짜 DATA_DIR·로그)은 저장소 밖에 둔다.
const ROOT = path.join(os.tmpdir(), 'saessak-oomfix-verify');
fs.mkdirSync(ROOT, { recursive: true });

function kstNow() {
  const d = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false })
      .formatToParts(d)
      .find((x) => x.type === 'hour').value,
    10
  ) % 24;
  return { ymd, hour };
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function seed(dataDir, { heartbeat, settings }) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (heartbeat) {
    fs.writeFileSync(path.join(dataDir, 'heartbeat.json'), JSON.stringify(heartbeat, null, 2), 'utf8');
  }
  if (settings) {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  }
}

function telegrams(dataDir) {
  const f = path.join(dataDir, 'telegram.sent.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function heartbeatOf(dataDir) {
  const f = path.join(dataDir, 'heartbeat.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

// 하네스를 띄우고, 종료되면 code 를, timeoutMs 안에 안 죽으면 죽이고 null 을 준다.
function run(name, dataDir, env, timeoutMs) {
  return new Promise((resolve) => {
    const logPath = path.join(dataDir, 'run.log');
    const out = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(process.execPath, [HARNESS], {
      env: {
        ...process.env,
        TEST_REPO: REPO,
        DATA_DIR: dataDir,
        PORT: String(env.PORT || 3399),
        // 텔레그램은 이제 선택 기능(기본 꺼짐)이다. 이 검증은 '재기동 전에 알림이
        // 나가는가' 를 보는 것이므로 여기서는 명시적으로 켜 둔다.
        NOTIFY_TELEGRAM: '1',
        TELEGRAM_BOT_TOKEN: 'TEST-TOKEN',
        TELEGRAM_CHAT_ID: '99999',
        SCRAPE_TIMEOUT_MS: '5000',
        ...env,
      },
      cwd: REPO,
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      resolve({ code: null, killed: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, killed: false });
    });
  });
}

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass, detail });
  console.log(`${pass ? '  ✅' : '  ❌'} ${label}${detail ? ' — ' + detail : ''}`);
}

const MIN = 60000;

(async () => {
  // ================= ① 연속 실패 5회 → 자가재기동 + 텔레그램 =================
  console.log('\n=== [1] fail 5회 시뮬레이션 (수집 간격 1분, 시드 없음) ===');
  const d1 = path.join(ROOT, 'data-full5');
  rmrf(d1);
  seed(d1, { settings: { intervalMinutes: 1 } });
  const r1 = await run('full5', d1, { PORT: '3391', BACKOFF_MAX_MIN: '1', SELF_RESTART_MIN_UPTIME_MIN: '0' }, 6.5 * MIN);
  const hb1 = heartbeatOf(d1);
  const tg1 = telegrams(d1);
  check('프로세스가 스스로 exit 1 로 나갔다', r1.code === 1, `code=${r1.code}`);
  check('failStreak 가 5 에서 재기동됐다', hb1.failStreak === 5, `failStreak=${hb1.failStreak}`);
  check('재기동 사유가 failstreak', hb1.lastSelfRestartReason === 'failstreak', String(hb1.lastSelfRestartReason));
  check('자가 재기동 누적 1회', hb1.selfRestarts === 1, `selfRestarts=${hb1.selfRestarts}`);
  check('오늘 비계획 재기동 1회', hb1.selfRestartsToday === 1, `today=${hb1.selfRestartsToday}`);
  check('재기동 기준선 기록됨', hb1.failStreakAtLastRestart === 5, `atLast=${hb1.failStreakAtLastRestart}`);
  const restartMsg = tg1.filter((t) => t.text.includes('자가 재기동'));
  check('텔레그램 자가재기동 알림 1건 발신', restartMsg.length === 1, `${restartMsg.length}건`);
  check(
    '알림 본문에 연속 실패 횟수가 있다',
    restartMsg.length > 0 && /5회 연속/.test(restartMsg[0].text),
    restartMsg.length ? restartMsg[0].text.replace(/<[^>]+>/g, ' ').slice(0, 60) : ''
  );
  check('죽기 전에 알림을 먼저 보냈다', restartMsg.length === 1 && r1.code === 1);

  // ================= ② 부활 직후 재기동 루프가 아닌지 =================
  // Railway 가 다시 띄운 상황을 그대로 재현한다: ①이 남긴 DATA_DIR 을 그대로 쓴다.
  // failStreak=5 / atLast=5 로 되살아나므로 6·7·8·9 회에는 나가면 안 되고, 10 회에 나가야 한다.
  console.log('\n=== [2] 재기동 직후 루프 방지 (6~9회는 버티고 10회에 재기동) ===');
  const d2 = d1; // 같은 볼륨을 이어 쓴다
  fs.rmSync(path.join(d2, 'telegram.sent.jsonl'), { force: true });
  const r2 = await run('loopguard', d2, { PORT: '3392', BACKOFF_MAX_MIN: '1', SELF_RESTART_MIN_UPTIME_MIN: '0' }, 6.5 * MIN);
  const hb2 = heartbeatOf(d2);
  const tg2 = telegrams(d2);
  check('두 번째 재기동도 exit 1', r2.code === 1, `code=${r2.code}`);
  check('연속 실패 10회까지 버텼다 (6~9회엔 안 나감)', hb2.failStreak === 10, `failStreak=${hb2.failStreak}`);
  check('누적 재기동 2회', hb2.selfRestarts === 2, `selfRestarts=${hb2.selfRestarts}`);
  check('오늘 비계획 재기동 2회', hb2.selfRestartsToday === 2, `today=${hb2.selfRestartsToday}`);
  check('이번 구간 알림도 1건뿐', tg2.filter((t) => t.text.includes('자가 재기동')).length === 1);

  // ================= ③ 하루 3회 초과 → 재기동 대신 경보 =================
  console.log('\n=== [3] 하루 3회 초과 경보 (재기동하지 않고 사람을 부른다) ===');
  const d3 = path.join(ROOT, 'data-storm');
  rmrf(d3);
  const { ymd } = kstNow();
  seed(d3, {
    settings: { intervalMinutes: 1 },
    heartbeat: {
      failStreak: 4,
      failStreakAtLastRestart: 0,
      selfRestarts: 3,
      selfRestartsToday: 3, // 오늘 이미 상한(3회)만큼 재기동했다
      selfRestartDate: ymd,
    },
  });
  // 3분 돌린다: 5회째(경보) → 6·7회째(경보 중복 없이 계속 살아 있어야 한다)
  const r3 = await run('storm', d3, { PORT: '3393', BACKOFF_MAX_MIN: '1', SELF_RESTART_MIN_UPTIME_MIN: '0' }, 3.2 * MIN);
  const hb3 = heartbeatOf(d3);
  const tg3 = telegrams(d3);
  check('재기동하지 않고 살아 있었다 (러너가 죽였다)', r3.killed === true, `code=${r3.code}`);
  check('누적 재기동은 3회 그대로', (hb3.selfRestarts || 0) === 3, `selfRestarts=${hb3.selfRestarts}`);
  check('연속 실패는 계속 쌓였다', (hb3.failStreak || 0) >= 5, `failStreak=${hb3.failStreak}`);
  const storm = tg3.filter((t) => t.text.includes('재기동 반복'));
  check('🚨 재기동 반복 경보 발신', storm.length >= 1, `${storm.length}건`);
  check('경보는 하루 1건만 (도배 없음)', storm.length === 1, `${storm.length}건`);
  check(
    '경보 본문에 상한과 마지막 오류가 있다',
    storm.length > 0 && /상한 3회/.test(storm[0].text) && /테스트 강제 실패/.test(storm[0].text)
  );

  // ================= ④ 새벽 정기 재기동 =================
  // KST 04시를 기다릴 수 없으므로 '지금 시각' 을 정기 재기동 시각으로 준다.
  // 창(60분)·최소 생존 시간(0분)만 검증용으로 열고, 판정 로직 자체는 실제 코드 그대로다.
  console.log('\n=== [4] 정기(새벽 4시) 재기동 ===');
  const d4 = path.join(ROOT, 'data-daily');
  rmrf(d4);
  seed(d4, { settings: { intervalMinutes: 60 } });
  const nowK = kstNow();
  const r4 = await run(
    'daily',
    d4,
    {
      PORT: '3394',
      DAILY_RESTART_HOUR: String(nowK.hour),
      DAILY_RESTART_WINDOW_MIN: '60',
      DAILY_RESTART_MIN_UPTIME_MIN: '0',
      WATCHDOG_TICK_MIN: '0.05', // 3초 틱
    },
    45000
  );
  const hb4 = heartbeatOf(d4);
  const tg4 = telegrams(d4);
  check('정기 재기동도 exit 1', r4.code === 1, `code=${r4.code}`);
  check('사유가 daily', hb4.lastSelfRestartReason === 'daily', String(hb4.lastSelfRestartReason));
  check('오늘 몫 완료로 기록', hb4.lastDailyRestartDate === nowK.ymd, String(hb4.lastDailyRestartDate));
  check('계획 재기동은 비계획 카운터를 올리지 않는다', !hb4.selfRestartsToday, `today=${hb4.selfRestartsToday}`);
  check('정기 재기동은 텔레그램을 보내지 않는다 (새벽 소음 금지)', tg4.length === 0, `${tg4.length}건`);

  // ================= ⑤ 정기 재기동은 하루 한 번 =================
  console.log('\n=== [5] 같은 날 두 번째 정기 재기동은 없다 ===');
  const r5 = await run(
    'daily-again',
    d4,
    {
      PORT: '3395',
      DAILY_RESTART_HOUR: String(nowK.hour),
      DAILY_RESTART_WINDOW_MIN: '60',
      DAILY_RESTART_MIN_UPTIME_MIN: '0',
      WATCHDOG_TICK_MIN: '0.05',
    },
    40000
  );
  check('오늘 몫을 이미 했으므로 다시 나가지 않는다', r5.killed === true, `code=${r5.code}`);

  // ================= ⑥ 갓 태어난 프로세스는 버리지 않는다 =================
  // 임계(5회)를 채워도 기동 후 10분이 안 됐으면 넘어가야 한다.
  // 볼륨이 안 붙어 카운터가 매번 0 으로 돌아가는 환경에서 재기동만 반복되는 것을 막는 빗장.
  console.log('\n=== [6] 최소 생존 시간 (임계를 채워도 갓 태어났으면 안 나간다) ===');
  const d6 = path.join(ROOT, 'data-young');
  rmrf(d6);
  seed(d6, {
    settings: { intervalMinutes: 1 },
    heartbeat: { failStreak: 4, failStreakAtLastRestart: 0 },
  });
  // 기본값(10분)을 그대로 쓴다. 2.2분만 돌리므로 재기동은 일어나면 안 된다.
  const r6 = await run('young', d6, { PORT: '3396', BACKOFF_MAX_MIN: '1' }, 2.2 * MIN);
  const hb6 = heartbeatOf(d6);
  const tg6 = telegrams(d6);
  const log6 = fs.readFileSync(path.join(d6, 'run.log'), 'utf8');
  const deferLines = log6.split('\n').filter((l) => l.includes('재기동 조건을 채웠지만'));
  check('임계를 채웠어도 재기동하지 않았다', r6.killed === true, `code=${r6.code}`);
  check('재기동 기록 없음', !hb6.selfRestarts, `selfRestarts=${hb6.selfRestarts}`);
  check('연속 실패는 5회 이상 쌓였다', (hb6.failStreak || 0) >= 5, `failStreak=${hb6.failStreak}`);
  check('넘어간 사유가 로그에 남았다', deferLines.length >= 1, `${deferLines.length}줄`);
  check(
    '임계 미달 사이클(1~4회)에는 그 경고가 없다',
    deferLines.length <= (hb6.failStreak || 0) - 4,
    `실패 ${hb6.failStreak}회 중 경고 ${deferLines.length}줄`
  );
  check('♻️ 재기동 알림도 나가지 않았다', tg6.filter((t) => t.text.includes('자가 재기동')).length === 0);

  // ---- 정리 ----
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 결과: ${results.length - failed.length}/${results.length} 통과 =====`);
  if (failed.length) {
    console.log('실패 항목:');
    for (const f of failed) console.log(` - ${f.label} (${f.detail || ''})`);
  }
  process.exit(failed.length ? 1 : 0);
})();
