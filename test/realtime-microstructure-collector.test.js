'use strict';

/**
 * Network-free regression checks for the observe-only microstructure collector.
 *
 * These signs are economically load-bearing: positive flow must always mean upward pressure, a NO bid
 * is a YES ask, snapshots must never masquerade as order flow, and selection must not leak a future
 * settlement window into the current one.
 */
const assert = require('assert');
const {
  PRODUCTS, RETAIN_BPS, L2Book, CoinbaseFeed, createFrameMetrics, addTradeToFrame,
  summarizeKalshiBook, kalshiSnapshotFlow, selectActiveMarkets
} = require('../research/realtime-microstructure-collector');

let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, epsilon = 1e-8, message = '') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${message || 'values differ'}: got ${actual}, expected ${expected}`);
};

// Only products with a real Coinbase public feed are subscribed; unsupported symbols stay explicit.
eq(PRODUCTS, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD']);

// Advanced Trade sequence numbers span every channel on one connection.
{
  const counters = { coinbaseSequenceGaps: 0, coinbaseFrames: 0 };
  const feed = new CoinbaseFeed({
    products: ['BTC-USD', 'ETH-USD'], writer: { write() {} }, counters, frameMs: 1000, now: 0
  });
  eq(feed.markSequence(8), 0, 'the first connection-global sequence establishes the baseline');
  eq(feed.markSequence(9), 0, 'the next message is contiguous even if its channel differs');
  eq(feed.markSequence(11), 1, 'only a missing connection-global number is a real gap');
  eq(counters.coinbaseSequenceGaps, 1);
  eq(feed.frames.get('BTC-USD').sequenceGaps, 1);
  eq(feed.frames.get('ETH-USD').sequenceGaps, 1);
}

// Coinbase L2: snapshot establishes state without fabricating OFI.
{
  const book = new L2Book('BTC-USD');
  const initial = book.apply([
    { side: 'bid', price_level: '100.00', new_quantity: '2' },
    { side: 'bid', price_level: '99.96', new_quantity: '4' },
    { side: 'offer', price_level: '100.10', new_quantity: '1' },
    { side: 'offer', price_level: '100.14', new_quantity: '3' }
  ], { snapshot: true });
  eq(initial.touch, 0, 'snapshot depth is state, not flow');
  eq(initial.bps10, 0, 'snapshot cannot generate multi-level OFI');
  eq(initial.updates, 4);

  const f = book.features();
  eq(f.ready, true);
  eq(f.bid, 100);
  eq(f.ask, 100.1);
  near(f.mid, 100.05);
  near(f.touchImbalance, 1 / 3);
  near(f.microprice, (100.1 * 2 + 100 * 1) / 3, 1e-8, 'microprice weights the opposite quote by touch size');
  eq(f.depth5Bps.bid, 6, '5bp depth includes the second bid level');
  eq(f.depth5Bps.ask, 4, '5bp depth includes the second ask level');

  const bidAdded = book.apply([
    { side: 'bid', price_level: '100.00', new_quantity: '3' }
  ]);
  eq(bidAdded.touch, 1, 'adding one unit at best bid is positive touch OFI');
  eq(bidAdded.bps5, 1, 'bid addition is positive at every containing band');

  const askAdded = book.apply([
    { side: 'offer', price_level: '100.10', new_quantity: '2' }
  ]);
  eq(askAdded.touch, -1, 'adding one unit at best ask is negative touch OFI');
  eq(askAdded.bps10, -1, 'ask addition is negative multi-level OFI');

  const askRemoved = book.apply([
    { side: 'offer', price_level: '100.10', new_quantity: '0' }
  ]);
  eq(askRemoved.touch, 2, 'removing the two-unit best ask is positive pressure');
  eq(book.features().ask, 100.14, 'zero quantity removes the price level');

  const replacement = book.apply([
    { side: 'bid', price_level: '90', new_quantity: '7' },
    { side: 'ask', price_level: '91', new_quantity: '8' },
    { side: 'bid', price_level: '1', new_quantity: '999999' },
    { side: 'ask', price_level: '1000', new_quantity: '999999' }
  ], { snapshot: true });
  eq(replacement.absolute, 0, 'a reconnect snapshot never looks like a giant flow event');
  eq(replacement.updates, 4, 'source update counts include ignored tail levels for gap diagnostics');
  eq(book.features().levels, { bid: 1, ask: 1, retainedBps: RETAIN_BPS },
    'snapshot replaces stale depth and excludes absurd far-tail quotes');
}

// Trade side is retained exactly as reported and is deliberately not called aggressor flow.
{
  const frame = createFrameMetrics();
  ok(addTradeToFrame(frame, { price: '100', size: '2', side: 'BUY' }));
  ok(addTradeToFrame(frame, { price: '101', size: '3', side: 'SELL' }));
  ok(addTradeToFrame(frame, { price: '102', size: '4', side: 'UNKNOWN' }));
  eq(frame.trades, 3);
  eq(frame.tradeBase, 9);
  eq(frame.tradeNotional, 911);
  eq(frame.reportedBuyBase, 2);
  eq(frame.reportedSellBase, 3);
  eq(frame.unknownSideBase, 4);
  eq(addTradeToFrame(frame, { price: '0', size: '4', side: 'BUY' }), false,
    'invalid prints cannot pollute a frame');
}

// Kalshi publishes bids on both outcomes: best NO bid 33c is the 67c YES ask.
{
  const prior = summarizeKalshiBook({ orderbook_fp: {
    yes_dollars: [['0.63', '5'], ['0.66', '2']],
    no_dollars: [['0.30', '7'], ['0.33', '4']]
  } });
  eq(prior.yesBid, 0.66);
  eq(prior.yesAsk, 0.67, 'YES ask is one minus the best NO bid');
  eq(prior.spread, 0.01);
  eq(prior.bidTouch, 2);
  eq(prior.askTouch, 4);
  near(prior.touchImbalance, -1 / 3);
  near(prior.microprice, (0.67 * 2 + 0.66 * 4) / 6, 1e-6);
  eq(prior.depth5c.yes, 7);
  eq(prior.depth5c.no, 11);

  const current = summarizeKalshiBook({ orderbook_fp: {
    yes_dollars: [['0.63', '5'], ['0.66', '3']],
    no_dollars: [['0.30', '7'], ['0.33', '6']]
  } });
  const flow = kalshiSnapshotFlow(prior, current);
  eq(flow.near5cSigned, -1, 'YES bid +1 and NO bid +2 nets to one unit of downward pressure');
  eq(flow.near5cAbsolute, 3);
  near(flow.near5cNormalized, -1 / 3);
  eq(kalshiSnapshotFlow(null, current), null, 'the first snapshot has no invented predecessor');

  eq(summarizeKalshiBook({}), null);
  eq(summarizeKalshiBook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }), null);
}

// Market discovery chooses the current settlement window, never the next half-hour contract.
{
  const now = Date.parse('2026-09-04T12:00:00Z');
  const spec = { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' };
  const selected = selectActiveMarkets([
    { ticker: 'PAST', close_time: '2026-09-04T11:58:00Z', status: 'open', floor_strike: '100' },
    { ticker: 'NEXT', close_time: '2026-09-04T12:30:00Z', status: 'open', floor_strike: '102' },
    { ticker: 'CURRENT', close_time: '2026-09-04T12:15:00Z', status: 'open', floor_strike: '101' }
  ], now, spec);
  eq(selected.length, 1);
  eq(selected[0].ticker, 'CURRENT');
  eq(selected[0].strike, 101);
  eq(selected[0].sym, 'BTC');
}

console.log(`PASS realtime microstructure collector — ${checks} checks`);
