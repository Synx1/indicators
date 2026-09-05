'use strict';

/**
 * The CALIBRATION gate: buy whichever side the market has priced as a heavy favourite.
 *
 * ── what it is ──
 * Not a forecast. Kalshi's 15-minute crypto markets systematically UNDERPRICE heavy favourites, and this
 * gate does nothing but buy that mispricing. Measured on 25,159 settled markets over 68 settlement days:
 *
 *     YES priced   realized     bias
 *      10-25c       14.7%     -2.81pp   <- longshot overpriced, so buy NO (the 75-90c side)
 *      40-60c       50.3%     +0.43pp   <- no edge, and the costliest place to trade
 *      75-90c       86.4%     +4.09pp   <- favourite underpriced, buy YES
 *      90-95c       96.0%     +3.56pp   <- favourite underpriced, buy YES
 *
 * The pattern is monotone and present in all seven underlyings (SOL +4.86pp through ETH +3.15pp, every
 * one significant), and the YES base rate over the corpus is 51.0%, so it is a calibration effect rather
 * than an artifact of crypto having drifted upward.
 *
 * ── why the bands are where they are ──
 * The edge must clear the cost of trading, which is half-spread plus Kalshi's fee. That cost is worst at
 * mid prices (~2.57pp near 50c) and cheapest at the extremes (~0.55pp at 90c+), because the fee scales
 * with p(1-p). So the bias is only harvestable in the tails. Buckets are admitted only when their surplus
 * over their OWN cost clears two standard errors:
 *
 *     75-90c YES   surplus +2.26pp  t=4.30   admitted
 *     90-95c YES   surplus +2.68pp  t=4.93   admitted
 *     10-25c NO    surplus +0.97pp  t=1.77   admitted but MARGINAL, tracked separately
 *     >=95c  YES   surplus +0.93pp  t=1.54   refused
 *     60-75c YES   surplus -0.32pp           refused
 *     5-10c  NO    bias smaller than its own cost, negative by construction, refused
 *
 * ── the spread gate ──
 * Wide books actually show a LARGER bias (+4.74pp above 2c versus +4.14pp at or under 1c) yet convert
 * less of it, because the entry costs more. Gating at 1c raised expanding-day walk-forward ROI from 2.47%
 * to 3.01% and its day-clustered lower bound from +0.96pp to +1.22pp while retaining 64% of trades. A
 * 0.6c gate FAILS (296 trades, interval straddles zero), so 1c is an optimum, not a monotone tightening.
 *
 * ── what is NOT established ──
 * At a perfect fill the walk-forward is +3.01% with a positive lower bound. At one cent of slippage it is
 * +1.01% with the interval touching zero, and at two cents there is nothing. Signals also arrive heavily
 * CORRELATED — all seven coins can qualify in the same window on the same side — so the effective sample
 * is far smaller than the trade count, and the true interval is wider than a per-trade figure suggests.
 * This gate is therefore NOT cleared for live money. See CAL_LIVE_READY.
 */

/** Active buckets, keyed on the YES mid. `side` is what to BUY when the mid lands inside. */
const CAL_BUCKETS = Object.freeze([
  Object.freeze({ label: '75-90c', lo: 0.75, hi: 0.90, side: 'YES',
    biasPp: 4.092, costPp: 1.83, surplusPp: 2.262, t: 4.30, marginal: false }),
  Object.freeze({ label: '90-95c', lo: 0.90, hi: 0.95, side: 'YES',
    biasPp: 3.564, costPp: 0.88, surplusPp: 2.684, t: 4.93, marginal: false }),
  /**
   * DISABLED on forward evidence. Kept here as the record, not as a live rule.
   *
   * This bucket never cleared the pre-declared bar: its surplus over the cost of buying NO is +0.97pp at
   * t=1.77, against the 2-sigma requirement the two UP buckets pass at t=4.30 and t=4.93. It was admitted
   * anyway, by request, to be measured live.
   *
   * It was measured, and it failed. Across 49 unique settled paper trades it took 35 of them — 71% of all
   * capacity — at a 71.4% win rate against the ~80% its own mean entry price of 0.801 implies, for -12.04%
   * ROI. The UP buckets over the same period were -4.49% and +6.01% on much smaller samples. Two things
   * make this a fail-closed decision rather than a reaction to a loss streak: the historical bar that
   * rejected it was declared before any live data existed, and forward evidence has now independently
   * agreed with it. Disabling it does not adopt a new challenger, it reverts to the configuration the
   * pre-declared rule always supported.
   *
   * A sustained one-way crypto regime is what let it dominate: when prices fall for hours, YES sits at
   * 10-25c across every coin and this bucket fires on all of them at once, crowding out the buckets that
   * did pass. Re-enable ONLY on a day-clustered forward interval whose lower bound is above zero,
   * measured on independent windows rather than correlated trades.
   */
  Object.freeze({ label: '10-25c-NO', lo: 0.10, hi: 0.25, side: 'NO',
    biasPp: -2.814, costPp: 1.84, surplusPp: 0.974, t: 1.77, marginal: true, enabled: false })
]);

