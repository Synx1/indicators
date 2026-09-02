/**
 * The chart's observation series: bounded, honest about missing numbers, and unable to reach a decision.
 *
 * ── the property that matters most ──
 *
 * src/series.js exists so a chart can show the candles and indicators the favourite gate deliberately does
 * NOT read. The one way that could become dangerous is if the recorder ever grew a return value a decision
 * consumed, or threw where a decision would catch it and skip. So `record()` is asserted to swallow
 * everything and to answer only true/false, and the trader calls it inside its own try/catch.
 *
 * ── the trap this file is really guarding ──
 *
 * `Number(null) === 0` passes a finite check. Three separate false results in this project came from that,
 * and here it would put a spot of 0 on a price chart — a plausible-looking line through a period where the
 * feed was dead. Every numeric field is asserted to store null rather than 0 when it is absent.
 *
 * Run: node test/series.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'series-test-'));
process.env.DATA_DIR = DIR;

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

const series = require('../src/series');
series.init({ log: () => {} });

// ── it stores what it was given, and null for what it was not ──
series.record({ sym: 'BTC', at: 1000, spot: 77000.5, strike: 77010, yesAsk: 0.87, yesBid: 0.86,
  noAsk: 0.14, minutesLeft: 9.2, rsi: 55.5, gapBps: -12.3, drift10Bps: 4, realizedVolBps: 41,
  volumeRatio: 1.2, taken: true });
let p = series.forSym('BTC')[0];
eq(p.spot, 77000.5, 'the spot round-trips');
eq(p.taken, true, 'taken comes back a boolean, not a 1');
eq(p.reason, null, 'a taken pass carries no skip reason');

series.record({ sym: 'BTC', at: 2000, spot: null, strike: undefined, yesAsk: NaN, yesBid: 'x',
  noAsk: Infinity, minutesLeft: null, taken: false, reason: 'fav-off-band' });
p = series.forSym('BTC')[1];
for (const k of ['spot', 'strike', 'yesAsk', 'yesBid', 'noAsk', 'minutesLeft', 'rsi', 'gapBps']) {
  eq(p[k], null, `an absent ${k} is null, NEVER 0 — a 0 would draw as a real price`);
}
eq(p.reason, 'fav-off-band', 'the skip reason is kept, so the chart can say why');
eq(p.taken, false, 'and it did not trade');

// ── bounded, per coin ──
for (let i = 0; i < series.MAX_POINTS + 40; i++) series.record({ sym: 'ETH', at: 10000 + i, spot: i });
eq(series.forSym('ETH').length, series.MAX_POINTS, 'the ring is capped');
eq(series.forSym('ETH')[series.MAX_POINTS - 1].spot, series.MAX_POINTS + 39, 'and it keeps the NEWEST');
eq(series.forSym('BTC').length, 2, 'one coin filling up does not evict another');
eq(series.forSym('SOL').length, 0, 'an unseen coin is empty, not an error');

// ── it cannot break the caller ──
eq(series.record({}), false, 'no symbol, no record');
eq(series.record(null), false, 'null does not throw');
eq(series.record(undefined), false, 'undefined does not throw');
const circular = { sym: 'BTC', spot: 1 }; circular.self = circular;
eq(series.record(circular), true, 'a circular extra field is ignored, not fatal');

// ── persistence ──
ok(series.flush(), 'it writes');
ok(fs.existsSync(series.FILE), 'where DATA_DIR says it should');
const raw = JSON.parse(fs.readFileSync(series.FILE, 'utf8'));
eq(raw.cols, series.COLS, 'the file records its own column order');
// A row of the wrong width is a format change, not data: charting a column shifted by one would look
// like a real price and be a lie, so it is dropped rather than expanded.
raw.coins.BTC.push([1, 2, 3]);
raw.coins.BTC.push(null);
fs.writeFileSync(series.FILE, JSON.stringify(raw));
series.init({ log: () => {} });
eq(series.forSym('BTC').length, 3, 'short rows and nulls are dropped on load');
eq(series.forSym('ETH').length, series.MAX_POINTS, 'good coins survive the reload');

fs.writeFileSync(series.FILE, 'not json at all');
series.init({ log: () => {} });
eq(series.size(), 0, 'an unreadable file starts empty instead of throwing at boot');

// ── the route payload names nobody ──
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './users') {
    return { all: () => [{ userId: 'u1', rec: { tag: 'bento', book: { positions: [] } }, get: () => null }],
      money: n => '$' + n };
  }
  if (request === './trader') throw new Error('trader not started in this test');
  return origLoad.apply(this, arguments);
};
const data = require('../src/sitedata');
series.record({ sym: 'BTC', spot: 77000, taken: false, reason: 'fav-off-band' });

const good = data.seriesFor('BTC', 10);
eq(good.ok, true, 'a known market resolves');
ok(good.points.length >= 1, 'and carries its points');
ok(good.clock && good.clock.minLeft > 0, 'and the clock the gate is using');
const bad = data.seriesFor('NOTACOIN', 10);
eq(bad.ok, false, 'an unknown market is refused');
eq(bad.points, [], 'and returns no points rather than another coin’s');

// The series route is OPEN, so this is the assertion that keeps it safe to be open.
const body = JSON.stringify(good);
for (const leak of ['bento', 'u1', 'userId', 'who', 'bankroll', 'pnl']) {
  ok(body.indexOf(leak) < 0, `the open series payload must not contain ${leak}`);
}
Module._load = origLoad;

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS series — ${checks} checks`);
