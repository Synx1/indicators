/**
 * The favourite gate: the pure band logic, and the WIRING that decideFor actually reaches it.
 *
 * ── why the wiring half matters more than the unit half ──
 *
 * A mutation sweep on this project proved that a correct predicate which is never called is worth
 * nothing: replacing a whole gate in decideFor with `if (false)` left every suite green. So the pure
 * function is checked here, and then the real decideFor is driven with a stubbed network to prove the
 * decision that comes out is the one the gate produced.
 *
 * ── the property that is easiest to break by accident ──
 *
 * This gate must NOT depend on the spot feed or the candles. The signal is the order book. That is the
 * whole reason it exists: a lagging Coinbase candle read as live once cost 85% of the bankroll, and a gate
 * that decides from the book cannot be wrong that way. It would be very easy for a later edit to move the
 * favourite path below the stale-spot check and quietly reintroduce the dependency, so there is an
 * assertion here that a completely dead price feed still produces a favourite entry.
 *
 * Run: node test/favourite.test.js
 */
const assert = require('assert');
const Module = require('module');

process.env.STRATEGY = 'favourite';
// Favourite is suspended, so config.js would otherwise fall back to calibration and this suite
// would silently stop testing the favourite path at all. Opt in to the suspended gate on purpose.
process.env.STRATEGY_ALLOW_SUSPENDED = '1';

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

// ── the pure gate ──
const fav = require('../src/favourite');

// In band, on both sides, and the side taken is the one the book prices dear.
eq(fav.evaluate({ yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86, minutesLeft: 9 }).side, 'YES', 'a dear YES is taken');
eq(fav.evaluate({ yesAsk: 0.13, noAsk: 0.88, yesBid: 0.12, minutesLeft: 9 }).side, 'NO', 'a dear NO is taken');

// The band edges are inclusive at both ends, because they are where the measurement's cells begin and end.
eq(fav.evaluate({ yesAsk: 0.85, noAsk: 0.16, yesBid: 0.84, minutesLeft: 9 }).side, 'YES', '85c is in band');
eq(fav.evaluate({ yesAsk: 0.90, noAsk: 0.11, yesBid: 0.89, minutesLeft: 9 }).side, 'YES', '90c is in band');
eq(fav.evaluate({ yesAsk: 0.84, noAsk: 0.17, yesBid: 0.83, minutesLeft: 9 }).skip, 'fav-off-band', '84c is out');
eq(fav.evaluate({ yesAsk: 0.91, noAsk: 0.10, yesBid: 0.90, minutesLeft: 9 }).skip, 'fav-off-band', '91c is out');

// The clock. Outside 6-12 minutes there is no measurement, so there is no trade.
eq(fav.evaluate({ yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86, minutesLeft: 12.5 }).skip, 'fav-too-early', 'over 12m refused');
eq(fav.evaluate({ yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86, minutesLeft: 5.5 }).skip, 'fav-too-late', 'under 6m refused');

/**
 * A missing quote must not become a fill.
 *
 * Kalshi reports an absent ask as 0 and an absent bid as 0, and `Number(null) === 0` sails through a
 * finite check — that exact confusion has produced three separate false results in this project. An
 * 87c NO derived from a YES side that nobody is quoting would be a position taken at a price that
 * never existed.
 */
eq(fav.evaluate({ yesAsk: 0, noAsk: 0, yesBid: 0, minutesLeft: 9 }).skip, 'fav-no-quote', 'no quote at all');
eq(fav.evaluate({ yesAsk: 1, noAsk: 1, yesBid: 1, minutesLeft: 9 }).skip, 'fav-no-quote', 'a 1.00 quote is not a quote');
eq(fav.evaluate({ yesAsk: null, noAsk: null, yesBid: null, minutesLeft: 9 }).skip, 'fav-no-quote', 'nulls are not prices');
eq(fav.evaluate({ yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86, minutesLeft: NaN }).skip, 'fav-no-clock', 'no clock, no trade');

// Break-even is the price PLUS the fee on it, never the price alone. At 87c the fee is 0.79 points.
ok(Math.abs(fav.breakEven(0.87) - 0.8779) < 1e-4, 'break-even at 87c is 87.79%');
ok(fav.feePt(0.5) > fav.feePt(0.87), 'the fee is heavier at 50c than at 87c');
// FAV_EDGE is fee-adjusted: estimated P(win) is break-even plus that edge, not ask plus edge.
const hit = fav.evaluate({ yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86, minutesLeft: 9 });
eq(hit.edgePt, +(fav.FAV_EDGE * 100).toFixed(2), 'edgePt reports the historical net edge');
eq(hit.winPct, +((fav.breakEven(0.87) + fav.FAV_EDGE) * 100).toFixed(1),
  'estimated win probability adds net edge to fee-inclusive break-even');
ok(hit.winPct > hit.breakEvenPct, 'the historical point estimate clears break-even');

// ── the wiring ──
let QUOTE = { yes_ask_dollars: '0.87', no_ask_dollars: '0.14', yes_bid_dollars: '0.86' };
let MINUTES_OUT = 9;
let SPOT_OK = true;
let TICKER_READS = 0;
let CANDLE_READS = 0;

