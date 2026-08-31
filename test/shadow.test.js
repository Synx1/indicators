/**
 * The shadow book: the out-of-sample sample that the entry-ceiling decision rests on.
 *
 * ── why this file exists ──
 *
 * Every strategy argument on 2026-08-31 collapsed to one unresolved number — is the win rate the
 * backtest's 83.9% or the live book's 73%? — and the sub-question that mattered most, "does the edge
 * hold at DEARER entries?", had no out-of-sample evidence at all, because MAX_PRICE means the live
 * book cannot contain a single entry above 65¢.
 *
 * src/shadow.js exists to answer it with measurement instead of assumption. So the failure modes worth
 * pinning are the ones that would make it answer WRONGLY while still looking healthy:
 *
 *   - DOUBLE COUNTING. A pass runs every POLL_MS and a market stays too-dear for minutes. If record()
 *     were not idempotent per ticker, one signal would enter the sample dozens of times and the win
 *     rate would be weighted by how long each market sat in the band rather than by signals. The
 *     number would still look plausible.
 *   - GRADING DRIFT. A shadow win must mean exactly what a real win means, so settle() takes the
 *     trader's own gradeWin rather than reimplementing the comparison.
 *   - PREMATURE VERDICTS. `enough` must not fire under MIN_SAMPLE. Reading a win rate off a handful of
 *     trades is the specific mistake that has cost this bot the most.
 *   - BAND EDGES. The bands must start exactly where the live ceiling stops, or the shadow sample and
 *     the real book overlap and stop being comparable.
 *
 * Run: node test/shadow.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A scratch DATA_DIR, so the real shadow book is never touched and persistence can be tested for real.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-test-'));
process.env.DATA_DIR = DIR;
const shadow = require('../src/shadow');

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

/** The real truth table, exactly as trader.gradeWin defines it. */
const gradeWin = (side, result) =>
  (side === 'YES' && result === 'yes') || (side === 'NO' && result === 'no');

const CLOSED = new Date(Date.now() - 60000).toISOString();
const cand = over => ({
  ticker: 'T1', sym: 'BTC', side: 'NO', price: 0.67,
  confidence: 84, confirm: 4, closeTime: CLOSED, ...over
});

shadow.init({ log: () => {} });

// ── 1. the bands start where the live ceiling stops ──────────────
//
// If a band began below 65¢ the shadow sample would overlap the real book and the comparison would be
// meaningless; if it began above, the slice immediately above the ceiling — the only one a ceiling
// change would actually buy — would go unmeasured.
eq(shadow.bandOf(0.65), null, 'exactly the live ceiling is NOT shadowed — that price is already traded');
eq(shadow.bandOf(0.6501), '65-70c', 'a hair above the ceiling is the first shadow band');
eq(shadow.bandOf(0.70), '65-70c', 'band edges are inclusive at the top');
eq(shadow.bandOf(0.7001), '70-75c', 'and exclusive at the bottom, so no price lands in two bands');
eq(shadow.bandOf(0.75), '70-75c', '75c closes the middle band');
eq(shadow.bandOf(0.80), '75-80c', '80c closes the last one');
eq(shadow.bandOf(0.8001), null, 'above SHADOW_MAX nothing is recorded — the question is the next slice up');
eq(shadow.bandOf(0.10), null, 'and a cheap price is not a shadow at all');
for (const junk of [NaN, undefined, null, Infinity, '0.67', {}]) {
  eq(shadow.bandOf(junk), null, `a ${JSON.stringify(junk)} price has no band`);
}

// SHADOW_MAX and the bands are two halves of ONE decision, split across two files: trader.js uses
// SHADOW_MAX to decide whether to offer a candidate at all, and bandOf() decides whether to keep it.
// If they drift, the failure is silent in both directions — a higher SHADOW_MAX offers candidates that
// bandOf then discards, and a lower one means the top band never receives anything and reads as
// "no data" forever rather than as a bug.
eq(shadow.SHADOW_MAX, shadow.BANDS[shadow.BANDS.length - 1][1],
  'SHADOW_MAX equals the top of the highest band — the two are one decision in two files');
eq(shadow.BANDS[0][0], 0.65, 'and the lowest band starts exactly at the live ceiling');
for (let i = 1; i < shadow.BANDS.length; i++) {
  eq(shadow.BANDS[i][0], shadow.BANDS[i - 1][1],
    `band ${i} starts where band ${i - 1} ends — no price falls in a gap between them`);
}
ok(shadow.bandOf(shadow.SHADOW_MAX) !== null, 'SHADOW_MAX itself is inside a band, not just past one');
eq(shadow.bandOf(shadow.SHADOW_MAX + 0.0001), null, 'and a hair above it is outside every band');

