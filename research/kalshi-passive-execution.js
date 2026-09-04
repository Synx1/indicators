#!/usr/bin/env node
'use strict';

/**
 * Does the favourite-longshot bias survive REAL execution?
 *
 * Established by the calibration walk-forward: buying underpriced favourites (75-95c) is worth about
 * +2.5% fee-adjusted ROI with a positive day-clustered lower bound IF filled at the quoted price, and
 * nothing at all once 1-2 cents of slippage are paid. So the edge is not a forecasting problem any
 * more, it is an execution problem: can the price be obtained without crossing the spread?
 *
 * The obvious answer is a passive limit buy that JOINS THE BID instead of taking the offer. That is
 * cheaper by the half-spread, but it is not free, and the cost is not a fee: a resting buy order fills
 * precisely when a seller is willing to come down to it, which is disproportionately when the
 * favourite is weakening. That is adverse selection, and if it is strong enough it removes the entire
 * edge while looking like an improvement on paper.
 *
 * This study measures it directly and conservatively:
 * - Bucket direction is chosen walk-forward from strictly prior settlement days (imported unchanged
 *   from the calibration module, so the selection rule is not re-tuned here).
 * - A limit buy rests at the observed bid. It is treated as FILLED only if a later minute's ask LOW
 *   trades down to the limit, i.e. a seller actually crossed to us. Never filled from the decision
 *   bar itself, so there is no within-bar lookahead.
 * - Unfilled orders cost nothing and earn nothing; they are reported, not silently dropped.
 * - The headline number is the win rate on FILLED orders versus the unconditional win rate on all
 *   signalled markets. A large negative gap is adverse selection, and it is the finding that matters.
 * - Read-only historical quotes. No credentials, no orders, no account state, and nothing here can
 *   mark a strategy ready.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  BUCKETS, DAY_MS, calibrate, bucketSignal, observationFrom, dayKey
} = require('./kalshi-calibration-walkforward');
const { feePerContract, dayClusteredMeanCI } = require('./realtime-microstructure-evaluate');

const DEFAULT_DECISION_MINUTE = 9;
const DEFAULT_CANCEL_MINUTE = 2;
const DEFAULT_CONTRACTS = 30;
const DEFAULT_MIN_TRAIN = 300;
const DEFAULT_MARGIN_PP = 0.5;
const DEFAULT_MIN_T = 2;

const askLowAt = step => (Array.isArray(step) && Array.isArray(step[1]) ? Number(step[1][0]) : NaN);
const bidLowAt = step => (Array.isArray(step) && Array.isArray(step[2]) ? Number(step[2][0]) : NaN);

/**
 * Conservative passive fill test for a resting BUY at `limit`.
 * Scans minutes strictly after the decision minute, down to the cancel minute, and reports the first
 * minute whose ask low reached the limit. `offsetCents` lets the order rest below the bid.
 */
function passiveFill(pathRows, decisionMinute, cancelMinute, limit) {
  if (!Array.isArray(pathRows) || !Number.isFinite(limit)) return null;
  const candidates = pathRows
    .filter(step => Array.isArray(step) && Number.isFinite(Number(step[0])))
    .filter(step => Number(step[0]) < decisionMinute && Number(step[0]) >= cancelMinute)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
  for (const step of candidates) {
    const low = askLowAt(step);
    if (Number.isFinite(low) && low <= limit) {
      return { filledAtMinute: Number(step[0]), limit, askLow: low };
    }
  }
  return null;
}

/** Where the market ended up relative to our limit, as context for interpreting a fill. */
function terminalContext(pathRows, cancelMinute) {
  const tail = pathRows
    .filter(step => Array.isArray(step) && Number(step[0]) <= cancelMinute)
    .sort((a, b) => Number(b[0]) - Number(a[0]));
  const last = tail[tail.length - 1];
  if (!last) return { lastBidLow: null };
  return { lastBidLow: bidLowAt(last) };
}

async function loadRows(file, decisionMinute) {
  const lines = readline.createInterface({
    input: fs.createReadStream(file), crlfDelay: Infinity
  });
  const rows = [];
  let parsed = 0, unusable = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch (_) { unusable++; continue; }
    parsed++;
    const observation = observationFrom(raw, decisionMinute);
    if (!observation) { unusable++; continue; }
    observation.path = raw.p;
    rows.push(observation);
  }
  rows.sort((a, b) => a.closeMs - b.closeMs);
  return { rows, parsed, unusable };
}

/**
 * Walk forward over settlement days. On each test day, every signalled market produces one resting
 * passive order; the outcome is filled-and-settled, or unfilled.
 */
