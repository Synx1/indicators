# Competitor Analysis — "@TheDirectionalBot" (v2.0) / support "@ItzDirectional"

**Author:** competitor-analysis agent
**Date:** 2026-08-26
**Scope:** Research + analysis only. No code was changed. Input = 5 cashout notifications Bento pasted from one burst (self-published wins).
**Epistemic labels used throughout:** **[EVIDENCE]** = derivable from the pasted data or verified math. **[INFERENCE]** = reasoned reconstruction, could be wrong. **[UNKNOWN]** = cannot be determined from what we have.

---

## 0. TL;DR

- The 5 "wins" are **arithmetically real Kalshi trades** — 4 of 5 reproduce to the exact cent under Kalshi's two-sided fee formula (see §2). This is not fabricated marketing math.
- But they are **not 5 independent wins**. They are **one correlated macro call** (crypto complex DOWN) expressed across BTC/ETH/SOL in a single 8:03–8:04 PM ET window, doubled up on BTC and ETH. **Effective independent sample size ≈ 1.**
- The single biggest structural difference vs our bot is **entry price / timing**: they enter **early and cheap (50–56¢)**; our losing cluster entered **late and expensive (83–86¢)**. Entry price sets both your breakeven hurdle and your risk/reward. At 54¢ you need to be right 54% of the time (R/R ≈ 0.86:1). At 85¢ you need to be right 85% of the time to break even and you win only 15¢ while risking 85¢ (R/R ≈ 0.18:1). **This one fact explains most of the visible performance gap.**
- **Selection bias is severe and structural.** These are cashout notifications. The early-cashout mechanism *is* the selection filter: a position that never reaches 86¢+ produces no cashout notification — it just quietly loses at settlement. Their correlated same-direction stacking amplifies wins **and** losses; we are shown only the winning burst.
- **Could not verify any public footprint** for either handle from this environment (WebSearch degraded, X behind a paywall, GitHub null). No track record, pricing, or claims are asserted here because none could be sourced. See §1.
- **Verdict on our new correlation guard:** right instinct, too blunt as a hard rule. The problem in our lost cluster was *correlation at expensive entries with no margin of safety*, not correlation per se. Recommend making it **conditional on entry price + signal strength** and treating a correlated cluster as **one risk unit** rather than banning it. See §7.

---

## 1. Public research — findings and honest null result

**I could not retrieve any public information about @TheDirectionalBot or @ItzDirectional from this environment.** Per the brief, I will not fabricate a track record, pricing, or claims. Here is exactly what I tried and what happened, so the null result is auditable:

| Channel | Attempt | Result |
|---|---|---|
| WebSearch tool | 5 queries (handles, "Kalshi crypto bot", etc.) | **Tool degraded** — returned model-generated "I can't search" placeholders, not real result blocks. One query hard-blocked (`content-blocked`). No usable results. |
| X / Twitter | `x.com/TheDirectionalBot`, `x.com/ItzDirectional` | **HTTP 402 Payment Required** (auth/paywall). Cannot read either profile. |
| Nitter mirrors | `nitter.poast.org`, `bitter.st`, `nitter.net` | Cert mismatch / 503 / `content-blocked`. |
| Jina reader proxy | `r.jina.ai/...x.com/ItzDirectional`, `s.jina.ai` search | 403 / 401. |
| Bing | `"TheDirectionalBot" Kalshi crypto bot` (quoted) | Returned **entirely unrelated results** (language forums, Sri Lankan education) + "some results removed." A quoted rare handle returning pure noise ≈ no meaningful indexed match. |
| Google | quoted `"TheDirectionalBot" OR "ItzDirectional"` | Fallback/error page, no results. |
| DuckDuckGo (html + lite) | quoted handle | CAPTCHA / bot-verification challenge. |
| SearX (`searx.be`) | quoted handle | Anti-bot "verifying your browser" challenge. |
| GitHub (authenticated `gh`) | exact-quoted repo + code + user search for both handles | **0 repos, 0 code matches, 0 users** for either exact handle. |
| Kalshi docs (for fee citation) | `kalshi.com/docs/.../fees`, `help.kalshi.com` | 429 / 404. |

