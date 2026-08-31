/**
 * Kelly-proportional sizing — the one transferable piece of the $100→$457 challenge.
 *
 * ── why this file exists ──
 *
 * That overnight run was a PAPER ledger with no fill model, cherry-picked candidates and Kelly
 * compounding, so its headline return is not evidence of anything. But the SIZING scheme underneath it
 * is, and reconstructing it here (research-challenge-config.js) returned 3.1x on $30 at the live gate —
 * 2.6x once 2¢ of slippage is charged — against roughly 1.8x for flat sizing on the SAME 54 trades.
 *
 * The reason it is worth testing hard is that it is the only setting in this bot that can size a bet
 * from a number the MODEL produced. Flat sizing is wrong but bounded; Kelly sizing is right in
 * proportion to `confidence`, which means a confidence bug becomes a money bug. Every assertion below
 * exists because of that: the arithmetic, the three caps, and above all the guards that make a garbage
 * confidence produce ZERO contracts rather than an enormous position.
 *
 * Run: node test/kelly.test.js
 */
const assert = require('assert');
const Module = require('module');

// kellyShares() reads the book through book.openPositions, so the real module is used; only the
// network layer is stubbed, exactly as decide-gate.test.js does it.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return {
      create: () => ({
        get: async () => ({ data: {} }), post: async () => ({ data: {} }),
        interceptors: { request: { use() {} }, response: { use() {} } }
      }),
      get: async () => ({ data: {} }), post: async () => ({ data: {} })
    };
  }
  return origLoad.apply(this, arguments);
};
const trader = require('../src/trader');

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

/** The challenge's own numbers, which are also the schema defaults. */
const CH = { kellyFraction: 0.12, maxFraction: 0.07, maxPortfolioFraction: 0.35 };
const SET = {
  live: true, armed: true, autoShares: true, kellySizing: true, shares: 30,
  riskPerTrade: 0.25, maxOpen: 3, maxOrderCost: null,
  liveBankroll: null, paperBankroll: 100, paperResetAt: null, ...CH
};
// arguments.length rather than a default parameter, for the same reason dec() uses an `in` check:
// tenant({}, [], undefined) must actually hand the trader an undefined balance.
function tenant(over, positions, balance) {
  const bal = arguments.length >= 3 ? balance : 100;
  return {
    rec: { book: { positions: positions || [], seq: (positions || []).length }, balance: bal, approved: true },
    get: k => ({ ...SET, ...(over || {}) })[k],
    hasAccess: () => true
  };
}
// Written with an `in` check rather than default parameters: `dec({ confidence: undefined })` must
// actually pass undefined through, and a default parameter would silently substitute 84 — so the
// fail-closed assertions below would have been testing the happy path and passing for the wrong reason.
const dec = (o = {}) => {
  const price = 'price' in o ? o.price : 0.55;
  const confidence = 'confidence' in o ? o.confidence : 84;
  return {
    sym: 'BTC', market: { ticker: 'KXBTC-A', close_time: '2026-08-31T22:45:00Z' },
    side: 'NO', direction: 'DOWN', price, pricePct: Math.round(price * 100),
    strike: 1, spot: 1, confidence, modelPct: confidence, minutesLeft: 9, confirm: 4
  };
};
const held = (live, { cost = 10, ticker = 'KXETH-A' } = {}) =>
  ({ seq: Math.random(), sym: 'ETH', ticker, side: 'YES', closeTime: '2026-08-31T23:00:00Z', live, cost, contracts: 10 });

/** The formula, computed independently so the test is not just the implementation restated. */
const expected = (bank, p, q, atRisk = 0, cfg = CH) => {
  const edge = p - q;
  if (edge <= 0) return 0;
  const equity = bank + atRisk;
  const room = Math.max(0, equity * cfg.maxPortfolioFraction - atRisk);
  const perTrade = Math.min((edge / (1 - q)) * cfg.kellyFraction, cfg.maxFraction) * bank;
  return Math.max(0, Math.floor(Math.min(perTrade, room) / q));
};

// ── 1. the arithmetic, hand-checked ──────────────────────────────
//
// $100, 84% on a 55¢ contract: edge 0.29, kelly = 0.29/0.45 = 0.6444, ×0.12 = 0.07733 — which is over
// maxFraction 0.07, so the per-trade cap binds at $7.00 and buys floor(7/0.55) = 12 contracts.
eq(trader.kellyShares(tenant(), dec()), 12, '$100 at 84% on 55c buys 12 contracts, capped by maxFraction');
eq(trader.kellyShares(tenant(), dec()), expected(100, 0.84, 0.55), 'and matches the formula computed independently');

