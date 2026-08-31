/**
 * The two dashboard features shipped on 2026-08-30, and the thresholds they turn on.
 *
 * ── why this file exists ──
 *
 * Both shipped without a suite, and a mutation test the same day proved it: bucketing hours by UTC
 * instead of Eastern, and moving the DOWN-book warn threshold from 0.65 to 0.01 so it can never
 * fire, both left all twelve suites green. A health indicator whose failure mode is "looks
 * healthier" is worse than no indicator, so the thresholds are pinned here.
 *
 * The direction block also had a real bug of exactly that shape, caught by the assertions below
 * before it ever misled anyone: written as `direction === 'DOWN' ? down : up`, every UNRECOGNISED
 * value — a legacy position saved before the field existed, a lowercase 'down' — fell into the UP
 * book, moving a DOWN loss out of the column being watched.
 *
 * Run: node test/dashboard.test.js
 */
const assert = require('assert');
const Module = require('module');

let ACCOUNTS = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './users') {
    return { all: () => ACCOUNTS, money: n => '$' + Number(n).toFixed(2) };
  }
  if (request === './trader') throw new Error('trader not started in this test');
  return origLoad.apply(this, arguments);
};
const data = require('../src/sitedata');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// A fixed epoch, so nothing here depends on when the suite runs.
const T0 = Date.UTC(2026, 7, 30, 20, 0, 0);
const pos = over => Object.assign({
  seq: 1, ticker: 'T', sym: 'BTC', side: 'NO', direction: 'DOWN', outcome: 'WIN', pnl: 1, live: true,
  contracts: 10, priceCents: 55, cost: 5.5, entryFee: 0.1, exitFee: 0,
  at: new Date(T0).toISOString(), exitAt: new Date(T0).toISOString()
}, over);
const withBook = positions => {
  ACCOUNTS = [{
    userId: 'u1', rec: { tag: 'tester', book: { positions } },
    get: k => ({ live: true, liveBankroll: 100, paperBankroll: 100 }[k])
  }];
};
const direction = positions => { withBook(positions); return data.publicState().direction; };
/** n settled DOWN positions, the first `wins` of them winners, newest first. */
const downBook = (n, wins) => Array.from({ length: n }, (_, i) => pos({
  seq: i, pnl: i < wins ? 2 : -3, outcome: i < wins ? 'WIN' : 'LOSS',
  at: new Date(T0 - i * 60000).toISOString(), exitAt: new Date(T0 - i * 60000).toISOString()
}));

// ── 1. the warn threshold, at the boundaries ────────────────────
//
// warn fires when the DOWN book's recent hit rate falls UNDER 0.65 on at least 8 settled trades.
// Both halves matter: too few trades and it cries wolf, too loose a threshold and it never speaks.
ok(direction(downBook(7, 2)).warn === false, '7 recent trades never warn, however bad the hit rate');
ok(direction(downBook(8, 2)).warn === true, '8 recent trades at a 25% hit DO warn');
const at65 = direction(downBook(20, 13));
ok(Math.abs(at65.down.recentHit - 0.65) < 1e-12, 'crafted a book at exactly 0.65');
eq(at65.warn, false, 'exactly 0.65 does NOT warn — the threshold is strictly under');
eq(direction(downBook(20, 12)).warn, true, '0.60 warns');
eq(direction(downBook(20, 20)).warn, false, 'a perfect DOWN book never warns');

// ── 2. an unrecognised direction must not be guessed as UP ───────
let d = direction([pos({ direction: undefined, side: 'NO', pnl: -4, outcome: 'LOSS' })]);
eq(d.up.n, 0, 'a NO position with no direction field does NOT land in the UP book');
eq(d.down.n, 1, 'it lands in the DOWN book, classified by its exchange side');
d = direction([pos({ direction: 'down', side: 'NO', pnl: -4, outcome: 'LOSS' })]);
ok(d.down.n === 1 && d.up.n === 0, 'a lowercase "down" does not flip the position to UP');
d = direction([pos({ direction: undefined, side: 'YES', pnl: 4 })]);
ok(d.up.n === 1 && d.down.n === 0, 'a YES position with no direction lands in UP');
d = direction([pos({ direction: undefined, side: undefined, pnl: 4 })]);
ok(d.up.n === 0 && d.down.n === 0, 'a position classifiable by neither is excluded, never guessed');

// ── 3. open, empty and unsettled books ──────────────────────────
d = direction([pos({ outcome: null, pnl: null }), pos({ outcome: null, pnl: null, side: 'YES', direction: 'UP' })]);
ok(d.down.recentHit === null && d.up.recentHit === null, 'an all-open book has a null hit, not 0');
eq(d.warn, false, 'an all-open book does not warn');
ok(d.open.down === 1 && d.open.up === 1, 'open exposure is counted per side');
ok(d.down.n === 0 && d.up.n === 0, 'open positions are excluded from the settled counts');
d = direction([]);
ok(d.down.n === 0 && d.open.down === 0 && d.warn === false, 'an empty book is safe');
d = direction([pos({ pnl: 0, outcome: 'LOSS' }), pos({ seq: 2, pnl: 5 })]);
ok(d.down.n === 2 && d.down.wins === 1, 'a pnl of exactly 0 is not counted a win');

