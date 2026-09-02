'use strict';
/**
 * Which 15-minute series exist, not which ones the bot happens to trade.
 *
 * The bot trades seven: BTC ETH SOL XRP BNB DOGE HYPE. A cross-category parlay market listed alongside
 * them referenced KXGOLD15M, KXSILVER15M, KXCOPPER15M, KXNATGAS15M, KXWTI15M, KXNEAR15M and KXZEC15M —
 * the same fifteen-minute product on metals, energy and two more coins. If those exist and behave, they
 * are the two levers that matter at once: twice the signals per hour, and settlements that do not all
 * move with Bitcoin, which is what currently caps the size.
 */
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const CAND = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE', 'GOLD', 'SILVER', 'COPPER',
  'NATGAS', 'WTI', 'NEAR', 'ZEC', 'LTC', 'AVAX', 'ADA', 'LINK', 'TRX', 'TON', 'SUI', 'PEPE',
  'PLATINUM', 'CORN', 'WHEAT', 'SOYBEAN', 'BRENT', 'GASOLINE', 'SPX', 'NDX', 'EURUSD'];
(async () => {
  const live = [];
  for (const sym of CAND) {
    const s = `KX${sym}15M`;
    let open = 0, settled = 0, title = '';
    try {
      const o = await get(`${BASE}/markets?series_ticker=${s}&status=open&limit=4`);
      open = (o.markets || []).length;
      if (open) title = (o.markets[0].title || '').slice(0, 46);
    } catch (_) {}
    if (!open) { console.log(`${s.padEnd(16)} —`); continue; }
    try {
      const d = await get(`${BASE}/markets?series_ticker=${s}&status=settled&limit=1000`);
      settled = (d.markets || []).filter(m => m.result === 'yes' || m.result === 'no').length;
    } catch (_) {}
    live.push({ sym, series: s, open, settled });
    console.log(`${s.padEnd(16)} open ${String(open).padStart(2)}  settled/page ${String(settled).padStart(4)}  ${title}`);
  }
  console.log(`\n${live.length} live 15-minute series; the bot trades 7`);
  require('fs').writeFileSync('series15.json', JSON.stringify(live, null, 1));
})();
