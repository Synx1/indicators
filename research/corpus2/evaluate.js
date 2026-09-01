'use strict';

/**
 * Walk-forward evaluation: does the rebuilt model know more than the live engine?
 *
 * ── the benchmark is not a straw man ──
 *
 * The live engine's prediction is exactly Phi(z) — the normal CDF of the z it already computes. So the
 * incumbent is scored on the SAME rows from the SAME feature, with no gates and no reimplementation.
 * Anything the new model wins is won against the real thing.
 *
 * ── what counts as winning ──
 *
 * Not accuracy. A 15-minute binary near its strike is close to a coin flip, so accuracy mostly measures
 * the base rate. Three things matter, in order:
 *   AUC        — can it rank? Everything downstream needs this and nothing recovers it.
 *   Brier skill vs a constant — are the probabilities worth more than always saying the base rate? The
 *              live engine fails this test on the traded band, which is why 85% meant 68%.
 *   Reliability — when it says 70%, does 70% happen? A miscalibrated ranker cannot be sized.
 *
 * Folds are DAYS, fitted only on strictly earlier days, so a fold never sees its own regime.
 */

const fs = require('fs');
const path = require('path');
const { train, sigmoid } = require('./model');

const DIR = __dirname;
const DAY = 86400000;

// Phi via Abramowitz-Stegun; the live engine uses the same approximation, so the benchmark matches it.
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function auc(pairs) {
  // Rank-based, so it is O(n log n) rather than the O(n^2) pair count.
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let rank = 1, i = 0, sumPosRanks = 0, nPos = 0, nNeg = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avgRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) { if (sorted[k].y === 1) { sumPosRanks += avgRank; nPos++; } else nNeg++; }
    rank += j - i + 1;
    i = j + 1;
  }
  if (!nPos || !nNeg) return null;
  return (sumPosRanks - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

const brier = pairs => pairs.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / pairs.length;

function reliability(pairs, bins = 10) {
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin = pairs.filter(r => r.p >= lo && (hi >= 1 ? r.p <= hi : r.p < hi));
    if (inBin.length < 30) continue;
    out.push({ band: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`, n: inBin.length,
      said: +(inBin.reduce((s, r) => s + r.p, 0) / inBin.length).toFixed(4),
      happened: +(inBin.reduce((s, r) => s + r.y, 0) / inBin.length).toFixed(4) });
  }
  return out;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json'), 'utf8'));
  const { names, X, y, meta } = raw;
  const zIdx = names.indexOf('z');
  const days = meta.map(m => Math.floor(m[1] / DAY));
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  console.log(`${X.length} rows · ${uniq.length} days · ${names.length} features`);

  // Fit only once the history is worth fitting on: at least 20% of the corpus behind the first fold.
  const MIN_TRAIN_DAYS = Math.max(10, Math.floor(uniq.length * 0.35));
  const testDays = uniq.slice(MIN_TRAIN_DAYS);
  console.log(`fitting on the first ${MIN_TRAIN_DAYS} days, testing forward over ${testDays.length}\n`);

  const modelPairs = [], incumbentPairs = [];
  let lastWeights = null;
  // Refit weekly: a daily refit changes almost nothing at this feature count and costs 7x the time.
  const REFIT_EVERY = 7;
  let model = null;

  for (let t = 0; t < testDays.length; t++) {
    const d = testDays[t];
    if (t % REFIT_EVERY === 0) {
      const trIdx = [];
      for (let i = 0; i < X.length; i++) if (days[i] < d) trIdx.push(i);
      const Xtr = trIdx.map(i => X[i]), ytr = trIdx.map(i => y[i]);
      model = train(Xtr, ytr, { l2: 2.0, iters: 12 });
      lastWeights = model.weights(names);
      process.stdout.write(`  refit at day ${t + 1}/${testDays.length} on ${Xtr.length} rows\n`);
    }
    for (let i = 0; i < X.length; i++) {
      if (days[i] !== d) continue;
      modelPairs.push({ p: model.predict(X[i]), y: y[i], i });
      incumbentPairs.push({ p: phi(X[i][zIdx]), y: y[i], i });
    }
  }

  const base = modelPairs.reduce((s, r) => s + r.y, 0) / modelPairs.length;
  const constPairs = modelPairs.map(r => ({ p: base, y: r.y }));
  const bM = brier(modelPairs), bI = brier(incumbentPairs), bC = brier(constPairs);

  console.log(`\nout-of-sample rows: ${modelPairs.length} · base rate ${(base * 100).toFixed(2)}% YES\n`);
  console.log('                        AUC      Brier      skill vs constant');
  console.log(`  live engine (z only)  ${auc(incumbentPairs).toFixed(4)}   ${bI.toFixed(6)}   ${(1 - bI / bC >= 0 ? '+' : '')}${(1 - bI / bC).toFixed(4)}`);
  console.log(`  rebuilt model         ${auc(modelPairs).toFixed(4)}   ${bM.toFixed(6)}   ${(1 - bM / bC >= 0 ? '+' : '')}${(1 - bM / bC).toFixed(4)}`);
  console.log(`  always base rate      0.5000   ${bC.toFixed(6)}    0.0000`);

  console.log('\nreliability of the rebuilt model (said vs happened):');
  for (const b of reliability(modelPairs)) {
    console.log(`  ${b.band.padEnd(9)} n=${String(b.n).padStart(6)}  said ${(b.said * 100).toFixed(1)}%  happened ${(b.happened * 100).toFixed(1)}%  ` +
      `${Math.abs(b.said - b.happened) < 0.02 ? '' : (b.said > b.happened ? '(hot)' : '(cold)')}`);
  }
  console.log('\nreliability of the live engine, for comparison:');
  for (const b of reliability(incumbentPairs)) {
    console.log(`  ${b.band.padEnd(9)} n=${String(b.n).padStart(6)}  said ${(b.said * 100).toFixed(1)}%  happened ${(b.happened * 100).toFixed(1)}%  ` +
      `${Math.abs(b.said - b.happened) < 0.02 ? '' : (b.said > b.happened ? '(hot)' : '(cold)')}`);
  }

  console.log('\nwhat the model leans on:');
  for (const w of lastWeights) console.log(`  ${w.feature.padEnd(12)} ${w.weight >= 0 ? '+' : ''}${w.weight}`);

  fs.writeFileSync(path.join(DIR, 'evaluation.json'), JSON.stringify({
    rows: modelPairs.length, baseRate: base, days: uniq.length, trainDays: MIN_TRAIN_DAYS,
    model: { auc: auc(modelPairs), brier: bM, skill: 1 - bM / bC },
    incumbent: { auc: auc(incumbentPairs), brier: bI, skill: 1 - bI / bC },
    constant: { brier: bC },
    reliabilityModel: reliability(modelPairs), reliabilityIncumbent: reliability(incumbentPairs),
    weights: lastWeights
  }, null, 2));
  // Predictions are kept so the pricing stage can score decisions without refitting anything.
  fs.writeFileSync(path.join(DIR, 'oos-predictions.json'), JSON.stringify({
    meta: modelPairs.map(r => meta[r.i]), pModel: modelPairs.map(r => +r.p.toFixed(5)),
    pIncumbent: incumbentPairs.map(r => +r.p.toFixed(5)), y: modelPairs.map(r => r.y)
  }));
  console.log('\n-> evaluation.json, oos-predictions.json');
}

if (require.main === module) main();
module.exports = { phi, auc, brier, reliability };
