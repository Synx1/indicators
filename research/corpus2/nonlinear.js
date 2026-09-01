'use strict';

/**
 * The linear tests, redone with a model that can see curvature and interaction.
 *
 * The last study closed on a LINEAR residual test, and linearity was a real limitation: RSI matters at
 * both ends, z should interact with the clock, volume probably only matters when extreme. A linear term
 * has to average all of that into one slope and will report approximately zero — which is exactly what
 * RSI's +0.0024 weight was. So the conclusion is not safe until trees have had a turn.
 *
 * Two experiments, both walk-forward with weekly refits, early stopping on the tail of each training
 * window so tree count never touches the test fold:
 *
 *   1  NO PRICE   — GBM on the 13 features against the live engine's Phi(z). Do the indicators carry
 *                   non-linear information about the outcome?
 *   2  WITH PRICE — GBM on (ask + 13 features) against GBM on (ask) alone. This is the one that decides
 *                   it: if trees on top of the price cannot beat the price, there is nothing left.
 */

const fs = require('fs');
const path = require('path');
const gbm = require('./gbm');
const { train: logistic } = require('./model');
const { auc, brier, phi, reliability } = require('./evaluate');
const { candidates } = require('./decide');

const DIR = __dirname;
const DAY = 86400000;
const REFIT = 7;
const TRAIN_CAP = 150000;      // trees need rows, not all of them; 150k is ample for 14 features
const logit = p => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };

function report(label, pairs, bC) {
  const a = auc(pairs), b = brier(pairs);
  console.log(`  ${label.padEnd(34)} AUC ${a == null ? ' n/a  ' : a.toFixed(4)}   Brier ${b.toFixed(6)}   skill ${(1 - b / bC >= 0 ? '+' : '')}${(1 - b / bC).toFixed(4)}`);
  return { auc: a, brier: b, skill: 1 - b / bC };
}

/** Walk forward over days, refitting every REFIT days on strictly earlier rows. */
function walkForward(rows, buildX, fitter, { cap = TRAIN_CAP } = {}) {
  const days = [...new Set(rows.map(r => r.day))].sort((a, b) => a - b);
  const START = Math.max(8, Math.floor(days.length * 0.4));
  const test = new Set(days.slice(START));
  const out = [];
  let model = null, since = REFIT;
  for (const d of days) {
    if (!test.has(d)) continue;
    if (since >= REFIT) {
      let tr = rows.filter(r => r.day < d);
      // Keep the most RECENT rows when capping: nearest history is the relevant history.
      if (tr.length > cap) tr = tr.slice(tr.length - cap);
      model = fitter(tr.map(buildX), tr.map(r => r.y));
      since = 0;
      process.stdout.write(`    refit on ${tr.length} rows${model.trees ? ` → ${model.trees} trees` : ''}\n`);
    }
    since++;
    for (const r of rows) if (r.day === d) out.push({ p: model.predict(buildX(r)), y: r.y });
  }
  return { pairs: out, model };
}

function experiment1() {
  console.log('\n── 1. NO PRICE: do the indicators carry non-linear information? ──\n');
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json'), 'utf8'));
  const zIdx = raw.names.indexOf('z');
  const rows = raw.X.map((x, i) => ({ x, y: raw.y[i], day: Math.floor(raw.meta[i][1] / DAY) }));
  rows.sort((a, b) => a.day - b.day);

  const g = walkForward(rows, r => r.x, (X, y) => gbm.train(X, y, { rounds: 300, depth: 4, lr: 0.06 }));
  const inc = g.pairs.map((p, k) => ({ p: phi(0), y: p.y }));       // placeholder, filled below
  // Rebuild the incumbent on exactly the rows the GBM scored, in the same order.
  const days = [...new Set(rows.map(r => r.day))].sort((a, b) => a - b);
  const START = Math.max(8, Math.floor(days.length * 0.4));
  const test = new Set(days.slice(START));
  let k = 0;
  for (const d of days) { if (!test.has(d)) continue; for (const r of rows) if (r.day === d) { inc[k] = { p: phi(r.x[zIdx]), y: r.y }; k++; } }

  const base = g.pairs.reduce((s, r) => s + r.y, 0) / g.pairs.length;
  const bC = brier(g.pairs.map(r => ({ p: base, y: r.y })));
  console.log(`\n  out-of-sample rows: ${g.pairs.length}\n`);
  const rInc = report('live engine (z only)', inc, bC);
  const rGbm = report('GBM on 13 features', g.pairs, bC);
  report('always base rate', g.pairs.map(r => ({ p: base, y: r.y })), bC);
  console.log(`\n  trees over the live engine: AUC ${(rGbm.auc - rInc.auc >= 0 ? '+' : '')}${(rGbm.auc - rInc.auc).toFixed(4)}, Brier ${(rInc.brier - rGbm.brier).toFixed(6)}`);
  console.log('\n  what the trees split on:');
  for (const f of g.model.importance(raw.names).slice(0, 8)) console.log(`    ${f.feature.padEnd(12)} ${(f.share * 100).toFixed(1)}%`);
  return { incumbent: rInc, gbm: rGbm };
}

