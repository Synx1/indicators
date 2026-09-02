'use strict';
/**
 * The one configuration that survived being chosen blind: buy the favourite at 85-90¢, in the middle of
 * the market's life, and hold it to settlement.
 *
 * Both chronological halves of the corpus independently pick this same band out of 27 bands × 4 time
 * windows, and the band chosen on the FIRST half earns +1.78 points on the second half, which it has
 * never seen. That is the test every earlier finding in this project failed.
 *
 * What follows is every way it could still be an artefact, checked one at a time.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');
const A_CL = 2;
const LO = 0.85, HI = 0.90, MIN_LEFT = 6, MAX_LEFT = 12;

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
  return { yes: a, no: +(1 - b).toFixed(4), spread: +(a - b).toFixed(4) };
}
function entry(m) {
  for (const row of m.p) {
    const left = row[0];
    if (left > MAX_LEFT) continue;
    if (left < MIN_LEFT) break;
    const a = asks(row);
    if (!a) continue;
    if (a.yes >= LO && a.yes <= HI) return { side: 'YES', px: a.yes, left, spread: a.spread };
    if (a.no >= LO && a.no <= HI) return { side: 'NO', px: a.no, left, spread: a.spread };
  }
  return null;
}
function T(ts) {
  const n = ts.length; if (!n) return null;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const be = px + 0.07 * px * (1 - px);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  let eq = 0, peak = 0, dd = 0, run = 0, worst = 0;
  for (const t of ts) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
    if (!t.won) { run++; if (run > worst) worst = run; } else run = 0; }
  return { n, win: +(win * 100).toFixed(2), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((win - be) * 100).toFixed(2), lo95: +((c - hw) * 100).toFixed(2), hi95: +((c + hw) * 100).toFixed(2),
           roi: +(pnl / staked * 100).toFixed(3), pnl: +pnl.toFixed(0), dd: +dd.toFixed(0), run: worst };
}
const ms = load();
const ts = [];
for (const m of ms) {
  const e = entry(m);
  if (!e) continue;
  const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
  const cost = 100 * e.px + takerFee(100, e.px);
  ts.push({ sym: m.s, close: m.c, side: e.side, px: e.px, left: e.left, spread: e.spread, won, cost, pnl: (won ? 100 : 0) - cost });
}
const all = T(ts);
console.log(`=== buy 85-90c, T-12..T-6, hold to settle ===`);
console.log(`markets scanned ${ms.length}, signals ${all.n} (${(all.n / ms.length * 100).toFixed(0)}% of markets)`);
console.log(`price ${all.px}c   win ${all.win}% [${all.lo95}, ${all.hi95}]   break-even ${all.be}%   EDGE ${all.edge}pp   ROI ${all.roi}%`);
console.log(`the interval clears break-even: ${all.lo95 > all.be ? 'YES' : 'no — needs more sample'}`);
console.log(`worst losing streak ${all.run}   max drawdown $${all.dd} against $${all.pnl} profit at 100 contracts`);
console.log(`median spread at entry ${(ts.map(t => t.spread).sort((a, b) => a - b)[Math.floor(ts.length / 2)] * 100).toFixed(1)}c`);

console.log('\nchronological quarters (the check that has failed every previous finding):');
const q = Math.floor(ts.length / 4);
for (let i = 0; i < 4; i++) {
  const t = T(ts.slice(i * q, i === 3 ? undefined : (i + 1) * q));
  const d0 = new Date(ts[i * q].close).toISOString().slice(5, 10);
  console.log(`  Q${i + 1} ${d0}  n=${String(t.n).padStart(4)}  win ${String(t.win).padStart(5)}%  b/e ${t.be}  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%`);
}
console.log('\nper coin:');
for (const s of ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE']) {
  const t = T(ts.filter(x => x.sym === s));
  if (t) console.log(`  ${s.padEnd(5)} n=${String(t.n).padStart(4)}  win ${String(t.win).padStart(5)}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%`);
}
console.log('\nper side (an edge on one side only is a bet on direction):');
for (const s of ['YES', 'NO']) {
  const t = T(ts.filter(x => x.side === s));
  if (t) console.log(`  ${s.padEnd(4)} n=${String(t.n).padStart(4)}  win ${String(t.win).padStart(5)}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%`);
}
console.log('\nper minute of entry:');
for (let L = MAX_LEFT; L >= MIN_LEFT; L--) {
  const t = T(ts.filter(x => x.left === L));
  if (t && t.n >= 40) console.log(`  T-${String(L).padStart(2)}  n=${String(t.n).padStart(4)}  win ${String(t.win).padStart(5)}%  edge ${String(t.edge).padStart(6)}pp`);
}
fs.writeFileSync(path.join(__dirname, 'final.json'), JSON.stringify({ at: Date.now(), band: [LO, HI], window: [MIN_LEFT, MAX_LEFT], markets: ms.length, all }, null, 1));
console.log('\n-> final.json');
