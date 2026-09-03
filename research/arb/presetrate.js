'use strict';
/**
 * Trades per hour and dollars per session for each preset, with the risk guards left in.
 *
 * Every projection before this one counted SIGNALS. The bot does not trade signals — it trades what
 * survives accountBlock, whose binding rule is ONE DIRECTION PER SETTLEMENT WINDOW. Six or seven coins
 * move together, so a window where crypto is up offers five YES favourites and the guard takes one. That
 * guard is not up for negotiation: it is what stopped the correlated double that took $100 to $35.62.
 *
 * So the honest count is directions available per window, capped by maxOpen — not coins in band.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, LO = 0.85, HI = 0.90;

const PRESETS = {
  Passive: { coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'], minLeft: 7, maxLeft: 12, maxOpen: 1 },
  Neutral: { coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE'], minLeft: 7, maxLeft: 12, maxOpen: 3 },
  Aggro: { coins: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'], minLeft: 6, maxLeft: 12, maxOpen: 6 }
};

const rows = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  r.p.sort((a, b) => b[0] - a[0]);
  rows.push(r);
}
rows.sort((a, b) => a.c - b.c);
// How complete the sampled windows are, so a per-window rate can be scaled to a live 7-coin window.
const winSet = new Set(rows.map(r => String(r.c)));
const coverage = rows.length / winSet.size;

function signalsFor(p) {
  const out = [];
  for (const m of rows) {
    if (!p.coins.includes(m.s)) continue;
    for (const row of m.p) {
      const L = row[0];
      if (L > p.maxLeft) continue;
      if (L < p.minLeft) break;
      const ask = row[1], bid = row[2];
      const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
      const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
      if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
      const no = +(1 - b).toFixed(4);
      let e = null;
      if (a >= LO && a <= HI) e = { side: 'YES', px: a };
      else if (no >= LO && no <= HI) e = { side: 'NO', px: no };
      if (!e) continue;
      out.push({ sym: m.s, close: m.c, left: L, side: e.side, px: e.px,
                 won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
      break;
    }
  }
  return out;
}
function allowed(sig, p) {
  const byWin = new Map();
  for (const s of sig) {
    const k = String(s.close);
    if (!byWin.has(k)) byWin.set(k, []);
    byWin.get(k).push(s);
  }
  const taken = [];
  for (const [, ws] of byWin) {
    ws.sort((a, b) => b.left - a.left);      // earliest minute first, as a forward scan finds them
    const seen = new Set();
    for (const s of ws) {
      if (seen.has(s.side)) continue;        // one direction per settlement window
      seen.add(s.side);
      taken.push(s);
      if (seen.size >= p.maxOpen) break;
    }
  }
  return { taken: taken.sort((a, b) => a.close - b.close), windows: byWin.size };
}

console.log(`corpus ${rows.length} markets over ${winSet.size} windows (${coverage.toFixed(1)} of 7 coins per window)\n`);
console.log('preset    coins clock      signals  taken  per window  /hour  9h    win%    edge     ROI%');
const out = {};
for (const [name, p] of Object.entries(PRESETS)) {
  const sig = signalsFor(p);
  const { taken, windows } = allowed(sig, p);
  const n = taken.length;
  const win = taken.filter(t => t.won).length / n;
  const px = taken.reduce((a, t) => a + t.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  // Scale the per-window rate to a full live window: only the coins present can signal, and the corpus
  // carries ~5.6 of them.
  const perWin = n / windows * (p.coins.length / Math.min(p.coins.length, coverage));
  const perHour = perWin * 4;
  out[name] = { win, px, be, perHour, edge: (win - be) };
  console.log(`${name.padEnd(9)} ${String(p.coins.length).padStart(3)}   T-${p.maxLeft}..T-${p.minLeft} ${String(sig.length).padStart(8)} ${String(n).padStart(6)} ${perWin.toFixed(2).padStart(11)} ${perHour.toFixed(1).padStart(6)} ${(perHour * 9).toFixed(0).padStart(4)} ${(win * 100).toFixed(2).padStart(7)} ${((win - be) * 100).toFixed(2).padStart(7)}pp ${((win - px - (be - px)) / px * 100).toFixed(2).padStart(7)}`);
}

console.log('\n=== $50 over 9 hours, at the rate the guards actually allow ===');
console.log('preset    trades   3 contracts   5 contracts   8 contracts   12 contracts');
for (const [name, r] of Object.entries(out)) {
  const t = r.perHour * 9;
  const ev = c => (r.win * c) - (c * r.px + takerFee(c, r.px));
  const cell = c => `$${(50 + ev(c) * t).toFixed(2)}`.padStart(13);
  console.log(`${name.padEnd(9)} ${t.toFixed(0).padStart(6)} ${cell(3)} ${cell(5)} ${cell(8)} ${cell(12)}`);
}
console.log('\nmaxOpen caps how many DIRECTIONS a window can hold, and there are only two, so');
console.log('anything above maxOpen 2 buys nothing — the fleet ceiling of 3 is already past the limit.');