function experiment2() {
  console.log('\n── 2. WITH PRICE: can trees beat the ask? (the decisive one) ──\n');
  const priced = candidates();
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json'), 'utf8'));
  const featByKey = new Map();
  for (let i = 0; i < raw.X.length; i++) featByKey.set(`${raw.meta[i][0]}|${raw.meta[i][1]}|${raw.meta[i][2]}`, raw.X[i]);

  const rows = [];
  for (const r of priced) {
    const f = featByKey.get(`${r.sym}|${r.closeMs}|${r.el}`);
    if (!f || !r.infoAskIsContemporaneous) continue;
    // infoAsk: contemporaneous with the features. yesAsk closes a minute later.
    rows.push({ y: r.y, ask: r.infoAsk, feats: f, day: Math.floor(r.closeMs / DAY) });
  }
  rows.sort((a, b) => a.day - b.day);
  console.log(`  ${rows.length} priced+featured rows\n`);

  const askOnly = walkForward(rows, r => [logit(r.ask)], (X, y) => gbm.train(X, y, { rounds: 200, depth: 3, lr: 0.08 }));
  const both = walkForward(rows, r => [logit(r.ask), ...r.feats], (X, y) => gbm.train(X, y, { rounds: 300, depth: 4, lr: 0.06 }));
  const lin = walkForward(rows, r => [logit(r.ask), ...r.feats], (X, y) => logistic(X, y, { l2: 2.0 }));

  const base = both.pairs.reduce((s, r) => s + r.y, 0) / both.pairs.length;
  const bC = brier(both.pairs.map(r => ({ p: base, y: r.y })));
  const rawAsk = rows.filter(r => [...new Set(rows.map(x => x.day))].sort((a, b) => a - b).slice(Math.max(8, Math.floor([...new Set(rows.map(x => x.day))].length * 0.4))).includes(r.day))
    .map(r => ({ p: r.ask, y: r.y }));
  console.log(`\n  out-of-sample rows: ${both.pairs.length}\n`);
  const rRaw = report('the raw ask', rawAsk, bC);
  const rAsk = report('GBM on the ask alone', askOnly.pairs, bC);
  const rBoth = report('GBM on ask + 13 indicators', both.pairs, bC);
  const rLin = report('logistic on ask + indicators', lin.pairs, bC);

  const gain = rAsk.brier - rBoth.brier;
  console.log(`\n  Brier gain from the indicators, non-linearly, on top of the price: ${gain >= 0 ? '+' : ''}${gain.toFixed(6)}`);
  console.log(`  ${gain > 0.0005
    ? 'TREES FIND SOMETHING LINEAR REGRESSION MISSED — worth pricing.'
    : 'Even with curvature and interaction available, the indicators add nothing to the price.'}`);
  console.log('\n  what the trees split on:');
  for (const f of both.model.importance(['logitAsk', ...raw.names]).slice(0, 8)) console.log(`    ${f.feature.padEnd(12)} ${(f.share * 100).toFixed(1)}%`);
  console.log('\n  calibration of GBM(ask + indicators):');
  for (const b of reliability(both.pairs)) console.log(`    ${b.band.padEnd(9)} n=${String(b.n).padStart(5)}  said ${(b.said * 100).toFixed(1)}%  happened ${(b.happened * 100).toFixed(1)}%`);
  return { rawAsk: rRaw, askOnly: rAsk, askPlus: rBoth, linear: rLin, brierGain: gain };
}

const one = experiment1();
const two = experiment2();
fs.writeFileSync(path.join(DIR, 'nonlinear.json'), JSON.stringify({ noPrice: one, withPrice: two }, null, 2));
console.log('\n-> nonlinear.json');
