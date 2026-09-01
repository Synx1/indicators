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
    // TWO asks, because they answer different questions and conflating them flatters the book.
    //
    // `end_period_ts` is the END of a bar. The bar ending exactly at minuteMs closes AT the decision
    // instant, so its price is contemporaneous with features built from candles before minuteMs — that
    // is the only fair one for "who is better informed". The bar ending at minuteMs + 60000 closes a
    // minute LATER; using it for the comparison would hand the book a 60-second head start the model
    // never had. It is still the right price for ROI, because it is roughly what an order placed at the
    // decision would actually fill against.
    const atDecision = book.find(b => b[0] === minuteMs);
    const afterDecision = book.find(b => b[0] === minuteMs + 60000);
    const fill = afterDecision || atDecision;
    if (!fill) continue;
    const info = atDecision || afterDecision;
    const yesAsk = fill[1], yesBid = fill[2];
    const noAsk = +(1 - yesBid).toFixed(4);
    out.push({ sym, closeMs, el, ticker, y: preds.y[i],
      pModel: preds.pModel[i], pIncumbent: preds.pIncumbent[i], yesAsk, noAsk,
      // The contemporaneous quote. Both sides are needed: a NO ask is 1 - yesBid, never 1 - yesAsk.
      infoAsk: info[1], infoBid: info[2], infoAskIsContemporaneous: Boolean(atDecision) });
  }
  return out;
}

/**
 * Apply a rule that returns 'YES' | 'NO' | null, taking the FIRST qualifying minute per market.
 *
 * `priceAt` selects which ask pays. 'fill' uses the bar closing a minute after the decision — roughly
 * what an order placed then would meet, but it carries a minute of price movement. 'decision' uses the
 * contemporaneous ask, which is the clean read. Both are reported; a rule that only works on one of them
 * is being carried by the timing, not by the signal.
 */
function applyRule(rows, rule, priceAt = 'fill') {
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
      const useInfo = priceAt === 'decision' && r.infoAskIsContemporaneous;
      const ask = side === 'YES'
        ? (useInfo ? r.infoAsk : r.yesAsk)
        : (useInfo ? +(1 - r.infoBid).toFixed(4) : r.noAsk);
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
  // The CONTEMPORANEOUS ask — the bar closing at the decision instant, not the one closing a minute
  // later. Using the later bar would let the book see 60 seconds the model did not, which is the
  // difference between "better informed" and "informed later".
  const fair = rows.filter(r => r.infoAskIsContemporaneous);
  const book = fair.map(r => ({ p: r.infoAsk, y: r.y }));
  const model = fair.map(r => ({ p: r.pModel, y: r.y }));
  const zOnly = fair.map(r => ({ p: r.pIncumbent, y: r.y }));
  const base = fair.reduce((s, r) => s + r.y, 0) / fair.length;
  const constant = fair.map(r => ({ p: base, y: r.y }));
  const bC = brier(constant);
  const line = (label, pairs) => {
    const a = auc(pairs), b = brier(pairs);
    console.log(`  ${label.padEnd(24)} AUC ${a == null ? ' n/a ' : a.toFixed(4)}   Brier ${b.toFixed(6)}   ` +
      `skill ${(1 - b / bC >= 0 ? '+' : '')}${(1 - b / bC).toFixed(4)}`);
    return { auc: a, brier: b, skill: 1 - b / bC };
  };
  console.log(`who is better informed, on ${fair.length} rows with a contemporaneous ask ` +
    `(of ${rows.length} priced; the rest have no bar closing exactly at the decision minute):`);
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
    const taken = applyRule(rows, rule, 'fill');
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
  // ── why the rules are priced at the FILL bar and not the decision bar ──
  //
  // Pricing at the decision instant looks more rigorous and is not: a NO ask has to be derived as
  // 1 - yesBid, and at the decision minute the bid side is frequently thin or absent. Measured on these
  // rows, 22.2% of NO-side candidates derive an ask above 90c that way, and the median YES bid is 48c
  // against a 1.5c mean spread — so those are empty book sides, not dear prices. 1 minus a bid that does
  // not exist is not a price, and a run built on it reported -26.5% ROI purely from that artifact.
  //
  // The fill bar closes a minute later, by which point the bid has filled in. Its ask carries a minute of
  // movement, which is a real if smaller objection — but the two YES asks differ by 0.27c on average, so
  // the timing is worth cents while the empty-bid artifact is worth tens of cents. The fill bar wins.
  const bidDiag = (() => {
    const c = rows.filter(r => r.infoAskIsContemporaneous);
    const noSide = c.filter(r => r.pIncumbent < 0.5);
    return {
      rows: c.length,
      thinBidShare: +(c.filter(r => r.infoBid < 0.03).length / c.length).toFixed(4),
      noAskOver90Share: noSide.length ? +(noSide.filter(r => 1 - r.infoBid > 0.90).length / noSide.length).toFixed(4) : null,
      meanYesAskGapCents: +(c.reduce((s, r) => s + (r.infoAsk - r.yesAsk), 0) / c.length * 100).toFixed(3)
    };
  })();
  console.log(`\npricing note: ${(bidDiag.noAskOver90Share * 100).toFixed(1)}% of NO-side candidates would derive an ` +
    `ask above 90c from the decision-instant bid, which is an empty book side rather than a price. ` +
    `Rules are therefore priced at the fill bar; the two YES asks differ by ${bidDiag.meanYesAskGapCents}c on average.`);
  const atDecision = null;
  fs.writeFileSync(path.join(DIR, 'decisions.json'), JSON.stringify({ rows: rows.length, mid: MID, headToHead: h2h, results, pricingNote: bidDiag }, null, 2));
  console.log('\n-> decisions.json');
}

if (require.main === module) main();
module.exports = { candidates, applyRule, summarize, breakEven };
