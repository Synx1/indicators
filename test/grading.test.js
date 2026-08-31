/**
 * The four lines that decide how much money there is, and a truth table for each.
 *
 * ── why this file exists ──
 *
 * On 2026-08-30 a mutation test ran fourteen deliberate one-line breaks against the twelve suites
 * that existed. Eleven survived. The worst three:
 *
 *   - INVERTING the settlement grade, so every win books as a loss: no suite failed.
 *   - Removing `- entryFee` from settle(), so every P&L is overstated: no suite failed.
 *   - Raising MAX_PRICE from 0.65 to 0.95, undoing the change the whole entry band rests on: no
 *     suite failed.
 *
 * A suite that cannot catch an inverted win/loss is not testing the thing that matters. These are
 * the assertions that would have failed, written against the smallest units that can carry them:
 * trader.gradeWin (extracted from checkExits for exactly this reason), book.settle, book.stats, and
 * the gate constants themselves.
 *
 * Run: node test/grading.test.js
 */
const assert = require('assert');
const trader = require('../src/trader');
const book = require('../src/book');

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const near = (a, b, m, e = 1e-6) => { checks++; assert.ok(Math.abs(a - b) < e, `${m} (got ${a}, want ${b})`); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

// ── 1. the settlement truth table ──────────────────────────────
//
// Kalshi grades a market 'yes' or 'no'. A YES position wins on 'yes'; a NO position wins on 'no'.
// Every other combination loses, and every other RESULT must never be graded at all — the caller
// keeps the position open and waits, which is asserted separately below.
eq(trader.gradeWin('YES', 'yes'), true, 'YES on a yes market WINS');
eq(trader.gradeWin('YES', 'no'), false, 'YES on a no market LOSES');
eq(trader.gradeWin('NO', 'no'), true, 'NO on a no market WINS');
eq(trader.gradeWin('NO', 'yes'), false, 'NO on a yes market LOSES');

// Anything that is not exactly 'yes'/'no' must not read as a win for either side. checkExits
// refuses to grade these at all; this asserts the function is safe even if that changes.
for (const junk of [null, undefined, '', 'void', 'YES', 'Yes', 'settled', 0, 1, true, {}]) {
  eq(trader.gradeWin('YES', junk), false, `YES is not a win on result ${JSON.stringify(junk)}`);
  eq(trader.gradeWin('NO', junk), false, `NO is not a win on result ${JSON.stringify(junk)}`);
}
// And a malformed SIDE never wins, whatever the market did.
for (const side of [null, undefined, '', 'yes', 'UP', 'DOWN', 'Y']) {
  eq(trader.gradeWin(side, 'yes'), false, `side ${JSON.stringify(side)} does not win a yes market`);
  eq(trader.gradeWin(side, 'no'), false, `side ${JSON.stringify(side)} does not win a no market`);
}

console.log(`  grading truth table: ${checks} checks`);

// ── 2. settle() arithmetic ─────────────────────────────────────
//
// pnl = proceeds - cost - entryFee, and settlement charges NO exit fee. The missing-entryFee mutant
// survived the old suite, so each term is asserted on its own rather than as one total.
const mkBook = () => ({ positions: [], seq: 0 });
const openOne = (b, { side = 'NO', contracts = 10, priceCents = 55, live = true } = {}) =>
  book.open(b, {
    sym: 'BTC',
    decision: { side, strike: 100, spot: 100, confidence: 84, minutesLeft: 9, edgePt: 20, modelPct: 84, pricePct: priceCents },
    market: { ticker: 'T1', close_time: '2026-08-30T20:45:00Z' },
    fill: { contracts, priceCents, price: priceCents / 100, cost: +(contracts * priceCents / 100).toFixed(2), fee: 0.05, live }
  });

let b = mkBook();
let p = openOne(b);
book.settle(b, p, true);
near(p.proceeds, 10, 'a winning settle pays $1 per contract');
eq(p.exitFee, 0, 'settlement is not a trade, so it charges no exit fee');
near(p.pnl, 10 - 5.5 - 0.05, 'win pnl subtracts BOTH the cost and the entry fee');
eq(p.exitPriceCents, 100, 'a win settles at 100c');
eq(p.outcome, 'WIN', 'the outcome label is set');

b = mkBook(); p = openOne(b);
book.settle(b, p, false);
near(p.pnl, -(5.5 + 0.05), 'a loss costs the stake AND the entry fee');
eq(p.proceeds, 0, 'a loss pays nothing');
eq(p.exitPriceCents, 0, 'a loss settles at 0c');

// A position is graded exactly once. The refusal must also leave the position untouched, or a
// retried pass would corrupt a settled row.
b = mkBook(); p = openOne(b);
book.settle(b, p, true);
const frozen = JSON.stringify(p);
checks++; assert.throws(() => book.settle(b, p, false), /already/, 'a second settle throws');
eq(JSON.stringify(p), frozen, 'the refused settle mutated nothing');
checks++; assert.throws(() => book.close(b, p, { price: 0.9, reason: 'CASHOUT' }), /already/,
  'closing a settled position throws');
eq(JSON.stringify(p), frozen, 'the refused close mutated nothing');

console.log(`  settle arithmetic: ${checks} checks`);

// ── 3. stats(): the totals must equal the rows ──────────────────
b = mkBook();
const pnls = [];
for (let i = 0; i < 12; i++) {
  const q = openOne(b, { side: i % 3 ? 'NO' : 'YES', priceCents: 40 + i, live: i % 2 === 0 });
  q.ticker = 'T' + i;
  book.settle(b, q, i % 3 !== 0);
  pnls.push(q.pnl);
}
let s = book.stats(b);
eq(s.n, 12, 'stats counts every settled position');
near(s.net, pnls.reduce((a, x) => a + x, 0), 'stats.net is the exact sum of the rows', 1e-4);
near(book.equity(b, { start: 100 }).realised, s.net, 'equity.realised agrees with stats.net', 1e-4);
near(s.hit, s.wins / s.n, 'the hit rate is exactly wins/closed — the number every gate decision is judged against');
eq(s.wins + s.losses, s.n, 'wins and losses account for every closed position, with none double-counted');

// A pnl of exactly zero is not a win. `pnl >= 0` would silently inflate every hit rate on the
// dashboard and in the Discord panel.
b = mkBook(); p = openOne(b);
p.outcome = 'WIN'; p.pnl = 0; p.exitAt = '2026-08-30T21:00:00Z';
s = book.stats(b);
eq(s.n, 1, 'a zero-pnl position still counts as closed');
eq(s.wins, 0, 'a pnl of exactly 0 is NOT a win');

// ── 4. the gate constants are load-bearing, so pin them ─────────
//
// MIN_CONF 80 and MAX_PRICE 0.65 are one decision, not two dials (see the essay above them in
// trader.js): a looser floor at a high ceiling just buys dearer contracts. MIN_MINUTES 8 was
// measured to double the weaker chronological half. Changing any of these is legitimate — but it
// must be deliberate, and this assertion is what makes it deliberate.
eq(trader.MIN_CONF, 80, 'the confidence floor is 80');
eq(trader.MAX_PRICE, 0.65, 'the ceiling is 65c — the band the edge was measured in');
eq(trader.MIN_PRICE, 0.35, 'the floor is 35c — raised from 25c on 2026-08-31');
// The floor and the ceiling are ONE decision about how much the model is allowed to disagree with the
// market, because confidence and price measure the same thing. At the 80% floor, a 35c entry is a
// 45-point disagreement and a 65c entry is a 15-point one. Asserting the SPAN pins that relationship,
// which neither constant does alone.
checks++; assert.ok(trader.MIN_CONF / 100 - trader.MIN_PRICE >= 0.40,
  'a bought contract may imply at most a 45pp model-vs-market disagreement at the confidence floor');
checks++; assert.ok(trader.MIN_CONF / 100 - trader.MAX_PRICE >= 0.10,
  'and at least a 10pp one at the ceiling, or the gate would be buying at fair value');
eq(trader.MIN_CONFIRM, 3, 'three of the four indicators must agree');
eq(trader.MIN_MINUTES, 8, 'no entry inside eight minutes');
eq(trader.MAX_MINUTES, 14, 'and none earlier than fourteen');
eq(trader.MAX_SPOT_AGE_MS, 45000, 'a spot older than 45s is not worth trading on');
eq(trader.MIN_GAP_PCT, 0.03, 'spot must sit at least 0.03% from the strike');
checks++; assert.ok(trader.MIN_PRICE < trader.MAX_PRICE, 'the price band is the right way round');
checks++; assert.ok(trader.MIN_MINUTES < trader.MAX_MINUTES, 'the clock window is the right way round');

// ── 4b. the min-gap floor: distance before conviction ────────────
//
// The degenerate case this exists for: z = gap/sigma, and when realizedVol collapses sigma goes tiny,
// so a gap of 0.02% still divides out to a large z and the model reports 85% on a market where spot
// is sitting ON the strike. At gap→0 the true probability is 50% whatever the arithmetic says, so
// MIN_CONF cannot screen this — confidence is HIGHEST exactly when sigma is smallest.
//
// The boundary is asserted from both sides because `>=` vs `>` is one keystroke, and Math.abs is one
// deletion — without it every DOWN read (spot BELOW strike, so a negative gap) would fail the floor
// and the bot would stop taking its structural side entirely.
const GAP = trader.MIN_GAP_PCT / 100;
eq(trader.gapOK(100, 100), false, 'spot exactly ON the strike is refused — that is a coin flip, not a read');
// The inclusive boundary, on a pair whose gap lands on exactly 0.03 in binary floating point. Most
// pairs do not (100 -> 100.03 reads back as 0.030000000000001137), and on those `>=` and `>` cannot be
// told apart — so a mutation from `>=` to `>` survives unless the assertion is made HERE.
eq(Math.abs((10003 - 10000) / 10000) * 100, trader.MIN_GAP_PCT, 'crafted a pair exactly on the floor');
eq(trader.gapOK(10003, 10000), true, 'exactly at the floor CLEARS it — the boundary is inclusive');
eq(trader.gapOK(9997, 10000), true, 'and inclusive on the DOWN side too');
eq(trader.gapOK(100 * (1 + GAP * 0.999), 100), false, 'a hair under the floor is refused');
eq(trader.gapOK(100 * (1 + GAP * 10), 100), true, 'well above the floor passes');
// The same distances BELOW the strike, which is the side this bot mostly trades.
eq(trader.gapOK(100 * (1 - GAP * 1.001), 100), true, 'the floor is symmetric — a DOWN read at the same distance clears');eq(trader.gapOK(100 * (1 - GAP * 0.999), 100), false, 'and a DOWN read just inside it is refused');
eq(trader.gapOK(100 * (1 - GAP * 10), 100), true, 'a far DOWN read clears');
// Garbage must fail CLOSED. `NaN < floor` is false, so an unguarded comparison would read an
// unreadable spot as a clean, distant strike and trade on it.
for (const junk of [NaN, undefined, null, Infinity, -Infinity, '100', {}, '']) {
  eq(trader.gapOK(junk, 100), false, `a ${JSON.stringify(junk)} spot never clears the gap floor`);
  eq(trader.gapOK(100, junk), false, `a ${JSON.stringify(junk)} strike never clears the gap floor`);
}
eq(trader.gapOK(100, 0), false, 'a zero strike is refused rather than dividing by zero');
// Scale independence: the floor is a percentage, so it must behave identically on a $0.20 coin and a
// $100,000 one. A DOGE gap of 0.03% is fractions of a cent; an absolute floor would ban DOGE outright.
// Tested a hair either side rather than exactly ON the boundary, because `strike * (1 + GAP)` does not
// round-trip through binary floating point at every scale — 3.5 * 1.0003 reads back as 0.029999…%.
// That lands on the refusing side, which is the harmless direction for a guard, and is why the
// inclusive-boundary assertion above is made at a scale where the arithmetic is exact.
for (const strike of [0.2, 3.5, 240, 64978.38]) {
  eq(trader.gapOK(strike * (1 + GAP * 1.001), strike), true, `the floor is relative, not absolute (strike ${strike})`);
  eq(trader.gapOK(strike * (1 + GAP * 0.5), strike), false, `and it still bites at half the distance (strike ${strike})`);
}

// ── 5. the entry gate cannot be fooled by a NaN ─────────────────
//
// A NaN confidence is the dangerous case, because every comparison with NaN is false: written as
// `confidence < MIN_CONF`, a garbage reading sailed through the floor as a confident NO. Three
// guards now stand in a row and each is asserted on its own.
const decide = require('../src/decide');

eq(trader.confOK(79), false, '79% is under the floor');
eq(trader.confOK(80), true, 'exactly 80% CLEARS the floor — the boundary is inclusive');
eq(trader.confOK(81), true, '81% clears it');
for (const junk of [NaN, undefined, null, Infinity, -Infinity, '85', {}, '']) {
  eq(trader.confOK(junk), false, `${JSON.stringify(junk)} does not clear the floor`);
}

// realizedVol: a single non-positive close must not poison the variance.
const bar = c => ({ close: c, high: c * 1.001, low: c * 0.999, volume: 10 });
const clean = Array.from({ length: 25 }, (_, i) => bar(100 + (i % 3)));
for (const poison of [0, -5, NaN, undefined, null]) {
  const candles = clean.slice();
  candles[3] = bar(poison);
  const vol = decide.realizedVol(candles, 10);
  ok(Number.isFinite(vol) && vol > 0, `a ${JSON.stringify(poison)} close still yields a finite vol`);
  const r = decide.engineEvaluate(100, 100.5, 10, candles);
  ok(r.side === null || Number.isFinite(r.confidence),
    `engineEvaluate never returns a NaN confidence (got ${JSON.stringify(r)})`);
  ok(Number.isFinite(r.confidence) || !trader.confOK(r.confidence),
    'a non-finite reading can never clear the gate');
}
// Dropping bad bars can leave too few returns; that must fall back to the floor, not to NaN.
const sparse = Array.from({ length: 8 }, (_, i) => bar(i % 2 ? 0 : 100));
eq(decide.realizedVol(sparse, 10), 0.0006, 'too few usable returns falls back to the vol floor');
eq(decide.engineEvaluate(100, 100.5, 2.99, clean).side, null, 'inside three minutes there is no read');
eq(decide.engineEvaluate(0, 100, 10, clean).side, null, 'a zero spot produces no read');

// A NaN clock is the reachable way to get a non-finite probability: minutesLeft is computed from the
// market's close_time, so one unparseable timestamp from the exchange makes every number after it
// NaN — and `minutesLeft < 3` does not catch NaN, because no comparison with NaN is true. The
// fail-closed check on pYes is the guard that stops it becoming a confident NO.
for (const clock of [NaN, undefined, null, 'soon', {}]) {
  const r = decide.engineEvaluate(100, 100.5, clock, clean);
  ok(r.side === null && r.confidence === 0,
    `a ${String(clock)} minutesLeft produces NO read at all (got ${JSON.stringify(r)})`);
}
// Infinity is the one non-finite clock that survives to a number: sigma becomes Infinity, so z is 0
// and the model reports an honest coin-flip. That is harmless precisely because 50% cannot clear the
// floor — which is the property worth asserting, rather than the exact shape of the reply.
const inf = decide.engineEvaluate(100, 100.5, Infinity, clean);
ok(inf.side === null || !trader.confOK(inf.confidence),
  `an Infinity minutesLeft can never clear the confidence gate (got ${JSON.stringify(inf)})`);

// decide.fee must agree with the exchange's own arithmetic, everywhere in the traded band.
const kt = require('../src/kalshitrade');
let mismatches = 0;
for (let c = 1; c <= 200; c++) {
  for (let pc = 1; pc <= 99; pc++) {
    if (Math.abs(decide.fee(pc / 100, c) - kt.feeDollars(c, pc / 100)) > 1e-9) mismatches++;
  }
}
eq(mismatches, 0, 'decide.fee matches kalshitrade.feeDollars on all 19,800 (contracts, price) pairs');
eq(decide.fee(0.5, 100), 1.75, 'the documented maximum fee case is $1.75, not $1.76');

// ── 6. the position cap defaults to 3, and the default is the cap ─
//
// `Number(t.get('maxOpen')) || 3` is the only thing standing between a signal-rich pass and an
// account with every dollar committed. Raising that default to 99 left all twelve suites green, so
// the DEFAULT — not just a configured value — is asserted here.
const SET = {
  live: true, armed: true, autoShares: false, shares: 5, maxOpen: undefined,
  maxOrderCost: null, liveBankroll: 100, paperBankroll: 100, riskPerTrade: 0.25, paperResetAt: null
};
const heldPos = (i) => ({
  seq: i, sym: 'BTC', ticker: 'HELD-' + i, side: 'YES', live: true,
  closeTime: `2026-08-30T2${i}:45:00Z`, cost: 5, contracts: 5
});
const tenantWith = n => ({
  rec: { book: { positions: Array.from({ length: n }, (_, i) => heldPos(i)), seq: n }, balance: 100, approved: true },
  get: k => SET[k],
  hasAccess: () => true
});
const candidate = {
  sym: 'ETH', market: { ticker: 'NEW-1', close_time: '2026-08-30T19:45:00Z' },
  side: 'YES', direction: 'UP', price: 0.55, pricePct: 55, strike: 1, spot: 1,
  confidence: 84, edgePt: 5, modelPct: 84, minutesLeft: 9, exchangeIndex: null
};
ok(!/limit/.test(String(trader.accountBlock(tenantWith(2), candidate))),
  'two positions open still allows a third');
ok(/at the 3 limit/.test(String(trader.accountBlock(tenantWith(3), candidate))),
  `three open positions refuses the fourth at the DEFAULT cap of 3 (got ${JSON.stringify(trader.accountBlock(tenantWith(3), candidate))})`);
ok(/at the 3 limit/.test(String(trader.accountBlock(tenantWith(7), candidate))),
  'and the cap keeps refusing past it');

console.log(`PASS grading + money arithmetic — ${checks} checks`);

