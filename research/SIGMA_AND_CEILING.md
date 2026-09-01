# Post-mortem study — two hypotheses tested, both rejected

Prompted by a live BNB loss on 2026-09-01: DOWN at 66¢, printed **85% · 4/4**, settled 0¢, −$6.76.
Reproduced exactly by `node postmortem.js BNB 2026-09-01T17:30:00Z 683.91` (86% at 13:16, 85% at 13:17).

Both mechanisms that single trade suggested turned out not to generalise. Recording them so neither gets
re-proposed as new.

## Rejected 1 — sigma is NOT biased low

The BNB round measured σ over a quiet 10-minute stretch (a $0.69 band) and projected it across 13
minutes that spanned $1.67 — 2.4× wider. σ came out $0.66 where the horizon delivered $1.30, so z read
−1.08 instead of ~−0.51. That looked like an estimator bug: `realizedVol(candles, 10)` measures ten
minutes and `vol * Math.sqrt(minutesLeft)` projects up to fourteen.

Tested across **12,629 entry-window observations over all 1,806 corpus markets**. For a correctly
scaled σ the standardised move |X|/σ has expectation √(2/π) = 0.798:

| | measured | expected | factor |
|---|---:|---:|---:|
| mean | 0.809 | 0.798 | **1.01×** |
| median | 0.664 | 0.674 | 0.98× |

No bias, and none that grows with the horizon (0.98–1.04× across 8–14 minutes left). Per coin BNB is
**0.93×** — σ is if anything slightly *over*stated there. The BNB round was a ~2σ draw from a correctly
scaled distribution, not a broken estimator.

There is a real but minor defect in the same direction: `variance` divides by `returns.length` rather
than `length − 1`, understating σ by ~5% at n=10. Not worth a behaviour change on its own.

## Rejected 2 — clamping the limit to the declared ceiling does not help

`MAX_PRICE = 0.65` is enforced on the **quote**; the order's limit is `quote + slippage` bounded only at
99¢ (`src/trader.js`, `limitCents`). With the two live accounts at 5¢ and 4¢ the effective ceilings are
70¢ and 69¢, and 9 of 12 recorded fills landed above 65¢ (up to 78¢). The code does not do what the
constant says — that part is true.

But clamping it costs volume for no gain. Both arms scan later minutes when the first signal is too dear,
which is what the live poller actually does:

| Arm | Ceiling | Entries | Won | Margin over break-even | Net (30 shares) |
|---|---:|---:|---:|---:|---:|
| **A clamped** | 65¢ | 44 | 68.2% | **+10.3pt** | **+$135.77** |
| B slip 4 | 69¢ | 63 | 68.3% | +6.0pt | +$113.68 |
| B slip 5 | 70¢ | 69 | 69.6% | +6.5pt | +$134.68 |
| B slip 10 | 75¢ | 124 | 75.0% | +6.1pt | +$227.79 |
| B max 20 | 85¢ | 406 | 80.5% | +0.6pt | +$81.41 |

Clamping moves 69 entries → 44 and net $134.68 → $135.77. **$1.09 across 1,806 markets.** The entries
the leak adds, taken alone, went 23/31 = 74.2% against a 69.6% break-even for +$42.69 — marginally
profitable, not losing.

Higher ceilings trade margin per bet for volume and land in the same place. The 75¢ arm shows the most
net dollars, and that is exactly the shape of the 70¢ price-floor finding that already reversed
out-of-sample on the full record — so it is recorded here and explicitly **not** recommended.

## What survived — the edge lives in the disagreement window

Holding the entry minute fixed and bucketing by whatever ask it carried (no price filter, so the bands
are comparable) over 1,393 price-blind entries:

| Ask band | n | Won | Needs | Margin |
|---|---:|---:|---:|---:|
| 55–65¢ | 9 | 66.7% | 62.6% | +4.1pt |
| 65–70¢ | 9 | 55.6% | 69.2% | −13.6pt |
| 70–80¢ | 38 | 55.3% | 77.1% | −21.9pt |
| **80–95¢** | **401** | **79.6%** | **90.1%** | **−10.6pt** |

Once the book agrees with the model there is nothing left: −10.6pt on n=401 with a tight 75–83% interval.
The profit comes from entering while the price is still cheap relative to the model's read. Waiting for
35–65¢ is not a cost constraint — it is the whole thesis.

That also explains the calibration gap. Price-blind, printed confidence is nearly honest: 94.0% printed
against 90.3% realised, only 3.7pt hot. In the band the bot actually trades it is **87.5% printed against
68.2% realised — 19 points hot**. The formula is not broken; the bot selects the subpopulation where its
model most disagrees with the book, and that is where the model is most wrong.

## Shipped

Nothing that changes a trade. Two things that stop the bot overstating itself:

- `postmortem.js` — replays `decide.engineEvaluate` against real Coinbase candles minute by minute for
  any settled round. Imports the production formula rather than copying it, so a divergence between the
  replay and a DM is always the data. States in its own output that one market cannot separate a bad
  model from a bad draw.
- `src/notify.js` — every DM now prints **model 85% · book 66%** instead of a bare `85%`, with the
  measured 19-point optimism named. The price paid is itself a probability and it is the better-informed
  one.

Also fixed while testing: `cents()` and `money()` rendered `NaN¢` and the new book figure rendered
`book 0%` for a missing price — `Number(null)` is 0 and passes a finite check. A price that failed to
record is not a price of zero. Pinned by `test/confidence-display.test.js`.
