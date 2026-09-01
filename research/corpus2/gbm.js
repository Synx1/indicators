'use strict';

/**
 * Histogram gradient-boosted trees, written from scratch (this repo has no ML dependency).
 *
 * ── why a non-linear model is a genuinely different test ──
 *
 * The residual test that closed the last study used LINEAR logistic regression, so it could only ask
 * whether each indicator shifts the odds in one direction by a constant amount. That is the wrong shape
 * for most of these signals:
 *
 *   - RSI should matter at BOTH ends (30 and 70 are both informative, 50 is not) — a linear term cannot
 *     express that and will fit approximately zero, which is exactly what happened (+0.0024).
 *   - z should interact with the clock: 1.5 sigma with 12 minutes left is a different bet from 1.5 sigma
 *     with 8, and a linear model has to pick one slope for both.
 *   - Volume probably only matters when it is extreme.
 *
 * Trees get all of that for free. So "the indicators add nothing" is only established once a model that
 * CAN see curvature and interaction still finds nothing. That is what this exists to check.
 *
 * Design notes: 255 quantile bins per feature so splits are found in one pass over histograms rather
 * than by sorting; logistic loss with Newton leaf values (sum g / sum h), which is what makes boosting
 * on a binary target well behaved; early stopping on a held-out tail of the training window so tree
 * count is chosen without ever consulting the test fold.
 */

const BINS = 255;

/** Quantile bin edges per feature, computed on TRAIN only — bin edges are a fitted parameter. */
function makeBinner(X, cols) {
  const edges = [];
  const n = X.length;
  const sampleStride = Math.max(1, Math.floor(n / 20000));   // 20k sample is plenty for 255 quantiles
  for (let j = 0; j < cols; j++) {
    const vals = [];
    for (let i = 0; i < n; i += sampleStride) vals.push(X[i][j]);
    vals.sort((a, b) => a - b);
    const e = [];
    for (let b = 1; b < BINS; b++) {
      const v = vals[Math.floor(vals.length * b / BINS)];
      if (!e.length || v > e[e.length - 1]) e.push(v);
    }
    edges.push(e);
  }
  return edges;
}

function binRow(row, edges) {
  const out = new Uint8Array(row.length);
  for (let j = 0; j < row.length; j++) {
    const e = edges[j];
    let lo = 0, hi = e.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (row[j] > e[m]) lo = m + 1; else hi = m; }
    out[j] = lo;
  }
  return out;
}

/**
 * One depth-limited tree fitted to gradients/hessians.
 * Nodes are grown breadth-first; a split is taken only if it beats `minGain` and both children keep
 * `minChild` hessian mass, which is what stops a leaf being fitted to a handful of rows.
 */
function growTree(Xb, g, h, idx, { depth, minChild, minGain, lambda, cols }) {
  const node = { idx, depth: 0 };
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    let G = 0, H = 0;
    for (const i of cur.idx) { G += g[i]; H += h[i]; }
    cur.value = -G / (H + lambda);
    if (cur.depth >= depth || cur.idx.length < 2 * minChild) { cur.leaf = true; continue; }

    let best = null;
    const parentScore = (G * G) / (H + lambda);
    for (let j = 0; j < cols; j++) {
      const hg = new Float64Array(BINS), hh = new Float64Array(BINS);
      for (const i of cur.idx) { const b = Xb[i][j]; hg[b] += g[i]; hh[b] += h[i]; }
      let gl = 0, hl = 0;
      for (let b = 0; b < BINS - 1; b++) {
        gl += hg[b]; hl += hh[b];
        if (hl < minChild) continue;
        const gr = G - gl, hr = H - hl;
        if (hr < minChild) break;
        const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parentScore;
        if (gain > minGain && (!best || gain > best.gain)) best = { gain, j, bin: b };
      }
    }
    if (!best) { cur.leaf = true; continue; }
    const left = [], right = [];
    for (const i of cur.idx) (Xb[i][best.j] <= best.bin ? left : right).push(i);
    if (!left.length || !right.length) { cur.leaf = true; continue; }
    cur.j = best.j; cur.bin = best.bin; cur.leaf = false;
    cur.left = { idx: left, depth: cur.depth + 1 };
    cur.right = { idx: right, depth: cur.depth + 1 };
    delete cur.idx;
    stack.push(cur.left, cur.right);
  }
  // Drop the row lists so a fitted model does not retain the training set.
  (function prune(n) { delete n.idx; if (!n.leaf) { prune(n.left); prune(n.right); } })(node);
  return node;
}

const treePredict = (node, xb) => {
  let n = node;
  while (!n.leaf) n = xb[n.j] <= n.bin ? n.left : n.right;
  return n.value;
};

const sigmoid = z => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/**
 * Fit with early stopping. The last `valFrac` of the (chronologically ordered) training window is held
 * back to choose the tree count — never the test fold, or the number of trees becomes a leaked
 * hyperparameter.
 */
function train(X, y, {
  rounds = 400, lr = 0.06, depth = 3, minChild = 40, minGain = 1e-4, lambda = 1.0, valFrac = 0.15, patience = 25
} = {}) {
  const cols = X[0].length;
  const cut = Math.floor(X.length * (1 - valFrac));
  const edges = makeBinner(X.slice(0, cut), cols);
  const Xb = X.map(r => binRow(r, edges));

  const base = Math.log(Math.max(1e-6, y.reduce((a, b) => a + b, 0) / y.length) /
    Math.max(1e-6, 1 - y.reduce((a, b) => a + b, 0) / y.length));
  const F = new Float64Array(X.length).fill(base);
  const g = new Float64Array(X.length), h = new Float64Array(X.length);
  const trIdx = []; for (let i = 0; i < cut; i++) trIdx.push(i);

  const trees = [];
  let bestLoss = Infinity, bestCount = 0, since = 0;
  for (let r = 0; r < rounds; r++) {
    for (const i of trIdx) { const p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = Math.max(p * (1 - p), 1e-6); }
    const tree = growTree(Xb, g, h, trIdx.slice(), { depth, minChild, minGain, lambda, cols });
    trees.push(tree);
    for (let i = 0; i < X.length; i++) F[i] += lr * treePredict(tree, Xb[i]);

    let loss = 0, n = 0;
    for (let i = cut; i < X.length; i++) {
      const p = Math.min(Math.max(sigmoid(F[i]), 1e-9), 1 - 1e-9);
      loss -= y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p); n++;
    }
    loss /= Math.max(1, n);
    if (loss < bestLoss - 1e-6) { bestLoss = loss; bestCount = trees.length; since = 0; }
    else if (++since >= patience) break;
  }
  const kept = trees.slice(0, bestCount || trees.length);
  return {
    trees: kept.length, valLoss: bestLoss,
    predict(row) {
      const xb = binRow(row, edges);
      let f = base;
      for (const t of kept) f += lr * treePredict(t, xb);
      return sigmoid(f);
    },
    /** Total split gain per feature — which signals the trees actually used. */
    importance(names) {
      const imp = new Float64Array(cols);
      const walk = n => { if (n.leaf) return; imp[n.j] += 1; walk(n.left); walk(n.right); };
      for (const t of kept) walk(t);
      const total = imp.reduce((a, b) => a + b, 0) || 1;
      return names.map((nm, j) => ({ feature: nm, share: +(imp[j] / total).toFixed(4) }))
        .sort((a, b) => b.share - a.share);
    }
  };
}

module.exports = { train, sigmoid, BINS };
