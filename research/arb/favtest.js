'use strict';
/**
 * The mirror of the cheap-entry result.
 *
 * The band sweep said something very loud: entries averaging 25.7¢ won 18.5% of the time — 7.2 points
 * BELOW what was paid, on 1,516 markets, which is a seven-sigma miss. A binary has only two sides, so
 * a side that loses 7 points below its price implies the other side WINS above its price by nearly as
 * much. That other side is the dear one, and Kalshi's fee is 0.07·p·(1−p), which is smallest exactly
 * there. So the same measurement that condemns the cheap entry recommends the dear one.
 *
 * This measures the dear side directly rather than inferring it, because the spread sits between the
 * two and inference would quietly pocket it.
 *
 * ── no side preference ──
 *
 * YES and NO are picked purely on which one's ask lands in the band. Preferring YES when both qualify
 * is how a rally in the sample turns into a fake edge, and the band 45-55¢ in the previous run was
 * exactly that artefact: near 50¢ both sides always qualify, so "prefer YES" is "bet on up".
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');

const FILE = path.join(__dirname, 'paths.jsonl');
const SIZE = 100;
const A_LO = 0, A_HI = 1, A_CL = 2;

function load() {
  const out = [];
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
    r.p.sort((a, b) => b[0] - a[0]);
    out.push(r);
  }
  out.sort((a, b) => a.c - b.c);
  return out;
}

/** Both sides' buyable price at the close of one minute. NO is the mirror of the YES book. */
function asks(row) {
  const ask = row[1], bid = row[2];
  const yes = ask && ask[A_CL] != null ? ask[A_CL] : null;
  const no = bid && bid[A_CL] != null ? +(1 - bid[A_CL]).toFixed(4) : null;
  return { yes, no };
}

function firstEntry(m, lo, hi, minLeft, maxLeft) {
  for (const row of m.p) {
    const left = row[0];
    if (left > maxLeft) continue;
    if (left < minLeft) break;
    const { yes, no } = asks(row);
    // Whichever side's ask lands in the band. Both can only qualify if the band straddles 50¢.
    if (yes != null && yes >= lo && yes <= hi) return { side: 'YES', px: yes, left };
    if (no != null && no >= lo && no <= hi) return { side: 'NO', px: no, left };
  }
  return null;
}

function stats(ts) {
  const n = ts.length;
  if (!n) return null;
  const pnl = ts.reduce((a, t) => a + t.pnl, 0);
  const staked = ts.reduce((a, t) => a + t.cost, 0);
  const wins = ts.filter(t => t.won).length;
  const avgEntry = ts.reduce((a, t) => a + t.px, 0) / n;
  let eq = 0, peak = 0, dd = 0;
  for (const t of ts) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const win = wins / n;
  // Wilson 95% on the win rate, so a band is judged on what the sample can actually support.
  const z = 1.96, d = 1 + z * z / n;
  const c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  return { n, pnl: +pnl.toFixed(2), roi: +(pnl / staked * 100).toFixed(2), win: +(win * 100).toFixed(1),
           avgEntry: +avgEntry.toFixed(4), margin: +((win - avgEntry) * 100).toFixed(2),
           lo95: +((c - hw) * 100).toFixed(1), hi95: +((c + hw) * 100).toFixed(1), maxDD: +dd.toFixed(2) };
}

const ms = load();
console.log(`markets: ${ms.length}   range ${new Date(ms[0].c).toISOString().slice(0, 10)} .. ${new Date(ms[ms.length - 1].c).toISOString().slice(0, 10)}`);
console.log(`YES base rate: ${(ms.filter(m => m.r === 1).length / ms.length * 100).toFixed(2)}%`);

const BANDS = [[0.55, 0.65], [0.60, 0.70], [0.65, 0.75], [0.70, 0.80], [0.75, 0.85],
               [0.80, 0.90], [0.85, 0.95], [0.90, 0.97], [0.90, 0.99], [0.95, 0.99],
               [0.60, 0.99], [0.75, 0.99], [0.55, 0.99]];
console.log('\nbuy the DEAR side, hold to settle, minutes 5..13, one entry per round, 100 contracts');
console.log('\nband        n     avgEnt   win%   [95% CI]      margin   ROI%    PnL$      maxDD$  | h1 ROI  h2 ROI');
const out = [];
for (const [lo, hi] of BANDS) {
  const ts = [];
  for (const m of ms) {
    const e = firstEntry(m, lo, hi, 2, 10);
    if (!e) continue;
    const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
    const cost = SIZE * e.px + takerFee(SIZE, e.px);
    ts.push({ sym: m.s, close: m.c, side: e.side, px: e.px, left: e.left, won,
              cost: +cost.toFixed(4), pnl: +((won ? SIZE : 0) - cost).toFixed(4) });
  }
  const s = stats(ts);
  if (!s || s.n < 40) continue;
  const mid = Math.floor(ts.length / 2);
  const h1 = stats(ts.slice(0, mid)), h2 = stats(ts.slice(mid));
  out.push({ lo, hi, s, h1, h2, sides: { YES: ts.filter(t => t.side === 'YES').length, NO: ts.filter(t => t.side === 'NO').length } });
  console.log(`${lo.toFixed(2)}-${hi.toFixed(2)} ${String(s.n).padStart(6)} ${String(s.avgEntry).padStart(7)} ${String(s.win).padStart(6)} [${String(s.lo95).padStart(5)},${String(s.hi95).padStart(5)}] ${String(s.margin).padStart(8)} ${String(s.roi).padStart(7)} ${String(s.pnl).padStart(9)} ${String(s.maxDD).padStart(9)}  | ${String(h1 ? h1.roi : '-').padStart(7)} ${String(h2 ? h2.roi : '-').padStart(7)}`);
}
fs.writeFileSync(path.join(__dirname, 'favtest.json'), JSON.stringify({ at: Date.now(), markets: ms.length, out }, null, 1));
console.log('\nside split (a lopsided split means the band is a directional bet, not an edge):');
for (const r of out) console.log(`  ${r.lo.toFixed(2)}-${r.hi.toFixed(2)}  YES ${r.sides.YES}  NO ${r.sides.NO}`);
console.log('\n-> favtest.json');
