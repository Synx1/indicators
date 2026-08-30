#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-30) — decomposes the win-rate DECAY the new-levers spike found
 * (first half 94% -> second half 68%). Question: regime change, one coin, one window,
 * correlated clusters, or entry-price drift? Same leak-free gate as research-newlevers.js.
 *
 * `node research-decay.js`. Delete when done.
 */

const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3, MIN_PRICE = 0.25, MAX_PRICE = 0.65;
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(FEE_COEF * n * p * (1 - p) * 100) / 100;

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { rows: j.rows || [], byTime };
}
function closedBefore(byTime, ts, depth) {
  const out = []; let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) { const c = byTime.get(t); if (c) out.push(c); }
  return out;
}
function decideEntry(row, byTime) {
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
    let c = 0;
    if (res.side === 'YES') { if (rsi > 50) c++; if (ema9 > ema20) c++; if (bb && spot > bb.middle) c++; if (spot > vwap) c++; }
    else { if (rsi < 50) c++; if (ema9 < ema20) c++; if (bb && spot < bb.middle) c++; if (spot < vwap) c++; }
    if (c < MIN_CONFIRM) continue;
    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < MIN_PRICE || entryPrice > MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? SHARES * (1 - entryPrice) : -SHARES * entryPrice) - fee(entryPrice, SHARES);
    return { min, side: res.side, entryPrice, confidence: res.confidence, won, pnl, closeMs: row.closeMs };
  }
  return null;
}

const E = [];
for (const sym of COINS) {
  let ds; try { ds = loadCoin(sym); } catch (e) { continue; }
  for (const row of ds.rows) { const e = decideEntry(row, ds.byTime); if (e) E.push({ ...e, sym }); }
}
E.sort((a, b) => a.closeMs - b.closeMs);

const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
const d = ms => new Date(ms).toISOString().slice(0, 10);
const sum = ts => {
  const w = ts.filter(t => t.won).length, pnl = ts.reduce((a, t) => a + t.pnl, 0);
  const ae = ts.length ? ts.reduce((a, t) => a + t.entryPrice, 0) / ts.length : 0;
  const ac = ts.length ? ts.reduce((a, t) => a + t.confidence, 0) / ts.length : 0;
  const wr = ts.length ? w / ts.length : 0;
  return { n: ts.length, wr, pnl, per: ts.length ? pnl / ts.length : 0, ae, ac };
};

console.log(`\n  DECAY DECOMPOSITION — ${E.length} entries, ${d(E[0].closeMs)} .. ${d(E[E.length - 1].closeMs)}\n`);

console.log('  A) CHRONOLOGICAL QUARTILES (is win% trending down, and is entry price drifting up?)');
console.log('     quartile   n    dates                 win%     $/trade   avg-entry  avg-conf');
const Q = Math.ceil(E.length / 4);
for (let i = 0; i < 4; i++) {
  const s2 = E.slice(i * Q, (i + 1) * Q); if (!s2.length) continue;
  const s = sum(s2);
  console.log(`     Q${i + 1}       ${String(s.n).padStart(4)}   ${d(s2[0].closeMs)}..${d(s2[s2.length - 1].closeMs)}  ` +
    `${pct(s.wr).padStart(6)}  ${usd(s.per).padStart(8)}  ${pct(s.ae).padStart(7)}   ${s.ac.toFixed(1)}`);
}

console.log('\n  B) SECOND-HALF LOSSES BY COIN (which symbol drives the drop?)');
const mid = Math.floor(E.length / 2), H2 = E.slice(mid);
console.log('     coin   n(2nd half)  win%     $/trade   losses');
for (const sym of COINS) {
  const s2 = H2.filter(e => e.sym === sym); if (!s2.length) { continue; }
  const s = sum(s2);
  console.log(`     ${sym.padEnd(5)}  ${String(s.n).padStart(6)}     ${pct(s.wr).padStart(6)}  ${usd(s.per).padStart(8)}   ` +
    `${s2.filter(e => !e.won).map(e => e.side + '@' + pct(e.entryPrice)).join(' ') || '-'}`);
}

console.log('\n  C) CORRELATED CLUSTERS (entries sharing one 15-min settlement window)');
const byWin = {};
for (const e of E) (byWin[Math.floor(e.closeMs / 1000 / 900)] ||= []).push(e);
const clustered = [], solo = [];
for (const k in byWin) (byWin[k].length >= 2 ? clustered : solo).push(...byWin[k]);
const nWin = Object.keys(byWin).length, multi = Object.values(byWin).filter(v => v.length >= 2).length;
console.log(`     ${nWin} distinct windows; ${multi} carried >=2 simultaneous entries`);
console.log(`     solo entries:      ${sum(solo).n.toString().padStart(3)}  win ${pct(sum(solo).wr)}  ${usd(sum(solo).per)}/trade`);
console.log(`     clustered entries: ${sum(clustered).n.toString().padStart(3)}  win ${pct(sum(clustered).wr)}  ${usd(sum(clustered).per)}/trade`);
const allLose = Object.values(byWin).filter(v => v.length >= 2 && v.every(e => !e.won));
const allWin = Object.values(byWin).filter(v => v.length >= 2 && v.every(e => e.won));
console.log(`     of ${multi} multi-entry windows: ${allWin.length} all-win, ${allLose.length} all-LOSE (correlated wipeouts)`);

console.log('\n  D) WIN% BY ENTRY PRICE BAND (does the edge live only in cheap entries?)');
console.log('     band       n    win%     $/trade   margin');
for (const [lo, hi] of [[0.25, 0.45], [0.45, 0.55], [0.55, 0.65]]) {
  const s2 = E.filter(e => e.entryPrice >= lo && e.entryPrice < hi + (hi === 0.65 ? 0.001 : 0));
  if (!s2.length) { console.log(`     ${(lo + '-' + hi).padEnd(9)}  0`); continue; }
  const s = sum(s2);
  console.log(`     ${(lo + '-' + hi).padEnd(9)} ${String(s.n).padStart(4)}   ${pct(s.wr).padStart(6)}  ${usd(s.per).padStart(8)}  ${((s.wr - s.ae) * 100).toFixed(1)}pp`);
}

console.log('\n  E) WIN% BY MINUTES-LEFT AT ENTRY (is one look-window weaker?)');
console.log('     min-left   n    win%     $/trade');
for (const m of ENTRY_SCAN) {
  const s2 = E.filter(e => e.min === m); if (!s2.length) { continue; }
  const s = sum(s2);
  console.log(`     ${String(m).padStart(2)}        ${String(s.n).padStart(4)}   ${pct(s.wr).padStart(6)}  ${usd(s.per).padStart(8)}`);
}
console.log('');
