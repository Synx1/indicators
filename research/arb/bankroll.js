'use strict';
/**
 * What $10 actually does, with the correlation left in.
 *
 * ── the two things that decide this, neither of which is the edge ──
 *
 * 1. THE CENT. At 88¢ and one contract, Kalshi's fee rounds UP from 0.74¢ to a whole cent. That
 *    rounding alone costs 0.30 points of the 1.0-point edge. A $10 account cannot buy its way out of
 *    it, and a $1,000 account never notices it. The edge is the same; the account is not.
 *
 * 2. CORRELATION. Seven coins settle in the SAME fifteen-minute window and crypto moves together, so
 *    seven entries in one window are not seven independent bets. At 88¢ one loss undoes eight wins, so
 *    a window that goes wrong on six coins at once is the whole account. This simulator therefore
 *    replays real windows in real order rather than shuffling trades, which is the only way the
 *    correlation survives into the answer.
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
  trades.push({ sym: m.s, close: m.c, side: e.side, px: e.px,
                won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
}
trades.sort((a, b) => a.close - b.close);
console.log(`signals: ${trades.length} over ${ms.length} markets`);

// ── how correlated is a window? ──
const byWin = new Map();
for (const t of trades) {
  const k = String(t.close);
  if (!byWin.has(k)) byWin.set(k, []);
  byWin.get(k).push(t);
}
let both = 0, tot = 0, sameCnt = 0;
const winLoss = [];
for (const [, ts] of byWin) {
  if (ts.length < 2) continue;
  const w = ts.filter(t => t.won).length;
  winLoss.push([ts.length, w]);
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { tot++; if (ts[i].won === ts[j].won) both++; }
  if (w === 0) sameCnt++;
}
const p = trades.filter(t => t.won).length / trades.length;
console.log(`\nwindows with 2+ signals: ${winLoss.length}`);
console.log(`  pairs in the same window agreeing: ${(both / tot * 100).toFixed(1)}%   (independent would be ${((p * p + (1 - p) * (1 - p)) * 100).toFixed(1)}%)`);
console.log(`  windows where EVERY signal lost: ${sameCnt} of ${winLoss.length} = ${(sameCnt / winLoss.length * 100).toFixed(1)}%`);
const wipe = winLoss.filter(([n, w]) => n >= 4 && w === 0).length;
console.log(`  windows with 4+ signals that ALL lost: ${wipe}`);

/**
 * Replay the book. `frac` is the share of bankroll risked per SIGNAL, `cap` the most a single window may
 * risk in total — the only defence against a window that goes wrong on every coin at once.
 */
function replay(bank0, frac, cap, maxPerWindow) {
  let bank = bank0, peak = bank0, dd = 0, n = 0, ruin = false;
  const keys = [...byWin.keys()].sort((a, b) => Number(a) - Number(b));
  for (const k of keys) {
    let spentThisWindow = 0;
    let taken = 0;
    for (const t of byWin.get(k)) {
      if (taken >= maxPerWindow) break;
      // Size to the fraction, but a fraction that rounds to zero contracts is not "no bet" — on a $10
      // account one contract at 88¢ IS 8.8% of the bankroll, so the minimum tradeable size and the Kelly
      // size are the same thing. Trading one contract whenever the window cap still has room for it is
      // what the account can actually do; refusing it because 0.9 contracts is the "correct" size stalls
      // the book forever the moment the bankroll dips.
      const room = bank * cap - spentThisWindow;
      if (room < t.px) continue;
      const contracts = Math.max(1, Math.floor(bank * frac / t.px));
      if (contracts * t.px > room) continue;
      const cost = contracts * t.px + takerFee(contracts, t.px);
      if (cost > bank) continue;
      bank -= cost;
      if (t.won) bank += contracts;
      spentThisWindow += cost;
      taken++; n++;
      if (bank > peak) peak = bank;
      if (peak - bank > dd) dd = peak - bank;
      if (bank < 1) { ruin = true; break; }
    }
    if (ruin) break;
  }
  return { bank: +bank.toFixed(2), n, dd: +dd.toFixed(2), ddPct: +(dd / peak * 100).toFixed(1), ruin,
           mult: +(bank / bank0).toFixed(3) };
}

console.log('\n=== $10, whole 68-day book replayed in real order ===');
console.log('perSignal  windowCap  maxPerWin    trades   final$   x     maxDD$  maxDD%  ruined');
for (const [frac, cap, mpw] of [[0.09, 0.09, 1], [0.09, 0.18, 2], [0.09, 0.27, 3],
                                 [0.05, 0.10, 2], [0.05, 0.15, 3], [0.03, 0.09, 3],
                                 [0.20, 0.20, 1], [0.50, 0.50, 1], [1.0, 1.0, 1]]) {
  const r = replay(10, frac, cap, mpw);
  console.log(`   ${(frac * 100).toFixed(0).padStart(3)}%      ${(cap * 100).toFixed(0).padStart(3)}%        ${String(mpw).padStart(2)}      ${String(r.n).padStart(6)}  ${String(r.bank).padStart(8)} ${String(r.mult).padStart(6)} ${String(r.dd).padStart(8)} ${String(r.ddPct).padStart(7)}  ${r.ruin ? 'YES' : 'no'}`);
}
console.log('\n=== the same rules on a bankroll the cent rounding cannot reach ===');
for (const b0 of [100, 1000, 5000]) {
  const r = replay(b0, 0.09, 0.18, 2);
  console.log(`  $${String(b0).padStart(5)} -> $${String(r.bank).padStart(10)}  (${r.mult}x)  ${r.n} trades  maxDD ${r.ddPct}%  ${r.ruin ? 'RUINED' : ''}`);
}
