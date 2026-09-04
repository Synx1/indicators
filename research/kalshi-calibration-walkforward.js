#!/usr/bin/env node
'use strict';

/**
 * Walk-forward test of KALSHI PRICE CALIBRATION as a predictor.
 *
 * Motivation. Every model tried so far attempted to out-forecast the market from features and failed
 * out of sample. This asks a narrower and much older question: is the market price itself biased in a
 * stable, exploitable way? Prediction markets classically show a favourite-longshot bias (longshots
 * overpriced, heavy favourites underpriced). If that holds here, the "predictor" is the price itself
 * and there is no feature model to overfit.
 *
 * Why now. Measured cost curve from 19,594 live books: crossing plus taker fee costs about 2.57pp of
 * true edge at 40-60c but only about 0.55pp at >=90c. The retired Favourite strategy capped entries
 * at 90c, so the CHEAPEST band was never actually traded. A bias too small to matter at mid can be
 * decisive in the tails.
 *
 * Honesty guards, because a calibration curve is trivially easy to fool yourself with:
 * - The bias is estimated ONLY on settlement days strictly before the day being traded (expanding
 *   walk-forward). A bucket's direction is never learned from the day it is traded on.
 * - A bucket must clear a minimum training sample count AND its own measured cost, or it is skipped.
 * - P&L uses the real side ask plus configurable slippage and the production-identical fee, not the
 *   mid that generated the signal.
 * - Confidence intervals are day-clustered: adjacent 15-minute windows on one day are not
 *   independent observations.
 * - In-sample calibration is reported separately and is explicitly NOT a result.
 * - This file never marks anything ready to trade and touches no account, order, or credential path.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { feePerContract, dayClusteredMeanCI } = require('./realtime-microstructure-evaluate');

const DAY_MS = 86400000;
const DEFAULT_MINUTE = 9;
const DEFAULT_CONTRACTS = 30;
const DEFAULT_SLIPPAGE_CENTS = 1;
const DEFAULT_MIN_TRAIN = 300;
const DEFAULT_MARGIN_PP = 0.5;
const DEFAULT_MIN_T = 2;

/** Price buckets deliberately finer in the tails, where the cost bar is lowest. */
const BUCKETS = Object.freeze([
  { label: '<5c', lo: 0, hi: 0.05 }, { label: '5-10c', lo: 0.05, hi: 0.10 },
  { label: '10-25c', lo: 0.10, hi: 0.25 }, { label: '25-40c', lo: 0.25, hi: 0.40 },
  { label: '40-60c', lo: 0.40, hi: 0.60 }, { label: '60-75c', lo: 0.60, hi: 0.75 },
  { label: '75-90c', lo: 0.75, hi: 0.90 }, { label: '90-95c', lo: 0.90, hi: 0.95 },
  { label: '>=95c', lo: 0.95, hi: 1.01 }
]);

const bucketOf = mid => BUCKETS.findIndex(b => mid >= b.lo && mid < b.hi);
const dayKey = ms => Math.floor(ms / DAY_MS);

/**
 * Extract one decision observation per market: the quote state at `minute` minutes left, plus the
 * settlement result. Returns null when that minute is missing or the quote is unusable.
 */
function observationFrom(row, minute) {
  if (!row || !Array.isArray(row.p) || (row.r !== 0 && row.r !== 1)) return null;
  const step = row.p.find(entry => Array.isArray(entry) && entry[0] === minute);
  if (!step) return null;
  const askClose = Array.isArray(step[1]) ? Number(step[1][2]) : NaN;
  const bidClose = Array.isArray(step[2]) ? Number(step[2][2]) : NaN;
  if (!Number.isFinite(askClose) || !Number.isFinite(bidClose)) return null;
  if (askClose <= 0 || askClose >= 1 || bidClose < 0 || bidClose >= 1) return null;
  if (askClose < bidClose) return null;
  const mid = (askClose + bidClose) / 2;
  const bucket = bucketOf(mid);
  if (bucket < 0) return null;
  return {
    ticker: row.t, sym: row.s, closeMs: Number(row.c), day: dayKey(Number(row.c)),
    y: row.r, yesAsk: askClose, yesBid: bidClose, noAsk: +(1 - bidClose).toFixed(6),
    mid, bucket, volume: Number(Array.isArray(step[3]) ? 0 : step[3]) || 0
  };
}

async function loadObservations(file, minute) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file), crlfDelay: Infinity
  });
  const rows = [];
  let parsed = 0, skipped = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { skipped++; continue; }
    parsed++;
    const observation = observationFrom(row, minute);
    if (observation) rows.push(observation); else skipped++;
  }
  rows.sort((a, b) => a.closeMs - b.closeMs);
  return { rows, parsed, skipped };
}