**What this null result does and does not mean:**
- **[EVIDENCE]** There is no discoverable open-source (GitHub) implementation under these handles.
- **[INFERENCE, weak]** The absence of any indexed web match for the exact quoted handle is *consistent with* a small/new/private operation or a **closed Discord/Telegram paid-signal service** rather than a public product. But search was degraded/blocked, so absence-of-evidence here is **not** strong evidence of absence. Do not over-read it.
- **[INFERENCE]** The naming pattern — a bot handle "@TheDirectionalBot" advertised at **"v2.0"** with a **separate human support handle** ("@ItzDirectional") and a stream of broadcast cashout notifications — is the classic shape of a **subscription/paid-signal service**. If so, its commercial incentive is to **publish wins to sell subscriptions**, which predicts *maximal* selection bias in anything it posts. (Clearly labeled inference — I could not confirm a product, price, or Discord.)

> If Bento can paste the account bio, pinned post, pricing page, or a Discord invite (things behind the paywall I hit), I can analyze the actual claims. Right now I have zero verified external claims to evaluate.

---

## 2. Quantitative analysis of the burst (verified)

All figures below are computed and cross-checked. Net P&L was tested against **Kalshi's standard trading-fee formula**: `fee_per_side = ceil_to_cent(0.07 × contracts × P × (1−P))`, charged on **both** entry and exit; settlement is free. *(Formula from prior knowledge — I could not fetch kalshi.com live this session, 429/404 — but it is corroborated internally below.)*

| # | Coin | Side | Entry | Exit | Sh | Move | Gross | Reported net | Implied fee | Kalshi entry+exit | Match? |
|---|------|------|------:|-----:|---:|-----:|------:|-------------:|------------:|------------------:|:------:|
| 1 | BTC | DOWN | 56¢ | 95¢ | 100 | 39¢ | $39.00 | **+$36.93** | $2.07 | $1.73 + $0.34 = $2.07 | ✅ exact |
| 2 | BTC | DOWN | 56¢ | 97¢ | 50  | 41¢ | $20.50 | **+$19.52** | $0.98 | $0.87 + $0.11 = $0.98 | ✅ exact |
| 3 | ETH | DOWN | 55¢ | 86¢ | 45  | 31¢ | $13.95 | **+$12.79** | $1.16 | $0.78 + $0.38 = $1.16 | ✅ exact |
| 4 | ETH | DOWN | 54¢ | 95¢ | 100 | 41¢ | $41.00 | **+$38.92** | $2.08 | $1.74 + $0.34 = $2.08 | ✅ exact |
| 5 | SOL | DOWN | 50¢ | 95¢ | 100 | 45¢ | $45.00 | **+$43.33** | $1.67 | $1.76 + $0.34 = $2.10 | ⚠︎ off $0.43 |
| | | | | | **395** | | **$159.45** | **+$151.49** | **$7.96** | | |

**Headline aggregates [EVIDENCE]:**
- **Cost basis deployed:** $212.75. **Net profit:** +$151.49. **Return on deployed capital in one 15-min window: +71.2%** (on winners only — see selection bias, §3).
- Weighted-average entry **53.9¢**; weighted-average exit **~94.2¢**. Captured move **~31–45¢** per leg.
- Total fees **$7.96 = 5.3% of net.** Fees are a rounding error here because the edge is enormous; they do **not** drive the story.

**Why the fee check matters:** 4 of 5 legs reproduce the reported net **to the exact cent** using the two-sided Kalshi formula. Fabricated "marketing" P&L almost never lands on Kalshi's oddly-shaped `ceil(0.07·n·P·(1−P))` fee to the penny on both sides. **[INFERENCE, high confidence]** these are **genuine Kalshi fills**, real or paper.

**Leg 5 (SOL) discrepancy [EVIDENCE + INFERENCE]:** formula predicts $2.10 fees, only $1.67 was taken (Δ $0.43). At exactly 50¢ the entry fee is at its theoretical **maximum** ($1.76). Most likely explanation: the entry was a **resting/maker limit order** (reduced or rebated fee) or a partial fill averaged below the notified price. It does not change any conclusion.

