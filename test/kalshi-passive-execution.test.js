'use strict';

/** Network-free regressions for the passive-execution / adverse-selection study. */
const assert = require('assert');
const {
  askLowAt, bidLowAt, passiveFill, terminalContext, study, summarizeStudy, verdict
} = require('../research/kalshi-passive-execution');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-6, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
};

// step = [minutesLeft, [askLow, askHigh, askClose], [bidLow, bidHigh, bidClose], volume]
const step = (minute, askLow, askClose, bidLow, bidClose) =>
  [minute, [askLow, askClose, askClose], [bidLow, bidClose, bidClose], 100];

// Quote accessors read the low of the correct side.
{
  const s = step(9, 0.80, 0.86, 0.78, 0.84);
  near(askLowAt(s), 0.80);
  near(bidLowAt(s), 0.78);
  ok(Number.isNaN(askLowAt(null)));
}

// A resting buy fills only when a LATER minute's ask low reaches the limit.
{
  const rows = [
    step(9, 0.86, 0.87, 0.84, 0.85),
    step(8, 0.86, 0.86, 0.85, 0.85),
    step(7, 0.84, 0.85, 0.83, 0.84),
    step(6, 0.88, 0.89, 0.87, 0.88)
  ];
  // Minute 8's ask low is 0.86 and never reaches an 0.85 limit; minute 7's low of 0.84 does.
  const fill = passiveFill(rows, 9, 2, 0.85);
  eq(fill.filledAtMinute, 7, 'the earliest later minute whose ask low reaches the limit fills');
  near(fill.askLow, 0.84);

  eq(passiveFill(rows, 9, 2, 0.83), null, 'a limit the ask never reaches does not fill');
  const tight = passiveFill(rows, 9, 7, 0.84);
  eq(tight.filledAtMinute, 7, 'a nearer cancel deadline still admits a qualifying in-window fill');
  eq(passiveFill(rows, 8, 8, 0.84), null,
    'a window containing no minute strictly before the decision cannot fill');
}

// The decision bar itself can never fill the order — that would be within-bar lookahead.
{
  const rows = [step(9, 0.10, 0.86, 0.09, 0.85), step(8, 0.90, 0.91, 0.89, 0.90)];
  eq(passiveFill(rows, 9, 2, 0.85), null,
    'the decision minute low is ignored even when it plunges through the limit');
}

// Terminal context reads the last in-window bar.
{
  const rows = [step(9, 0.86, 0.87, 0.84, 0.85), step(2, 0.50, 0.52, 0.48, 0.50)];
  near(terminalContext(rows, 2).lastBidLow, 0.48);
  eq(terminalContext([], 2).lastBidLow, null);
}

/**
 * End-to-end adverse-selection check on a constructed corpus.
 * Day 1 trains an obvious YES bias on 80c favourites. Day 2 has two market types with IDENTICAL
 * decision quotes: ones that dip (so a resting bid fills) and then LOSE, and ones that never dip
 * (never fill) and WIN. A correct study must fill only the losers and report negative selection.
 */
{
  const DAY = 86400000;
  const market = (day, index, { y, dips }) => ({
    t: `T${day}-${index}`, s: 'BTC', c: day * DAY, r: y,
    p: [
      step(9, 0.86, 0.86, 0.84, 0.84),
      dips ? step(8, 0.84, 0.85, 0.83, 0.84) : step(8, 0.87, 0.88, 0.86, 0.87),
      step(2, 0.90, 0.91, 0.89, 0.90)
    ]
  });
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(market(1, i, { y: 1, dips: false }));
  for (let i = 0; i < 50; i++) rows.push(market(2, `dip${i}`, { y: 0, dips: true }));
  for (let i = 0; i < 50; i++) rows.push(market(2, `no${i}`, { y: 1, dips: false }));

  const { observationFrom } = require('../research/kalshi-calibration-walkforward');
  const observations = rows.map(raw => {
    const observation = observationFrom(raw, 9);
    if (observation) observation.path = raw.p;
    return observation;
  }).filter(Boolean);
  eq(observations.length, 500, 'every constructed market yields a decision observation');

  const result = study(observations, {
    decisionMinute: 9, cancelMinute: 2, contracts: 30, minTrain: 100, marginPp: 0.5, minT: 0
  });
  eq(result.signalled.length, 100, 'only day 2 is traded; day 1 is training');
  eq(result.fills.length, 50, 'only the markets whose ask dipped to the bid are filled');
  ok(result.fills.every(fill => fill.won === false),
    'the dipping markets are exactly the losers, so every fill is a loss');

  const summary = summarizeStudy(result);
  near(summary.unconditionalWinRate, 0.5, 1e-9, 'half of the signalled day-2 markets win');
  near(summary.filledWinRate, 0, 1e-9, 'none of the FILLED orders win');
  near(summary.adverseSelectionPp, -50, 1e-6,
    'filled minus unconditional win rate is the adverse-selection measure');
  near(summary.fillRate, 0.5, 1e-9);
  ok(summary.netPerContract < 0, 'a fully adversely-selected fill set must lose money');
  eq(verdict(summary), 'negative');
}

// A signal set that never fills reports no fills rather than a fabricated zero-cost win.
{
  const DAY = 86400000;
  const rows = [];
  const mk = (day, i, y) => ({
    t: `N${day}-${i}`, s: 'BTC', c: day * DAY, r: y,
    p: [step(9, 0.86, 0.86, 0.84, 0.84), step(8, 0.95, 0.96, 0.94, 0.95)]
  });
  for (let i = 0; i < 400; i++) rows.push(mk(1, i, 1));
  for (let i = 0; i < 20; i++) rows.push(mk(2, i, 1));
  const { observationFrom } = require('../research/kalshi-calibration-walkforward');
  const observations = rows.map(raw => {
    const observation = observationFrom(raw, 9);
    if (observation) observation.path = raw.p;
    return observation;
  }).filter(Boolean);
  const result = study(observations, { minTrain: 100, marginPp: 0.5, minT: 0, cancelMinute: 2 });
  ok(result.signalled.length > 0, 'markets were signalled');
  eq(result.fills.length, 0, 'a market whose ask only rises never fills a resting bid');
  const summary = summarizeStudy(result);
  eq(summary.roi, null, 'no fills means no return, not a zero return');
  eq(verdict(summary), 'no_fills');
}

console.log(`PASS Kalshi passive execution — ${checks} checks`);