/** Realized-minus-priced bias per bucket. Positive means YES settles more often than priced. */
function calibrate(rows) {
  const buckets = BUCKETS.map(b => ({
    label: b.label, n: 0, midSum: 0, askSum: 0, noAskSum: 0, wins: 0
  }));
  for (const row of rows) {
    const bucket = buckets[row.bucket];
    bucket.n++;
    bucket.midSum += row.mid;
    bucket.askSum += row.yesAsk;
    bucket.noAskSum += row.noAsk;
    bucket.wins += row.y;
  }
  return buckets.map(bucket => {
    if (!bucket.n) {
      return { label: bucket.label, n: 0, meanMid: null, meanAsk: null, meanNoAsk: null,
        realized: null, biasPp: null, biasSePp: null };
    }
    const meanMid = bucket.midSum / bucket.n;
    const realized = bucket.wins / bucket.n;
    // Binomial standard error of the realized rate, in probability points. The priced mid is treated
    // as fixed, so this is the uncertainty that matters for "is the bias real".
    const sePp = Math.sqrt(Math.max(realized * (1 - realized), 1e-9) / bucket.n) * 100;
    return {
      label: bucket.label, n: bucket.n,
      meanMid: +meanMid.toFixed(4),
      meanAsk: +(bucket.askSum / bucket.n).toFixed(4),
      meanNoAsk: +(bucket.noAskSum / bucket.n).toFixed(4),
      realized: +realized.toFixed(4),
      biasPp: +((realized - meanMid) * 100).toFixed(3),
      biasSePp: +sePp.toFixed(4)
    };
  });
}

/**
 * Cost of taking one side, in probability points, measured against that side's own fair value.
 * `quoted` is the real average offer for the side; `fair` is the fair probability of that side. The
 * half-spread must be included here — pricing cost off the mid understates it and lets a bucket
 * look tradable when it is not.
 */
function sideCostPp(quoted, fair, contracts, slippageCents) {
  const fill = Math.min(0.99, Math.max(0.01, quoted + slippageCents / 100));
  return { fill, costPp: (fill - fair) * 100 + feePerContract(fill, contracts) * 100 };
}

/**
 * Decide whether a bucket's TRAINING bias is large enough to trade, and in which direction.
 *
 * A bare "bias > cost" test is not enough: with nine buckets, a bucket whose true bias is zero will
 * sometimes clear the bar by luck, and those lucky buckets are exactly the thin, unstable ones. So
 * the surplus over cost must also be at least `minT` standard errors of the realized rate. This is
 * an a-priori statistical requirement, NOT a filter chosen after seeing which buckets performed.
 */
function bucketSignal(training, contracts, slippageCents, minTrain, marginPp, minT = 0) {
  if (!training || training.n < minTrain || training.biasPp == null) return null;
  const se = training.biasSePp > 0 ? training.biasSePp : Infinity;
  const yesCost = sideCostPp(training.meanAsk, training.meanMid, contracts, slippageCents);
  const noCost = sideCostPp(training.meanNoAsk, 1 - training.meanMid, contracts, slippageCents);
  const yesSurplus = training.biasPp - yesCost.costPp - marginPp;
  const noSurplus = -training.biasPp - noCost.costPp - marginPp;
  if (yesSurplus > 0 && yesSurplus / se >= minT) {
    return { side: 'YES', biasPp: training.biasPp, costPp: +yesCost.costPp.toFixed(3),
      surplusPp: +yesSurplus.toFixed(3), t: +(yesSurplus / se).toFixed(2) };
  }
  if (noSurplus > 0 && noSurplus / se >= minT) {
    return { side: 'NO', biasPp: training.biasPp, costPp: +noCost.costPp.toFixed(3),
      surplusPp: +noSurplus.toFixed(3), t: +(noSurplus / se).toFixed(2) };
  }
  return null;
}

function walkForward(rows, options = {}) {
  const {
    contracts = DEFAULT_CONTRACTS, slippageCents = DEFAULT_SLIPPAGE_CENTS,
    minTrain = DEFAULT_MIN_TRAIN, marginPp = DEFAULT_MARGIN_PP, minT = DEFAULT_MIN_T
  } = options;
  const days = [...new Set(rows.map(row => row.day))].sort((a, b) => a - b);
  const byDay = new Map(days.map(day => [day, rows.filter(row => row.day === day)]));
  const trades = [];
  const skippedDays = [];
  const trained = [];

  for (let i = 0; i < days.length; i++) {
    const testDay = days[i];
    const trainingRows = [];
    for (let j = 0; j < i; j++) trainingRows.push(...byDay.get(days[j]));
    if (!trainingRows.length) { skippedDays.push({ day: testDay, reason: 'no prior day' }); continue; }
    const training = calibrate(trainingRows);
    const signals = training.map(bucket =>
      bucketSignal(bucket, contracts, slippageCents, minTrain, marginPp, minT));
    trained.push({ day: testDay, trainRows: trainingRows.length,
      active: signals.map((s, idx) => s && { bucket: BUCKETS[idx].label, ...s }).filter(Boolean) });

    for (const row of byDay.get(testDay)) {
      const signal = signals[row.bucket];
      if (!signal) continue;
      const quoted = signal.side === 'YES' ? row.yesAsk : row.noAsk;
      const fill = Math.min(0.99, Math.max(0.01, quoted + slippageCents / 100));
      const fee = feePerContract(fill, contracts);
      const won = signal.side === 'YES' ? row.y === 1 : row.y === 0;
      trades.push({
        ticker: row.ticker, sym: row.sym, day: row.day, bucket: BUCKETS[row.bucket].label,
        side: signal.side, mid: row.mid, quoted, fill, fee, won,
        pnlPerContract: +(((won ? 1 : 0) - fill - fee)).toFixed(6),
        costPerContract: +(fill + fee).toFixed(6)
      });
    }
  }
  return { days: days.length, trades, trained, skippedDays };
}