/** Buckets actually traded. A disabled bucket stays visible for provenance but never fires. */
const CAL_ACTIVE_BUCKETS = Object.freeze(CAL_BUCKETS.filter(b => b.enabled !== false));

/** Decision clock, in minutes left. The corpus was measured at exactly 9 minutes. */
const CAL_DECIDE_MIN = 8.25;
const CAL_DECIDE_MAX = 9.75;
const CAL_DECIDE_TARGET = 9;

/** Maximum quoted spread in cents for an entry to be taken. */
/**
 * Maximum half-spread cost, in cents, that an entry may pay.
 *
 * ── 1.05c is the sweep optimum, and it is now BACKED FORWARD as well as historically ──
 *
 * Swept against all 25,159 settled markets (240 configs: 6 decision minutes x 5 spread caps x 4 bucket
 * sets x the session gate), ranked on the day-clustered 95% CI lower bound of per-trade ROI:
 *
 *     cap      n     win%   loss%   ROI      CI floor
 *     1.05c   3384   90.1    9.9   +2.81%   +1.29%   <- this setting, ranked 1st of 240
 *     0.6c     692   96.2    3.8   +2.34%   +0.30%
 *
 * And confirmed forward by the research shadow running this exact cap: 151 settled trades, 87.5% win,
 * +4.2% ROI -- landing on the +2.81% the corpus predicted. That is the only configuration in this
 * project with historical AND forward evidence pointing the same way.
 *
 * ── why the 0.6c experiment was reverted ──
 *
 * 0.6c was set deliberately to cut losing trades from 9.9% to 3.8%, accepting a weaker floor. The
 * forward result was not a loss, it was SILENCE: 2 trades in 7 hours of live operation, because only
 * 759 of 25,159 markets are ever quoted that tight and all 7 coins share one 15-minute grid. A gate
 * that cannot transact cannot compound, and a 96.2% win rate on two trades is not a result. Reverted on
 * that basis -- inability to accumulate evidence -- not because it lost money.
 *
 * The cost of coming back is honest: ~1 trade in 10 loses again, and a loss at these prices is roughly
 * 5x the size of a win. The compensation is a floor 4x higher and 5x the volume for the edge to work
 * through.
 */
const CAL_MAX_SPREAD_CENTS = 1.05;

/**
 * Grace allowance in cents above the quoted ask. A real taker order is a limit order: it fills only if
 * the offer has not run past ask+grace, otherwise the buy FAILS rather than filling worse. History could
 * not settle this value (99.98% of next-minute bars have a low at or below the decision ask, so a
 * bar-based test can never fail). The live paper shadow measured 0c/1c/2c side by side and 1c won: it
 * converted 4 of 25 no-fills into fills at an unchanged win rate, while 2c was byte-identical to 1c and
 * so never used its extra room.
 */
const CAL_GRACE_CENTS = 1;

/**
 * Eastern-time hours whose contract CLOSES are skipped.
 *
 * ── how these two hours were chosen, and why no others ──
 *
 * Slicing by hour of day produced a tempting in-sample ranking (2am ET at +10.6% ROI, 7am at -4.8%), but
 * selecting the best hours FAILS out of sample: an expanding-day walk-forward that kept the top 6 hours
 * returned 2.95% with a day-clustered interval of [-0.61, +5.43] — worse than the 3.06% [+1.31, +4.01]
 * baseline it was meant to improve. Hourly ROI estimates on ~150 trades are simply too noisy to rank.
 *
 * So these two hours are NOT the best-looking ones. They are the only hours that survived an independent
 * split-half test: choosing the loss-making hours using ONLY the first chronological half of the corpus
 * selected exactly [7, 8], and applying that exclusion to the UNTOUCHED second half improved it from
 * 3.413% ROI [+1.11, +4.67] to 3.827% [+1.40, +5.06]. They are also negative in BOTH halves separately
 * (-5.96% and -2.28%), which a noise artifact usually is not.
 *
 * The obvious explanation — 8:30am ET US macro releases causing jumps that break favourites — is NOT
 * supported: the 8:15-8:45 window is only -0.87%, so the weakness is spread across both hours rather than
 * concentrated at the release. Absent a mechanism, this stays a narrow empirical exclusion, and it is
 * deliberately two hours rather than the four that would have looked better in sample.
 */
