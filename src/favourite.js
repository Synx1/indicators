/**
 * The favourite gate: buy the side the BOOK already favours, at 85-90c, and hold it to settlement.
 *
 * ── where this came from ──
 *
 * The model gate in decide.js reads a direction out of spot, the strike and realised vol, then asks four
 * indicators to agree. Measured over 68 days and 45,030 settled markets it is fairly priced: the realised
 * win rate equals the price paid at every band, so the fee is the whole result and the book beats it
 * (AUC .88 against .84). That is an information limit, not a tuning one, and no feature set, model class,
 * order-flow signal or microstructure signal moved it.
 *
 * What DID move was looking at the price rather than predicting it. Buying the cheap side systematically
 * loses 3.8 points below its own price — a contract is cheap because its side is losing, so scanning for a
 * cheap entry buys a falling knife. A binary has two sides, so the mirror of that is the dear one, and the
 * dear side wins ABOVE its price:
 *
 *   85-90c, 12 to 6 minutes left, held to settlement
 *   3,938 signals   entry 87.15c   win 89.82% [88.83, 90.72]   break-even 87.93%   edge +1.88pp
 *
 * It survives what killed everything before it: all four chronological quarters positive, six of seven
 * coins, both sides symmetric (so it is not a hidden bet on "up"), every entry minute positive, and — the
 * one that matters — the band chosen blind on the first half of the corpus earned +1.60pp on the second
 * half it had never seen. The band was the best of 108 searched, so +1.60pp is the honest figure and
 * +1.88pp is the optimistic one.
 *
 * ── why it is cheap to be wrong ──
 *
 * Kalshi's fee is 0.07·p·(1−p), which peaks at 1.75 points near 50c and collapses to 0.78 points at 87c.
 * If this edge is entirely imaginary and the market is perfectly efficient, the cost of running it is that
 * 0.78 points a trade. The model gate at 35-65c pays 1.5-1.75 points for the same privilege. Being wrong
 * here is half as expensive as being wrong there.
 *
 * ── it does not read a price feed ──
 *
 * The signal IS the order book, so this gate needs the quote and the clock and nothing else. No spot, no
 * candles, no realised vol. That removes the entire failure class that cost 85% of the bankroll once
 * already: Coinbase candles lagging 1-5 minutes behind, a stale spot read as live, and a confident
 * direction computed from a price that had already moved. A quote fetched a moment ago cannot be stale in
 * that way — it is the thing being traded.
 */

'use strict';

/** The band. Below 85c the edge is negative; above 90c it shrinks and the loss-to-win ratio gets worse. */
const FAV_LO = 0.85;
const FAV_HI = 0.90;
/**
 * The clock window, in minutes left.
 *
 * Later than 6 minutes and the measured edge turns over — by T-3 and T-2 the cells are negative, because a
 * market still at 87c that late is one the crowd has already re-priced. Earlier than 12 and the market has
 * not committed yet, and the 85-90c reading is noise around a coin flip.
 */
const FAV_MIN_LEFT = 6;
const FAV_MAX_LEFT = 12;
/**
 * The measured out-of-sample edge, in probability points, used as the honest confidence.
 *
 * Deliberately the smaller of the two numbers. The in-sample figure is +1.88pp; this band was the best of
 * 108 price/window combinations searched, and the best of 108 is biased upward by construction. +1.60pp is
 * what it earned on data that had no part in choosing it, so that is what the bot is allowed to claim.
 */
const FAV_EDGE = 0.016;

/** Kalshi's taker fee per contract at a price, as a probability cost. Peaks at 50c, near zero at the ends. */
const feePt = p => 0.07 * p * (1 - p);

/** What the win rate has to beat for this entry to make money: the price plus the fee on it. */
const breakEven = p => p + feePt(p);

/**
 * Decide from the book alone.
 *
 * Returns a hit — the side to buy and what it costs — or a skip carrying the reason, in the same shape the
 * model gate uses so the pass log reads the same for both strategies.
 *
 * BOTH sides are tested and the dear one is taken. Preferring YES whenever it qualifies is how a rally in
 * the sample becomes a fake edge: near the middle of the book both sides qualify at once, and "prefer YES"
 * silently becomes "bet on up". Here the band starts at 85c, so at most one side can ever be in it, and the
 * measured YES/NO split came out 954/983 — which is what an edge that is about price rather than direction
 * has to look like.
 */
function evaluate({ yesAsk, noAsk, yesBid, minutesLeft }) {
  const ml = Number(minutesLeft);
  if (!Number.isFinite(ml)) return { skip: 'fav-no-clock', why: 'no close time on the market' };
  if (ml > FAV_MAX_LEFT) {
    return { skip: 'fav-too-early', why: `${ml.toFixed(1)}m left is over the ${FAV_MAX_LEFT}m ceiling` };
  }
  if (ml < FAV_MIN_LEFT) {
    return { skip: 'fav-too-late', why: `${ml.toFixed(1)}m left is under the ${FAV_MIN_LEFT}m floor` };
  }

  // A missing quote arrives as 0 or 1, and both are finite numbers that sail through a range check.
  // Number(null) === 0 passing a finite test has produced three separate false results in this project,
  // and here it would invent an 87c fill in a market where nothing was offered.
  const ya = Number(yesAsk), na = Number(noAsk);
  const twoSided = p => Number.isFinite(p) && p > 0 && p < 1;

  const sides = [];
  if (twoSided(ya)) sides.push({ side: 'YES', price: ya });
  if (twoSided(na)) sides.push({ side: 'NO', price: na });
  if (!sides.length) return { skip: 'fav-no-quote', why: 'neither side is offered' };

  const hit = sides.find(s => s.price >= FAV_LO && s.price <= FAV_HI);
  if (!hit) {
    const near = sides.slice().sort((a, b) => Math.abs(a.price - 0.875) - Math.abs(b.price - 0.875))[0];
    return {
      skip: 'fav-off-band',
      why: `nearest side is ${Math.round(near.price * 100)}c, outside ${FAV_LO * 100}-${FAV_HI * 100}c`
    };
  }

  // The spread is worth carrying even though the gate does not refuse on it: this is a taker entry, and a
  // wide book means the measured 1c median spread is not what is being paid here.
  const yb = Number(yesBid);
  const spread = twoSided(ya) && twoSided(yb) ? +(ya - yb).toFixed(4) : null;

  return {
    side: hit.side,
    price: hit.price,
    // The honest estimate of P(win): what the market is charging, plus the edge measured out of sample.
    winPct: +((hit.price + FAV_EDGE) * 100).toFixed(1),
    breakEvenPct: +(breakEven(hit.price) * 100).toFixed(2),
    edgePt: +(FAV_EDGE * 100).toFixed(2),
    feePt: +(feePt(hit.price) * 100).toFixed(2),
    minutesLeft: ml,
    spread
  };
}

module.exports = {
  evaluate, breakEven, feePt,
  FAV_LO, FAV_HI, FAV_MIN_LEFT, FAV_MAX_LEFT, FAV_EDGE
};
