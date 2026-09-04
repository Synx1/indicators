/**
 * Does the CALIBRATION gate actually trade paper, and is it genuinely refused for real money?
 *
 * ── why this file exists ──
 *
 * The gate is new and its edge is real but narrow: +3.01% fee-adjusted on an expanding-day walk-forward
 * at a PERFECT fill, and only +1.01% with the day-clustered interval touching zero once a single cent of
 * slippage is paid. Its signals also arrive correlated across coins. That combination is exactly the
 * shape of thing that should accumulate forward evidence in a paper book and must not reach a live
 * account, so both halves of that need to be proven rather than asserted in a comment.
 *
 * This drives the real sequence — decideFor, gateSignal, accountBlock, sharesFor, placeEntry — with a
 * real user record and a stubbed exchange, once for paper and once for live.
 *
 * ── the specific thing being pinned ──
 *
 * entryLimitCents must respect the gate's OWN limit (ask plus the measured 1c grace), not the generic
 * 99c exchange ceiling. The grace value was chosen because 2c bought nothing extra in the live shadow, so
 * letting a user's 4c slippage dial push an entry to ask+4c would trade a population never validated.
 *
 * Run: node test/calibration-entry.test.js
 */
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STRATEGY = 'calibration';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calent-'));
process.env.STATE_DIR = DIR;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

/**
 * The clock is FROZEN, and it has to be.
 *
 * The gate excludes 07:00 and 08:00 ET closes, and this test builds a market closing nine minutes from
 * now. Against the wall clock it therefore passed 22 hours a day and failed during those two — worse
 * than no test, because the one time it goes red everybody blames the clock instead of reading it. It
 * caught itself twice: once at 08:00 ET when the session gate first landed, and again after a branch
 * rebuild silently dropped this guard.
 *
 * 17:00Z is 13:00 ET under daylight saving, so a close nine minutes out lands at 13:09 ET: inside the
 * decision band, outside the excluded hours, and independent of when the suite runs. The excluded hours
 * keep their own explicit coverage in test/calibration.test.js.
 */
const FROZEN_NOW = Date.parse('2026-09-04T17:00:00Z');
const realNow = Date.now;
Date.now = () => FROZEN_NOW;

// One round, nine minutes out, YES quoted 0.84/0.85 — inside 75-90c with a 1c spread, so it qualifies.
let QUOTE = { yes_ask_dollars: '0.85', no_ask_dollars: '0.16', yes_bid_dollars: '0.84' };
let MINUTES_OUT = 9;
const origLoad = Module._load;
const stubAxios = {
  create: () => ({
    get: async () => ({ data: {} }), post: async () => ({ data: {} }),
    interceptors: { request: { use() {} }, response: { use() {} } }
  }),
  post: async () => ({ data: {} }),
  get: async (url) => {
    if (/\/ticker/.test(url)) return { data: { price: '100', time: new Date().toISOString() } };
    if (/\/candles/.test(url)) return { data: [] };
    if (/\/markets\?/.test(url)) {
      return { data: { markets: [{
        ticker: 'KXBTC15M-CALTEST',
        close_time: new Date(Date.now() + MINUTES_OUT * 60000).toISOString(),
        floor_strike: '100', exchange_index: 2, ...QUOTE
      }] } };
    }
    if (/\/markets\//.test(url)) {
      return { data: { market: { ticker: 'KXBTC15M-CALTEST', floor_strike: '100', ...QUOTE } } };
    }
    throw new Error('unexpected url ' + url);
  }
};
Module._load = function (request) {
  if (request === 'axios') return stubAxios;
  return origLoad.apply(this, arguments);
};

const trader = require('../src/trader');
const calibration = require('../src/calibration');
const users = require('../src/users');
const book = require('../src/book');

// ── the grace cap: a user's slippage dial may not push an entry past the gate's own limit ──
eq(trader.entryLimitCents({ strategy: 'CALIBRATION', pricePct: 85, calLimit: 0.86 }, 4), 86,
  'a 4c slippage dial cannot outrun the measured 1c grace allowance');
eq(trader.entryLimitCents({ strategy: 'CALIBRATION', pricePct: 92, calLimit: 0.93 }, 20), 93,
  'even a large allowance is capped at the gate limit');
eq(trader.entryLimitCents({ strategy: 'CALIBRATION', pricePct: 85, calLimit: 0.86 }, 0), 85,
  'with no slippage the entry pays the quoted ask, not the limit');