const CAL_SKIP_ET_HOURS = Object.freeze([7, 8]);

/**
 * Eastern-time hour of a close timestamp, or null when it cannot be read.
 * Uses the IANA zone so US daylight-saving transitions are handled by the runtime rather than by an
 * offset constant that would silently drift by an hour twice a year.
 */
function etHour(closeTime) {
  if (closeTime == null || closeTime === '') return null;
  const ms = typeof closeTime === 'number' ? closeTime : Date.parse(closeTime);
  if (!Number.isFinite(ms)) return null;
  const raw = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false
  }).format(new Date(ms));
  const hour = Number(raw);
  if (!Number.isFinite(hour)) return null;
  return hour === 24 ? 0 : hour;
}

/** Fitted-on provenance, surfaced to the panel and site so a reader can judge the sample. */
const CAL_FITTED = Object.freeze({
  markets: 25159, settlementDays: 68, throughDay: '2026-09-02', decisionMinutesLeft: 9
});

/**
 * Forward readiness. Paper is permitted so the gate accumulates honest forward evidence inside the bot's
 * own book, exactly as the favourite gate did before it was suspended.
 */
const CAL_FORWARD_READY = true;

/**
 * Live readiness — FAIL CLOSED, and it must stay false until forward evidence supports it.
 *
 * Do not flip this because a short paper run looked good. At an ~88% win rate a handful of winning
 * windows is the EXPECTED outcome and says nothing; the favourite gate was suspended after exactly that
 * kind of early optimism reversed. The bar is a fee-adjusted, day-clustered forward interval whose lower
 * bound is above zero on a sample of independent WINDOWS, not individual correlated trades.
 */
const CAL_LIVE_READY = false;

const feePt = p => 0.07 * p * (1 - p);
const breakEven = p => p + feePt(p);

/**
 * The single numeric guard for this module.
 *
 * Number(null) and Number('') are both 0, and 0 passes Number.isFinite. That has produced four separate
 * false results in this project — an invented 87c fill, a 0c bid treated as a real quote, a missing clock
 * reported as "too late", and a 1c entry limit out of a null price. Every value that arrives from a book,
 * a market payload or a caller goes through here first.
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The bucket whose band contains this YES mid, or null. */
function bucketFor(yesMid) {
  const mid = finiteOrNull(yesMid);
  if (mid == null) return null;
  return CAL_ACTIVE_BUCKETS.find(b => mid >= b.lo && mid < b.hi) || null;
}

/** Limit price for a taker entry: the quoted ask plus the grace allowance, capped at 99c. */
function entryLimit(ask, graceCents = CAL_GRACE_CENTS) {
  const a = finiteOrNull(ask);
  if (a == null) return null;
  return +Math.min(0.99, a + graceCents / 100).toFixed(4);
}

/**
 * Evaluate one round. Pure: a quote plus a clock in, a decision or a structured refusal out.
 *
 * `yesBid`/`yesAsk` are the YES ladder. The NO side is derived, because Kalshi quotes bids on both
 * outcomes and a NO position simply inverts them: noAsk = 1 - yesBid, noBid = 1 - yesAsk.
 */
