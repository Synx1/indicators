'use strict';
/** What else does Kalshi expose that has not been used? Probing the API surface, not guessing at it. */
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  // A live 15-minute market to probe against.
  const j = await get(`${BASE}/markets?series_ticker=KXBTC15M&status=open&limit=1`);
  const t = (j.markets || [])[0];
  console.log('probe market:', t && t.ticker, '\n');

  const tries = [
    ['trades tape', `${BASE}/markets/trades?ticker=${t.ticker}&limit=5`],
    ['index ticker', `${BASE}/series/KXBTC15M/ticker`],
    ['index history', `${BASE}/indexes/BRTI`],
    ['index candles', `${BASE}/series/KXBTC15M/candlesticks?period_interval=1`],
    ['market orderbook', `${BASE}/markets/${t.ticker}/orderbook?depth=10`],
    ['events nested', `${BASE}/events/${t.event_ticker}`],
    ['other BTC series', `${BASE}/series?category=Crypto&limit=200`]
  ];
  for (const [name, url] of tries) {
    try {
      const r = await get(url);
      const keys = Object.keys(r || {});
      console.log(`${name.padEnd(20)} OK   top-level keys: ${keys.join(', ').slice(0, 90)}`);
      if (name === 'trades tape' && r.trades && r.trades.length) {
        console.log('   trade shape:', JSON.stringify(r.trades[0]));
      }
      if (name === 'other BTC series' && r.series) {
        const btc = r.series.filter(s => /BTC/.test(s.ticker)).map(s => s.ticker);
        console.log(`   BTC series available (${btc.length}): ${btc.join(' ')}`);
      }
    } catch (e) { console.log(`${name.padEnd(20)} ${e.message.slice(0, 60)}`); }
  }
})();