**Breakeven & risk/reward — the crux [EVIDENCE]:**

| Position | Entry | Breakeven win-rate | If wins | If loses | Reward:Risk (to $1) |
|---|---:|---:|---:|---:|---:|
| Their avg | 53.9¢ | **53.9%** | +46.1¢ | −53.9¢ | 0.86 : 1 |
| Their cheapest (SOL) | 50.0¢ | **50.0%** | +50.0¢ | −50.0¢ | 1.00 : 1 |
| **Our lost cluster** | ~84.5¢ | **84.5%** | +15.5¢ | −84.5¢ | **0.18 : 1** |

**Fee-per-share by entry price** (Kalshi fee is *maximized* at 50¢): 50¢ → 1.75¢/sh; 70¢ → 1.47¢/sh; 85¢ → 0.89¢/sh; 95¢ → 0.33¢/sh. Note the irony: the competitor pays the **highest possible entry fee** (entering near 50¢) and it doesn't matter, while our 85¢ entries pay **lower** fees for a structurally terrible 0.18:1 payoff. **Cheap fees at 85¢ are a trap, not a saving.**

---

## 3. Selection bias — what we CAN and CANNOT infer

This is the most important section. **These are self-published cashout notifications from one burst.**

### What we CAN infer [EVIDENCE]
1. In this burst they traded the **DOWN** side only.
2. They entered **cheap: 50–56¢** (near coin-flip pricing).
3. They entered **early: 8:03–8:04 PM ET** — i.e. ~3–4 min into an 8:00–8:15 Kalshi window, before the move had priced in.
4. They **fired across correlated coins simultaneously** (BTC, ETH, SOL in the same 60–90 seconds), and **doubled up** on BTC (100+50) and ETH (45+100).
5. They **exited early: 86–97¢, before settlement** (two-sided fees prove a sell, not an expiry).
6. They used **variable size: 45 / 50 / 100 / 100 / 100**.
7. The economics of *these specific* trades: cheap entry → low breakeven → ~1:1 R/R → large captured move → +71% on capital.
8. The P&L is consistent with real Kalshi fills (§2).

### What we CANNOT infer [UNKNOWN] — do not let anyone call this a money-printer
- **Win rate.** Zero losing trades are shown. The **cashout mechanism itself is the selection filter**: a position that never climbs to 86¢+ generates *no* cashout notification — it just settles, quietly, at a loss. We are looking at the survivors.
- **Net profitability / expectancy over time.** One winning burst says nothing about the equity curve.
- **Loss distribution.** Same-direction correlated stacking across BTC/ETH/SOL means when the macro call is **wrong**, *all* legs fall together — a symmetric burst would be roughly **−$150 from 50¢ → 0**, and that burst would not be advertised.
- **Effective sample size.** Crypto majors are highly correlated intraday. This is **≈1 independent event**, not 5. You cannot estimate a hit rate from n≈1.
- **Signal logic, bankroll, drawdown, Sharpe, real vs paper, how often they trade, whether entries are always this cheap or cherry-picked.**

> **One-line framing for the team:** we are being shown the single best photo from someone's vacation and asked to infer their whole life. The photo is real; the life is unknown.

---

## 4. Structural facts → what each implies

| Observed fact [EVIDENCE] | Most likely implication [INFERENCE] |
|---|---|
| Entry 50–56¢, ~3–4 min into the window | Signal is **anticipatory / momentum-onset**, fired while the market is still ~50/50. They **buy before confirmation**, not after. |
| All DOWN, 3 coins, same 90 seconds | **One market-wide signal** on a correlated basket (macro crypto down-tick), not 3 independent edges. All-DOWN is almost certainly *that day's tape*, not a permanent short bias. |
| Doubled on BTC (100+50) & ETH (45+100) | Either scaling into conviction, a split/averaged fill, or two sub-signals. Consistent with **conviction-scaled sizing**. |
| Exit 86–97¢, pre-settlement | **Take-profit rule** that locks gains once the contract is deep ITM, deliberately avoiding late-window settlement reversal risk. Also conveniently produces a clean stream of "win" notifications. |
| Size 45–100, not fixed | **Confidence- or liquidity-scaled sizing** (vs our fixed 30). |
| Net matches two-sided Kalshi fee to the cent | Real fills; they **pay the exit fee** that hold-to-settlement avoids — a small, deliberate cost for variance reduction. |

