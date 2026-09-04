#!/usr/bin/env node
'use strict';

/**
 * Offline evaluation for realtime-microstructure-collector.js.
 *
 * This is deliberately not a trading process. It consumes the append-only public-data corpus and
 * asks one narrow question: do receive-time microstructure features improve terminal YES
 * probabilities beyond the contemporaneous Kalshi midpoint, after spread, fees and slippage?
 *
 * Guardrails:
 * - one canonical snapshot near T-9m per contract, so repeated REST polls do not become fake samples;
 * - Coinbase frames are joined only when their receive-time bucket ended before the Kalshi response;
 * - Coinbase distance is measured from its own first post-open quote, not the CF Benchmarks strike;
 * - expanding UTC-day folds only, with L2 selected on an inner past-day validation split;
 * - a fixed-logit-offset model: logit(P(YES)) = logit(Kalshi midpoint) + residual(features);
 * - at most one simulated entry per settlement window, exact Kalshi fee rounding, and slippage;
 * - output can qualify only for a new forward shadow. It can never activate paper or live entries.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { standardizer, applyScale, sigmoid, solve } = require('./corpus2/model');

const DAY_MS = 86400000;
const TARGET_SECONDS_LEFT = 540;
const TARGET_TOLERANCE_SECONDS = 6;
const PRODUCT_BY_SYM = Object.freeze({
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', DOGE: 'DOGE-USD'
});
const FEATURE_NAMES = Object.freeze([
  'spotMoveBps', 'distanceVol', 'return5sBps', 'return30sBps',
  'rv60Bps', 'rv300Bps', 'ofi5s', 'ofi30s', 'ofi120s',
  'touchImbalance', 'depth5Imbalance', 'depth10Imbalance', 'micropriceOffsetBps',
  'reportedTradeSide30s', 'kalshiSpread', 'kalshiTouchImbalance',
  'kalshiDepth5Imbalance', 'kalshiMicropriceOffset', 'kalshiSnapshotFlow',
  'kalshiMidMove30s', 'kalshiMidMove120s', 'kalshiFlow30s', 'kalshiFlow120s',
  'kalshiTouchMean30s', 'kalshiLatencySec', 'secondsLeftDelta', 'marketLogitAdjustment'
]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const logit = p => Math.log(clamp(p, 1e-5, 1 - 1e-5) / (1 - clamp(p, 1e-5, 1 - 1e-5)));
const logLoss = rows => rows.reduce((sum, row) => {
  const p = clamp(row.p, 1e-12, 1 - 1e-12);
  return sum - (row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
}, 0) / Math.max(1, rows.length);
const brier = rows => rows.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / Math.max(1, rows.length);

/** Production-identical Kalshi taker fee; settlement itself has no exit fill or exit fee. */
function feeDollars(price, contracts = 30) {
  const rawCents = 0.07 * contracts * price * (1 - price) * 100;
  return Math.ceil(+rawCents.toFixed(6)) / 100;
}

function feePerContract(price, contracts = 30) {
  return feeDollars(price, contracts) / contracts;
}

function auc(rows) {
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  let rank = 1, i = 0, positiveRanks = 0, positives = 0, negatives = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const averageRank = (rank + rank + j - i) / 2;
    for (let k = i; k <= j; k++) {
      if (sorted[k].y) { positiveRanks += averageRank; positives++; } else negatives++;
    }
    rank += j - i + 1;
    i = j + 1;
  }
  return positives && negatives
    ? (positiveRanks - positives * (positives + 1) / 2) / (positives * negatives) : null;
}

