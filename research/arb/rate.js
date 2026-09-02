'use strict';
/**
 * How many signals a real hour actually contains — and why the earlier "32 a day" was wrong by 10x.
 *
 * The corpus is stride-sampled: 4,199 of the 45,030 settled markets, spread across the whole 68 days so
 * any prefix is representative. That makes rates per MARKET correct and rates per DAY wrong by exactly
 * the sampling fraction. 2,177 signals in the sample reads as 32 a day only because 91% of the markets
 * that would also have signalled were never fetched.
 *
 * Seven coins × 96 fifteen-minute windows = 672 markets a day, and the gate fires on about half of them.
 * The real rate is a couple of hundred a day, which changes a nine-hour projection completely.
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
const sig = [];
for (const m of ms) {
  const e = entry(m);
  if (e) sig.push({ sym: m.s, close: m.c, px: e.px, left: e.left, won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
}
const fire = sig.length / ms.length;
console.log(`markets sampled ${ms.length}   signals ${sig.length}   fire rate ${(fire * 100).toFixed(1)}% of markets`);
console.log(`full exchange: 7 coins x 96 windows = 672 markets/day`);
console.log(`  -> signals/day  ${(672 * fire).toFixed(0)}`);
console.log(`  -> signals/hour ${(28 * fire).toFixed(1)}   (9 hours: ${(28 * 9 * fire).toFixed(0)})`);

// Signals per hour of the ET day, to see whether a 9-hour session should be picked at all.
const byHour = Array.from({ length: 24 }, () => [0, 0]);
for (const m of ms) {
  const h = Number(new Date(m.c).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  byHour[h % 24][1]++;
}
for (const s of sig) {
  const h = Number(new Date(s.close).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  byHour[h % 24][0]++;
}
console.log('\nfire rate and edge by hour of the ET day:');
console.log(' hour   markets  fires  fire%   win%   edge(pp)');
const hourStat = [];
for (let h = 0; h < 24; h++) {
  const [f, n] = byHour[h];
  if (n < 40) continue;
  const hs = sig.filter(s => Number(new Date(s.close).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) % 24 === h);
  const win = hs.length ? hs.filter(x => x.won).length / hs.length : 0;
  const px = hs.length ? hs.reduce((a, x) => a + x.px, 0) / hs.length : 0;
  const be = px + 0.07 * px * (1 - px);
  const edge = hs.length >= 40 ? (win - be) * 100 : null;
  hourStat.push({ h, fire: f / n, edge, n: hs.length });
  console.log(`  ${String(h).padStart(2)}:00 ${String(n).padStart(8)} ${String(f).padStart(6)} ${(f / n * 100).toFixed(0).padStart(6)} ${hs.length >= 40 ? (win * 100).toFixed(1).padStart(6) : '     .'} ${edge == null ? '        .' : edge.toFixed(2).padStart(9)}`);
}

/**
 * Nine hours on $50, with capital and correlation both binding.
 *
 * Positions are held to settlement, so money is locked for up to twelve minutes and the account can only
 * run as many at once as it can pay for. Correlation is modelled rather than resampled: the corpus is 10%
 * fetched, so complete seven-coin windows are rare, but the pairwise agreement inside the windows that ARE
 * complete is measurable — 85.1% against 81.6% under independence. A latent common factor is tuned to
 * reproduce that, then each coin's outcome is drawn conditional on it.
 */
const wins = sig.filter(s => s.won).length / sig.length;
const avgPx = sig.reduce((a, s) => a + s.px, 0) / sig.length;
const BE = avgPx + 0.07 * avgPx * (1 - avgPx);

/**
 * Correlation that preserves the marginal.
 *
 * Seven coins settle together and their outcomes agree more often than chance. The obvious way to force
 * that — blend a shared random number into each coin's draw — silently changes the win rate too: mixing
 * U(0,0.05) into U(0,0.95) turns an 89.3% threshold into a 91.3% one, and a two-point gift on top of a
 * two-point edge doubles the answer. Correlation must be added WITHOUT touching the marginal.
 *
 * The mixture form does that exactly. With probability rho a coin copies one shared coin flip; otherwise
 * it flips its own. Either branch is Bernoulli(p), so the win rate is p by construction, and the pairwise
 * agreement becomes rho^2 + (1 − rho^2)·(p² + (1−p)²) — solved for rho against the 85.1% measured in the
 * windows that carry more than one signal.
 */
