'use strict';
/** How far back does Kalshi actually keep 15-minute markets? Paged to exhaustion, not assumed. */
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  for (const sym of ['BTC', 'ETH']) {
    let cursor = null, oldest = Infinity, n = 0, pages = 0;
    while (pages < 40) {
      let j;
      try { j = await get(`${BASE}/markets?series_ticker=KX${sym}15M&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`); }
      catch (e) { console.log(`  ${sym} page ${pages + 1}: ${e.message}`); break; }
      const ms = j.markets || [];
      for (const m of ms) {
        const t = Date.parse(m.close_time);
        if (Number.isFinite(t) && t < oldest) oldest = t;
      }
      n += ms.length; pages++;
      cursor = j.cursor;
      if (!cursor || !ms.length) break;
    }
    const days = (Date.now() - oldest) / 86400e3;
    console.log(`${sym}: ${n} settled over ${pages} pages, oldest close ${new Date(oldest).toISOString().slice(0, 10)} — ${days.toFixed(1)} days of history`);
    console.log(`   cursor exhausted: ${cursor ? 'NO (more pages exist)' : 'yes, that is everything Kalshi exposes'}`);
  }
  // And whether an explicit older window returns anything at all.
  const old = Math.floor(new Date('2026-04-01').getTime() / 1000);
  const j = await get(`${BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=10&min_close_ts=${old - 86400}&max_close_ts=${old + 86400}`);
  console.log(`\nasking directly for 2026-04-01: ${(j.markets || []).length} markets returned`);
})();