// ── 4. the recent window is 30 PER SIDE ─────────────────────────
const mixed = downBook(40, 0).map((p, i) => ({ ...p, at: new Date(T0 - (100 + i) * 60000).toISOString(), exitAt: new Date(T0 - (100 + i) * 60000).toISOString() }));
for (let i = 0; i < 5; i++) {
  mixed.push(pos({ seq: 100 + i, side: 'YES', direction: 'UP', pnl: 3, at: new Date(T0 - i * 60000).toISOString(), exitAt: new Date(T0 - i * 60000).toISOString() }));
}
d = direction(mixed);
eq(d.down.recentN, 30, 'the DOWN window caps at 30');
eq(d.up.recentN, 5, 'the 5 UP trades are not crowded out by 40 DOWN ones');
eq(d.up.recentHit, 1, 'the UP hit rate is not diluted by the DOWN book');
ok(d.down.n === 40 && d.up.n === 5, 'the all-time counts still keep everything');

// ── 5. the open state serves to strangers, so it names nobody ────
withBook([pos({})]);
const st = JSON.stringify(data.publicState());
ok(!st.includes('tester'), 'publicState carries no account tag');
ok(!st.includes('"u1"'), 'publicState carries no userId');

console.log(`  direction health: ${checks} checks`);

// ── 6. hours() buckets by the EASTERN hour a trade was OPENED ─────
//
// Eastern, not UTC: "the best time to trade" is a wall-clock answer for a person in New York, and
// the two differ by four or five hours depending on daylight saving. Entry time, not settlement, so
// a row reads as "trades I open at 4pm do X".
const at = (iso, pnl, live = true) => pos({
  pnl, live, outcome: pnl > 0 ? 'WIN' : 'LOSS', at: iso, exitAt: iso
});
withBook([
  at('2026-08-30T20:15:00Z', 5, true),     // 16:15 EDT
  at('2026-08-30T20:45:00Z', -2, false),   // 16:45 EDT
  at('2026-08-31T03:30:00Z', 3, true),     // 23:30 EDT — the PREVIOUS day in Eastern
  at('2026-08-31T04:30:00Z', 1, true),     // 00:30 EDT
  at('2026-01-15T05:30:00Z', 2, true),     // 00:30 EST — winter, so the offset is five hours
  pos({ outcome: null, pnl: null }),       // still open — excluded
  pos({ pnl: null, outcome: 'WIN' })       // graded but no P&L — excluded
]);
const h = data.hours();
const H = h.hours;
eq(h.totalClosed, 5, 'only resolved, timestamped positions are bucketed');
eq(H.length, 24, 'there are 24 buckets whatever the data');
eq(H[16].taken, 2, 'both 16:xx EDT trades land in hour 16');
ok(H[16].wins === 1 && H[16].losses === 1, 'hour 16 is 1W/1L');
ok(Math.abs(H[16].net - 3) < 1e-9, 'hour 16 nets 5 + -2 = 3');
ok(H[16].live.taken === 1 && H[16].paper.taken === 1, 'hour 16 splits live from paper');
ok(Math.abs(H[16].live.net + H[16].paper.net - H[16].net) < 1e-9, 'the live/paper split sums to the hour');
eq(H[23].taken, 1, 'the 03:30Z trade buckets to 23:00 Eastern, not 03:00');
eq(H[0].taken, 2, 'both midnight-Eastern trades land in hour 0');
ok(H[3].taken === 0 && H[4].taken === 0, 'no UTC hour leaks into 03:00/04:00 Eastern');
eq(H[5].taken, 0, 'the winter 05:30Z trade is not in hour 5 — daylight saving is handled');
eq(H[1].hit, null, 'an empty hour has a null hit rate, not 0 and not NaN');
ok(H.every(b => Number.isFinite(b.net) && Number.isFinite(b.fees)), 'every bucket is numeric');
ok(Math.abs(H.reduce((a, b) => a + b.net, 0) - 9) < 1e-9, 'the buckets sum to the total net');
ok(H.reduce((a, b) => a + b.taken, 0) === h.totalClosed, 'the bucket counts sum to totalClosed');

// ── 7. the page renders these payloads without throwing ──────────
const page = require('../src/sitepage');
const html = page();
ok(/data-t=hours/.test(html), 'the Hours tab button is in the markup');
ok(/<section id=s-hours/.test(html), 'the Hours section exists for it to switch to');
ok(/Direction now/.test(html) && /DOWN book/.test(html), 'both direction cells are rendered');
for (const m of html.matchAll(/\$\(['"]([\w-]+)['"]\)/g)) {
  ok(new RegExp('\\bid=' + m[1] + '\\b').test(html), `$("${m[1]}") refers to an element that exists`);
}
ok(!/WEB_TOKEN\s*[:=]\s*['"][^'"]+/.test(html), 'no token value is baked into the served page');

console.log(`PASS dashboard signals — ${checks} checks`);


