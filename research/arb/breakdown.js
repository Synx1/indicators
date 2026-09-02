'use strict';
/**
 * Does the dear-side margin behave the way the settlement rule says it must?
 *
 * ── the mechanism, and the prediction that tests it ──
 *
 * Kalshi settles a 15-minute market on "the simple average of the sixty seconds of CF Benchmarks' BRTI
 * before" the close — its own rules text, not an inference. The settlement value is therefore a MEAN of
 * the final minute, not the price at the bell, and the mean of the last minute has less variance than a
 * single draw: sd σ·√(T − 2/3) against σ·√T for T minutes left.
 *
 * A model that treats settlement as a point draw therefore OVERSTATES how much can still change, and so
 * prices every favourite too cheaply. The size of that error is not constant — the ratio √T/√(T−2/3) is
 * 1.04 at eight minutes and 1.22 at two, so the mispricing must GROW as the close approaches.
 *
 * That is a falsifiable prediction with a shape, not just a sign. A margin that is flat across
 * minutes-left, or that shrinks, means the mechanism is not what is producing the number and the number
 * is a coincidence in one sample. This file checks the shape, the per-coin consistency, and whether a
 * two-sided book was actually present at entry.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');

const SIZE = 100, A_CL = 2;
const LO = 0.75, HI = 0.90;   // the band the sweep favoured, widened to keep the per-cell counts usable

function load() {
  const out = [];
  for (const line of fs.readFileSync(path.join(__dirname, 'paths.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
    r.p.sort((a, b) => b[0] - a[0]);
    out.push(r);
  }
  out.sort((a, b) => a.c - b.c);
  return out;
}

/**
 * Both sides' buyable price, but only from a minute that had a REAL two-sided book.
 *
 * A missing ask is reported as 1.0000 and a missing bid as 0.0000, and both are finite numbers that
 * sail through a range check. "Number(null) === 0 passes a finite check" has already produced three
 * false results in this project; here it would invent an 80¢ fill in a minute where nothing was
 * offered. So a minute with no bid or no ask is not a tradeable minute.
 */
function asks(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
  const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
  if (a == null || b == null) return { yes: null, no: null };
  if (!(a > 0) || !(a < 1) || !(b > 0) || !(b < 1)) return { yes: null, no: null };
  if (a < b) return { yes: null, no: null };                      // crossed: bad data, not an opportunity
  return { yes: a, no: +(1 - b).toFixed(4) };
}

function entryAt(m, lo, hi, minLeft, maxLeft) {
  for (const row of m.p) {
    const left = row[0];
    if (left > maxLeft) continue;
    if (left < minLeft) break;
    const { yes, no } = asks(row);
    if (yes != null && yes >= lo && yes <= hi) return { side: 'YES', px: yes, left };
    if (no != null && no >= lo && no <= hi) return { side: 'NO', px: no, left };
  }
  return null;
}

function tally(ts) {
  const n = ts.length;
  if (!n) return null;
  const wins = ts.filter(t => t.won).length;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0);
  const staked = ts.reduce((a, t) => a + t.cost, 0);
  const win = wins / n;
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  // Break-even is the price plus the fee actually charged at that price, not the price alone.
  const be = px + 0.07 * px * (1 - px);
  return { n, win: +(win * 100).toFixed(1), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((win - be) * 100).toFixed(2), lo95: +((c - hw) * 100).toFixed(1),
           roi: +(pnl / staked * 100).toFixed(2), pnl: +pnl.toFixed(0) };
}

const ms = load();
const all = [];
for (const m of ms) {
  const e = entryAt(m, LO, HI, 1, 13);
  if (!e) continue;
  const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
  const cost = SIZE * e.px + takerFee(SIZE, e.px);
  all.push({ sym: m.s, close: m.c, side: e.side, px: e.px, left: e.left, won, cost, pnl: (won ? SIZE : 0) - cost });
}
console.log(`markets ${ms.length}, entries in ${LO}-${HI}: ${all.length}\n`);

console.log('=== the mechanism test: margin by MINUTES LEFT at entry ===');
console.log('the averaging correction predicts edge GROWS as the close approaches\n');
console.log('minsLeft    n    price   win%   breakeven   edge(pp)   predicted(pp)   ROI%');
for (let L = 13; L >= 1; L--) {
  const ts = all.filter(t => t.left === L);
  const t = tally(ts);
  if (!t || t.n < 25) continue;
  // What the averaging correction alone predicts at this horizon and this price.
  const p = t.px / 100;
  const zx = Math.sqrt(2) * inverf(2 * p - 1);
  const scale = Math.sqrt(L) / Math.sqrt(Math.max(L - 2 / 3, 0.05));
  const pred = (ncdf(zx * scale) - p) * 100;
  console.log(`  ${String(L).padStart(3)} ${String(t.n).padStart(7)} ${String(t.px).padStart(7)} ${String(t.win).padStart(6)} ${String(t.be).padStart(11)} ${String(t.edge).padStart(10)} ${String(pred.toFixed(2)).padStart(15)} ${String(t.roi).padStart(6)}`);
}

console.log('\n=== per coin (an edge in one coin only is a coin story, not a mechanism) ===');
console.log('coin      n    price   win%   edge(pp)   ROI%');
for (const sym of ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE']) {
  const t = tally(all.filter(x => x.sym === sym));
  if (!t) continue;
  console.log(`  ${sym.padEnd(6)} ${String(t.n).padStart(5)} ${String(t.px).padStart(7)} ${String(t.win).padStart(6)} ${String(t.edge).padStart(10)} ${String(t.roi).padStart(6)}`);
}

console.log('\n=== thirds, chronological (halves hid a bad stretch before) ===');
const k = Math.floor(all.length / 3);
for (const [name, slice] of [['first ', all.slice(0, k)], ['middle', all.slice(k, 2 * k)], ['last  ', all.slice(2 * k)]]) {
  const t = tally(slice);
  if (!t) continue;
  console.log(`  ${name}  n=${String(t.n).padStart(5)}  price ${t.px}  win ${t.win}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(6)}%  PnL $${t.pnl}`);
}

console.log('\n=== side split ===');
for (const s of ['YES', 'NO']) {
  const t = tally(all.filter(x => x.side === s));
  if (t) console.log(`  ${s}  n=${String(t.n).padStart(5)}  price ${t.px}  win ${t.win}%  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(6)}%`);
}

/** Normal cdf and inverse-erf, so the prediction column is computed rather than eyeballed. */
function ncdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function inverf(y) {
  const a = 0.147; const ln = Math.log(1 - y * y);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(y) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}
