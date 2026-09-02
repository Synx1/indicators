'use strict';
/**
 * A bounded first read on the five commodity 15-minute series.
 *
 * Deliberately small — 700 markets, a few minutes — because the question is binary: does the favourite
 * band exist outside crypto at all? A full 19,327-market fetch is only worth doing if the answer is yes,
 * and if the answer is no then metals and energy are off the table and the seven-coin book is the whole
 * product. Spread across each series' date range so this is not one afternoon of one week.
 */
const fs = require('fs');
const { get, takerFee } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const PER = 350, CONC = 8;
const SYMS = ['NEAR', 'ZEC'];
const num = v => (v == null ? NaN : Number(v));
const sideOf = s => {
  if (!s) return null;
  const lo = num(s.low_dollars), hi = num(s.high_dollars), cl = num(s.close_dollars);
  return [Number.isFinite(lo) ? lo : null, Number.isFinite(hi) ? hi : null, Number.isFinite(cl) ? cl : null];
};
(async () => {
  const mk = JSON.parse(fs.readFileSync('markets2.json', 'utf8'));
  const jobs = [];
  for (const sym of SYMS) {
    const rows = (mk[sym] || []).slice().sort((a, b) => a[1] - b[1]);
    const step = Math.max(1, Math.floor(rows.length / PER));
    for (let i = 0; i < rows.length && jobs.filter(j => j[0] === sym).length < PER; i += step) jobs.push([sym, rows[i]]);
  }
  console.log(`fetching ${jobs.length} commodity market paths...`);
  const out = [];
  let i = 0, bad = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < jobs.length) {
      const [sym, r] = jobs[i++];
      const closeS = Math.floor(r[1] / 1000);
      try {
        const j = await get(`${BASE}/series/KX${sym}15M/markets/${r[0]}/candlesticks?start_ts=${closeS - 16 * 60}&end_ts=${closeS + 60}&period_interval=1`);
        const p = [];
        for (const c of (j.candlesticks || [])) {
          const left = Math.round((closeS - c.end_period_ts) / 60);
          if (left < 0) continue;
          p.push([left, sideOf(c.yes_ask), sideOf(c.yes_bid)]);
        }
        if (p.length) out.push({ s: sym, c: r[1], r: r[3], p });
      } catch (_) { bad++; }
    }
  }));
  fs.writeFileSync('comm2.jsonl', out.map(o => JSON.stringify(o)).join('\n'));
  console.log(`${out.length} paths, ${bad} failed\n`);

  // Same gate, same fee, same grading as the crypto measurement — nothing tuned for this data.
  const LO = 0.85, HI = 0.90;
  function test(rows, minL, maxL) {
    const ts = [];
    for (const m of rows) {
      const path = m.p.slice().sort((a, b) => b[0] - a[0]);
      let e = null;
      for (const row of path) {
        const left = row[0];
        if (left > maxL) continue;
        if (left < minL) break;
        const a = row[1] && row[1][2], b = row[2] && row[2][2];
        if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
        const no = +(1 - b).toFixed(4);
        if (a >= LO && a <= HI) { e = { side: 'YES', px: a, left }; break; }
        if (no >= LO && no <= HI) { e = { side: 'NO', px: no, left }; break; }
      }
      if (!e) continue;
      const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
      ts.push({ px: e.px, won, side: e.side, sym: m.s });
    }
    const n = ts.length; if (!n) return null;
    const win = ts.filter(t => t.won).length / n;
    const px = ts.reduce((a, t) => a + t.px, 0) / n;
    const be = px + 0.07 * px * (1 - px);
    const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
    const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
    return { n, win: +(win * 100).toFixed(2), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
             edge: +((win - be) * 100).toFixed(2), lo95: +((c - hw) * 100).toFixed(2),
             yes: ts.filter(t => t.side === 'YES').length, no: n - ts.filter(t => t.side === 'YES').length };
  }
  const all = test(out, 6, 12);
  console.log(`=== 85-90c, T-12..T-6, commodities pooled ===`);
  if (all) console.log(`  n=${all.n} of ${out.length} markets (fire ${(all.n / out.length * 100).toFixed(0)}%)  price ${all.px}c  win ${all.win}% [CI low ${all.lo95}]  b/e ${all.be}  EDGE ${all.edge}pp   YES/NO ${all.yes}/${all.no}`);
  console.log('\nper series:');
  for (const sym of SYMS) {
    const t = test(out.filter(o => o.s === sym), 6, 12);
    if (t) console.log(`  ${sym.padEnd(7)} n=${String(t.n).padStart(3)}  fire ${(t.n / out.filter(o => o.s === sym).length * 100).toFixed(0).padStart(3)}%  price ${t.px}c  win ${String(t.win).padStart(6)}%  edge ${String(t.edge).padStart(7)}pp`);
  }
})();
