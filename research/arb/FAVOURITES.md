# Tested the "100% True Way to Win on 15m Crypto" post against 68 days of Kalshi book data

Data: per-minute `yes_bid` / `yes_ask` high-low-close for every settled 15-minute market on all seven
coins, straight from Kalshi's candlestick endpoint. 2026-06-26 to 2026-09-01. Fetch still running;
numbers below are from the first 4,199 markets, stride-sampled so they span the whole period.

Fees are charged the way the exchange charges them: `ceil(0.07·C·P·(1−P)·100)/100`, rounded up on the
whole order, at the size actually traded.

## What the post gets right

**The settlement mechanism.** Confirmed from Kalshi's own rules text, not inferred:

> "If the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:30 PM EDT ... is at least
> the simple average of the sixty seconds ... before 11:15 PM EDT, then the market resolves to Yes."

Both the strike and the settlement value are 60-second means. The "judgement tape" being slow is not a
conspiracy, it is the contract.

**"Nobody can tell you where it goes after you enter."** Every measurement agrees. Across every price
band, the realised win rate equals the price paid to within noise. 25.7¢ entries won 23.9%. 39.8¢ entries
won 37.6%. 60.2¢ entries won 60.3%. The market is fairly priced everywhere, so the fee is the whole
result.

**Don't buy the 1¢ lottery ticket.** Correct, and worse than the post says — see below.

## What the post gets wrong

**"Any win ratio greater than 40% will trend positive" at ≤40¢.** Break-even at 40¢ is not 40%, it is
41.68% — the price plus the fee. Measured, on 1,522 markets:

| entry band | avg price | win% | break-even | edge | ROI |
|---|---|---|---|---|---|
| 35-45¢ | 39.81¢ | 37.6% | 41.48% | **−3.84pp** | −9.25% |
| 20-40¢ | 30.71¢ | 28.6% | 32.20% | −3.61pp | −11.15% |
| 2-40¢ | 26.33¢ | 23.9% | 27.69% | −3.78pp | −13.44% |

**"Fees are almost non-existent at the .01 and .99 ends."** True at the 99¢ end, false at the 1¢ end. As a
share of the money put up, the fee is 0.07·(1−p): **6.9% of stake at 1¢**, 4.2% at 40¢, 0.4% at 94¢. The
cheap end is the most expensive place to pay this fee, not the cheapest.

**Take profit at 95-99¢ loses money.** It does convert reversals into wins — the win rate rises 0.3-0.9pp
because a market that touches 97¢ and then reverses becomes a winner. It is not enough. Giving up 1-5¢ on
every actual winner costs more than the reversals are worth, at every level, in every band:

| band | hold to settle | TP 99¢ | TP 97¢ | TP 95¢ |
|---|---|---|---|---|
| 35-45¢ | −6.80% | −6.96% | −8.14% | −9.36% |
| 45-55¢ | +2.70% | +1.91% | +0.89% | +0.38% |

Monotonic in the wrong direction. The exit is modelled generously — a resting limit sell that fills the
instant the bid touches, charged the taker fee — and it still loses.

**The two entry rules contradict each other.** "Enter at ≤40¢" and "never enter when the index is trending
away from the strike" cannot both hold: a contract is cheap *because* its side is losing. Scanning for the
first minute at or under 40¢ buys a falling knife by construction.

## What actually works: the mirror

A binary has two sides. If the cheap side loses 3.8 points below its price, the dear side wins above its.
That is the favourite-longshot bias — the crowd overpays for the underdog — and on Kalshi it lands where
the fee is nearly absent.

**Buy the favourite at 85-90¢, between 12 and 6 minutes left, hold to settlement.**

- 2,063 signals on 4,199 markets (fires on 49% of markets)
- average entry **87.17¢**, win rate **90.5%** (95% CI 89.16-91.69)
- break-even **87.95%** → **edge +2.54pp**, ROI **+2.89% of stake per trade**
- the confidence interval clears break-even
- worst losing streak **3**; max drawdown $782 against $5,242 profit at 100 contracts

It survives every check that killed the earlier findings in this project:

| check | result |
|---|---|
| all four chronological quarters | +1.96, +5.10, +0.79, +2.60 pp — all positive |
| per coin | 6 of 7 positive (SOL −0.35pp) |
| per side | YES +3.42pp, NO +1.90pp — symmetric, so not a bet on direction |
| every entry minute T-12..T-6 | +1.00 to +4.47pp — no single minute carries it |
| **band chosen blind on the first half, traded on the second** | **+1.78pp** |

