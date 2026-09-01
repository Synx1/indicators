# Rebuilding the prediction — what 68 days says

## The question

Can the indicators bot's predictions be remade to win more often?

## Why the old evidence could not answer it

Every finding before this rested on `.lab-cache.json`: **1,806 markets over 2.81 days**, all of it one
regime, and that regime was a rally. It produced a 68.2% headline whose own second chronological half
was **negative** (13/23 = 57%, −$10). A four-day corpus split in half is not a validation; it is two
samples of the same afternoon.

## The corpus this uses instead

| | Old | New |
|---|---:|---:|
| Markets | 1,806 | **45,030** |
| Days | 2.81 | **67.9** |
| Coins | 7 | 7 |
| Feature rows | — | **~585,000** |
| Regimes | one rally | June 26 → Sept 1 |

- **Markets** — every settled 15-minute market Kalshi still exposes, for all seven coins: strike,
  close, graded result. `fetch-markets.js`
- **Underlying** — 1-minute Coinbase candles with traded volume across the whole span, ~98,000 bars per
  coin. `fetch-candles.js`
- **Books** — per-minute `yes_ask` / `yes_bid` for a stratified sample (6 markets per coin per day,
  spread within each day by a fixed stride so a rerun scores identical rows). Kalshi serves books one
  market at a time, so all 45,030 would take hours; the sample measures a rule to within a point or two
  while keeping every regime. `fetch-books.js`

The book join is validated end to end against a real fill: on `KXBNB15M-26SEP011330-30` the derived NO
ask reads **0.65 at 13:17**, and the live bot filled that DOWN bet at 66¢ with slippage.

## Leakage control

Every feature at minute *m* is built only from candles closing strictly before *m*, and
`assertNoLookahead` **throws** rather than warns — a silent lookahead produces a beautiful model that
cannot be traded. All 334,620 rows built so far passed. Labels come from Kalshi's settlement, never from
the candle series, so a close-price rounding difference cannot leak into the target. Standardisation is
fitted on train only; fitting the scaler on everything is the quietest leak there is.

## What was modelled

At minute *m* of a 15-minute round, with `left = 15 − m`, predict P(close > strike). Thirteen
point-in-time features: `z`, `gapBps`, `leftMin`, `rsi14`, `emaSpread`, `vwapSpread`, `bbSpread`,
`ret1Bps`, `ret5Bps`, `ret15Bps`, `volRatio`, `volAccel`, `volBps`.

The live engine uses exactly **one** of these — `z` — and the four indicator votes only gate the
direction `z` already chose. Traded volume is not consulted at all. So the rebuild is not a new dial: it
asks whether those signals carry information the z-only model throws away, by fitting them jointly.

L2 logistic regression fitted by Newton/IRLS, refitted every 7 days walk-forward, each fold trained only
on strictly earlier days.

## The benchmark that matters

Not accuracy — a 15-minute binary near its strike is close to a coin flip, so accuracy mostly reports
the base rate. And not a constant either. **The benchmark is the price.** The ask *is* a probability,
published by people watching the same chart. A model that predicts well has found nothing if the book
already contains it.

So three tests, each able to kill the idea on its own:

1. **Head-to-head** — model vs book vs live engine, same rows, AUC and Brier.
2. **Residual** — fit `y ~ ask` and `y ~ ask + all 13 features`. If the second does not beat the first
   out of sample, the indicators are redundant to the price and no gate built on them can pay.
3. **Decision rules** — enter when `p − breakeven(ask) > edge`, priced at 15 shares with Kalshi's fee,
   split at the chronological midpoint.

Results follow below once the full fetch completes.

---

# Results

**585,390 feature rows · 386,958 scored out of sample · 68 days · fit on the first 23, tested forward.**

## 1. The extra features add nothing

| | AUC | Brier | Skill vs constant |
|---|---:|---:|---:|
| Live engine (`z` only) | 0.8465 | 0.161867 | +0.3525 |
| **Rebuilt model (13 features)** | **0.8474** | **0.159474** | **+0.3621** |
| Always the base rate | 0.5000 | 0.249991 | 0.0000 |

