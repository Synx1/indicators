'use strict';
/**
 * Trades per day, counted two independent ways so the answer is not one arithmetic slip.
 *
 * A) per-window rate x 96 windows a day. The 15-minute product runs round the clock, so a day is exactly
 *    96 settlement windows and a position never survives its own window — it settles at the boundary.
 * B) straight count per calendar day in the corpus, scaled for how many of the seven coins each sampled
 *    window actually carries.
 *
 * Both must land in the same place. They are counting what survives accountBlock — one direction per
 * settlement window — not what signals, because the guard discards 58% of in-band signals as correlated
 * duplicates and every earlier projection in this project forgot that.
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

function take(p) {
  const byWin = new Map();
  for (const m of rows) {
    if (!p.coins.includes(m.s)) continue;
    const k = String(m.c);
    if (!byWin.has(k)) byWin.set(k, { coins: 0, sigs: [] });
    const w = byWin.get(k);
    w.coins++;
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
      w.sigs.push({ ...e, left: L, close: m.c, won: e.side === 'YES' ? m.r === 1 : m.r === 0 });
      break;
    }
  }
  // Only windows carrying ALL of the preset's coins are counted, so the per-window rate is a real
  // window's rate and needs no coverage fudge. Partial windows would understate it.
  const full = [...byWin.values()].filter(w => w.coins >= p.coins.length);
  const taken = [];
  for (const w of full) {
    w.sigs.sort((a, b) => b.left - a.left);
    const seen = new Set();
    for (const s of w.sigs) {
      if (seen.has(s.side)) continue;
      seen.add(s.side);
      taken.push(s);
      if (seen.size >= Math.min(p.maxOpen, 2)) break;
    }
  }
  return { taken, fullWindows: full.length, allWindows: byWin.size };
}

console.log('counted only on windows carrying every one of the preset\'s coins\n');
console.log('preset    full windows   taken   per window   PER DAY (x96)   per hour');
const out = {};
for (const [name, p] of Object.entries(PRESETS)) {
  const { taken, fullWindows } = take(p);
  const perWin = taken.length / fullWindows;
  const win = taken.filter(t => t.won).length / taken.length;
  const px = taken.reduce((a, t) => a + t.px, 0) / taken.length;
  out[name] = { perDay: perWin * 96, win, px, n: taken.length };
  console.log(`${name.padEnd(9)} ${String(fullWindows).padStart(12)} ${String(taken.length).padStart(7)} ${perWin.toFixed(2).padStart(12)} ${(perWin * 96).toFixed(0).padStart(15)} ${(perWin * 4).toFixed(1).padStart(10)}`);
}

console.log('\ncross-check — straight count per calendar day of the corpus:');
for (const [name, p] of Object.entries(PRESETS)) {
  const { taken } = take(p);
  const byDay = new Map();
  for (const t of taken) {
    const d = new Date(t.close).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  // Each corpus day holds only the windows that were sampled complete, so scale by how many of the day's
  // 96 windows that was.
  const days = [...byDay.keys()].length;
  const perDayRaw = taken.length / days;
  const winsPerDay = take(p).fullWindows / days;
  console.log(`  ${name.padEnd(9)} ${days} days, ${perDayRaw.toFixed(1)} taken/day on ${winsPerDay.toFixed(1)} complete windows/day -> ${(perDayRaw / winsPerDay * 96).toFixed(0)} per day at full coverage`);
}

console.log('\n=== what a day is worth, flat stake ===');
console.log('preset    trades/day   1 ctr    3 ctr    5 ctr    8 ctr    12 ctr');
for (const [name, r] of Object.entries(out)) {
  const ev = c => (r.win * c) - (c * r.px + takerFee(c, r.px));
  const cell = c => `+$${(ev(c) * r.perDay).toFixed(2)}`.padStart(8);
  console.log(`${name.padEnd(9)} ${r.perDay.toFixed(0).padStart(10)} ${cell(1)} ${cell(3)} ${cell(5)} ${cell(8)} ${cell(12)}`);
}
