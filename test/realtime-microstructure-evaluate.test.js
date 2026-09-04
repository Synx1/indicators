'use strict';

/** Network-free regression coverage for the offline microstructure residual evaluator. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  DAY_MS, FEATURE_NAMES, feeDollars, feePerContract,
  ExampleExtractor, extractFiles, fitOffsetLogistic, fitMarketCalibration, walkForward, probabilityMetrics,
  selectTrades, economicMetrics, activationVerdict, parseArgs
} = require('../research/realtime-microstructure-evaluate');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-8, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected}`);
};

function frame(endMs, mid, sequenceGaps = 0) {
  return {
    kind: 'coinbase_frame', product: 'BTC-USD', bucketEndMs: endMs, sequenceGaps,
    flow: { bps5Normalized: Math.sin(endMs / 17000) / 20 },
    trade: { reportedBuyBase: endMs % 3000 ? 2 : 1, reportedSellBase: 1 },
    book: {
      ready: true, mid, spreadBps: 1, touchImbalance: 0.1,
      micropriceOffsetBps: 0.05,
      depth5Bps: { imbalance: 0.2 }, depth10Bps: { imbalance: 0.15 }
    }
  };
}

function kalshiBook(overrides = {}) {
  return {
    kind: 'kalshi_book', ticker: 'KXBTC15M-TEST', series: 'KXBTC15M', sym: 'BTC',
    openTime: '1970-01-01T00:00:00.000Z', closeTime: '1970-01-01T00:15:00.000Z',
    recvMs: 360000, secondsLeft: 540, latencyMs: 100,
    snapshotFlow: { near5cNormalized: 0.25 },
    book: {
      yesBid: 0.54, yesAsk: 0.56, mid: 0.55, spread: 0.02,
      touchImbalance: 0.1, micropriceOffset: 0.002,
      depth5c: { imbalance: 0.2 }
    },
    ...overrides
  };
}

function feedFrames(extractor, gapAt = null) {
  for (let second = 1; second <= 360; second++) {
    const mid = 100 + second * 0.001 + Math.sin(second / 9) * 0.01;
    extractor.consume(frame(second * 1000, mid, second === gapAt ? 1 : 0));
  }
}

// Exact production fee rounding is economically load-bearing.
eq(feeDollars(0.5, 30), 0.53, '52.5 cents rounds upward to 53 cents');
eq(feeDollars(0.87, 30), 0.24, '23.751 cents rounds upward to 24 cents');
near(feePerContract(0.87, 30), 0.008, 1e-12, 'fee is amortized over the modeled batch');

// The extractor chooses exactly the first T-9m crossing and cannot see later receive-time frames.
{
  const extractor = new ExampleExtractor();
  feedFrames(extractor);
  extractor.consume(kalshiBook({ recvMs: 300000, secondsLeft: 600,
    snapshotFlow: { near5cNormalized: -0.1 },
    book: { yesBid: 0.49, yesAsk: 0.51, mid: 0.5, spread: 0.02, touchImbalance: -0.2,
      micropriceOffset: -0.001, depth5c: { imbalance: -0.1 } } }));
  extractor.consume(kalshiBook({ recvMs: 335000, secondsLeft: 565,
    snapshotFlow: { near5cNormalized: 0.1 },
    book: { yesBid: 0.51, yesAsk: 0.53, mid: 0.52, spread: 0.02, touchImbalance: 0,
      micropriceOffset: 0, depth5c: { imbalance: 0 } } }));
  extractor.consume(kalshiBook());
  extractor.consume(frame(361000, 1000)); // physically received after the decision; must not alter it
  extractor.consume(kalshiBook({ recvMs: 362000, secondsLeft: 538,
    book: { yesBid: 0.8, yesAsk: 0.82, mid: 0.81, spread: 0.02 } }));
  extractor.consume({ kind: 'kalshi_settlement', ticker: 'KXBTC15M-TEST', result: 'YES' });
  const { examples, counts } = extractor.finish();
  eq(examples.length, 1, 'one contract produces one canonical example');
  eq(examples[0].y, 1);
  eq(examples[0].marketMid, 0.55, 'a later and more favorable snapshot cannot replace the canonical quote');
  const expectedLatest = 100 + 360 * 0.001 + Math.sin(360 / 9) * 0.01;
  const expectedOpen = 100 + 0.001 + Math.sin(1 / 9) * 0.01;
  near(examples[0].X[0], Math.log(expectedLatest / expectedOpen) * 10000, 1e-8,
    'spot move uses only frames whose receive bucket ended by decision time');
  eq(examples[0].X.length, FEATURE_NAMES.length);
  near(examples[0].X[FEATURE_NAMES.indexOf('kalshiMidMove30s')], 0.03, 1e-12,
    '30-second Kalshi path uses only prior and current receive-time snapshots');
  near(examples[0].X[FEATURE_NAMES.indexOf('kalshiMidMove120s')], 0.05, 1e-12,
    '120-second Kalshi path retains the older probability state');
  near(examples[0].X[FEATURE_NAMES.indexOf('kalshiFlow30s')], 0.35, 1e-12,
    'snapshot-flow path aggregates the prior and current public REST deltas');
  eq(counts.candidateBooks, 1, 'later polls are not counted as independent candidates');
}

// Missing target timing, unsupported direct underlyings, and sequence gaps all fail closed.
{
  const extractor = new ExampleExtractor();
  feedFrames(extractor);
  extractor.consume(kalshiBook({ ticker: 'LATE', secondsLeft: 530 }));
  extractor.consume(kalshiBook({ ticker: 'BNB', sym: 'BNB' }));
  const result = extractor.finish();
  eq(result.examples.length, 0);
  eq(result.counts.missedTarget, 1);
  eq(result.counts.unsupportedUnderlying, 1);
}
{
  const extractor = new ExampleExtractor();
  feedFrames(extractor, 200);
  extractor.consume(kalshiBook({ ticker: 'GAPPED' }));
  extractor.consume({ kind: 'kalshi_settlement', ticker: 'GAPPED', result: 'NO' });
  const result = extractor.finish();
  eq(result.examples.length, 0, 'a connection-global sequence gap rejects the feature row');
  eq(result.counts.featureUnavailable, 1);
}

// The fixed-offset logistic model learns only a residual around the contemporaneous market price.
{
  const rows = [];
  for (let i = 0; i < 240; i++) {
    const signal = i % 2 ? 1 : -1;
    const X = Array(FEATURE_NAMES.length).fill(0); X[0] = signal;
    rows.push({ X, marketMid: 0.5, y: signal > 0 ? 1 : 0 });
  }
  const model = fitOffsetLogistic(rows, { l2: 2 });
  const positive = { X: Array(FEATURE_NAMES.length).fill(0), marketMid: 0.5 };
  const negative = { X: Array(FEATURE_NAMES.length).fill(0), marketMid: 0.5 };
  positive.X[0] = 1; negative.X[0] = -1;
  ok(model.predict(positive) > 0.9, 'positive residual signal raises the market baseline');
  ok(model.predict(negative) < 0.1, 'negative residual signal lowers the market baseline');

  const calibrationRows = rows.map((row, i) => ({ ...row, marketMid: 0.8, y: i % 2 }));
  const calibration = fitMarketCalibration(calibrationRows, { l2: 2 });
  near(calibration.predict(calibrationRows[0]), 0.5, 0.02,
    'market-only benchmark can correct a systematically overconfident midpoint');
}

// Expanding folds only train on strictly earlier UTC days and beat the inert midpoint on clear data.
let syntheticWalk;
{
  const rows = [];
  for (let day = 0; day < 6; day++) {
    for (let i = 0; i < 40; i++) {
      const signal = i % 2 ? 1 : -1;
      const X = Array(FEATURE_NAMES.length).fill(0); X[0] = signal;
      rows.push({
        day, X, marketMid: 0.5, y: signal > 0 ? 1 : 0,
        ticker: `D${day}-${i}`, sym: 'BTC', closeTime: `${day}-${i}`,
        yesAsk: 0.51, noAsk: 0.51, recvMs: day * DAY_MS + i
      });
    }
  }
  syntheticWalk = walkForward(rows, { minTrainDays: 3 });
  eq(syntheticWalk.folds.length, 3);
  eq(syntheticWalk.folds[0].train, 120);
  eq(syntheticWalk.folds[0].test, 40);
  eq(syntheticWalk.predictions.length, 120);
  ok(syntheticWalk.predictions.every(row => row.testDay === row.day),
    'each prediction belongs to its held-out settlement day');
  ok(syntheticWalk.predictions.every(row => Number.isFinite(row.pCalibrated)),
    'every fold produces a separately trained market-only calibration probability');
  const metrics = probabilityMetrics(syntheticWalk.predictions);
  ok(metrics.incrementalOverCalibrated.brier > 0,
    'full residual model improves Brier score over the calibrated market-only baseline');
  ok(metrics.incrementalOverCalibrated.logLoss > 0,
    'full residual model improves log loss over the calibrated market-only baseline');
}

// Execution pays the side ask, four cents of slippage, and fees; it never forces a trade.
{
  const sameWindow = '2026-01-01T00:15:00Z';
  const predictions = [
    { ticker: 'A', sym: 'BTC', closeTime: sameWindow, day: 1, pModel: 0.95,
      pMarket: 0.5, yesAsk: 0.5, noAsk: 0.52, y: 1 },
    { ticker: 'B', sym: 'ETH', closeTime: sameWindow, day: 1, pModel: 0.8,
      pMarket: 0.5, yesAsk: 0.55, noAsk: 0.47, y: 1 }
  ];
  const trades = selectTrades(predictions, { edgeBps: 300, slippageCents: 4, contracts: 30 });
  eq(trades.length, 1, 'only the best candidate in a settlement window can be selected');
  eq(trades[0].ticker, 'A');
  near(trades[0].entry, 0.54, 1e-12, 'slippage is charged on top of the observed ask');
  ok(trades[0].fee > 0, 'entry fee is charged');

  const abstain = selectTrades([{ ticker: 'C', sym: 'BTC', closeTime: 'later', day: 1,
    pModel: 0.5, pMarket: 0.5, yesAsk: 0.51, noAsk: 0.51, y: 1 }],
  { edgeBps: 300, slippageCents: 4, contracts: 30 });
  eq(abstain.length, 0, 'no edge means no trade');
}

// Even attractive retrospective metrics can only nominate a separate forward shadow.
{
  const metrics = { incrementalOverCalibrated: { brier: 0.01, logLoss: 0.01 } };
  const economics = { trades: 50, dayClustered95: { low: 0.01, high: 0.03 } };
  const verdict = activationVerdict(metrics, economics, 7);
  eq(verdict.accountReady, false);
  eq(verdict.status, 'eligible_for_independent_forward_shadow');
  ok(verdict.reasons.some(reason => reason.includes('independent forward confirmation')),
    'same-corpus performance is never called account-ready');

  const weak = activationVerdict({ incrementalOverCalibrated: { brier: -0.01, logLoss: -0.01 } },
    { trades: 4, dayClustered95: { low: -0.2, high: 0.3 } }, 2);
  eq(weak.status, 'observe_only_rejected');
  ok(weak.reasons.length >= 5, 'all material evidence failures are disclosed');
}

// Economic summaries preserve abstention and deterministic day-clustered uncertainty.
{
  const empty = economicMetrics([], 4);
  eq(empty.trades, 0);
  eq(empty.roi, null);
  eq(empty.dayClustered95, { low: null, high: null });
}

// CLI parsing keeps all execution assumptions explicit and supports repeated input files.
{
  const args = parseArgs(['--input', 'a.gz', '--input', 'b.gz', '--edge-bps', '250',
    '--slippage-cents', '3', '--contracts', '40']);
  eq(args.inputs, ['a.gz', 'b.gz']);
  eq(args.edgeBps, 250);
  eq(args.slippageCents, 3);
  eq(args.contracts, 40);
}

// Both plain JSONL and native gzip are consumed with exact record parity.
async function testStreams() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-eval-test-'));
  const plain = path.join(dir, 'tiny.jsonl');
  const gzip = `${plain}.gz`;
  const records = [{ kind: 'collector_start' }, { kind: 'collector_end' }];
  const body = records.map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(plain, body);
  fs.writeFileSync(gzip, zlib.gzipSync(body));
  const fromPlain = await extractFiles([plain]);
  const fromGzip = await extractFiles([gzip]);
  eq(fromPlain.counts.records, 2);
  eq(fromGzip.counts.records, 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

testStreams().then(() => {
  console.log(`PASS realtime microstructure evaluator — ${checks} checks`);
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
