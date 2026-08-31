#!/usr/bin/env node
/**
 * THROWAWAY SPIKE (2026-08-31) — "buy cheaper" lever, the DirectionalBot's real edge.
 *
 * Re-runs the WHOLE live-gate scan once per price band. This is NOT a post-filter on the
 * 65c entry set: tightening MAX_PRICE can make a market qualify at a DIFFERENT minute (a
 * later, cheaper look), so the entry set genuinely changes and must be recomputed. Engine +
 * indicators imported from src/decide.js so the numbers cannot diverge from production.
 *
 * Reports each band's net / win% / volume / margin, AND the second-half (regime-flip) slice,
 * because live got hurt in exactly that regime and a ceiling change is only worth shipping if
 * it helps THERE, not just on the easy days.
 *
 * Leakage discipline identical to research-newlevers.js. `node research-pricesweep.js`.
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3;
const ENTRY_SCAN = [13, 12, 11, 10, 9];
const MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (price, n) => Math.ceil(FEE_COEF * n * price * (1 - price) * 100) / 100;

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
/** First qualifying entry under a given [minP, maxP] band, or null. */
function decideEntry(row, byTime, minP, maxP) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || res.confidence < MIN_CONF) continue;
    const rsi = decide.calcRSI(candles, 14), ema9 = decide.calcEMA(candles, 9), ema20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vwap = decide.calcVWAP(candles, 20);
    let confirm = 0;
    if (res.side === 'YES') { if (rsi > 50) confirm++; if (ema9 > ema20) confirm++; if (bb && spot > bb.middle) confirm++; if (spot > vwap) confirm++; }
    else { if (rsi < 50) confirm++; if (ema9 < ema20) confirm++; if (bb && spot < bb.middle) confirm++; if (spot < vwap) confirm++; }
    if (confirm < MIN_CONFIRM) continue;
    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < minP || entryPrice > maxP) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? SHARES * (1 - entryPrice) : -SHARES * entryPrice) - fee(entryPrice, SHARES);
    return { min, side: res.side, entryPrice, confidence: res.confidence, won, pnl, closeMs: row.closeMs, sym: row.sym };
  }
  return null;
}
function summarize(ts) {
  const w = ts.filter(t => t.won), pnl = ts.reduce((a, t) => a + t.pnl, 0);
  const avgEntry = ts.length ? ts.reduce((a, t) => a + t.entryPrice, 0) / ts.length : 0;
  const winRate = ts.length ? w.length / ts.length : 0;
  const noN = ts.filter(t => t.side === 'NO').length;
  return { n: ts.length, wins: w.length, winRate, pnl, per: ts.length ? pnl / ts.length : 0, avgEntry, margin: winRate - avgEntry, noPct: ts.length ? noN / ts.length : 0 };
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function secondHalf(ts) { const c = ts.slice().sort((a, b) => a.closeMs - b.closeMs); return summarize(c.slice(Math.floor(c.length / 2))); }

const datasets = [];
for (const sym of COINS) { try { datasets.push(loadCoin(sym)); } catch (e) {} }

function runBand(minP, maxP) {
  const entries = [];
  for (const ds of datasets) for (const row of ds.rows) { const e = decideEntry({ ...row, sym: ds.sym }, ds.byTime, minP, maxP); if (e) entries.push(e); }
  return entries;
}

console.log('\n  PRICE-BAND SWEEP — live gate (conf>=80, 3/4, 8<ml<14), hold to settlement, 30 sh');
console.log(`  data: ${DATA_DIR}`);
console.log('  ' + '─'.repeat(96));
console.log('  band          n     net        win%     $/trade   avgEntry  margin   %NO   | 2nd-half: n   net       win%');
for (const [minP, maxP] of [[0.25, 0.65], [0.25, 0.60], [0.25, 0.55], [0.25, 0.50], [0.25, 0.45], [0.30, 0.55], [0.35, 0.55], [0.35, 0.50]]) {
  const e = runBand(minP, maxP);
  const s = summarize(e), h2 = secondHalf(e);
  const label = `${(minP * 100).toFixed(0)}-${(maxP * 100).toFixed(0)}c`;
  console.log(`  ${label.padEnd(10)} ${String(s.n).padStart(4)}  ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ` +
    `${usd(s.per).padStart(8)}  ${pct(s.avgEntry).padStart(7)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(7)}  ${pct(s.noPct).padStart(5)} | ` +
    `${String(h2.n).padStart(3)}  ${usd(h2.pnl).padStart(9)}  ${pct(h2.winRate).padStart(6)}`);
}
console.log('');