// A SMALLER edge must buy less. This is the entire point of Kelly over flat sizing: at 81% on 63¢ the
// edge is 0.18, kelly = 0.4865, ×0.12 = 0.0584 — now UNDER the 0.07 cap, so Kelly itself binds.
const small = trader.kellyShares(tenant(), dec({ price: 0.63, confidence: 81 }));
eq(small, expected(100, 0.81, 0.63), 'a thinner edge is sized by Kelly rather than by the cap');
ok(small < 12, `and buys fewer contracts than the fat edge did (${small} < 12)`);
// A FATTER edge is capped, not scaled indefinitely.
eq(trader.kellyShares(tenant(), dec({ price: 0.30, confidence: 95 })),
  expected(100, 0.95, 0.30), 'a very fat edge is bounded by maxFraction, not by Kelly');

// Size scales with the balance, because it is a fraction of it.
eq(trader.kellyShares(tenant({}, [], 1000), dec()), expected(1000, 0.84, 0.55),
  '10x the balance buys ~10x the contracts');
eq(trader.kellyShares(tenant({}, [], 30), dec()), expected(30, 0.84, 0.55),
  'and $30 is sized on $30');
ok(trader.kellyShares(tenant({}, [], 30), dec()) >= 1, '$30 still affords at least one contract');

// ── 2. no edge means no bet, not a small one ─────────────────────
//
// A non-positive edge is not a smaller position, it is the OTHER side of the market, which this bot
// cannot take. Written as `edge > 0` rather than `edge >= 0` because at exactly breakeven the fee makes
// the trade negative-expectancy.
eq(trader.kellyShares(tenant(), dec({ price: 0.84, confidence: 84 })), 0,
  'confidence exactly equal to the price is ZERO contracts — breakeven loses after fees');
// NOTE for a future mutation sweep: changing that guard to `edge >= 0` SURVIVES, and correctly so.
// At edge exactly 0 the arithmetic already yields 0 — kelly is 0, so budget is 0, so floor(0/q) is 0.
// The explicit guard is documentary rather than load-bearing, and no assertion can distinguish them.
// The guard stays because a reader should not have to derive that, and because a later refactor could
// make it load-bearing again.
eq(trader.kellyShares(tenant(), dec({ price: 0.90, confidence: 84 })), 0,
  'a price above the confidence is zero, never a negative or a floor of one');
eq(trader.kellyShares(tenant(), dec({ price: 0.8399, confidence: 84 })), expected(100, 0.84, 0.8399),
  'a hair of edge is allowed, and rounds to whatever it can afford');

// ── 3. garbage must produce ZERO, not an enormous position ───────
//
// This is the assertion that matters most. Kelly sizes from `confidence`, so a confidence bug becomes a
// money bug — and NaN fails every comparison, so an unguarded version would compute NaN contracts and
// Math.floor(NaN) is NaN, which downstream reads as "not >= 1" or worse, gets sent as an order size.
for (const junk of [NaN, undefined, null, Infinity, -Infinity, '84', {}, '']) {
  eq(trader.kellyShares(tenant(), dec({ confidence: junk })), 0,
    `a ${JSON.stringify(junk)} confidence buys nothing`);
  eq(trader.kellyShares(tenant(), dec({ price: junk })), 0,
    `a ${JSON.stringify(junk)} price buys nothing`);
}
for (const bad of [0, 1, 1.5, -0.2]) {
  eq(trader.kellyShares(tenant(), dec({ price: bad })), 0, `a price of ${bad} buys nothing`);
}
for (const bad of [0, -5, null, NaN, undefined]) {
  eq(trader.kellyShares(tenant({}, [], bad), dec()), 0, `a ${JSON.stringify(bad)} balance buys nothing`);
}
// A missing or nonsense risk setting must fail CLOSED rather than falling back to something generous.
for (const key of ['kellyFraction', 'maxFraction', 'maxPortfolioFraction']) {
  for (const bad of [0, -1, null, NaN, undefined, 'x']) {
    eq(trader.kellyShares(tenant({ [key]: bad }), dec()), 0,
      `a ${JSON.stringify(bad)} ${key} buys nothing — it fails closed`);
  }
}

