'use strict';

/**
 * The decisive experiment: do the indicators know anything the PRICE does not already know?
 *
 * ── why this is the only test that settles it ──
 *
 * z alone ranks these markets at AUC ~0.85. That reads like a discovery until you notice the book
 * ranks them too, and charges accordingly — the ask IS a probability, published by people who can see
 * the same chart. So "the model predicts well" is not evidence of an edge. The only evidence that
 * counts is whether the model knows something the price has left out.
 *
 * Two nested models, fitted walk-forward on identical rows:
 *
 *   A   y ~ f(ask)                     — the book alone, recalibrated. The benchmark to beat.
 *   B   y ~ f(ask, all 13 features)    — the book PLUS everything the bot computes.
 *
 * If B does not beat A out of sample, the indicators are redundant to the price and no gate, threshold
 * or confirmation rule built on them can be profitable. That would be a hard result, and it is the one
 * worth being sure about before shipping anything.
 *
 * The ask is passed as its logit so the model can shade it rather than having to relearn its shape.
 */

const fs = require('fs');
const path = require('path');
const { train } = require('./model');
const { auc, brier, reliability } = require('./evaluate');
const { candidates } = require('./decide');

const DIR = __dirname;
const DAY = 86400000;
const logit = p => Math.log(Math.min(Math.max(p, 1e-6), 1 - 1e-6) / (1 - Math.min(Math.max(p, 1e-6), 1 - 1e-6)));

function main() {
  const rows = candidates();
  if (rows.length < 2000) { console.log(`only ${rows.length} priced rows — need the book fetch to finish`); return; }

  // Features must be re-read: `candidates()` carries predictions and prices, not the raw matrix.
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json'), 'utf8'));
  const keyOf = m => `${m[0]}|${m[1]}|${m[2]}`;
  const featByKey = new Map();
  for (let i = 0; i < raw.X.length; i++) featByKey.set(keyOf(raw.meta[i]), raw.X[i]);

  const data = [];
  for (const r of rows) {
    const f = featByKey.get(`${r.sym}|${r.closeMs}|${r.el}`);
    if (!f) continue;
    data.push({ day: Math.floor(r.closeMs / DAY), closeMs: r.closeMs, y: r.y, ask: r.yesAsk, feats: f });
  }
  data.sort((a, b) => a.closeMs - b.closeMs);
  const days = [...new Set(data.map(d => d.day))].sort((a, b) => a - b);
  const START = Math.max(8, Math.floor(days.length * 0.4));
  const testDays = new Set(days.slice(START));
  console.log(`${data.length} priced+featured rows over ${days.length} days`);
  console.log(`fit on the first ${START} days, test forward on ${days.length - START}\n`);

  const A = [], B = [], BOOK = [];
  let weights = null;
  const REFIT = 7;
  let mA = null, mB = null, sinceRefit = REFIT;

  for (const d of days) {
    if (!testDays.has(d)) continue;
    if (sinceRefit >= REFIT) {
      const tr = data.filter(x => x.day < d);
      mA = train(tr.map(x => [logit(x.ask)]), tr.map(x => x.y), { l2: 1.0 });
      mB = train(tr.map(x => [logit(x.ask), ...x.feats]), tr.map(x => x.y), { l2: 2.0 });
      weights = mB.weights(['logitAsk', ...raw.names]);
      sinceRefit = 0;
      process.stdout.write(`  refit on ${tr.length} rows\n`);
    }
    sinceRefit++;
    for (const x of data) {
      if (x.day !== d) continue;
      A.push({ p: mA.predict([logit(x.ask)]), y: x.y });
      B.push({ p: mB.predict([logit(x.ask), ...x.feats]), y: x.y });
      BOOK.push({ p: x.ask, y: x.y });
    }
  }

  const base = B.reduce((s, r) => s + r.y, 0) / B.length;
  const bC = brier(B.map(r => ({ p: base, y: r.y })));
  const show = (label, pairs) => {
    const a = auc(pairs), b = brier(pairs);
    console.log(`  ${label.padEnd(34)} AUC ${a == null ? 'n/a' : a.toFixed(4)}   Brier ${b.toFixed(6)}   skill ${(1 - b / bC >= 0 ? '+' : '')}${(1 - b / bC).toFixed(4)}`);
    return { auc: a, brier: b, skill: 1 - b / bC };
  };
  console.log(`out-of-sample rows: ${B.length} · base rate ${(base * 100).toFixed(2)}%\n`);
  const rBook = show('the raw ask', BOOK);
  const rA = show('A: ask, recalibrated', A);
  const rB = show('B: ask + all 13 indicators', B);
  show('always base rate', B.map(r => ({ p: base, y: r.y })));

  const gain = rA.brier - rB.brier;
  console.log(`\n  Brier gain from every indicator, on top of the price: ${gain >= 0 ? '+' : ''}${gain.toFixed(6)}`);
  console.log(`  ${gain > 0.0005
    ? 'The indicators add information the price lacks. An edge is plausible; size it by how much.'
    : 'The indicators add essentially NOTHING beyond the price. No gate built on them can be profitable.'}`);

  console.log('\nwhat B leans on (the ask should dominate; anything near it is a real signal):');
  for (const w of weights.slice(0, 8)) console.log(`  ${w.feature.padEnd(12)} ${w.weight >= 0 ? '+' : ''}${w.weight}`);

  console.log('\ncalibration of B:');
  for (const b of reliability(B)) {
    console.log(`  ${b.band.padEnd(9)} n=${String(b.n).padStart(5)}  said ${(b.said * 100).toFixed(1)}%  happened ${(b.happened * 100).toFixed(1)}%`);
  }

  fs.writeFileSync(path.join(DIR, 'residual.json'), JSON.stringify({
    rows: B.length, baseRate: base, book: rBook, askOnly: rA, askPlusIndicators: rB,
    brierGain: gain, weights, reliabilityB: reliability(B)
  }, null, 2));
  console.log('\n-> residual.json');
}

if (require.main === module) main();
