/**
 * The admin advice rules.
 *
 * Every rule here is a mistake this bot has actually made or allowed, so each one is asserted
 * twice: that it fires when the condition holds, and — the half that matters more — that it stays
 * quiet when it does not. An advice panel that cries wolf is worse than no advice panel, because
 * the one real finding arrives in a list nobody reads any more.
 *
 * Run: node test/advice.test.js
 */
const assert = require('assert');
const advice = require('../src/advice');

let checks = 0;
const has = (found, code, what) => {
  assert.ok(found.some(f => f.code === code), `${what}: expected a ${code} finding, got ` +
    `[${found.map(f => f.code).join(', ')}]`);
  checks++;
};
const lacks = (found, code, what) => {
  assert.ok(!found.some(f => f.code === code), `${what}: did NOT expect ${code}, got ` +
    `[${found.map(f => f.code).join(', ')}]`);
  checks++;
};
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

/** A healthy armed account, which every case below varies by one field. */
const ok = {
  who: 'tofu.0001', userId: '384033277595484160',
  live: true, armed: true, keyed: true, keyFile: true,
  balance: 24.9, shares: 7, dailyStop: 8, todayRealised: 0,
  paperOpen: 0, liveOpen: 1, atRiskLive: 5.2
};
const one = over => advice.review([{ ...ok, ...over }], { day: '2026-08-28' });

// ── the healthy account produces nothing ────────────────────────
eq(one({}).length, 0, 'a well-configured armed account has no findings at all');

// ── size against the real balance ───────────────────────────────
// 30 contracts at 80c is $24 against a $24.90 balance: one trade is the account.
const big = one({ shares: 30 });
has(big, 'size-vs-balance', '30 contracts on $24.90');
assert.ok(/%/.test(big[0].text), 'says what share of the account one trade is'); checks++;
assert.ok(big[0].fix && /\d/.test(big[0].fix), 'and names a safer size'); checks++;
lacks(one({ shares: 7 }), 'size-vs-balance', '7 contracts (~$5.60) is a sane share of $24.90');
lacks(one({ shares: 30, balance: null }), 'size-vs-balance',
  'with no balance read yet there is no share to compute — silence beats a guess');
lacks(one({ shares: 30, live: false }), 'size-vs-balance',
  'a paper account cannot over-concentrate real money');

// ── armed but cannot pay for the order ──────────────────────────
has(one({ balance: 1.2, shares: 7, dailyStop: null }), 'cannot-afford',
  '$1.20 cannot buy 7 contracts even at 25c');
lacks(one({ balance: 1.2, shares: 7, dailyStop: null, armed: false }), 'cannot-afford',
  'not armed means no order is going out to be refused');

// ── a daily stop that can never trip ────────────────────────────
has(one({ dailyStop: 20 }), 'stop-too-big', 'a $20 stop on a $24.90 account stops nothing');
lacks(one({ dailyStop: 8 }), 'stop-too-big', 'a third of the account is a working stop');
lacks(one({ dailyStop: null }), 'stop-too-big', 'no stop set is a different question');

// ── the stop already hit ────────────────────────────────────────
const stopped = one({ dailyStop: 8, todayRealised: -8.5 });
has(stopped, 'stop-hit', 'today is past the limit');
assert.ok(/midnight/i.test(stopped.find(f => f.code === 'stop-hit').text),
  'says when it lifts, because "nothing is trading" otherwise reads as a dead bot'); checks++;
lacks(one({ dailyStop: 8, todayRealised: -2 }), 'stop-hit', 'still inside the limit');

// ── credentials ─────────────────────────────────────────────────
has(one({ keyed: false, keyFile: true }), 'key-unreadable', 'a key file that will not decrypt');
assert.ok(/KALSHI_KEY_SECRET/.test(one({ keyed: false, keyFile: true })
  .find(f => f.code === 'key-unreadable').text), 'and names the usual cause'); checks++;
has(one({ keyed: false, keyFile: false }), 'armed-no-key', 'armed with no credential at all');
lacks(one({ keyed: false, keyFile: false, armed: false }), 'armed-no-key',
  'no key while running paper is the normal state, not a finding');

// ── the dead switch ─────────────────────────────────────────────
has(one({ armed: false }), 'live-never-armed', 'live on, nothing armed: it is all filling paper');
lacks(one({}), 'live-never-armed', 'armed accounts are not nagged');

// ── paper left over after arming ────────────────────────────────
has(one({ paperOpen: 2 }), 'paper-settling', 'two paper positions still to settle while armed');
lacks(one({ paperOpen: 2, armed: false }), 'paper-settling',
  'paper positions in paper mode are just the book');

// ── fleet: the market that loses money ──────────────────────────
const fleet = advice.review([ok], {
  day: '2026-08-28',
  markets: [{ sym: 'SOL', n: 12, net: -18.4 }, { sym: 'BTC', n: 30, net: 42.1 }]
});
has(fleet, 'worst-market', 'SOL is 12 trades and -$18.40');
assert.ok(/SOL/.test(fleet.find(f => f.code === 'worst-market').text), 'names the market'); checks++;
lacks(advice.review([ok], { day: '2026-08-28', markets: [{ sym: 'SOL', n: 3, net: -4 }] }),
  'worst-market', 'three trades is not a verdict on a market');
lacks(advice.review([ok], { day: '2026-08-28', markets: [{ sym: 'BTC', n: 30, net: 42.1 }] }),
  'worst-market', 'nothing is losing money');

// ── shape and ordering ──────────────────────────────────────────
const many = advice.review(
  [{ ...ok, shares: 30, dailyStop: 20, paperOpen: 2 }],
  { day: '2026-08-28' }
);
assert.ok(many.length >= 3, 'several findings on one bad account'); checks++;
eq(many[0].severity, 'high', 'the most severe finding is first');
assert.ok(many.every(f => f.code && f.severity && f.text && f.who),
  'every finding names a code, a severity, a subject and what it means'); checks++;
eq(advice.review([], {}).length, 0, 'no accounts, no advice');

console.log(`PASS advice — ${checks} assertions (each rule fires, and stays quiet)`);
