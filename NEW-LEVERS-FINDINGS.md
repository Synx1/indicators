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
