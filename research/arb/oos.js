'use strict';
/**
 * The only test that separates a finding from a curve fit: choose the band on one half, trade it on the
 * other, and never look at the half being traded.
 *
 * The 85-93¢ band was picked by reading a surface computed on the WHOLE corpus. That is exactly how the
 * vol floor and the stop-loss got shipped and reverted in this project — a number chosen with the answer
 * in view will always look good on the data that chose it. So the band is re-chosen here from one half
 * only, using nothing but that half, and then traded blind on the other. Both directions, because a
 * result that works forwards and not backwards is a regime, not an edge.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');
const A_CL = 2;

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
function run(ms, lo, hi, minLeft, maxLeft) {
  const ts = [];
  for (const m of ms) {
    const e = entry(m, lo, hi, minLeft, maxLeft);
    if (!e) continue;
    const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
    const cost = 100 * e.px + takerFee(100, e.px);
    ts.push({ px: e.px, won, cost, pnl: (won ? 100 : 0) - cost, side: e.side, sym: m.s });
  }
  const n = ts.length; if (!n) return null;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const be = px + 0.07 * px * (1 - px);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  return { n, win: +(win * 100).toFixed(2), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((win - be) * 100).toFixed(2), roi: +(pnl / staked * 100).toFixed(3),
           lo95: +((c - hw) * 100).toFixed(2), yes: ts.filter(t => t.side === 'YES').length, no: n - ts.filter(t => t.side === 'YES').length };
}

/** Every band the search is allowed to consider. Coarse on purpose — a finer grid is a finer curve fit. */
const GRID = [];
for (let lo = 0.55; lo <= 0.95; lo += 0.05) for (const w of [0.05, 0.08, 0.10]) {
  const hi = +(lo + w).toFixed(2);
  if (hi <= 0.99) GRID.push([+lo.toFixed(2), hi]);
}
const WINDOWS = [[3, 13], [5, 13], [6, 12], [3, 10]];

const ms = load();
const k = Math.floor(ms.length / 2);
const A = ms.slice(0, k), B = ms.slice(k);
console.log(`markets ${ms.length}: half A ${A.length} (${new Date(A[0].c).toISOString().slice(0,10)}..${new Date(A[A.length-1].c).toISOString().slice(0,10)}), half B ${B.length} (${new Date(B[0].c).toISOString().slice(0,10)}..${new Date(B[B.length-1].c).toISOString().slice(0,10)})`);

function best(train, minN) {
  let top = null;
  for (const [lo, hi] of GRID) for (const [a, b] of WINDOWS) {
    const r = run(train, lo, hi, a, b);
    if (!r || r.n < minN) continue;
    if (!top || r.edge > top.r.edge) top = { lo, hi, a, b, r };
  }
  return top;
}

for (const [trainName, train, testName, test] of [['A', A, 'B', B], ['B', B, 'A', A]]) {
  const minN = Math.floor(train.length * 0.25);
  const pick = best(train, minN);
  if (!pick) { console.log(`\ntrain ${trainName}: nothing met the sample floor`); continue; }
  const t = run(test, pick.lo, pick.hi, pick.a, pick.b);
  console.log(`\n=== chosen on ${trainName}, traded blind on ${testName} ===`);
  console.log(`  chosen band ${pick.lo.toFixed(2)}-${pick.hi.toFixed(2)}  window T-${pick.b}..T-${pick.a}`);
  console.log(`  in-sample  (${trainName})  n=${String(pick.r.n).padStart(5)}  price ${pick.r.px}  win ${pick.r.win}%  b/e ${pick.r.be}  edge ${String(pick.r.edge).padStart(6)}pp  ROI ${String(pick.r.roi).padStart(7)}%`);
  if (t) console.log(`  OUT OF SAMPLE (${testName})  n=${String(t.n).padStart(5)}  price ${t.px}  win ${t.win}%  b/e ${t.be}  edge ${String(t.edge).padStart(6)}pp  ROI ${String(t.roi).padStart(7)}%   YES/NO ${t.yes}/${t.no}`);
}

console.log('\n=== the fixed 85-93c band, T-13..T-3, in each half separately (no selection at all) ===');
for (const [nm, part] of [['A', A], ['B', B], ['all', ms]]) {
  const r = run(part, 0.85, 0.93, 3, 13);
  if (r) console.log(`  ${nm.padEnd(4)} n=${String(r.n).padStart(5)}  price ${r.px}  win ${r.win}%  b/e ${r.be}  edge ${String(r.edge).padStart(6)}pp  CI-low ${r.lo95}%  ROI ${String(r.roi).padStart(7)}%  YES/NO ${r.yes}/${r.no}`);
}