Twelve additional features — RSI, both EMAs, Bollinger, VWAP, three return horizons, traded volume,
volatility and volatility acceleration — buy **+0.0009 AUC**. The fitted weights say why:

```
z          +2.8982     ret5Bps    -0.0466
gapBps     +0.5885     ret1Bps    -0.0463
emaSpread  -0.0808     ret15Bps   +0.0398
leftMin    -0.0625     volAccel   -0.0170
bbSpread   -0.0590     volRatio   +0.0124
volBps     -0.0490     vwapSpread -0.0059
                       rsi14      +0.0024
```

`z` and the raw gap carry the model. **RSI's weight is +0.0024** — the indicator four-of-four
confirmation is built on, and the one the exhaustion guard was going to use, is indistinguishable from
zero once fitted alongside the rest. Traded volume, the feature the live bot never consults, earns
+0.0124 and does not deserve to be consulted.

## 2. The one real defect: the live engine is systematically COLD

| It says | It happens | |
|---:|---:|---|
| 44.8% | 48.8% | cold 4.0pt |
| 54.7% | **61.3%** | **cold 6.6pt** |
| 64.8% | **72.2%** | **cold 7.4pt** |
| 74.8% | **82.1%** | **cold 7.3pt** |
| 84.9% | 89.9% | cold 5.0pt |

On 386,958 rows the engine **understates** its probabilities through the whole middle of the range. The
rebuilt model is calibrated within ~1 point everywhere.

This corrects something I told you earlier today. I reported the confidence running "19 points hot" —
that came from 44 in-band entries on the old four-day corpus, and it is a selection artifact, not a
property of the model. Measured properly the engine errs the other way.

## 3. But calibration is not the problem, because it cannot change what gets picked

At the 80% gate, on the full board:

| | Rows cleared | Right |
|---|---:|---:|
| Live engine | 148,550 (38.4%) | **91.9%** |
| Rebuilt model | 166,689 (43.1%) | 91.1% |

A monotone recalibration cannot reorder rows, so it moves only where the line is drawn — **+18,139
trades for −0.8pt of hit rate**. The selection is untouched.

And note what that table actually says: **at its own 80% gate the engine is right 91.9% of the time.**
The success rate you asked for already exists. The next section is why it is worth nothing.

## 4. The price is better informed than any model here

**24,542 priced rows across 1,890 markets, 68 days, identical rows for every contender.**

> **Corrected.** The first version of this table gave the book a 60-second head start. Kalshi's
> `end_period_ts` is the END of a bar, so the bar I was pairing with a decision at minute *m* closed at
> *m+1* — the book was being scored on a price the model never saw. Fixed to the bar closing **at** the
> decision instant; the fill price still uses the later bar, because that is what an order actually pays.
> The book's advantage shrinks from +0.043 AUC to **+0.015**, and from 0.023 Brier to **0.008**. It still
> wins. Numbers below are the corrected ones.

| | AUC | Brier | Skill vs constant |
|---|---:|---:|---:|
| **The book (contemporaneous ask)** | **0.8528** | **0.157170** | **+0.3696** |
| Rebuilt model | 0.8376 | 0.164790 | +0.3391 |
| Live engine (`z` only) | 0.8370 | 0.164873 | +0.3387 |
| Always the base rate | 0.5000 | 0.249324 | 0.0000 |

The book wins on ranking **and** on calibration — by less than it first appeared, and still clearly. And it wins in every
price band — 1–10¢, 10–25¢, 25–40¢, 40–60¢, 60–75¢, 75–90¢, 90–99¢ — including, decisively, the one
band the bot can afford to trade:

| Region: conf ≥80%, ask 35–65¢ (n=163) | Brier |
|---|---:|
| The book | **0.2489** |
| Rebuilt model | 0.3363 |
| Live engine | 0.3406 |

A Brier of 0.249 is what you score by saying "coin flip" when it *is* a coin flip. **In the only region
this bot can afford, the market says coin flip and is right, while the model says 85% and is wrong.**

