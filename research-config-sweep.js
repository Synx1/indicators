#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — the three gate parameters that have never been swept.
 *
 * MAX_PRICE, MIN_CONFIRM, MIN_MINUTES and MIN_GAP_PCT all have measurements behind them. These do not:
 *
 *   MIN_CONF 80     moved from 85 to 80 on 2026-08-30 together with the ceiling, never swept since
 *   MIN_PRICE 0.25   never tested at all
 *   ENTRY_SCAN order takes the EARLIEST qualifying look (13 min); latest-first is untested
 *
 * MIN_PRICE is the interesting one, and it is a direct test of a hypothesis rather than a dial hunt.
 * This bot's confidence and the market's price are the SAME quantity — P(closes past the strike) — so a
 * 25¢ contract the model calls 85% is a 60-POINT disagreement with the market. Either that is the
 * richest edge in the book, or it is where the model is most wrong. Nobody has looked.
 *
 * ── the standard applied ──
 *
 * Sweeping parameters on one 4-day corpus is textbook overfitting, and this repo has the reverted
 * commits to prove it. So a value only counts as an improvement if it clears three bars:
 *   1. PLATEAU   neighbouring values agree; a lone spike is noise
 *   2. BOTH HALVES  the weaker (rally) half improves too, not just the total
 *   3. MECHANISM  there is a reason it should work that does not cite this backtest
 * Anything clearing fewer than three is reported and NOT recommended.
 *
 * `node research-config-sweep.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CANDLES = 20, SHARES = 30;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(+(0.07 * n * p * (1 - p) * 100).toFixed(6)) / 100;

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { sym, rows: j.rows || [], byTime };
}
function closedBefore(byTime, ts, depth) {
  const out = []; let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) { const c = byTime.get(t); if (c) out.push(c); }
  return out;
}
/** `g.scan` is the minute order — earliest-first is what production does. */
function candidate(row, byTime, sym, g) {
  for (const min of g.scan) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !Number.isFinite(res.confidence) || res.confidence < g.conf) continue;
    if (!trader.gapOK(spot, row.strike)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    const up = res.side === 'YES';
    let cf = 0;
    if (up) { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < trader.MIN_CONFIRM) continue;
    const ep = up ? q.ask : (1 - q.bid);
    if (ep < g.minP || ep > g.maxP) continue;
    const won = (up && row.settledYes) || (!up && !row.settledYes);
    return {
      sym, side: res.side, entryPrice: ep, confidence: res.confidence, won, min,
      pnl: (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES), closeMs: row.closeMs
    };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function maxDD(list) {
  let eq = 0, peak = 0, dd = 0;
  for (const e of list.slice().sort((a, b) => a.closeMs - b.closeMs)) {
    eq += e.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}
function stats(list) {
  const s = list.slice().sort((a, b) => a.closeMs - b.closeMs);
  const w = s.filter(e => e.won).length, p = s.reduce((a, e) => a + e.pnl, 0);
  const ae = s.length ? s.reduce((a, e) => a + e.entryPrice, 0) / s.length : 0;
  const wr = s.length ? w / s.length : 0;
  const mid = Math.floor(s.length / 2);
  const h = x => ({ wr: x.length ? x.filter(e => e.won).length / x.length : 0, p: x.reduce((a, e) => a + e.pnl, 0) });
  const dd = maxDD(s);
  return {
    n: s.length, wr, p, per: s.length ? p / s.length : 0, avgEntry: ae, margin: wr - ae,
    dd, ratio: dd > 0 ? p / dd : Infinity, h1: h(s.slice(0, mid)), h2: h(s.slice(mid))
  };
}

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
const EARLY = [13, 12, 11, 10, 9], LATE = [9, 10, 11, 12, 13];
const BASE = { conf: trader.MIN_CONF, minP: trader.MIN_PRICE, maxP: trader.MAX_PRICE, scan: EARLY };
const run = over => {
  const g = { ...BASE, ...over };
  const out = [];
  for (const ds of datasets) for (const r of ds.rows) { const c = candidate(r, ds.byTime, ds.sym, g); if (c) out.push(c); }
  return stats(out);
};
const line = (label, s, live) =>
  console.log(`  ${label.padEnd(16)} ${String(s.n).padStart(3)}  ${usd(s.p).padStart(9)}  ${pct(s.wr).padStart(6)}  ` +
    `${usd(s.per).padStart(7)}  ${pct(s.avgEntry).padStart(6)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}  ` +
    `${('$' + s.dd.toFixed(0)).padStart(5)}  ${(Number.isFinite(s.ratio) ? s.ratio.toFixed(1) : '∞').padStart(5)}  | ` +
    `${pct(s.h1.wr)} ${usd(s.h1.p).padStart(8)} / ${pct(s.h2.wr)} ${usd(s.h2.p).padStart(8)}${live ? '   <- LIVE' : ''}`);

const HEAD = '  parameter         n      net      win%   $/trade  entry  margin  maxDD  net/DD | 1st half        / 2nd half (RALLY)';

console.log('\n  UNSWEPT GATE PARAMETERS — everything else held at the live value');
console.log(`  base: conf>=${BASE.conf}, ${trader.MIN_CONFIRM}/4, ${BASE.minP * 100}-${BASE.maxP * 100}c, gap>=${trader.MIN_GAP_PCT}%, 8<ml<14, ${SHARES}sh`);

console.log('\n  1) MIN_CONF — the confidence floor');
console.log(HEAD);
for (const conf of [80, 82, 84, 86, 88, 90]) line(`conf >= ${conf}`, run({ conf }), conf === trader.MIN_CONF);

console.log('\n  2) MIN_PRICE — is a huge model-vs-market disagreement edge, or error?');
console.log(HEAD);
for (const minP of [0.25, 0.35, 0.40, 0.45, 0.50, 0.55]) line(`price >= ${(minP * 100).toFixed(0)}c`, run({ minP }), minP === trader.MIN_PRICE);

console.log('\n  3) ENTRY SCAN ORDER — take the earliest qualifying look, or the latest?');
console.log(HEAD);
line('earliest (13m)', run({ scan: EARLY }), true);
line('latest (9m)', run({ scan: LATE }), false);

console.log('\n  4) the two most promising in COMBINATION, to check they are not the same effect twice');
console.log(HEAD);
for (const conf of [80, 84]) for (const minP of [0.25, 0.45]) {
  line(`conf${conf} price${(minP * 100).toFixed(0)}c`, run({ conf, minP }), conf === 80 && minP === 0.25);
}
console.log('\n  net/DD is net divided by max drawdown — the figure that matters on a small bankroll,');
console.log('  where the drawdown is what ends the account rather than the total.\n');
