#!/usr/bin/env node
'use strict';

/**
 * Direction-free structural scan of already-collected public Kalshi order books.
 *
 * Why this exists: every DIRECTIONAL model tried so far (indicator consensus, residual-vs-market,
 * historical flow, the 85-90c favourite) failed to show robust fee-adjusted forward edge. This scan
 * asks a different question that needs no forecast at all: does the two-sided book ever price both
 * outcomes so cheaply that a guaranteed $1 settlement can be bought for less than $1 plus fees?
 *
 * Kalshi quotes bid ladders on BOTH outcomes. Buying YES consumes resting NO bids, so
 *   yesAsk = 1 - bestNoBid   and   noAsk = 1 - bestYesBid.
 * Holding one YES and one NO pays exactly $1 at settlement regardless of the outcome, so the
 * gross edge per pair is  1 - yesAsk - noAsk = bestYesBid - yesAsk  (i.e. a CROSSED book).
 * Both legs are taker fills, so both pay the production fee.
 *
 * Discipline:
 * - Fees come from the evaluator's production-identical fee function; no separate fee math.
 * - Executable size is capped by the touch quantity that would actually be consumed on each side.
 * - A crossing seen in a single 2s REST snapshot is reported but NOT counted as tradable: the scan
 *   requires the same ticker to stay crossed across consecutive snapshots, because one flash cannot
 *   be distinguished from a stale read at this polling latency.
 * - Read-only over local gzip corpora. No credentials, no orders, no account state.
 */

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');
const { feePerContract } = require('./realtime-microstructure-evaluate');

const ORDER_CONTRACTS = 30;
const PERSIST_SNAPSHOTS = 2;

/** Number(null) is 0 and Number('') is 0, so an absent quote must be rejected first. */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Net dollars per YES+NO pair after both taker fees. Positive means guaranteed profit. */
function pairEdge(yesBid, yesAsk, contracts = ORDER_CONTRACTS) {
  if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk)) return null;
  const noAsk = 1 - yesBid;
  const gross = 1 - yesAsk - noAsk;
  const fees = feePerContract(yesAsk, contracts) + feePerContract(noAsk, contracts);
  return { noAsk, gross, fees, net: gross - fees };
}

/** Contracts actually fillable: buying YES eats resting NO bids, buying NO eats resting YES bids. */
function executablePairs(book) {
  const yesSide = finiteOrNull(book && book.bidTouch);
  const noSide = finiteOrNull(book && book.askTouch);
  if (yesSide == null || noSide == null) return 0;
  return Math.max(0, Math.floor(Math.min(yesSide, noSide)));
}

/**
 * The real hurdle for a DIRECTIONAL trade is not the crossing that never happens: it is the cost of
 * taking the offer plus the taker fee. On a $1 binary, 1 cent of cost is exactly 1 percentage point
 * of probability edge, so the mean cost per bucket IS the minimum edge a model must beat to break
 * even. Fees are largest near 50c and shrink toward the extremes, so the bar is price-dependent.
 */
const PRICE_BUCKETS = Object.freeze([
  { label: '<10c', max: 0.10 }, { label: '10-25c', max: 0.25 },
  { label: '25-40c', max: 0.40 }, { label: '40-60c', max: 0.60 },
  { label: '60-75c', max: 0.75 }, { label: '75-90c', max: 0.90 },
  { label: '>=90c', max: Infinity }
]);

function bucketIndex(mid) {
  for (let i = 0; i < PRICE_BUCKETS.length; i++) if (mid < PRICE_BUCKETS[i].max) return i;
  return PRICE_BUCKETS.length - 1;
}

function createStats() {
  return {
    books: 0, quotedBothSides: 0, crossed: 0, locked: 0,
    grossPositive: 0, netPositive: 0, confirmedNetPositive: 0,
    spreadCentsSum: 0, spreadSamples: 0,
    spreadBuckets: { '<=1c': 0, '<=2c': 0, '<=3c': 0, '<=5c': 0, '<=10c': 0, '>10c': 0 },
    confirmedDollars: 0, opportunities: [],
    costBuckets: PRICE_BUCKETS.map(b => ({
      label: b.label, samples: 0, halfSpreadCents: 0, feeCents: 0
    }))
  };
}


/** Cost in cents of buying one contract at the offer instead of theoretical mid, fee included. */
function takeCostCents(yesBid, yesAsk, contracts = ORDER_CONTRACTS) {
  const mid = (yesBid + yesAsk) / 2;
  const halfSpreadCents = (yesAsk - mid) * 100;
  const feeCents = feePerContract(yesAsk, contracts) * 100;
  return { mid, halfSpreadCents, feeCents, totalCents: halfSpreadCents + feeCents };
}

function bucketSpread(stats, spreadCents) {
  const buckets = stats.spreadBuckets;
  if (spreadCents <= 1) buckets['<=1c']++;
  else if (spreadCents <= 2) buckets['<=2c']++;
  else if (spreadCents <= 3) buckets['<=3c']++;
  else if (spreadCents <= 5) buckets['<=5c']++;
  else if (spreadCents <= 10) buckets['<=10c']++;
  else buckets['>10c']++;
}

/**
 * Fold one kalshi_book record into the running scan. `state` holds only per-ticker last-crossing
 * bookkeeping, so memory stays flat regardless of corpus size.
 */
