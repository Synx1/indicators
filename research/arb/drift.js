'use strict';
/**
 * ROI drift: trade the price's trajectory instead of its level.
 *
 * ── the question, and why it is a different one ──
 *
 * Every measurement in this project so far asked "does this contract WIN at settlement". This asks "does
 * this contract's price go UP from here" — a shorter horizon and a different trade. A 40c contract that
 * drifts to 70c can be sold at a profit whether or not it eventually settles NO, which is the day-trader
 * framing rather than the bettor's.
 *
 * ── why there is reason to expect something ──
 *
 * The band sweep found that cheap entries realise 3.8 points BELOW their own price. That is not a
 * mispricing of cheap contracts in general — it is a selection effect in how they were chosen. Scanning
 * forward for "the first minute at or under 40c" finds a price the moment it crosses DOWN through 40c, so
 * the rule systematically buys a falling knife. If falling-and-cheap loses 3.8 points, then rising-and-cheap
 * is the untested half of the same coin, and it is testable with the paths already fetched.
 *
 * ── the extrapolation, stated before it is fitted ──
 *
 * A contract price is a function of the underlying's distance to the strike and the time remaining. Its
 * drift is that function's time derivative, and the cheapest useful forecast is one Euler step along the
 * observed trajectory:
 *
 *     P(t + k) ≈ P(t) + k · dP/dt
 *
 * dP/dt is estimated from the last few minutes of the price itself, so nothing here needs the spot feed.
 * The forecast is only interesting if it beats the flat one — P(t+k) ≈ P(t) — which is the null this file
 * measures against. A drift term that adds nothing over "the price now" is a drift term with no edge, and
 * that is the outcome six previous feature sets produced.
 */
const fs = require('fs');
const path = require('path');
const A_LO = 0, A_HI = 1, A_CL = 2;

/** Load paths, oldest minute first, and keep only markets with a usable two-sided run. */
function load(file = 'paths.jsonl') {
  const out = [];
  for (const line of fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || r.p.length < 6) continue;
    r.p.sort((a, b) => b[0] - a[0]);          // T-15 ... T-1
    out.push(r);
  }
  return out.sort((a, b) => a.c - b.c);
}

/**
 * Both sides at one minute, from a REAL two-sided book.
 *
 * A missing ask reads as 1.0000 and a missing bid as 0.0000, and both are finite numbers that pass a range
 * check — the confusion that has produced three false results in this project. `mid` is what a drift is
 * measured on: using the ask alone makes a one-cent spread change look like a price move.
 */
function quote(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
  const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
  if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  return { yesAsk: a, yesBid: b, mid: (a + b) / 2, spread: +(a - b).toFixed(4) };
}
/** The best price a side could be SOLD into during a minute — what a take-profit would have caught. */
function sellable(row, side) {
  const ask = row[1], bid = row[2];
  if (side === 'YES') {
    const h = bid && bid[A_HI] != null ? Number(bid[A_HI]) : NaN;
    return h > 0 && h < 1 ? h : null;
  }
  const l = ask && ask[A_LO] != null ? Number(ask[A_LO]) : NaN;
  return l > 0 && l < 1 ? +(1 - l).toFixed(4) : null;
}

/**
 * Every (market, minute) that could have been an entry, with backward-looking features only.
 *
 * `side` is fixed per row as the DEAR side at that minute, because that is the side a drift is being read
 * on. Both sides are emitted so nothing is a directional bet: a YES-only sample would make a rally look
 * like an edge, which is exactly the artefact the 45-55c band produced earlier.
 */
function rows(ms, { minLeft = 3, maxLeft = 13, lo = 0.25, hi = 0.80 } = {}) {
  const out = [];
  for (const m of ms) {
    const byLeft = new Map();
    for (const r of m.p) byLeft.set(r[0], r);
    for (const row of m.p) {
      const L = row[0];
      if (L > maxLeft || L < minLeft) continue;
      const q = quote(row);
      if (!q) continue;
      // Three earlier minutes for the derivative. All strictly in the past.
      const p1 = byLeft.get(L + 1), p2 = byLeft.get(L + 2), p3 = byLeft.get(L + 3);
      const q1 = p1 && quote(p1), q2 = p2 && quote(p2), q3 = p3 && quote(p3);
      if (!q1 || !q2) continue;

      for (const side of ['YES', 'NO']) {
        const px = side === 'YES' ? q.yesAsk : +(1 - q.yesBid).toFixed(4);
        if (!(px >= lo && px <= hi)) continue;
        const mid = side === 'YES' ? q.mid : 1 - q.mid;
        const mid1 = side === 'YES' ? q1.mid : 1 - q1.mid;
        const mid2 = side === 'YES' ? q2.mid : 1 - q2.mid;
        const mid3 = q3 ? (side === 'YES' ? q3.mid : 1 - q3.mid) : null;

        // dP/dt over one and two minutes, and the change in that slope. Cents per minute.
        const d1 = +(mid - mid1).toFixed(4);
        const d2 = +((mid - mid2) / 2).toFixed(4);
        const accel = mid3 == null ? null : +((mid - mid1) - (mid1 - mid2)).toFixed(4);
        // Realised volatility of the price path itself, over the three deltas available.
        const steps = [mid - mid1, mid1 - mid2].concat(mid3 == null ? [] : [mid2 - mid3]);
        const vol = +Math.sqrt(steps.reduce((a, x) => a + x * x, 0) / steps.length).toFixed(4);

        // ── the Euler step ──
        // One step of the observed trajectory, carried to the close and clamped to a probability.
        const proj = Math.max(0.01, Math.min(0.99, mid + d1 * L));

        // What actually happened afterwards, for grading. Strictly later minutes.
        let maxSell = null;
        for (let k = L - 1; k >= 0; k--) {
          const later = byLeft.get(k);
          if (!later) continue;
          const s = sellable(later, side);
          if (s != null && (maxSell == null || s > maxSell)) maxSell = s;
        }
        out.push({
          sym: m.s, close: m.c, left: L, side, px, mid, d1, d2, accel, vol, proj,
          spread: q.spread,
          won: side === 'YES' ? m.r === 1 : m.r === 0,
          maxSell
        });
      }
    }
  }
  return out;
}

module.exports = { load, quote, sellable, rows };
