/**
 * decideFor() end to end, with the network stubbed — the gate ORDER and the on-strike floor.
 *
 * ── why this file exists ──
 *
 * test/grading.test.js unit-tests `trader.gapOK`, and a mutation sweep on 2026-08-31 proved that was
 * not enough: replacing the whole `if (!gapOK(...))` gate in decideFor with `if (false)` left every
 * suite green. A predicate that is correct and never called is worth nothing, so the thing that has
 * to be asserted is the WIRING — that a real pass, with a real market and real candles, actually
 * refuses a signal whose spot is sitting on the strike.
 *
 * Stubbing axios rather than the trader's own helpers is deliberate: findActive/getSpot/getCandles
 * are called by direct reference inside decideFor, so monkey-patching module.exports would not
 * intercept them, and a test that patched them would prove nothing about the real path.
 *
 * Run: node test/decide-gate.test.js
 */
const assert = require('assert');
const Module = require('module');

// This file is about the MODEL gate's wiring, so it pins the strategy to 'model' before config is read.
// The shipped default is 'favourite' (src/favourite.js), which decides from the order book and never
// reaches engineEvaluate — under that default every assertion here would pass for the wrong reason, which
// is exactly the failure this file was written to catch.
process.env.STRATEGY = 'model';

// ── the stub network ──
let SPOT = 100.05;          // spot the ticker reports
let STRIKE = 100;           // the market's floor_strike
let CANDLES = null;         // set below
let QUOTE = { yes_ask_dollars: '0.55', no_ask_dollars: '0.55' };
let MINUTES_OUT = 10;       // how far the round's close_time is from now
let STALE_MS = 0;           // how old the ticker claims its last trade is
let PRODUCT = 'BTC-USD';    // rotated by setCandles() to defeat getCandles' per-product cache

const origLoad = Module._load;
// Only the trader's OWN axios is stubbed. kalshitrade.js also requires axios and calls
// axios.create() at module scope, so a stub without it crashes the whole require chain — the
// interceptor therefore carries create()/post() shims and the real module is used everywhere the
// stub is not needed.
const stubAxios = {
  create: () => ({
    get: async () => ({ data: {} }), post: async () => ({ data: {} }),
    interceptors: { request: { use() {} }, response: { use() {} } }
  }),
  post: async () => ({ data: {} }),
  get: async (url) => {
    if (/\/ticker/.test(url)) {
      return { data: { price: String(SPOT), time: new Date(Date.now() - STALE_MS).toISOString() } };
    }
    if (/\/candles/.test(url)) return { data: CANDLES };
    if (/\/markets\?/.test(url)) {
      return {
        data: {
          markets: [{
            ticker: 'KXTEST-1',
            close_time: new Date(Date.now() + MINUTES_OUT * 60000).toISOString(),
            floor_strike: String(STRIKE),
            exchange_index: 2,
            ...QUOTE
          }]
        }
      };
    }
    if (/\/markets\//.test(url)) {
      return { data: { market: { ticker: 'KXTEST-1', floor_strike: String(STRIKE), ...QUOTE } } };
    }
    throw new Error('unexpected url ' + url);
  }
};
Module._load = function (request) {
  if (request === 'axios') return stubAxios;
  return origLoad.apply(this, arguments);
};

const trader = require('../src/trader');
// markets.js keeps its enable/kill state in a module-scope variable that is null until init(), and
// marketBlock() treats "no state" as "every market off" — so without this the very first gate in
// decideFor refuses everything and the rest of the file would pass for the wrong reason.
require('../src/markets').init({ log: () => {} });

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

/**
 * A synthetic candle history in Coinbase's raw array shape, newest first.
 *
 * `drift` per bar makes the four indicators agree with the intended side (falling EMA, RSI under 50,
 * spot under both the Bollinger middle and VWAP for a DOWN read). `jitter` is what sets realizedVol,
 * and it is the load-bearing knob here: the degenerate case this file is about only exists when vol
 * is small enough that sigma barely clears engineEvaluate's own 0.0001 floor. At jitter 0.002 the
 * corpus-like sigma is ~1.27e-4, and a gap of just 0.02% then divides out to z = -1.58 — a stated
 * 94% on a market two hundredths of a percent from its strike.
 */
function candles({ base = 100, drift = -0.004, jitter = 0.002 } = {}) {
  const now = Math.floor(Date.now() / 1000 / 60) * 60;
  return Array.from({ length: 60 }, (_, i) => {
    const close = base - drift * i + (i % 2 ? jitter : -jitter);
    return [now - i * 60, close * 0.999, close * 1.001, close, close, 10];
  });
}

