'use strict';

/** Network-free regressions for the zero-money calibration paper shadow. */
const assert = require('assert');
const { FROZEN_CONFIG, CONTRACTS, bucketFor, Ledger } = require('../research/kalshi-calibration-paper-shadow');
const { feePerContract } = require('../research/realtime-microstructure-evaluate');

let checks = 0;
const ok = (value, message) => { checks++; assert.ok(value, message); };
const eq = (actual, expected, message) => { checks++; assert.deepStrictEqual(actual, expected, message); };
const near = (actual, expected, tolerance = 1e-6, message = 'values differ') => {
  checks++;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: got ${actual}, expected ${expected}`);
};

const meta = (ticker = 'KXBTC15M-T1') => ({
  ticker, sym: 'BTC', closeTime: '2026-09-04T00:00:00Z', strike: 80000
});
const book = (bid, ask) => ({ yesBid: bid, yesAsk: ask, mid: (bid + ask) / 2 });

// The frozen config must stay frozen: live results may never be fitted back into it.
{
  eq(FROZEN_CONFIG.buckets.length, 3, 'two UP buckets plus the marginal DOWN mirror');
  eq(FROZEN_CONFIG.buckets.map(b => b.label), ['75-90c', '90-95c', '10-25c-NO']);
  const up = FROZEN_CONFIG.buckets.filter(b => b.side === 'YES');
  const down = FROZEN_CONFIG.buckets.filter(b => b.side === 'NO');
  eq(up.length, 2);
  eq(down.length, 1, 'the DOWN mirror trade is included');
  ok(up.every(b => !b.marginal), 'the UP buckets clear the significance bar');
  ok(down.every(b => b.marginal), 'the DOWN bucket is explicitly flagged as marginal');
  ok(down[0].t < 2 && up.every(b => b.t > 2),
    'the flag matches the statistics: DOWN is below 2 sigma, UP is above');
  ok(Object.isFrozen(FROZEN_CONFIG) && Object.isFrozen(FROZEN_CONFIG.buckets),
    'the config object is frozen so a live loop cannot mutate it');
  eq(FROZEN_CONFIG.fittedOn.markets, 25159);
  ok(FROZEN_CONFIG.cancelSecondsLeft < FROZEN_CONFIG.decisionSecondsLeft,
    'the cancel deadline must come after the decision point');
}

// The spread gate is part of the config and must be an optimum, not an unbounded tightening.
{
  eq(FROZEN_CONFIG.maxSpreadCents, 1.05,
    'the 1c spread gate was validated out of sample; 0.6c failed');
  ok(FROZEN_CONFIG.maxSpreadCents > 0 && FROZEN_CONFIG.maxSpreadCents < 5);
}

// Only prices inside an active bucket produce a signal.
{
  eq(bucketFor(0.80).label, '75-90c');
  eq(bucketFor(0.92).label, '90-95c');
  eq(bucketFor(0.74), null, 'between the bands there is no supported edge');
  eq(bucketFor(0.15).side, 'NO', 'a 15c YES price means NO is the underpriced favourite');
  eq(bucketFor(0.15).label, '10-25c-NO');
  eq(bucketFor(0.09), null, 'the 5-10c mirror had no surplus over cost and stays out');
  eq(bucketFor(0.96), null, 'the >=95c bucket failed its own t-test and must stay inactive');
  eq(bucketFor(0.50), null, 'mid prices are where the cost bar is highest and are excluded');
}

// A DOWN position inverts the ladder: rest at the NO bid, take at the NO ask.
{
  const ledger = new Ledger();
  const downBucket = FROZEN_CONFIG.buckets.find(b => b.side === 'NO');
  // YES quoted 0.14/0.16 means NO is 0.84/0.86.
  ledger.open(meta('DOWN1'), { yesBid: 0.14, yesAsk: 0.16, mid: 0.15 }, downBucket, 540);
  const order = ledger.orders.get('DOWN1');
  eq(order.side, 'NO');
  eq(order.marginal, true);
  near(order.passive.limit, 0.84, 1e-9, 'the NO bid is 1 minus the YES ask');
  near(order.taker.fill, 0.86, 1e-9, 'the NO ask is 1 minus the YES bid');

  // The NO offer falls to 0.84 when the YES bid rises to 0.16.
  ledger.tryFill('DOWN1', { yesBid: 0.155, yesAsk: 0.17, mid: 0.1625 }, 500);
  eq(order.passive.filled, false, 'a NO ask of 0.845 does not reach an 0.84 limit');
  ledger.tryFill('DOWN1', { yesBid: 0.16, yesAsk: 0.18, mid: 0.17 }, 490);
  eq(order.passive.filled, true, 'a NO ask reaching 0.84 fills the resting NO bid');

  // A DOWN position wins when the market settles NO.
  ledger.settle('DOWN1', 'NO');
  eq(ledger.orders.get('DOWN1').won, true, 'buying NO wins on a NO settlement');
  ok(ledger.orders.get('DOWN1').passivePnl > 0);

  ledger.open(meta('DOWN2'), { yesBid: 0.14, yesAsk: 0.16, mid: 0.15 }, downBucket, 540);
  ledger.settle('DOWN2', 'YES');
  eq(ledger.orders.get('DOWN2').won, false, 'buying NO loses on a YES settlement');
}

// UP and DOWN are reported separately so a weak side cannot hide inside a strong one.
{
  const ledger = new Ledger();
  const upBucket = FROZEN_CONFIG.buckets[0];
  const downBucket = FROZEN_CONFIG.buckets.find(b => b.side === 'NO');
  ledger.open(meta('U1'), { yesBid: 0.84, yesAsk: 0.86, mid: 0.85 }, upBucket, 540);
  ledger.settle('U1', 'YES');
  ledger.open(meta('D1'), { yesBid: 0.14, yesAsk: 0.16, mid: 0.15 }, downBucket, 540);
  ledger.settle('D1', 'YES');
  const sides = ledger.summary().bySide;
  eq(sides.up.taker.n, 1);
  eq(sides.down.taker.n, 1);
  near(sides.up.taker.winRate, 1, 1e-9, 'the UP trade won');
  near(sides.down.taker.winRate, 0, 1e-9, 'the DOWN trade lost');
  ok(sides.up.taker.net > 0 && sides.down.taker.net < 0);
}

// A signal records BOTH entry styles, with the taker paying the ask and the passive resting at the bid.
{
  const ledger = new Ledger();
  ledger.open(meta(), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  const order = ledger.orders.get('KXBTC15M-T1');
  eq(order.passive.limit, 0.84, 'the resting order joins the bid');
  eq(order.taker.fill, 0.86, 'the taker pays the ask');
  eq(order.taker.filled, true, 'a taker order always fills');
  eq(order.passive.filled, false, 'a resting order is not filled at signal time');
  near(order.spreadCents, 2);
  // The ledger stores fees rounded to six decimals, so compare at that precision.
  near(order.passive.fee, feePerContract(0.84, CONTRACTS), 1e-6, 'production fee on the limit price');
  near(order.taker.fee, feePerContract(0.86, CONTRACTS), 1e-6, 'production fee on the ask');
  eq(ledger.counters.signals, 1);
  eq(ledger.counters.takerFilled, 1);
  eq(ledger.has('KXBTC15M-T1'), true, 'a ticker with a signal is not re-signalled');
}

// The resting order fills only when the ask actually trades down to the limit.
{
  const ledger = new Ledger();
  ledger.open(meta(), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  ledger.tryFill('KXBTC15M-T1', book(0.84, 0.85), 500);
  eq(ledger.orders.get('KXBTC15M-T1').passive.filled, false,
    'an ask above the limit does not fill the resting order');
  ledger.tryFill('KXBTC15M-T1', book(0.83, 0.84), 480);
  const order = ledger.orders.get('KXBTC15M-T1');
  eq(order.passive.filled, true, 'an ask reaching the limit fills it');
  eq(order.passive.filledSecondsLeft, 480);
  eq(ledger.counters.passiveFilled, 1);
  ledger.tryFill('KXBTC15M-T1', book(0.80, 0.81), 470);
  eq(ledger.counters.passiveFilled, 1, 'a filled order is never filled twice');
}

// Past the cancel deadline the resting order expires instead of filling.
{
  const ledger = new Ledger();
  ledger.open(meta(), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  ledger.tryFill('KXBTC15M-T1', book(0.70, 0.72), 300);
  const order = ledger.orders.get('KXBTC15M-T1');
  eq(order.passive.filled, false, 'a late crossing must not fill a cancelled order');
  eq(order.passive.expired, true);
  eq(ledger.counters.passiveExpired, 1);
  ledger.tryFill('KXBTC15M-T1', book(0.70, 0.72), 290);
  eq(ledger.counters.passiveExpired, 1, 'expiry is counted once');
}

// Settlement pays exactly $1 on a win and zero on a loss, charging the fee either way.
{
  const ledger = new Ledger();
  ledger.open(meta('WIN'), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  ledger.tryFill('WIN', book(0.83, 0.84), 480);
  ledger.settle('WIN', 'YES');
  const win = ledger.orders.get('WIN');
  eq(win.won, true);
  near(win.passivePnl, 1 - 0.84 - feePerContract(0.84, CONTRACTS), 1e-6);
  near(win.takerPnl, 1 - 0.86 - feePerContract(0.86, CONTRACTS), 1e-6);
  ok(win.passivePnl > win.takerPnl, 'when both fill, the cheaper entry wins by the half-spread');

  ledger.open(meta('LOSE'), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  ledger.settle('LOSE', 'NO');
  const lose = ledger.orders.get('LOSE');
  eq(lose.won, false);
  eq(lose.passivePnl, null, 'an unfilled passive order has no P&L, not a zero P&L');
  near(lose.takerPnl, -(0.86 + feePerContract(0.86, CONTRACTS)), 1e-6);
  eq(ledger.counters.settled, 2);
}

// The summary measures adverse selection: passive fills versus every signalled market.
{
  const ledger = new Ledger();
  // Two markets whose ask dips (so the resting bid fills) and which then LOSE.
  for (const id of ['dipA', 'dipB']) {
    ledger.open(meta(id), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
    ledger.tryFill(id, book(0.83, 0.84), 480);
    ledger.settle(id, 'NO');
  }
  // Two markets whose ask never dips (never fill) and which WIN.
  for (const id of ['upA', 'upB']) {
    ledger.open(meta(id), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
    ledger.tryFill(id, book(0.88, 0.90), 480);
    ledger.settle(id, 'YES');
  }
  const summary = ledger.summary();
  eq(summary.settledSignals, 4);
  eq(summary.passive.n, 2, 'only the dipping markets filled passively');
  near(summary.passive.winRate, 0, 1e-9, 'every passive fill lost');
  near(summary.taker.winRate, 0.5, 1e-9, 'the taker traded all four and won half');
  near(summary.passiveFillRate, 0.5, 1e-9);
  near(summary.adverseSelectionPp, -50, 1e-6,
    'passive fills concentrated entirely in the losers is a 50pp adverse-selection reading');
  ok(summary.passive.net < 0 && summary.taker.net < 0);
  eq(summary.openOrders, 0);
}

// An empty ledger reports nothing rather than a fabricated result.
{
  const summary = new Ledger().summary();
  eq(summary.settledSignals, 0);
  eq(summary.passive.roi, null);
  eq(summary.taker.roi, null);
  eq(summary.adverseSelectionPp, null);
}

// The grace ladder simulates a real limit order: the buy FAILS when price runs past the allowance.
{
  eq(FROZEN_CONFIG.graceCents.length, 3, 'three allowances are measured on one observation');
  eq([...FROZEN_CONFIG.graceCents], [0, 1, 2]);

  const ledger = new Ledger();
  ledger.open(meta('G1'), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  const order = ledger.orders.get('G1');
  eq(order.grace.map(a => a.limit), [0.86, 0.87, 0.88], 'each limit is the ask plus its allowance');
  ok(order.grace.every(a => !a.resolved));

  // One poll later the ask has run to 0.87: the 0c order fails, 1c and 2c fill AT the prevailing ask.
  const signalMs = Date.parse(order.signalAt);
  ledger.resolveGrace('G1', book(0.865, 0.87), signalMs + 1000);
  const [g0, g1, g2] = order.grace;
  ok(g0.resolved && g1.resolved && g2.resolved, 'every allowance resolves on the same observation');
  eq(g0.filled, false, 'an ask of 0.87 runs past a 0.86 limit, so the buy fails');
  eq(g1.filled, true);
  eq(g2.filled, true);
  near(g1.fill, 0.87, 1e-9, 'you pay the prevailing ask, not your limit, when it is inside');
  near(g2.fill, 0.87, 1e-9, 'a wider allowance does not make you overpay');
  near(g1.moveCents, 1, 1e-9, 'the recorded move is the ask change since the signal');
  eq(g1.latencyMs, 1000);
  eq(ledger.counters.graceFilled, 2);
  eq(ledger.counters.graceFailed, 1);

  // Re-observing must not re-resolve or double count.
  ledger.resolveGrace('G1', book(0.60, 0.61), signalMs + 2000);
  eq(ledger.counters.graceFilled, 2, 'a resolved attempt is never revisited');
  eq(g0.filled, false, 'a later cheap ask cannot rescue an already-failed order');

  // Settlement pays only the attempts that actually filled.
  ledger.settle('G1', 'YES');
  eq(g0.pnl, null, 'a failed buy has no P&L');
  near(g1.pnl, 1 - 0.87 - g1.fee, 1e-6);
  const byGrace = ledger.summary().byGrace;
  eq(byGrace.length, 3);
  eq(byGrace[0].fillRate, 0, 'the 0c allowance filled nothing in this sample');
  eq(byGrace[1].fillRate, 1);
  near(byGrace[1].meanMoveCents, 1, 1e-6);
}

// A favourable move fills every allowance at the better price.
{
  const ledger = new Ledger();
  ledger.open(meta('G2'), book(0.84, 0.86), FROZEN_CONFIG.buckets[0], 540);
  const order = ledger.orders.get('G2');
  ledger.resolveGrace('G2', book(0.83, 0.845), Date.parse(order.signalAt) + 800);
  ok(order.grace.every(a => a.filled), 'an ask that improves fills every allowance');
  ok(order.grace.every(a => Math.abs(a.fill - 0.845) < 1e-9),
    'all allowances pay the same improved ask');
  ok(order.grace.every(a => a.moveCents < 0), 'a negative move means the offer came down');
}

console.log(`PASS Kalshi calibration paper shadow — ${checks} checks`);