function consider(stats, state, row) {
  if (!row || row.kind !== 'kalshi_book' || !row.book) return null;
  const book = row.book;
  stats.books++;
  const yesBid = finiteOrNull(book.yesBid), yesAsk = finiteOrNull(book.yesAsk);
  if (yesBid == null || yesAsk == null) return null;
  stats.quotedBothSides++;

  const spreadCents = +((yesAsk - yesBid) * 100).toFixed(4);
  stats.spreadCentsSum += spreadCents;
  stats.spreadSamples++;
  bucketSpread(stats, spreadCents);

  if (spreadCents >= 0) {
    const cost = takeCostCents(yesBid, yesAsk);
    const bucket = stats.costBuckets[bucketIndex(cost.mid)];
    bucket.samples++;
    bucket.halfSpreadCents += cost.halfSpreadCents;
    bucket.feeCents += cost.feeCents;
  }

  if (spreadCents === 0) stats.locked++;
  if (spreadCents >= 0) { state.delete(row.ticker); return null; }

  stats.crossed++;
  const pairs = executablePairs(book);
  const contracts = Math.min(ORDER_CONTRACTS, pairs);
  const edge = pairEdge(yesBid, yesAsk, Math.max(1, contracts));
  if (edge.gross > 0) stats.grossPositive++;
  if (!(edge.net > 0) || contracts < 1) { state.delete(row.ticker); return null; }

  stats.netPositive++;
  const streak = (state.get(row.ticker) || 0) + 1;
  state.set(row.ticker, streak);
  if (streak < PERSIST_SNAPSHOTS) return null;

  stats.confirmedNetPositive++;
  const dollars = +(edge.net * contracts).toFixed(4);
  stats.confirmedDollars = +(stats.confirmedDollars + dollars).toFixed(4);
  const opportunity = {
    ticker: row.ticker, sym: row.sym, recv: row.recv,
    secondsLeft: row.secondsLeft == null ? null : +Number(row.secondsLeft).toFixed(1),
    yesBid, yesAsk, noAsk: +edge.noAsk.toFixed(4),
    grossPerPair: +edge.gross.toFixed(6), feesPerPair: +edge.fees.toFixed(6),
    netPerPair: +edge.net.toFixed(6), contracts, dollars, consecutiveSnapshots: streak
  };
  if (stats.opportunities.length < 25) stats.opportunities.push(opportunity);
  return opportunity;
}

/**
 * A gzip file that a collector is still writing has no trailer yet, so the decompressor ends with
 * "unexpected end of file". That is the expected shape of a LIVE corpus, not corruption: read every
 * complete record already flushed and mark the read partial rather than failing the whole scan.
 */
const isTruncatedGzip = error => {
  const text = String(error && (error.message || error));
  return /unexpected end of file/i.test(text) || error.code === 'Z_BUF_ERROR';
};

async function scanFile(file, stats, state) {
  const stream = fs.createReadStream(file);
  const source = file.endsWith('.gz') ? stream.pipe(zlib.createGunzip()) : stream;
  const lines = readline.createInterface({ input: source, crlfDelay: Infinity });
  let parseErrors = 0, records = 0, truncated = false;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch (_) { parseErrors++; continue; }
      records++;
      consider(stats, state, row);
    }
  } catch (error) {
    if (!isTruncatedGzip(error)) throw error;
    truncated = true;
  }
  return { file, records, parseErrors, truncated };
}

function summarize(stats) {
  const meanSpreadCents = stats.spreadSamples
    ? +(stats.spreadCentsSum / stats.spreadSamples).toFixed(4) : null;
  return {
    verdict: stats.confirmedNetPositive > 0 ? 'structural_edge_found' : 'no_structural_edge',
    books: stats.books,
    quotedBothSides: stats.quotedBothSides,
    meanSpreadCents,
    spreadBuckets: stats.spreadBuckets,
    lockedBooks: stats.locked,
    crossedBooks: stats.crossed,
    grossPositiveSnapshots: stats.grossPositive,
    netPositiveSnapshots: stats.netPositive,
    confirmedPersistentSnapshots: stats.confirmedNetPositive,
    confirmedDollars: stats.confirmedDollars,
    persistenceRequirement: PERSIST_SNAPSHOTS,
    orderContracts: ORDER_CONTRACTS,
    requiredEdgeByPrice: stats.costBuckets.filter(b => b.samples > 0).map(b => ({
      price: b.label, samples: b.samples,
      meanHalfSpreadCents: +(b.halfSpreadCents / b.samples).toFixed(3),
      meanFeeCents: +(b.feeCents / b.samples).toFixed(3),
      minimumEdgePp: +((b.halfSpreadCents + b.feeCents) / b.samples).toFixed(3)
    })),
    samples: stats.opportunities,
    accountReady: false,
    trading: false,
    limitation: 'Read-only public snapshots. A confirmed crossing still needs a live two-leg fill ' +
      'test before any account use; this scan cannot prove fill priority.'
  };
}

async function main(argv = process.argv.slice(2)) {
  const files = argv.filter(a => !a.startsWith('--'));
  if (!files.length) {
    process.stderr.write('usage: kalshi-structural-scan.js <corpus.jsonl[.gz]> [more...]\n');
    process.exitCode = 2;
    return null;
  }
  const stats = createStats();
  const state = new Map();
  const read = [];
  for (const file of files) read.push(await scanFile(path.resolve(file), stats, state));
  const report = { ...summarize(stats), inputs: read };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  ORDER_CONTRACTS, PERSIST_SNAPSHOTS, PRICE_BUCKETS, finiteOrNull, isTruncatedGzip,
  pairEdge, executablePairs, bucketIndex, takeCostCents,
  createStats, consider, scanFile, summarize, main
};