// ── 2. idempotence: one signal is one row, however many passes see it ──
//
// The mutation that matters. A market sits too-dear for minutes while a pass runs every POLL_MS, so
// without the per-ticker check the same signal enters 20+ times and the win rate becomes a measure of
// how long each market lingered rather than of whether the signal was right.
shadow._reset();
ok(shadow.record(cand()), 'the first sighting is recorded');
eq(shadow.size, 1, 'one row');
for (let i = 0; i < 25; i++) shadow.record(cand());
eq(shadow.size, 1, '25 further passes over the SAME ticker add nothing');
eq(shadow.record(cand({ ticker: 'T2' })).ticker, 'T2', 'a different ticker is a different signal');
eq(shadow.size, 2, 'and is recorded');
// Out-of-range prices are refused rather than stored with a null band.
eq(shadow.record(cand({ ticker: 'T3', price: 0.60 })), null, 'a 60c candidate is not shadowed');
eq(shadow.record(cand({ ticker: 'T4', price: 0.95 })), null, 'nor a 95c one');
eq(shadow.size, 2, 'neither reached the book');
// A row must carry everything a later verdict needs, and nothing about a person.
const row = shadow.record(cand({ ticker: 'T5', price: 0.72, side: 'YES', confidence: 88 }));
eq(row.band, '70-75c', 'the band is resolved at record time');
eq(row.pricePct, 72, 'the price is kept in cents for display');
eq(row.side, 'YES', 'and the side, because grading needs it');
eq(row.outcome, null, 'a fresh row is ungraded');
ok(!('who' in row) && !('userId' in row) && !('cost' in row) && !('pnl' in row),
  'a shadow row names no person and carries no money — it is a fact about the signal');
// A malformed side must not become a third category that grades as neither.
eq(shadow.record(cand({ ticker: 'T6', side: 'up' })).side, 'NO', 'an unrecognised side normalises to NO');

// ── 3. grading goes through the REAL truth table ──────────────────
shadow._reset();
shadow.record(cand({ ticker: 'W1', side: 'NO' }));
eq(shadow.settle('W1', 'no', gradeWin).won, true, 'a NO on a no market WON');
eq(shadow.settle('W1', 'yes', gradeWin), null, 'and a settled row is never re-graded');
shadow.record(cand({ ticker: 'W2', side: 'NO' }));
eq(shadow.settle('W2', 'yes', gradeWin).won, false, 'a NO on a yes market LOST');
shadow.record(cand({ ticker: 'W3', side: 'YES' }));
eq(shadow.settle('W3', 'yes', gradeWin).outcome, 'WIN', 'a YES on a yes market WON');
// An unresolved market must leave the row OPEN rather than grading it as a loss. Grading "not yet
// settled" as a loss would understate every band's win rate and argue against a ceiling raise on the
// strength of markets that had not finished.
shadow.record(cand({ ticker: 'P1' }));
for (const junk of ['', null, undefined, 'void', 'settled', 'pending', 0, 1, {}, []]) {
  eq(shadow.settle('P1', junk, gradeWin), null, `a ${JSON.stringify(junk)} result leaves the row open`);
}
// CASE is normalised before grading, deliberately: resultFor() already lowercases what Kalshi returns,
// and a shadow row that failed to settle because the exchange sent "YES" would sit pending forever
// while the real book graded the same market fine.
shadow.record(cand({ ticker: 'C1', side: 'NO' }));
eq(shadow.settle('C1', 'NO', gradeWin).won, true, 'an upper-case NO result still grades');
shadow.record(cand({ ticker: 'C2', side: 'YES' }));
eq(shadow.settle('C2', 'Yes', gradeWin).won, true, 'and a mixed-case Yes does too');
eq(shadow.pending().some(e => e.ticker === 'P1'), true, 'P1 is still pending, not silently lost');
eq(shadow.settle('NOSUCH', 'yes', gradeWin), null, 'settling an unknown ticker is a no-op, not a throw');

