'use strict';
/**
 * Which of the 85-90c entries LOSE, and is there anything visible about them beforehand?
 *
 * ── the right question, finally ──
 *
 * Every earlier test asked whether the band works. It does: 89.5% against a break-even of 87.9%. This asks
 * something narrower and more useful — of the 220 losses in 2,098 trades, is there anything in the price
 * path BEFORE entry that marks them? A filter that removes half the losses while keeping most of the wins
 * roughly doubles the edge without taking fewer trades, which is the thing actually being asked for.
 *
 * ── the trap, and the discipline against it ──
 *
 * 220 losses is a small sample to search for a filter in, and searching hard enough will always find one.
 * So: every candidate is fitted on the FIRST chronological half and scored on the second, and a filter only
 * counts if it survives that and keeps a usable share of the trades. A rule that lifts the win rate by
 * throwing away 80% of the entries is not an answer to "without minimising trades".
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_LO = 0, A_HI = 1, A_CL = 2;
const LO = 0.85, HI = 0.90, MIN_L = 7, MAX_L = 12;

function quote(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
  const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
  if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  return { a, b, mid: (a + b) / 2, spread: +(a - b).toFixed(4) };
}

const markets = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  if (r.s === 'XRP') continue;
  r.p.sort((a, b) => b[0] - a[0]);
  markets.push(r);
}
markets.sort((a, b) => a.c - b.c);

/** The entry, plus everything about how it GOT there. Strictly backward-looking. */
const trades = [];
for (const m of markets) {
  const byLeft = new Map();
  for (const r of m.p) byLeft.set(r[0], r);
  for (const row of m.p) {
    const L = row[0];
    if (L > MAX_L) continue;
    if (L < MIN_L) break;
    const q = quote(row);
    if (!q) continue;
    const no = +(1 - q.b).toFixed(4);
    let side = null, px = null;
    if (q.a >= LO && q.a <= HI) { side = 'YES'; px = q.a; }
    else if (no >= LO && no <= HI) { side = 'NO'; px = no; }
    if (!side) continue;

    const dearMid = side === 'YES' ? q.mid : 1 - q.mid;
    // The three minutes before entry, on the same side.
    const hist = [];
    for (let k = 1; k <= 4; k++) {
      const p = byLeft.get(L + k);
      const qq = p && quote(p);
      hist.push(qq ? (side === 'YES' ? qq.mid : 1 - qq.mid) : null);
    }
    const h1 = hist[0], h2 = hist[1], h3 = hist[2];
    // How it arrived: rose into the band, or fell into it.
    const d1 = h1 == null ? null : +(dearMid - h1).toFixed(4);
    const d2 = h2 == null ? null : +((dearMid - h2) / 2).toFixed(4);
    // Consecutive earlier minutes already at or above the band floor — how settled the lead is.
    let dwell = 0;
    for (let k = 1; k <= 8; k++) {
      const p = byLeft.get(L + k);
      const qq = p && quote(p);
      if (!qq) break;
      const dm = side === 'YES' ? qq.a : +(1 - qq.b).toFixed(4);
      if (dm >= LO) dwell++; else break;
    }
    // The highest this side had reached before now, and how far off that peak it is.
    let peak = 0;
    for (let k = 1; k <= 8; k++) {
      const p = byLeft.get(L + k);
      const qq = p && quote(p);
      if (!qq) continue;
      const dm = side === 'YES' ? qq.a : +(1 - qq.b).toFixed(4);
      if (dm > peak) peak = dm;
    }
    const offPeak = peak > 0 ? +(peak - px).toFixed(4) : null;
    const steps = [h1, h2, h3].filter(x => x != null);
    const vol = steps.length >= 2
      ? +Math.sqrt(steps.slice(0, -1).map((x, i) => Math.pow(x - steps[i + 1], 2))
          .reduce((a, b) => a + b, 0) / Math.max(1, steps.length - 1)).toFixed(4)
      : null;
    trades.push({
      sym: m.s, close: m.c, left: L, side, px, spread: q.spread, d1, d2, dwell, offPeak, vol,
      vol1: Number(row[3]) || 0,
      won: side === 'YES' ? m.r === 1 : m.r === 0
    });
    break;
  }
}
// One direction per settlement window, as the bot enforces.
const byWin = new Map();
for (const t of trades) { const k = String(t.close); if (!byWin.has(k)) byWin.set(k, t); }
const T = [...byWin.values()].sort((a, b) => a.close - b.close);
const mid = Math.floor(T.length / 2);
const A = T.slice(0, mid), B = T.slice(mid);
console.log(`${T.length} trades  (${T.filter(t => !t.won).length} losses)   half A ${A.length}, half B ${B.length}\n`);

function score(rs) {
  const n = rs.length; if (!n) return null;
  const win = rs.filter(r => r.won).length / n;
  const px = rs.reduce((a, r) => a + r.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  const pnl = rs.reduce((a, r) => a + ((r.won ? 100 : 0) - (100 * r.px + takerFee(100, r.px))), 0);
  const staked = rs.reduce((a, r) => a + 100 * r.px + takerFee(100, r.px), 0);
  return { n, win, px, be, edge: (win - be) * 100, roi: pnl / staked * 100, pnl };
}
const base = score(T);
console.log(`baseline: win ${(base.win * 100).toFixed(2)}%  b/e ${(base.be * 100).toFixed(2)}%  edge ${base.edge.toFixed(2)}pp  ROI ${base.roi.toFixed(2)}%\n`);

/** Loss rate by bucket, one feature at a time, on the FIRST half only. */
function buckets(rs, key, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const sel = rs.filter(r => r[key] != null && r[key] >= edges[i] && r[key] < edges[i + 1]);
    if (sel.length < 60) continue;
    const s = score(sel);
    out.push({ range: `${edges[i]}..${edges[i + 1]}`, n: s.n, lossPct: (1 - s.win) * 100, edge: s.edge });
  }
  return out;
}
const FEATS = [
  ['px', [0.85, 0.865, 0.88, 0.895, 0.91]],
  ['left', [7, 8, 9, 10, 11, 13]],
  ['spread', [0, 0.011, 0.021, 0.031, 1]],
  ['d1', [-1, -0.02, 0, 0.02, 0.06, 1]],
  ['dwell', [0, 1, 2, 3, 5, 9]],
  ['offPeak', [-1, 0, 0.01, 0.03, 1]],
  ['vol', [0, 0.01, 0.025, 0.05, 1]]
];
console.log('loss rate by feature, FIRST HALF only (the search set)');
for (const [key, edges] of FEATS) {
  const bs = buckets(A, key, edges);
  if (!bs.length) continue;
  console.log(`  ${key}`);
  for (const b of bs) {
    console.log(`    ${b.range.padEnd(14)} n=${String(b.n).padStart(4)}  lost ${b.lossPct.toFixed(1).padStart(5)}%  edge ${b.edge.toFixed(2).padStart(6)}pp`);
  }
}
module.exports = { T, A, B, score };