---

## 5. Reverse-engineered strategy (most likely) [INFERENCE]

> A **momentum-onset, multi-coin, cheap-entry / early-exit** strategy:
> 1. **Detect a market-wide directional impulse early** in a fresh 15-min crypto window (first few minutes), while contracts are still near 50¢.
> 2. **Enter the whole correlated basket** (BTC/ETH/SOL…) in the signalled direction at cheap prices, **sizing up** on the strongest legs.
> 3. **Ride intra-window momentum**, then **take profit early at ~86–97¢** rather than holding to settlement, locking the move and dodging end-of-window reversals.
> 4. Accept high correlation/variance because the **cheap entry gives a low breakeven and ~1:1 payoff**, so being directionally right *often enough* is profitable — and publish the wins.

This is essentially the **mirror image** of our bot:

| | Competitor (inferred) | Our bot |
|---|---|---|
| Entry timing | Early, at move **onset** (~50¢) | Late, on **confirmation** (z≥85% + 2/4 indicators) → often 80¢+ |
| Entry price band | Cheap (~50–56¢ here) | 25–90¢ (permits structurally bad 83–86¢ entries) |
| Correlated coins | **Stacks** them (upside participation) | **Now capped** at ≤1/direction/window |
| Exit | **Early take-profit** 86–97¢ | Usually **holds to settlement** (cash only at 97¢) |
| Sizing | Variable 45–100 | **Fixed 30** |
| Per-trade hit rate | Likely **lower** (buys before confirmation) | Likely **higher** (waits for confirmation) |
| Per-trade R/R & breakeven | **Excellent** (~1:1, ~54%) | **Poor** when late (~0.18:1, ~85%) |

The deep point: our confirmation logic **buys certainty that the market has already priced.** An "85% confidence" z-signal that only triggers an entry at 85¢ has **no margin of safety** — you're paying fair value for the confirmation and keeping ~zero edge after fees. That is the most plausible reason the DOGE/XRP/ETH cluster at 83–86¢ lost: no cushion, and one correlated reversal took all legs at once.

---

## 6. Ranked adoptable techniques

Ranked by **expected structural value net of overfitting risk**. Each: benefit / risk / interaction with our strategy / sound-vs-overfit.

### #1 — Cap fresh-entry price and stop buying structurally bad odds (highest value, lowest risk)
- **Change:** forbid *new* directional entries above ~**72–75¢** (tighten the 25–90¢ band on the top end). At 85¢ you need 85% accuracy to break even and win 15¢ risking 85¢.
- **Benefit:** removes the worst R/R zone that just cost us a whole cluster. Directly addresses the lost trade.
- **Risk:** fewer trades; you skip some that would have won.
- **Interaction:** complements the z-score engine — it just refuses to *act* when the market has already repriced past the point of edge.
- **Verdict:** **Sound structural guardrail.** Not overfit — it's a risk-of-ruin / breakeven-math argument, not a fit to 5 wins. **Do this first.**

### #2 — Add an early take-profit / scale-out rule (high value, low risk, easy to test)
- **Change:** instead of "hold to settlement, cash only at 97¢," **scale out**: e.g. sell half at ~90¢ and hold half, or take profit fully if late-window realized vol is high. At 95¢, holding to settlement risks 95¢ to gain 5¢ (R/R 19:1 against) — only worth it if win-prob > 95%.
- **Benefit:** cuts variance, locks gains, avoids end-of-window reversals; steadier equity curve.
- **Risk:** if our positions usually settle ITM, early exit lowers gross EV slightly and pays an extra exit fee (~0.33¢/sh at 95¢ — tiny).
- **Interaction:** directly changes our "usually holds to settlement" default. Cleanest A/B we can run: replay history, compare hold-to-settlement vs sell-half-at-90¢.
- **Verdict:** **Sound, and the easiest high-value experiment.** The competitor's early exits are partly *why their notifications look so clean* — but variance reduction is a real, defensible benefit independent of the marketing.

