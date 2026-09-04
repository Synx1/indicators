#!/usr/bin/env node
'use strict';

/**
 * ZERO-MONEY paper shadow for the frozen favourite-longshot calibration config.
 *
 * What this tests. The historical study found the market underprices heavy favourites, worth about
 * +1.4% fee-adjusted ROI when bought with a PASSIVE limit at the bid, with a day-clustered interval
 * of [-0.31pp, +2.62pp] that still includes zero. The binding uncertainty is execution: historical
 * minute bars can only prove the ask traded down to our price, never that our specific order would
 * have been filled. This shadow measures the same decision live, against real books.
 *
 * FROZEN CONFIG. The buckets and their direction were fitted on 25,159 markets across 68 settlement
 * days ending 2026-09-02 and are hard-coded below. They are NOT re-fitted from live data, so every
 * observation this process records is genuinely out of sample. Editing these numbers to chase live
 * results would destroy that property and make the output meaningless.
 *
 * Both entry styles are recorded on every signal so the central tradeoff is measured directly:
 *   PASSIVE - rest at the bid; fills only when a seller crosses down to us; suffers adverse selection.
 *   TAKER   - pay the ask immediately; always fills; pays the full half-spread.
 * The historical estimates were -2.6pp of win rate for passive versus about -1.35c of price for taker.
 *
 * Safety. Public Kalshi REST reads only. No credentials, no account state, no order endpoints, no
 * production config import, and no path by which this can place a real order. Nothing here can mark
 * any strategy ready; it only writes a ledger.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  SERIES, summarizeKalshiBook, selectActiveMarkets, atomicWrite, num, iso, arg
} = require('./realtime-microstructure-collector');
const { feePerContract } = require('./realtime-microstructure-evaluate');

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE_PRODUCT_BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const CONTRACTS = 30;
const SPOT_REFRESH_MS = 10000;

/**
 * Public Coinbase spot, used ONLY to display how far each coin sits from its Kalshi target price.
 * Kalshi settles on a CF Benchmarks index, not on Coinbase, so this is indicative context for a
 * human reading the page — it is deliberately NOT an input to any trading decision.
 */
const SPOT_PRODUCT = Object.freeze({
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
  DOGE: 'DOGE-USD', BNB: 'BNB-USD', HYPE: 'HYPE-USD'
});

const spotCache = new Map();
let spotFetchedMs = 0;

async function refreshSpot(now = Date.now()) {
  if (now - spotFetchedMs < SPOT_REFRESH_MS) return spotCache;
  spotFetchedMs = now;
  await Promise.all(Object.entries(SPOT_PRODUCT).map(async ([sym, product]) => {
    try {
      const response = await fetch(`${COINBASE_PRODUCT_BASE}/${product}`);
      if (!response.ok) return;
      const body = await response.json();
      const price = Number(body && body.price);
      if (Number.isFinite(price) && price > 0) spotCache.set(sym, { price, at: now });
    } catch (_) { /* display-only; a miss just shows a dash */ }
  }));
  return spotCache;
}

/**
 * Frozen from research/kalshi-calibration-walkforward.js over research/arb/paths.jsonl.
 * `costPp` and `t` are recorded for provenance; the live gate uses only lo/hi/side.
 */
