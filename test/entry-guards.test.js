/**
 * The entry guards, and which book they are allowed to count.
 *
 * A paper position is not exposure — no money is at stake — so it must not consume a LIVE
 * account's position cap, its per-ticker slot, or its correlation slot. src/book.js already says
 * this about `atRisk` in as many words ("counting them against a live portfolio cap made a week of
 * paper trading suppress real entries, and enforced the cap against a book that was partly
 * imaginary"), and the free-cash check honours it. The three guards in accountBlock() did not.
 *
 * It showed up the moment arming started skipping paper instead of filling it: two paper positions
 * left over from before the arm were silently holding two of three live slots, and a signal landing
 * in the same window as one of them would have been refused outright.
 *
 * The rule asserted here is compare like with like: the guards scope to the book this entry will
 * actually land in — live when the account is armed, paper otherwise.
 *
 * Run: node test/entry-guards.test.js
 */
const assert = require('assert');
const trader = require('../src/trader');

let checks = 0;
const CLOSE = '2026-08-28T22:45:00Z';
const OTHER = '2026-08-28T23:00:00Z';

const SET = {
  live: true, armed: true, autoShares: false, shares: 7,
  maxOpen: 3, maxOrderCost: null, liveBankroll: 24, paperBankroll: 100,
  riskPerTrade: 0.25, paperResetAt: null
};
const tenant = (over, positions, balance = null) => ({
  rec: { book: { positions, seq: positions.length }, balance },
  get: k => ({ ...SET, ...over })[k]
});
/** An open position: no `outcome`, so the book counts it as held. */
const held = (live, { ticker = 'KXBTC-A', closeTime = CLOSE, side = 'YES', sym = 'BTC' } = {}) =>
  ({ seq: Math.random(), sym, ticker, side, closeTime, live, cost: 5, contracts: 7 });
const dec = ({ ticker = 'KXBTC-B', closeTime = OTHER, side = 'YES' } = {}) => ({
  sym: 'BTC', market: { ticker, close_time: closeTime }, side,
  direction: side === 'YES' ? 'UP' : 'DOWN',
  price: 0.70, pricePct: 70, strike: 1, spot: 1,
  confidence: 90, edgePt: 5, modelPct: 90, minutesLeft: 8
});

const blocks = (t, d, re, what) => {
  const why = trader.accountBlock(t, d);
  assert.ok(why, `${what}: expected a refusal, got none`);
  assert.ok(re.test(why), `${what}: refusal was "${why}", expected /${re.source}/`);
  checks++;
};
const allows = (t, d, what) => {
  const why = trader.accountBlock(t, d);
  assert.strictEqual(why, null, `${what}: expected no refusal, got "${why}"`);
  checks++;
};

// ── the position cap counts the book the entry lands in ──
const threePaper = [held(false), held(false, { ticker: 'KXETH-A' }), held(false, { ticker: 'KXSOL-A' })];
allows(tenant({}, threePaper, 24.9), dec(),
  'armed with three PAPER positions open: none of them is money, so the live cap is untouched');
blocks(tenant({}, [held(true), held(true, { ticker: 'KXETH-A' }), held(true, { ticker: 'KXSOL-A' })], 24.9),
  dec(), /at the 3 limit/, 'armed with three LIVE positions: the cap applies');
blocks(tenant({ armed: false }, threePaper, 24.9), dec(), /at the 3 limit/,
  'in paper mode the paper cap still applies — the guard is scoped, not removed');
allows(tenant({ armed: false }, [held(true), held(true, { ticker: 'KXETH-A' }), held(true, { ticker: 'KXSOL-A' })], 24.9),
  dec(), 'and a paper entry is not capped by live positions either');

// ── one position per ticker, per book ──
allows(tenant({}, [held(false, { ticker: 'KXBTC-B' })], 24.9), dec({ ticker: 'KXBTC-B' }),
  'a PAPER position on this round does not stop the live entry — different books');
blocks(tenant({}, [held(true, { ticker: 'KXBTC-B' })], 24.9), dec({ ticker: 'KXBTC-B' }),
  /already holding this round/, 'a LIVE position on this round does');

// ── the correlation guard, same direction and same settlement ──
allows(tenant({}, [held(false, { closeTime: CLOSE, side: 'YES' })], 24.9),
  dec({ closeTime: CLOSE, side: 'YES' }),
  'a paper bet in that window carries no leverage, so it cannot make one bet twice');
blocks(tenant({}, [held(true, { closeTime: CLOSE, side: 'YES', sym: 'ETH' })], 24.9),
  dec({ closeTime: CLOSE, side: 'YES' }), /same direction, same settlement/,
  'a live bet in that window does — this is the rule that saved the bankroll on 2026-08-26');
allows(tenant({}, [held(true, { closeTime: CLOSE, side: 'NO' })], 24.9),
  dec({ closeTime: CLOSE, side: 'YES' }),
  'the OPPOSITE direction in the same window still hedges and is still allowed');

// ── guards that must not have moved ──
blocks(tenant({}, [], 1.0), dec(), /only \$0\.30 is free|but only/,
  'the free-cash refusal still fires and still shows its arithmetic');
blocks(tenant({ shares: 0, autoShares: false }, [], 24.9), dec(), /shares per trade is not set/,
  'an unset size is still refused');
blocks(tenant({ maxOrderCost: 2 }, [], 24.9), dec(), /per-order cap/,
  'the per-order cap still applies');
blocks(tenant({ shares: 30 }, [], 24.9), dec(), /over half of the/,
  'and so does the half-bankroll ceiling');
allows(tenant({}, [], 24.9), dec(), 'a clean armed account with room takes the trade');

console.log(`PASS entry-guards — ${checks} assertions (paper never blocks live, and vice versa)`);