function evaluate({ yesBid, yesAsk, minutesLeft, minLeft, maxLeft, closeTime }) {
  const lo = finiteOrNull(minLeft) == null ? CAL_DECIDE_MIN : finiteOrNull(minLeft);
  const hi = finiteOrNull(maxLeft) == null ? CAL_DECIDE_MAX : finiteOrNull(maxLeft);
  const ml = finiteOrNull(minutesLeft);
  if (ml == null) return { skip: 'cal-no-clock', why: 'no close time on the market' };

  // The session gate runs before the quote work: an excluded hour is not tradable at any price, so
  // reading the book for it would only produce a refusal that costs a request.
  const hour = etHour(closeTime);
  if (hour != null && CAL_SKIP_ET_HOURS.includes(hour)) {
    return {
      skip: 'cal-skip-hour',
      why: `${String(hour).padStart(2, '0')}:00 ET closes are excluded — negative in both halves of ` +
        'the corpus and confirmed by split-half validation',
      etHour: hour
    };
  }

  /**
   * The ceiling is the TARGET, not the top of a tolerance band, and that distinction cost real money in
   * the first paper run.
   *
   * A poller that accepts anything inside target±tolerance fires on the FIRST poll that enters the band,
   * which is systematically its early edge. The live shadow entered at a mean of 573s left against a
   * nominal 540s, and these contracts move about 8.4c per minute — so a 33-second bias is roughly 4.5c of
   * drift, comparable to the entire measured edge. The corpus was sampled at exactly 9 minutes, so an
   * entry at 9m45s is simply a different trade than the one that was validated.
   *
   * Gating at `ml > CAL_DECIDE_TARGET` makes the first qualifying poll land just UNDER the target instead,
   * which is the closest a discrete poller can get to the sampled point. `hi` is retained only as an
   * upper sanity bound for callers that pass a custom window.
   */
  const ceiling = Math.min(CAL_DECIDE_TARGET, hi);
  if (ml > ceiling) {
    return { skip: 'cal-too-early', why: `${ml.toFixed(1)}m left is before the ${ceiling}m decision point` };
  }
  if (ml < lo) return { skip: 'cal-too-late', why: `${ml.toFixed(1)}m left is under the ${lo}m floor` };

  // Number(null) === 0 is finite and would invent a free contract. Three separate false results in this
  // project came from exactly that, so an absent quote is rejected before any arithmetic.
  const twoSided = p => p != null && p > 0 && p < 1;
  const yb = finiteOrNull(yesBid);
  const ya = finiteOrNull(yesAsk);
  if (!twoSided(yb) || !twoSided(ya)) {
    return { skip: 'cal-no-quote', why: 'the YES ladder is not two-sided' };
  }
  if (ya < yb) return { skip: 'cal-crossed', why: 'the quoted book is crossed' };

  const mid = (yb + ya) / 2;
  const spreadCents = +((ya - yb) * 100).toFixed(2);
  const bucket = bucketFor(mid);
  if (!bucket) {
    return {
      skip: 'cal-off-band',
      why: `${Math.round(mid * 100)}c is outside the supported bands ` +
        `(${CAL_BUCKETS.map(b => b.label).join(', ')})`,
      mid: +mid.toFixed(4), spreadCents
    };
  }
  if (spreadCents > CAL_MAX_SPREAD_CENTS) {
    return {
      skip: 'cal-wide-spread',
      why: `${spreadCents}c spread is over the ${CAL_MAX_SPREAD_CENTS}c gate`,
      mid: +mid.toFixed(4), spreadCents, bucket: bucket.label
    };
  }

  // The side actually bought, priced off its own ladder.
  const price = bucket.side === 'YES' ? ya : +(1 - yb).toFixed(4);
  if (!twoSided(price)) return { skip: 'cal-no-quote', why: 'the traded side has no offer' };

  const breakEvenPrice = breakEven(price);
  // The bias is measured against the mid, so the honest win estimate is the mid of the side we buy plus
  // the bucket's bias — NOT break-even plus a bias, which would double-count the spread we already pay.
  const sideMid = bucket.side === 'YES' ? mid : 1 - mid;
  const winPct = +((sideMid + Math.abs(bucket.biasPp) / 100) * 100).toFixed(1);

  return {
    side: bucket.side,
    price,
    limit: entryLimit(price),
    graceCents: CAL_GRACE_CENTS,
    // The spread gate IN FORCE at decision time, carried so the audit can judge this trade against the
    // rule it actually traded under. Without it, tightening the gate retroactively reclassifies every
    // older compliant trade as a violation -- which is what happened when 1.05c became 0.6c and 21
    // legitimate trades started reporting `spread: paid 1.00c > 0.6c gate` forever.
    maxSpreadCents: CAL_MAX_SPREAD_CENTS,
    bucket: bucket.label,
    marginal: bucket.marginal,
    winPct,
    breakEvenPct: +(breakEvenPrice * 100).toFixed(2),
    edgePt: +bucket.surplusPp.toFixed(2),
    biasPt: +Math.abs(bucket.biasPp).toFixed(2),
    feePt: +(feePt(price) * 100).toFixed(2),
    tStat: bucket.t,
    mid: +mid.toFixed(4),
    spreadCents,
    minutesLeft: ml
  };
}

module.exports = {
  evaluate, bucketFor, entryLimit, breakEven, feePt, finiteOrNull, etHour,
  CAL_BUCKETS, CAL_DECIDE_MIN, CAL_DECIDE_MAX, CAL_DECIDE_TARGET,
  CAL_BUCKETS_ALL: CAL_BUCKETS, CAL_ACTIVE_BUCKETS,
  CAL_MAX_SPREAD_CENTS, CAL_GRACE_CENTS, CAL_SKIP_ET_HOURS, CAL_FITTED,
  CAL_FORWARD_READY, CAL_LIVE_READY
};
