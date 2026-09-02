# Kalshi structural arbitrage — measured, and dead

Scanned all 12,987 open events (109,242 legs) on 2026-09-01. 6,056 mutually-exclusive multi-leg
events priced.

## sum(yesAsk) < 1 — "buy every leg, one must pay $1"
107 candidates, the biggest at +90pt. **All false.** They are non-exhaustive events: 10 candidate
Netflix shows at 1¢ each, where the actual #1 show is not on the list. Buying all ten legs buys ten
losers. The screen finds them because "at most one YES" does not imply "at least one YES", and only
the second makes the sum a bound.

## sum(yesBid) > 1 — "sell every leg, at most one can pay"
63 candidates. This one is structurally sound — mutual exclusivity alone guarantees N−1 payouts —
and it is still not tradeable:

`KXNFLFFLEADER-27QB`, the best at +15pt over 25 legs:
- capital 25 − 1.15 = **$23.85** per set, locked until the 2027 NFL season ends
- fees at 1 contract/leg: 25 orders × 1-2¢ = **~35¢** against a 15¢ gross. Loses.
- fees at 100 contracts/leg: $6.83 against $15 gross → $8.17 on $2,385 = **0.34% over 16 months**
- and the thinnest leg offers **0.76 contracts**, so 100 is not available anyway

The per-order cent rounding is what kills the small size and the thin legs are what kill the large
size. Every candidate has the same shape: the over-round is smaller than the sum of the fees needed
to collect it.

## what this rules out
No model-free money on this exchange. Whatever earns has to come from being right about something,
which puts the fee back in the middle of the problem — see FAVOURITES.md for where the fee is
actually small.
