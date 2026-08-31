#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — "one trade every 15 minutes, but skip the bad ones."
 *
 * The current gate takes 62 of ~258 settlement windows: about one trade every 75 minutes. This asks
 * what it costs to reach ~1 per WINDOW, and tests the one idea that might get there without simply
 * buying worse trades: instead of relaxing the gate and taking everything that passes (which is what
 * BETSSSSS does — 501 trades at 80.5c average entry, 5.6pp margin, $189 drawdown), RANK every
 * candidate in each window and take only the BEST one.
 *
 * That is a different lever from the price ceiling. Relaxing the ceiling adds dear trades at the
 * bottom of the quality range. Best-of-N adds one trade per window chosen from a wider pool, which
 * could be better than the marginal trade the ceiling would have added. The paper challenge did
 * exactly this ("the five best available rather than whichever symbols were scanned first").
 *
 * Two things make 1-per-window structurally safer than the current burst pattern, and both are
 * measured below rather than assumed:
 *   - SEQUENTIAL, not concurrent: a 15-minute position settles before the next window opens, so
 *     maxOpen stops binding and same-window correlation cannot happen at all.
 *   - the directional tilt is diluted, because each window is chosen on its own merits.
 *
 * `node research-oneperround.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const SHARES = 30;                       // fixed, so every row is comparable
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
/** Every candidate this market offers under a gate, or null. Gap floor always applied. */
function candidate(row, byTime, sym, g) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !Number.isFinite(res.confidence) || res.confidence < g.conf) continue;
    if (g.gap && !trader.gapOK(spot, row.strike)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < g.confirm) continue;
    const ep = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (ep < g.minP || ep > g.maxP) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    return {
      sym, side: res.side, entryPrice: ep, confidence: res.confidence, confirm: cf,
      won, pnl: (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES),
      closeMs: row.closeMs,
      // The model's own expected edge per contract: calibrated within ~1pp, so it is a usable ranker.
      edge: res.confidence / 100 - ep
    };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function maxDD(list) {
  let eq = 0, peak = 0, dd = 0;
  for (const e of list) { eq += e.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return dd;
}
function stats(list, windows) {
  const s = list.slice().sort((a, b) => a.closeMs - b.closeMs);
  const w = s.filter(e => e.won).length, p = s.reduce((a, e) => a + e.pnl, 0);
  const ae = s.length ? s.reduce((a, e) => a + e.entryPrice, 0) / s.length : 0;
  const wr = s.length ? w / s.length : 0;
  const mid = Math.floor(s.length / 2);
  const h = x => ({ wr: x.length ? x.filter(e => e.won).length / x.length : 0, p: x.reduce((a, e) => a + e.pnl, 0) });
  // Max concurrent: a 15-min position opened 8-14 min out settles at closeMs, so two entries only
  // overlap when they share a window or sit in adjacent ones.
  const perWindow = {};
  for (const e of s) perWindow[e.closeMs] = (perWindow[e.closeMs] || 0) + 1;
  return {
    n: s.length, wr, p, per: s.length ? p / s.length : 0, avgEntry: ae, margin: wr - ae,
    dd: maxDD(s), coverage: windows ? s.length / windows : 0,
    maxPerWindow: Math.max(0, ...Object.values(perWindow)),
    noPct: s.length ? s.filter(e => e.side === 'NO').length / s.length : 0,
    h1: h(s.slice(0, mid)), h2: h(s.slice(mid))
  };
}

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
/** All candidates under a gate, grouped by settlement window. */
function pool(g) {
  const byWindow = new Map();
  for (const ds of datasets) for (const r of ds.rows) {
    const c = candidate(r, ds.byTime, ds.sym, g);
    if (!c) continue;
    if (!byWindow.has(c.closeMs)) byWindow.set(c.closeMs, []);
    byWindow.get(c.closeMs).push(c);
  }
  return byWindow;
}
const ALL_WINDOWS = new Set();
for (const ds of datasets) for (const r of ds.rows) ALL_WINDOWS.add(r.closeMs);
const W = ALL_WINDOWS.size;

const IND = { conf: 80, confirm: 3, minP: 0.25, maxP: 0.65, gap: true };
const RANKERS = {
  'best edge': (a, b) => b.edge - a.edge,
  cheapest: (a, b) => a.entryPrice - b.entryPrice,
  'most confident': (a, b) => b.confidence - a.confidence
};

console.log(`\n  ONE TRADE PER 15 MINUTES? — ${W} settlement windows in the corpus, ${SHARES}sh fixed, hold to settlement`);
console.log('  ' + '─'.repeat(108));
console.log('  strategy                        n   cover   win%      net     $/trade  avgEntry margin  maxDD  %NO  maxOpen | halves win%');
const line = (label, s) =>
  console.log(`  ${label.padEnd(29)} ${String(s.n).padStart(3)}  ${pct(s.coverage).padStart(6)}  ${pct(s.wr).padStart(6)}  ` +
    `${usd(s.p).padStart(9)}  ${usd(s.per).padStart(7)}  ${pct(s.avgEntry).padStart(6)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}  ` +
    `${('$' + s.dd.toFixed(0)).padStart(5)}  ${pct(s.noPct).padStart(5)}  ${String(s.maxPerWindow).padStart(6)}  | ` +
    `${pct(s.h1.wr)} / ${pct(s.h2.wr)}`);

// Baseline: today's gate, take everything that passes.
const indPool = pool(IND);
line('CURRENT (take all, 65c)', stats([...indPool.values()].flat(), W));

// Best-of-N at the CURRENT gate: this cannot add volume, only remove it. Included to show that the
// selection rule is not itself the lever — the pool has to be bigger first.
for (const [name, cmp] of Object.entries(RANKERS)) {
  const picked = [...indPool.values()].map(v => v.slice().sort(cmp)[0]).filter(Boolean);
  line(`  best-1/window, ${name}`, stats(picked, W));
}

console.log('  ' + '·'.repeat(108));
// Widen the pool, then take only the best one per window.
for (const maxP of [0.70, 0.75, 0.80, 0.90]) {
  const g = { ...IND, maxP };
  const p = pool(g);
  const allTaken = [...p.values()].flat();
  line(`ceiling ${(maxP * 100).toFixed(0)}c, take ALL`, stats(allTaken, W));
  for (const [name, cmp] of Object.entries(RANKERS)) {
    const picked = [...p.values()].map(v => v.slice().sort(cmp)[0]).filter(Boolean);
    line(`  best-1/window, ${name}`, stats(picked, W));
  }
  console.log('  ' + '·'.repeat(108));
}
console.log('  cover = share of the ' + W + ' windows that got a trade. maxOpen = most entries in ONE window,');
console.log('  which is the correlation that matters: 1 means every position settles before the next opens.\n');
