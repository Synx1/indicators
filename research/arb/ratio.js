'use strict';
/**
 * "Risking $20 to earn $4 isn't good" — the objection, priced against the real trade sequence.
 *
 * The objection is arithmetically correct: at 87c a loss costs 87c and a win pays 13c, so one loss undoes
 * 6.7 wins. What that ratio does NOT tell you is whether the account grows, because the ratio is only half
 * the equation — the other half is how many wins arrive per loss. This replays the actual settled sequence
 * and reports both halves, plus what a losing streak really costs at each size.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, LO = 0.85, HI = 0.90, MIN_L = 7, MAX_L = 12;   // Neutral's clock

const rows = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  if (r.s === 'XRP') continue;                                  // off under Neutral
  r.p.sort((a, b) => b[0] - a[0]);
  rows.push(r);
}
rows.sort((a, b) => a.c - b.c);

const sig = [];
for (const m of rows) {
  for (const row of m.p) {
    const L = row[0];
    if (L > MAX_L) continue;
    if (L < MIN_L) break;
    const ask = row[1], bid = row[2];
    const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
    const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
    if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
    const no = +(1 - b).toFixed(4);
    let e = null;
    if (a >= LO && a <= HI) e = { side: 'YES', px: a };
    else if (no >= LO && no <= HI) e = { side: 'NO', px: no };
    if (!e) continue;
    sig.push({ close: m.c, px: e.px, won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
    break;
  }
}
// One direction per settlement window, as accountBlock enforces.
const byWin = new Map();
for (const s of sig) { const k = String(s.close); if (!byWin.has(k)) byWin.set(k, []); byWin.get(k).push(s); }
const taken = [];
for (const [, ws] of byWin) taken.push(ws[0]);
taken.sort((a, b) => a.close - b.close);

const wins = taken.filter(t => t.won).length, losses = taken.length - wins;
const px = taken.reduce((a, t) => a + t.px, 0) / taken.length;
console.log(`${taken.length} trades in the real sequence: ${wins} won, ${losses} lost (${(wins / taken.length * 100).toFixed(2)}%)`);
console.log(`average entry ${(px * 100).toFixed(2)}c\n`);

console.log('the ratio, and the other half of it');
console.log(`  a loss costs ${(px * 100).toFixed(1)}c, a win pays ${((1 - px) * 100).toFixed(1)}c`);
console.log(`  -> one loss undoes ${(px / (1 - px)).toFixed(1)} wins`);
console.log(`  -> but you get ${(wins / losses).toFixed(1)} wins per loss`);
console.log(`  net per loss: ${(wins / losses).toFixed(1)} x ${((1 - px) * 100).toFixed(1)}c = ` +
  `${((wins / losses) * (1 - px) * 100).toFixed(1)}c collected against ${(px * 100).toFixed(1)}c paid out\n`);

// Longest losing runs actually observed.
let run = 0; const runs = [];
for (const t of taken) { if (!t.won) run++; else { if (run) runs.push(run); run = 0; } }
if (run) runs.push(run);
runs.sort((a, b) => b - a);
console.log(`losing streaks observed: worst ${runs[0]}, then ${runs.slice(1, 6).join(', ')}`);
console.log(`streaks of 3+: ${runs.filter(r => r >= 3).length} in ${taken.length} trades\n`);

console.log('what it looks like at each size, on this exact sequence');
console.log('size  per win  per loss   worst streak costs   net over the run   max drawdown   trades to recover a loss');
for (const c of [1, 3, 5, 10, 30]) {
  let bank = 0, peak = 0, dd = 0;
  for (const t of taken) {
    const cost = c * t.px + takerFee(c, t.px);
    bank += (t.won ? c : 0) - cost;
    if (bank > peak) peak = bank;
    if (peak - bank > dd) dd = peak - bank;
  }
  const perWin = c * (1 - px) - takerFee(c, px);
  const perLoss = c * px + takerFee(c, px);
  console.log(`${String(c).padStart(4)} ${('$' + perWin.toFixed(2)).padStart(8)} ${('$' + perLoss.toFixed(2)).padStart(9)} ` +
    `${('$' + (perLoss * runs[0]).toFixed(2)).padStart(19)} ${('$' + bank.toFixed(2)).padStart(18)} ` +
    `${('$' + dd.toFixed(2)).padStart(14)} ${(perLoss / perWin).toFixed(1).padStart(26)}`);
}

console.log('\nand what $50 survives');
for (const c of [1, 3, 5, 10, 30]) {
  const perLoss = c * px + takerFee(c, px);
  console.log(`  ${String(c).padStart(2)} contracts: a loss costs $${perLoss.toFixed(2)}, so $50 survives ` +
    `${Math.floor(50 / perLoss)} losses in a row (worst seen: ${runs[0]})`);
}