const origLoad = Module._load;
const stubAxios = {
  create: () => ({
    get: async () => ({ data: {} }), post: async () => ({ data: {} }),
    interceptors: { request: { use() {} }, response: { use() {} } }
  }),
  post: async () => ({ data: {} }),
  get: async (url) => {
    // A dead price feed on purpose: the favourite gate must not care.
    if (/\/ticker/.test(url)) {
      TICKER_READS++;
      if (!SPOT_OK) throw new Error('ticker down');
      return { data: { price: '100', time: new Date().toISOString() } };
    }
    if (/\/candles/.test(url)) {
      CANDLE_READS++;
      if (!SPOT_OK) throw new Error('candles down');
      return { data: [] };
    }
    if (/\/markets\?/.test(url)) {
      return { data: { markets: [{
        ticker: 'KXFAV-1', close_time: new Date(Date.now() + MINUTES_OUT * 60000).toISOString(),
        floor_strike: '100', exchange_index: 2, ...QUOTE
      }] } };
    }
    if (/\/markets\//.test(url)) {
      return { data: { market: { ticker: 'KXFAV-1', floor_strike: '100', ...QUOTE } } };
    }
    throw new Error('unexpected url ' + url);
  }
};
Module._load = function (request) {
  if (request === 'axios') return stubAxios;
  return origLoad.apply(this, arguments);
};

const trader = require('../src/trader');
require('../src/markets').init({ log: () => {} });

(async () => {
  const coin = { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' };

  let d = await trader.decideFor(coin);
  ok(!d.skip, `an 87c book at T-9 is taken (got ${d.skip || ''} ${d.why || ''})`);
  eq(d.strategy, 'FAVOURITE', 'the decision says which gate produced it');
  eq(d.side, 'YES', 'the dear side is the one bought');
  eq(d.pricePct, 87, 'priced at the fresh ask');
  eq(d.confidence, +((fav.breakEven(0.87) + fav.FAV_EDGE) * 100).toFixed(1),
    'confidence is the fee-inclusive historical point estimate');
  eq(TICKER_READS, 0, 'favorite-only makes no Coinbase ticker request on its critical path');
  eq(CANDLE_READS, 0, 'favorite-only makes no Coinbase candle request on its critical path');

  // The NO side, so a lopsided implementation cannot pass. A gate that only ever fires on YES is a bet
  // on "up", and the measurement it is built from came out 954 YES to 983 NO.
  QUOTE = { yes_ask_dollars: '0.13', no_ask_dollars: '0.88', yes_bid_dollars: '0.12' };
  d = await trader.decideFor(coin);
  eq(d.side, 'NO', 'a dear NO is bought just as readily');
  eq(d.pricePct, 88, 'the NO ask is the price');

  // Outside the band, nothing — and the reason names the band rather than a generic refusal.
  QUOTE = { yes_ask_dollars: '0.55', no_ask_dollars: '0.46', yes_bid_dollars: '0.54' };
  d = await trader.decideFor(coin);
  eq(d.skip, 'fav-off-band', 'a 55c book is refused');

  // Outside the clock, nothing. The round lookup itself is bounded, so this reads as no-window.
  QUOTE = { yes_ask_dollars: '0.87', no_ask_dollars: '0.14', yes_bid_dollars: '0.86' };
  MINUTES_OUT = 3;
  d = await trader.decideFor(coin);
  ok(d.skip, 'a 3-minute round is refused');

  /**
   * The independence property, asserted rather than assumed.
   *
   * Spot and candles both throw. Under the model gate that is `no-spot` and the pass is over. This gate
   * reads the order book, so it must still trade — and if a later edit moves the favourite path below the
   * stale-spot check, this is the assertion that fails.
   */
  MINUTES_OUT = 9;
  SPOT_OK = false;
  d = await trader.decideFor(coin);
  ok(!d.skip, `a dead price feed does not stop a book signal (got ${d.skip || ''} ${d.why || ''})`);
  eq(d.strategy, 'FAVOURITE', 'still the favourite gate');
  eq(d.spot, null, 'and it reports honestly that it did not wait for spot');
  eq(TICKER_READS, 0, 'even a failing ticker endpoint is never touched by favorite-only');
  eq(CANDLE_READS, 0, 'even a failing candle endpoint is never touched by favorite-only');

  /**
   * The persistence gate must not apply here.
   *
   * gateSignal holds a model signal for 60 seconds before it may trade, because the model's direction
   * flips between passes. The favourite gate's direction is which side the book charges 85-90c for, and
   * the tracker deletes its watch on any pass without an observation — so applying persistence meant the
   * dear side had to hold a five-cent band for a full minute straight, which is why the live bot took no
   * trades at all. Measured over 13,269 markets it keeps 33% of signals to gain 0.43pp, taking the total
   * from $9,862 to $4,080. This asserts the exemption, at the first sight of a signal, with no history.
   */
  SPOT_OK = true;
  QUOTE = { yes_ask_dollars: '0.87', no_ask_dollars: '0.14', yes_bid_dollars: '0.86' };
  const fresh = trader.gateSignal({ sym: 'BTC' }, await trader.decideFor(coin), Date.now());
  ok(!fresh.skip, `a first-sight favourite signal is not held for persistence (got ${fresh.skip || ''})`);
  eq(fresh.strategy, 'FAVOURITE', 'and it is still the favourite decision, not a rewritten one');

  // A favourite SKIP must leave the model's watch alone, so that under STRATEGY=both an out-of-band poll
  // cannot reset the persistence clock and starve the model gate as well.
  const before = trader.signalTracker ? trader.signalTracker.size : null;
  QUOTE = { yes_ask_dollars: '0.55', no_ask_dollars: '0.46', yes_bid_dollars: '0.54' };
  trader.gateSignal({ sym: 'BTC' }, await trader.decideFor(coin), Date.now());
  if (before != null) eq(trader.signalTracker.size, before, 'a fav skip does not touch the tracker');

  Module._load = origLoad;
  console.log(`PASS favourite gate — ${checks} checks`);
})().catch(e => { console.error(e); process.exit(1); });
