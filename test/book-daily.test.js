/**
 * The daily high-water mark, and the live/paper split that has to stay watertight.
 *
 * Both exist because the panel showed `Today +$82.98 / 10 closed` (paper) directly above
 * `All time +$0.00 / 0 closed` (live) and the two read as a contradiction. They were measuring
 * different books. Separating them is only useful if the separation is exact, so this asserts the
 * arithmetic rather than trusting a filter to be applied everywhere.
 *
 * `day` is passed in rather than read from the clock: a test that only passes on the day it was
 * written is not a test.
 *
 * Run: node test/book-daily.test.js
 */
const assert = require('assert');
const book = require('../src/book');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

// Midnight ET is 04:00Z in August, so 14:00Z–23:00Z is unambiguously the same ET day.
let seq = 0;
const closed = (exitAt, pnl, live) => ({
  seq: ++seq, sym: 'BTC', outcome: 'settled', exitAt, pnl, live,
  cost: 10, contracts: 10, entryFee: 0.1, exitFee: 0
});
const held = live => ({ seq: ++seq, sym: 'ETH', live, cost: 7.5, contracts: 10 });

const b = {
  startedAt: '2026-08-27T00:00:00Z',
  seq,
  positions: [
    closed('2026-08-27T18:00:00Z', 10, false),   // yesterday, paper
    closed('2026-08-28T14:00:00Z', 20, false),   // today, paper — the day's high is here
    closed('2026-08-28T15:00:00Z', -5, false),   // today, paper — and it gave some back
    closed('2026-08-28T16:00:00Z', 2, true),     // today, live
    held(false),                                  // still open, paper
    held(true)                                    // still open, live
  ]
};

// ── paper, with the day pinned ──────────────────────────────────
const paper = book.equity(b, { start: 100, liveOnly: false, day: '2026-08-28' });
eq(paper.equity, 125, 'paper equity walks 100 → 110 → 130 → 125');
eq(paper.realised, 25, 'paper realised is the whole curve');
eq(paper.peak, 130, 'all-time paper peak');
eq(paper.todayStart, 110, "today opened at yesterday's close, not at `start`");
eq(paper.todayPeak, 130, 'the daily high is the best point reached TODAY');
eq(paper.todayNet, 15, "today's realised is +20 -5, not the all-time 25");
eq(paper.todayN, 2, 'two paper positions closed today');
eq(paper.fromPeak, 5, 'currently $5 below the high');
eq(paper.atRisk, 7.5, 'only the open PAPER position is at risk here');

// ── live, same book, same day ───────────────────────────────────
const live = book.equity(b, { start: 24, liveOnly: true, day: '2026-08-28' });
eq(live.equity, 26, 'live equity is 24 + 2 and knows nothing of the paper book');
eq(live.realised, 2, 'live realised excludes every paper trade');
eq(live.todayStart, 24, 'live opened today at its start, having closed nothing before');
eq(live.todayPeak, 26, 'live daily high');
eq(live.todayNet, 2, 'live realised today');
eq(live.todayN, 1, 'one live position closed today');
eq(live.atRisk, 7.5, 'only the open LIVE position is at risk here');

// The split must be total: the two nets cannot overlap, and together they are the whole book.
const both = book.equity(b, { start: 0, day: '2026-08-28' });
eq(both.realised, paper.realised + live.realised, 'live + paper = the entire realised book');

// ── a day with nothing closed on it ─────────────────────────────
const quiet = book.equity(b, { start: 100, liveOnly: false, day: '2026-08-29' });
eq(quiet.todayNet, 0, 'a day with no closes realised nothing');
eq(quiet.todayStart, 125, 'and opened where the curve already stood');
eq(quiet.todayPeak, 125, 'so its high is that same figure, not the all-time peak');
eq(quiet.peak, 130, 'while the all-time peak is untouched by the quiet day');

// ── an empty book must not report a phantom high ─────────────────
const empty = book.equity({ positions: [] }, { start: 50, day: '2026-08-28' });
eq(empty.equity, 50, 'an empty book sits at its start');
eq(empty.todayPeak, 50, 'and its daily high is that start');
eq(empty.todayNet, 0, 'having realised nothing');

// ── the paper baseline still works with the day pinned ──────────
// paperResetAt re-baselines the paper curve; the daily figures must respect that window too.
const since = book.equity(b, {
  start: 100, liveOnly: false, day: '2026-08-28',
  sinceMs: new Date('2026-08-28T00:00:00Z').getTime()
});
eq(since.n, 2, 'only the two paper closes after the baseline count');
eq(since.todayNet, 15, 'and today is still +20 -5');
eq(since.todayStart, 100, 'with today opening at the re-baselined start');

console.log(`PASS book-daily — ${checks} assertions (daily high-water mark, live/paper split)`);
