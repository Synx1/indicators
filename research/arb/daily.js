'use strict';
/**
 * "I want profit every day" — a different requirement from "profitable", and measurable.
 *
 * With ~90 trades a day at an 89.5% win rate, a day carries about nine losses. Each loss costs 87c and each
 * win pays 13c, so whether a given DAY is green depends on landing near nine rather than fifteen — and that
 * is variance, not edge. This counts how many days actually finished green on the real sequence.
 *
 * ── the sample correction, which matters here ──
 *
 * paths.jsonl holds a stride-sample of the 68-day window, so its trades-per-day is the SAMPLE's rate, not
 * the exchange's. Earlier numbers quoted straight off it ($91 over 68 days) understated the real book by the
 * sampling fraction. Per-trade economics are unaffected by sampling; per-DAY economics are not, so the daily
 * figures below are scaled by the coverage and the scaling is printed rather than hidden.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, LO = 0.85, HI = 0.90, MIN_L = 7, MAX_L = 12;

const markets = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length || r.s === 'XRP') continue;
  r.p.sort((a, b) => b[0] - a[0]);
  markets.push(r);
}
markets.sort((a, b) => a.c - b.c);

const sig = [];
for (const m of markets) {
  for (const row of m.p) {
    const L = row[0];
    if (L > MAX_L) continue;
    if (L < MIN_L) break;
    const ask = row[1], bid = row[2];
    const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
    const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
    if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
    const no = +(1 - b).toFixed(4);
    let side = null, px = null;
    if (a >= LO && a <= HI) { side = 'YES'; px = a; }
    else if (no >= LO && no <= HI) { side = 'NO'; px = no; }
    if (!side) continue;
    sig.push({ sym: m.s, close: m.c, side, px, won: side === 'YES' ? m.r === 1 : m.r === 0 });
    break;
  }
}
// One position per direction per settlement window, as accountBlock enforces.
const byWin = new Map();
for (const s of sig) { const k = String(s.close); if (!byWin.has(k)) byWin.set(k, []); byWin.get(k).push(s); }
const taken = [];
for (const [, ws] of byWin) {
  const seen = new Set();
  for (const s of ws) { if (seen.has(s.side)) continue; seen.add(s.side); taken.push(s); if (seen.size >= 2) break; }
}
taken.sort((a, b) => a.close - b.close);

// Coverage: how many of the six live coins each sampled window actually carries.
const coverage = markets.length / new Set(markets.map(m => String(m.c))).size;
const scale = 6 / Math.min(6, coverage);
const days = new Map();
for (const t of taken) {
  const d = new Date(t.close).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!days.has(d)) days.set(d, []);
  days.get(d).push(t);
}
const perDaySample = taken.length / days.size;
console.log(`${taken.length} trades over ${days.size} days`);
console.log(`sampled coverage ${coverage.toFixed(2)} of 6 coins per window -> scale x${scale.toFixed(2)}`);
console.log(`trades/day in the sample ${perDaySample.toFixed(1)}  ->  at full coverage ${(perDaySample * scale).toFixed(0)}\n`);

function dayPnl(ts, c) {
  return ts.reduce((a, t) => a + ((t.won ? c : 0) - (c * t.px + takerFee(c, t.px))), 0);
}
console.log('per DAY, at full coverage, on the real sequence');
console.log('size   avg day    median day   green days   worst day    best day   days to a losing week');
for (const c of [3, 5, 8]) {
  const vals = [...days.values()].map(ts => dayPnl(ts, c) * scale).sort((a, b) => a - b);
  const green = vals.filter(v => v > 0).length;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const med = vals[Math.floor(vals.length / 2)];
  // Weekly rollup: how often seven consecutive days finish red.
  const seq = [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, ts]) => dayPnl(ts, c) * scale);
  let redWeeks = 0, weeks = 0;
  for (let i = 0; i + 7 <= seq.length; i += 7) { weeks++; if (seq.slice(i, i + 7).reduce((a, b) => a + b, 0) <= 0) redWeeks++; }
  console.log(`${String(c).padStart(4)} ${('$' + avg.toFixed(2)).padStart(9)} ${('$' + med.toFixed(2)).padStart(13)} ` +
    `${(green + '/' + vals.length).padStart(12)} ${('$' + vals[0].toFixed(2)).padStart(11)} ${('$' + vals[vals.length - 1].toFixed(2)).padStart(11)}` +
    `${(redWeeks + ' of ' + weeks + ' weeks red').padStart(24)}`);
}

console.log('\nand the whole 68 days, compounding the size as the bank grows (10% of bank per trade, min 1)');
for (const b0 of [50, 100, 250]) {
  let bank = b0, peak = b0, dd = 0, n = 0;
  const seq = [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [, ts] of seq) {
    // Scaled up to full coverage by replaying each sampled day `scale` times.
    for (let rep = 0; rep < Math.round(scale); rep++) {
      for (const t of ts) {
        const c = Math.max(1, Math.floor(bank * 0.10 / t.px));
        const cost = c * t.px + takerFee(c, t.px);
        if (cost > bank) continue;
        bank += (t.won ? c : 0) - cost;
        n++;
        if (bank > peak) peak = bank;
        if (peak - bank > dd) dd = peak - bank;
      }
    }
  }
  console.log(`  $${String(b0).padStart(4)} -> $${bank.toFixed(2).padStart(10)} after ${n} trades   worst drawdown ${(dd / peak * 100).toFixed(0)}%`);
}