### #3 — Add an earlier "onset" entry mode (highest ceiling, highest execution risk)
- **Change:** a **second, anticipatory entry path** that enters cheap (≤~60¢) at move onset on a fast signal, at **reduced size**, run in parallel with (not replacing) the current confirmation path.
- **Benefit:** this is the competitor's core edge — cheap entry fixes the breakeven/R/R problem at the root. Biggest upside.
- **Risk:** anticipatory signals have **lower hit rate** by construction; you trade the 85% hurdle for a ~54% hurdle but must actually clear 54%. Needs genuine predictive signal, not just "enter early and hope."
- **Interaction:** our current engine is late by design (waits for z≥85% + 2/4). Onset entry is a **different signal**, not a threshold tweak. Validate hit rate on history before risking size.
- **Verdict:** **Structurally sound in principle, easiest thing to overfit in practice.** Prototype small, size tiny, measure realized hit rate vs the 54% breakeven before scaling. Do **not** copy their exact 8:03–8:04 timing or "always DOWN" — those are artifacts of one burst (see §8).

### #4 — Make the correlation guard conditional, and treat a cluster as one risk unit (medium value)
- Full verdict in §7. **Change:** replace the hard ≤1/direction/window with: allow correlated same-direction legs **only when entries are cheap (≤~65¢) and signal is strong**, cap the cluster's **total** risk to one unit, and scale each additional leg's size down. Forbid correlated stacking at ≥~75¢ entirely.
- **Benefit:** recaptures the competitor's upside participation on genuine market-wide moves without the 85¢ catastrophe.
- **Risk:** more complex; needs data to tune; correlated stacking is inherently higher-variance even when cheap.
- **Verdict:** **Sound refinement, but keep the current blunt guard until we have data** (see §7). Medium priority.

### #5 — Confidence-scaled sizing (medium value, needs a calibration check first)
- **Change:** replace **fixed 30 shares** with size ∝ edge — **fractional Kelly (¼–½)**, hard max cap.
- **Benefit:** more capital on the best edges, less on marginal ones; matches their variable 45–100.
- **Risk:** **amplifies variance and punishes miscalibrated confidence.** If our "85% confidence" is not a true 85% win rate (the lost cluster hints it may be optimistic), Kelly sizing will **over-bet losers**.
- **Interaction:** depends entirely on confidence calibration. **Prerequisite:** plot predicted-confidence vs realized-win-rate on history. Only enable scaling where calibration holds; cap hard.
- **Verdict:** **Sound *only after* a calibration audit.** Otherwise an overfitting/over-betting trap.

---

## 7. Verdict on the new correlation guard (≤1 position per direction per window)

**Right instinct, too blunt as a permanent hard rule.**

- **Why it's right, right now:** we just *lost* a correlated cluster (DOGE/XRP/ETH DOWN at 83–86¢, all lost). Same-direction correlated stacking converts several "diversified" bets into **one concentrated bet on a single macro move**. When entries are expensive (≥80¢), that bet has **bad EV *and* catastrophic variance** — worst of both. With no data on our true hit rate, capping variance is the correct default. **Keep the guard on for now.**
- **Why it's too blunt:** it treats a **50¢ correlated stack** (each leg ~1:1 R/R, ~54% breakeven — a *good* bet made high-variance) identically to an **85¢ correlated stack** (each leg 0.18:1, 85% breakeven — a *bad* bet made catastrophic). The competitor's advertised burst was exactly the *cheap* kind, and a hard ≤1 rule would have let us take **only one** of those 5 legs. The guard, as written, would also have blocked the upside.
- **The real lesson from comparing both clusters:** the killer wasn't correlation alone — it was **correlation × expensive entry × no margin of safety.** Fix entry price (#1) and much of the correlation danger goes away on its own.
- **Recommended evolution (once we have loss data):** make it **conditional** —
  1. Allow correlated same-direction legs **only if** entry ≤ ~65¢ **and** signal strength is high.
  2. Treat the whole correlated cluster as **one risk unit**: cap total shares across the cluster to a single position's budget, and **scale down** each additional leg.
  3. **Forbid** correlated stacking at entries ≥ ~75¢ outright.