function study(rows, options = {}) {
  const {
    decisionMinute = DEFAULT_DECISION_MINUTE, cancelMinute = DEFAULT_CANCEL_MINUTE,
    contracts = DEFAULT_CONTRACTS, minTrain = DEFAULT_MIN_TRAIN,
    marginPp = DEFAULT_MARGIN_PP, minT = DEFAULT_MIN_T, offsetCents = 0
  } = options;

  const days = [...new Set(rows.map(row => row.day))].sort((a, b) => a - b);
  const byDay = new Map(days.map(day => [day, rows.filter(row => row.day === day)]));
  const signalled = [];
  const fills = [];

  for (let i = 1; i < days.length; i++) {
    const trainingRows = [];
    for (let j = 0; j < i; j++) trainingRows.push(...byDay.get(days[j]));
    const training = calibrate(trainingRows);
    // Signal selection is evaluated at zero slippage: a passive order does not pay slippage, and
    // charging it here would suppress exactly the buckets this study exists to test.
    const signals = training.map(bucket => bucketSignal(bucket, contracts, 0, minTrain, marginPp, minT));

    for (const row of byDay.get(days[i])) {
      const signal = signals[row.bucket];
      if (!signal || signal.side !== 'YES') continue;
      const won = row.y === 1;
      const limit = +(row.yesBid - offsetCents / 100).toFixed(4);
      signalled.push({ day: row.day, bucket: BUCKETS[row.bucket].label, won, limit });
      if (limit <= 0 || limit >= 1) continue;
      const fill = passiveFill(row.path, decisionMinute, cancelMinute, limit);
      if (!fill) continue;
      const fee = feePerContract(limit, contracts);
      fills.push({
        ticker: row.ticker, sym: row.sym, day: row.day, bucket: BUCKETS[row.bucket].label,
        quotedAsk: row.yesAsk, limit, filledAtMinute: fill.filledAtMinute, fee, won,
        pnlPerContract: +(((won ? 1 : 0) - limit - fee)).toFixed(6),
        costPerContract: +(limit + fee).toFixed(6),
        ...terminalContext(row.path, cancelMinute)
      });
    }
  }
  return { days: days.length, signalled, fills };
}

function summarizeStudy({ signalled, fills }) {
  const unconditionalWins = signalled.filter(row => row.won).length;
  const unconditional = signalled.length ? unconditionalWins / signalled.length : null;
  const filledWins = fills.filter(row => row.won).length;
  const filledRate = fills.length ? filledWins / fills.length : null;
  const cost = fills.reduce((sum, row) => sum + row.costPerContract, 0);
  const net = fills.reduce((sum, row) => sum + row.pnlPerContract, 0);
  const adverseSelectionPp = unconditional != null && filledRate != null
    ? +((filledRate - unconditional) * 100).toFixed(3) : null;
  return {
    signalledMarkets: signalled.length,
    unconditionalWinRate: unconditional == null ? null : +unconditional.toFixed(4),
    filledOrders: fills.length,
    fillRate: signalled.length ? +(fills.length / signalled.length).toFixed(4) : null,
    filledWinRate: filledRate == null ? null : +filledRate.toFixed(4),
    adverseSelectionPp,
    meanLimit: fills.length ? +(fills.reduce((s, r) => s + r.limit, 0) / fills.length).toFixed(4) : null,
    meanQuotedAsk: fills.length
      ? +(fills.reduce((s, r) => s + r.quotedAsk, 0) / fills.length).toFixed(4) : null,
    netPerContract: fills.length ? +(net / fills.length).toFixed(6) : null,
    roi: cost > 0 ? +(net / cost).toFixed(6) : null,
    ci: dayClusteredMeanCI(fills)
  };
}

function verdict(summary) {
  if (!summary.filledOrders) return 'no_fills';
  if (summary.ci.low != null && summary.ci.low > 0) return 'positive_lower_bound';
  if (summary.netPerContract > 0) return 'positive_mean_ci_straddles_zero';
  return 'negative';
}

function parseArgs(argv) {
  const get = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] != null ? Number(argv[index + 1]) : fallback;
  };
  return {
    file: argv.find(a => !a.startsWith('--')) || null,
    decisionMinute: get('--minute', DEFAULT_DECISION_MINUTE),
    cancelMinute: get('--cancel-minute', DEFAULT_CANCEL_MINUTE),
    contracts: get('--contracts', DEFAULT_CONTRACTS),
    minTrain: get('--min-train', DEFAULT_MIN_TRAIN),
    marginPp: get('--margin', DEFAULT_MARGIN_PP),
    minT: get('--min-t', DEFAULT_MIN_T),
    offsetCents: get('--offset', 0)
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.file) {
    process.stderr.write('usage: kalshi-passive-execution.js <paths.jsonl> [--offset 0]\n');
    process.exitCode = 2;
    return null;
  }
  const { rows, parsed, unusable } = await loadRows(path.resolve(options.file), options.decisionMinute);
  const result = study(rows, options);
  const summary = summarizeStudy(result);
  const report = {
    verdict: verdict(summary),
    input: { file: path.resolve(options.file), marketsParsed: parsed, unusable,
      observations: rows.length, settlementDays: result.days },
    options,
    execution: 'passive limit buy resting at the bid minus offset; filled only when a later ' +
      "minute's ask low trades down to the limit",
    summary,
    accountReady: false,
    trading: false,
    limitation: 'Minute-bar fills are a proxy for queue position, which this data cannot observe. A ' +
      'bar low touching the limit does not guarantee our specific order would have been filled.'
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_DECISION_MINUTE, DEFAULT_CANCEL_MINUTE, askLowAt, bidLowAt, passiveFill,
  terminalContext, loadRows, study, summarizeStudy, verdict, parseArgs, main
};
