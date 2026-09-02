'use strict';
/**
 * The calibration surface: P(win) against price paid, cell by cell, for every price × minutes-left.
 *
 * ── why this and not another strategy backtest ──
 *
 * The timing control turned up something a strategy sweep cannot express. Holding the PRICE fixed and
 * moving the entry LATER changed the result enormously and in opposite directions at the two ends: a
 * 60¢ contract bought late won 68.3% against 60.3% bought early, while a 30¢ contract bought late won
 * 14% against 28.6%. Same price, same fee, wildly different outcome — which means price alone does not
 * determine the odds on this market, and minutes-left is not a nuisance parameter but a second axis.
 *
 * A surface says where the market is wrong rather than whether one rule happened to win. Every cell is
 * "what did contracts at this price with this much time left actually do", so a strategy can be read
 * off it afterwards instead of being guessed at and then tested.
 *
 * ── one observation per market-minute ──
 *
 * A market appears in several cells, once per minute it was quoted. That is correct for measuring
 * P(win | price, time) and WRONG for a confidence interval, because a market's minutes share one
 * outcome. So the surface is measured here and the interval is measured in the one-entry-per-market
 * simulation that follows it, never mixed.
 */
const fs = require('fs');
const path = require('path');
const A_CL = 2;

function load() {
  const out = [];
  for (const line of fs.readFileSync(path.join(__dirname, 'paths.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
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

const EDGES = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.93, 0.99];
const bandOf = p => { for (let i = 0; i < EDGES.length - 1; i++) if (p >= EDGES[i] && p < EDGES[i + 1]) return i; return -1; };

const ms = load();
// cell[band][left] = [wins, n, sumPrice]
const cell = EDGES.map(() => Array.from({ length: 16 }, () => [0, 0, 0]));
for (const m of ms) {
  for (const row of m.p) {
    const left = row[0];
    if (left < 1 || left > 14) continue;
    const a = asks(row);
    if (!a) continue;
    for (const side of ['yes', 'no']) {
      const px = a[side];
      const b = bandOf(px);
      if (b < 0) continue;
      const won = side === 'yes' ? m.r === 1 : m.r === 0;
      const c = cell[b][left];
      c[0] += won ? 1 : 0; c[1]++; c[2] += px;
    }
  }
}

console.log(`markets ${ms.length}\n`);
console.log('EDGE = realised win% minus (price + fee). Positive means the contract was too cheap.\n');
let head = 'price band  ';
for (let L = 13; L >= 1; L--) head += `  T-${String(L).padStart(2)}`;
console.log(head);
for (let b = 0; b < EDGES.length - 1; b++) {
  let line = `${(EDGES[b] * 100).toFixed(0).padStart(3)}-${(EDGES[b + 1] * 100).toFixed(0).padEnd(3)}   `;
  for (let L = 13; L >= 1; L--) {
    const [w, n, sp] = cell[b][L];
    if (n < 60) { line += '     .'; continue; }
    const px = sp / n, be = px + 0.07 * px * (1 - px);
    const e = (w / n - be) * 100;
    line += String(e.toFixed(1)).padStart(6);
  }
  console.log(line);
}
console.log('\nsample sizes (same layout):');
for (let b = 0; b < EDGES.length - 1; b++) {
  let line = `${(EDGES[b] * 100).toFixed(0).padStart(3)}-${(EDGES[b + 1] * 100).toFixed(0).padEnd(3)}   `;
  for (let L = 13; L >= 1; L--) line += String(cell[b][L][1]).padStart(6);
  console.log(line);
}
fs.writeFileSync(path.join(__dirname, 'grid.json'), JSON.stringify({ at: Date.now(), markets: ms.length, EDGES, cell }, null, 1));
console.log('\n-> grid.json');