## 5. The indicators are worse than nothing once the price is known

Fit `y ~ ask` against `y ~ ask + all 13 features`, walk-forward:

| | AUC | Brier |
|---|---:|---:|
| A: ask, recalibrated | 0.8729 | **0.144725** |
| B: ask + all 13 indicators | 0.8693 | 0.147141 |

**Brier gain from every indicator, on top of the price: −0.002416.** Negative. Adding RSI, the EMAs,
Bollinger, VWAP, the return horizons, volume, volatility and volatility acceleration to the price makes
the forecast *worse* out of sample, and B's calibration shows why — it says 75.1% where 67.5% happens.
That is a model that has learned noise.

## 6. Every decision rule loses money

15 shares, Kalshi's real fee, real asks, split at the chronological midpoint:

| Rule | Trades | Win% | ROI | Net | Margin | 1st half | 2nd half |
|---|---:|---:|---:|---:|---:|---|---|
| **Live engine (conf≥80, 35–65¢)** | 270 | 55.2% | **−4.6%** | **−$108** | −2.7pt | 74/128 58% −$2 | 75/142 53% −$106 |
| EV edge > 0.02 | 1890 | 43.1% | −6.2% | −$803 | −3.0pt | −$190 | −$613 |
| EV edge > 0.05 | 1865 | 41.8% | −7.7% | −$977 | −3.7pt | −$202 | −$775 |
| EV edge > 0.10 | 1755 | 39.2% | −10.1% | −$1,154 | −4.6pt | −$97 | −$1,057 |
| EV edge > 0.15 | 1527 | 35.2% | −13.3% | −$1,234 | −5.6pt | −$278 | −$956 |

Two honest notes on the EV rules. They enter nearly every market because with thirteen chances per round
a noisy model always disagrees with the book by two cents somewhere — taking the *first* disagreement
rather than the largest is maximum adverse selection, and a better-specified rule would demand a bigger
gap. But `edge > 0.15` demands exactly that and loses more, so the conclusion is not an artifact of the
specification.

The live rule is the least bad thing on the table at **−4.6% ROI**, and its second half is −$106.

---

# Verdict

**The predictions cannot be remade to win more, because prediction is not the binding constraint.**

At its own 80% gate the engine is right **91.9%** of the time across 386,958 out-of-sample rows. The
success rate already exists. It is worth nothing, because the book prices those same markets at 90–98¢
where break-even is 90–98% — so the trades the model is right about are unaffordable, and the trades it
can afford are the ones where the book disagrees, and there the book is right.

Four independent tests, any one of which could have found an edge, all agree:

- Twelve new features on top of `z`: **+0.0009 AUC**.
- Model against the price, same rows: book **0.8806** AUC to the model's 0.8376.
- Indicators on top of the price: **−0.0024 Brier**. They subtract.
- Every decision rule, real prices, real fees: **−4.6% to −13.3% ROI**.

This is what an efficient market on a liquid contract looks like. A 15-minute crypto binary is priced by
people reading the same public 1-minute candles, and there is no residual in them.

## What is left

Two directions, both requiring information this setup does not have:

1. **Order-book imbalance.** Kalshi exposes live depth but publishes no history, so it can only be
   validated forward — log depth alongside every decision and grade it in a few weeks. This is the only
   remaining hypothesis with a stated mechanism.
2. **Cross-venue lead-lag.** If another exchange leads the settlement reference by even seconds, that is
   information the Kalshi book may lag. Binance's second-resolution endpoint was unreachable from here,
   so this is untested and is a different project — it needs a second feed and sub-minute execution.

## What should happen to the live bot

It is running a rule measured at −4.6% ROI over 270 trades whose second half is negative, and its live
book is consistent with that. The honest recommendation is **paper, or the smallest size that keeps you
interested**, until one of the two directions above produces something. Nothing in this study justifies
real money at size.

---

# Round two — non-linear models, Polymarket, and order flow

