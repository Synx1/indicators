'use strict';

/** Network-free regression checks for the observe-only Binance challenger collector. */
const assert = require('assert');
const {
  SYMBOLS, parseLevels, summarizePartialDepth, partialSnapshotFlow,
  createMetrics, addTrade, BinanceFeed, makeCounters
} = require('../research/realtime-binance-microstructure-collector');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-8, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected}`);
};

const depth = ({ symbol = 'BTCUSDT', U = 1, u = 2, pu = 0, bids, asks } = {}) => ({
  e: 'depthUpdate', E: 100, T: 99, s: symbol, U, u, pu,
  b: bids || [['100', '2'], ['99.99', '1'], ['99', '8']],
  a: asks || [['100.01', '1'], ['100.02', '3'], ['101', '8']]
});

// Every Kalshi crypto has an observed direct perpetual stream; no symbol is silently proxied.
eq(SYMBOLS, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'HYPEUSDT']);

// Complete partial-depth snapshots are sorted and summarized without a REST seed.
{
  const bids = parseLevels([['99', '1'], ['100', '2']], 'bid');
  const asks = parseLevels([['102', '1'], ['101', '3']], 'ask');
  eq(bids.map(row => row.price), [100, 99]);
  eq(asks.map(row => row.price), [101, 102]);

  const book = summarizePartialDepth(depth());
  eq(book.bid, 100);
  eq(book.ask, 100.01);
  near(book.mid, 100.005);
  near(book.touchImbalance, 1 / 3);
  near(book.microprice, (100.01 * 2 + 100 * 1) / 3, 1e-8,
    'microprice weights the opposite quote by touch depth');
  eq(book.depthTop20.bid, 11);
  eq(book.depthTop20.ask, 12);
  eq(book.levels.semantics, 'complete top-20 snapshot');
  eq(summarizePartialDepth(depth({ bids: [['101', '1']], asks: [['100', '1']] })), null,
    'crossed partial books are rejected');
}

// Snapshot flow signs are consistent while remaining explicitly weaker than event-complete OFI.
{
  const prior = summarizePartialDepth(depth({
    bids: [['100', '2'], ['99', '1']], asks: [['101', '2'], ['102', '1']]
  }));
  const upward = summarizePartialDepth(depth({
    bids: [['100', '3'], ['99', '1']], asks: [['101', '1'], ['102', '1']]
  }));
  const flow = partialSnapshotFlow(prior, upward);
  eq(flow.top20, 2, 'one bid added plus one ask removed is positive two units');
  eq(flow.touch, 2);
  eq(flow.absolute, 2);
  eq(flow.normalized, 1);

  const askAdded = summarizePartialDepth(depth({
    bids: [['100', '3'], ['99', '1']], asks: [['101', '4'], ['102', '1']]
  }));
  eq(partialSnapshotFlow(upward, askAdded).top20, -3,
    'adding three units at the ask is negative pressure');
  eq(partialSnapshotFlow(null, upward), null, 'the initial full snapshot never fabricates flow');
}

// Binance's maker flag gives an explicit aggressor-side interpretation.
{
  const metrics = createMetrics();
  ok(addTrade(metrics, { p: '100', q: '2', m: false }));
  ok(addTrade(metrics, { p: '101', q: '3', m: true }));
  eq(metrics.trades, 2);
  eq(metrics.tradeBase, 5);
  eq(metrics.tradeNotional, 503);
  eq(metrics.aggressorBuyBase, 2);
  eq(metrics.aggressorSellBase, 3);
  eq(addTrade(metrics, { p: '0', q: '3', m: false }), false);
}

// `pu` continuity is tracked per symbol; one gap marks only that symbol's receive-time frame.
{
  const records = [];
  const counters = makeCounters();
  const feed = new BinanceFeed({
    symbols: ['BTCUSDT', 'ETHUSDT'], writer: { write: row => records.push(row) },
    counters, frameMs: 1000, now: 0
  });
  ok(feed.onMessage(JSON.stringify({ stream: 'btcusdt@depth20@100ms', data: depth({ u: 10, pu: 7 }) }), 100));
  ok(feed.onMessage(JSON.stringify({ stream: 'ethusdt@depth20@100ms', data:
    depth({ symbol: 'ETHUSDT', u: 20, pu: 4 }) }), 150));
  ok(feed.onMessage(JSON.stringify({ stream: 'btcusdt@depth20@100ms', data: depth({ U: 11, u: 12, pu: 10,
    bids: [['100', '3']], asks: [['100.01', '1']] }) }), 200));
  ok(feed.onMessage(JSON.stringify({ stream: 'btcusdt@depth20@100ms', data: depth({ U: 14, u: 15, pu: 9,
    bids: [['100', '4']], asks: [['100.01', '1']] }) }), 300));
  ok(feed.onMessage(JSON.stringify({ stream: 'btcusdt@trade', data: {
    e: 'trade', E: 301, T: 300, s: 'BTCUSDT', p: '100.01', q: '0.5', m: false
  } }), 400));
  eq(counters.trades, 1);
  eq(counters.sequenceDiscontinuities, 1);
  eq(feed.frames.get('BTCUSDT').sequenceDiscontinuities, 1);
  eq(feed.frames.get('ETHUSDT').sequenceDiscontinuities, 0);
  feed.roll(1000);
  eq(records.length, 2);
  const btc = records.find(row => row.symbol === 'BTCUSDT');
  eq(btc.kind, 'binance_frame');
  eq(btc.bucketEndMs, 1000);
  eq(btc.book.ready, true);
  eq(btc.depthSnapshots, 3);
  eq(btc.sequenceDiscontinuities, 1);
  eq(btc.trade.count, 1);
  near(btc.trade.aggressorBuyBase, 0.5);
  eq(btc.snapshotFlow.semantics, 'change between complete top-20 snapshots; not event-complete OFI');

  feed.resetConnectionState();
  eq(feed.books.get('BTCUSDT'), null, 'a reconnect waits for a fresh self-contained snapshot');
  eq(feed.lastUpdate.get('BTCUSDT'), null, 'a reconnect cannot compare a new sequence to the old connection');
  const allSymbols = new BinanceFeed({ writer: { write() {} }, counters: makeCounters(), now: 0 });
  ok(allSymbols.streamUrl().includes('hypeusdt@depth20@100ms'));
  ok(allSymbols.streamUrl().includes('hypeusdt@trade'));
}

// Malformed and unsupported messages cannot pollute counters or frames.
{
  const counters = makeCounters();
  const feed = new BinanceFeed({ symbols: ['BTCUSDT'], writer: { write() {} }, counters, now: 0 });
  eq(feed.onMessage('{', 10), false);
  eq(counters.parseErrors, 1);
  eq(feed.onMessage(JSON.stringify({ data: depth({ symbol: 'UNKNOWN' }) }), 20), false);
  eq(counters.messages, 0);
}

console.log(`PASS realtime Binance microstructure collector — ${checks} checks`);
