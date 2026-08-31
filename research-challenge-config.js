#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — the $100 -> $457 challenge config, run on the indicators corpus.
 *
 * Bento asked to bring back the config behind BETSSSSS's overnight $100 -> $457 run and see what it
 * does here. This reconstructs it exactly from src/challenge.js and src/paperchallenge.js:
 *
 *   kelly       = (p - q) / (1 - q)                     true Kelly for a contract costing q
 *   perTrade    = min(kelly * kellyFraction, maxFraction) * balance
 *   room        = equity * maxPortfolioFraction - atRisk
 *   contracts   = floor(min(perTrade, room) / q)
 *   kellyFraction 0.12, maxFraction 0.07, maxPortfolioFraction 0.35
 *   5 positions per round (4 "main" + 1 reserved), candidates RANKED, main DOGE excluded
 *
 * ── the one thing this does differently, deliberately ──
 *
 * The original had NO fill model. Grepping paperchallenge.js for slippage, misses, spread or bid/ask
 * handling returns nothing: every entry filled at the quoted price, instantly, always. That is most of
 * why its curve looks the way it does, and reproducing it would just reproduce the fantasy. So this
 * charges the real two-sided Kalshi fee and can optionally charge slippage, and it reports MAX DRAWDOWN
 * and BUST alongside the final balance — the two numbers a headline return omits.
 *
 * `node research-challenge-config.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(+(0.07 * n * p * (1 - p) * 100).toFixed(6)) / 100;

/** The challenge's own risk numbers, copied from paperchallenge.js CFG. */
const CH = Object.freeze({
  kellyFraction: 0.12, maxFraction: 0.07, maxPortfolioFraction: 0.35,
  maxEntriesPerRound: 5, maxMainEntriesPerRound: 4
});

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
/** A candidate under a named gate. `gate.gap` applies the indicators min-gap floor. */
function candidate(row, byTime, sym, gate) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !Number.isFinite(res.confidence) || res.confidence < gate.conf) continue;
    if (gate.gap && !trader.gapOK(spot, row.strike)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    const up = res.side === 'YES';
    let cf = 0;
    if (up) { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < gate.confirm) continue;
    const ep = up ? q.ask : (1 - q.bid);
    if (ep < gate.minP || ep > gate.maxP) continue;
    return {
      sym, ticker: `${sym}-${row.closeMs}`, side: res.side, price: ep,
      p: res.confidence / 100, confidence: res.confidence, confirm: cf,
      won: (up && row.settledYes) || (!up && !row.settledYes),
      openMs: row.closeMs - min * 60 * 1000, closeMs: row.closeMs,
      edge: res.confidence / 100 - ep
    };
  }
  return null;
}

/** challenge.size(), reproduced term for term. */
function sizeFor(p, q, balance, atRisk) {
  if (!(q > 0 && q < 1) || !(balance > 0)) return 0;
  const edge = p - q;
  if (edge <= 0) return 0;
  const equity = balance + atRisk;
  const room = Math.max(0, equity * CH.maxPortfolioFraction - atRisk);
  const kelly = edge / (1 - q);
  const perTrade = Math.min(kelly * CH.kellyFraction, CH.maxFraction) * balance;
  const budget = Math.min(perTrade, room);
  return Math.max(0, Math.floor(budget / q));
}

/** paperchallenge.score(), minus the late-cheap term (indicators has no such path). */
const score = c => 100 + c.edge + c.confidence / 100;

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }

/**
 * Run the challenge forward through the corpus.
 *
 * Sequential and stateful on purpose: the portfolio cap reads `atRisk`, and the whole character of the
 * original run — the exponential bend in its equity curve — comes from size compounding with balance.
 */
function run({ gate, start = 100, excludeDoge = true, slipCents = 0, capRound = CH.maxEntriesPerRound }) {
  const all = [];
  for (const ds of datasets) for (const r of ds.rows) {
    const c = candidate(r, ds.byTime, ds.sym, gate);
    if (c) all.push(c);
  }
  const byMinute = new Map();
  for (const c of all) {
    const k = Math.floor(c.openMs / 60000);
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(c);
  }
  let balance = start, peak = start, dd = 0, bust = false;
  const open = [];                     // { closeMs, cost, contracts, price, won, ticker }
  const closed = [];
  for (const k of [...byMinute.keys()].sort((a, b) => a - b)) {
    const nowMs = k * 60000;
    // Settle everything that has closed, which returns cash and frees portfolio room.
    while (open.length && open[0].closeMs <= nowMs) {
      const pos = open.shift();
      const proceeds = pos.won ? pos.contracts : 0;
      balance += proceeds;
      closed.push({ ...pos, pnl: proceeds - pos.cost });
      const eq = balance + open.reduce((a, o) => a + o.cost, 0);
      if (eq > peak) peak = eq;
      if (peak - eq > dd) dd = peak - eq;
    }
    const inRound = closeMs => open.filter(o => o.closeMs === closeMs).length;
    for (const c of byMinute.get(k).slice().sort((a, b) => score(b) - score(a))) {
      if (excludeDoge && c.sym === 'DOGE') continue;             // main DOGE excluded, as the original did
      if (open.some(o => o.ticker === c.ticker)) continue;
      if (inRound(c.closeMs) >= capRound) continue;
      const atRisk = open.reduce((a, o) => a + o.cost, 0);
      const q = Math.min(0.99, c.price + slipCents / 100);
      const contracts = sizeFor(c.p, q, balance, atRisk);
      if (contracts < 1) continue;
      const cost = +(contracts * q).toFixed(2) + fee(q, contracts);
      if (cost > balance) continue;
      balance -= cost;
      open.push({ closeMs: c.closeMs, cost, contracts, price: q, won: c.won, ticker: c.ticker, sym: c.sym });
      open.sort((a, b) => a.closeMs - b.closeMs);
      if (balance <= 0.01) { bust = true; break; }
    }
    if (bust) break;
  }
  // Settle the tail so nothing is left un-graded.
  for (const pos of open) {
    balance += pos.won ? pos.contracts : 0;
    closed.push({ ...pos, pnl: (pos.won ? pos.contracts : 0) - pos.cost });
  }
  const w = closed.filter(c => c.won).length;
  return {
    start, end: +balance.toFixed(2), peak: +peak.toFixed(2), dd: +dd.toFixed(2), bust,
    n: closed.length, wins: w, wr: closed.length ? w / closed.length : 0,
    avgEntry: closed.length ? closed.reduce((a, c) => a + c.price, 0) / closed.length : 0,
    maxContracts: Math.max(0, ...closed.map(c => c.contracts))
  };
}

const BET = { conf: 85, confirm: 0, minP: 0.10, maxP: 0.90, gap: false };   // BETSSSSS V7/V8
const IND = { conf: 80, confirm: 3, minP: 0.25, maxP: 0.65, gap: true };    // indicators, live
const usd = x => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const pct = x => (x * 100).toFixed(1) + '%';

console.log('\n  THE $100 -> $457 CHALLENGE CONFIG, RUN HERE');
console.log(`  Kelly ${CH.kellyFraction} / maxFraction ${CH.maxFraction} / portfolio ${CH.maxPortfolioFraction}, ` +
  `${CH.maxEntriesPerRound}/round, ranked, main DOGE excluded`);
console.log('  ' + '─'.repeat(104));
console.log('  gate        start  slip  trades  win%   avgEntry   FINAL      peak     maxDD   x    biggest  bust');
const rows = [
  ['BETSSSSS 90c', BET, 100, 0], ['BETSSSSS 90c', BET, 100, 2],
  ['BETSSSSS 90c', BET, 30, 0], ['BETSSSSS 90c', BET, 30, 2],
  ['indicators', IND, 100, 0], ['indicators', IND, 100, 2],
  ['indicators', IND, 30, 0], ['indicators', IND, 30, 2]
];
for (const [label, gate, start, slip] of rows) {
  const r = run({ gate, start, slipCents: slip });
  console.log(`  ${label.padEnd(12)} ${usd(start).padStart(5)}  ${(slip + 'c').padStart(4)}  ` +
    `${String(r.n).padStart(6)}  ${pct(r.wr).padStart(5)}  ${pct(r.avgEntry).padStart(8)}  ` +
    `${usd(r.end).padStart(9)}  ${usd(r.peak).padStart(8)}  ${usd(r.dd).padStart(7)}  ` +
    `${(r.end / start).toFixed(1)}x  ${String(r.maxContracts).padStart(6)}  ${r.bust ? 'YES' : 'no'}`);
}
console.log('\n  maxDD is peak-to-trough on EQUITY. "biggest" is the largest single position in contracts —');
console.log('  the number a real Kalshi book has to be deep enough to absorb.\n');
