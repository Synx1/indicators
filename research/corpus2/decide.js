'use strict';

/**
 * From probability to trade: score decision rules on real prices.
 *
 * ── the conceptual fix ──
 *
 * The live bot enters when `confidence >= 80` AND `price is in [0.35, 0.65]`. Those are two unrelated
 * thresholds, and their interaction is where the money goes wrong:
 *
 *   - Confidence is not price-aware, so an 85% read at 66c and an 85% read at 40c are treated as the
 *     same trade when one has 19 points of edge and the other has 45.
 *   - MAX_PRICE is not direction-aware, so in a trend the agreeing side is priced out and the bot
 *     becomes one-sided by accident. Measured: the model is 56% DOWN before the ceiling and 96% after.
 *
 * The rule here is expected value instead: enter when
 *
 *     p_model - breakeven(ask)  >  edge
 *
 * with breakeven(ask) = ask + 0.07*ask*(1-ask), which is Kalshi's own entry fee. One threshold, in the
 * units that decide whether a bet makes money. It refuses a dear contract unless the model is
 * genuinely that sure, allows a cheap one on a modest read, and has no opinion about direction at all.
 *
 * Every rule is scored on identical rows, and reported split at the chronological midpoint — a rule
 * that only works in the first half is fitted to it.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const FEE_RATE = 0.07;
const SHARES = 15;
const breakEven = ask => ask + FEE_RATE * ask * (1 - ask);
const feeDollars = (ask, n) => Math.ceil(FEE_RATE * n * ask * (1 - ask) * 100) / 100;

function wilson(w, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = w / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

/**
 * Build every priced, predicted candidate: one row per (market, minute) that has both a model
 * probability and a real book. Both sides are offered, so each row carries the YES and NO ask.
 */
function candidates() {
  const preds = JSON.parse(fs.readFileSync(path.join(DIR, 'oos-predictions.json'), 'utf8'));
  const books = JSON.parse(fs.readFileSync(path.join(DIR, 'books.json'), 'utf8'));
  const markets = JSON.parse(fs.readFileSync(path.join(DIR, 'markets.json'), 'utf8'));

  // closeMs -> ticker, per coin, so a prediction row can find its own market.
  const tickerOf = new Map();
  for (const [sym, rows] of Object.entries(markets)) for (const r of rows) tickerOf.set(`${sym}|${r[1]}`, r[0]);

  const out = [];
  for (let i = 0; i < preds.y.length; i++) {
    const [sym, closeMs, el] = preds.meta[i];
    const ticker = tickerOf.get(`${sym}|${closeMs}`);
    if (!ticker) continue;
    const book = books[ticker];
    if (!book || !book.length) continue;
    const minuteMs = closeMs - 15 * 60000 + el * 60000;
    // The book row for THIS minute. end_period_ts is the close of the minute, so the bar covering the
    // decision minute ends one minute later — anything else would price a decision at a later book.
    const bar = book.find(b => b[0] === minuteMs + 60000) || book.find(b => b[0] === minuteMs);
    if (!bar) continue;
    const yesAsk = bar[1], yesBid = bar[2];
    const noAsk = +(1 - yesBid).toFixed(4);
    out.push({ sym, closeMs, el, ticker, y: preds.y[i],
      pModel: preds.pModel[i], pIncumbent: preds.pIncumbent[i], yesAsk, noAsk });
  }
  return out;
}

/** Apply a rule that returns 'YES' | 'NO' | null, taking the FIRST qualifying minute per market. */
function applyRule(rows, rule) {
  const byMarket = new Map();
  for (const r of rows) {
    if (!byMarket.has(r.ticker)) byMarket.set(r.ticker, []);
    byMarket.get(r.ticker).push(r);
  }
  const taken = [];
  for (const [, list] of byMarket) {
    list.sort((a, b) => a.el - b.el);
    for (const r of list) {
      const side = rule(r);
      if (!side) continue;
      const ask = side === 'YES' ? r.yesAsk : r.noAsk;
      if (!(ask > 0.01 && ask < 0.99)) continue;
      const won = side === 'YES' ? r.y === 1 : r.y === 0;
      const fee = feeDollars(ask, SHARES);
      taken.push({ ...r, side, ask, won,
        cost: +(SHARES * ask + fee).toFixed(2),
        pnl: +(won ? SHARES * (1 - ask) - fee : -(SHARES * ask) - fee).toFixed(2) });
      break;
    }
  }
  return taken;
}

function summarize(taken) {
  if (!taken.length) return null;
  const w = taken.filter(t => t.won).length;
  const net = taken.reduce((s, t) => s + t.pnl, 0);
  const cost = taken.reduce((s, t) => s + t.cost, 0);
  const avgAsk = taken.reduce((s, t) => s + t.ask, 0) / taken.length;
  const [lo, hi] = wilson(w, taken.length);
  return { n: taken.length, w, rate: w / taken.length, net, roi: net / cost, avgAsk,
    margin: w / taken.length - breakEven(avgAsk), lo, hi,
    down: taken.filter(t => t.side === 'NO').length / taken.length };
}

/**
 * The question the whole rebuild turns on: is the model better informed than the price?
 *
 * z alone already ranks these markets at AUC ~0.85, which sounds like an edge and is not one — the book
 * knows the same thing and charges for it. An edge exists only where the model is closer to the truth
 * than the ask is. If the book wins both AUC and Brier here, no threshold anywhere downstream can make
 * money, and the honest answer is that there is nothing to trade.
 */
