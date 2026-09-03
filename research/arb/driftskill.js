'use strict';
/**
 * Does the drift term carry information the price does not already have?
 *
 * This is the null every previous feature set failed against: "the price now" is already an excellent
 * forecast, and twelve engineered features, order flow, book microstructure and two model classes all
 * failed to beat it. So the drift is not asked whether it predicts — almost anything correlated with the
 * price predicts. It is asked whether, HOLDING THE PRICE FIXED, knowing the last two minutes of slope
 * changes what happens next.
 *
 * Two outcomes are graded because they are different trades:
 *   SETTLEMENT — did it win, against the price paid plus the fee. The bettor's question.
 *   REACH      — did the price ever offer a profitable exit before close. The day-trader's question, and
 *                the one a drift signal ought to speak to if it speaks to anything.
 */
const { load, rows } = require('./drift');
const { takerFee } = require('./kx');

const ms = load();
const all = rows(ms, { minLeft: 3, maxLeft: 13, lo: 0.25, hi: 0.80 });
console.log(`markets ${ms.length}   candidate entries ${all.length}`);
console.log(`side split YES ${all.filter(r => r.side === 'YES').length} / NO ${all.filter(r => r.side === 'NO').length}\n`);

/** Buckets that hold the PRICE roughly fixed, so the drift is the only thing varying inside one. */
const PX = [[0.25, 0.40], [0.40, 0.55], [0.55, 0.70], [0.70, 0.80]];
const DR = [[-9, -0.03], [-0.03, -0.01], [-0.01, 0.01], [0.01, 0.03], [0.03, 9]];
const drName = d => (d[0] === -9 ? 'falling hard' : d[1] === 9 ? 'rising hard'
  : d[0] === -0.03 ? 'falling' : d[1] === 0.03 ? 'rising' : 'flat');

function tally(rs) {
  const n = rs.length;
  if (!n) return null;
  const px = rs.reduce((a, r) => a + r.px, 0) / n;
  const win = rs.filter(r => r.won).length / n;
  const be = px + 0.07 * px * (1 - px);
  // Did the price ever offer 5c / 10c above the entry, before the close?
  const r5 = rs.filter(r => r.maxSell != null && r.maxSell >= r.px + 0.05).length / n;
  const r10 = rs.filter(r => r.maxSell != null && r.maxSell >= r.px + 0.10).length / n;
  return { n, px, win, be, edge: win - be, r5, r10 };
}

console.log('SETTLEMENT edge (win% minus price+fee), by price and by drift');
console.log('price band     ' + DR.map(d => drName(d).padStart(13)).join(''));
for (const [lo, hi] of PX) {
  let line = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(15);
  for (const d of DR) {
    const t = tally(all.filter(r => r.px >= lo && r.px < hi && r.d1 >= d[0] && r.d1 < d[1]));
    line += (t && t.n >= 200 ? (t.edge * 100).toFixed(2) + 'pp' : '.').padStart(13);
  }
  console.log(line);
}

console.log('\nREACH: share that ever offered entry +10c before the close');
console.log('price band     ' + DR.map(d => drName(d).padStart(13)).join(''));
for (const [lo, hi] of PX) {
  let line = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(15);
  for (const d of DR) {
    const t = tally(all.filter(r => r.px >= lo && r.px < hi && r.d1 >= d[0] && r.d1 < d[1]));
    line += (t && t.n >= 200 ? (t.r10 * 100).toFixed(1) + '%' : '.').padStart(13);
  }
  console.log(line);
}

console.log('\nsample sizes');
console.log('price band     ' + DR.map(d => drName(d).padStart(13)).join(''));
for (const [lo, hi] of PX) {
  let line = `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(15);
  for (const d of DR) {
    const t = tally(all.filter(r => r.px >= lo && r.px < hi && r.d1 >= d[0] && r.d1 < d[1]));
    line += String(t ? t.n : 0).padStart(13);
  }
  console.log(line);
}

/**
 * The Euler forecast against the flat one, scored as a probability forecast.
 *
 * Brier skill against "the price is the probability". Positive means the extrapolation knows something the
 * price does not; zero or negative means the drift is already in the price, which is what an efficient
 * market implies and what every earlier feature set found.
 */
function brier(pred, rs) { return rs.reduce((a, r) => a + Math.pow(pred(r) - (r.won ? 1 : 0), 2), 0) / rs.length; }
const usable = all.filter(r => r.accel != null);
const bFlat = brier(r => r.mid, usable);
const bProj = brier(r => r.proj, usable);
const bHalf = brier(r => Math.max(0.01, Math.min(0.99, r.mid + r.d1 * r.left * 0.5)), usable);
console.log(`\nBrier, ${usable.length} rows`);
console.log(`  price as the forecast          ${bFlat.toFixed(6)}`);
console.log(`  one full Euler step to close   ${bProj.toFixed(6)}   skill ${((1 - bProj / bFlat) * 100).toFixed(2)}%`);
console.log(`  half an Euler step             ${bHalf.toFixed(6)}   skill ${((1 - bHalf / bFlat) * 100).toFixed(2)}%`);
console.log(bProj < bFlat || bHalf < bFlat
  ? '  -> the extrapolation beats the price on at least one setting'
  : '  -> the price already contains the drift; extrapolating it makes the forecast WORSE');
