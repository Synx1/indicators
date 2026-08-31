#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — apply decisions in EDGE order instead of scan order.
 *
 * src/trader.js runOnce() decides for all seven coins concurrently and then applies the results with
 * `for (const res of decided)` — i.e. in `gl.COINS` array order. Every guard in accountBlock() is
 * correct, but when one of them BINDS, which candidate survives is decided by where the coin sits in
 * a hard-coded array. BTC beats HYPE for the last free slot because B comes before H. Nothing about
 * the market is consulted.
 *
 * That is not a tuning parameter, it is a defect: given a fixed number of slots, filling them with the
 * highest-edge candidates is strictly better use of the same information. This measures how much it is
 * worth, which is the part that needs evidence — the direction of the effect does not.
 *
 * The simulation enforces the REAL guards so the comparison is honest:
 *   - one position per ticker
 *   - no second same-direction position settling in the same window
 *   - maxOpen total concurrent positions
 * Candidates are grouped by the minute they would be entered, because that is the granularity a pass
 * actually sees. Everything except the ordering is held identical.
 *
 * `node research-rankorder.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30;
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
function candidate(row, byTime, sym, maxP) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !trader.confOK(res.confidence)) continue;
    if (!trader.gapOK(spot, row.strike)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < trader.MIN_CONFIRM) continue;
    const ep = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (ep < trader.MIN_PRICE || ep > maxP) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    return {
      sym, ticker: `${sym}-${row.closeMs}`, side: res.side, entryPrice: ep,
      confidence: res.confidence, won,
      pnl: (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES),
      openMs: row.closeMs - min * 60 * 1000, closeMs: row.closeMs,
      // The model's expected edge per contract. Calibrated within ~1pp over 21,634 predictions, which
      // is what makes it usable as a ranker rather than just a number to display.
      edge: res.confidence / 100 - ep,
      scanIdx: COINS.indexOf(sym)
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
  const sd = s.length > 1
    ? Math.sqrt(s.reduce((a, e) => a + (e.pnl - p / s.length) ** 2, 0) / (s.length - 1)) : 0;
  const mid = Math.floor(s.length / 2);
  const h = x => (x.length ? x.filter(e => e.won).length / x.length : 0);
  return {
    n: s.length, wr, p, per: s.length ? p / s.length : 0, avgEntry: ae, margin: wr - ae,
    dd: maxDD(s), sharpe: sd ? (p / s.length) / sd : 0,
    h1: h(s.slice(0, mid)), h2: h(s.slice(mid))
  };
}

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }

/** Walk the corpus, applying the real guards, choosing contested slots by `cmp`. */
function simulate(cmp, { maxOpen = 3, maxP = trader.MAX_PRICE } = {}) {
  const all = [];
  for (const ds of datasets) for (const r of ds.rows) {
    const c = candidate(r, ds.byTime, ds.sym, maxP);
    if (c) all.push(c);
  }
  // Group by the minute a pass would see them, then order WITHIN the minute by `cmp`.
  const byMinute = new Map();
  for (const c of all) {
    const k = Math.floor(c.openMs / 60000);
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(c);
  }
  const open = [];               // {closeMs, side, ticker}
  const taken = [], refused = [];
  for (const k of [...byMinute.keys()].sort((a, b) => a - b)) {
    const nowMs = k * 60000;
    while (open.length && open[0].closeMs <= nowMs) open.shift();
    for (const c of byMinute.get(k).slice().sort(cmp)) {
      if (open.some(o => o.ticker === c.ticker)) { refused.push(c); continue; }
      if (open.some(o => o.side === c.side && o.closeMs === c.closeMs)) { refused.push(c); continue; }
      if (open.length >= maxOpen) { refused.push(c); continue; }
      taken.push(c);
      open.push({ closeMs: c.closeMs, side: c.side, ticker: c.ticker });
      open.sort((a, b) => a.closeMs - b.closeMs);
    }
  }
  return { taken, refused };
}

const BY_SCAN = (a, b) => a.scanIdx - b.scanIdx;              // what production does today
const BY_EDGE = (a, b) => b.edge - a.edge;                    // the proposed change
const BY_CONF = (a, b) => b.confidence - a.confidence;
const BY_CHEAP = (a, b) => a.entryPrice - b.entryPrice;
const BY_WORST = (a, b) => a.edge - b.edge;                   // the adversarial floor

console.log('\n  APPLY ORDER — same gate, same guards, ONLY the order contested slots are filled in');
console.log(`  gate: conf>=${trader.MIN_CONF}, ${trader.MIN_CONFIRM}/4, ${trader.MIN_PRICE * 100}-${trader.MAX_PRICE * 100}c, gap>=${trader.MIN_GAP_PCT}%, ${SHARES}sh, hold to settlement`);
// The ordering only matters when slots are CONTESTED, so it is measured at both the current gate and
// a loose one. At 65c the gate is so selective that positions rarely overlap; a looser ceiling is what
// creates the contention the ordering is supposed to resolve.
for (const [maxOpen, maxP] of [[3, 0.65], [1, 0.65], [3, 0.80], [3, 0.90], [1, 0.80]]) {
  console.log('  ' + '─'.repeat(96));
  console.log(`  maxOpen ${maxOpen}, ceiling ${(maxP * 100).toFixed(0)}c`);
  console.log('  order            taken  refused   win%      net     $/trade  margin   maxDD  Sharpe | halves win%');
  for (const [label, cmp] of [
    ['scan order (NOW)', BY_SCAN], ['by EDGE', BY_EDGE],
    ['by confidence', BY_CONF], ['cheapest first', BY_CHEAP], ['worst-first (floor)', BY_WORST]
  ]) {
    const { taken, refused } = simulate(cmp, { maxOpen, maxP });
    const s = stats(taken);
    console.log(`  ${label.padEnd(20)} ${String(s.n).padStart(3)}   ${String(refused.length).padStart(5)}  ` +
      `${pct(s.wr).padStart(6)}  ${usd(s.p).padStart(9)}  ${usd(s.per).padStart(7)}  ` +
      `${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}  ${('$' + s.dd.toFixed(0)).padStart(5)}  ` +
      `${s.sharpe.toFixed(3).padStart(6)} | ${pct(s.h1)} / ${pct(s.h2)}`);
  }
}
console.log('\n  "worst-first" is the adversarial floor: if scan order sits near it, the array index is');
console.log('  effectively choosing at random and the ordering change is free money.\n');
