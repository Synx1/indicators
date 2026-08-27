# Indicators strategy — replay findings (corrected)

Reviewed 2026-08-25. **This file was rewritten after the replay in `replay.js`
disproved two of my initial conclusions.** Read the correction; the first draft
was wrong in an instructive way.

## What I got wrong from the 20-trade live sample

The live bot showed $100 → $79.42, 20 trades, 80% win vs an 83.9% breakeven, and
I concluded the payoff geometry "cannot win" and that a stop-loss was the fix.
**Both were artifacts of a 20-trade sample.** Replayed over 837 leak-free entries
across 9 coins with Kalshi fees modelled:

```
no-stop baseline : +$596 over 837 trades, win 86.0%, breakeven 83.5%
```

86.0% clears the 83.5% bar. The strategy is **marginally +EV**, ~+$0.72/trade.
The live −$20.58 was variance — 4 losses in 20 landed on the wrong side of an
edge that is real but thin.

## Correction 1 — a stop-loss makes it strictly WORSE

Sweeping the stop from 30c to 70c, PnL falls monotonically from the +$596
no-stop baseline (50c: +$401, 70c: +$47). On 15-minute favorite markets, most
mid-round dips recover by settlement, so a stop converts eventual winners into
realized losses. **Do not add a stop.** (This is why we replay before shipping —
the stop I first proposed would have cut $200–550 of edge.)

## Correction 2 — the price cap is NOT a safe lever either (walked back)

My first pass off the replay said "lower the ceiling 0.90 → 0.85 for +$72." Then
the live board arrived and **contradicted the replay on exactly that band**:

```
band     replay (fixed EMA, 837 trades)   live (broken EMA, 23 trades)
85-90c   -$72   (291 trades)              +$29.82  (11W / 0L)
75-85c   +$476  (best)                    small, mixed
<75c     weak, 74.5% win                  -$35.52  (3W / 3L)
```

Two caveats collide here and both matter:

1. **Live and replay are different strategies.** The deployed bot runs the broken
   `calcEMA` (the fix is local, uncommitted). The replay runs the fixed one. So
   these tables were produced by different entry logic — live cannot validate the
   replay. But it also means **the replay's +EV has never actually run live.**
2. **The profitable band is not stable between windows.** Even discounting the
   strategy difference, the fact that the top band is the worst in one 3-day
   window and 11/0 in another is exactly the instability that makes tuning an
   entry cap on ~3 days of data overfitting. **Do not ship a price cap yet.**

The only price statement both datasets support: **cheap entries (<75c) are weak.**
That points at *raising the floor* more than lowering the ceiling — but same
caveat applies, so it is a hypothesis to forward-test, not a change to ship.

## Correction 3 — `calcEMA` was reading ~30 min in the past (still valid, fixed)

This one held up and is fixed. `calcEMA` reversed all 60 candles then capped the
loop from the start, so `ema9` finished ~33 min behind while `ema20` finished at
the present — the `ema9 > ema20` confirmation compared two different times and
flipped on 6/6 coins when tested live. Fixed to walk oldest→newest ending on the
latest bar. Independent of any strategy question.

## How trustworthy is the +EV? (the part that keeps us honest)

Promising, **not** a green light to scale stake. The caveats are real:

- **One short regime.** Each coin's data spans ~67 hours — 2–3 days. Adjacent
  15-min rounds are highly correlated, so the effective sample is far below 837.
  A favorite-buying strategy looks great across calm days and takes its losses in
  clusters on the volatile one this window may not contain.
- **Thin edge, CI touches breakeven.** +$0.72/trade. The lower bound of the win-
  rate interval sits near the 83.5% breakeven even before accounting for
  correlation.
- **Not universal.** Per coin: XRP is −$39 (83.2% < its 84.3% b/e), BNB thin.
  DOGE and SOL carry most of the total.
- **Decays over time.** First chronological half +$438 (87.6%), second +$159
  (84.5%). Still positive, but weakening toward breakeven.
- **Replay ≠ live.** Modelled the bid/ask spread and fees, but not slippage from
  the 5s scan cadence, partial fills, or API latency. Live will be worse than
  paper.

## Still worth doing (unchanged from first draft, still true)

- **Fees are now modelled here but NOT in the live bot's reported PnL.** Kalshi
  charges `ceil(0.07·C·P·(1−P))` per side; the dashboard PnL is optimistic by
  ~$0.34/round-trip.
- **Stuck-position sweeper.** `checkCashouts` swallows all errors and with
  `MAX_POS = 3`, three positions whose settlement fetch keeps failing silently
  halt trading. The local dev copy was found in exactly this state.
- **`Procfile` is `web: node server.js & node bot.js`** — a dead `server.js`
  kills the dashboard without a Railway restart.
- **Comment drift**: header says "45-90c / cashout 95c"; code is 25–90c / 97c.

## Recommended order (revised again after the live board)

1. **Ship the `calcEMA` fix.** This is the only unambiguous win. The live bot is
   demonstrably running a broken indicator (one of four confirmations reads ~33
   min stale, flips on 6/6 coins). It is a defect, not a parameter — fixing it
   doesn't curve-fit anything. Everything the live board shows was produced by
   the broken version, so this is also the prerequisite to trusting any future
   live measurement.
2. Add the stuck-position sweeper so the bot can't silently stop trading.
3. Model fees in the live PnL so every future measurement is honest.
4. **Do NOT add a stop** (disproven) and **do NOT tune the entry price cap yet**
   (replay and live disagree on which band wins — that's overfitting bait).
5. Forward-test the *fixed* strategy on paper across a volatile stretch before
   any stake increase. The short-regime risk + the fact that the +EV strategy
   has never actually run live are the two things most likely to turn this into
   −EV. More data beats more parameters here.