/** One decideFor pass against the stub. */
const pass = () => trader.decideFor({ sym: 'BTC', series: 'KXBTC', product: PRODUCT });
/**
 * Swap in a new candle history.
 *
 * getCandles() memoises per PRODUCT for CANDLE_TTL_MS — real behaviour, and the reason a naive
 * version of this file silently tested one history six times: the first pass cached the falling
 * candles and every later pass reused them, so a phase that set a rising trend was still scored
 * against a falling one. Changing the product key is how a test gets a cold cache without reaching
 * into module internals.
 */
let phase = 0;
function setCandles(opts) {
  CANDLES = candles(opts);
  PRODUCT = 'BTC-USD-' + (++phase);
  SPOT = CANDLES[0][4];
}
/** Put the strike `gapPct` above spot (a DOWN read) or below it (an UP read). */
const strikeAtGap = (spot, gapPct, below = false) =>
  below ? spot / (1 + gapPct / 100) : spot / (1 - gapPct / 100);

(async () => {
  setCandles();

  // ── 1. the baseline must be a real TAKEN decision ──────────────
  //
  // Every assertion below is "the gate refused it", which is also what a broken harness produces. So
  // the harness has to be shown capable of producing a signal first, or this file proves nothing.
  STRIKE = strikeAtGap(SPOT, 0.1);
  let d = await pass();
  ok(!d.skip, `a clear DOWN signal is taken (got ${JSON.stringify(d.skip || d.side)} ${d.why || ''})`);
  eq(d.side, 'NO', 'and it is a NO/DOWN read, as the falling candles imply');
  ok(d.confidence >= trader.MIN_CONF, 'clearing the confidence floor');

  // ── 2. spot exactly ON the strike is caught EARLIER, by confidence ──
  //
  // Worth pinning because it bounds what the gap floor is actually for. At gap = 0 exactly, z = 0, so
  // the model honestly reports 50% and MIN_CONF refuses it. The dangerous band is not zero — it is
  // SMALL-BUT-NONZERO, where a collapsed sigma turns a rounding error into a conviction.
  STRIKE = SPOT;
  d = await pass();
  eq(d.skip, 'below-conf', 'a gap of exactly zero is an honest 50% and fails the confidence floor');

  // ── 3. the band the floor exists for: high confidence, no distance ──
  //
  // This is the wiring assertion. Same candles, same trend, same model — only the distance moves, and
  // the model's own confidence goes UP as the distance shrinks, which is the whole pathology.
  STRIKE = strikeAtGap(SPOT, 0.02);
  d = await pass();
  eq(d.skip, 'on-strike', `a 0.02% gap is refused despite high confidence (got ${JSON.stringify(d)})`);
  ok(/from the strike/.test(d.why), 'and the reason says why, so the skip log is readable');
  ok(/artifact/.test(d.why), 'naming it an artifact rather than a weak signal');
  ok(/\b(8[0-9]|9[0-9]|100)%/.test(d.why),
    `the refusal quotes the confidence it is overriding, which is what makes it legible (${d.why})`);

  // The boundary is live, not decorative: just inside is refused, just outside is taken.
  STRIKE = strikeAtGap(SPOT, trader.MIN_GAP_PCT * 0.99);
  eq((await pass()).skip, 'on-strike', 'a hair inside the floor is still refused');
  STRIKE = strikeAtGap(SPOT, trader.MIN_GAP_PCT * 1.05);
  ok(!(await pass()).skip, 'a hair outside the floor is taken');

  // ── 4. the floor is symmetric, so an UP read is held to it too ──
  //
  // Written because dropping Math.abs from gapOK would refuse every DOWN read and pass every UP one —
  // a mutation that silently inverts which side the bot trades.
  setCandles({ drift: 0.004 });
  STRIKE = strikeAtGap(SPOT, 0.02, true);
  d = await pass();
  eq(d.skip, 'on-strike', 'an UP read just under the floor is refused the same way');
  STRIKE = strikeAtGap(SPOT, 0.1, true);
  d = await pass();
  ok(!d.skip, `and an UP read far from the strike is taken (got ${JSON.stringify(d.skip || d.side)})`);
  eq(d.side, 'YES', 'rising candles produce a YES read, confirming the harness drives both sides');

  // ── 5. a flat market fails on the read, not on the gap ──────────
  //
  // The gap check sits AFTER the confidence gate so the skip log keeps "no signal" and "signal the
  // maths should not have produced" as separate diagnoses. Collapsing them would hide how often each
  // fires, which is the one thing the Decisions tab is for.
  setCandles({ drift: 0, jitter: 0.05 });
  STRIKE = strikeAtGap(SPOT, 0.02);
  d = await pass();
  ok(['below-conf', 'no-read', 'indicators'].includes(d.skip),
    `a flat market fails on the read itself, not on the gap (got ${JSON.stringify(d.skip)})`);

  // ── 6. a stale spot still outranks everything ───────────────────
  //
  // Trading on a stale price is the worse fault, and its guard runs before both — asserted so a
  // reordering that let a stale-but-distant market through would fail here.
  setCandles();
  STRIKE = strikeAtGap(SPOT, 0.02);
  STALE_MS = 90 * 1000;
  d = await pass();
  eq(d.skip, 'stale-spot', 'a 90s-old spot is refused before the gap is even considered');
  STALE_MS = 0;

  // ── 7. a too-dear market is offered to the shadow book ──────────
  //
  // The shadow book can only answer the ceiling question if decideFor actually hands it the markets
  // that were refused for price ALONE. Asserted here rather than in shadow.test.js because that suite
  // tests the book and this one tests the wiring — and the wiring is the half that silently does
  // nothing if the `shadow` field is dropped from the skip.
  setCandles();
  STRIKE = strikeAtGap(SPOT, 0.1);
  QUOTE = { yes_ask_dollars: '0.72', no_ask_dollars: '0.72' };
  d = await pass();
  eq(d.skip, 'too-dear', 'a 72c quote is refused on price');
  ok(d.shadow, 'and is offered to the shadow book, because it cleared every other gate');
  eq(d.shadow.price, 0.72, 'at the price it was actually refused at');
  eq(d.shadow.side, 'NO', 'carrying the side, which grading needs');
  ok(d.shadow.confidence >= trader.MIN_CONF, 'and the confidence that cleared the floor');
  ok(d.shadow.ticker && d.shadow.closeTime, 'plus what a later settle pass needs to look it up');
  // Above SHADOW_MAX there is nothing to learn — the question is the next slice up, not a lottery.
  QUOTE = { yes_ask_dollars: '0.95', no_ask_dollars: '0.95' };
  d = await pass();
  eq(d.skip, 'too-dear', 'a 95c quote is still refused');
  eq(d.shadow, null, 'but is NOT shadowed — above SHADOW_MAX the sample would not inform the ceiling');
  // A market refused for a reason OTHER than price must not enter the sample: it is not part of the
  // population the ceiling question is about.
  QUOTE = { yes_ask_dollars: '0.72', no_ask_dollars: '0.72' };
  STRIKE = strikeAtGap(SPOT, 0.02);
  d = await pass();
  eq(d.skip, 'on-strike', 'a near-strike market is refused on the gap, before price is considered');
  ok(!d.shadow, 'and is not shadowed — it failed a gate the ceiling has nothing to do with');
  QUOTE = { yes_ask_dollars: '0.55', no_ask_dollars: '0.55' };

  // ── 8. both price bounds are WIRED, not just defined ─────────────
  //
  // A mutation sweep bypassed the too-cheap gate and every suite stayed green: the shadow assertions
  // above only ever quote DEAR prices, so nothing exercised the floor. Same class of hole as the
  // on-strike bypass, and the same fix — drive the real path at a price outside each bound.
  setCandles();
  STRIKE = strikeAtGap(SPOT, 0.1);
  QUOTE = { yes_ask_dollars: '0.20', no_ask_dollars: '0.20' };
  d = await pass();
  eq(d.skip, 'too-cheap', `a 20c quote is refused by the floor (got ${JSON.stringify(d.skip)})`);
  ok(/20c is under/.test(d.why), 'and the reason quotes both the price and the floor');
  QUOTE = { yes_ask_dollars: '0.34', no_ask_dollars: '0.34' };
  eq((await pass()).skip, 'too-cheap', 'a hair under the floor is still refused');
  QUOTE = { yes_ask_dollars: '0.36', no_ask_dollars: '0.36' };
  ok(!(await pass()).skip, 'and a hair above it is taken — the floor is live, not decorative');
  // A cheap market is NOT shadowed: the shadow book exists to answer the CEILING question, and a 20c
  // entry tells it nothing about whether the edge holds above 65c.
  QUOTE = { yes_ask_dollars: '0.20', no_ask_dollars: '0.20' };
  ok(!(await pass()).shadow, 'a too-cheap market is not shadowed — wrong question entirely');
  QUOTE = { yes_ask_dollars: '0.55', no_ask_dollars: '0.55' };

  console.log(`PASS decideFor gate wiring — ${checks} checks`);
})().catch(e => { console.error(e); process.exit(1); });
