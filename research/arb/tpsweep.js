'use strict';
/**
 * The day-trader trade, priced exactly: buy at the ask, rest a sell k cents up, hold what never fills.
 *
 * The drift test came back empty — holding the price fixed, the last two minutes of slope changed neither
 * the settlement rate nor the chance of the price running up. So the trajectory is not the signal. But the
 * REACH numbers underneath it are striking on their own: at 25-40c, 65% of entries later offered entry+10c
 * while only 28% went on to settle YES. That gap is a real population — prices that run up and then fail —
 * and a resting take-profit is what converts it into cash.
 *
 * Whether it converts into ENOUGH cash is arithmetic, and this is the arithmetic. Every (entry band,
 * target) pair, graded exactly:
 *
 *   fills at the target when any later minute's bid reached it — a resting limit sell needs nothing more
 *   otherwise held to settlement, paying 1.00 or 0
 *   taker fee charged BOTH ways, which overstates the cost of a resting exit and so understates the result
 *
 * One entry per market, so a market whose price crosses a band repeatedly counts once.
 */
const { load, rows } = require('./drift');
const { takerFee } = require('./kx');

const ms = load();
const SIZE = 100;

/** First qualifying minute per market, scanning from the open — no hindsight about which minute was best. */
function firstPer(rs) {
  const seen = new Set(), out = [];
  for (const r of rs.slice().sort((a, b) => (a.close - b.close) || (b.left - a.left))) {
    const k = r.close + '|' + r.sym;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out;
}

function run(rs, target) {
  const ts = [];
  for (const r of rs) {
    const tgt = target == null ? null : Math.min(0.99, +(r.px + target).toFixed(4));
    const hit = tgt != null && r.maxSell != null && r.maxSell >= tgt;
    const cost = SIZE * r.px + takerFee(SIZE, r.px);
    const gross = hit ? SIZE * tgt : (r.won ? SIZE : 0);
    const exitFee = hit ? takerFee(SIZE, tgt) : 0;
    ts.push({ pnl: gross - exitFee - cost, cost, hit, won: r.won, px: r.px, close: r.close, sym: r.sym });
  }
  const n = ts.length;
  if (!n) return null;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const k = Math.floor(n / 2);
  const roiOf = s => s.reduce((a, t) => a + t.pnl, 0) / s.reduce((a, t) => a + t.cost, 0) * 100;
  let eq = 0, peak = 0, dd = 0;
  for (const t of ts) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return { n, roi: pnl / staked * 100, pnl, hitPct: ts.filter(t => t.hit).length / n * 100,
           h1: roiOf(ts.slice(0, k)), h2: roiOf(ts.slice(k)), dd };
}

const BANDS = [[0.25, 0.40], [0.25, 0.55], [0.30, 0.50], [0.40, 0.55], [0.40, 0.70],
               [0.55, 0.70], [0.55, 0.80], [0.70, 0.80], [0.25, 0.80]];
const TARGETS = [null, 0.03, 0.05, 0.08, 0.10, 0.15, 0.20, 0.30];

console.log('one entry per market, T-13..T-3, taker fee both ways, 100 contracts\n');
console.log('band      target      n    fill%     ROI%      h1      h2    worse    PnL$');
const best = [];
for (const [lo, hi] of BANDS) {
  const rs = firstPer(rows(ms, { minLeft: 3, maxLeft: 13, lo, hi }));
  for (const t of TARGETS) {
    const r = run(rs, t);
    if (!r || r.n < 300) continue;
    const worse = Math.min(r.h1, r.h2);
    best.push({ lo, hi, t, r, worse });
    console.log(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(10) +
      (t == null ? 'hold' : '+' + (t * 100).toFixed(0) + 'c').padEnd(9) +
      String(r.n).padStart(6) + (t == null ? '     —' : r.hitPct.toFixed(1).padStart(6)) +
      r.roi.toFixed(2).padStart(9) + r.h1.toFixed(2).padStart(8) + r.h2.toFixed(2).padStart(8) +
      worse.toFixed(2).padStart(9) + r.pnl.toFixed(0).padStart(8));
  }
  console.log('');
}
const top = best.filter(b => b.worse > 0).sort((a, b) => b.worse - a.worse);
console.log(top.length
  ? 'positive in BOTH halves:\n' + top.slice(0, 8).map(b =>
      `  ${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}c ${b.t == null ? 'hold' : '+' + (b.t * 100).toFixed(0) + 'c'}` +
      `  ROI ${b.r.roi.toFixed(2)}%  halves ${b.r.h1.toFixed(2)}/${b.r.h2.toFixed(2)}  n=${b.r.n}`).join('\n')
  : 'NOTHING is positive in both chronological halves.');
