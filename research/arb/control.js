'use strict';
/**
 * Is the cheap-entry loss the STRATEGY, or is it my entry timing?
 *
 * "The first minute the price is at or under 40¢" systematically buys a side while it is falling — that
 * is when a price first crosses down through 40¢. If the whole loss comes from that selection, then
 * entering at a different qualifying minute should behave differently, and the finding is about my rule
 * rather than about the strategy. Three timings, same band, same grading: first, last, and middle
 * qualifying minute.
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
  if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return { yes: null, no: null };
  return { yes: a, no: +(1 - b).toFixed(4) };
}
/** Every minute in 5..13 where either side's ask sits in the band. */
function candidates(m, lo, hi) {
  const c = [];
  for (const row of m.p) {
    const left = row[0];
    if (left > 10 || left < 2) continue;
    const { yes, no } = asks(row);
    if (yes != null && yes >= lo && yes <= hi) c.push({ side: 'YES', px: yes, left });
    else if (no != null && no >= lo && no <= hi) c.push({ side: 'NO', px: no, left });
  }
  return c;
}
function run(ms, lo, hi, pick) {
  const ts = [];
  for (const m of ms) {
    const c = candidates(m, lo, hi);
    if (!c.length) continue;
    const e = pick === 'first' ? c[0] : pick === 'last' ? c[c.length - 1] : c[Math.floor(c.length / 2)];
    const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
    const cost = SIZE * e.px + takerFee(SIZE, e.px);
    ts.push({ px: e.px, won, cost, pnl: (won ? SIZE : 0) - cost, side: e.side });
  }
  const n = ts.length; if (!n) return null;
  const wins = ts.filter(t => t.won).length, px = ts.reduce((a, t) => a + t.px, 0) / n;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const be = px + 0.07 * px * (1 - px);
  return { n, win: +(wins / n * 100).toFixed(1), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((wins / n - be) * 100).toFixed(2), roi: +(pnl / staked * 100).toFixed(2),
           yes: ts.filter(t => t.side === 'YES').length, no: ts.filter(t => t.side === 'NO').length };
}
const ms = load();
console.log(`markets ${ms.length}\n`);
console.log('band        timing    n    price   win%   breakeven   edge(pp)   ROI%    YES/NO');
for (const [lo, hi] of [[0.02, 0.40], [0.20, 0.40], [0.35, 0.45], [0.55, 0.65], [0.75, 0.85], [0.90, 0.99]]) {
  for (const pick of ['first', 'mid', 'last']) {
    const r = run(ms, lo, hi, pick);
    if (!r || r.n < 40) continue;
    console.log(`${lo.toFixed(2)}-${hi.toFixed(2)}  ${pick.padEnd(6)} ${String(r.n).padStart(5)} ${String(r.px).padStart(7)} ${String(r.win).padStart(6)} ${String(r.be).padStart(11)} ${String(r.edge).padStart(10)} ${String(r.roi).padStart(7)}   ${r.yes}/${r.no}`);
  }
  console.log('');
}
