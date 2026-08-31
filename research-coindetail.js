#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — dissect every BTC/ETH/SOL live-gate entry to see whether their
 * losers share a FIXABLE cause (a mechanistic flaw) or are just regime/small-sample noise.
 * Tuning a filter on a few losers is overfitting; this only looks for a common structure.
 * Engine/indicators from src/decide.js. `node research-coindetail.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3, MIN_PRICE = 0.25, MAX_PRICE = 0.65;
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const TARGET = ['BTC', 'ETH', 'SOL'];
const fee = (p, n) => Math.ceil(FEE_COEF * n * p * (1 - p) * 100) / 100;
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
function decideEntry(row, byTime, sym) {
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
    if (entryPrice < MIN_PRICE || entryPrice > MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? SHARES * (1 - entryPrice) : -SHARES * entryPrice) - fee(entryPrice, SHARES);
    const vol = decide.realizedVol(candles, 10);
    return { sym, min, side: res.side, entryPrice, confidence: res.confidence, confirm, won, pnl,
      vol, closeMs: row.closeMs, gapPct: ((spot - row.strike) / row.strike) * 100 };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
const iso = ms => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');

const all = [];
for (const sym of TARGET) { let ds; try { ds = loadCoin(sym); } catch (e) { continue; } for (const row of ds.rows) { const e = decideEntry(row, ds.byTime, sym); if (e) all.push(e); } }
all.sort((a, b) => a.closeMs - b.closeMs);

console.log('\n  BTC / ETH / SOL — every live-gate entry, ordered by settlement time');
console.log('  ' + '─'.repeat(92));
console.log('  when         coin  side  entry  conf  cfm  vol      gap%    result   pnl');
for (const e of all) {
  console.log(`  ${iso(e.closeMs)}  ${e.sym.padEnd(4)}  ${e.side.padEnd(4)}  ${pct(e.entryPrice).padStart(5)}  ` +
    `${String(e.confidence).padStart(3)}  ${e.confirm}/4  ${e.vol.toFixed(4)}  ${e.gapPct.toFixed(2).padStart(6)}  ` +
    `${(e.won ? 'WIN ' : 'LOSS').padEnd(6)}  ${usd(e.pnl).padStart(8)}`);
}
const W = all.filter(e => e.won), L = all.filter(e => !e.won);
const avg = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : NaN;
console.log('  ' + '─'.repeat(92));
console.log(`  ${all.length} entries, ${W.length} win / ${L.length} loss (${pct(W.length / all.length)}), net ${usd(all.reduce((s, e) => s + e.pnl, 0))}`);
console.log('\n  WINNERS vs LOSERS — do the losers share anything the winners do not?');
console.log(`  metric        winners      losers`);
console.log(`  entry price   ${pct(avg(W, e => e.entryPrice)).padStart(7)}      ${pct(avg(L, e => e.entryPrice)).padStart(7)}`);
console.log(`  confidence    ${avg(W, e => e.confidence).toFixed(1).padStart(7)}      ${avg(L, e => e.confidence).toFixed(1).padStart(7)}`);
console.log(`  confirms      ${avg(W, e => e.confirm).toFixed(2).padStart(7)}      ${avg(L, e => e.confirm).toFixed(2).padStart(7)}`);
console.log(`  realizedVol   ${avg(W, e => e.vol).toFixed(4).padStart(7)}      ${avg(L, e => e.vol).toFixed(4).padStart(7)}`);
console.log(`  |gap%|        ${avg(W, e => Math.abs(e.gapPct)).toFixed(3).padStart(7)}      ${avg(L, e => Math.abs(e.gapPct)).toFixed(3).padStart(7)}`);
console.log(`  side %NO      ${pct(W.filter(e => e.side === 'NO').length / W.length).padStart(7)}      ${pct(L.filter(e => e.side === 'NO').length / L.length).padStart(7)}`);
const secondHalfMs = all.length ? all[Math.floor(all.length / 2)].closeMs : 0;
console.log(`  in 2nd half   ${pct(W.filter(e => e.closeMs >= secondHalfMs).length / W.length).padStart(7)}      ${pct(L.filter(e => e.closeMs >= secondHalfMs).length / L.length).padStart(7)}`);
console.log('');
