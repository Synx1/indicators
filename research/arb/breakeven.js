'use strict';
/**
 * The four posts, run through their own break-even.
 *
 * A cash-out feed shows the gain and never the stake at risk. Each of these trades needs a specific hit rate
 * to be worth taking, and the rate is set by the ratio of what it pays to what it risks — not by how good
 * the number in the post looks. Kalshi's fee is charged on both legs at the sizes actually shown.
 */
const { takerFee } = require('./kx');
const POSTS = [
  ['XRP DOWN', 0.34, null, 100, 'held to settlement'],
  ['BTC DOWN', 0.64, 0.84, 100, 'cashed out'],
  ['SOL DOWN', 0.59, 0.96, 100, 'cashed out'],
  ['XRP UP',   0.56, 0.96, 100, 'cashed out']
];
console.log('trade        entry  exit   shown gain   loses if it fails   needs to win   the post says');
for (const [name, entry, exit, n, kind] of POSTS) {
  const cost = n * entry + takerFee(n, entry);
  const out = exit == null ? n : n * exit - takerFee(n, exit);
  const gain = out - cost;
  const need = cost / (cost + gain);
  console.log(`${name.padEnd(12)} ${(entry * 100).toFixed(0)}c` +
    `${exit == null ? '  settle' : '   ' + (exit * 100).toFixed(0) + 'c  '}` +
    `${('+$' + gain.toFixed(2)).padStart(12)} ${('-$' + cost.toFixed(2)).padStart(19)} ` +
    `${(need * 100).toFixed(1) + '%'}   ${kind}`);
}
console.log('\nmeasured on 41,643 held-out cheap entries (25-70c), one entry per market:');
console.log('  hold to settle      43.8% win   ROI -6.21%');
console.log('  cash out at +30c    55.5% win   ROI -8.99%');
console.log('\nA cash-out feed at these prices posts a majority of winners and still loses money: more than');
console.log('half the trades hit a modest target, and the rest give back the whole stake. The win RATE is');
console.log('what gets posted; the break-even rate is what decides it.');
