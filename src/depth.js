'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DATA_DIR, KALSHI_API_BASE } = require('./config');

/**
 * Resting order-book depth, logged at the moment of decision, so the last untested hypothesis can be
 * graded with real outcomes.
 *
 * ── why this and nothing else ──
 *
 * Six things have now been measured against the price on a 68-day corpus and every one of them lost:
 * twelve extra indicators fitted linearly and with trees, those indicators layered on top of the ask,
 * aggressive trade flow from the tape, and book microstructure. See research/corpus2/REBUILD.md. Every
 * one of them is derived from a price series, which is why their redundancy reads as obvious in
 * hindsight — the ask is the market's own summary of the same series.
 *
 * DEPTH is not. How much size is resting, and how it is split between the two sides, is a statement
 * about intent that has not yet been executed. It is the standard microstructure predictor in every
 * other venue, and it is the one thing left with a mechanism worth stating out loud.
 *
 * ── why it has to be forward-only ──
 *
 * Kalshi publishes depth live and keeps no history of it. There is no backtest available at any price,
 * so the only way to find out is to start recording now and grade in a few weeks. That is the same
 * reason the NFRI lineup collector exists: some data cannot be bought later.
 *
 * ── what this deliberately does NOT do ──
 *
 * It changes no decision. Nothing in the trading path reads it, and `observe()` is fire-and-forget: the
 * caller never awaits the HTTP request, because a pass that runs long is a pass whose spot price has
 * gone stale, and that is the one failure this bot cannot afford. A depth read that fails, times out or
 * returns nonsense costs a row in a research file and nothing else.
 */

const FILE = path.join(DATA_DIR, 'depth.json');
/** Bounded like the shadow book: the aggregate is what gets read, not the individual rows. */
const MAX = 6000;
/** Levels requested per side. Eight covers roughly a dime of book on these markets. */
const LEVELS = 8;
/** How far from the touch counts as "near" depth, in cents. Beyond this, size is not really contestable. */
const NEAR_CENTS = 5;

let log = () => {};
let state = null;
let dirty = false;
let timer = null;
let inflight = 0;
/** More than this many concurrent depth reads and the rest are dropped — research must never queue. */
const MAX_INFLIGHT = 4;

const blank = () => ({ v: 1, entries: [], updatedAt: null });

function read() {
  try {
    if (!fs.existsSync(FILE)) return blank();
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.entries)) return blank();
    return { v: 1, entries: raw.entries, updatedAt: raw.updatedAt || null };
  } catch (e) {
    log(`  !! depth.json unreadable (${e.message}) — starting a fresh sample`);
    return blank();
  }
}

