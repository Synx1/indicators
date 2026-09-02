'use strict';
/**
 * Why $50 tops out where it does, and which levers actually move it.
 *
 * Expected profit is one product: trades x stake x edge-per-stake. The edge is +1.7 points, which is
 * ~2% of stake per trade, and it is not a dial — it is a measurement. So there are exactly three ways
 * to a bigger number, and only one of them is free.
 *
 *   MORE TRADES   capped by how many 15-minute markets exist
 *   MORE STAKE    capped by ruin, which is driven by correlation, not by the edge
 *   MORE BANKROLL not a lever I can pull
 *
 * This prints the frontier rather than a single answer, because "too little" is a choice about which
 * point on it to stand at, and the cost of moving right is measured in ruin.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');
const A_CL = 2;
const LO = 0.85, HI = 0.90, MIN_LEFT = 6, MAX_LEFT = 12;

function load(file) {
  const out = [];
  if (!fs.existsSync(path.join(__dirname, file))) return out;
  for (const line of fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n')) {
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
function entry(m) {
  for (const row of m.p) {
    const left = row[0];
    if (left > MAX_LEFT) continue;
    if (left < MIN_LEFT) break;
    const a = asks(row);
    if (!a) continue;
    if (a.yes >= LO && a.yes <= HI) return { side: 'YES', px: a.yes };
    if (a.no >= LO && a.no <= HI) return { side: 'NO', px: a.no };
  }
  return null;
}
const ms = load('paths.jsonl');
const sig = [];
for (const m of ms) {
  const e = entry(m);
  if (e) sig.push({ sym: m.s, close: m.c, px: e.px, won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
}
const fire = sig.length / ms.length;
const wins = sig.filter(s => s.won).length / sig.length;
const avgPx = sig.reduce((a, s) => a + s.px, 0) / sig.length;
const BE = avgPx + 0.07 * avgPx * (1 - avgPx);
const pOOS = BE + (wins - BE) * 0.96;   // 10,923-market corpus: in-sample 1.75pp, out-of-sample 1.69pp

console.log(`corpus ${ms.length} markets, ${sig.length} signals, fire ${(fire * 100).toFixed(0)}%`);
console.log(`entry ${(avgPx * 100).toFixed(2)}c  break-even ${(BE * 100).toFixed(2)}%  honest win ${(pOOS * 100).toFixed(2)}%  edge ${((pOOS - BE) * 100).toFixed(2)}pp\n`);

const indepAgree = wins * wins + (1 - wins) * (1 - wins);
const RHO7 = Math.sqrt(Math.max(0, (0.851 - indepAgree) / (1 - indepAgree)));

/**
 * One 9-hour session. `series` is how many 15-minute products are watched, `rho` how much their outcomes
 * move together, `size` the contracts per entry.
 *
 * Correlation enters through a single shared coin flip that each position copies with probability rho.
 * That form leaves the win rate exactly p — blending a shared random NUMBER into each draw would quietly
 * shift the marginal too, and a two-point gift on top of a two-point edge doubles the answer.
 */
function session(bank0, size, series, rho, p, hours = 9, runs = 20000) {
  const windows = Math.round(hours * 4);
  const cost = size * avgPx + takerFee(size, avgPx);
  const finals = []; let up = 0, ruin = 0, tr = 0;
  for (let r = 0; r < runs; r++) {
    let bank = bank0, open = 0, n = 0, dead = false;
    for (let w = 0; w < windows && !dead; w++) {
      bank += open; open = 0;
      const shared = Math.random() < p;
      for (let k = 0; k < series; k++) {
        if (Math.random() > fire) continue;
        if (cost > bank) continue;
        bank -= cost;
        if (Math.random() < rho ? shared : Math.random() < p) open += size;
        n++;
      }
      if (bank < cost && open === 0) { ruin++; dead = true; }
    }
    bank += open;
    finals.push(bank); tr += n;
    if (bank > bank0) up++;
  }
  finals.sort((a, b) => a - b);
  const q = x => finals[Math.min(finals.length - 1, Math.floor(x * finals.length))];
  return { mean: finals.reduce((a, b) => a + b, 0) / finals.length, med: q(0.5), p05: q(0.05),
           p95: q(0.95), up: up / runs * 100, ruin: ruin / runs * 100, trades: tr / runs };
}

