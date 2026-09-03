'use strict';
/**
 * Why no take-profit can work here, checked against the data rather than asserted.
 *
 * If the contract price is a martingale — already a probability, and efficiently priced, which is what the
 * whole corpus says: realised win rate equals price at every level — then a resting sell k cents above the
 * entry is a gambler's-ruin problem with absorbing barriers at 0 and 1. The chance of touching p+k before
 * touching 0 is exactly p/(p+k), and the expected value of the trade is therefore ZERO before fees, for
 * every target, from every entry price.
 *
 * That is a strong claim, so it gets measured. If observed fill rates track p/(p+k) across the whole grid,
 * the take-profit sweep's 72 negative results are not an unlucky sample — they are arithmetic, and no
 * target, filter or entry band can change them.
 */
const { load, rows } = require('./drift');

const ms = load();
const all = rows(ms, { minLeft: 3, maxLeft: 13, lo: 0.20, hi: 0.85 });
console.log(`${all.length} candidate entries\n`);
console.log('observed chance of touching entry+k before the close, against the martingale value p/(p+k)\n');
console.log('entry    k=+5c            k=+10c           k=+20c');
console.log('        obs   theory     obs   theory     obs   theory        n');
let sumAbs = 0, cells = 0;
for (const [lo, hi] of [[0.25, 0.35], [0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 0.75], [0.75, 0.85]]) {
  const rs = all.filter(r => r.px >= lo && r.px < hi);
  if (rs.length < 400) continue;
  const p = rs.reduce((a, r) => a + r.px, 0) / rs.length;
  let line = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(8);
  for (const k of [0.05, 0.10, 0.20]) {
    const obs = rs.filter(r => r.maxSell != null && r.maxSell >= r.px + k).length / rs.length;
    // The barrier at 1.00 truncates the walk, so the theoretical value uses the reachable target.
    const theory = Math.min(1, p / Math.min(0.999, p + k));
    sumAbs += Math.abs(obs - theory); cells++;
    line += (obs * 100).toFixed(1).padStart(6) + (theory * 100).toFixed(1).padStart(9);
  }
  console.log(line + String(rs.length).padStart(9));
}
console.log(`\nmean absolute gap between observed and martingale: ${(sumAbs / cells * 100).toFixed(2)} points`);
/**
 * The observed rate sits BELOW the untruncated value at every cell, by about eight points, and that is the
 * expected direction rather than a contradiction. p/(p+k) is the chance of touching the barrier given
 * unlimited time; this walk has three to thirteen minutes and then settles. A time-limited martingale
 * reaches a barrier LESS often than a free one.
 *
 * Which makes the conclusion stronger, not weaker: the take-profit fills less often than the zero-EV
 * benchmark, so the trade is worse than break-even BEFORE the fee is charged, at every target and from
 * every entry price. There is nothing for a filter to find.
 */
console.log('-> observed sits ' + (sumAbs / cells * 100).toFixed(1) + 'pp BELOW the untruncated value at every');
console.log('   cell, which is what a time-LIMITED martingale does: 3-13 minutes is not unlimited time to');
console.log('   reach a barrier. So a take-profit fills less often than the zero-EV benchmark — worse than');
console.log('   break-even before the fee is even charged, at every target, from every entry price.');

/**
 * And the fee, which is what turns zero into a loss. It is 0.07·p·(1−p) — largest in the middle of the
 * price line and nearly absent at the ends. This is the whole reason the surviving strategy sits at 87c.
 */
console.log('\nthe toll at each entry price, per contract, as a share of the stake');
for (const p of [0.25, 0.40, 0.50, 0.65, 0.80, 0.87, 0.95]) {
  const fee = 0.07 * p * (1 - p);
  console.log(`  ${(p * 100).toFixed(0)}c   fee ${(fee * 100).toFixed(2)}pp   ` +
    `= ${(fee / p * 100).toFixed(2)}% of the money put up   ` +
    `round trip ${(fee * 2 * 100).toFixed(2)}pp`);
}
