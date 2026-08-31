#!/usr/bin/env node
/**
 * THROWAWAY SPIKE (2026-08-31) — directional-exposure cap, the second lever.
 *
 * The live loss is a structurally-short book (92.6% NO) meeting a rally. This simulates a
 * cap on CONCURRENT same-direction open positions across windows (the existing maxOpen=3 caps
 * TOTAL concurrency; this caps per-DIRECTION). Entries processed in open-time order; a new
 * entry is SKIPPED if it would exceed the same-side concurrent cap. Positions open at
 * closeMs-min*60 and close at closeMs. Engine/indicators from src/decide.js.
 *
 * Honest framing: the corpus is ONE regime (Aug 5-8 rally). A short-cap MUST look good here
 * because shorts lost here — that is fitting to the regime, not proof of edge. The number that
 * matters is whether it protects the bad slice WITHOUT gutting total EV.  `node research-dircap.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3, MIN_PRICE = 0.25, MAX_PRICE = 0.65;
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
    const openMs = row.closeMs - min * 60 * 1000;
    return { min, side: res.side, entryPrice, won, pnl, openMs, closeMs: row.closeMs, sym };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function summarize(ts) {
  const w = ts.filter(t => t.won).length, pnl = ts.reduce((a, t) => a + t.pnl, 0);
  return { n: ts.length, wins: w, winRate: ts.length ? w / ts.length : 0, pnl, per: ts.length ? pnl / ts.length : 0 };
}

const all = [];
for (const sym of COINS) { let ds; try { ds = loadCoin(sym); } catch (e) { continue; } for (const row of ds.rows) { const e = decideEntry(row, ds.byTime, sym); if (e) all.push(e); } }
all.sort((a, b) => a.openMs - b.openMs || a.closeMs - b.closeMs);

/** Apply a per-direction concurrent cap. maxTotal mirrors the live maxOpen=3. */
function applyCap(sideCap, maxTotal) {
  const open = []; const taken = []; const skipped = [];
  for (const e of all) {
    while (open.length && open[0].closeMs <= e.openMs) open.shift();
    const sameSide = open.filter(o => o.side === e.side).length;
    if (open.length >= maxTotal) { skipped.push(e); continue; }
    if (sameSide >= sideCap) { skipped.push(e); continue; }
    taken.push(e); open.push(e); open.sort((a, b) => a.closeMs - b.closeMs);
  }
  return { taken, skipped };
}

console.log('\n  DIRECTIONAL-CAP SWEEP — live gate, 30 sh, maxOpen(total)=3, cap on concurrent SAME-side');
console.log(`  full entry set: ${all.length} trades  (${pct(all.filter(e => e.side === 'NO').length / all.length)} NO)`);
console.log('  ' + '─'.repeat(90));
console.log('  sideCap   taken   net        win%     $/trade  | skipped-that-wouldve: n   net(if taken)  win%');
for (const cap of [1, 2, 3, 99]) {
  const { taken, skipped } = applyCap(cap, 3);
  const s = summarize(taken), sk = summarize(skipped);
  console.log(`  ${String(cap === 99 ? 'none' : cap).padEnd(7)} ${String(s.n).padStart(5)}  ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ` +
    `${usd(s.per).padStart(8)} | ${String(sk.n).padStart(3)}  ${usd(sk.pnl).padStart(9)}  ${pct(sk.winRate).padStart(6)}`);
}
console.log('\n  read: "skipped-that-wouldve" is the EV you FORGO by capping. If those trades were net-positive,');
console.log('  the cap cut profit to buy variance reduction. If net-negative, the cap removed real losers.\n');
