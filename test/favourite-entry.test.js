/**
 * Does a favourite signal actually become a POSITION? The whole path, not just the gate.
 *
 * ── why this file exists ──
 *
 * The favourite gate shipped and the bot then took no trades for thirteen hours. The gate was fine —
 * decideFor returned entries and test/favourite.test.js proved it. What stopped them was everything
 * AFTER the gate: gateSignal held each one for sixty seconds of continuous persistence it could never
 * accumulate. That was invisible to every existing test, because no test drove a decision past decideFor.
 *
 * So this drives the real sequence — decideFor, gateSignal, accountBlock, sharesFor, placeEntry — with a
 * real user record and a stubbed exchange, and asserts a paper position exists at the end. Anything that
 * silently refuses an 87c entry between the gate and the book fails here instead of costing another
 * thirteen hours.
 *
 * ── the specific thing that nearly bit twice ──
 *
 * The model gate buys at 35-65c and the favourite gate buys at 85-90c. Every size, cost and affordability
 * rule in the path was written when 65c was the most a contract could cost. sharesFor divides the risk
 * budget by MAX_PRICE — the MODEL's ceiling — so at an 87c fill it sizes 34% larger than the risk dial
 * asks for. That is asserted below as an explicit arithmetic check, because it is the kind of wrong that
 * still produces a trade and therefore never looks broken.
 *
 * Run: node test/favourite-entry.test.js
 */
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STRATEGY = 'favourite';
// A scratch DATA_DIR so this never reads or writes the real users.json.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favent-'));
process.env.STATE_DIR = DIR;

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// ── the stubbed exchange: one round, nine minutes out, the dear side at 87c ──
let QUOTE = { yes_ask_dollars: '0.87', no_ask_dollars: '0.14', yes_bid_dollars: '0.86' };
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
        ticker: 'KXBTC15M-TEST', close_time: new Date(Date.now() + MINUTES_OUT * 60000).toISOString(),
        floor_strike: '100', exchange_index: 2, ...QUOTE
      }] } };
    }
    if (/\/markets\//.test(url)) {
      return { data: { market: { ticker: 'KXBTC15M-TEST', floor_strike: '100', ...QUOTE } } };
    }
    throw new Error('unexpected url ' + url);
  }
};
Module._load = function (request) {
  if (request === 'axios') return stubAxios;
  return origLoad.apply(this, arguments);
};

const trader = require('../src/trader');
const users = require('../src/users');
const book = require('../src/book');
require('../src/markets').init({ log: () => {} });
users.init({ log: () => {} });

// A paper account that is entitled to trade: access on the clock, live off, fixed size.
const UID = '111111111111111111';
const t = users.tenant(UID, { create: true });
t.grantAccess(30, 'TEST-KEY');
t.set('live', false);
t.set('shares', 5);
ok(t.hasAccess(), 'the test account has access — without it nothing trades, not even paper');

(async () => {
  const coin = { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' };

  // 1. the gate produces a decision
  const raw = await trader.decideFor(coin);
  ok(!raw.skip, `decideFor takes an 87c book (got ${raw.skip || ''} ${raw.why || ''})`);

  // 2. gateSignal lets it through on FIRST sight — the thirteen-hour bug
  const d = trader.gateSignal(coin, raw, Date.now());
  ok(!d.skip, `gateSignal does not hold a favourite signal (got ${d.skip || ''})`);

  // 3. accountBlock permits it
  const why = trader.accountBlock(t, d);
  eq(why, null, `accountBlock permits an 87c paper entry (got: ${why})`);

  // 4. it sizes to something tradeable
  eq(trader.sharesFor(t, d), 5, 'fixed size is honoured at 87c');

  // 5. and it becomes a position
  const claims = new Map();
  const placed = await trader.placeEntry(t, d, claims);
  ok(placed && placed.taken !== false, `placeEntry opens the position (got: ${placed && placed.why})`);
  // placeEntry returns only the pending half — the caller owns `t` and `d` and merges them in, which is
  // how runOnce does it so the fill-grace waits can be gathered and run together.
  if (placed && placed.pending) await trader.settleEntry({ t, d, ...placed.pending });
  const open = book.openPositions(t.rec.book);
  eq(open.length, 1, 'exactly one position is on the book');
  if (process.env.DUMP) console.log(JSON.stringify(open[0], null, 1));
  eq(open[0].side, 'YES', 'on the dear side');
  eq(Math.round(Number(open[0].entryPrice != null ? open[0].entryPrice : open[0].price) * 100), 87,
    'recorded at the price the book was offering');
  eq(open[0].strategy, 'FAVOURITE', 'and tagged with the gate that produced it');

  /**
   * The sizer divides by the MODEL's ceiling, not the entry price.
   *
   * sharesFor returns floor(bank * riskPerTrade / MAX_PRICE), and MAX_PRICE is 0.65 — what a model-gate
   * contract could cost at most. A favourite fill costs 0.87, so auto size buys 0.87/0.65 = 1.34x the
   * contracts the risk dial asked for and the order risks a third more than intended. It still trades,
   * which is why nothing else catches it.
   */
  const fresh = users.tenant('222222222222222222', { create: true });
  fresh.grantAccess(30, 'TEST-KEY');
  fresh.set('live', false);
  fresh.set('autoShares', true);
  fresh.set('riskPerTrade', 0.1);
  const bank = trader.liveOrPaperBalance(fresh);
  const wanted = Math.floor(bank * 0.1 / d.price);          // what 10% of the bank really buys at 87c
  const got = trader.sharesFor(fresh, d);
  eq(got, wanted,
    `auto size must divide by the price PAID: 10% of ${bank.toFixed(2)} is ` +
    `${(bank * 0.1).toFixed(2)}, which buys ${wanted} contracts at ${d.pricePct}c. Dividing by ` +
    `MAX_PRICE (${trader.MAX_PRICE}) instead returns ${Math.floor(bank * 0.1 / trader.MAX_PRICE)} — 34% ` +
    'more contracts than the risk dial asked for, which still fills and so never looks wrong.');
  // And the money actually at risk is the budget, which is the only reading of riskPerTrade that is true.
  ok(Math.abs(got * d.price - bank * 0.1) < d.price,
    'the cash committed equals the risk budget to within one contract');

  Module._load = origLoad;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  console.log(`PASS favourite entry path — ${checks} checks`);
})().catch(e => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
