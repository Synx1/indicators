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
