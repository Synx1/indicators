#!/usr/bin/env node
/**
 * CALIBRATION of the PREDICTOR itself (2026-08-30) — "does the engine predict accurately?"
 * Not a backtest of the trade gate: evaluates engineEvaluate at EVERY look-minute on EVERY
 * market (thousands of predictions, all coins/directions/confidences), then asks:
 *   1. Reliability: when it says P(win)=x, does it win x of the time? (binary calibration)
 *   2. Vol model: is the predicted sigma right? Standardize each realized terminal move by
 *      the model's sigma; if calibrated it is ~N(0,1). std>1 => vol underestimated =>
 *      overconfident. excess kurtosis => fat tails the normal CDF misses.
 *   3. Fix preview: rescale sigma by the measured k (and try Student-t tails); does Brier
 *      score (mean sq prediction error) drop in BOTH chronological halves? A real fix helps
 *      both halves; a curve-fit helps one. Regime-independent because it pools directions.
 *
 * `node research-calibration.js`. Read-only. Delete when done.
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const SCAN = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3], MIN_CANDLES = 20;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

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
function spotAt(byTime, ts) { // settlement spot: candle at/just before ts
  let t = Math.floor(ts / 60) * 60;
  for (let i = 0; i < 10; i++, t -= 60) { const c = byTime.get(t); if (c) return c.close; }
  return null;
}
// normal CDF (same A&S approx the engine uses), P(Z<=z)
function ncdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

// collect one prediction record per (market, look-minute)
const P = [];
for (const sym of COINS) {
  let ds; try { ds = loadCoin(sym); } catch (_) { continue; }
  for (const row of ds.rows) {
    const settleSpot = spotAt(ds.byTime, Math.floor(row.closeMs / 1000));
    for (const m of SCAN) {
      const ts = Math.floor(row.closeMs / 1000) - m * 60;
      const candles = closedBefore(ds.byTime, ts, 60);
      if (candles.length < MIN_CANDLES) continue;
      const spot = candles[0].close;
      const vol = decide.realizedVol(candles, 10);
      const sigma = vol * Math.sqrt(m);
      if (!(sigma >= 0.0001) || !settleSpot) continue;
      // mean 1-min log return over the same 10-candle lookback (the drift the engine ignores)
      let mu = 0, nR = Math.min(10, candles.length - 1);
      for (let i = 0; i < nR; i++) if (candles[i + 1].close > 0) mu += Math.log(candles[i].close / candles[i + 1].close);
      mu = nR ? mu / nR : 0;
      const r = decide.engineEvaluate(spot, row.strike, m, candles);
      if (!r.side) continue;
      const pYes = r.side === 'YES' ? r.confidence / 100 : 1 - r.confidence / 100;
      const won = (r.side === 'YES') === !!row.settledYes;
      const realMove = Math.log(settleSpot / spot);      // signed terminal log-return
      P.push({ sym, m, closeMs: row.closeMs, sigma, mu, gap: (spot - row.strike) / row.strike,
        pYes, conf: r.confidence, side: r.side, won, realMove, outY: row.settledYes ? 1 : 0 });
    }
  }
}
P.sort((a, b) => a.closeMs - b.closeMs);

const pct = x => (x * 100).toFixed(1) + '%';
const std = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const kurt = a => { const m = a.reduce((s, x) => s + x, 0) / a.length, v = a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; return a.reduce((s, x) => s + (x - m) ** 4, 0) / a.length / v ** 2; };

console.log(`\n  PREDICTOR CALIBRATION — ${P.length} predictions over ${COINS.length} coins, look-minutes 3..14\n`);

// ---- 1. Binary reliability: predicted P(win) bucket vs realized win frequency ----
console.log('  1) RELIABILITY  (predicted win-prob bucket -> realized win rate; gap = miscalibration)');
console.log('     conf-band    n     predicted   realized    gap');
for (const [lo, hi] of [[50, 60], [60, 70], [70, 80], [80, 90], [90, 100.1]]) {
  const b = P.filter(p => p.conf >= lo && p.conf < hi); if (!b.length) continue;
  const pred = b.reduce((s, p) => s + p.conf / 100, 0) / b.length, real = b.filter(p => p.won).length / b.length;
  console.log(`     ${(lo + '-' + Math.min(hi, 100)).padEnd(9)} ${String(b.length).padStart(5)}    ${pct(pred).padStart(6)}     ${pct(real).padStart(6)}   ${((real - pred) * 100).toFixed(1).padStart(5)}pp`);
}

// ---- 1b. Does the rally break calibration? Split the confident book (conf>=80) by half x side ----
console.log('\n  1b) CONFIDENT BOOK (conf>=80) split by chronological half x side — did the regime break it?');
console.log('      slice            n     predicted   realized    gap');
const hi80 = P.filter(p => p.conf >= 80), midC = Math.floor(hi80.length / 2);
for (const [label, set] of [['1st half', hi80.slice(0, midC)], ['2nd half', hi80.slice(midC)]]) {
  for (const sd of ['YES', 'NO']) {
    const b = set.filter(p => p.side === sd); if (!b.length) continue;
    const pred = b.reduce((s, p) => s + p.conf / 100, 0) / b.length, real = b.filter(p => p.won).length / b.length;
    console.log(`      ${(label + ' ' + sd).padEnd(14)} ${String(b.length).padStart(5)}    ${pct(pred).padStart(6)}     ${pct(real).padStart(6)}   ${((real - pred) * 100).toFixed(1).padStart(5)}pp`);
  }
}

// ---- 2. Vol-model calibration: standardized terminal move should be ~N(0,1) ----
const zt = P.map(p => p.realMove / p.sigma);
console.log(`\n  2) VOL MODEL  (standardized terminal move = realMove / sigma; calibrated => std 1.0, kurt 3.0)`);
console.log(`     std(z_terminal) = ${std(zt).toFixed(3)}   (>1 => sigma too small => OVERCONFIDENT)`);
console.log(`     kurtosis        = ${kurt(zt).toFixed(2)}   (>3 => fat tails the normal CDF underweights)`);
console.log(`     => sigma is under-scaled by factor k = ${std(zt).toFixed(3)}`);

// ---- 3. Fix preview: Brier score before/after, in BOTH halves ----
// Brier = mean((P(YES) - outcomeYES)^2), lower = more accurate. Compare the live model to
// sigma rescaled by k (fixes vol underestimation) and to a fatter-tailed variant.
const pYesUnder = (p, k) => ncdf(p.gap / (k * p.sigma));                 // rescaled-normal
const brier = (recs, k) => recs.reduce((s, p) => s + (pYesUnder(p, k) - p.outY) ** 2, 0) / recs.length;
const k = std(zt);
const mid = Math.floor(P.length / 2), H1 = P.slice(0, mid), H2 = P.slice(mid);
console.log('  3) FIX PREVIEW  (Brier score = mean squared prediction error; LOWER is more accurate)');
console.log('     sigma scale     Brier(all)   Brier(1st half)   Brier(2nd half)');
for (const [label, kk] of [['k=1.0 (LIVE)', 1.0], [`k=${k.toFixed(2)} (fit)`, k], ['k=1.15', 1.15], ['k=1.30', 1.30]]) {
  console.log(`     ${label.padEnd(15)} ${brier(P, kk).toFixed(4).padStart(6)}      ${brier(H1, kk).toFixed(4).padStart(6)}           ${brier(H2, kk).toFixed(4).padStart(6)}`);
}
console.log('\n  A lower Brier in BOTH halves under k>1 = the vol fix genuinely predicts better (not curve-fit).');

// ---- 4. DRIFT fix: center the Gaussian at spot*e^(mu*m) instead of assuming zero drift ----
// 1b shows NO is over-confident and YES under-confident (the market drifted up). Adding the
// recent drift mu should correct that. lambda dampens it (1.0 = full realized drift).
const pYesDrift = (p, lam) => ncdf((p.gap + lam * p.mu * p.m) / p.sigma);
const brierD = (recs, lam) => recs.reduce((s, p) => s + (pYesDrift(p, lam) - p.outY) ** 2, 0) / recs.length;
console.log('\n  4) DRIFT FIX  (Brier under a drift-centered Gaussian; LOWER = more accurate)');
console.log('     drift lambda      Brier(all)   Brier(1st half)   Brier(2nd half)');
for (const [label, lam] of [['0.0 (LIVE)', 0], ['0.5 (damped)', 0.5], ['1.0 (full)', 1.0]]) {
  console.log(`     ${label.padEnd(15)} ${brierD(P, lam).toFixed(4).padStart(6)}      ${brierD(H1, lam).toFixed(4).padStart(6)}           ${brierD(H2, lam).toFixed(4).padStart(6)}`);
}
console.log('\n  Drift lowering Brier in BOTH halves = a real accuracy gain. CAUTION: mu extrapolates the');
console.log('  recent trend, so on 4 up-days it will look good; it is a directional bet at reversals.');
console.log('');


