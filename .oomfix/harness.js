// 로컬 기동 테스트용 하네스.
// 진짜 server.js 를 그대로 띄우되 두 곳만 가짜로 바꾼다:
//   · scrape()  → 항상 실패 (사이트 없이 '연속 실패' 를 만든다)
//   · fetch()   → 텔레그램 발신을 가로채 파일에 기록 (실제로 보내지 않는다)
// 그 외 스케줄러·워치독·재기동 판정은 전부 실제 코드다.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = process.env.TEST_REPO || path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR;

fs.mkdirSync(DATA, { recursive: true });
const TG_LOG = path.join(DATA, 'telegram.sent.jsonl');

// ---- 텔레그램 가로채기 ----
const realFetch = global.fetch;
global.fetch = async function (url, opts) {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    let body = {};
    try {
      body = JSON.parse((opts && opts.body) || '{}');
    } catch (e) {}
    fs.appendFileSync(
      TG_LOG,
      JSON.stringify({ at: new Date().toISOString(), text: body.text || '' }) + '\n',
      'utf8'
    );
    console.log('[TEST] 텔레그램 발신 가로챔:\n' + String(body.text || '').replace(/<[^>]+>/g, ''));
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  }
  return realFetch(url, opts);
};

// ---- 수집 강제 실패 ----
// watcher.js 가 require 하기 '전에' 모듈 객체를 바꿔야 한다 (거기서 구조분해로 집어간다).
const scraper = require(path.join(REPO, 'src', 'scraper.js'));
scraper.scrape = async function () {
  throw new Error('테스트 강제 실패: 사이트 연결 불가');
};
scraper.fetchDetails = async function () {
  return {};
};
scraper.closeAllBrowsers = async function () {
  return 0;
};

process.on('exit', (code) => {
  console.log(`[TEST] 프로세스 종료 code=${code}`);
});

require(path.join(REPO, 'src', 'server.js'));