eq(trader.entryLimitCents({ strategy: 'MODEL', pricePct: 65 }, 4), 69,
  'the model path keeps its prior behaviour');
eq(trader.entryLimitCents({ strategy: 'FAVOURITE', pricePct: 87 }, 4), 90,
  'the favourite cap is untouched by this gate');

require('../src/markets').init({ log: () => {} });
users.init({ log: () => {} });

(async () => {
  const coin = { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' };

  // 1. the gate produces a decision from the book alone
  const raw = await trader.decideFor(coin);
  ok(!raw.skip, `decideFor takes an 85c in-band book (got ${raw.skip || ''} ${raw.why || ''})`);
  eq(raw.strategy, 'CALIBRATION');
  eq(raw.side, 'YES');
  eq(raw.direction, 'UP');
  eq(raw.calBucket, '75-90c');
  eq(raw.calMarginal, false);
  eq(raw.pricePct, 85, 'the YES entry pays the YES ask');
  eq(raw.calSpreadCents, 1);
  ok(raw.calLimit === 0.86, 'the carried limit is the ask plus the 1c grace');
  ok(raw.calTStat > 4, 'the bucket t-statistic travels with the decision');
  ok(raw.confidence > 84 && raw.confidence < 93, 'confidence is the side mid plus the measured bias');

  // 2. the signal is not held back on first sight
  const d = trader.gateSignal(coin, raw, Date.now());
  ok(!d.skip, `gateSignal does not hold a calibration signal (got ${d.skip || ''})`);

  // 3. PAPER is allowed — this is how forward evidence accumulates
  const paper = users.tenant('333333333333333333', { create: true });
  paper.grantAccess(30, 'TEST-KEY');
  paper.set('live', false);
  paper.set('shares', 5);
  paper.set('slippageCents', 4);
  ok(paper.hasAccess(), 'the paper account has access');
  // accountBlock returns a reason string when it refuses, and a falsy value when it permits.
  ok(!trader.accountBlock(paper, d),
    'a paper account is permitted so the gate can be measured forward');

  // A permitted order comes back as a PENDING placement carrying the limit it will be filled against;
  // a refused one comes back as taken:false with a reason. Those are different shapes, and asserting the
  // wrong one is how a broken gate looks like a working one.
  const claims = new Map();
  const placed = await trader.placeEntry(paper, d, claims);
  ok(placed && placed.pending,
    `the paper entry is placed (got ${placed && placed.why ? placed.why : JSON.stringify(placed)})`);
  eq(placed.pending.kind, 'paper', 'it is placed against the paper book');
  eq(placed.pending.limitCents, 86,
    'the placement carries the grace-capped limit, not the 4c slippage dial');
  eq(placed.pending.shares, 5);
  eq(placed.pending.block, null, 'nothing blocked the paper placement');
  ok(placed.taken !== false, 'a permitted strategy is not reported as refused');

  // 4. LIVE is refused, and the refusal states the evidence rather than a bare flag
  // An account only reaches real money when it is BOTH live AND armed — paperAllowed() is
  // !(live && armed), so setting `live` alone leaves it on paper and would silently test nothing.
  const live = users.tenant('444444444444444444', { create: true });
  live.grantAccess(30, 'TEST-KEY');
  live.set('live', true);
  live.set('armed', true);
  live.set('shares', 5);
  ok(!live.liveBlock(), `the live account is genuinely able to trade (got ${live.liveBlock()})`);
  const whyLive = trader.accountBlock(live, d);
  ok(typeof whyLive === 'string' && /paper-only/.test(whyLive),
    `a live account is refused (got: ${whyLive})`);
  ok(/1c slippage|correlated/.test(whyLive),
    'the refusal names the actual reason, not just a disabled switch');

  const placedLive = await trader.placeEntry(live, d, new Map());
  ok(placedLive && placedLive.taken === false,
    'placeEntry independently refuses a live calibration entry');
  eq(book.openPositions(live.rec.book).length, 0, 'no live position is ever opened');

  // 5. the readiness switches are what gate this, and live must remain false
  eq(calibration.CAL_LIVE_READY, false, 'live readiness stays fail-closed');
  eq(calibration.CAL_FORWARD_READY, true, 'paper readiness is on');

  // 6. an out-of-band book is refused outright rather than traded at a worse price
  QUOTE = { yes_ask_dollars: '0.50', no_ask_dollars: '0.51', yes_bid_dollars: '0.49' };
  const mid = await trader.decideFor(coin);
  eq(mid.skip, 'cal-off-band', `a 50c book is refused (got ${mid.skip})`);

  // 7. a wide spread in band is refused even though the price qualifies
  QUOTE = { yes_ask_dollars: '0.85', no_ask_dollars: '0.21', yes_bid_dollars: '0.80' };
  const wide = await trader.decideFor(coin);
  eq(wide.skip, 'cal-wide-spread', `a 5c spread is refused (got ${wide.skip})`);

  // 8. the RECORDED position carries the gate's own inputs
  //
  // This is not bookkeeping. The case for this gate is a measured per-bucket bias over that bucket's
  // own cost, and the bar for ever letting it touch live money is a day-clustered forward interval
  // with a lower bound above zero. Neither number can be computed from a position that does not say
  // which bucket produced it or what spread was paid. These fields were reaching the live panel and
  // then being dropped by record(), which is how four paper trades ended up with an unverifiable
  // spread gate. The gap was invisible precisely because nothing failed when the fields went missing,
  // so it is asserted here against a position built by the real settleEntry path.
  QUOTE = { yes_ask_dollars: '0.85', no_ask_dollars: '0.16', yes_bid_dollars: '0.84' };
  const d2 = await trader.decideFor(coin);
  ok(!d2.skip, `the qualifying round still decides (got ${d2.skip || 'ok'})`);
  const before = book.openPositions(paper.rec.book).length;
  const limit2 = trader.entryLimitCents(d2, Number(paper.get('slippageCents')) || 0);
  eq(limit2, 86, 'the grace-capped limit is still 86c, not the 4c slippage dial');
  const filled = await trader.settleEntry({
    t: paper, d: d2, kind: 'paper', shares: 5,
    limitCents: limit2, res: null, block: null
  });
  ok(filled && filled.taken === true,
    `the paper order fills (got ${filled && filled.why ? filled.why : JSON.stringify(filled)})`);
  const opened = book.openPositions(paper.rec.book);
  eq(opened.length, before + 1, 'the paper fill opened exactly one position');
  const pos = opened[opened.length - 1];

  eq(pos.strategy, 'CALIBRATION', 'the position is tagged with the gate that produced it');
  eq(pos.calBucket, '75-90c', `the bucket is persisted (got ${pos.calBucket})`);
  eq(pos.calMarginal, false, 'the bucket is recorded as non-marginal');
  ok(Number.isFinite(pos.calTStat) && pos.calTStat > 2,
    `the bucket's t-stat is persisted (got ${pos.calTStat})`);
  ok(Number.isFinite(pos.calBiasPt) && pos.calBiasPt > 0,
    `the measured bias is persisted (got ${pos.calBiasPt})`);
  ok(Number.isFinite(pos.calGraceCents), `the grace allowance is persisted (got ${pos.calGraceCents})`);
  ok(Number.isFinite(pos.calLimit), `the entry limit is persisted (got ${pos.calLimit})`);

  // The spread is the audit that could not be run on the live trades. 0.84/0.85 is a 1c book, and it
  // has to survive as 1c on the record rather than as a value inferred from the absence of slippage.
  ok(Number.isFinite(pos.calSpreadCents) && Math.abs(pos.calSpreadCents - 1) < 1e-6,
    `the spread paid is persisted exactly (got ${pos.calSpreadCents})`);
  ok(pos.calSpreadCents <= calibration.CAL_MAX_SPREAD_CENTS,
    'the persisted spread is inside the validated gate, verifiably and not by inference');

  // calMid must be the BOOK MID, distinct from the fill. midPct is assigned from pricePct for every
  // strategy, so it is the price paid; if calMid were wired to the same source the cost being measured
  // would collapse to zero and every future audit would read as free execution.
  ok(Math.abs(pos.calMid - 0.845) < 1e-6, `calMid is the book mid, not the fill (got ${pos.calMid})`);
  ok(pos.calMid < pos.price,
    `the mid sits below the ask actually paid (mid ${pos.calMid} vs paid ${pos.price})`);

  Date.now = realNow;
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`PASS calibration entry path — ${checks} checks`);
})().catch(error => {
  Date.now = realNow;
  fs.rmSync(DIR, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