const indepAgree = wins * wins + (1 - wins) * (1 - wins);
const RHO = Math.sqrt(Math.max(0, (0.851 - indepAgree) / (1 - indepAgree)));
console.log(`\nwin rate ${(wins * 100).toFixed(2)}%   avg price ${(avgPx * 100).toFixed(2)}c   break-even ${(BE * 100).toFixed(2)}%`);
console.log(`independent pair agreement would be ${(indepAgree * 100).toFixed(1)}%, measured 85.1% -> rho ${RHO.toFixed(3)}`);

function session(bank0, size, hours, p, runs = 20000) {
  const windowsN = Math.round(hours * 4);
  const cost = size * avgPx + takerFee(size, avgPx);
  const finals = []; let up = 0, ruin = 0, trades = 0;
  for (let r = 0; r < runs; r++) {
    let bank = bank0, open = 0, t = 0, dead = false;
    for (let w = 0; w < windowsN && !dead; w++) {
      bank += open; open = 0;                       // last window's positions have settled
      const shared = Math.random() < p;            // the one flip the correlated coins copy
      for (let coin = 0; coin < 7; coin++) {
        if (Math.random() > fire) continue;
        if (cost > bank) continue;
        bank -= cost;
        const won = Math.random() < RHO ? shared : Math.random() < p;
        if (won) open += size;
        t++;
      }
      if (bank < cost && open === 0) { ruin++; dead = true; }
    }
    bank += open;
    finals.push(bank); trades += t;
    if (bank > bank0) up++;
  }
  finals.sort((a, b) => a - b);
  const q = x => finals[Math.min(finals.length - 1, Math.floor(x * finals.length))];
  return { mean: finals.reduce((a, b) => a + b, 0) / finals.length, med: q(0.5), p05: q(0.05),
           p25: q(0.25), p75: q(0.75), p95: q(0.95), up: up / runs * 100, ruin: ruin / runs * 100,
           trades: trades / runs };
}

/**
 * Three scenarios, because the edge is an estimate and the third one is what happens if it is not real.
 *
 * FULL SAMPLE is the win rate the whole corpus shows. OUT OF SAMPLE is the band chosen on the first half
 * and traded on the second — the unbiased figure, since the band was the best of 108 searched. ZERO EDGE
 * prices the market as perfectly efficient, leaving only the fee; that is the honest floor and the outcome
 * every other configuration in this project has produced.
 */
const SCEN = [
  ['full-sample  (win 89.8%, edge +1.9pp)', wins],
  ['out-of-sample (win 89.4%, edge +1.4pp)', BE + (wins - BE) * 0.70],
  ['ZERO EDGE — market efficient, fee only', BE],
];
for (const [label, p] of SCEN) {
  console.log(`\n=== $50 over 9 hours, all 7 coins, ${(28 * fire).toFixed(1)} signals/hour — ${label} ===`);
  console.log('size  trades   mean$    median$    5th%     25th%    75th%    95th%   chance up  ruin%');
  for (const size of [1, 3, 5, 8, 12, 20]) {
    const r = session(50, size, 9, p);
    console.log(`${String(size).padStart(4)} ${r.trades.toFixed(0).padStart(7)} ${('$' + r.mean.toFixed(2)).padStart(8)} ${('$' + r.med.toFixed(2)).padStart(10)} ${('$' + r.p05.toFixed(2)).padStart(8)} ${('$' + r.p25.toFixed(2)).padStart(8)} ${('$' + r.p75.toFixed(2)).padStart(8)} ${('$' + r.p95.toFixed(2)).padStart(8)} ${(r.up.toFixed(1) + '%').padStart(10)} ${(r.ruin.toFixed(2) + '%').padStart(7)}`);
  }
}

// The arithmetic behind the simulation, so it can be checked without trusting it.
console.log('\n=== the same answer by hand, at size 5 ===');
for (const [label, p] of SCEN) {
  const cost = 5 * avgPx + takerFee(5, avgPx);
  const ev = p * 5 - cost;
  console.log(`  ${label.padEnd(40)} EV/trade $${ev.toFixed(4)}  x 123 trades = ${(ev * 123 >= 0 ? '+' : '')}$${(ev * 123).toFixed(2)}  -> $${(50 + ev * 123).toFixed(2)}`);
}
