# New-levers findings — live gate (2026-08-30)

Read-only spike over the full 1806-market corpus at the **current live gate**
(`src/trader.js`: conf≥80, 3/4 confirm, 25–65¢, 8<ml<14, hold to settlement).
Engine + indicators imported from `src/decide.js`, so these numbers cannot diverge
from production. Reproduce with `node research-newlevers.js` and `node research-decay.js`
(`MM_DATA_DIR` overrides the data dir).

**Nothing here is shipped.** This is the answer to "what raises the success rate,"
and the answer is: none of the three competitor-style levers survives the sample, and
the sample itself is the finding.

## Baseline

| metric | value |
|---|---|
| entries | 68 / 1806 markets (3.8% selectivity) |
| net (30 sh/trade, fees modeled) | +$416.59 |
| win rate | 80.9% |
| $/trade | +$6.13 |
| avg entry | 58.8¢ → structural breakeven |
| margin (win% − entry) | **+22.1pp** |

The edge is real and both chronological halves are net-positive. But the win rate
falls 94% → 68% across the two halves, and that decay is the whole story.

## 1) Calibration — the overconfidence worry does NOT hold at 80

The 80–82 band is half the sample (33/68): stated ~81%, realized 78.8% — only
**−2.2pp**, essentially honest. The scary 87%-on-a-coin-flip overconfidence from
`LOSS-AUTOPSY.md` was a sub-80 / vol-collapse artifact, and the 80 gate already
screens it out. Higher bands (90+, n=4 and n=1) are too thin to read.

**Verdict: no calibration penalty needed. The gate already does that job.**

## 2) Dip vs momentum — not actionable

Only **5 DIP entries vs 63 MOVE** in the entire corpus. The bot is a momentum bot by
construction; the competitor's dip filter has almost nothing to act on here. DIP's
higher margin (27.6 vs 21.7pp) is on n=5 — noise.

**Verdict: nothing to filter.**

## 3) Per-coin — looks tempting, is curve-fitting

ETH is the only net-negative (−$22, 33% win) — on **n=3**. XRP shows 100% here but was
a net *loser* under the old gate; a signal that flips sign when the gate changes is not
a signal. BNB is the workhorse (25 entries, +$137).

**Verdict: no per-coin disable survives. Too thin, and unstable across gates.**

## The real finding: a regime-dependent directional short

The decay decomposition (`research-decay.js`) says the corpus spans **only 4 days**
(2026-08-05 → 2026-08-08), and the win rate falls monotonically by quartile:

| quartile | dates | win% | $/trade |
|---|---|---|---|
| Q1 | 08-05→08-06 | 94.1% | +$9.66 |
| Q2 | 08-06 | 94.1% | +$9.72 |
| Q3 | 08-06→08-07 | 76.5% | +$4.75 |
| Q4 | 08-07→08-08 | 58.8% | +$0.38 |

This is **not** time-decay of an edge. It is one directional tilt meeting a regime flip:

- **63 of 68 entries are NO** (betting the coin closes *below* strike). The strategy is
  structurally short at this gate; it is not diversified two-way betting.
- Splitting the NO book by half: **93.8% win (Aug 5–6) → 64.5% win (Aug 7–8).** Every
  YES bet (all 5) won in both halves. The collapse is entirely the short book meeting a
  two-day crypto rally.
- Every second-half loss is a NO position (BTC/ETH×2/SOL×2/BNB×5/DOGE), spread across
  *different* settlement windows — so the existing same-window correlation guard would
  not have caught them.

Clustered entries (≥2 in one 15-min window) win 73.1% vs 85.7% solo, and 2 of 12
multi-entry windows were all-lose wipeouts. Correlation remains the dominant risk lever,
exactly as `indicators-strategy-eval` says — but here the correlation is *directional*
(all-NO in a rally), not same-window.

## Why no new rule ships

A directional-exposure cap (limit concurrent same-direction positions across windows)
would bound the rally losses — but clustered NO bets were net +$3.90/trade even in this
sample, so capping them cuts EV as much as variance. This is the same trap as the
vol-floor (reverted, halved profit) and the stop-loss (made it worse). Optimizing a rule
on **4 days** of a single directional regime is textbook curve-fitting, and
`indicators-strategy-eval` already says: judge on samples, not a handful of trades.

## Recommendation

1. **Do not ship any of the three levers, or a directional cap, on this data.** The 80
   gate is already calibrated; the rest is sample noise over 4 days.
2. **The strategy's success rate is a function of regime, not just signal quality.** A
   two-way corpus (an up regime *and* a down regime) is required before the 80.9% can be
   trusted as skill rather than a lucky short window.
3. **Grow the corpus and re-run.** Both scripts are parameterized on `MM_DATA_DIR`;
   re-run as data accumulates and revisit per-coin/directional splits once any slice has
   ~30+ entries spanning both regimes.
4. **Watch the NO/YES win-rate split live** as the health signal — a NO book win rate
   sliding under ~65% is the early warning that the market has turned against the tilt.