function reliability(rows, minBin = 20) {
  const out = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10, hi = (b + 1) / 10;
    const bin = rows.filter(row => row.p >= lo && (b === 9 ? row.p <= hi : row.p < hi));
    if (bin.length < minBin) continue;
    out.push({
      band: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`, n: bin.length,
      predicted: bin.reduce((sum, row) => sum + row.p, 0) / bin.length,
      observed: bin.reduce((sum, row) => sum + row.y, 0) / bin.length
    });
  }
  return out;
}

class FrameHistory {
  constructor(maxFrames = 1500) {
    this.maxFrames = maxFrames;
    this.byProduct = new Map();
  }

  add(frame) {
    if (!frame || !frame.product || !Number.isFinite(frame.bucketEndMs)) return;
    const rows = this.byProduct.get(frame.product) || [];
    rows.push(frame);
    if (rows.length > this.maxFrames) rows.splice(0, rows.length - this.maxFrames);
    this.byProduct.set(frame.product, rows);
  }

  rows(product) { return this.byProduct.get(product) || []; }

  atOrBefore(product, recvMs) {
    const rows = this.rows(product);
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].bucketEndMs <= recvMs) return rows[i];
    return null;
  }

  firstAfter(product, recvMs, maxDelayMs = 3000) {
    return this.rows(product).find(row => row.bucketEndMs >= recvMs && row.bucketEndMs <= recvMs + maxDelayMs) || null;
  }

  window(product, recvMs, windowMs) {
    return this.rows(product).filter(row => row.bucketEndMs <= recvMs && row.bucketEndMs > recvMs - windowMs);
  }
}

function frameMid(frame) {
  const mid = frame && frame.book && Number(frame.book.mid);
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

function logReturnBps(latest, prior) {
  const a = frameMid(latest), b = frameMid(prior);
  return a && b ? Math.log(a / b) * 10000 : 0;
}

function realizedVolBps(frames) {
  let sum = 0, prior = null;
  for (const frame of frames) {
    const mid = frameMid(frame);
    if (mid && prior) sum += Math.log(mid / prior) ** 2;
    if (mid) prior = mid;
  }
  return Math.sqrt(sum) * 10000;
}

function aggregateFrames(frames) {
  let ofi = 0, buy = 0, sell = 0, gaps = 0;
  for (const frame of frames) {
    ofi += finite(frame.flow && frame.flow.bps5Normalized);
    buy += finite(frame.trade && frame.trade.reportedBuyBase);
    sell += finite(frame.trade && frame.trade.reportedSellBase);
    gaps += finite(frame.sequenceGaps);
  }
  return { ofi, tradeSide: buy + sell > 0 ? (buy - sell) / (buy + sell) : 0, gaps };
}

function kalshiPath(rows, recvMs, windowMs) {
  const observed = rows.filter(row => Number(row.recvMs) <= recvMs && Number(row.recvMs) > recvMs - windowMs);
  if (!observed.length) return { midMove: 0, flow: 0, touchMean: 0 };
  const mids = observed.map(row => Number(row.book && row.book.mid)).filter(Number.isFinite);
  const touches = observed.map(row => Number(row.book && row.book.touchImbalance)).filter(Number.isFinite);
  return {
    midMove: mids.length > 1 ? mids[mids.length - 1] - mids[0] : 0,
    flow: observed.reduce((sum, row) => sum + finite(row.snapshotFlow && row.snapshotFlow.near5cNormalized), 0),
    touchMean: touches.length ? touches.reduce((sum, value) => sum + value, 0) / touches.length : 0
  };
}

function buildFeatureRow(record, history, kalshiRows = []) {
  const product = PRODUCT_BY_SYM[record.sym];
  const recvMs = Number(record.recvMs);
  const openMs = Date.parse(record.openTime);
  if (!product || !Number.isFinite(recvMs) || !Number.isFinite(openMs)) return null;

  const latest = history.atOrBefore(product, recvMs);
  const opening = history.firstAfter(product, openMs);
  if (!latest || !opening || !frameMid(latest) || !frameMid(opening)) return null;
  if (recvMs - latest.bucketEndMs > 3000) return null;

  const w5 = history.window(product, recvMs, 5000);
  const w30 = history.window(product, recvMs, 30000);
  const w60 = history.window(product, recvMs, 60000);
  const w120 = history.window(product, recvMs, 120000);
  const w300 = history.window(product, recvMs, 300000);
  if (w300.length < 240 || aggregateFrames(w300).gaps > 0) return null;

  const prior5 = history.atOrBefore(product, recvMs - 5000);
  const prior30 = history.atOrBefore(product, recvMs - 30000);
  const rv60 = realizedVolBps(w60), rv300 = realizedVolBps(w300);
  const spotMove = logReturnBps(latest, opening);
  const secondsLeft = Number(record.secondsLeft);
  const oneSecondVol = rv300 / Math.sqrt(Math.max(1, w300.length - 1));
  const distanceVol = oneSecondVol > 0 && secondsLeft > 0
    ? spotMove / (oneSecondVol * Math.sqrt(secondsLeft)) : 0;
  const a5 = aggregateFrames(w5), a30 = aggregateFrames(w30), a120 = aggregateFrames(w120);
  const k30 = kalshiPath(kalshiRows, recvMs, 30000), k120 = kalshiPath(kalshiRows, recvMs, 120000);
  const book = record.book || {}, cb = latest.book || {};

  return [
    spotMove, distanceVol, logReturnBps(latest, prior5), logReturnBps(latest, prior30),
    rv60, rv300, a5.ofi, a30.ofi, a120.ofi,
    finite(cb.touchImbalance), finite(cb.depth5Bps && cb.depth5Bps.imbalance),
    finite(cb.depth10Bps && cb.depth10Bps.imbalance), finite(cb.micropriceOffsetBps),
    a30.tradeSide, finite(book.spread), finite(book.touchImbalance),
    finite(book.depth5c && book.depth5c.imbalance), finite(book.micropriceOffset),
    finite(record.snapshotFlow && record.snapshotFlow.near5cNormalized),
    k30.midMove, k120.midMove, k30.flow, k120.flow, k30.touchMean,
    finite(record.latencyMs) / 1000, secondsLeft - TARGET_SECONDS_LEFT,
    logit(Number(book.mid))
  ];
}

class ExampleExtractor {
  constructor() {
    this.history = new FrameHistory();
    this.kalshiHistory = new Map();
    this.candidates = new Map();
    this.settlements = new Map();
    this.seen = new Set();
    this.counts = {
      records: 0, coinbaseFrames: 0, candidateBooks: 0, settledExamples: 0,
      unsupportedUnderlying: 0, missedTarget: 0, invalidBook: 0, featureUnavailable: 0
    };
  }

  consume(record) {
    this.counts.records++;
    if (record.kind === 'coinbase_frame') {
      this.history.add(record);
      this.counts.coinbaseFrames++;
      return;
    }
    if (record.kind === 'kalshi_settlement') {
      this.settlements.set(record.ticker, String(record.result).toUpperCase() === 'YES' ? 1 : 0);
      return;
    }
    if (record.kind !== 'kalshi_book') return;
    const kalshiRows = this.kalshiHistory.get(record.ticker) || [];
    kalshiRows.push(record);
    if (kalshiRows.length > 600) kalshiRows.splice(0, kalshiRows.length - 600);
    this.kalshiHistory.set(record.ticker, kalshiRows);
    if (this.seen.has(record.ticker)) return;

    const left = Number(record.secondsLeft);
    if (!Number.isFinite(left) || left > TARGET_SECONDS_LEFT) return;
    this.seen.add(record.ticker); // the first crossing is canonical; never hunt for a nicer later quote
    this.counts.candidateBooks++;
    if (left < TARGET_SECONDS_LEFT - TARGET_TOLERANCE_SECONDS) {
      this.counts.missedTarget++;
      return;
    }
    if (!PRODUCT_BY_SYM[record.sym]) {
      this.counts.unsupportedUnderlying++;
      return;
    }
    const book = record.book || {};
    const mid = Number(book.mid), yesAsk = Number(book.yesAsk), yesBid = Number(book.yesBid);
    if (!(mid > 0 && mid < 1 && yesAsk > 0 && yesAsk < 1 && yesBid > 0 && yesBid < 1)) {
      this.counts.invalidBook++;
      return;
    }
    const X = buildFeatureRow(record, this.history, kalshiRows);
    if (!X || X.some(value => !Number.isFinite(value))) {
      this.counts.featureUnavailable++;
      return;
    }
    this.candidates.set(record.ticker, {
      ticker: record.ticker, sym: record.sym, series: record.series,
      recvMs: Number(record.recvMs), closeTime: record.closeTime,
      // Group by settlement day, not decision day: a 00:00 contract is never allowed into the
      // preceding day's training set before its label could have existed.
      day: Math.floor((Number.isFinite(Date.parse(record.closeTime))
        ? Date.parse(record.closeTime) : Number(record.recvMs)) / DAY_MS),
      marketMid: mid, yesAsk, noAsk: 1 - yesBid, X
    });
  }

  finish() {
    const examples = [];
    for (const [ticker, row] of this.candidates) {
      if (!this.settlements.has(ticker)) continue;
      examples.push({ ...row, y: this.settlements.get(ticker) });
    }
    examples.sort((a, b) => a.recvMs - b.recvMs || a.ticker.localeCompare(b.ticker));
    this.counts.settledExamples = examples.length;
    return { examples, counts: this.counts };
  }
}

async function* readRecords(file) {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    try { yield JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${lineNo}: invalid JSON: ${error.message}`); }
  }
}