The first round closed on a **linear** residual test, and linearity was a real limitation: RSI should
matter at both ends, `z` should interact with the clock, volume probably only matters when extreme. A
linear term averages all of that into one slope and reports approximately zero — which is exactly what
RSI's +0.0024 weight was. So the conclusion was not safe until trees had a turn.

## 7. Gradient-boosted trees: same answer

Wrote a histogram GBM from scratch (`gbm.js`) — 255 quantile bins, logistic loss with Newton leaves,
early stopping on a held-out tail of each training window so tree count never touches the test fold.
Sanity check: **99.7% on a pure XOR** that a linear model scores ~50% on, so it can genuinely see
interaction.

**Without the price** — 352,131 out-of-sample rows:

| | AUC | Brier |
|---|---:|---:|
| Live engine (`z` only) | 0.8449 | 0.162563 |
| **GBM on 13 features** | **0.8479** | **0.159194** |

Trees beat logistic's +0.0009 with **+0.0030 AUC**, and they find some real structure — 18.9% of splits
go to `volAccel`, 11.2% to `leftMin`, so volatility acceleration and the clock do interact with `z`. But
the total is still three thousandths of AUC.

**With the price** — the decisive test, 24,542 rows:

| | AUC | Brier |
|---|---:|---:|
| The raw ask | 0.8733 | 0.145530 |
| **GBM on the ask alone** | 0.8717 | **0.145184** |
| GBM on ask + 13 indicators | 0.8691 | 0.146702 |
| Logistic on ask + indicators | 0.8693 | 0.147141 |

**Brier gain from the indicators, non-linearly, on top of the price: −0.001518.** Negative again. The
trees spend **49.1% of their splits on the ask** and still end up worse for having the indicators.

So the redundancy is not an artifact of assuming linearity. A model that provably captures interaction
reaches the same verdict.

**Rerun against a fairly-timed price** (after the lookahead fix in §4), 14,741 rows:

| | AUC | Brier |
|---|---:|---:|
| The raw ask | 0.8446 | 0.161119 |
| **GBM on the ask alone** | 0.8430 | **0.160502** |
| GBM on ask + 13 indicators | 0.8401 | 0.162266 |

**Brier gain from the indicators, non-linearly, on a fairly-timed price: −0.001764.** Still negative. The
verdict survives both corrections — non-linearity and the timing fix — independently.

### A pricing artifact worth recording

Pricing the decision rules at the decision instant instead of the fill bar looked more rigorous and was
not. A NO ask has to be derived as `1 − yesBid`, and at the decision minute the bid side is often thin or
absent: **22.2% of NO-side candidates derive an ask above 90¢** that way, against a median YES bid of 48¢
and a 1.5¢ mean spread. Those are empty book sides, not dear prices. A run built on them reported −26.5%
ROI purely from the artifact.

The fill bar closes a minute later, by which point the bid has filled in. Its ask carries a minute of
movement — a real but smaller objection, since the two YES asks differ by **0.27¢** on average. So the
rules in §6 are priced at the fill bar, which is also the more favourable of the two for the strategy.

## 8. Polymarket: there is no second book

Checked whether a second prediction market could provide a cross-market signal. Polymarket **does** run
5-minute crypto up/down markets on BTC, ETH, SOL and XRP — `btc-updown-5m-…`, three of which would fit
inside one Kalshi round. Promising until you look at the volume:

- Those markets are dated **December 2025**, nine months stale, with **volume 0 and liquidity 0**, still
  reported by the API as `active: true`.
- **Zero** crypto markets ending within the next hour.
- **Zero** crypto markets closing within 24 hours with more than $1k liquidity.
- The only crypto market in the top-volume list is *"Will Solana reach $190 in September?"* — a 29-day
  horizon on $1,000 of volume.
- Scanning 100 recently settled markets: **no** 5-minute up/down markets among them. What Polymarket
  actually trades is token-launch FDV and politics.

A market with no volume has no price, only a quote nobody took. There is no second book to compare
against, so the cross-market idea is closed — not disproven, absent.
