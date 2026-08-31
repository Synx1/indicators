#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — overnight volume/win-rate by hour, and an honest $30 projection.
 *
 * Part 1 measures the overnight window (12a-8a ET) hour by hour at the CURRENT gate, min-gap floor
 * included, so "midnight volume" is a number rather than a feeling.
 *
 * Part 2 projects $30 forward. The important design choice: it does NOT treat the measured win rate
 * as truth. 62 backtest trades gives a Beta(53,11) posterior with a 95% interval of roughly 73-91%,
 * and at these prices the difference between 73% and 91% is the difference between bleeding and
 * compounding. So every simulated path draws its OWN win rate from that posterior — the projection
 * therefore includes "the edge is weaker than measured" as one of its outcomes, which a point-estimate
 * simulation silently assumes away. That assumption is the single biggest way these projections lie.
 *
 * Sizing is modelled as autoShares (riskPerTrade 0.25), because the DEFAULT fixed 30 shares is
 * unrunnable on $30 and Part 2 shows why: one loss leaves the account unable to afford the next
 * position at all.
 *
 * `node research-project30.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const NIGHT = [0, 1, 2, 3, 4, 5, 6, 7];
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
function signal(row, byTime, sym) {
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
    if (ep < trader.MIN_PRICE || ep > trader.MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    return { sym, entryPrice: ep, won, closeMs: row.closeMs, hour: etHour(row.closeMs) };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);

const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
const all = [];
for (const ds of datasets) for (const r of ds.rows) { const e = signal(r, ds.byTime, ds.sym); if (e) all.push(e); }
all.sort((a, b) => a.closeMs - b.closeMs);
const night = all.filter(e => NIGHT.includes(e.hour));
const nightsCovered = new Set(night.map(e => {
  const d = new Date(e.closeMs - (e.hour < 8 ? 24 : 0) * 3600e3);
  return d.toISOString().slice(0, 10);
})).size;

console.log('\n  PART 1 — the overnight window, hour by hour (ET), current gate incl. min-gap floor');
console.log('  ' + '─'.repeat(72));
console.log('   hour     trades   wins   win%     avg entry   per-night rate');
for (const h of NIGHT) {
  const sub = night.filter(e => e.hour === h);
  const w = sub.filter(e => e.won).length;
  const ae = sub.length ? sub.reduce((a, e) => a + e.entryPrice, 0) / sub.length : 0;
  const label = h === 0 ? '12 AM' : h + ' AM';
  console.log(`   ${label.padStart(5)}   ${String(sub.length).padStart(6)}   ${String(w).padStart(4)}   ` +
    `${(sub.length ? pct(w / sub.length) : '—').padStart(6)}   ${(sub.length ? pct(ae) : '—').padStart(9)}   ` +
    `${(sub.length / nightsCovered).toFixed(1)}/night`);
}
const nw = night.filter(e => e.won).length;
const nAvgEntry = night.reduce((a, e) => a + e.entryPrice, 0) / night.length;
console.log('  ' + '─'.repeat(72));
console.log(`   OVERNIGHT TOTAL  ${night.length}    ${nw}   ${pct(nw / night.length)}   ${pct(nAvgEntry)}   ` +
  `${(night.length / nightsCovered).toFixed(1)}/night   (${nightsCovered} nights covered)`);
const aw = all.filter(e => e.won).length;
console.log(`   ALL HOURS        ${all.length}    ${aw}   ${pct(aw / all.length)}   ` +
  `${pct(all.reduce((a, e) => a + e.entryPrice, 0) / all.length)}`);
console.log(`\n   NOTE: ${night.length} overnight trades over ${nightsCovered} nights is far too thin to trust its own`);
console.log(`   win rate. Part 2 therefore uses the ALL-HOURS posterior (n=${all.length}), which is the`);
console.log('   larger sample, and treats overnight vs daytime as indistinguishable.');

// ── Part 2: the projection ─────────────────────────────────────
const WINS = aw, LOSSES = all.length - aw;
const AVG_ENTRY = all.reduce((a, e) => a + e.entryPrice, 0) / all.length;
const TRADES_PER_NIGHT = night.length / nightsCovered;
const START = 30, RISK = 0.25;

// Marsaglia-Tsang gamma, so a Beta can be drawn without a dependency.
function gammaRand(k) {
  if (k < 1) return gammaRand(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = Math.random(), u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaRand = (a, b) => { const x = gammaRand(a); return x / (x + gammaRand(b)); };
const poissonRand = lam => { let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; };

/**
 * One path of `nights`, autoShares sizing, drawing its own win rate from the posterior.
 *
 * MAX_CONTRACTS is the correction that makes this a projection rather than a fantasy. Without it,
 * 25% risk of a compounding bankroll grows without bound and the model happily reports a $87M median
 * inside a month — which is the simulation admitting it has no liquidity term, not a forecast. A
 * Kalshi 15-minute crypto market is a thin book: a few hundred contracts near the touch, and a large
 * order walks the price against itself. Past that ceiling growth stops being exponential and turns
 * linear, which is the single most important thing to understand about scaling this strategy.
 */
const MAX_CONTRACTS = 200;
function simulate(nights) {
  const p = betaRand(1 + WINS, 1 + LOSSES);      // parameter uncertainty, not a point estimate
  let bank = START, capped = false;
  for (let n = 0; n < nights; n++) {
    const k = poissonRand(TRADES_PER_NIGHT);
    for (let i = 0; i < k; i++) {
      let shares = Math.floor((bank * RISK) / AVG_ENTRY);
      if (shares < 1) return { bank, dead: true, p, capped };
      if (shares > MAX_CONTRACTS) { shares = MAX_CONTRACTS; capped = true; }
      const f = fee(AVG_ENTRY, shares);
      bank += (Math.random() < p ? shares * (1 - AVG_ENTRY) : -shares * AVG_ENTRY) - f;
      if (bank <= 0) return { bank: 0, dead: true, p, capped };
    }
  }
  return { bank, dead: false, p, capped };
}
const PATHS = 40000;
const q = (arr, x) => arr[Math.min(arr.length - 1, Math.floor(x * arr.length))];

console.log('\n\n  PART 2 — will $30 become something? 40,000 simulated paths');
console.log(`  autoShares at ${pct(RISK)} risk, avg entry ${pct(AVG_ENTRY)}, ${TRADES_PER_NIGHT.toFixed(1)} trades/night,`);
console.log(`  win rate drawn per path from Beta(${1 + WINS},${1 + LOSSES}) — mean ${pct((1 + WINS) / (2 + all.length))},`);
console.log('  so "the edge is weaker than measured" is one of the outcomes rather than an assumption.');
console.log('  ' + '─'.repeat(94));
console.log('  horizon      p5        p25       MEDIAN     p75       p95      | P(lose)  P(halved)  P(2x)  P(capped)');
for (const [label, nights] of [['1 night', 1], ['3 nights', 3], ['1 week', 7], ['2 weeks', 14], ['1 month', 30]]) {
  const out = [];
  let capped = 0;
  for (let i = 0; i < PATHS; i++) { const r = simulate(nights); out.push(r.bank); if (r.capped) capped++; }
  out.sort((a, b) => a - b);
  const lose = out.filter(x => x < START).length / PATHS;
  const half = out.filter(x => x < START / 2).length / PATHS;
  const dbl = out.filter(x => x >= START * 2).length / PATHS;
  console.log(`  ${label.padEnd(11)} ${usd(q(out, 0.05)).padStart(8)}  ${usd(q(out, 0.25)).padStart(8)}  ` +
    `${usd(q(out, 0.50)).padStart(8)}  ${usd(q(out, 0.75)).padStart(8)}  ${usd(q(out, 0.95)).padStart(8)}  | ` +
    `${pct(lose).padStart(6)}  ${pct(half).padStart(8)}  ${pct(dbl).padStart(6)}  ${pct(capped / PATHS).padStart(8)}`);
}
console.log(`\n  P(capped) = share of paths that hit the ${MAX_CONTRACTS}-contract liquidity ceiling. Once most paths`);
console.log('  are capped the growth is LINEAR, and every figure to its right should be read as an upper bound.');

// ── the crux: everything above hinges on ONE number, and the two estimates of it disagree ──
//
// The Beta posterior captures SAMPLING error (how much 62 trades pins the rate) but NOT REGIME error
// (whether a 4-day corpus from one rally generalises at all). Those are different, and the second is
// bigger. The live book is the out-of-sample evidence: -$57.68 over 37 closed trades, hitting ~73%.
// Breakeven at a 58.8c average entry is 58.8%. So the honest presentation is not one projection — it
// is this table, which shows the answer flipping between the two estimates that actually exist.
function simulateAt(p, nights) {
  let bank = START;
  for (let n = 0; n < nights; n++) {
    const k = poissonRand(TRADES_PER_NIGHT);
    for (let i = 0; i < k; i++) {
      let shares = Math.floor((bank * RISK) / AVG_ENTRY);
      if (shares < 1) return 0;
      if (shares > MAX_CONTRACTS) shares = MAX_CONTRACTS;
      bank += (Math.random() < p ? shares * (1 - AVG_ENTRY) : -shares * AVG_ENTRY) - fee(AVG_ENTRY, shares);
      if (bank <= 0) return 0;
    }
  }
  return bank;
}
console.log('\n\n  THE CRUX — the answer depends entirely on the true win rate, and the two estimates disagree');
console.log(`  breakeven at a ${pct(AVG_ENTRY)} average entry is ${pct(AVG_ENTRY)} — below that, nothing else matters`);
console.log('  ' + '─'.repeat(88));
console.log('  true win%   source                     1 night median   1 week median   P(lose,1wk)  P(dead,1mo)');
for (const [p, src] of [
  [0.839, 'the 4-day backtest'],
  [0.780, 'halfway between'],
  [0.730, 'the LIVE book (37 closed)'],
  [0.650, 'a weaker regime'],
  [0.588, 'exactly breakeven']
]) {
  const one = [], week = [];
  let deadMo = 0;
  for (let i = 0; i < 12000; i++) {
    one.push(simulateAt(p, 1)); week.push(simulateAt(p, 7));
    if (simulateAt(p, 30) <= 0.01) deadMo++;
  }
  one.sort((a, b) => a - b); week.sort((a, b) => a - b);
  const lose = week.filter(x => x < START).length / week.length;
  console.log(`  ${pct(p).padStart(8)}   ${src.padEnd(26)} ${usd(q(one, 0.5)).padStart(13)}   ` +
    `${usd(q(week, 0.5)).padStart(13)}   ${pct(lose).padStart(10)}   ${pct(deadMo / 12000).padStart(10)}`);
}
console.log('\n  UNMODELLED, and it fattens the LEFT tail: 93% of entries are NO, so trades are strongly');
console.log('  correlated. This simulation treats them as independent coin flips, which understates the');
console.log('  chance of a night where a rally takes most of the book at once. Real tail risk is worse.');

// Why the DEFAULT sizing cannot be used, in one line of arithmetic.
const FIXED = 30;
const cost = FIXED * AVG_ENTRY + fee(AVG_ENTRY, FIXED);
console.log(`\n  ── the default sizing is unrunnable on $30 ──`);
console.log(`  shares=30 (the default) at ${pct(AVG_ENTRY)} costs ${usd(cost)} per position.`);
console.log(`  $30 affords ONE. After a single loss the balance is ${usd(START - cost)}, which cannot`);
console.log(`  afford the next position at all — the account stalls rather than recovers.`);
console.log('  autoShares (or shares<=12) is mandatory at this bankroll, not a preference.\n');