function flush() {
  if (!dirty || !state) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    state.updatedAt = new Date().toISOString();
    // Write-then-rename: a crash mid-write leaves the previous sample intact rather than a truncated one.
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! could not write ${FILE}: ${e.message}`);
    return false;
  }
}

function save() {
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, 5000);
    if (timer.unref) timer.unref();
  }
  return true;
}

function init(opts = {}) {
  log = opts.log || log;
  state = read();
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
    process.on(sig, () => { flush(); if (sig !== 'exit') process.exit(0); });
  }
  return state.entries.length;
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * Reduce a Kalshi orderbook to the features the hypothesis is actually about.
 *
 * The payload is `orderbook_fp` with `yes_dollars` and `no_dollars`, each an array of
 * [price, restingSize] — BIDS on each side. A NO bid at p is someone willing to sell YES at 1-p, which
 * is why the YES ask is 1 minus the best NO bid rather than anything in the yes array. Getting that
 * backwards would invert every imbalance sign, so it is spelled out here rather than assumed.
 */
function summarize(orderbook) {
  const ob = (orderbook && (orderbook.orderbook_fp || orderbook.orderbook)) || null;
  if (!ob) return null;
  const parse = rows => (Array.isArray(rows) ? rows : [])
    .map(l => ({ price: num(l && l[0]), size: num(l && l[1]) }))
    .filter(l => l.price != null && l.size != null && l.size > 0);
  const yes = parse(ob.yes_dollars || ob.yes);
  const no = parse(ob.no_dollars || ob.no);
  if (!yes.length || !no.length) return null;

  const bestYesBid = Math.max(...yes.map(l => l.price));
  const bestNoBid = Math.max(...no.map(l => l.price));
  const yesAsk = +(1 - bestNoBid).toFixed(4);
  const spread = +(yesAsk - bestYesBid).toFixed(4);
  // A crossed or absurd book is a bad read, not a signal. Drop it rather than record a fiction.
  if (!(spread >= 0 && spread < 0.5)) return null;

  const near = (rows, best) => rows.filter(l => l.price >= best - NEAR_CENTS / 100);
  const sum = rows => +rows.reduce((s, l) => s + l.size, 0).toFixed(2);
  const depthYes = sum(near(yes, bestYesBid));
  const depthNo = sum(near(no, bestNoBid));
  const touchYes = sum(yes.filter(l => l.price === bestYesBid));
  const touchNo = sum(no.filter(l => l.price === bestNoBid));
  const ratio = (a, b) => (a + b > 0 ? +((a - b) / (a + b)).toFixed(4) : null);

  return {
    yesAsk, yesBid: +bestYesBid.toFixed(4), spread,
    depthYes, depthNo, touchYes, touchNo,
    // The signal: positive means more size resting behind YES than behind NO.
    imbalance: ratio(depthYes, depthNo),
    touchImbalance: ratio(touchYes, touchNo),
    levels: Math.min(yes.length, no.length)
  };
}

/** Public endpoint: no key, no money, and a failure is silent by design. */
async function fetchBook(ticker) {
  const { data } = await axios.get(
    `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook?depth=${LEVELS}`,
    { timeout: 4000 }
  );
  return data;
}

/**
 * Record depth for one decision. FIRE AND FORGET — returns immediately and never rejects.
 *
 * The caller must not await this. It is called from inside a scan pass, and an awaited HTTP request
 * there ages the spot price of every coin behind it, which is the failure that cost 85% of a bankroll
 * once already. Concurrency is capped so a slow exchange cannot accumulate requests either.
 */
function observe(d) {
  if (!state || !d || !d.ticker) return false;
  if (inflight >= MAX_INFLIGHT) return false;
  // One row per market: a pass runs every POLL_MS and the same market stays qualifying for minutes, so
  // recording each look would weight the sample by how long a market sat there rather than by decisions.
  if (state.entries.some(e => e.ticker === d.ticker)) return false;

  inflight++;
  fetchBook(d.ticker)
    .then(book => {
      const s = summarize(book);
      if (!s) return;
      state.entries.push({
        ticker: String(d.ticker), sym: String(d.sym || '?'),
        side: d.side === 'YES' ? 'YES' : 'NO',
        // What the model believed, so depth can be scored against it rather than in isolation.
        confidence: num(d.confidence), confirm: num(d.confirm),
        pricePct: num(d.pricePct), minutesLeft: num(d.minutesLeft),
        taken: Boolean(d.taken),
        closeTime: d.closeTime || null,
        ...s,
        at: new Date().toISOString(),
        outcome: null, won: null, settledAt: null
      });
      if (state.entries.length > MAX) state.entries.splice(0, state.entries.length - MAX);
      save();
    })
    .catch(() => { /* a missing depth read costs a research row and nothing else */ })
    .then(() => { inflight--; });
  return true;
}

/**
 * Grade one row against the exchange's own result, using the SAME grader as the real book so a depth
 * win and a real win can never mean different things.
 */
function settle(ticker, result, gradeWin) {
  if (!state) return null;
  const row = state.entries.find(e => e.ticker === ticker && !e.outcome);
  if (!row) return null;
  const r = String(result || '').toLowerCase();
  if (r !== 'yes' && r !== 'no') return null;
  row.settledYes = r === 'yes';
  row.won = Boolean(gradeWin(row.side, r));
  row.outcome = row.won ? 'WIN' : 'LOSS';
  row.settledAt = new Date().toISOString();
  save();
  return row;
}

/** Rows still awaiting a result, oldest first. */
function pending(limit = 60) {
  if (!state) return [];
  return state.entries.filter(e => !e.outcome).slice(0, limit);
}

/** Below this a bucket is a run, not a measurement, and the report says so instead of printing a rate. */
const MIN_SAMPLE = 30;
const BANDS = [[-1.01, -0.4], [-0.4, -0.15], [-0.15, 0.15], [0.15, 0.4], [0.4, 1.01]];
const bandLabel = ([lo, hi]) =>
  `${lo <= -1 ? '≤' : ''}${lo <= -1 ? '-40%' : `${(lo * 100).toFixed(0)}%`}` +
  `${hi >= 1 ? ' and up' : ` to ${(hi * 100).toFixed(0)}%`}`;

/**
 * The test, stated as a question depth can fail: does resting imbalance predict the outcome BEYOND what
 * the price already says?
 *
 * So the rate reported per band is not the raw hit rate — that would mostly track the entry price, the
 * mistake that made a 68% headline look like a strategy. It is the margin over the break-even the price
 * itself demands. A band whose margin is positive on a real sample is the first thing in this project
 * that would have beaten the market.
 */
function report() {
  if (!state) return { ready: false, reason: 'not initialised' };
  const graded = state.entries.filter(e => e.outcome && e.imbalance != null && e.pricePct != null);
  const breakEven = pct => { const p = pct / 100; return p + 0.07 * p * (1 - p); };

  const bucket = list => {
    if (!list.length) return { taken: 0, wins: 0, rate: null, margin: null, avgPricePct: null };
    const wins = list.filter(e => e.won).length;
    const avg = list.reduce((s, e) => s + e.pricePct, 0) / list.length;
    const rate = wins / list.length;
    return {
      taken: list.length, wins, rate: +rate.toFixed(4),
      avgPricePct: +avg.toFixed(1),
      needRate: +breakEven(avg).toFixed(4),
      margin: +(rate - breakEven(avg)).toFixed(4),
      estimable: list.length >= MIN_SAMPLE
    };
  };

  // Signed so positive always means "depth agreed with the side we took": for a NO entry, more size
  // behind NO is agreement, which is a NEGATIVE raw imbalance. Getting this wrong would make an
  // agreeing book look like a disagreeing one on 78% of entries.
  const agreement = e => (e.side === 'YES' ? e.imbalance : -e.imbalance);

  return {
    ready: graded.length >= MIN_SAMPLE,
    logged: state.entries.length,
    graded: graded.length,
    awaiting: state.entries.length - graded.length,
    minSample: MIN_SAMPLE,
    overall: bucket(graded),
    byDepthAgreement: BANDS.map(b => ({
      band: bandLabel(b),
      ...bucket(graded.filter(e => { const a = agreement(e); return a >= b[0] && a < b[1]; }))
    })),
    byTouchAgreement: BANDS.map(b => ({
      band: bandLabel(b),
      ...bucket(graded.filter(e => {
        const a = e.side === 'YES' ? e.touchImbalance : -e.touchImbalance;
        return a != null && a >= b[0] && a < b[1];
      }))
    })),
    caution: 'Read `margin`, not `rate`: margin is the win rate minus what the entry price already ' +
      'demands, so a high rate with a negative margin is a losing bucket. A band under ' +
      `${MIN_SAMPLE} graded rows is marked estimable:false and means nothing yet. Depth is the only ` +
      'untested hypothesis left (see research/corpus2/REBUILD.md); everything derived from the price ' +
      'series has already been measured and lost.'
  };
}

/** For tests. */
function _reset(entries = []) { state = { v: 1, entries, updatedAt: null }; dirty = false; }

module.exports = {
  FILE, MAX_INFLIGHT, MIN_SAMPLE, NEAR_CENTS,
  init, observe, settle, pending, report, summarize, flush, _reset
};
