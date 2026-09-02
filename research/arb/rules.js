'use strict';
/** The settlement rule for a 15-minute crypto market, in Kalshi's own words. */
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
(async () => {
  const s = await get(`${BASE}/series/KXBTC15M`);
  const ser = s.series || {};
  console.log('=== series KXBTC15M ===');
  console.log('settlement_sources:', JSON.stringify(ser.settlement_sources));
  console.log('fee_type:', ser.fee_type, ' fee_multiplier:', ser.fee_multiplier);
  console.log('\n--- one live market rules ---');
  const j = await get(`${BASE}/markets?series_ticker=KXBTC15M&status=open&limit=1`);
  const m = (j.markets || [])[0];
  console.log('ticker:', m && m.ticker);
  console.log('\nRULES PRIMARY:\n', (m && m.rules_primary) || '(none)');
  console.log('\nRULES SECONDARY:\n', ((m && m.rules_secondary) || '(none)').slice(0, 1500));
})();