// ── 4. the portfolio cap, which is what bounds a BOOK ────────────
//
// Per-trade caps do not bound a book: three positions each inside the 7% limit can still put a fifth of
// the account into one settlement window. maxPortfolioFraction is the limit that actually holds when
// several signals fire together, and it is measured on EQUITY (cash + what is already at risk) so that
// committing money does not silently raise the ceiling for the next trade.
eq(trader.kellyShares(tenant({}, [held(true, { cost: 30 })]), dec()),
  expected(100, 0.84, 0.55, 30), 'with $30 already at risk the cap is computed on $130 equity');
// Enough at risk and the room goes to zero — no further position, however good the edge.
eq(trader.kellyShares(tenant({}, [held(true, { cost: 100 })]), dec()), 0,
  '$100 at risk against a 35% portfolio cap leaves no room at all');
// The cap only BINDS once room falls below the per-trade budget: at $100 balance and a 7% per-trade
// cap, room = (100+a)*0.35 - a beats $7 until a exceeds ~$43. Below that an open position is invisible
// to the sizing, which is worth pinning as much as the binding case — it is why $30 at risk above
// produced the same 12 contracts rather than fewer.
ok(trader.kellyShares(tenant({}, [held(true, { cost: 30 })]), dec()) <=
   trader.kellyShares(tenant(), dec()),
  'an open position never RAISES the next size');
eq(trader.kellyShares(tenant({}, [held(true, { cost: 50 })]), dec()),
  expected(100, 0.84, 0.55, 50), '$50 at risk pushes room under the per-trade cap, so the cap binds');
ok(trader.kellyShares(tenant({}, [held(true, { cost: 50 })]), dec()) <
   trader.kellyShares(tenant(), dec()),
  'and THEN the size is strictly smaller');
// A PAPER position is not money at risk, so it must not consume live portfolio room — the same scoping
// accountBlock() applies to its three guards, and getting it wrong would let stale paper rows shrink
// every live bet.
eq(trader.kellyShares(tenant({}, [held(false, { cost: 100 })]), dec()),
  expected(100, 0.84, 0.55, 0), 'a paper position does not eat live portfolio room');
// ...and in paper mode the paper book guards itself the same way: an open paper position both reduces
// free paper cash and counts toward the paper portfolio cap.
ok(trader.kellyShares(tenant({ live: false, armed: false }, [held(false, { cost: 20 })]), dec()) <=
   trader.kellyShares(tenant({ live: false, armed: false }), dec()),
  'in paper mode an open PAPER position never raises the next paper size');

// The three caps are checked TOGETHER, so the binding one is whichever is smallest.
eq(trader.kellyShares(tenant({ maxFraction: 0.01 }), dec()), expected(100, 0.84, 0.55, 0,
  { ...CH, maxFraction: 0.01 }), 'a tight per-trade cap binds');
eq(trader.kellyShares(tenant({ maxPortfolioFraction: 0.02 }), dec()), expected(100, 0.84, 0.55, 0,
  { ...CH, maxPortfolioFraction: 0.02 }), 'a tight portfolio cap binds instead');
eq(trader.kellyShares(tenant({ kellyFraction: 0.01 }), dec()), expected(100, 0.84, 0.55, 0,
  { ...CH, kellyFraction: 0.01 }), 'and a tight Kelly fraction binds when it is the smallest');

// ── 5. it is an auto-size MODE, not a separate switch ────────────
//
// Kelly needs a balance to be a fraction of, so it is meaningless with fixed sizing. Gating it behind
// autoShares keeps "how big is a position" one decision with one owner rather than two switches that
// can contradict each other.
eq(trader.sharesFor(tenant({ autoShares: false, shares: 7 }), dec()), 7,
  'with auto size OFF the fixed share count wins, whatever kellySizing says');
eq(trader.sharesFor(tenant({ autoShares: true, kellySizing: false }), dec()),
  Math.floor((100 * 0.25) / trader.MAX_PRICE),
  'with auto size on and Kelly off, flat riskPerTrade sizing is used');
eq(trader.sharesFor(tenant({ autoShares: true, kellySizing: true }), dec()),
  trader.kellyShares(tenant(), dec()), 'and with both on, Kelly decides');
// Kelly is MORE conservative than the flat 25% default here, which is the point worth knowing: it is
// not a way to bet more, it is a way to bet in proportion to the edge.
ok(trader.kellyShares(tenant(), dec()) < Math.floor((100 * 0.25) / trader.MAX_PRICE),
  'Kelly at the challenge settings sizes SMALLER than a flat 25% risk, not larger');

console.log(`PASS Kelly sizing — ${checks} checks`);