The band was picked by searching 27 price bands × 4 time windows, so the best of 108 is upward-biased.
**The honest number is the out-of-sample one: +1.78pp, roughly +2.0% of stake per trade.**

## Dollars

32 signals a day across seven coins. Flat stake, no compounding:

| bank | size | horizon | mean | median | 5th pct | chance up | ruin |
|---|---|---|---|---|---|---|---|
| $10 | 1 contract | 4 days | $12.46 | $12.70 | $6.20 | 76% | 0.5% |
| $10 | 1 contract | 30 days | $28.12 | $28.70 | $8.44 | 94% | 3.9% |
| $50 | 5 | 30 days | $145 | $148 | $52 | 95% | 0.3% |
| $500 | 50 | 30 days | $1,497 | $1,531 | $562 | 96% | 0.03% |

20,000 runs, resampling whole 15-minute windows so the correlation between coins stays in (85.1% of
same-window pairs agree against 81.6% if independent).

**The cent tax on a small account.** At one contract the fee rounds up from 0.80¢ to a full cent, which
costs 0.25 of the 2.54 points. It is why $10 earns 2.48% a trade and $100 earns 2.69% for the identical
signal.

---

# The band fails on all seven series the bot does not trade

The obvious way to make more money on a small account is more markets. Kalshi runs the identical
15-minute product on fourteen series, and the bot trades seven. The other seven — GOLD, SILVER, COPPER,
NATGAS, WTI, NEAR, ZEC, 19,327 settled markets between them — would have roughly doubled the trade count,
and the five metals and energy ones would have cut the cross-coin correlation that is what actually caps
the stake.

Tested with the shipped gate, unchanged: 85-90¢, T-12..T-6, hold to settle, same fee, same grading.

| series | median volume | edge | in the bot? |
|---|---|---|---|
| BTC | 2,190,179 | **+2.11pp** | yes |
| GOLD | 199,132 | −4.45pp | no |
| ETH | 83,031 | **+1.92pp** | yes |
| WTI | 60,558 | −1.83pp | no |
| SILVER | 49,320 | −2.53pp | no |
| XRP | 39,698 | **+0.46pp** | yes |
| SOL | 36,663 | **+1.46pp** | yes |
| HYPE | 22,504 | **+1.03pp** | yes |
| DOGE | 18,482 | **+1.62pp** | yes |
| BNB | 9,246 | **+2.39pp** | yes |
| COPPER | 8,623 | −2.17pp | no |
| ZEC | 8,245 | −13.66pp | no |
| NEAR | 7,726 | −3.76pp | no |
| NATGAS | 6,616 | −6.24pp | no |

**Seven for, seven against, and the line falls exactly on which seven the bot already trades.** Pooled
across all fourteen the band loses 1.62pp.

## It is not liquidity

That was the hypothesis worth having, because it would have been a mechanism and a filter. It does not
hold. Correlation between log(median volume) and edge across the fourteen is 0.373 — and the two facts
that break it are plain in the table: GOLD is the second most heavily traded series of all fourteen and
loses 4.45pp, while BNB is eleventh and earns 2.39pp. Splitting at 20,000 contracts gives the heavily
traded group a mean edge of −0.23pp, because that group contains GOLD, WTI and SILVER.

It is not "crypto versus commodities" either. NEAR and ZEC are crypto and they are the two worst results
in the table.

## What this does to the finding

The chronological out-of-sample test held time out. It never held an ASSET out. These seven series are the
first genuinely independent test the band has faced, and it went 0 for 7.

Both groups look real rather than noisy: the seven coins average +1.57pp over ~900 signals each, which is
about four sigma as a group, and the other seven average −4.95pp on samples large enough to matter. So this
is not one lucky half of a distribution centred on zero — it is two opposite effects with no explanation
for the boundary between them.

**The 7-coin edge stands on its own 68 days of data and on nothing else.** It is statistically sound there —
6,362 signals, win 89.48% against break-even 87.93%, interval [88.71, 90.21], all four quarters positive,
both sides symmetric. It also has no stated mechanism and it failed the first test that varied something
other than the calendar. That combination means: run it in paper, keep the stake small if it goes live, and
do not scale it on the strength of the backtest.

