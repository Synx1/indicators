#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — "if I run it overnight, will I be down?"
 *
 * Two honest answers, neither of them a promise:
 *   1. What the corpus says about the OVERNIGHT hours specifically (ET), at the current gate
 *      INCLUDING the new min-gap floor — because overnight is thinner and the average is not it.
 *   2. The distribution of outcomes over a realistic overnight trade count: with an 84% win rate and
 *      this payoff geometry, how often does a night end NEGATIVE anyway?
 *
 * (2) is the part that matters. A positive expectation says nothing about one night; the question
 * "will I be down" is a question about variance, and variance is answerable exactly.
 *
 * Engine/indicators from src/decide.js. `node research-overnight.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = trader.MIN_CONF, MIN_CONFIRM = trader.MIN_CONFIRM;
const MIN_PRICE = trader.MIN_PRICE, MAX_PRICE = trader.MAX_PRICE;
const MIN_GAP_PCT = trader.MIN_GAP_PCT;
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
// Overnight in Eastern: midnight through 8am, the stretch Bento is asking about.
const NIGHT = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const fee = (p, n) => Math.ceil(FEE_COEF * n * p * (1 - p) * 100) / 100;
const etHour = ms => Number(new Date(ms).toLocaleString('en-US',
  { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;

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
/** The live gate as it stands RIGHT NOW, min-gap floor included. */
function decideEntry(row, byTime, sym, shares) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !trader.confOK(res.confidence)) continue;
    if (!trader.gapOK(spot, row.strike)) continue;              // the floor shipped tonight
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < MIN_CONFIRM) continue;
    const ep = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (ep < MIN_PRICE || ep > MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? shares * (1 - ep) : -shares * ep) - fee(ep, shares);
    return { sym, side: res.side, entryPrice: ep, won, pnl, closeMs: row.closeMs, hour: etHour(row.closeMs) };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
const sm = t => {
  const w = t.filter(x => x.won).length, p = t.reduce((a, x) => a + x.pnl, 0);
  return { n: t.length, w, wr: t.length ? w / t.length : 0, p, per: t.length ? p / t.length : 0 };
};

// ── sizing: what $30 actually buys ──
// sharesFor() with autoShares off uses the fixed `shares` setting (default 30). 30 contracts at 57c
// is $17.10 — over half a $30 bankroll in ONE trade, and the free-cash guard would refuse the second.
// So the realistic overnight size on $30 is small, and that is modelled rather than assumed away.
const BANKROLL = 30;
const AVG_ENTRY = 0.57;
const SHARES_30 = Math.max(1, Math.floor((BANKROLL * 0.25) / AVG_ENTRY));   // riskPerTrade 0.25 default

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
const runAt = shares => {
  const out = [];
  for (const ds of datasets) for (const r of ds.rows) { const e = decideEntry(r, ds.byTime, ds.sym, shares); if (e) out.push(e); }
  return out.sort((a, b) => a.closeMs - b.closeMs);
};

const all = runAt(SHARES_30);
const night = all.filter(e => NIGHT.has(e.hour));
const day = all.filter(e => !NIGHT.has(e.hour));

console.log('\n  OVERNIGHT REALITY CHECK — current gate incl. the min-gap floor');
console.log(`  bankroll $${BANKROLL} at 25% risk and ~${AVG_ENTRY * 100}c => ${SHARES_30} contracts/trade`);
console.log('  ' + '─'.repeat(78));
console.log('  slice          n    win%     net       $/trade');
for (const [label, set] of [['ALL hours', all], ['OVERNIGHT 12a-8a', night], ['daytime 8a-12a', day]]) {
  const s = sm(set);
  console.log(`  ${label.padEnd(15)} ${String(s.n).padStart(3)}  ${pct(s.wr).padStart(6)}  ${usd(s.p).padStart(9)}  ${usd(s.per).padStart(8)}`);
}
const nightDays = new Set(night.map(e => new Date(e.closeMs).toISOString().slice(0, 10))).size;
console.log(`\n  the overnight sample is ${night.length} trades across ${nightDays} nights ` +
  `(~${(night.length / Math.max(1, nightDays)).toFixed(1)}/night)`);

// ── the variance question, answered exactly ──
//
// Binomial over k wins in n trades. Win pays (1-entry)*shares - fee; a loss costs entry*shares + fee.
// Using the sample's own average entry so the payoff geometry is the real one, not a guess.
const s = sm(all);
const avgEntry = all.length ? all.reduce((a, e) => a + e.entryPrice, 0) / all.length : AVG_ENTRY;
const WIN = SHARES_30 * (1 - avgEntry) - fee(avgEntry, SHARES_30);
const LOSS = -(SHARES_30 * avgEntry) - fee(avgEntry, SHARES_30);
const P = s.wr;
const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };

console.log('\n  ── IF THE EDGE IS REAL, HOW OFTEN IS A NIGHT STILL NEGATIVE? ──');
console.log(`  assuming win rate ${pct(P)} (the backtest's), avg entry ${pct(avgEntry)},`);
console.log(`  a win pays ${usd(WIN)} and a loss costs ${usd(LOSS)} at ${SHARES_30} contracts`);
console.log('\n   trades   P(down on the night)   P(down > $10)   worst case (all lose)');
for (const n of [3, 4, 5, 6, 8, 10]) {
  let pNeg = 0, pBad = 0;
  for (let k = 0; k <= n; k++) {
    const prob = choose(n, k) * Math.pow(P, k) * Math.pow(1 - P, n - k);
    const net = k * WIN + (n - k) * LOSS;
    if (net < 0) pNeg += prob;
    if (net < -10) pBad += prob;
  }
  console.log(`   ${String(n).padStart(5)}    ${pct(pNeg).padStart(18)}   ${pct(pBad).padStart(13)}   ${usd(n * LOSS).padStart(9)}`);
}
// The break-even count, which is the thing to actually remember.
const needed = n => { for (let k = 0; k <= n; k++) if (k * WIN + (n - k) * LOSS >= 0) return k; return n + 1; };
console.log('\n  wins needed to break even:');
for (const n of [3, 4, 5, 6, 8, 10]) {
  console.log(`   ${String(n).padStart(2)} trades -> need ${needed(n)} wins (${pct(needed(n) / n)}) just to be flat`);
}
console.log('');
