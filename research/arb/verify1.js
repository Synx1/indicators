'use strict';
/**
 * Before trusting either list: is a MISSING ask reported as 0?
 *
 * "Number(null) === 0 passes a finite check" has already produced three separate false results in this
 * project. A +90pt under-round on ten legs priced at a penny is exactly the shape that bug makes, so
 * it gets checked against the real order book before it is called anything.
 */
const { get, num } = require('./kx');

(async () => {
  for (const t of ['KXNETFLIXRANKSHOW-26SEP07', 'KXNFLFFLEADER-27QB', 'KXLAPRIMARY-01D26']) {
    const j = await get(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${t}&limit=100`);
    const ms = (j.markets || []);
    console.log(`\n=== ${t}  (${ms.length} legs) ===`);
    let sb = 0, sa = 0, nAskMissing = 0;
    for (const m of ms) {
      const yb = num(m.yes_bid_dollars), ya = num(m.yes_ask_dollars);
      sb += (Number.isFinite(yb) ? yb : 0); sa += (Number.isFinite(ya) ? ya : 0);
      if (!(ya > 0)) nAskMissing++;
      console.log(`  ${(m.yes_sub_title || m.ticker).slice(0, 30).padEnd(31)} yesBid ${String(m.yes_bid_dollars).padEnd(7)} sz ${String(m.yes_bid_size_fp || 0).padEnd(9)} yesAsk ${String(m.yes_ask_dollars).padEnd(7)} sz ${String(m.yes_ask_size_fp || 0).padEnd(9)} status ${m.status}`);
    }
    console.log(`  sum yesBid ${sb.toFixed(4)}   sum yesAsk ${sa.toFixed(4)}   legs with NO ask: ${nAskMissing}`);
    // and the raw book on the first leg, to see what an "ask 0" really is
    const ob = await get(`https://api.elections.kalshi.com/trade-api/v2/markets/${ms[0].ticker}/orderbook`);
    const fp = ob.orderbook_fp || ob.orderbook || {};
    console.log(`  raw book ${ms[0].ticker}: yes_dollars=${JSON.stringify((fp.yes_dollars || []).slice(-3))} no_dollars=${JSON.stringify((fp.no_dollars || []).slice(-3))}`);
  }
})();