async function extractFiles(files) {
  const extractor = new ExampleExtractor();
  for (const file of files) for await (const record of readRecords(file)) extractor.consume(record);
  return extractor.finish();
}

function fitOffsetLogistic(rows, { l2 = 2, iterations = 15, featureNames = FEATURE_NAMES } = {}) {
  if (!rows.length) throw new Error('cannot fit an empty model');
  const scaler = standardizer(rows.map(row => row.X), featureNames.length);
  const scaled = rows.map(row => applyScale(row.X, scaler));
  const d = featureNames.length + 1;
  const beta = new Float64Array(d);

  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = new Float64Array(d);
    const hessian = Array.from({ length: d }, () => new Float64Array(d));
    let movement = 0;
    for (let i = 0; i < rows.length; i++) {
      const x = new Float64Array(d); x[0] = 1;
      for (let j = 1; j < d; j++) x[j] = scaled[i][j - 1];
      let z = logit(rows[i].marketMid);
      for (let j = 0; j < d; j++) z += beta[j] * x[j];
      const p = sigmoid(z), weight = Math.max(1e-8, p * (1 - p));
      for (let a = 0; a < d; a++) {
        gradient[a] += (p - rows[i].y) * x[a];
        for (let b = a; b < d; b++) hessian[a][b] += weight * x[a] * x[b];
      }
    }
    for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) hessian[a][b] = hessian[b][a];
    for (let j = 1; j < d; j++) { hessian[j][j] += l2; gradient[j] += l2 * beta[j]; }
    const step = solve(hessian, gradient, d);
    if (!step) break;
    for (let j = 0; j < d; j++) { beta[j] -= step[j]; movement += Math.abs(step[j]); }
    if (movement < 1e-8) break;
  }

  return {
    beta, scaler, l2,
    predict(row) {
      const x = applyScale(row.X, scaler);
      let z = logit(row.marketMid) + beta[0];
      for (let j = 0; j < x.length; j++) z += beta[j + 1] * x[j];
      return sigmoid(z);
    },
    weights: featureNames.map((feature, i) => ({ feature, weight: beta[i + 1] }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  };
}

const marketCalibrationRow = row => ({ ...row, X: [logit(row.marketMid)] });

/** Platt-style recalibration is a stronger baseline than treating the raw midpoint as perfect. */
function fitMarketCalibration(rows, options = {}) {
  const model = fitOffsetLogistic(rows.map(marketCalibrationRow), {
    ...options, featureNames: ['marketLogitAdjustment']
  });
  return { ...model, predict: row => model.predict(marketCalibrationRow(row)) };
}

function chooseL2(trainRows, candidates = [0.5, 2, 8, 32], fitModel = fitOffsetLogistic) {
  const days = [...new Set(trainRows.map(row => row.day))].sort((a, b) => a - b);
  if (days.length < 3) return 2;
  const validationDay = days[days.length - 1];
  const fitRows = trainRows.filter(row => row.day < validationDay);
  const validationRows = trainRows.filter(row => row.day === validationDay);
  let best = { l2: candidates[0], score: Infinity };
  for (const l2 of candidates) {
    const model = fitModel(fitRows, { l2 });
    const score = logLoss(validationRows.map(row => ({ y: row.y, p: model.predict(row) })));
    if (score < best.score) best = { l2, score };
  }
  return best.l2;
}

function walkForward(examples, { minTrainDays = 3 } = {}) {
  const days = [...new Set(examples.map(row => row.day))].sort((a, b) => a - b);
  const predictions = [];
  const folds = [];
  let lastModel = null;
  for (let i = minTrainDays; i < days.length; i++) {
    const testDay = days[i];
    const train = examples.filter(row => row.day < testDay);
    const test = examples.filter(row => row.day === testDay);
    const l2 = chooseL2(train);
    const calibrationL2 = chooseL2(train, [0.5, 2, 8, 32], fitMarketCalibration);
    const model = fitOffsetLogistic(train, { l2 });
    const calibration = fitMarketCalibration(train, { l2: calibrationL2 });
    for (const row of test) predictions.push({
      ...row, pModel: model.predict(row), pCalibrated: calibration.predict(row),
      pMarket: row.marketMid, testDay, l2, calibrationL2
    });
    folds.push({ testDay, train: train.length, test: test.length, l2, calibrationL2 });
    lastModel = model;
  }
  return { predictions, folds, days, lastModel };
}

function probabilityMetrics(predictions) {
  const model = predictions.map(row => ({ y: row.y, p: row.pModel }));
  const calibrated = predictions.map(row => ({ y: row.y, p: row.pCalibrated }));
  const market = predictions.map(row => ({ y: row.y, p: row.pMarket }));
  const score = rows => ({ auc: auc(rows), brier: brier(rows), logLoss: logLoss(rows), reliability: reliability(rows) });
  return {
    rows: predictions.length, model: score(model), calibratedMarket: score(calibrated), market: score(market),
    incrementalOverCalibrated: {
      brier: brier(calibrated) - brier(model), logLoss: logLoss(calibrated) - logLoss(model)
    },
    incrementalOverRaw: { brier: brier(market) - brier(model), logLoss: logLoss(market) - logLoss(model) }
  };
}

function selectTrades(predictions, { edgeBps = 300, slippageCents = 4, contracts = 30 } = {}) {
  const byWindow = new Map();
  for (const row of predictions) {
    const yesEntry = clamp(row.yesAsk + slippageCents / 100, 0.01, 0.99);
    const noEntry = clamp(row.noAsk + slippageCents / 100, 0.01, 0.99);
    const yesEdge = row.pModel - yesEntry - feePerContract(yesEntry, contracts);
    const noEdge = (1 - row.pModel) - noEntry - feePerContract(noEntry, contracts);
    const side = yesEdge >= noEdge ? 'YES' : 'NO';
    const expectedEdge = Math.max(yesEdge, noEdge);
    if (expectedEdge < edgeBps / 10000) continue;
    const entry = side === 'YES' ? yesEntry : noEntry;
    const won = side === 'YES' ? row.y === 1 : row.y === 0;
    const fee = feePerContract(entry, contracts);
    const trade = {
      ticker: row.ticker, sym: row.sym, closeTime: row.closeTime, day: row.day,
      side, pModel: row.pModel, pMarket: row.pMarket, quotedAsk: side === 'YES' ? row.yesAsk : row.noAsk,
      entry, fee, expectedEdge, won,
      pnlPerContract: (won ? 1 : 0) - entry - fee,
      costPerContract: entry + fee
    };
    const prior = byWindow.get(row.closeTime);
    if (!prior || trade.expectedEdge > prior.expectedEdge) byWindow.set(row.closeTime, trade);
  }
  return [...byWindow.values()].sort((a, b) => String(a.closeTime).localeCompare(String(b.closeTime)));
}

function seededRandom(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => ((state = (1664525 * state + 1013904223) >>> 0) / 0x100000000);
}

function dayClusteredMeanCI(trades, iterations = 4000) {
  if (!trades.length) return { low: null, high: null };
  const groups = new Map();
  for (const trade of trades) {
    const rows = groups.get(trade.day) || [];
    rows.push(trade.pnlPerContract);
    groups.set(trade.day, rows);
  }
  const days = [...groups.keys()], random = seededRandom();
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0, n = 0;
    for (let j = 0; j < days.length; j++) {
      const values = groups.get(days[Math.floor(random() * days.length)]);
      for (const value of values) { sum += value; n++; }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { low: means[Math.floor(iterations * 0.025)], high: means[Math.floor(iterations * 0.975)] };
}

function economicMetrics(trades, oosDays) {
  const pnl = trades.reduce((sum, trade) => sum + trade.pnlPerContract, 0);
  const cost = trades.reduce((sum, trade) => sum + trade.costPerContract, 0);
  const ci = dayClusteredMeanCI(trades);
  return {
    trades: trades.length, tradesPerHour: oosDays > 0 ? trades.length / (oosDays * 24) : 0,
    wins: trades.filter(trade => trade.won).length,
    winRate: trades.length ? trades.filter(trade => trade.won).length / trades.length : null,
    pnlPerContract: pnl, meanPnlPerTrade: trades.length ? pnl / trades.length : null,
    roi: cost > 0 ? pnl / cost : null, dayClustered95: ci
  };
}

function activationVerdict(metrics, economics, totalDays) {
  const reasons = [
    'this corpus is one observation window, not independent forward confirmation',
    'Coinbase is not necessarily Kalshi’s exact CF Benchmarks settlement source'
  ];
  if (!(metrics.incrementalOverCalibrated.brier > 0 && metrics.incrementalOverCalibrated.logLoss > 0))
    reasons.push('full residual model lacks proper-score skill over a separately calibrated market-only baseline');
  if (!(economics.dayClustered95.low > 0)) reasons.push('day-clustered lower confidence bound is not above zero');
  if (economics.trades < 30) reasons.push('fewer than 30 out-of-sample simulated entries');
  if (totalDays < 5) reasons.push('fewer than five distinct UTC days');
  return {
    accountReady: false,
    status: reasons.length === 2 ? 'eligible_for_independent_forward_shadow' : 'observe_only_rejected',
    reasons,
    invariant: 'this evaluator never enables paper or live account entries'
  };
}

function parseArgs(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
  };
  const inputs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--input' && argv[i + 1]) inputs.push(argv[++i]);
  return {
    inputs, out: value('--out'), minDays: finite(value('--min-days', 5), 5),
    minExamples: finite(value('--min-examples', 500), 500),
    minTrainDays: finite(value('--min-train-days', 3), 3),
    edgeBps: finite(value('--edge-bps', 300), 300),
    slippageCents: finite(value('--slippage-cents', 4), 4),
    contracts: finite(value('--contracts', 30), 30)
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.inputs.length) throw new Error('usage: node realtime-microstructure-evaluate.js --input FILE[.gz] [--out REPORT.json]');
  for (const file of options.inputs) if (!fs.existsSync(file)) throw new Error(`input not found: ${file}`);

  const { examples, counts } = await extractFiles(options.inputs);
  const days = [...new Set(examples.map(row => row.day))];
  if (examples.length < options.minExamples || days.length < options.minDays) {
    const report = {
      status: 'insufficient_data', generatedAt: new Date().toISOString(), inputs: options.inputs.map(file => path.resolve(file)),
      counts, settledExamples: examples.length, days: days.length,
      required: { examples: options.minExamples, days: options.minDays },
      safety: { accountReady: false, trading: false }
    };
    if (options.out) fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  const walk = walkForward(examples, { minTrainDays: options.minTrainDays });
  const metrics = probabilityMetrics(walk.predictions);
  const trades = selectTrades(walk.predictions, options);
  const economics = economicMetrics(trades, walk.folds.length);
  const report = {
    status: 'complete', generatedAt: new Date().toISOString(), inputs: options.inputs.map(file => path.resolve(file)),
    design: {
      targetSecondsLeft: TARGET_SECONDS_LEFT, targetToleranceSeconds: TARGET_TOLERANCE_SECONDS,
      validation: 'expanding UTC settlement-day walk-forward; L2 chosen on last training day only',
      probability: 'fixed Kalshi-midpoint logit offset plus regularized residual; separately fitted market-only calibration benchmark',
      execution: `actual side ask + ${options.slippageCents}c slippage + exact ${options.contracts}-contract entry fee`,
      selection: `at most one highest-edge entry per settlement window; fixed ${options.edgeBps}bp minimum edge`
    },
    counts, examples: examples.length, days: days.length, folds: walk.folds,
    probabilityMetrics: metrics, economicMetrics: economics,
    topWeights: walk.lastModel ? walk.lastModel.weights.slice(0, 12) : [],
    verdict: activationVerdict(metrics, economics, days.length), trades
  };
  if (options.out) fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  DAY_MS, TARGET_SECONDS_LEFT, TARGET_TOLERANCE_SECONDS, PRODUCT_BY_SYM, FEATURE_NAMES,
  feeDollars, feePerContract, auc, brier, logLoss, reliability,
  FrameHistory, aggregateFrames, kalshiPath, buildFeatureRow, ExampleExtractor, extractFiles,
  fitOffsetLogistic, fitMarketCalibration, chooseL2, walkForward, probabilityMetrics,
  selectTrades, dayClusteredMeanCI, economicMetrics, activationVerdict, parseArgs, main
};
