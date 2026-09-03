'use strict';
/**
 * Fit it, and score it on data it never saw.
 *
 * The baseline is the market's own price used directly as the probability — the forecast that has beaten
 * twelve engineered features, two model classes, order flow, book microstructure and a trajectory
 * extrapolation. Anything that cannot beat it on the held-out half has found nothing, however good it looks
 * on the half it was fitted on.
 *
 * Logistic regression on the logit of the market's own price plus the cross-market terms. Linear on purpose:
 * with one real feature and 30k training rows, a tree's extra capacity buys overfitting, and the earlier
 * tree runs on this project's data beat their linear counterparts by 0.002 AUC while costing a whole
 * afternoon. If a linear model cannot find a signal this size, the signal is not there to be found.
 */
const { rows } = require('./cross');

rows.sort((a, b) => a.close - b.close || a.left - b.left);
const mid = Math.floor(rows.length / 2);
const TR = rows.slice(0, mid), TE = rows.slice(mid);
console.log(`train ${TR.length}  test ${TE.length}`);
console.log(`train ${new Date(TR[0].close).toISOString().slice(0, 10)}..${new Date(TR[TR.length - 1].close).toISOString().slice(0, 10)}`);
console.log(`test  ${new Date(TE[0].close).toISOString().slice(0, 10)}..${new Date(TE[TE.length - 1].close).toISOString().slice(0, 10)}\n`);

const clamp = p => Math.min(0.999, Math.max(0.001, p));
const logit = p => Math.log(clamp(p) / (1 - clamp(p)));
const sig = z => 1 / (1 + Math.exp(-z));

/** Feature sets, each including the market's own price so the question is always "does this ADD anything". */
const SETS = {
  'own price only            ': r => [logit(r.pUp)],
  'own price + consensus gap ': r => [logit(r.pUp), r.gap],
  'own price + consensus     ': r => [logit(r.pUp), logit(r.othersMean)],
  'own price + gap + agree   ': r => [logit(r.pUp), r.gap, r.agree - 0.5],
  'own price + all cross     ': r => [logit(r.pUp), r.gap, r.agree - 0.5, r.spread, logit(r.othersMean)],
};

/** L2 logistic regression by Newton/IRLS. Ridge is what keeps a near-collinear design from exploding. */
function fit(X, y, lambda = 1) {
  const n = X.length, d = X[0].length + 1;
  let w = new Array(d).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    const g = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) {
      const x = [1, ...X[i]];
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      const p = sig(z), r = p * (1 - p) + 1e-9;
      for (let j = 0; j < d; j++) {
        g[j] += (p - y[i]) * x[j];
        for (let k = 0; k < d; k++) H[j][k] += r * x[j] * x[k];
      }
    }
    for (let j = 1; j < d; j++) { g[j] += lambda * w[j]; H[j][j] += lambda; }
    // Solve H·step = g by Gaussian elimination with partial pivoting.
    const M = H.map((row, i) => [...row, g[i]]);
    for (let c = 0; c < d; c++) {
      let piv = c;
      for (let r2 = c + 1; r2 < d; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) continue;
      for (let r2 = 0; r2 < d; r2++) {
        if (r2 === c) continue;
        const f = M[r2][c] / M[c][c];
        for (let k = c; k <= d; k++) M[r2][k] -= f * M[c][k];
      }
    }
    let delta = 0;
    for (let j = 0; j < d; j++) {
      const s = M[j][d] / (M[j][j] || 1e-12);
      w[j] -= s; delta += Math.abs(s);
    }
    if (delta < 1e-8) break;
  }
  return w;
}
const predict = (w, x) => sig(w.reduce((a, wj, j) => a + wj * (j === 0 ? 1 : x[j - 1]), 0));

function auc(pred, y) {
  const pairs = pred.map((p, i) => [p, y[i]]).sort((a, b) => a[0] - b[0]);
  let pos = 0, neg = 0, sum = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][1] === 1) { pos++; sum += i + 1; } else neg++;
  }
  return pos && neg ? (sum - pos * (pos + 1) / 2) / (pos * neg) : 0.5;
}
const brier = (pred, y) => pred.reduce((a, p, i) => a + Math.pow(p - y[i], 2), 0) / pred.length;

const yTR = TR.map(r => r.y), yTE = TE.map(r => r.y);
// The market's raw price, used as the probability, with no fitting at all. The bar to clear.
const rawTE = TE.map(r => r.pUp);
const bRaw = brier(rawTE, yTE), aRaw = auc(rawTE, yTE);
console.log(`the bar — the market's own price, unfitted:   AUC ${aRaw.toFixed(5)}   Brier ${bRaw.toFixed(6)}\n`);
console.log('feature set                    test AUC    test Brier    skill vs price    verdict');
for (const [name, f] of Object.entries(SETS)) {
  const w = fit(TR.map(f), yTR);
  const pTE = TE.map(r => predict(w, f(r)));
  const b = brier(pTE, yTE), a = auc(pTE, yTE);
  const skill = (1 - b / bRaw) * 100;
  console.log(`${name} ${a.toFixed(5).padStart(9)} ${b.toFixed(6).padStart(13)} ${(skill >= 0 ? '+' : '') + skill.toFixed(3) + '%'}` .padEnd(0).padStart(18) +
    '    ' + (skill > 0.5 ? 'BEATS the price' : skill > -0.5 ? 'ties the price' : 'worse'));
}
