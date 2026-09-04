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
 * loses below its own price — a contract is cheap because its side is losing, so scanning for a cheap entry
 * buys a falling knife. A binary has two sides, so the mirror of that is the dear one.
 *
 * The expanded local corpus (25,159 usable markets, 2026-06-26..09-01) currently measures the raw gate at:
 *
 *   85-90c, 12 to 6 minutes left, held to settlement
 *   12,130 signals   entry 87.15c   win 88.99%   fee-adjusted edge +1.06pp   ROI +1.20%
 *
 * The raw result stays positive after clustering by settlement window and by day. The production Neutral
 * correlation guard is less certain: 2,434 entries, +0.87pp, with a day-clustered 95% interval spanning
 * -0.50pp to +2.23pp. This is therefore a historical PAPER estimate, not a guaranteed confidence or a
 * reason to arm real money. Fresh forward evidence still has to earn promotion.
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
 * Current historical fee-adjusted edge point estimate.
 *
 * This is net of the entry fee: estimated P(win) is break-even + FAV_EDGE, not price + FAV_EDGE. Keeping
 * those definitions aligned prevents the UI from displaying a 1.06pp edge beside a probability that only
 * clears break-even by a fraction of that amount. The clustered interval is reported above and includes
 * zero after production guards, so this number is descriptive paper evidence, not certainty.
 */
const FAV_EDGE = 0.0106;
/**
 * Entry switch, deliberately false after forward evidence contradicted the historical point estimate.
 *
 * The two public-data forward samples, re-scored on the same one-minute closes and production correlation
 * guard as history, produced 8 wins from 11 entries, -1.611 contracts net and -16.76% fee-adjusted ROI.
 * First-sight plus every pre-declared elapsed/strict persistence challenger was negative. That does not
 * prove the anomaly can never return; it does mean the current configuration has not earned another
 * paper-bankroll entry. The standalone public shadow keeps observing candidates without putting them in
 * an account book, so this reversible switch can change only after a challenger earns it.
 */
const FAV_FORWARD_READY = false;
/**
 * Promotion switch, deliberately false while production-guarded clustered uncertainty includes zero.
 * UI copy saying "paper-only" is not a safety control; execution must fail closed too.
 */
const FAV_LIVE_READY = false;

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
function evaluate({ yesAsk, noAsk, yesBid, minutesLeft, minLeft, maxLeft }) {
  // The clock comes from the fleet preset (src/presets.js) and falls back to the constants above, so a
  // caller that does not know about presets still gets the band the module was measured on. Passing the
  // window in rather than reading it here keeps this file free of the config it is gated by — the gate
  // stays a pure function of a quote and a clock, which is what makes favourite.test.js cheap.
  const lo = Number.isFinite(Number(minLeft)) ? Number(minLeft) : FAV_MIN_LEFT;
  const hi = Number.isFinite(Number(maxLeft)) ? Number(maxLeft) : FAV_MAX_LEFT;
  const ml = Number(minutesLeft);
  if (!Number.isFinite(ml)) return { skip: 'fav-no-clock', why: 'no close time on the market' };
  if (ml > hi) {
    return { skip: 'fav-too-early', why: `${ml.toFixed(1)}m left is over the ${hi}m ceiling` };
  }
  if (ml < lo) {
    return { skip: 'fav-too-late', why: `${ml.toFixed(1)}m left is under the ${lo}m floor` };
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
    // The DEAR side, not the nearest to the band's middle. What a watcher wants to see is which way this
    // round is leaning and how far it has to travel, and that is the expensive side — a 64c dear side is
    // 21c from the band, while its 36c partner is not approaching it at all.
    const near = sides.slice().sort((a, b) => b.price - a.price)[0];
    return {
      skip: 'fav-off-band',
      why: `nearest side is ${Math.round(near.price * 100)}c, outside ${FAV_LO * 100}-${FAV_HI * 100}c`,
      // Structured alongside the sentence, so the panel can draw the distance instead of parsing prose.
      nearest: near.price, nearestSide: near.side,
      gapToBand: +(FAV_LO - near.price).toFixed(4)
    };
  }

  // The spread is worth carrying even though the gate does not refuse on it: this is a taker entry, and a
  // wide book means the measured 1c median spread is not what is being paid here.
  const yb = Number(yesBid);
  const spread = twoSided(ya) && twoSided(yb) ? +(ya - yb).toFixed(4) : null;

  const breakEvenPrice = breakEven(hit.price);
  return {
    side: hit.side,
    price: hit.price,
    // FAV_EDGE is measured AFTER fees, so add it to break-even rather than directly to the ask.
    winPct: +((breakEvenPrice + FAV_EDGE) * 100).toFixed(1),
    breakEvenPct: +(breakEvenPrice * 100).toFixed(2),
    edgePt: +(FAV_EDGE * 100).toFixed(2),
    feePt: +(feePt(hit.price) * 100).toFixed(2),
    minutesLeft: ml,
    spread
  };
}

module.exports = {
  evaluate, breakEven, feePt,
  FAV_LO, FAV_HI, FAV_MIN_LEFT, FAV_MAX_LEFT, FAV_EDGE, FAV_FORWARD_READY, FAV_LIVE_READY
};
