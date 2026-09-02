'use strict';
/**
 * The candidate the surface points at: contracts priced 85-93¢.
 *
 * The calibration surface said one thing consistently. Below 75¢ every cell is negative — the crowd
 * overpays for the underdog. In 85-93¢, ten of thirteen time cells are positive by 2-3 points. That is
 * the favourite-longshot bias, the oldest and most replicated anomaly in betting markets, and it lands
 * on this exchange where Kalshi's fee is nearly absent: 0.07·p·(1−p) is 0.69 points at 89¢ against 1.75
 * at 50¢. The bias and the cheap fee are in the same place.
 *
 * ── what would make it fake, and is therefore checked ──
 *
 * A lopsided YES/NO split: buying the favourite is a bet on "up" if the favourite is usually YES.
 * An edge in one or two coins: a coin story.
 * An edge in one chronological stretch: the failure mode that has killed every earlier finding here.
 * A drawdown larger than the profit: unsurvivable regardless of expectancy, which at 89¢ is the live
 * risk since one loss undoes eight wins.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');
const SIZE = 100, A_CL = 2;

function load() {
  const out = [];
  for (const line of fs.readFileSync(path.join(__dirname, 'paths.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
    r.p.sort((a, b) => b[0] - a[0]);
    out.push(r);
  }
  return out.sort((a, b) => a.c - b.c);
}
function asks(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
  const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
  if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  return { yes: a, no: +(1 - b).toFixed(4) };
}
/** First qualifying minute, scanning from the open toward the close. No hindsight. */
function entry(m, lo, hi, minLeft, maxLeft) {
  for (const row of m.p) {
    const left = row[0];
    if (left > maxLeft) continue;
    if (left < minLeft) break;
    const a = asks(row);
    if (!a) continue;
    if (a.yes >= lo && a.yes <= hi) return { side: 'YES', px: a.yes, left };
    if (a.no >= lo && a.no <= hi) return { side: 'NO', px: a.no, left };
  }
  return null;
}
function sim(ms, lo, hi, minLeft, maxLeft) {
  const ts = [];
  for (const m of ms) {
    const e = entry(m, lo, hi, minLeft, maxLeft);
    if (!e) continue;
    const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
    const cost = SIZE * e.px + takerFee(SIZE, e.px);
    ts.push({ sym: m.s, close: m.c, side: e.side, px: e.px, left: e.left, won, cost, pnl: (won ? SIZE : 0) - cost });
  }
  return ts;
}
function T(ts) {
  const n = ts.length; if (!n) return null;
  const wins = ts.filter(t => t.won).length, win = wins / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const be = px + 0.07 * px * (1 - px);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  let eq = 0, peak = 0, dd = 0, worst = 0, run = 0;
  for (const t of ts) {
    eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
    if (!t.won) { run++; if (run > worst) worst = run; } else run = 0;
  }
  return { n, win: +(win * 100).toFixed(1), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((win - be) * 100).toFixed(2), lo95: +((c - hw) * 100).toFixed(1), hi95: +((c + hw) * 100).toFixed(1),
           roi: +(pnl / staked * 100).toFixed(3), pnl: +pnl.toFixed(0), dd: +dd.toFixed(0), losses: worst,
           yes: ts.filter(t => t.side === 'YES').length, no: ts.filter(t => t.side === 'NO').length };
}
const ms = load();
console.log(`markets ${ms.length}  range ${new Date(ms[0].c).toISOString().slice(0,10)} .. ${new Date(ms[ms.length-1].c).toISOString().slice(0,10)}`);
console.log(`YES base rate ${(ms.filter(m => m.r === 1).length / ms.length * 100).toFixed(2)}%\n`);

console.log('band / window            n   price   win%  [95% CI]     b/e    edge   ROI%    PnL$   maxDD$ maxLoseRun YES/NO');
const CFG = [
  [0.85, 0.93, 3, 13], [0.85, 0.93, 5, 13], [0.85, 0.93, 3, 10], [0.85, 0.93, 6, 12],
  [0.85, 0.90, 3, 13], [0.88, 0.93, 3, 13], [0.85, 0.95, 3, 13], [0.83, 0.93, 3, 13],
  [0.90, 0.96, 3, 13], [0.93, 0.99, 3, 13], [0.75, 0.85, 6, 13], [0.85, 0.93, 2, 14],
];
const results = [];
for (const [lo, hi, a, b] of CFG) {
  const ts = sim(ms, lo, hi, a, b);
  const t = T(ts); if (!t || t.n < 60) continue;
  const k = Math.floor(ts.length / 2);
  const h1 = T(ts.slice(0, k)), h2 = T(ts.slice(k));
  results.push({ lo, hi, a, b, t, h1, h2, ts });
  console.log(`${lo.toFixed(2)}-${hi.toFixed(2)} T-${String(b).padStart(2)}..${String(a).padStart(2)} ${String(t.n).padStart(6)} ${String(t.px).padStart(7)} ${String(t.win).padStart(6)} [${String(t.lo95).padStart(4)},${String(t.hi95).padStart(4)}] ${String(t.be).padStart(6)} ${String(t.edge).padStart(7)} ${String(t.roi).padStart(7)} ${String(t.pnl).padStart(7)} ${String(t.dd).padStart(8)} ${String(t.losses).padStart(10)} ${t.yes}/${t.no}`);
}

const pick = results.find(r => r.lo === 0.85 && r.hi === 0.93 && r.a === 3 && r.b === 13);
if (pick) {
  console.log(`\n=== detail on 85-93c, T-13..T-3 (n=${pick.t.n}) ===`);
  console.log(`  half 1  ROI ${pick.h1.roi}%  edge ${pick.h1.edge}pp  win ${pick.h1.win}%  n=${pick.h1.n}`);
  console.log(`  half 2  ROI ${pick.h2.roi}%  edge ${pick.h2.edge}pp  win ${pick.h2.win}%  n=${pick.h2.n}`);
  const k = Math.floor(pick.ts.length / 3);
  ['first ', 'middle', 'last  '].forEach((nm, i) => {
    const t = T(pick.ts.slice(i * k, i === 2 ? undefined : (i + 1) * k));
    if (t) console.log(`  ${nm}  third  ROI ${String(t.roi).padStart(7)}%  edge ${String(t.edge).padStart(6)}pp  win ${t.win}%  n=${t.n}`);
  });
  console.log('  per coin:');
  for (const s of ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE']) {
    const t = T(pick.ts.filter(x => x.sym === s));
    if (t) console.log(`    ${s.padEnd(5)} n=${String(t.n).padStart(4)}  price ${t.px}  win ${String(t.win).padStart(5)}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%`);
  }
  console.log('  per side:');
  for (const s of ['YES', 'NO']) {
    const t = T(pick.ts.filter(x => x.side === s));
    if (t) console.log(`    ${s.padEnd(5)} n=${String(t.n).padStart(4)}  price ${t.px}  win ${String(t.win).padStart(5)}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%`);
  }
}
fs.writeFileSync(path.join(__dirname, 'fav2.json'), JSON.stringify({ at: Date.now(), markets: ms.length,
  results: results.map(r => ({ lo: r.lo, hi: r.hi, minLeft: r.a, maxLeft: r.b, all: r.t, h1: r.h1, h2: r.h2 })) }, null, 1));
console.log('\n-> fav2.json');
