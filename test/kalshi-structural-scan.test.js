'use strict';

/** Network-free regressions for the direction-free Kalshi structural scan. */
const assert = require('assert');
const {
  ORDER_CONTRACTS, PERSIST_SNAPSHOTS, pairEdge, executablePairs,
  bucketIndex, takeCostCents, createStats, consider, summarize
} = require('../research/kalshi-structural-scan');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-9, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
};

const book = ({ yesBid, yesAsk, bidTouch = 100, askTouch = 100 }) => ({
  yesBid, yesAsk, spread: +(yesAsk - yesBid).toFixed(4), bidTouch, askTouch
});
const record = (over = {}) => ({
  kind: 'kalshi_book', ticker: 'KXBTC15M-T1', sym: 'BTC', recv: '2026-09-03T23:00:00.000Z',
  secondsLeft: 400, book: book({ yesBid: 0.6, yesAsk: 0.54 }), ...over
});

// A normal (uncrossed) book has no structural edge no matter how wide it is.
{
  const edge = pairEdge(0.4, 0.55);
  near(edge.noAsk, 0.6);
  near(edge.gross, -0.15, 1e-9, 'paying 0.55 + 0.60 for a $1 payout loses 15c');
  ok(edge.net < 0);
}

// A crossed book's gross edge is exactly the crossing, and both legs pay a taker fee.
{
  const edge = pairEdge(0.6, 0.54, ORDER_CONTRACTS);
  near(edge.gross, 0.06, 1e-9, 'gross edge equals bestYesBid - yesAsk');
  ok(edge.fees > 0, 'both legs are taker fills and must be charged');
  near(edge.net, edge.gross - edge.fees);
  ok(edge.net > 0, 'a 6c crossing clears both mid-price fees');
}

// Two taker legs near 50c cost about 3.5c per pair, so a small crossing is NOT an edge.
{
  const thin = pairEdge(0.5001, 0.5, ORDER_CONTRACTS);
  ok(thin.gross > 0, 'a 1bp crossing is gross-positive');
  ok(thin.net < 0, 'a 1bp crossing cannot survive two taker fees near 50c');

  const twoCent = pairEdge(0.6, 0.58, ORDER_CONTRACTS);
  near(twoCent.gross, 0.02, 1e-9);
  ok(twoCent.fees > 0.03, 'mid-price pair fees exceed 3c');
  ok(twoCent.net < 0, 'even a 2c crossing at mid prices is fee-negative');

  const extreme = pairEdge(0.92, 0.9, ORDER_CONTRACTS);
  ok(extreme.fees < twoCent.fees, 'fees shrink toward the price extremes');
  ok(extreme.net > 0, 'the same 2c crossing does clear fees near 90c');
}

// Size is bounded by the liquidity each leg actually consumes.
{
  eq(executablePairs({ bidTouch: 40, askTouch: 12 }), 12, 'buying NO is capped by resting YES bids');
  eq(executablePairs({ bidTouch: 7.9, askTouch: 100 }), 7, 'partial contracts are not tradable');
  eq(executablePairs({ bidTouch: null, askTouch: 5 }), 0);
}

// One flash crossing is counted but NOT confirmed; a persistent one is.
{
  const stats = createStats();
  const state = new Map();
  eq(consider(stats, state, record()), null, 'a single snapshot cannot confirm executability');
  eq(stats.crossed, 1);
  eq(stats.netPositive, 1);
  eq(stats.confirmedNetPositive, 0);

  const confirmed = consider(stats, state, record({ recv: '2026-09-03T23:00:02.000Z' }));
  ok(confirmed, 'a crossing surviving consecutive snapshots is confirmed');
  eq(confirmed.consecutiveSnapshots, PERSIST_SNAPSHOTS);
  eq(confirmed.contracts, ORDER_CONTRACTS);
  ok(confirmed.dollars > 0);
  eq(stats.confirmedNetPositive, 1);
  eq(summarize(stats).verdict, 'structural_edge_found');
}

