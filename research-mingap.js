#!/usr/bin/env node
/**
 * THROWAWAY SPIKE (2026-08-31) — the MIN-GAP floor, the one lever with a mechanism behind it.
 *
 * The dissection in research-coindetail.js found the BTC/ETH/SOL losers were NOT lower-confidence
 * or lower-confirm than the winners — they were CHEAPER (55.2c vs 62.5c) and sat CLOSER to the
 * strike (|gap| 0.033% vs 0.044%). That points at a real mechanical flaw rather than bad luck:
 *
 *   z = gap / sigma,  sigma = realizedVol(10) * sqrt(minutesLeft)
 *
 * When realizedVol collapses (crypto going quiet, ~0.0001 here), sigma goes tiny, so even a gap of
 * 0.02% divides out to a large z and the model reports 80-89% on what is physically a coin flip:
 * spot is sitting ON the strike with minutes to go. LOSS-AUTOPSY.md already named this ("87% on a
 * coin flip") and blamed sub-80 confidence; it is actually the near-zero GAP, and the 80 gate does
 * not screen it because confidence is high precisely when sigma is small.
 *
 * A vol FLOOR was tried before and reverted (it halved profit) — it fought the symptom by inflating
 * sigma everywhere. This tests the direct form: refuse the entry when spot is within X% of the
 * strike, whatever the model claims.
 *
 * Validation that matters (a threshold that only works on the whole corpus is curve-fitting):
 *   1. plateau      — do NEIGHBOURING thresholds agree, or is one value a spike?
 *   2. both halves  — does it help the Aug 5-6 half AND the Aug 7-8 rally half?
 *   3. per coin     — does it help the three weak coins specifically, and not hurt the others?
 *   4. what it drops — are the dropped trades genuinely coin-flips (win% ~50), not good trades?
 *
 * Engine/indicators from src/decide.js. `node research-mingap.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3, MIN_PRICE = 0.25, MAX_PRICE = 0.65;
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const WEAK = ['BTC', 'ETH', 'SOL'];
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
    return { sym, side: res.side, entryPrice, confidence: res.confidence, won, pnl,
      closeMs: row.closeMs, gap: Math.abs((spot - row.strike) / row.strike) * 100 };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function sm(t) {
  const w = t.filter(x => x.won).length, p = t.reduce((a, x) => a + x.pnl, 0);
  return { n: t.length, w, wr: t.length ? w / t.length : 0, p, per: t.length ? p / t.length : 0 };
}
const row = (label, k, d) =>
  `  ${label.padEnd(11)} ${String(k.n).padStart(4)}  ${usd(k.p).padStart(9)}  ${pct(k.wr).padStart(6)}  ` +
  `${usd(k.per).padStart(7)} | ${String(d.n).padStart(3)} dropped ${usd(d.p).padStart(8)} ${d.n ? pct(d.wr).padStart(6) : '     -'}`;

const all = [];
for (const s of COINS) { let ds; try { ds = loadCoin(s); } catch (e) { continue; } for (const r of ds.rows) { const e = decideEntry(r, ds.byTime, s); if (e) all.push(e); } }
all.sort((a, b) => a.closeMs - b.closeMs);
const midMs = all[Math.floor(all.length / 2)].closeMs;
const split = (ts, g) => [ts.filter(e => e.gap >= g), ts.filter(e => e.gap < g)];

console.log('\n  MIN-GAP FLOOR — refuse an entry when spot sits within X% of the strike');
console.log(`  data: ${DATA_DIR}   full live-gate set: ${all.length} entries`);
console.log('  ' + '─'.repeat(94));
console.log('  1) PLATEAU — a real effect holds across neighbouring thresholds; a spike is noise');
console.log('  minGap      kept       net    win%   $/trade | what it dropped');
for (const g of [0, 0.01, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.06]) {
  const [k, d] = split(all, g);
  console.log(row(g.toFixed(3) + '%', sm(k), sm(d)));
}

console.log('\n  2) BOTH HALVES — a filter that only works in one regime is fitted to that regime');
console.log('  minGap    first-half kept: net / win%      second-half (RALLY) kept: net / win%');
const H1 = all.filter(e => e.closeMs < midMs), H2 = all.filter(e => e.closeMs >= midMs);
for (const g of [0, 0.03, 0.04, 0.05]) {
  const a = sm(split(H1, g)[0]), b = sm(split(H2, g)[0]);
  console.log(`  ${(g.toFixed(3) + '%').padEnd(8)}  ${String(a.n).padStart(3)}  ${usd(a.p).padStart(9)}  ${pct(a.wr).padStart(6)}` +
    `        ${String(b.n).padStart(3)}  ${usd(b.p).padStart(9)}  ${pct(b.wr).padStart(6)}`);
}

console.log('\n  3) PER COIN — does it fix the three weak coins without hurting the workhorses?');
console.log('  coin    no-floor: n  net      win%   |  0.04% floor: n  net      win%   | delta net');
for (const s of COINS) {
  const sub = all.filter(e => e.sym === s);
  const a = sm(sub), b = sm(split(sub, 0.04)[0]);
  const tag = WEAK.includes(s) ? ' <- weak' : '';
  console.log(`  ${s.padEnd(6)}  ${String(a.n).padStart(9)}  ${usd(a.p).padStart(8)}  ${pct(a.wr).padStart(6)}   |` +
    `  ${String(b.n).padStart(11)}  ${usd(b.p).padStart(8)}  ${pct(b.wr).padStart(6)}   | ${usd(b.p - a.p).padStart(8)}${tag}`);
}

console.log('\n  4) THE WEAK THREE TOGETHER (the coins to strengthen)');
const weakSet = all.filter(e => WEAK.includes(e.sym));
for (const g of [0, 0.03, 0.04, 0.05]) {
  const [k, d] = split(weakSet, g);
  console.log(row('  ' + g.toFixed(3) + '%', sm(k), sm(d)));
}

console.log('\n  5) WHAT GETS DROPPED — is it really coin-flips? (a floor is only justified if win% ~50)');
const dropped = all.filter(e => e.gap < 0.04).sort((a, b) => a.gap - b.gap);
console.log('   gap%    coin  side  entry  conf   result    pnl');
for (const e of dropped) {
  console.log(`   ${e.gap.toFixed(4)}  ${e.sym.padEnd(4)}  ${e.side.padEnd(4)}  ${pct(e.entryPrice).padStart(5)}  ` +
    `${String(e.confidence).padStart(3)}   ${(e.won ? 'WIN ' : 'LOSS').padEnd(6)}  ${usd(e.pnl).padStart(8)}`);
}
const ds = sm(dropped);
console.log(`   => ${ds.n} trades, ${ds.w} win (${pct(ds.wr)}), net ${usd(ds.p)} — ` +
  `${ds.wr < 0.6 ? 'genuinely coin-flip territory' : 'NOT coin-flips; the floor would be cutting real edge'}`);
console.log('');