function headToHead(rows) {
  const { auc, brier } = require('./evaluate');
  // The book's implied probability of YES is its own ask, the fairest reading of what it believes.
  const book = rows.map(r => ({ p: r.yesAsk, y: r.y }));
  const model = rows.map(r => ({ p: r.pModel, y: r.y }));
  const zOnly = rows.map(r => ({ p: r.pIncumbent, y: r.y }));
  const base = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const constant = rows.map(r => ({ p: base, y: r.y }));
  const bC = brier(constant);
  const line = (label, pairs) => {
    const a = auc(pairs), b = brier(pairs);
    console.log(`  ${label.padEnd(24)} AUC ${a == null ? ' n/a ' : a.toFixed(4)}   Brier ${b.toFixed(6)}   ` +
      `skill ${(1 - b / bC >= 0 ? '+' : '')}${(1 - b / bC).toFixed(4)}`);
    return { auc: a, brier: b, skill: 1 - b / bC };
  };
  console.log('who is better informed, on identical rows:');
  const out = {
    book: line('the book (yes ask)', book),
    model: line('rebuilt model', model),
    zOnly: line('live engine (z only)', zOnly),
    constant: line('always base rate', constant)
  };
  const verdict = out.model.brier < out.book.brier
    ? 'the model is better calibrated than the price — an edge is possible'
    : 'THE BOOK IS BETTER CALIBRATED THAN THE MODEL — no threshold can manufacture an edge from this';
  console.log(`\n  => ${verdict}\n`);
  return out;
}

function main() {
  const rows = candidates();
  if (!rows.length) { console.log('no priced candidates — run fetch-books.js first'); return; }
  const closes = [...new Set(rows.map(r => r.closeMs))].sort((a, b) => a - b);
  const MID = closes[Math.floor(closes.length / 2)];
  console.log(`${rows.length} priced candidate rows across ${new Set(rows.map(r => r.ticker)).size} markets`);
  console.log(`split at ${new Date(MID).toISOString().slice(0, 16)}\n`);
  const h2h = headToHead(rows);

  const evRule = (edge, key) => r => {
    const yes = r[key] - breakEven(r.yesAsk);
    const no = (1 - r[key]) - breakEven(r.noAsk);
    if (yes >= no && yes > edge) return 'YES';
    if (no > yes && no > edge) return 'NO';
    return null;
  };
  // The incumbent, reconstructed: confidence >= 80 on the z-only model, price inside 35-65c.
  const incumbentRule = r => {
    const conf = Math.max(r.pIncumbent, 1 - r.pIncumbent);
    if (conf < 0.80) return null;
    const side = r.pIncumbent >= 0.5 ? 'YES' : 'NO';
    const ask = side === 'YES' ? r.yesAsk : r.noAsk;
    return ask >= 0.35 && ask <= 0.65 ? side : null;
  };

  const RULES = [
    ['live engine (conf>=80, 35-65c)', incumbentRule],
    ['EV edge > 0.02 (model)', evRule(0.02, 'pModel')],
    ['EV edge > 0.05 (model)', evRule(0.05, 'pModel')],
    ['EV edge > 0.10 (model)', evRule(0.10, 'pModel')],
    ['EV edge > 0.15 (model)', evRule(0.15, 'pModel')],
    ['EV edge > 0.10 (z only)', evRule(0.10, 'pIncumbent')],
  ];

  console.log('rule                              trades  win%     ROI      net$     margin   %DOWN   1st half         2nd half');
  const results = [];
  for (const [label, rule] of RULES) {
    const taken = applyRule(rows, rule);
    const a = summarize(taken);
    if (!a) { console.log(`${label.padEnd(33)}      0`); continue; }
    const h1 = summarize(taken.filter(t => t.closeMs < MID));
    const h2 = summarize(taken.filter(t => t.closeMs >= MID));
    const half = s => (s ? `${s.w}/${s.n} ${(s.rate * 100).toFixed(0)}% ${s.net >= 0 ? '+' : ''}$${s.net.toFixed(0)}`.padEnd(16) : 'n/a'.padEnd(16));
    console.log(`${label.padEnd(33)} ${String(a.n).padStart(6)}  ${(a.rate * 100).toFixed(1).padStart(5)}%  ` +
      `${(a.roi * 100 >= 0 ? '+' : '')}${(a.roi * 100).toFixed(1).padStart(5)}%  ${(a.net >= 0 ? '+' : '')}$${a.net.toFixed(0).padStart(6)}  ` +
      `${(a.margin * 100 >= 0 ? '+' : '')}${(a.margin * 100).toFixed(1).padStart(5)}pt  ${(a.down * 100).toFixed(0).padStart(4)}%   ${half(h1)} ${half(h2)}`);
    results.push({ label, ...a, firstHalf: h1, secondHalf: h2 });
  }
  fs.writeFileSync(path.join(DIR, 'decisions.json'), JSON.stringify({ rows: rows.length, mid: MID, headToHead: h2h, results }, null, 2));
  console.log('\n-> decisions.json');
}

if (require.main === module) main();
module.exports = { candidates, applyRule, summarize, breakEven };