- **Do not** simply remove the guard on the strength of 5 advertised wins — that would be fitting risk policy to the competitor's survivorship-biased highlight reel.

---

## 8. Overfitting traps to avoid (things NOT to copy)

- **"Always trade DOWN."** All-DOWN reflects *that session's* falling tape, not a permanent edge. Copying a short bias would blow up on the first green day.
- **The exact 8:03–8:04 entry / 95¢ exit numbers.** Artifacts of one burst. The *principles* (enter early/cheap, exit before settlement) may generalize; the specific clock times and price will not.
- **"Correlated stacking prints money."** We are shown only the winning stack. The identical mechanism produces the −$150 bursts we never see.
- **Reading their win rate off these notifications.** Impossible (n≈1, survivorship-filtered). Any number inferred here would be fiction.
- **Chasing their look with our numbers.** Their clean win stream is partly an *artifact of early-cashout + publishing wins*, not proof of superior expectancy.

---

## 9. Recommended experiments & data to collect

Everything above is a hypothesis until backtested on **our own** history. Priority order:
1. **Backtest an entry-price cap** at 70/72/75¢ (technique #1): P&L, trade count, win rate by entry-price bucket. Expect the 80¢+ bucket to be a net loser.
2. **Backtest early take-profit** (technique #2): hold-to-settlement vs sell-half-at-90¢ vs full-exit-at-90/95¢. Compare mean P&L **and** variance/drawdown.
3. **Calibration audit** (prereq for #5): predicted z-confidence vs realized win rate, bucketed. Are we actually right 85% of the time when we claim 85%?
4. **Cluster replay** (technique #4): re-run historical correlated windows under (a) current ≤1 guard, (b) conditional guard, (c) no guard — at both cheap and expensive entry buckets.
5. **Prototype an onset-entry signal** (technique #3) on paper only, tiny size, and measure realized hit rate against the 54% breakeven before it touches real size.

**What to ask Bento for that would unlock more:** a paste of the competitor's bio / pinned post / pricing / Discord (behind the paywall I hit), and — more importantly — **our own losing trades** from the same period, so we can estimate a real hit rate instead of reasoning from the competitor's survivors.

---

## 10. Sources & research log

- **Primary data:** the 5 cashout notifications Bento pasted (self-published wins; single burst). Treated as the only hard external data point.
- **Computation:** verified locally (Python); Kalshi fee model `ceil_to_cent(0.07 × contracts × P × (1−P))` per side, entry+exit, settlement free — **from prior knowledge, not fetched this session** (kalshi.com returned 429/404), but **internally corroborated** by 4/5 legs reproducing the reported net to the cent.
- **External web research: no citable sources obtained.** Every discovery channel was blocked, degraded, paywalled, or returned no match. Full attempt log with status codes in §1. In particular:
  - GitHub (authenticated): `search/repositories`, `search/code`, `search/users` for `"TheDirectionalBot"` and `"ItzDirectional"` → **0 results each** (verifiable via `gh api`).
  - X profiles `x.com/TheDirectionalBot`, `x.com/ItzDirectional` → **HTTP 402** (could not read).
  - No pricing, track record, Discord, or product page could be confirmed. **None is asserted.**

**Bottom line:** the competitor's edge, *to the extent these trades represent it*, is **cheap early entry + early exit on a correlated basket** — the mirror image of our late-confirmation / hold-to-settlement bot. The techniques worth adopting (entry-price cap, early take-profit, conditional correlation handling, calibrated confidence sizing) are individually sound and testable. But the "profitability" on display is unverified survivorship, and the correlation guard should be **refined, not removed**, on the strength of our own data — never on the strength of five advertised wins.