const FROZEN_CONFIG = Object.freeze({
  fittedOn: { markets: 25159, settlementDays: 68, throughDay: '2026-09-02', decisionMinutesLeft: 9 },
  buckets: Object.freeze([
    // UP side: the market underprices heavy YES favourites. Both clear the 2-sigma surplus bar.
    Object.freeze({ label: '75-90c', lo: 0.75, hi: 0.90, side: 'YES',
      biasPp: 4.092, costPp: 1.83, surplusPp: 2.262, t: 4.30, marginal: false }),
    Object.freeze({ label: '90-95c', lo: 0.90, hi: 0.95, side: 'YES',
      biasPp: 3.564, costPp: 0.88, surplusPp: 2.684, t: 4.93, marginal: false }),
    // DOWN side: the mirror trade. When YES is 10-25c, NO is the 75-90c favourite and is likewise
    // underpriced (+2.81pp, t=5.1 against zero). It is included as MARGINAL because its surplus over
    // the cost of buying NO is only +0.97pp at t=1.77, below the 2-sigma bar the UP buckets clear.
    // It is tracked separately so it can be judged on its own and dropped without touching the UP
    // side. Its second purpose is diversification: UP signals arrive highly correlated across all
    // seven coins, and DOWN is what fires when crypto sells off instead.
    Object.freeze({ label: '10-25c-NO', lo: 0.10, hi: 0.25, side: 'NO',
      biasPp: -2.814, costPp: 1.84, surplusPp: 0.974, t: 1.77, marginal: true })
  ]),
  decisionSecondsLeft: 540,
  decisionToleranceSeconds: 45,
  cancelSecondsLeft: 420,
  /**
   * Maximum quoted spread, in cents, for a signal to be taken.
   *
   * The mispricing is actually LARGER in wide-spread contracts (+4.74pp above 2c versus +4.14pp at or
   * under 1c), but you pay more to capture it, so the converted return is worse. Gating at 1c was
   * validated out of sample on the expanding day walk-forward: ROI rose 2.47% -> 3.01% and the
   * day-clustered lower bound rose +0.96pp -> +1.22pp while retaining 64% of trades. A tighter 0.6c
   * gate FAILS (296 trades, interval straddles zero), so this is an optimum rather than a monotone
   * "tighter is better" fit. Derived from history only — never from this shadow's live results.
   */
  maxSpreadCents: 1.05,
  /**
   * Grace allowances, in cents, tested SIMULTANEOUSLY on every signal.
   *
   * A real taker order is a limit order: you decide at the quoted ask, your order arrives some
   * milliseconds later, and it fills only if the ask has not run past ask+grace. Otherwise the buy
   * FAILS — which is the honest outcome, not a fill at a worse price.
   *
   * This could not be settled on history: 99.98% of next-minute bars have a low at or below the
   * decision ask, so a bar-based fill test can never fail. Meanwhile these contracts move about 8.4c
   * per minute with a 14.2c intra-minute range, so the real fill behaviour is a sub-second question
   * that only live observation can answer. All three allowances share one observation, so measuring
   * them costs nothing extra and none of them is privileged in advance.
   */
  graceCents: Object.freeze([0, 1, 2])
});

const bucketFor = mid =>
  FROZEN_CONFIG.buckets.find(bucket => mid >= bucket.lo && mid < bucket.hi) || null;

const http = axios.create({
  baseURL: KALSHI_BASE, timeout: 7000,
  headers: { Accept: 'application/json', 'User-Agent': 'indicators-paper-shadow-observe-only' }
});

