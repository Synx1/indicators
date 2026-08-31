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
  rec: { book: { positions, seq: positions.length }, balance, approved: true },
  get: k => ({ ...SET, ...over })[k],
  // The owner's switch. Every case below is an ENABLED account unless it says otherwise, so the
  // guards under test are the ones being tested rather than this one.
  hasAccess: () => (over.approved === undefined ? true : over.approved)
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

// ── the directional-concentration cap (opt-in; blank = the historical no-cap behaviour) ──
// This bounds the SLOWER concentration the same-window rule misses: a book filling up all one way
// across DIFFERENT windows — the structural short that met the 08-07 rally and bled the live DOWN
// book. A YES held in the CLOSE window and a YES candidate in the OTHER window are same-direction,
// different-settlement, so ONLY this cap can stop them.
const oneYesElsewhere = [held(true, { closeTime: CLOSE, side: 'YES' })];
allows(tenant({}, oneYesElsewhere, 24.9), dec({ closeTime: OTHER, side: 'YES' }),
  'with no maxPerDir set, a second same-direction bet across windows is allowed — the default is unchanged');
blocks(tenant({ maxPerDir: 1 }, oneYesElsewhere, 24.9), dec({ closeTime: OTHER, side: 'YES' }),
  /1 UP position already open, at the 1 same-direction limit/,
  'maxPerDir=1 refuses the second UP bet even though it is a different window');
allows(tenant({ maxPerDir: 1 }, [held(true, { closeTime: CLOSE, side: 'NO' })], 24.9),
  dec({ closeTime: OTHER, side: 'YES' }),
  'the cap is per-direction: one DOWN open does not block an UP entry');
allows(tenant({ maxPerDir: 2 }, oneYesElsewhere, 24.9), dec({ closeTime: OTHER, side: 'YES' }),
  'maxPerDir=2 still allows the second same-direction bet; it is the third that is refused');
blocks(tenant({ maxPerDir: 2 },
  [held(true, { closeTime: CLOSE, side: 'NO' }), held(true, { closeTime: OTHER, side: 'NO', ticker: 'KXETH-A' })], 24.9),
  dec({ closeTime: '2026-08-28T23:15:00Z', side: 'NO', ticker: 'KXSOL-A' }),
  /2 DOWN positions already open, at the 2 same-direction limit/,
  'and the DOWN book is capped the same way, with the count and direction named');
allows(tenant({ maxPerDir: '' }, oneYesElsewhere, 24.9), dec({ closeTime: OTHER, side: 'YES' }),
  'a blank maxPerDir is no cap, exactly like leaving it unset');
// A paper position is not live exposure, so it must not consume a live directional slot.
allows(tenant({ maxPerDir: 1 }, [held(false, { closeTime: CLOSE, side: 'YES' })], 24.9),
  dec({ closeTime: OTHER, side: 'YES' }),
  'a PAPER same-direction position does not fill a live directional slot');

// ── the free-cash check measures the SHARD, not the account ──
// Kalshi holds cash per exchange shard and checks the order against the shard the market lives on.
// $24 on shard 0 with 2c on the crypto shard is a $24 balance that cannot buy one contract, which
// is the "400 insufficient balance" the account hit once the shard record existed.
const withShards = (shards, over = {}) => {
  const t = tenant(over, [], 24.2);
  t.rec.balanceShards = shards;
  return t;
};
const cryptoDec = { ...dec(), exchangeIndex: 2 };
blocks(withShards({ '0': 24.17, '2': 0.02 }), cryptoDec, /only \$0\.02 of it is on exchange shard 2/,
  'the money is on the wrong shard, and the refusal says so');
allows(withShards({ '0': 4.17, '2': 20.0 }), cryptoDec,
  'funded on the shard that matters, so it trades');
blocks(withShards({ '0': 24.17, '2': 0.02 }), cryptoDec, /Your balance is \$24\.20/,
  'and it still reports the account total, so the number is not a mystery');
allows(withShards(null), cryptoDec,
  'with no breakdown read yet it falls back to the total — a cold cache must not refuse everything');
allows(withShards({ '0': 24.17, '2': 0.02 }), { ...dec(), exchangeIndex: null },
  'and a market with no shard reported is judged on the total, as before');

// ── access comes before everything ──
// Without a key on the clock an account does not trade at all — not live, and not paper either,
// because a paper book built without access records trades nobody was entitled to run.
blocks(tenant({ approved: false }, [], 24.9), dec(), /no access key entered/,
  'an account with no key is refused before any other question is asked');
blocks(tenant({ approved: false, armed: false, live: false }, [], 24.9), dec(),
  /no access key entered/, 'and paper is refused too, not just live');
allows(tenant({ approved: true }, [], 24.9), dec(), 'an account with access is judged on its merits');

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