## Take-profit A/B — the DirectionalBot's one transferable idea, tested

The competitor broadcasts a stream of clean "cashout" wins, and the one mechanic behind
them that looked worth stealing is **early take-profit** (sell at ~90¢ instead of holding
to settlement). Bento's own live run of that bot (v1.75, Aggressive) went **50% win /
−$3.25 / $7.88 balance** — the broadcasts are survivorship bias (a position only posts a
"win" if it reaches 86¢+; the rest settle quietly at a loss). So the take-profit was
tested honestly here rather than taken on faith.

`research-takeprofit.js` holds the entry set FIXED (the same 68 live-gate entries) and
varies only the exit, selling into the bid with a two-sided fee:

| strategy | net | $/trade | win% | sd/trade | Sharpe* | rescued | capped |
|---|---|---|---|---|---|---|---|
| **HOLD (baseline)** | **+$416.59** | +$6.13 | 80.9% | $11.43 | **0.536** | 0 | 0 |
| sell-all @85¢ | +$329.90 | +$4.85 | 83.8% | $9.86 | 0.492 | 2 | 50 |
| sell-all @90¢ | +$343.22 | +$5.05 | 82.4% | $10.49 | 0.481 | 1 | 50 |
| sell-all @95¢ | +$376.61 | +$5.54 | 80.9% | $11.17 | 0.496 | 0 | 47 |
| sell-half @90¢ | +$379.76 | +$5.58 | 80.9% | $10.81 | 0.517 | 1 | 50 |
| sell-half @95¢ | +$396.47 | +$5.83 | 80.9% | $11.30 | 0.516 | 0 | 47 |

*Sharpe = mean/sd per trade (unitless variance-adjusted comparison, not annualized).

**Every take-profit variant loses on both return and Sharpe.** The `rescued`/`capped`
split is why: TP capped ~50 winners (forfeiting the last cents on trades that would have
settled at $1) and rescued ~1 loser. At this gate the positions that climb to 90¢ are the
ones that were going to win anyway — the bot enters **late, on confirmation** (55–65¢,
high conf), when the outcome is nearly decided, so there is no end-of-window reversal to
insure against. The DirectionalBot's early exit helps *it* because it enters **cheap at
the onset** (~50¢) where reversal risk is real; the identical rule hurts a
confirmation-late strategy. Same mechanic, opposite value.

**Verdict: do not add take-profit. Hold-to-settlement is optimal for this entry style,
and the competitor thread is closed — the only good idea it had (cheap entries) is already
in the live gate.**

## 2026-08-31 — "buy cheaper" and "cap the direction", tested end to end

Follow-up to the question *"how does the DirectionalBot make money at 77%?"* The answer is
payoff geometry — breakeven win rate **equals** entry price, so a 77% bot buying at 50¢ earns
+27¢/contract while the same 77% at 65¢ barely clears fees. So both levers were run on the full
corpus with the production engine (`research-pricesweep.js`, `research-dircap.js`).

### Lever A — lower MAX_PRICE (buy cheaper). Tested: makes it WORSE.

| band | n | net | win% | $/trade | margin |
|---|---|---|---|---|---|
| **25-65¢ (live)** | 68 | **+$416.59** | **80.9%** | +$6.13 | **+22.1pp** |
| 25-60¢ | 32 | +$168.62 | 71.9% | +$5.27 | +19.3pp |
| 25-55¢ | 14 | +$41.11 | 57.1% | +$2.94 | +11.5pp |
| 25-50¢ | 10 | +$18.62 | 50.0% | +$1.86 | +7.9pp |

Every tighter ceiling cuts volume, win rate AND margin. The reason is the mirror of the
take-profit result: this bot enters **late, on confirmation**, so by the time it fires the cheap
contracts are the ones where the signal is *weak* — cheap = coin-flip. The DirectionalBot enters
**early**, where cheap = mispriced. Same price, opposite meaning; the lever does not port. The
current 25-65¢ band already has the best margin.

### Lever B — cap concurrent same-direction positions. Tested: raises win% but cuts $.

| sideCap | taken | net | win% | $/trade | skipped-that-wouldve (net / win%) |
|---|---|---|---|---|---|
| 1 | 55 | +$381.16 | **83.6%** | +$6.93 | +$35.43 / 69.2% |
| 2 | 66 | +$395.67 | 80.3% | +$5.99 | +$20.92 / 100% |
| 3 / none | 68 | +$416.59 | 80.9% | +$6.13 | — |

A cap of 1 **does** raise the win rate (80.9→83.6%) — the thing the user asked for — but the
shorts it declines still won 69% and were net **+$35**, so the cap buys a higher hit rate and a
smaller drawdown by **forfeiting expected dollars**. And this is measured on the ONE regime
(a rally) where capping shorts should look best; it still lost money. That is decisive against
making it the default.

### What shipped

