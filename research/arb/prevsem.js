'use strict';
/**
 * What does `previous_yes_bid_dollars` on a SETTLED market actually mean?
 *
 * If it is a fixed pre-close snapshot it is a free pre-resolution price for every settled market on
 * the exchange — one request per thousand markets instead of one per market. If it is anything else,
 * using it would silently date every price in the study. So it gets checked against the market's own
 * candlesticks before a single number is built on it.
 */
const { get, num } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

(async () => {
  const j = await get(`${BASE}/markets?series_ticker=KXMLBGAME&status=settled&limit=6`);
  for (const m of (j.markets || []).slice(0, 4)) {
    const closeMs = Date.parse(m.close_time);
    const openMs = Date.parse(m.open_time);
    const start = Math.floor((closeMs - 6 * 3600e3) / 1000);
    const end = Math.floor(closeMs / 1000);
    let c;
    try {
      c = await get(`${BASE}/series/KXMLBGAME/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`);
    } catch (e) { console.log(`${m.ticker} candles failed: ${e.message}`); continue; }
    const cs = (c.candlesticks || []).filter(x => x && x.yes_bid && x.yes_bid.close != null);
    console.log(`\n${m.ticker}  result=${m.result}  prevBid=${m.previous_yes_bid_dollars} prevAsk=${m.previous_yes_ask_dollars}`);
    console.log(`  open ${m.open_time}  close ${m.close_time}  candles ${cs.length}`);
    if (!cs.length) { console.log('  (no candles in window)'); continue; }
    const show = [cs[0], cs[Math.floor(cs.length / 2)], cs[cs.length - 2], cs[cs.length - 1]].filter(Boolean);
    for (const k of show) {
      const mins = Math.round((closeMs / 1000 - k.end_period_ts) / 60);
      console.log(`  T-${String(mins).padStart(4)}m  bid ${k.yes_bid.close}  ask ${k.yes_ask && k.yes_ask.close}  vol ${k.volume}`);
    }
    console.log(`  CANDLE KEYS: ${Object.keys(cs[0]).join(', ')}`);
  }
})();
