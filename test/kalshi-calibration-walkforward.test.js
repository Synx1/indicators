'use strict';

/** Network-free regressions for the Kalshi calibration walk-forward. */
const assert = require('assert');
const {
  BUCKETS, DAY_MS, bucketOf, dayKey, observationFrom, calibrate,
  sideCostPp, bucketSignal, walkForward, economics, verdict
} = require('../research/kalshi-calibration-walkforward');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-6, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
};

// One decision quote per market, taken only from the requested minute.
{
  const row = {
    t: 'KXBTC15M-A', s: 'BTC', c: 5 * DAY_MS, r: 1,
    p: [[14, [0.5, 0.6, 0.55], [0.49, 0.59, 0.54], 100],
        [9, [0.8, 0.9, 0.86], [0.79, 0.88, 0.84], 200]]
  };
  const observation = observationFrom(row, 9);
  eq(observation.yesAsk, 0.86, 'the ask close of the requested minute is used');
  eq(observation.yesBid, 0.84);
  near(observation.mid, 0.85);
  near(observation.noAsk, 0.16, 1e-9, 'NO ask is one minus the YES bid');
  eq(BUCKETS[observation.bucket].label, '75-90c');
  eq(observationFrom(row, 7), null, 'a missing minute yields no observation');
  eq(observationFrom({ ...row, r: null }, 9), null, 'an unsettled market is unusable');
  eq(observationFrom({ ...row, p: [[9, [0.4, 0.5, 0.4], [0.45, 0.5, 0.45], 1]] }, 9), null,
    'a crossed historical quote is rejected');
}

// Buckets are half-open and cover the range.
{
  eq(BUCKETS[bucketOf(0.049)].label, '<5c');
  eq(BUCKETS[bucketOf(0.05)].label, '5-10c', 'an edge belongs to the upper bucket');
  eq(BUCKETS[bucketOf(0.9)].label, '90-95c');
  eq(BUCKETS[bucketOf(0.999)].label, '>=95c');
  eq(dayKey(3 * DAY_MS + 5), 3);
}

// Calibration reports realized-minus-priced bias with a binomial standard error.
{
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ bucket: bucketOf(0.8), mid: 0.8, yesAsk: 0.81, noAsk: 0.19, y: i < 90 ? 1 : 0 });
  }
  const bucket = calibrate(rows).find(b => b.label === '75-90c');
  eq(bucket.n, 100);
  near(bucket.realized, 0.9);
  near(bucket.biasPp, 10, 1e-6, 'a 90% realized rate priced at 80c is a 10pp bias');
  near(bucket.meanAsk, 0.81, 1e-9, 'the real quoted ask is retained for cost accounting');
  ok(bucket.biasSePp > 2.9 && bucket.biasSePp < 3.1, 'binomial SE of 90% over n=100 is about 3pp');
}

// Cost must include the half-spread actually paid, not only the fee.
{
  const { feePerContract } = require('../research/realtime-microstructure-evaluate');
  const feePp = price => feePerContract(price, 30) * 100;

  const atFair = sideCostPp(0.85, 0.85, 30, 0);
  const atAsk = sideCostPp(0.86, 0.85, 30, 0);
  ok(atFair.costPp > 0, 'even a fair-value fill still pays the fee');
  near(atFair.costPp, feePp(0.85), 1e-9, 'at fair value the only cost is the fee');
  near(atAsk.costPp, 1 + feePp(0.86), 1e-9, 'paying 1c above fair adds exactly 1pp plus its fee');

  // The fee shrinks as price approaches $1, so one extra cent of price nets slightly under 1pp.
  const spreadDelta = atAsk.costPp - atFair.costPp;
  ok(spreadDelta > 0.9 && spreadDelta < 1, 'a 1c half-spread costs just under 1pp net of fee relief');

  const slipped = sideCostPp(0.86, 0.85, 30, 1);
  near(slipped.costPp, 2 + feePp(0.87), 1e-9, 'a cent of slippage is charged on top of the spread');
  ok(slipped.costPp > atAsk.costPp, 'slippage strictly increases cost');
}

