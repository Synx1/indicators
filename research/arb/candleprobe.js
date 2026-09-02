'use strict';
/** Does the candlestick endpoint expose the full price path of a settled 15-minute market? */
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  const j = await get(`${BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=3`);
  for (const m of (j.markets || [])) {
    const closeS = Math.floor(Date.parse(m.close_time) / 1000);
    const openS = Math.floor(Date.parse(m.open_time) / 1000);
    for (const iv of [1, 60]) {
      let c;
      try { c = await get(`${BASE}/series/KXBTC15M/markets/${m.ticker}/candlesticks?start_ts=${openS - 120}&end_ts=${closeS + 120}&period_interval=${iv}`); }
      catch (e) { console.log(`${m.ticker} iv=${iv} ERR ${e.message}`); continue; }
      const cs = c.candlesticks || [];
      console.log(`${m.ticker} result=${m.result} iv=${iv}min -> ${cs.length} candles`);
      if (cs.length) {
        console.log('  KEYS:', Object.keys(cs[0]).join(', '));
        console.log('  first:', JSON.stringify(cs[0]));
        console.log('  last :', JSON.stringify(cs[cs.length - 1]));
      }
    }
    break;
  }
})();