// ── 4. the report, and the verdict it is allowed to reach ─────────
//
// `enough` is the guard on the whole exercise. This bot's expensive mistakes came from reading a win
// rate off a handful of trades — the backtest's two 100% coins were 7 and 9 — so a band must not be
// allowed to claim anything until MIN_SAMPLE settles.
shadow._reset();
const N = shadow.MIN_SAMPLE;
for (let i = 0; i < N - 1; i++) {
  shadow.record(cand({ ticker: 'A' + i, price: 0.67, side: 'NO' }));
  shadow.settle('A' + i, 'no', gradeWin);            // every one a win
}
let rep = shadow.report();
let b0 = rep.bands.find(b => b.band === '65-70c');
eq(b0.n, N - 1, `${N - 1} settled rows are counted`);
eq(b0.hit, 1, 'all of them won');
eq(b0.enough, false, `but ${N - 1} is still under MIN_SAMPLE, so no verdict is claimed`);
shadow.record(cand({ ticker: 'Alast', price: 0.67, side: 'NO' }));
shadow.settle('Alast', 'no', gradeWin);
rep = shadow.report();
b0 = rep.bands.find(b => b.band === '65-70c');
eq(b0.n, N, 'the boundary row lands');
eq(b0.enough, true, `and exactly MIN_SAMPLE is enough — the threshold is inclusive`);

// margin = win% − avgEntry, which on a binary IS the edge per contract because breakeven equals the
// price paid. A band that wins exactly as often as its price implies has ZERO edge, not a small one,
// and that is the number a ceiling decision turns on.
shadow._reset();
for (let i = 0; i < 10; i++) {
  shadow.record(cand({ ticker: 'M' + i, price: 0.70, side: 'NO' }));
  shadow.settle('M' + i, i < 7 ? 'no' : 'yes', gradeWin);      // 7 of 10 win, at 70c
}
rep = shadow.report();
b0 = rep.bands.find(b => b.band === '65-70c');
eq(b0.hit, 0.7, '7 of 10 at 70c');
eq(b0.margin, 0, 'winning exactly as often as the price implies is ZERO edge, not a positive one');
eq(b0.avgEntry, 0.70, 'and the average entry is reported so the margin can be checked by hand');
shadow._reset();
for (let i = 0; i < 10; i++) {
  shadow.record(cand({ ticker: 'L' + i, price: 0.70, side: 'NO' }));
  shadow.settle('L' + i, i < 6 ? 'no' : 'yes', gradeWin);      // 6 of 10 — below breakeven
}
b0 = shadow.report().bands.find(b => b.band === '65-70c');
ok(b0.margin < 0, 'winning LESS often than the price implies is a negative margin — it would have lost');

// Pending rows are counted but never graded into the win rate.
shadow._reset();
shadow.record(cand({ ticker: 'PA', price: 0.67 }));
shadow.record(cand({ ticker: 'PB', price: 0.67 }));
shadow.settle('PA', 'no', gradeWin);
rep = shadow.report();
b0 = rep.bands.find(b => b.band === '65-70c');
eq(b0.n, 1, 'only the settled row is in the sample');
eq(b0.pending, 1, 'the open one is reported separately');
eq(b0.hit, 1, 'and does not drag the win rate — an unfinished market is not a loss');
eq(rep.total, 2, 'the total counts both');
eq(rep.settled, 1, 'settled counts one');
eq(rep.pending, 1, 'pending counts one');
eq(rep.liveCeiling, 0.65, 'the report states the ceiling it is measured against');

// ── 5. it survives a restart, because the answer takes days ──────
shadow._reset();
shadow.record(cand({ ticker: 'PERSIST-1', price: 0.72, side: 'YES' }));
shadow.settle('PERSIST-1', 'yes', gradeWin);
shadow.record(cand({ ticker: 'PERSIST-2', price: 0.78, side: 'NO' }));
ok(shadow.flush(), 'the book writes to disk');
ok(fs.existsSync(shadow.FILE), 'the file exists where DATA_DIR says it should');
const raw = JSON.parse(fs.readFileSync(shadow.FILE, 'utf8'));
eq(raw.entries.length, 2, 'both rows persisted');
ok(!/"who"|"userId"|"pnl"|"cost"|"balance"/.test(JSON.stringify(raw)),
  'and nothing about a person or their money reached the disk');
// A fresh init must read them back, graded state included.
shadow.init({ log: () => {} });
eq(shadow.size, 2, 'a restart reloads the sample rather than resetting it');
const after = shadow.report();
eq(after.settled, 1, 'the settled row is still settled');
eq(after.pending, 1, 'and the open one is still open');
// A corrupt file must not take the bot down with it.
fs.writeFileSync(shadow.FILE, '{not json at all');
shadow.init({ log: () => {} });
eq(shadow.size, 0, 'an unreadable shadow book starts empty rather than throwing');
ok(shadow.record(cand({ ticker: 'AFTER-CORRUPT', price: 0.67 })), 'and keeps working afterwards');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS shadow book — ${checks} checks`);