// The t-gate rejects a thin bucket whose surplus is indistinguishable from noise.
{
  const thin = { label: '40-60c', n: 400, meanMid: 0.5, meanAsk: 0.505, meanNoAsk: 0.505,
    realized: 0.53, biasPp: 3, biasSePp: 2.5 };
  ok(bucketSignal(thin, 30, 0, 300, 0.5, 0), 'without a t-requirement the lucky bucket passes');
  eq(bucketSignal(thin, 30, 0, 300, 0.5, 2), null, 'a 2-sigma requirement rejects it');

  const solid = { label: '75-90c', n: 4000, meanMid: 0.823, meanAsk: 0.83, meanNoAsk: 0.177,
    realized: 0.864, biasPp: 4.1, biasSePp: 0.54 };
  const signal = bucketSignal(solid, 30, 0, 300, 0.5, 2);
  eq(signal.side, 'YES', 'an underpriced favourite is bought, not sold');
  ok(signal.t >= 2);
  ok(signal.costPp > 0.7, 'the quoted-ask cost basis is charged, not the mid');
  eq(bucketSignal({ ...solid, n: 10 }, 30, 0, 300, 0.5, 2), null, 'a tiny training bucket is skipped');

  const overpriced = { label: '10-25c', n: 4000, meanMid: 0.175, meanAsk: 0.18, meanNoAsk: 0.825,
    realized: 0.147, biasPp: -2.8, biasSePp: 0.55 };
  eq(bucketSignal(overpriced, 30, 0, 300, 0.5, 0).side, 'NO',
    'an overpriced longshot is traded by buying the other side');
}

// The leakage guard that matters: a traded day is never part of its own training set.
{
  const make = (day, y, ask) => ({
    ticker: `T-${day}-${y}-${ask}`, sym: 'BTC', closeMs: day * DAY_MS, day, y,
    yesAsk: ask, yesBid: ask - 0.01, noAsk: +(1 - (ask - 0.01)).toFixed(6),
    mid: ask - 0.005, bucket: bucketOf(ask - 0.005), volume: 1
  });
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(make(1, 1, 0.81));   // day 1: always wins
  for (let i = 0; i < 50; i++) rows.push(make(2, 0, 0.81));    // day 2: always loses
  const result = walkForward(rows,
    { contracts: 30, slippageCents: 0, minTrain: 100, marginPp: 0.5, minT: 0 });
  eq(result.trades.length, 50, 'only day 2 is tradable');
  ok(result.trades.every(trade => trade.day === 2), 'day 1 is training only');
  ok(result.trades.every(trade => trade.won === false),
    'day-2 losses are recorded honestly instead of inheriting the day-1 bias');
  const economy = economics(result.trades);
  ok(economy.netPerContract < 0, 'a bad out-of-sample day must report negative P&L');
  eq(verdict(economy), 'negative');
}

// With no prior day there is nothing to learn from, so nothing trades.
{
  const single = [{ ticker: 'X', sym: 'BTC', closeMs: DAY_MS, day: 1, y: 1,
    yesAsk: 0.86, yesBid: 0.84, noAsk: 0.16, mid: 0.85, bucket: bucketOf(0.85), volume: 1 }];
  eq(walkForward(single, { minTrain: 1, minT: 0 }).trades.length, 0,
    'the first day can never be traded');
  eq(verdict(economics([])), 'no_trades');
}

// Economics charge the fee on the real fill and expose per-bucket detail.
{
  const trades = [
    { day: 1, bucket: '75-90c', side: 'YES', fill: 0.86, fee: 0.0028, won: true,
      pnlPerContract: 0.1372, costPerContract: 0.8628 },
    { day: 2, bucket: '75-90c', side: 'YES', fill: 0.86, fee: 0.0028, won: false,
      pnlPerContract: -0.8628, costPerContract: 0.8628 }
  ];
  const economy = economics(trades);
  eq(economy.trades, 2);
  eq(economy.wins, 1);
  near(economy.netPerContract, (0.1372 - 0.8628) / 2, 1e-9);
  eq(economy.byBucket.length, 1);
  ok(economy.ci.low != null && economy.ci.high != null, 'a day-clustered interval is produced');
}

console.log(`PASS Kalshi calibration walk-forward — ${checks} checks`);