// An uncrossed snapshot breaks the streak, so two separated flashes never fabricate persistence.
{
  const stats = createStats();
  const state = new Map();
  consider(stats, state, record());
  consider(stats, state, record({ book: book({ yesBid: 0.55, yesAsk: 0.58 }) }));
  consider(stats, state, record());
  eq(stats.netPositive, 2);
  eq(stats.confirmedNetPositive, 0, 'a normal book in between resets the streak');
  const report = summarize(stats);
  eq(report.verdict, 'no_structural_edge');
  eq(report.accountReady, false);
  eq(report.trading, false);
}

// Spread statistics are recorded for every two-sided book, including uncrossed ones.
{
  const stats = createStats();
  const state = new Map();
  consider(stats, state, record({ book: book({ yesBid: 0.5, yesAsk: 0.51 }) }));
  consider(stats, state, record({ book: book({ yesBid: 0.4, yesAsk: 0.47 }) }));
  consider(stats, state, record({ book: book({ yesBid: 0.3, yesAsk: 0.3 }) }));
  eq(stats.books, 3);
  eq(stats.quotedBothSides, 3);
  eq(stats.locked, 1, 'a zero-spread book is locked, not crossed');
  eq(stats.crossed, 0);
  eq(stats.spreadBuckets['<=1c'], 2, 'a locked book falls in the tightest bucket');
  eq(stats.spreadBuckets['<=10c'], 1);
  near(summarize(stats).meanSpreadCents, (1 + 7 + 0) / 3, 1e-4,
    'the reported mean spread is rounded to four decimals');
}

// Non-book records and missing quotes are ignored rather than counted.
{
  const stats = createStats();
  const state = new Map();
  eq(consider(stats, state, { kind: 'coinbase_frame' }), null);
  eq(consider(stats, state, record({ book: book({ yesBid: null, yesAsk: 0.5 }) })), null);
  eq(stats.books, 1, 'a book record with no usable quote still counts as observed');
  eq(stats.quotedBothSides, 0);
}

// The minimum-edge bar is half-spread plus fee, and it is price-dependent, not a constant.
{
  eq(bucketIndex(0.05), 0);
  eq(bucketIndex(0.5), 3, '50c lands in the 40-60c bucket');
  eq(bucketIndex(0.995), 6, 'the top bucket is closed at the high end');

  const atMid = takeCostCents(0.49, 0.51);
  near(atMid.halfSpreadCents, 1, 1e-9, 'a 2c spread costs 1c to cross');
  ok(atMid.feeCents > 1.7, 'the taker fee near 50c exceeds 1.7c per contract');
  ok(atMid.totalCents > atMid.halfSpreadCents,
    'fees dominate the crossing cost in these tight books');

  const atExtreme = takeCostCents(0.95, 0.97);
  near(atExtreme.halfSpreadCents, 1, 1e-9);
  ok(atExtreme.feeCents < atMid.feeCents / 3,
    'the same spread is far cheaper to pay near the extremes');
}

// Required-edge buckets are reported only where books were actually observed.
{
  const stats = createStats();
  const state = new Map();
  consider(stats, state, record({ book: book({ yesBid: 0.49, yesAsk: 0.51 }) }));
  consider(stats, state, record({ book: book({ yesBid: 0.95, yesAsk: 0.97 }) }));
  const report = summarize(stats);
  eq(report.requiredEdgeByPrice.length, 2, 'empty price buckets are omitted');
  const mid = report.requiredEdgeByPrice.find(b => b.price === '40-60c');
  const high = report.requiredEdgeByPrice.find(b => b.price === '>=90c');
  eq(mid.samples, 1);
  ok(mid.minimumEdgePp > high.minimumEdgePp,
    'a mid-priced contract needs a bigger real edge than a deep favourite');
  ok(mid.minimumEdgePp > 2.5, 'crossing at mid needs well over 2.5pp of true edge');
}

console.log(`PASS Kalshi structural scan — ${checks} checks`);
