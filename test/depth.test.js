/**
 * The depth logger: the last untested hypothesis, so its bookkeeping has to be right before weeks of
 * sample accumulate on top of it.
 *
 * Three things this pins, each of which would silently ruin the experiment:
 *   - the NO-bid convention (a NO bid at p is a YES ask at 1-p; inverting it flips every imbalance sign)
 *   - the agreement sign (for a NO entry, depth AGREEING means a negative raw imbalance — and 78% of
 *     this bot's entries are NO, so getting it backwards would mislabel almost the whole sample)
 *   - margin over break-even rather than raw win rate, which is the mistake that made a 68% headline
 *     look like a strategy
 */
const assert = require('assert');
const depth = require('../src/depth');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

// ── summarize: the real payload shape, verified against a live market ──
const book = (yes, no) => ({ orderbook_fp: { yes_dollars: yes, no_dollars: no } });
{
  // Live market quoted yes_ask 0.67 / yes_bid 0.66; these are the ladders it returned.
  const s = depth.summarize(book(
    [['0.5900', '1215.79'], ['0.6300', '7394.00'], ['0.6600', '752.02']],
    [['0.2600', '1894.00'], ['0.3000', '2445.00'], ['0.3300', '5044.95']]
  ));
  eq(s.yesBid, 0.66, 'best YES bid is the top of the yes ladder');
  eq(s.yesAsk, 0.67, 'the YES ask is 1 minus the best NO bid, never anything in the yes ladder');
  eq(s.spread, 0.01);
  eq(s.touchYes, 752.02);
  eq(s.touchNo, 5044.95);
  ok(s.touchImbalance < 0, 'more size behind NO at the touch must read negative');
  eq(s.levels, 3);
}

// A crossed or absurd book is a bad read, not a signal.
eq(depth.summarize(book([['0.9000', '10']], [['0.9000', '10']])), null, 'a crossed book must be dropped');
eq(depth.summarize(book([], [['0.3', '5']])), null, 'an empty side is not a book');
for (const bad of [null, undefined, {}, { orderbook_fp: {} }, { orderbook_fp: { yes_dollars: 'x' } }]) {
  eq(depth.summarize(bad), null, `malformed payload must yield null, not a fiction: ${JSON.stringify(bad)}`);
}
// Sizes that cannot be parsed must not become zero-size levels that survive the filter.
eq(depth.summarize(book([['0.60', 'abc']], [['0.30', '5']])), null, 'unparseable sizes drop the level');

// ── the agreement sign, on both sides ──
const row = over => Object.assign({
  ticker: 'T1', sym: 'BTC', side: 'NO', pricePct: 60, imbalance: -0.6, touchImbalance: -0.6,
  outcome: 'WIN', won: true
}, over);
{
  // A NO entry with size resting behind NO is depth AGREEING. It must land in a positive band.
  depth._reset([
    ...Array.from({ length: 40 }, (_, i) => row({ ticker: `n${i}`, side: 'NO', imbalance: -0.6, won: true, outcome: 'WIN' })),
    ...Array.from({ length: 40 }, (_, i) => row({ ticker: `y${i}`, side: 'YES', imbalance: +0.6, won: false, outcome: 'LOSS' }))
  ]);
  const r = depth.report();
  const strongAgree = r.byDepthAgreement.find(b => /40% and up/.test(b.band));
  eq(strongAgree.taken, 80, 'both a NO entry at -0.6 and a YES entry at +0.6 are strong agreement');
  eq(strongAgree.wins, 40);
  ok(strongAgree.estimable, '80 rows is above the minimum sample');
}

// ── margin, not raw rate ──
{
  // 60% wins at 60c is a LOSS once the fee is counted, and the report has to say so.
  depth._reset(Array.from({ length: 50 }, (_, i) =>
    row({ ticker: `m${i}`, pricePct: 60, won: i < 30, outcome: i < 30 ? 'WIN' : 'LOSS' })));
  const o = depth.report().overall;
  eq(o.rate, 0.6);
  ok(o.needRate > 0.6, `60c must demand more than 60%, got ${o.needRate}`);
  ok(o.margin < 0, 'a 60% rate at 60c must report a negative margin');
}

// ── a thin bucket must announce itself rather than print a rate ──
{
  depth._reset([row({ ticker: 'a' }), row({ ticker: 'b' })]);
  const r = depth.report();
  eq(r.ready, false, 'two rows is not a measurement');
  eq(r.graded, 2);
  ok(r.byDepthAgreement.every(b => !b.estimable), 'no band may claim to be estimable here');
  ok(/margin/.test(r.caution) && /estimable/.test(r.caution));
}

// ── ungraded rows never count, and settle uses the caller's grader ──
{
  depth._reset([{ ticker: 'T9', sym: 'BTC', side: 'NO', pricePct: 55, imbalance: -0.2, outcome: null, won: null }]);
  eq(depth.report().graded, 0, 'an unsettled row is not evidence');
  eq(depth.pending().length, 1);
  const graded = depth.settle('T9', 'no', (side, res) => (side === 'YES') === (res === 'yes'));
  eq(graded.won, true, 'a NO entry on a NO settlement is a win');
  eq(graded.outcome, 'WIN');
  eq(depth.report().graded, 1);
  eq(depth.settle('T9', 'no', () => true), null, 'an already-graded row is not re-settled');
  eq(depth.settle('nope', 'yes', () => true), null, 'an unknown ticker settles nothing');
  eq(depth.settle('T9', 'pending', () => true), null, 'an unresolved result leaves the row open');
}

// ── observe must never throw and never block, even with no state or a junk input ──
{
  depth._reset([]);
  eq(depth.observe(null), false, 'a missing decision is refused, not thrown on');
  eq(depth.observe({}), false, 'a decision with no ticker is refused');
  ok(depth.MAX_INFLIGHT > 0 && depth.MIN_SAMPLE >= 30, 'the guards exist and the sample floor is meaningful');
}

console.log(`PASS depth — ${checks} checks (NO-bid convention, agreement sign, margin over break-even)`);
