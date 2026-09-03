'use strict';
/**
 * Trades per day again, with two flaws in the last count fixed.
 *
 * FLAW 1 — the three presets were measured on three DIFFERENT window sets. Passive needs its five coins
 * present, Aggro all seven, so they ran on 1,233 / 1,141 / 1,130 windows and the comparison between them
 * was never apples to apples. Everything below runs on the one set of windows where all seven coins are
 * present, then applies each preset's coin list to it.
 *
 * FLAW 2 — Passive came out AHEAD of Neutral at every stake (+$21.35 against +$14.25 a day at 12
 * contracts) on fewer trades. More trades earning less money is either a mistake or a finding, and the
 * candidate explanation is structural: Passive's maxOpen of 1 takes only the FIRST direction a window
 * offers, while Neutral and Aggro also take the second. If a window's second direction is worse than its
 * first, then maxOpen above 1 is buying negative trades, which is the opposite of what the preset ladder
 * assumes. That is measured here directly rather than argued.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, LO = 0.85, HI = 0.90;
const ALL = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const PRESETS = {
  Passive: { coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'], minLeft: 7, maxLeft: 12, maxOpen: 1 },
  Neutral: { coins: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE'], minLeft: 7, maxLeft: 12, maxOpen: 3 },
  Aggro: { coins: ALL.slice(), minLeft: 6, maxLeft: 12, maxOpen: 6 }
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

// The common window set: every window where all seven coins were fetched.
const byWinAll = new Map();
for (const m of rows) {
  const k = String(m.c);
  if (!byWinAll.has(k)) byWinAll.set(k, []);
  byWinAll.get(k).push(m);
}
const complete = [...byWinAll.entries()].filter(([, ms]) => new Set(ms.map(m => m.s)).size === 7)
  .sort((a, b) => Number(a[0]) - Number(b[0]));
console.log(`complete 7-coin windows in the corpus: ${complete.length}`);
console.log(`spanning ${new Date(Number(complete[0][0])).toISOString().slice(0, 10)} .. ${new Date(Number(complete[complete.length - 1][0])).toISOString().slice(0, 10)}\n`);

/** First in-band minute for one market under one clock, or null. */
function signal(m, minLeft, maxLeft) {
  for (const row of m.p) {
    const L = row[0];
    if (L > maxLeft) continue;
    if (L < minLeft) break;
    const ask = row[1], bid = row[2];
    const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
    const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
    if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
    const no = +(1 - b).toFixed(4);
    if (a >= LO && a <= HI) return { side: 'YES', px: a, left: L, sym: m.s, close: m.c, won: m.r === 1 };
    if (no >= LO && no <= HI) return { side: 'NO', px: no, left: L, sym: m.s, close: m.c, won: m.r === 0 };
    // Keep scanning. Bailing here would test only the first minute of the window instead of the whole of
    // it, which is a different and far rarer event: it cut 3,800 signals to 229 and made every preset look
    // like a loss.
  }
  return null;
}
function stat(ts) {
  const n = ts.length; if (!n) return null;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  return { n, win, px, be, edge: win - be, lo95: c - hw };
}

// ── the anomaly first: is a window's SECOND direction worth taking? ──
const firsts = [], seconds = [];
for (const [, ms] of complete) {
  const sigs = ms.map(m => signal(m, 6, 12)).filter(Boolean).sort((a, b) => b.left - a.left);
  const seen = new Set();
  let rank = 0;
  for (const s of sigs) {
    if (seen.has(s.side)) continue;
    seen.add(s.side);
    (rank === 0 ? firsts : seconds).push(s);
    rank++;
    if (rank >= 2) break;
  }
}
const F = stat(firsts), S = stat(seconds);
console.log('=== is the second direction in a window worth taking? (all 7 coins, T-12..T-6) ===');
for (const [nm, r] of [['1st direction taken', F], ['2nd direction taken', S]]) {
  console.log(`  ${nm}  n=${String(r.n).padStart(4)}  price ${(r.px * 100).toFixed(2)}c  win ${(r.win * 100).toFixed(2)}%  b/e ${(r.be * 100).toFixed(2)}%  edge ${(r.edge * 100).toFixed(2)}pp  CI-low ${(r.lo95 * 100).toFixed(2)}%`);
}
console.log(`  -> the second position is ${((S.edge - F.edge) * 100).toFixed(2)}pp ${S.edge < F.edge ? 'WORSE' : 'better'} than the first`);
console.log(`  -> maxOpen above 1 is ${S.edge > 0 ? 'still profitable, just thinner' : 'ADDING LOSING TRADES'}\n`);

// ── the presets, on one common window set ──
console.log('=== all three presets on the SAME 7-coin windows ===');
console.log('preset    maxDir  trades  /window  PER DAY  win%    edge      12-ctr $/day');
const out = {};
for (const [name, p] of Object.entries(PRESETS)) {
  const maxDir = Math.min(p.maxOpen, 2);
  const ts = [];
  for (const [, ms] of complete) {
    const sigs = ms.filter(m => p.coins.includes(m.s)).map(m => signal(m, p.minLeft, p.maxLeft))
      .filter(Boolean).sort((a, b) => b.left - a.left);
    const seen = new Set();
    for (const s of sigs) {
      if (seen.has(s.side)) continue;
      seen.add(s.side);
      ts.push(s);
      if (seen.size >= maxDir) break;
    }
  }
  const r = stat(ts);
  const perDay = r.n / complete.length * 96;
  const ev = c => (r.win * c) - (c * r.px + takerFee(c, r.px));
  out[name] = { r, perDay, ev };
  console.log(`${name.padEnd(9)} ${String(maxDir).padStart(6)} ${String(r.n).padStart(7)} ${(r.n / complete.length).toFixed(2).padStart(8)} ${perDay.toFixed(0).padStart(8)} ${(r.win * 100).toFixed(2).padStart(6)} ${(r.edge * 100).toFixed(2).padStart(7)}pp ${('+$' + (ev(12) * perDay).toFixed(2)).padStart(13)}`);
}

// And the same three with maxOpen forced to 1, to price the second position in dollars.
console.log('\n=== the same presets, one direction per window only ===');
console.log('preset    trades  PER DAY  win%    edge      12-ctr $/day');
for (const [name, p] of Object.entries(PRESETS)) {
  const ts = [];
  for (const [, ms] of complete) {
    const sigs = ms.filter(m => p.coins.includes(m.s)).map(m => signal(m, p.minLeft, p.maxLeft))
      .filter(Boolean).sort((a, b) => b.left - a.left);
    if (sigs.length) ts.push(sigs[0]);
  }
  const r = stat(ts);
  const perDay = r.n / complete.length * 96;
  const ev = c => (r.win * c) - (c * r.px + takerFee(c, r.px));
  console.log(`${name.padEnd(9)} ${String(r.n).padStart(7)} ${perDay.toFixed(0).padStart(8)} ${(r.win * 100).toFixed(2).padStart(6)} ${(r.edge * 100).toFixed(2).padStart(7)}pp ${('+$' + (ev(12) * perDay).toFixed(2)).padStart(13)}`);
}

console.log('\n=== dollars per DAY, flat stake, on the best of the above ===');
console.log('preset    trades/day    1 ctr     3 ctr     5 ctr     8 ctr    12 ctr');
for (const [name, o] of Object.entries(out)) {
  const cell = c => `+$${(o.ev(c) * o.perDay).toFixed(2)}`.padStart(9);
  console.log(`${name.padEnd(9)} ${o.perDay.toFixed(0).padStart(10)} ${cell(1)} ${cell(3)} ${cell(5)} ${cell(8)} ${cell(12)}`);
}
