'use strict';
/**
 * Open interest, the one signal in the candles this project has never stored.
 *
 * ── why it is a different thing from volume ──
 *
 * Volume says how much traded. Open interest says how much is still HELD. The difference separates two
 * events that look identical on a price chart: a rally on rising OI is new money taking a side, and a rally
 * on falling OI is somebody closing a losing position. The first is a fresh opinion; the second is a
 * forced exit. If informed size is committing rather than covering, OI is where it shows up, and it is not
 * something the earlier order-flow test could see — that measured traded quantity and its direction, not
 * whether the resulting positions stayed open.
 *
 * Bounded to 1,200 markets. The point is whether the signal exists at all; if it does, the full corpus is
 * worth re-fetching with OI stored, and if it does not, nothing has been spent finding out.
 */
const fs = require('fs');
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const num = v => (v == null ? NaN : Number(v));

(async () => {
  const mk = JSON.parse(fs.readFileSync('../corpus2/markets.json', 'utf8'));
  const jobs = [];
  for (const sym of ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE']) {
    const rows = (mk[sym] || []).slice().sort((a, b) => a[1] - b[1]);
    const step = Math.max(1, Math.floor(rows.length / 200));
    for (let i = 0; i < rows.length && jobs.filter(j => j[0] === sym).length < 200; i += step) jobs.push([sym, rows[i]]);
  }
  console.log(`fetching ${jobs.length} markets with open interest...`);
  const out = [];
  let i = 0, bad = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < jobs.length) {
      const [sym, r] = jobs[i++];
      const closeS = Math.floor(r[1] / 1000);
      try {
        const j = await get(`${BASE}/series/KX${sym}15M/markets/${r[0]}/candlesticks?start_ts=${closeS - 16 * 60}&end_ts=${closeS + 60}&period_interval=1`);
        const p = [];
        for (const c of (j.candlesticks || [])) {
          const left = Math.round((closeS - c.end_period_ts) / 60);
          if (left < 0) continue;
          const ask = c.yes_ask && num(c.yes_ask.close_dollars);
          const bid = c.yes_bid && num(c.yes_bid.close_dollars);
          p.push([left, ask, bid, num(c.open_interest_fp), num(c.volume_fp)]);
        }
        if (p.length) out.push({ s: sym, c: r[1], r: r[3], p });
      } catch (_) { bad++; }
    }
  }));
  console.log(`${out.length} markets, ${bad} failed\n`);

  // Rows at the entry window, with the OI trend leading into them.
  const rows = [];
  for (const m of out) {
    const byLeft = new Map();
    for (const q of m.p) byLeft.set(q[0], q);
    for (let L = 12; L >= 7; L--) {
      const q = byLeft.get(L), q1 = byLeft.get(L + 1), q2 = byLeft.get(L + 2);
      if (!q || !q1 || !q2) continue;
      const [, ask, bid, oi, vol] = q;
      if (!(ask > 0 && ask < 1 && bid > 0 && bid < 1) || ask < bid) continue;
      const no = +(1 - bid).toFixed(4);
      let side = null, px = null;
      if (ask >= 0.85 && ask <= 0.90) { side = 'YES'; px = ask; }
      else if (no >= 0.85 && no <= 0.90) { side = 'NO'; px = no; }
      if (!side) continue;
      const oi1 = q1[3], oi2 = q2[3];
      if (!(oi > 0) || !(oi1 > 0)) continue;
      // Relative OI change, so a $2M BTC book and a small DOGE one are comparable.
      const dOI = +((oi - oi1) / oi1).toFixed(5);
      const dOI2 = oi2 > 0 ? +((oi - oi2) / oi2).toFixed(5) : null;
      rows.push({ sym: m.s, close: m.c, left: L, side, px, dOI, dOI2,
                  vol: vol > 0 ? vol : 0, won: side === 'YES' ? m.r === 1 : m.r === 0 });
      break;
    }
  }
  console.log(`entries in 85-90c with OI history: ${rows.length}`);
  const score = rs => {
    const n = rs.length; if (n < 60) return null;
    const win = rs.filter(r => r.won).length / n;
    const px = rs.reduce((a, r) => a + r.px, 0) / n;
    const be = px + 0.07 * px * (1 - px);
    return { n, win, edge: (win - be) * 100 };
  };
  const base = score(rows);
  console.log(`baseline: win ${(base.win * 100).toFixed(2)}%  edge ${base.edge.toFixed(2)}pp\n`);
  console.log('by open-interest change over the minute before entry');
  const qs = rows.map(r => r.dOI).sort((a, b) => a - b);
  const cut = p => qs[Math.floor(p * qs.length)];
  const bands = [[-Infinity, cut(0.25)], [cut(0.25), cut(0.5)], [cut(0.5), cut(0.75)], [cut(0.75), Infinity]];
  const NAME = ['falling / flat', 'slightly up', 'up', 'up hard'];
  bands.forEach(([lo, hi], k) => {
    const s = score(rows.filter(r => r.dOI >= lo && r.dOI < hi));
    if (s) console.log(`  ${NAME[k].padEnd(16)} n=${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(2)}%  edge ${s.edge.toFixed(2).padStart(6)}pp`);
  });
  fs.writeFileSync('oitest.json', JSON.stringify({ n: rows.length, base }, null, 1));
})();
