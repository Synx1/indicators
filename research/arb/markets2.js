'use strict';
/** Settled markets for the seven 15-minute series the bot does NOT trade. Strike/close/result only. */
const fs = require('fs');
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SYMS = ['GOLD', 'SILVER', 'COPPER', 'NATGAS', 'WTI', 'NEAR', 'ZEC'];
(async () => {
  const out = fs.existsSync('markets2.json') ? JSON.parse(fs.readFileSync('markets2.json', 'utf8')) : {};
  for (const sym of SYMS) {
    if (out[sym] && out[sym].length > 3000) { console.log(`${sym}: cached ${out[sym].length}`); continue; }
    const rows = []; let cursor = null;
    for (let page = 0; page < 12; page++) {
      let j;
      try {
        j = await get(`${BASE}/markets?series_ticker=KX${sym}15M&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      } catch (e) { console.log(`  ${sym} page ${page + 1}: ${e.message}`); break; }
      const ms = j.markets || [];
      for (const m of ms) {
        const strike = Number(m.floor_strike != null ? m.floor_strike : m.cap_strike);
        const closeMs = Date.parse(m.close_time);
        if (!Number.isFinite(closeMs)) continue;
        if (m.result !== 'yes' && m.result !== 'no') continue;
        rows.push([m.ticker, closeMs, Number.isFinite(strike) ? strike : null, m.result === 'yes' ? 1 : 0]);
      }
      cursor = j.cursor;
      if (!cursor || !ms.length) break;
    }
    out[sym] = rows;
    const ts = rows.map(r => r[1]);
    console.log(`${sym.padEnd(7)} ${String(rows.length).padStart(5)} settled  ${rows.length ? new Date(Math.min(...ts)).toISOString().slice(0,10) + ' .. ' + new Date(Math.max(...ts)).toISOString().slice(0,10) : ''}`);
    fs.writeFileSync('markets2.json', JSON.stringify(out));
  }
  const tot = Object.values(out).reduce((a, r) => a + r.length, 0);
  console.log(`\ntotal ${tot} settled markets across ${Object.keys(out).length} new series`);
})();
