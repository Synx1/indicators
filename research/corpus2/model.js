'use strict';

/**
 * L2-regularised logistic regression, fitted by Newton/IRLS.
 *
 * Newton rather than gradient descent because the feature count is small (13) and the row count is
 * not (~500k): the Hessian is 13x13, so each iteration costs one pass and converges in under ten
 * steps instead of the thousands a learning-rate schedule would need. That matters because the
 * walk-forward refits this once per fold, and a slow fit is a fit nobody reruns.
 *
 * Standardisation is fitted on TRAIN ONLY and applied to test. Fitting the scaler on everything is the
 * quietest form of leakage there is — it never looks wrong and it inflates every downstream number.
 */

function standardizer(X, cols) {
  const n = X.length, mean = new Float64Array(cols), sd = new Float64Array(cols);
  for (const row of X) for (let j = 0; j < cols; j++) mean[j] += row[j];
  for (let j = 0; j < cols; j++) mean[j] /= n;
  for (const row of X) for (let j = 0; j < cols; j++) { const d = row[j] - mean[j]; sd[j] += d * d; }
  for (let j = 0; j < cols; j++) sd[j] = Math.sqrt(sd[j] / Math.max(1, n - 1)) || 1;
  return { mean, sd };
}

const applyScale = (row, sc) => {
  const out = new Float64Array(row.length);
  for (let j = 0; j < row.length; j++) out[j] = (row[j] - sc.mean[j]) / sc.sd[j];
  return out;
};

const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve (A + lambda I) x = b by Gauss-Jordan with partial pivoting. d is small; clarity wins. */
function solve(A, b, d) {
  const M = [];
  for (let i = 0; i < d; i++) { M.push(Array.from(A[i])); M[i].push(b[i]); }
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;             // singular: caller keeps last good beta
    [M[col], M[piv]] = [M[piv], M[col]];
    const p = M[col][col];
    for (let j = col; j <= d; j++) M[col][j] /= p;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let j = col; j <= d; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(r => r[d]);
}

/**
 * Fit on standardised rows. `l2` penalises every weight except the intercept — penalising the
 * intercept would bias the base rate, which is the one thing the model should always get right.
 */
function fit(Xs, y, { l2 = 2.0, iters = 12 } = {}) {
  const n = Xs.length, d = Xs[0].length + 1;
  const beta = new Float64Array(d);
  beta[0] = Math.log(Math.max(1e-6, y.reduce((a, b) => a + b, 0) / n) / Math.max(1e-6, 1 - y.reduce((a, b) => a + b, 0) / n));
  const H = Array.from({ length: d }, () => new Float64Array(d));
  const g = new Float64Array(d);
  const x = new Float64Array(d);

  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < d; i++) { g[i] = 0; H[i].fill(0); }
    for (let i = 0; i < n; i++) {
      const row = Xs[i];
      x[0] = 1;
      for (let j = 0; j < row.length; j++) x[j + 1] = row[j];
      let z = 0;
      for (let j = 0; j < d; j++) z += beta[j] * x[j];
      const p = sigmoid(z), w = Math.max(p * (1 - p), 1e-8), r = p - y[i];
      for (let a = 0; a < d; a++) {
        g[a] += r * x[a];
        const wx = w * x[a];
        for (let b = a; b < d; b++) H[a][b] += wx * x[b];
      }
    }
    for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    for (let a = 1; a < d; a++) { H[a][a] += l2; g[a] += l2 * beta[a]; }
    const step = solve(H, g, d);
    if (!step) break;
    let moved = 0;
    for (let a = 0; a < d; a++) { beta[a] -= step[a]; moved += Math.abs(step[a]); }
    if (moved < 1e-9) break;
  }
  return beta;
}

function predictRaw(beta, xs) {
  let z = beta[0];
  for (let j = 0; j < xs.length; j++) z += beta[j + 1] * xs[j];
  return sigmoid(z);
}

/** Train a model end to end: scaler + weights, returned as one callable predictor. */
function train(X, y, opts) {
  const sc = standardizer(X, X[0].length);
  const Xs = X.map(r => applyScale(r, sc));
  const beta = fit(Xs, y, opts);
  return {
    beta, scaler: sc,
    predict: row => predictRaw(beta, applyScale(row, sc)),
    weights: names => names.map((nm, j) => ({ feature: nm, weight: +beta[j + 1].toFixed(4) }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  };
}

module.exports = { train, fit, standardizer, applyScale, predictRaw, sigmoid, solve };