const sourceMs = value => {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** One virtual order per market per style. Never more than one signal per ticker. */
class Ledger {
  constructor() {
    this.orders = new Map();
    this.counters = {
      scans: 0, marketsSeen: 0, signals: 0, skippedOutOfBucket: 0, skippedLateOrEarly: 0,
      skippedWideSpread: 0, graceFilled: 0, graceFailed: 0,
      passiveFilled: 0, passiveExpired: 0, takerFilled: 0, settled: 0,
      intervalsObserved: 0, decisionWindowsHit: 0,
      bookErrors: 0, discoverErrors: 0, settleErrors: 0, authRefusals: 0
    };
    // Each 15-minute contract passes the decision point exactly once, so coverage is tracked per
    // interval close: how many intervals we saw at all, versus how many we actually evaluated.
    this.intervalsSeen = new Set();
    this.windowsHit = new Set();
    // Last observed state of every currently-open contract, so a viewer can see WHEN the next
    // decision window lands and whether that contract would qualify if it landed now.
    this.watchlist = new Map();
  }

  /** Record the live quote state of an open contract, whether or not it produced a signal. */
  watch(meta, book, secondsLeft) {
    const bucket = bucketFor(book.mid);
    // Each 15-minute contract sets its own target price at the interval open; the bet is whether the
    // coin finishes at or above it. Showing the live gap makes the position legible at a glance.
    const spot = spotCache.get(meta.sym);
    const strike = Number(meta.strike);
    const gap = spot && Number.isFinite(strike) ? spot.price - strike : null;
    this.watchlist.set(meta.ticker, {
      ticker: meta.ticker, sym: meta.sym, closeTime: meta.closeTime, strike: meta.strike,
      subtitle: meta.subtitle || null,
      spot: spot ? spot.price : null,
      gapAbsolute: gap == null ? null : +gap.toFixed(6),
      gapPct: gap == null || !strike ? null : +((gap / strike) * 100).toFixed(4),
      aboveTarget: gap == null ? null : gap >= 0,
      bid: book.yesBid, ask: book.yesAsk, mid: +book.mid.toFixed(4),
      spreadCents: +((book.yesAsk - book.yesBid) * 100).toFixed(2),
      secondsLeft: +secondsLeft.toFixed(1),
      secondsUntilDecision: +(secondsLeft - FROZEN_CONFIG.decisionSecondsLeft).toFixed(1),
      inActiveBucket: !!bucket,
      spreadTooWide: (book.yesAsk - book.yesBid) * 100 > FROZEN_CONFIG.maxSpreadCents,
      bucket: bucket ? bucket.label : null,
      wouldSignal: !!bucket &&
        (book.yesAsk - book.yesBid) * 100 <= FROZEN_CONFIG.maxSpreadCents,
      alreadySignalled: this.orders.has(meta.ticker),
      updatedAt: new Date().toISOString()
    });
  }

  /** Drop contracts that have closed so the viewer only shows what is still live. */
  pruneWatchlist(now = Date.now()) {
    for (const [ticker, row] of this.watchlist) {
      const closeMs = Date.parse(row.closeTime);
      if (Number.isFinite(closeMs) && now > closeMs + 60000) this.watchlist.delete(ticker);
    }
  }

  /** Record that an interval exists, and separately that we reached its decision window. */
  observeInterval(closeTime, inWindow) {
    if (!closeTime) return;
    if (!this.intervalsSeen.has(closeTime)) {
      this.intervalsSeen.add(closeTime);
      this.counters.intervalsObserved++;
    }
    if (inWindow && !this.windowsHit.has(closeTime)) {
      this.windowsHit.add(closeTime);
      this.counters.decisionWindowsHit++;
    }
  }

  has(ticker) { return this.orders.has(ticker); }

  open(meta, book, bucket, secondsLeft) {
    // Kalshi quotes the YES ladder; a NO position inverts it. Buying NO passively means resting at
    // the NO bid, which is 1 - yesAsk; taking NO means paying the NO ask, which is 1 - yesBid.
    const limit = bucket.side === 'YES' ? book.yesBid : +(1 - book.yesAsk).toFixed(4);
    const takerFill = bucket.side === 'YES' ? book.yesAsk : +(1 - book.yesBid).toFixed(4);
    this.orders.set(meta.ticker, {
      ticker: meta.ticker, sym: meta.sym, closeTime: meta.closeTime, strike: meta.strike,
      bucket: bucket.label, side: bucket.side, marginal: !!bucket.marginal,
      signalAt: new Date().toISOString(), signalSecondsLeft: +secondsLeft.toFixed(1),
      quotedBid: limit, quotedAsk: takerFill,
      spreadCents: +((takerFill - limit) * 100).toFixed(2),
      passive: { limit, filled: false, filledAt: null, filledSecondsLeft: null,
        fee: +feePerContract(limit, CONTRACTS).toFixed(6) },
      taker: { fill: takerFill, filled: true, filledAt: new Date().toISOString(),
        fee: +feePerContract(takerFill, CONTRACTS).toFixed(6) },
      // One limit order per grace allowance, all resolved on the first poll after the signal.
      grace: FROZEN_CONFIG.graceCents.map(cents => ({
        graceCents: cents, limit: +Math.min(0.99, takerFill + cents / 100).toFixed(4),
        resolved: false, filled: false, fill: null, fee: null,
        observedAsk: null, latencyMs: null, moveCents: null, pnl: null
      })),
      settled: false, result: null, won: null,
      passivePnl: null, takerPnl: null
    });
    this.counters.signals++;
    this.counters.takerFilled++;
  }

  /**
   * Resolve every unresolved grace order against the CURRENT ask, one poll after the signal.
   * This is the live-trading simulation: if the offer has moved beyond ask+grace the buy fails.
   */
  resolveGrace(ticker, book, nowMs) {
    const order = this.orders.get(ticker);
    if (!order || !Array.isArray(order.grace)) return;
    const sideAsk = order.side === 'YES' ? book.yesAsk : (book.yesBid == null ? null : 1 - book.yesBid);
    if (sideAsk == null) return;
    const latencyMs = nowMs - Date.parse(order.signalAt);
    if (!(latencyMs > 0)) return;
    for (const attempt of order.grace) {
      if (attempt.resolved) continue;
      attempt.resolved = true;
      attempt.observedAsk = +sideAsk.toFixed(4);
      attempt.latencyMs = latencyMs;
      attempt.moveCents = +((sideAsk - order.taker.fill) * 100).toFixed(2);
      if (sideAsk <= attempt.limit + 1e-9) {
        attempt.filled = true;
        // You never pay more than your limit, and never less than the prevailing offer.
        attempt.fill = +Math.max(Math.min(attempt.limit, sideAsk), 0.01).toFixed(4);
        attempt.fee = +feePerContract(attempt.fill, CONTRACTS).toFixed(6);
        this.counters.graceFilled++;
      } else {
        this.counters.graceFailed++;
      }
    }
  }

  /** A resting bid fills when the best ask trades down to it. */
  tryFill(ticker, book, secondsLeft) {
    const order = this.orders.get(ticker);
    if (!order || order.passive.filled || order.settled) return;
    if (secondsLeft < FROZEN_CONFIG.cancelSecondsLeft) {
      if (!order.passive.expired) {
        order.passive.expired = true;
        this.counters.passiveExpired++;
      }
      return;
    }
    // A resting buy fills when the offer on OUR side trades down to our limit.
    const sideAsk = order.side === 'YES' ? book.yesAsk : (book.yesBid == null ? null : 1 - book.yesBid);
    if (sideAsk != null && sideAsk <= order.passive.limit + 1e-9) {
      order.passive.filled = true;
      order.passive.filledAt = new Date().toISOString();
      order.passive.filledSecondsLeft = +secondsLeft.toFixed(1);
      order.passive.crossedAsk = +sideAsk.toFixed(4);
      this.counters.passiveFilled++;
    }
  }

  settle(ticker, result) {
    const order = this.orders.get(ticker);
    if (!order || order.settled) return;
    const won = order.side === 'YES' ? result === 'YES' : result === 'NO';
    order.settled = true;
    order.result = result;
    order.won = won;
    const payout = won ? 1 : 0;
    order.takerPnl = +(payout - order.taker.fill - order.taker.fee).toFixed(6);
    order.passivePnl = order.passive.filled
      ? +(payout - order.passive.limit - order.passive.fee).toFixed(6) : null;
    for (const attempt of (order.grace || [])) {
      attempt.pnl = attempt.filled ? +(payout - attempt.fill - attempt.fee).toFixed(6) : null;
    }
    this.counters.settled++;
  }

  summary() {
    const all = [...this.orders.values()];
    const settled = all.filter(order => order.settled);
    const roll = rows => {
      if (!rows.length) return { n: 0, wins: 0, winRate: null, net: null, roi: null, meanEntry: null };
      const wins = rows.filter(row => row.won).length;
      const net = rows.reduce((sum, row) => sum + row.net, 0);
      const cost = rows.reduce((sum, row) => sum + row.cost, 0);
      return {
        n: rows.length, wins, winRate: +(wins / rows.length).toFixed(4),
        meanEntry: +(rows.reduce((s, r) => s + r.entry, 0) / rows.length).toFixed(4),
        net: +net.toFixed(4), roi: cost > 0 ? +(net / cost).toFixed(6) : null
      };
    };
    const passiveRows = settled.filter(order => order.passive.filled).map(order => ({
      won: order.won, net: order.passivePnl,
      cost: order.passive.limit + order.passive.fee, entry: order.passive.limit
    }));
    const takerRows = settled.map(order => ({
      won: order.won, net: order.takerPnl,
      cost: order.taker.fill + order.taker.fee, entry: order.taker.fill
    }));
    const passive = roll(passiveRows), taker = roll(takerRows);
    const bySide = {};
    for (const side of ['YES', 'NO']) {
      const subset = settled.filter(order => order.side === side);
      bySide[side === 'YES' ? 'up' : 'down'] = {
        taker: roll(subset.map(order => ({ won: order.won, net: order.takerPnl,
          cost: order.taker.fill + order.taker.fee, entry: order.taker.fill }))),
        passive: roll(subset.filter(order => order.passive.filled).map(order => ({
          won: order.won, net: order.passivePnl,
          cost: order.passive.limit + order.passive.fee, entry: order.passive.limit })))
      };
    }
    // Pair each attempt with its own order so the win flag is never looked up by scanning.
    const byGrace = FROZEN_CONFIG.graceCents.map(cents => {
      const paired = settled
        .map(order => ({ order, attempt: (order.grace || []).find(a => a.graceCents === cents) }))
        .filter(entry => entry.attempt && entry.attempt.resolved);
      const filled = paired.filter(entry => entry.attempt.filled);
      const meanMove = paired.length
        ? +(paired.reduce((sum, e) => sum + (e.attempt.moveCents || 0), 0) / paired.length).toFixed(3)
        : null;
      return {
        graceCents: cents, attempts: paired.length, filled: filled.length,
        fillRate: paired.length ? +(filled.length / paired.length).toFixed(4) : null,
        meanMoveCents: meanMove,
        ...roll(filled.map(entry => ({
          won: entry.order.won, net: entry.attempt.pnl,
          cost: entry.attempt.fill + entry.attempt.fee, entry: entry.attempt.fill
        })))
      };
    });
    return {
      bySide, byGrace,
      openOrders: all.filter(order => !order.settled).length,
      settledSignals: settled.length,
      passive, taker,
      passiveFillRate: settled.length ? +(passiveRows.length / settled.length).toFixed(4) : null,
      adverseSelectionPp: passive.winRate != null && taker.winRate != null
        ? +((passive.winRate - taker.winRate) * 100).toFixed(3) : null,
      note: 'adverseSelectionPp compares the win rate of FILLED passive orders against every ' +
        'signalled market; a negative value means resting orders fill on weakening favourites'
    };
  }
}

async function discover(ledger, now) {
  const found = await Promise.all(SERIES.map(async spec => {
    try {
      const { data } = await http.get('/markets', {
        params: { series_ticker: spec.series, status: 'open', limit: 10 }
      });
      return selectActiveMarkets(data && data.markets, now, spec);
    } catch (error) {
      ledger.counters.discoverErrors++;
      return [];
    }
  }));
  return found.flat();
}

async function scan(ledger, writer) {
  const now = Date.now();
  ledger.counters.scans++;
  ledger.pruneWatchlist(now);
  await refreshSpot(now).catch(() => {});
  const markets = await discover(ledger, now);
  for (const meta of markets) {
    ledger.counters.marketsSeen++;
    const closeMs = sourceMs(meta.closeTime);
    if (closeMs == null) continue;
    let book;
    try {
      const { data } = await http.get(`/markets/${encodeURIComponent(meta.ticker)}/orderbook`,
        { params: { depth: 20 } });
      book = summarizeKalshiBook(data);
    } catch (error) {
      ledger.counters.bookErrors++;
      const status = error && error.response && error.response.status;
      if (status === 401 || status === 403) ledger.counters.authRefusals++;
      continue;
    }
    if (!book || book.yesBid == null || book.yesAsk == null) continue;
    const secondsLeft = (closeMs - Date.now()) / 1000;
    ledger.watch(meta, book, secondsLeft);

    if (ledger.has(meta.ticker)) {
      ledger.resolveGrace(meta.ticker, book, Date.now());
      ledger.tryFill(meta.ticker, book, secondsLeft);
      continue;
    }
    // Fire AT the decision point, not on first entry to a tolerance band. Accepting target+tolerance
    // meant every signal landed on the band's EARLY edge (observed mean 573s against a 540s nominal),
    // and at 8.4c of price movement per minute that 33s bias is ~4.5c of drift — comparable to the whole
    // edge. The floor still bounds how late a first sighting may be accepted.
    const target = FROZEN_CONFIG.decisionSecondsLeft;
    const tolerance = FROZEN_CONFIG.decisionToleranceSeconds;
    const inWindow = secondsLeft <= target && secondsLeft >= target - tolerance;
    ledger.observeInterval(`${meta.ticker}@${meta.closeTime}`, inWindow);
    if (!inWindow) {
      ledger.counters.skippedLateOrEarly++;
      continue;
    }
    const bucket = bucketFor(book.mid);
    if (!bucket) { ledger.counters.skippedOutOfBucket++; continue; }
    const spreadCents = (book.yesAsk - book.yesBid) * 100;
    if (spreadCents > FROZEN_CONFIG.maxSpreadCents) {
      ledger.counters.skippedWideSpread++;
      continue;
    }
    ledger.open(meta, book, bucket, secondsLeft);
    writer({ kind: 'signal', ticker: meta.ticker, sym: meta.sym, bucket: bucket.label,
      mid: book.mid, bid: book.yesBid, ask: book.yesAsk, secondsLeft: +secondsLeft.toFixed(1),
      at: new Date().toISOString() });
  }
}

async function settleDue(ledger, writer) {
  const due = [...ledger.orders.values()].filter(order => {
    if (order.settled) return false;
    const closeMs = sourceMs(order.closeTime);
    return closeMs != null && Date.now() >= closeMs + 25000;
  });
  for (const order of due) {
    try {
      const { data } = await http.get(`/markets/${encodeURIComponent(order.ticker)}`);
      const market = data && data.market;
      const raw = String(market && (market.result || market.settlement_value) || '').toLowerCase();
      let result = null;
      if (raw === 'yes' || raw === '1' || raw === '1.0000') result = 'YES';
      if (raw === 'no' || raw === '0' || raw === '0.0000') result = 'NO';
      if (!result) continue;
      ledger.settle(order.ticker, result);
      writer({ kind: 'settlement', ticker: order.ticker, result,
        passiveFilled: order.passive.filled, passivePnl: order.passivePnl,
        takerPnl: order.takerPnl, at: new Date().toISOString() });
    } catch (error) {
      ledger.counters.settleErrors++;
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const startedMs = Date.now();
  const stamp = new Date(startedMs).toISOString().replace(/[-:.]/g, '');
  // Default to a full day: each contract offers exactly one decision window, so a useful sample
  // only accumulates by spanning many 15-minute interval boundaries.
  const hours = num(arg(argv, '--hours', 0)) || 0;
  const minutes = hours > 0
    ? hours * 60
    : Math.max(1, num(arg(argv, '--minutes', 1440)) || 1440);
  const pollMs = Math.max(2000, num(arg(argv, '--poll-ms', 5000)) || 5000);
  const out = arg(argv, '--out', `/tmp/indicators-calibration-paper-${stamp}.jsonl`);
  const progressOut = arg(argv, '--progress-out', `${out}.live.json`);
  const stopAt = startedMs + minutes * 60000;

  const ledger = new Ledger();
  const events = [];
  const writer = row => { events.push(row); };
  let stopping = false;

  const snapshot = state => ({
    state, pid: process.pid,
    startedAt: iso(startedMs), updatedAt: new Date().toISOString(), stopAt: iso(stopAt),
    observedMinutes: +((Date.now() - startedMs) / 60000).toFixed(2),
    safety: { publicDataOnly: true, credentialsLoaded: false, orderEndpoints: false,
      trading: false, realMoney: false },
    frozenConfig: FROZEN_CONFIG,
    counters: ledger.counters,
    summary: ledger.summary(),
    watchlist: [...ledger.watchlist.values()].sort((a, b) => a.secondsLeft - b.secondsLeft),
    orders: [...ledger.orders.values()]
  });
  const checkpoint = state => { try { atomicWrite(progressOut, snapshot(state)); } catch (_) { /* keep polling */ } };

  const finish = async (state = 'complete') => {
    if (stopping) return;
    stopping = true;
    clearInterval(scanTimer);
    clearInterval(checkTimer);
    await settleDue(ledger, writer).catch(() => {});
    const final = snapshot(state);
    final.events = events;
    fs.writeFileSync(out, `${JSON.stringify(final, null, 2)}\n`);
    checkpoint(state);
    process.stdout.write(`${JSON.stringify({ state, out: path.resolve(out),
      progressOut: path.resolve(progressOut), summary: final.summary }, null, 2)}\n`);
  };

  const tick = async () => {
    if (stopping) return;
    await scan(ledger, writer).catch(() => {});
    await settleDue(ledger, writer).catch(() => {});
    checkpoint('running');
    if (Date.now() >= stopAt) await finish('complete');
  };

  checkpoint('starting');
  const scanTimer = setInterval(() => { tick().catch(() => {}); }, pollMs);
  const checkTimer = setInterval(() => checkpoint('running'), 15000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { finish('stopped').catch(() => {}); });
  await tick();
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  FROZEN_CONFIG, CONTRACTS, SPOT_PRODUCT, bucketFor, refreshSpot, spotCache,
  Ledger, scan, settleDue, main
};
