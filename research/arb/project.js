'use strict';
/**
 * What the signal is worth in dollars, at sizes that exist.
 *
 * The compounding replay produced 186x, which is not a forecast — it is what any positive per-trade edge
 * looks like after sixteen hundred trades of geometric growth, and it ignores that the book at the touch
 * is a few thousand contracts deep, not a few hundred thousand. So this reports FLAT stakes: the same
 * size every trade, which is what the strategy actually calls for and what a small account can actually
 * place.
 *
 * The unbiased edge is the OUT-OF-SAMPLE one. The band was chosen by searching 27 price bands × 4 time
 * windows, and the best of 108 candidates is upward-biased by construction. Choosing on the first half
 * and trading the second gave +1.78 points; the full-sample figure is +2.54. The smaller number is the
 * one that goes into a projection.
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
  return { yes: a, no: +(1 - b).toFixed(4) };
}
function entry(m) {
  for (const row of m.p) {
    const left = row[0];
    if (left > MAX_LEFT) continue;
    if (left < MIN_LEFT) break;
    const a = asks(row);
    if (!a) continue;
    if (a.yes >= LO && a.yes <= HI) return { side: 'YES', px: a.yes, left };
    if (a.no >= LO && a.no <= HI) return { side: 'NO', px: a.no, left };
  }
  return null;
}
const ms = load();
const trades = [];
for (const m of ms) {
  const e = entry(m);
  if (!e) continue;
  trades.push({ sym: m.s, close: m.c, px: e.px, won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
}
trades.sort((a, b) => a.close - b.close);
const days = (trades[trades.length - 1].close - trades[0].close) / 86400e3;
console.log(`${trades.length} signals over ${days.toFixed(1)} days = ${(trades.length / days).toFixed(1)} per day across 7 coins\n`);

/** Per-contract expectancy at a given size, with the fee charged the way the exchange charges it. */
function perContract(size) {
  let pnl = 0, stake = 0;
  for (const t of trades) {
    const cost = size * t.px + takerFee(size, t.px);
    pnl += (t.won ? size : 0) - cost;
    stake += cost;
  }
  return { perTrade: pnl / trades.length, perContract: pnl / trades.length / size, roi: pnl / stake * 100 };
}
console.log('the cent rounding, priced: what one entry earns at each size');
console.log('  size   fee/contract   expectancy/trade   ROI% of stake');
for (const s of [1, 2, 5, 10, 25, 50, 100, 500]) {
  const r = perContract(s);
  const f = takerFee(s, 0.87) / s;
  console.log(`  ${String(s).padStart(4)}   ${(f * 100).toFixed(3).padStart(9)}c   ${('$' + r.perTrade.toFixed(4)).padStart(16)}   ${r.roi.toFixed(3).padStart(12)}`);
}

/**
 * Flat-stake Monte Carlo, resampling whole WINDOWS rather than individual trades.
 *
 * Seven coins settle together and their outcomes agree more often than chance (85.1% of same-window
 * pairs against 81.6% if independent). Resampling single trades would quietly assume that away and
 * report a drawdown far smaller than the real one, so a draw takes an entire window with all its
 * correlated results intact.
 */
const byWin = new Map();
for (const t of trades) {
  const k = String(t.close);
  if (!byWin.has(k)) byWin.set(k, []);
  byWin.get(k).push(t);
}
const windows = [...byWin.values()];
function mc(bank0, contracts, nDays, tradesPerDay, runs = 20000) {
  const perDay = Math.max(1, Math.round(tradesPerDay / 2.8));   // windows per day, ~2.8 signals each
  const finals = [];
  let ruined = 0, up = 0;
  for (let r = 0; r < runs; r++) {
    let bank = bank0;
    outer:
    for (let d = 0; d < nDays; d++) {
      for (let w = 0; w < perDay; w++) {
        const win = windows[(Math.random() * windows.length) | 0];
        for (const t of win) {
          const cost = contracts * t.px + takerFee(contracts, t.px);
          if (cost > bank) continue;
          bank -= cost;
          if (t.won) bank += contracts;
          if (bank < t.px) { ruined++; break outer; }
        }
      }
    }
    finals.push(bank);
    if (bank > bank0) up++;
  }
  finals.sort((a, b) => a - b);
  const q = p => finals[Math.min(finals.length - 1, Math.floor(p * finals.length))];
  return { mean: finals.reduce((a, b) => a + b, 0) / finals.length, med: q(0.5), p05: q(0.05), p95: q(0.95),
           upPct: up / runs * 100, ruinPct: ruined / runs * 100 };
}
console.log('\n=== flat stake, 20,000 simulated runs, real windows resampled whole ===');
console.log('bank   size   days   mean$    median$   5th%    95th%   chance up   ruin%');
for (const [b0, size, nd] of [[10, 1, 4], [10, 1, 30], [10, 2, 4], [10, 3, 4],
                              [50, 5, 4], [50, 5, 30], [100, 10, 30], [500, 50, 30]]) {
  const r = mc(b0, size, nd, 45);
  console.log(`$${String(b0).padStart(4)}  ${String(size).padStart(4)}  ${String(nd).padStart(5)}  ${('$' + r.mean.toFixed(2)).padStart(8)} ${('$' + r.med.toFixed(2)).padStart(9)} ${('$' + r.p05.toFixed(2)).padStart(8)} ${('$' + r.p95.toFixed(2)).padStart(8)} ${(r.upPct.toFixed(1) + '%').padStart(10)} ${(r.ruinPct.toFixed(2) + '%').padStart(7)}`);
}
