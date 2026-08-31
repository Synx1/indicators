#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — "which is better?" A controlled head-to-head.
 *
 * The $457 headline and the +$435 backtest are NOT comparable: one is a paper ledger with no fill
 * model, cherry-picked candidates and Kelly compounding; the other is a leakage-disciplined backtest
 * with fees modelled and fixed size. Comparing those two numbers directly would be meaningless.
 *
 * So this holds EVERYTHING constant except the gate — same engine (src/decide.js), same 1806-market
 * corpus, same fixed size, same two-sided fee, all hold-to-settlement — and varies only the knobs
 * that actually differ between the two bots:
 *
 *   indicators (now)   conf >= 80, 3/4 confirm, 25-65c, 8<ml<14, gap >= 0.03%
 *   BETSSSSS (V7/V8)   conf >= 85, 2/4 confirm, 25-90c, 8<ml<14, no gap floor
 *
 * Intermediates isolate WHICH knob does the work, because "one config beats another" is not a
 * finding you can act on — "the ceiling is what matters and the confirm count is not" is.
 *
 * Reports MAX DRAWDOWN alongside net, because on a $30 bankroll the drawdown is the binding
 * constraint, not the total: a config that ends higher having dipped $40 en route is unrunnable.
 *
 * HONEST LIMIT: this compares GATES on one engine. The real BETSSSSS also has per-market tuned
 * gates, an edge-driven stake ladder and candle-momentum confirmation that are NOT reproduced here.
 * This answers "which knob settings are better", not "which codebase is better".
 *
 * `node research-headtohead.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
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
/** One market under one gate config. */
function decideEntry(row, byTime, sym, g) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !Number.isFinite(res.confidence) || res.confidence < g.conf) continue;
    const gapPct = Math.abs((spot - row.strike) / row.strike) * 100;
    if (g.gap > 0 && !(gapPct >= g.gap)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < g.confirm) continue;
    const ep = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (ep < g.minP || ep > g.maxP) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES);
    return { sym, side: res.side, entryPrice: ep, confidence: res.confidence, won, pnl, closeMs: row.closeMs };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
/** Peak-to-trough of the cumulative curve, in settlement order — what a small bankroll must survive. */
function maxDrawdown(list) {
  let eq = 0, peak = 0, dd = 0;
  for (const e of list) { eq += e.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}
function summarize(list) {
  const s = list.slice().sort((a, b) => a.closeMs - b.closeMs);
  const w = s.filter(e => e.won).length, p = s.reduce((a, e) => a + e.pnl, 0);
  const avgEntry = s.length ? s.reduce((a, e) => a + e.entryPrice, 0) / s.length : 0;
  const wr = s.length ? w / s.length : 0;
  const mid = Math.floor(s.length / 2);
  const half = h => { const t = h.filter(e => e.won).length; return { n: h.length, wr: h.length ? t / h.length : 0, p: h.reduce((a, e) => a + e.pnl, 0) }; };
  return {
    n: s.length, wr, p, per: s.length ? p / s.length : 0, avgEntry,
    margin: wr - avgEntry, dd: maxDrawdown(s),
    h1: half(s.slice(0, mid)), h2: half(s.slice(mid))
  };
}

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
const run = g => {
  const out = [];
  for (const ds of datasets) for (const r of ds.rows) { const e = decideEntry(r, ds.byTime, ds.sym, g); if (e) out.push(e); }
  return out;
};

const IND = { conf: 80, confirm: 3, minP: 0.25, maxP: 0.65, gap: 0.03 };
const BET = { conf: 85, confirm: 2, minP: 0.25, maxP: 0.90, gap: 0 };
const CONFIGS = [
  ['indicators (live)', IND],
  ['BETSSSSS V7/V8', BET],
  ['— isolate the knobs —', null],
  ['ind, ceiling 90c', { ...IND, maxP: 0.90 }],
  ['ind, confirm 2/4', { ...IND, confirm: 2 }],
  ['ind, conf 85', { ...IND, conf: 85 }],
  ['ind, no gap floor', { ...IND, gap: 0 }],
  ['BET + gap floor', { ...BET, gap: 0.03 }],
  ['BET + 65c ceiling', { ...BET, maxP: 0.65 }],
  ['BET + 3/4 confirm', { ...BET, confirm: 3 }]
];

console.log('\n  HEAD TO HEAD — same engine, same corpus, same 30sh fixed size, fees modelled, hold to settlement');
console.log(`  data: ${DATA_DIR}`);
console.log('  ' + '─'.repeat(104));
console.log('  config                 n     net       win%   $/trade  avgEntry  margin   maxDD   | halves win% (net)');
for (const [label, g] of CONFIGS) {
  if (!g) { console.log('  ' + '·'.repeat(104)); continue; }
  const s = summarize(run(g));
  console.log(`  ${label.padEnd(21)} ${String(s.n).padStart(3)}  ${usd(s.p).padStart(9)}  ${pct(s.wr).padStart(6)}  ` +
    `${usd(s.per).padStart(7)}  ${pct(s.avgEntry).padStart(7)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}  ` +
    `${('$' + s.dd.toFixed(2)).padStart(7)}  | ${pct(s.h1.wr)} (${usd(s.h1.p)}) / ${pct(s.h2.wr)} (${usd(s.h2.p)})`);
}
console.log('\n  margin = win% - avgEntry. On a binary, breakeven win rate EQUALS the entry price, so');
console.log('  margin is the edge per contract. maxDD is peak-to-trough in settlement order — the');
console.log('  number a $30 bankroll has to survive, and the one a total conceals.\n');