`maxPerDir` — an **opt-in, blank-by-default** per-user setting (src/settings.js) enforced in
`trader.accountBlock` right after `maxOpen`. Blank = today's behaviour, unchanged. Set to N, it
refuses an (N+1)th open position pointing the same way across different windows — the slow
directional concentration the same-window rule misses. Off by default because the data says it
costs money; exposed because the user may rationally prefer a higher hit rate and a hard stop on a
one-sided book to maximum EV. Covered by `test/entry-guards.test.js` (per-direction, paper-exempt,
count/direction in the message) and mutation-checked (>=/>, side filter, null guard all caught).

**Bottom line for "higher success rate": it is achievable — flip `maxPerDir` to 1-2 — but it is a
trade, not a free win. A higher win rate here is bought with lower total profit, because the bot is
already right 81% of the time and the leak was never accuracy.**

## 2026-08-31 (later) — strengthening BTC/ETH/SOL: the min-gap floor

Bento asked to strengthen the three weakest coins. `research-coindetail.js` dissected all 19 of their
live-gate entries and the losers were **not** lower-confidence or lower-confirm than the winners:

| metric | winners | losers |
|---|---|---|
| entry price | 62.5¢ | **55.2¢** |
| confidence | 82.8 | 81.8 |
| confirms | 3.85 | 4.00 |
| **\|gap\| from strike** | 0.044% | **0.033%** |

So the losing trades were the ones where **spot was sitting on the strike**. That is a mechanism, not
bad luck. `z = gap / sigma`, `sigma = realizedVol(10) * sqrt(minutesLeft)` — when crypto goes quiet
and vol collapses (~1e-4 on this corpus), sigma goes tiny and a gap of 0.02% divides out to `z = 1.6`,
i.e. a stated **94% on a coin flip**. `MIN_CONF` cannot screen it, because confidence is HIGHEST
exactly when sigma is smallest. `LOSS-AUTOPSY.md` saw the symptom and blamed sub-80 confidence; the
actual cause is the near-zero gap.

A vol *floor* was tried for this before and reverted (halved profit) — it inflated sigma everywhere
and destroyed the legitimate high-conviction reads too. The direct form works (`research-mingap.js`):

| minGap | kept | net | win% | $/trade | 1st half | 2nd half (RALLY) |
|---|---|---|---|---|---|---|
| **none** | 68 | +$416.59 | 80.9% | +$6.13 | +$329.51 (94.1%) | +$87.08 (67.6%) |
| **0.03%** | 62 | **+$434.67** | **83.9%** | +$7.01 | +$329.51 (94.1%) | **+$105.16 (71.4%)** |
| 0.04% | 55 | +$435.84 | 87.3% | +$7.92 | +$314.41 (96.7%) | +$121.43 (76.0%) |
| 0.05% | 48 | +$350.47 | 85.4% | +$7.30 | +$280.51 (96.3%) | +$69.96 (71.4%) |

The weak three specifically: **19 trades / 68.4% / +$37.53 → 13 trades / 76.9% / +$55.61.** ETH's
−$21.97 disappears entirely (all three of its entries were inside the floor). The 13 trades the floor
drops won **53.8%** — coin flips, exactly as the mechanism predicts.

**Why this one shipped when the others did not:** it improves the WEAKER half (the Aug 7-8 rally,
the closest thing in the data to what hurt the live book) while leaving the good half untouched —
the same test `MIN_MINUTES 8` had to pass. And unlike a tuned dial it is defensible without the
backtest at all: at gap→0 the true probability is 50% whatever the arithmetic reports.

0.03 rather than the marginally better 0.04 because 0.04 cuts BTC from 8 entries to 2, which is
closer to disabling a coin than filtering it.

Shipped as `MIN_GAP_PCT = 0.03` in src/trader.js (a module constant, like MIN_CONF — this is what a
signal IS, not a risk appetite), with skip reason `on-strike`. Reverting is one line.

### Caveats, stated plainly

- Still **one four-day corpus**, one regime. The mechanism is sound; the exact threshold is not
  precision-tested and 0.025-0.05 all look similar.
- 13 dropped trades is a small sample for the 53.8% figure. The *direction* is what the mechanism
  predicts; the magnitude is noisy.
- BTC and DOGE each lose a couple of good trades to the floor (−$9.85 / −$10.02 net). The gain is
  concentrated in ETH and the rally half.

### Also shipped: the Coins tab

`/api/state` now carries a per-coin scoreboard (settled, W/L, win%, net, per-trade, open) and the
dashboard renders it as a **Coins** tab. Aggregate across accounts, so it names nobody and stays on
the open route.

The load-bearing column is **trust** — `thin` under 10 settled, `fair` under 30, `good` at 30+ — and
it renders before the win rate on purpose. Every previous attempt to pick coins off this bot's
numbers was defeated by sample size: the two coins showing 100% in the backtest had 7 and 9 trades,
and one of them was a net LOSER under the previous gate. The headline refuses to name a best market
until some coin has 10 settled trades. That is the answer to "what are the best markets": not the
backtest's ranking, but this table as real trades land.


