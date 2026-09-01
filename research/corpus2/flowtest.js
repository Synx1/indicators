'use strict';

/**
 * Does aggressive order flow know anything the price does not?
 *
 * Every feature tested so far is a function of the candles, and the ask is the market's own summary of
 * those candles — so their redundancy was almost predictable in hindsight. `taker_side` is different in
 * kind: it says who crossed the spread, which no chart contains.
 *
 * Three nested models, walk-forward, identical rows:
 *
 *   A   ask                         — the benchmark
 *   B   ask + flow                  — does flow add anything the price lacks?
 *   C   ask + flow + 13 indicators  — does anything at all?
 *
 * Flow at decision minute m uses buckets 0..m-1 ONLY. Including minute m would let the model see trades
 * printed during the very minute it is deciding in, which is not information the live bot could act on.
 */

const fs = require('fs');
const path = require('path');
const gbm = require('./gbm');
const { train: logistic } = require('./model');
const { auc, brier, reliability } = require('./evaluate');
const { candidates } = require('./decide');

const DIR = __dirname;
const DAY = 86400000;
const REFIT = 7;
const logit = p => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const FLOW_NAMES = ['netFlowCum', 'netFlowRate', 'flowSizeLog', 'flowTrades', 'netFlowLast', 'flowCapped'];
// Book microstructure, from the bars already fetched. Distinct from the price LEVEL, which is the thing
// everything else has proved redundant to: a widening spread says the market is less sure, and a moving
// ask says it is repricing. Cheap to add and it completes the "anything the level misses" question.
const BOOK_NAMES = ['spread', 'askChange1m', 'askChange2m', 'bidChange1m'];

function bookFeatures(book, minuteMs) {
  const at = ms => book.find(b => b[0] === ms) || null;
  const now = at(minuteMs);
  if (!now) return [0, 0, 0, 0];
  const back = k => at(minuteMs - k * 60000);
  const a1 = back(1), a2 = back(2);
  return [
    +(now[1] - now[2]).toFixed(4),
    a1 ? +(now[1] - a1[1]).toFixed(4) : 0,
    a2 ? +(now[1] - a2[1]).toFixed(4) : 0,
    a1 ? +(now[2] - a1[2]).toFixed(4) : 0
  ];
}

/** Flow features from buckets strictly before minute `el`. Zeroes when the tape is silent, not nulls —
 *  "no aggressive trades yet" is itself a state, and dropping those rows would bias the sample. */
function flowFeatures(entry, el) {
  const perMin = (entry && entry.perMin) || {};
  let net = 0, total = 0, trades = 0, last = 0;
  for (let m = 0; m < el; m++) {
    const b = perMin[m];
    if (!b) continue;
    net += b[0]; total += b[1]; trades += b[2];
    if (m === el - 1) last = b[0];
  }
  return [
    Math.sign(net) * Math.log1p(Math.abs(net)),      // signed log: size spans orders of magnitude
    total > 0 ? net / total : 0,                     // direction, normalised to [-1, 1]
    Math.log1p(total),
    trades,
    Math.sign(last) * Math.log1p(Math.abs(last)),
    entry && entry.capped ? 1 : 0
  ];
}

function walkForward(rows, buildX, fitter) {
  const days = [...new Set(rows.map(r => r.day))].sort((a, b) => a - b);
  const START = Math.max(8, Math.floor(days.length * 0.4));
  const test = new Set(days.slice(START));
  const out = [];
  let model = null, since = REFIT;
  for (const d of days) {
    if (!test.has(d)) continue;
    if (since >= REFIT) { const tr = rows.filter(r => r.day < d); model = fitter(tr.map(buildX), tr.map(r => r.y)); since = 0; }
    since++;
    for (const r of rows) if (r.day === d) out.push({ p: model.predict(buildX(r)), y: r.y });
  }
  return { pairs: out, model };
}