## And it closes the only route to a bigger number on $50

More series was the one lever that improved the frontier rather than moving along it. It is gone — adding
those seven would add trades with negative expectancy. What is left on a $50 account is the size dial, and
the size dial turns against itself: the median session peaks at 12 contracts and falls after, because
beyond that the account cannot survive its own losing streaks.

---

# ROI drift and earlier entries: tested, and the price wins

The ask: stop using the price level as the signal, predict the drift instead, and enter earlier —
25-80¢ rather than 85-90¢ — whenever the trajectory says the price is about to run up.

Measured on 13,269 markets, 134,756 candidate entries at 25-80¢, T-13..T-3. Both sides, one entry per
market, Kalshi's fee charged the way the exchange charges it.

## The drift carries no information the price does not already have

Holding the **price** fixed and varying the **slope**, the settlement edge does not move:

| entry | falling hard | falling | flat | rising | rising hard |
|---|---|---|---|---|---|
| 25-40¢ | −3.37pp | −3.98pp | −5.24pp | −4.38pp | −4.74pp |
| 40-55¢ | −2.38pp | −2.62pp | −3.52pp | −4.40pp | −3.47pp |
| 55-70¢ | −1.29pp | −0.97pp | −0.62pp | −2.41pp | −2.33pp |
| 70-80¢ | +0.07pp | +0.86pp | +1.53pp | −0.57pp | −1.06pp |

No trend, and where there is any tilt it runs the wrong way — *rising* is slightly worse than *falling*
in three of four bands.

Nor does drift predict a run-up, which is the thing it was supposed to predict. Share of entries that
ever offered entry+10¢ before the close, at 25-40¢: **65.9% falling hard, 64.4% rising.** Identical.

**The Euler extrapolation is far worse than doing nothing.** Taking one step along the observed
trajectory, `P(t+k) ≈ P(t) + k·dP/dt`, and scoring it as a probability forecast against "the price is the
probability":

- price as the forecast — Brier **0.219154**
- one full Euler step to close — Brier 0.363043, **skill −65.66%**
- half a step — Brier 0.309847, **skill −41.38%**

Extrapolating the trajectory destroys the forecast. That is what happens when you add a momentum term to
a martingale.

## No take-profit works, at any target, from any entry band

72 combinations: nine entry bands from 25-80¢ × eight exits from hold-to-settle to +30¢. **Every one is
negative, and negative in both chronological halves.** The pattern says why:

| 70-80¢ entry | hold | +3¢ | +5¢ | +10¢ | +20¢ | +30¢ |
|---|---|---|---|---|---|---|
| ROI | −1.11% | −7.20% | −6.99% | −6.10% | −2.99% | −1.58% |
| fills | — | 92.2% | 90.0% | 85.1% | 78.0% | 75.1% |

The nearer the target, the worse the result. A +3¢ sell on a 70¢ contract fills 92% of the time for 3¢ and
forfeits the 30¢ upside on the ~72% that would have settled YES. Selling a 70% winner for three cents is
the trade being proposed, and it is a bad one.

## Why it cannot be fixed by a better filter

The price on this market is a martingale — it is already a probability, and the corpus says the realised
win rate equals it at every level. For a driftless walk with absorbing barriers, the chance of touching
p+k before touching 0 is p/(p+k), which makes a take-profit exactly zero-expectancy before fees at every
target. Observed fill rates sit ~8pp BELOW that value at every cell, which is what a *time-limited*
martingale does — three to thirteen minutes is not unlimited time to reach a barrier.

So the take-profit is worse than break-even before the fee is charged. And then the fee is charged twice:

| entry | fee | as a share of the stake | round trip |
|---|---|---|---|
| 25¢ | 1.31pp | 5.25% | 2.63pp |
| 50¢ | 1.75pp | 3.50% | 3.50pp |
| 80¢ | 1.12pp | 1.40% | 2.24pp |
| **87¢** | **0.79pp** | **0.91%** | **1.58pp** |

**Earlier entries are the most expensive place on the price line to trade.** 0.07·p·(1−p) peaks at 50¢.
The 25-80¢ band asks for a bigger edge than 85-90¢ does, while the measurements say there is less edge
there, not more. That is the whole reason the surviving strategy sits at 87¢: not because favourites are
special, but because the toll is smallest there and a small real bias can clear it.
