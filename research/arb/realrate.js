'use strict';
/**
 * What the bot will actually take, once the risk guards have had their say.
 *
 * Every projection so far counted SIGNALS. The bot does not trade signals, it trades what survives
 * accountBlock, which allows one position per round and — the binding one — ONE DIRECTION PER SETTLEMENT
 * WINDOW. Seven coins move together, so a window where crypto is up offers six YES favourites and the
 * guard takes exactly one of them. That guard is not negotiable: it is what stopped the correlated double
 * that took $100 to $35.62 on 2026-08-26.
 *
 * So the honest trade count is the number of DIRECTIONS available per window, not the number of coins in
 * band, and it changes the dollar answer by roughly half.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, LO = 0.85, HI = 0.90;

const rows = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  r.p.sort((a, b) => b[0] - a[0]);
  rows.push(r);
}
rows.sort((a, b) => a.c - b.c);

const sig = [];
for (const m of rows) {
  for (const row of m.p) {
    const L = row[0];
    if (L > 12) continue;
    if (L < 6) break;
    const ask = row[1], bid = row[2];
    const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
    const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
    if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
    const no = +(1 - b).toFixed(4);
    let e = null;
    if (a >= LO && a <= HI) e = { side: 'YES', px: a };
    else if (no >= LO && no <= HI) e = { side: 'NO', px: no };
    if (!e) continue;
    sig.push({ sym: m.s, close: m.c, left: L, side: e.side, px: e.px,
               won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
    break;
  }
}

// Group by settlement window and keep the FIRST signal per direction — earliest minute wins, which is
// what a forward-scanning bot does.
const byWin = new Map();
for (const s of sig) {
  const k = String(s.close);
  if (!byWin.has(k)) byWin.set(k, []);
  byWin.get(k).push(s);
}
const taken = [];
let dirCounts = [0, 0, 0];
for (const [, ws] of byWin) {
  ws.sort((a, b) => b.left - a.left);
  const seen = new Set();
  let n = 0;
  for (const s of ws) {
    if (seen.has(s.side)) continue;
    seen.add(s.side);
    taken.push(s);
    n++;
    if (n >= 3) break;                       // maxOpen
  }
  dirCounts[Math.min(2, seen.size)]++;
}
taken.sort((a, b) => a.close - b.close);

const windows = byWin.size;
console.log(`markets ${rows.length}   in-band signals ${sig.length}   settlement windows with a signal ${windows}`);
console.log(`  windows offering 1 direction: ${dirCounts[1]}   both directions: ${dirCounts[2]}`);
console.log(`  signals per window offered ${(sig.length / windows).toFixed(2)}  ->  TAKEN ${(taken.length / windows).toFixed(2)}`);
console.log(`  the guard discards ${(100 - taken.length / sig.length * 100).toFixed(0)}% of signals as correlated duplicates\n`);

function tally(ts, label) {
  const n = ts.length;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  const pnl = ts.reduce((a, t) => a + ((t.won ? 100 : 0) - (100 * t.px + takerFee(100, t.px))), 0);
  const staked = ts.reduce((a, t) => a + 100 * t.px + takerFee(100, t.px), 0);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  console.log(`${label.padEnd(34)} n=${String(n).padStart(5)}  price ${(px * 100).toFixed(2)}  win ${(win * 100).toFixed(2)}%  b/e ${(be * 100).toFixed(2)}  edge ${((win - be) * 100).toFixed(2)}pp  CI-low ${((c - hw) * 100).toFixed(2)}  ROI ${(pnl / staked * 100).toFixed(3)}%`);
  const k = Math.floor(n / 2);
  const q = s => { const w = s.filter(t => t.won).length / s.length, p = s.reduce((a, t) => a + t.px, 0) / s.length;
    return ((w - (p + 0.07 * p * (1 - p))) * 100).toFixed(2); };
  console.log(`${''.padEnd(34)} halves ${q(ts.slice(0, k))} / ${q(ts.slice(k))}pp`);
  return { n, win, px, be };
}
const A = tally(sig, 'every in-band signal');
const B = tally(taken, 'what the guards actually allow');

// The clock the bot lives on: 96 settlement windows a day, so trades per hour follows directly.
const days = (rows[rows.length - 1].c - rows[0].c) / 86400e3;
const sampleFrac = rows.length / 45030;
console.log(`\nrate, corrected for the ${(sampleFrac * 100).toFixed(0)}% corpus sample:`);
console.log(`  taken per window ${(taken.length / windows).toFixed(2)}  ->  ${(taken.length / windows * 4).toFixed(1)} per hour  ->  ${(taken.length / windows * 4 * 9).toFixed(0)} in a 9-hour session`);
const evPer = c => (B.win * c) - (c * B.px + takerFee(c, B.px));
console.log(`\n$50, 9 hours, at the allowed rate (${(taken.length / windows * 4 * 9).toFixed(0)} trades):`);
for (const c of [3, 5, 8, 12]) {
  const t = taken.length / windows * 4 * 9;
  console.log(`  ${String(c).padStart(2)} contracts -> expected +$${(evPer(c) * t).toFixed(2)}  (final $${(50 + evPer(c) * t).toFixed(2)})`);
}
