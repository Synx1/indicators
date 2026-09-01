# corpus2 — the 68-day rebuild

Read `REBUILD.md`. Verdict: **the predictions cannot be remade to win more, because prediction is not
the binding constraint** — the book is better informed than any model built on public 1-minute candles.

## Reproduce

    node research/corpus2/fetch-markets.js    # 45,030 settled markets, 7 coins, 68 days   (~2 min)
    node research/corpus2/fetch-candles.js    # 1-min Coinbase candles + volume            (~60 min)
    PER_DAY=6 node research/corpus2/fetch-books.js   # per-minute Kalshi books, sampled     (~12 min)
    node research/corpus2/features.js         # 585,390 point-in-time rows                 (~4 min)
    node research/corpus2/evaluate.js         # walk-forward: model vs the live engine
    node research/corpus2/decide.js           # model vs the BOOK, and decision rules priced
    node research/corpus2/residual.js         # do the indicators add anything to the price?

Run them in that order; each reads the previous one's output. Raise `--max-old-space-size` for
`features.js` onward — the matrix is 85 MB.

## Files

| | |
|---|---|
| `fetch-markets.js` → `markets.json` | strike, close, graded result per market |
| `fetch-candles.js` → `candles/*.json` | `[ms, low, high, close, volume]`, ~98k bars per coin |
| `fetch-books.js` → `books.json` | `[ms, yesAsk, yesBid]` per minute, stratified 6/coin/day |
| `features.js` → `features.json` | 13 point-in-time features + label + meta |
| `model.js` | L2 logistic, Newton/IRLS. Scaler fitted on train only |
| `evaluate.js` → `evaluation.json` | walk-forward AUC / Brier / reliability vs the live engine |
| `decide.js` → `decisions.json` | model vs book head-to-head, and EV rules priced at 15 shares |
| `residual.js` → `residual.json` | `y ~ ask` against `y ~ ask + indicators` |

## The two things to know before touching this again

**`assertNoLookahead` throws.** Every feature at minute *m* is built from candles closing strictly
before *m*, and all 585,390 rows pass. A silent lookahead produces a beautiful model that cannot be
traded, so the build fails rather than warns.

**The benchmark is the price, not a constant.** `z` alone ranks these markets at AUC 0.85, which reads
like a discovery and is not one — the book ranks them at 0.88 and charges for it. Any future idea has to
beat the ask on identical rows or it is not an edge. `decide.js::headToHead` is where that is decided.