function economics(trades) {
  if (!trades.length) {
    return { trades: 0, wins: 0, winRate: null, meanEntry: null, netPerContract: null,
      roi: null, ci: { low: null, high: null }, byBucket: [] };
  }
  const wins = trades.filter(trade => trade.won).length;
  const cost = trades.reduce((sum, trade) => sum + trade.costPerContract, 0);
  const net = trades.reduce((sum, trade) => sum + trade.pnlPerContract, 0);
  const groups = new Map();
  for (const trade of trades) {
    const bucket = groups.get(trade.bucket) || { bucket: trade.bucket, n: 0, wins: 0, net: 0, cost: 0 };
    bucket.n++; bucket.wins += trade.won ? 1 : 0;
    bucket.net += trade.pnlPerContract; bucket.cost += trade.costPerContract;
    groups.set(trade.bucket, bucket);
  }
  return {
    trades: trades.length, wins, winRate: +(wins / trades.length).toFixed(4),
    meanEntry: +(trades.reduce((s, t) => s + t.fill, 0) / trades.length).toFixed(4),
    netPerContract: +(net / trades.length).toFixed(6),
    roi: cost > 0 ? +(net / cost).toFixed(6) : null,
    ci: dayClusteredMeanCI(trades),
    byBucket: [...groups.values()].map(bucket => ({
      bucket: bucket.bucket, n: bucket.n, wins: bucket.wins,
      winRate: +(bucket.wins / bucket.n).toFixed(4),
      netPerContract: +(bucket.net / bucket.n).toFixed(6),
      roi: bucket.cost > 0 ? +(bucket.net / bucket.cost).toFixed(6) : null
    })).sort((a, b) => a.bucket.localeCompare(b.bucket))
  };
}

function verdict(result) {
  const { ci, netPerContract, trades } = result;
  if (!trades) return 'no_trades';
  if (ci.low != null && ci.low > 0) return 'positive_lower_bound';
  if (netPerContract > 0) return 'positive_mean_ci_straddles_zero';
  return 'negative';
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] != null ? Number(argv[index + 1]) : fallback;
  };
  return {
    file: argv.find(a => !a.startsWith('--')) || null,
    minute: get('--minute', DEFAULT_MINUTE),
    contracts: get('--contracts', DEFAULT_CONTRACTS),
    slippageCents: get('--slippage', DEFAULT_SLIPPAGE_CENTS),
    minTrain: get('--min-train', DEFAULT_MIN_TRAIN),
    marginPp: get('--margin', DEFAULT_MARGIN_PP),
    minT: get('--min-t', DEFAULT_MIN_T)
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.file) {
    process.stderr.write('usage: kalshi-calibration-walkforward.js <paths.jsonl> [--minute 9]\n');
    process.exitCode = 2;
    return null;
  }
  const { rows, parsed, skipped } = await loadObservations(path.resolve(options.file), options.minute);
  const inSample = calibrate(rows);
  const forward = walkForward(rows, options);
  const result = economics(forward.trades);
  const report = {
    verdict: verdict(result),
    input: { file: path.resolve(options.file), marketsParsed: parsed, unusable: skipped,
      observations: rows.length, settlementDays: forward.days, decisionMinutesLeft: options.minute },
    options: { contracts: options.contracts, slippageCents: options.slippageCents,
      minTrainPerBucket: options.minTrain, safetyMarginPp: options.marginPp,
      minSurplusTStat: options.minT },
    inSampleCalibration: inSample.filter(bucket => bucket.n > 0),
    inSampleWarning: 'Descriptive only. Buckets were not selected out of sample here.',
    walkForward: result,
    activeBucketsFinalDay: forward.trained.length
      ? forward.trained[forward.trained.length - 1].active : [],
    accountReady: false,
    trading: false,
    limitation: 'Historical quote paths, not live fills. A positive lower bound here nominates a ' +
      'forward shadow only; queue position and fill priority are unproven.'
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  BUCKETS, DAY_MS, DEFAULT_MINUTE, DEFAULT_MIN_T, bucketOf, dayKey, observationFrom, loadObservations,
  calibrate, sideCostPp, bucketSignal, walkForward, economics, verdict, parseArgs, main
};