console.log(`=== $50, 9 hours, 7 crypto series (what ships today), rho ${RHO7.toFixed(2)} ===`);
console.log('size  trades   median$   5th%    95th%   chance up   RUIN%');
for (const size of [3, 5, 8, 12, 16, 20, 25]) {
  const r = session(50, size, 7, RHO7, pOOS);
  console.log(`${String(size).padStart(4)} ${r.trades.toFixed(0).padStart(7)} ${('$' + r.med.toFixed(2)).padStart(9)} ${('$' + r.p05.toFixed(2)).padStart(8)} ${('$' + r.p95.toFixed(2)).padStart(8)} ${(r.up.toFixed(0) + '%').padStart(10)} ${(r.ruin.toFixed(1) + '%').padStart(8)}`);
}

/**
 * The same $50 with fourteen series instead of seven.
 *
 * Kalshi runs the identical fifteen-minute product on GOLD, SILVER, COPPER, NATGAS, WTI, NEAR and ZEC —
 * verified live, 19,327 settled markets between them. Five of those seven are metals and energy, which do
 * not settle with Bitcoin, so the portfolio correlation falls as well as the trade count rising. Both are
 * shown separately, because the trade count is arithmetic and the correlation is the part that has to be
 * measured before it is believed.
 */
console.log(`\n=== $50, 9 hours, 14 series — trade count doubled, correlation UNCHANGED (pessimistic) ===`);
console.log('size  trades   median$   5th%    95th%   chance up   RUIN%');
for (const size of [3, 5, 8, 12, 16]) {
  const r = session(50, size, 14, RHO7, pOOS);
  console.log(`${String(size).padStart(4)} ${r.trades.toFixed(0).padStart(7)} ${('$' + r.med.toFixed(2)).padStart(9)} ${('$' + r.p05.toFixed(2)).padStart(8)} ${('$' + r.p95.toFixed(2)).padStart(8)} ${(r.up.toFixed(0) + '%').padStart(10)} ${(r.ruin.toFixed(1) + '%').padStart(8)}`);
}
console.log(`\n=== $50, 9 hours, 14 series — and commodities cut correlation to rho 0.22 (if it holds) ===`);
console.log('size  trades   median$   5th%    95th%   chance up   RUIN%');
for (const size of [5, 8, 12, 16, 20]) {
  const r = session(50, size, 14, RHO7 / 2, pOOS);
  console.log(`${String(size).padStart(4)} ${r.trades.toFixed(0).padStart(7)} ${('$' + r.med.toFixed(2)).padStart(9)} ${('$' + r.p05.toFixed(2)).padStart(8)} ${('$' + r.p95.toFixed(2)).padStart(8)} ${(r.up.toFixed(0) + '%').padStart(10)} ${(r.ruin.toFixed(1) + '%').padStart(8)}`);
}

// The lever that is not mine to pull, priced so it is not a mystery.
console.log('\n=== the same 14-series settings, on a bigger bankroll (size scaled to bank) ===');
for (const [b0, size] of [[50, 8], [100, 16], [250, 40], [500, 80], [1000, 160]]) {
  const r = session(b0, size, 14, RHO7 / 2, pOOS);
  console.log(`  $${String(b0).padStart(4)} at ${String(size).padStart(3)} contracts -> median $${r.med.toFixed(2).padStart(9)}  (${((r.med / b0 - 1) * 100).toFixed(1)}%)  5th $${r.p05.toFixed(2).padStart(8)}  ruin ${r.ruin.toFixed(1)}%`);
}