function main() {
  if (!fs.existsSync(path.join(DIR, 'flow.json'))) { console.log('run fetch-flow.js first'); return; }
  const flow = JSON.parse(fs.readFileSync(path.join(DIR, 'flow.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'features.json'), 'utf8'));
  const featByKey = new Map();
  for (let i = 0; i < raw.X.length; i++) featByKey.set(`${raw.meta[i][0]}|${raw.meta[i][1]}|${raw.meta[i][2]}`, raw.X[i]);

  const books = JSON.parse(fs.readFileSync(path.join(DIR, 'books.json'), 'utf8'));
  const rows = [];
  for (const r of candidates()) {
    const f = featByKey.get(`${r.sym}|${r.closeMs}|${r.el}`);
    const fl = flow[r.ticker];
    if (!f || !fl || !r.infoAskIsContemporaneous) continue;
    const minuteMs = r.closeMs - 15 * 60000 + r.el * 60000;
    // infoAsk: contemporaneous with the features, the flow buckets and the book features.
    rows.push({ y: r.y, ask: r.infoAsk, feats: f, flow: flowFeatures(fl, r.el),
      book: bookFeatures(books[r.ticker] || [], minuteMs), day: Math.floor(r.closeMs / DAY) });
  }
  rows.sort((a, b) => a.day - b.day);
  const silent = rows.filter(r => r.flow[3] === 0).length;
  console.log(`${rows.length} rows with price, indicators and flow · ${silent} (${(silent / rows.length * 100).toFixed(0)}%) had no aggressive trade yet at the decision minute\n`);
  if (rows.length < 2000) { console.log('too few rows — let the flow fetch finish'); return; }

  const A = walkForward(rows, r => [logit(r.ask)], (X, y) => gbm.train(X, y, { rounds: 200, depth: 3, lr: 0.08 }));
  const B = walkForward(rows, r => [logit(r.ask), ...r.flow], (X, y) => gbm.train(X, y, { rounds: 300, depth: 4, lr: 0.06 }));
  const M = walkForward(rows, r => [logit(r.ask), ...r.book], (X, y) => gbm.train(X, y, { rounds: 250, depth: 3, lr: 0.07 }));
  const C = walkForward(rows, r => [logit(r.ask), ...r.flow, ...r.book, ...r.feats], (X, y) => gbm.train(X, y, { rounds: 300, depth: 4, lr: 0.06 }));
  const Blin = walkForward(rows, r => [logit(r.ask), ...r.flow], (X, y) => logistic(X, y, { l2: 2.0 }));

  const base = A.pairs.reduce((s, r) => s + r.y, 0) / A.pairs.length;
  const bC = brier(A.pairs.map(r => ({ p: base, y: r.y })));
  const show = (label, pairs) => {
    const a = auc(pairs), b = brier(pairs);
    console.log(`  ${label.padEnd(32)} AUC ${a == null ? ' n/a  ' : a.toFixed(4)}   Brier ${b.toFixed(6)}   skill ${(1 - b / bC >= 0 ? '+' : '')}${(1 - b / bC).toFixed(4)}`);
    return { auc: a, brier: b, skill: 1 - b / bC };
  };
  console.log(`out-of-sample rows: ${A.pairs.length}\n`);
  const rA = show('A: ask', A.pairs);
  const rB = show('B: ask + flow', B.pairs);
  const rM = show('M: ask + book microstructure', M.pairs);
  const rC = show('C: ask + flow + book + indicators', C.pairs);
  const rBl = show('B linear (ask + flow)', Blin.pairs);

  const gainFlow = rA.brier - rB.brier;
  console.log(`\n  Brier gain from FLOW on top of the price: ${gainFlow >= 0 ? '+' : ''}${gainFlow.toFixed(6)}`);
  console.log(`  ${gainFlow > 0.0005
    ? 'ORDER FLOW ADDS INFORMATION THE PRICE LACKS — this is the first thing that has. Worth pricing.'
    : 'Order flow adds nothing beyond the price either.'}`);

  const gainBook = rA.brier - rM.brier;
  console.log(`  Brier gain from BOOK microstructure (spread, ask drift): ${gainBook >= 0 ? '+' : ''}${gainBook.toFixed(6)}`);
  console.log('\n  what B splits on:');
  for (const f of B.model.importance(['logitAsk', ...FLOW_NAMES])) console.log(`    ${f.feature.padEnd(13)} ${(f.share * 100).toFixed(1)}%`);
  console.log('\n  what M splits on:');
  for (const f of M.model.importance(['logitAsk', ...BOOK_NAMES])) console.log(`    ${f.feature.padEnd(13)} ${(f.share * 100).toFixed(1)}%`);
  console.log('\n  calibration of B:');
  for (const b of reliability(B.pairs)) console.log(`    ${b.band.padEnd(9)} n=${String(b.n).padStart(5)}  said ${(b.said * 100).toFixed(1)}%  happened ${(b.happened * 100).toFixed(1)}%`);

  fs.writeFileSync(path.join(DIR, 'flowtest.json'), JSON.stringify({
    rows: A.pairs.length, silentShare: silent / rows.length,
    ask: rA, askFlow: rB, askBook: rM, askFlowBookIndicators: rC, askFlowLinear: rBl,
    brierGainFromFlow: gainFlow, brierGainFromBook: gainBook,
    importanceB: B.model.importance(['logitAsk', ...FLOW_NAMES])
  }, null, 2));
  console.log('\n-> flowtest.json');
}

if (require.main === module) main();
