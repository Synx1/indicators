#!/usr/bin/env node
/**
 * Stop-loss + fee replay for the indicators strategy.
 *
 * Question this answers: the live bot's payoff is ~1:5 (win +$4, lose -$22) with
 * an 83.9% breakeven it does not clear. Does adding a stop-loss move it to
 * positive expectancy, and at what level — measured over 2000+ settled markets
 * instead of the 20 the live bot has taken?
 *
 * It imports the decision functions from ./bot.js directly (engineEvaluate, the
 * four indicators), so this measures the SHIPPING strategy. If bot.js changes,
 * this changes with it. That is the whole point — a hand-copied model drifts and
 * then the backtest is measuring fiction.
 *
 * Data: BETSSSSS/data/multimarket-<COIN>.json, collected by that repo. Each row
 * is one settled 15-minute market with a per-minute YES bid/ask path (minutes
 * 14..0 to close), the strike, and the real settlement. Verified separately:
 * the stored bid/ask is the YES side (quotes march to 1.0 on a YES settlement),
 * so NO fills are derived spread-aware as no_ask = 1 - yes_bid, no_bid = 1 - yes_ask.
 *
 * LEAKAGE DISCIPLINE (the reason to trust the output):
 *   - The entry decision sees only candles that CLOSED strictly before entry
 *     (closedBefore), and spot = the last such close. No peek at the forming
 *     candle, which is already slightly more conservative than the live bot.
 *   - settledYes / settlementValue are never in scope during the entry decision;
 *     they are read only to grade a position that was already opened.
 *   - The stop level is swept AFTER entries are fixed, so changing the stop can
 *     never change which markets were entered — only how each one exits.
 */

const fs = require('fs');
const path = require('path');
const bot = require('./bot');

// Where the collected market data lives. Overridable for a different checkout.
const DATA_DIR = process.env.MM_DATA_DIR ||
  '/Users/bento/workplace/BETSSSSS/data';

const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const MODEL_FEES = !flags.has('--no-fees');   // fees on by default; reality has them
const FEE_COEF = Number(process.env.FEE_COEF || 0.07);  // Kalshi general fee coefficient

// Entry window mirrors the live bot's 3 < minutesLeft < 14. We take the FIRST
// minute in that window (scanning 13 -> 4) where the gates pass, which is the
// closest single-shot analogue to a bot that scans every 5s and enters on the
// first qualifying look.
const ENTRY_SCAN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const MIN_CANDLES = 20;        // need enough history for EMA20/BB/VWAP; else skip

const STOP_LEVELS = [null, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

// ── Kalshi fee ──────────────────────────────────────
// fee = round UP to the cent of 0.07 * contracts * price * (1 - price), charged
// on every trade (entry, and any cashout/stop sell). Holding to settlement is
// not a trade, so it carries no exit fee.
function fee(price, contracts) {
  if (!MODEL_FEES) return 0;
  return Math.ceil(FEE_COEF * contracts * price * (1 - price) * 100) / 100;
}

// ── data loading ────────────────────────────────────

function loadCoin(sym) {
  const file = path.join(DATA_DIR, `multimarket-${sym}.json`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Bucket candles by minute for O(1) as-of lookups. Coinbase candle time is
  // in SECONDS; closeMs is in ms — the one unit trap in this dataset.
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { sym, rows: j.rows || [], byTime };
}

/** Completed candles strictly before ts, newest first — the leak-free window. */
function closedBefore(byTime, ts, depth) {
  const out = [];
  let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) {
    const c = byTime.get(t);
    if (c) out.push(c);
  }
  return out;
}

// ── the live decision, replayed ─────────────────────
// This is a faithful inline of bot.js scan()'s gate: engine picks a side at
// >=85% confidence, 2 of 4 indicators must agree, entry price must sit in the
// band. It calls bot.js's OWN functions so it cannot compute a different number
// than production.
function decideEntry(row, byTime) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;

    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;

    const spot = candles[0].close;         // last completed close, known at entry
    const res = bot.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || res.confidence < bot.MIN_CONF) continue;

    const rsi = bot.calcRSI(candles, 14);
    const ema9 = bot.calcEMA(candles, 9);
    const ema20 = bot.calcEMA(candles, 20);
    const bb = bot.calcBollingerBands(candles, 20);
    const vwap = bot.calcVWAP(candles, 20);
    let confirm = 0;
    if (res.side === 'YES') {
      if (rsi > 50) confirm++;
      if (ema9 > ema20) confirm++;
      if (bb && spot > bb.middle) confirm++;
      if (spot > vwap) confirm++;
    } else {
      if (rsi < 50) confirm++;
      if (ema9 < ema20) confirm++;
      if (bb && spot < bb.middle) confirm++;
      if (spot < vwap) confirm++;
    }
    if (confirm < 2) continue;

    // Fill: YES pays yes_ask (=q.ask); NO pays no_ask (=1 - yes_bid).
    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < 0.25 || entryPrice > 0.80) continue;   // mirror bot.js gate (0.80 cap)

    return { min, side: res.side, entryPrice, confidence: res.confidence };
  }
  return null;
}

/**
 * Exit a fixed entry under one stop level. Walks the price path from just after
 * entry to close; cashes out at >=0.97, stops at <=STOP, else settles.
 */
function simulateExit(row, entry, stop, tp) {
  const shares = bot.SHARES;
  const entryFee = fee(entry.entryPrice, shares);
  const TP = tp != null ? tp : bot.CASHOUT;   // take-profit level (default = live 0.97)

  for (let min = entry.min - 1; min >= 0; min--) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.bid >= 0) || !(q.ask > 0)) continue;
    // Price we could SELL at now (spread-aware): YES sells at yes_bid, NO sells
    // at no_bid = 1 - yes_ask.
    const sell = entry.side === 'YES' ? q.bid : (1 - q.ask);

    if (sell >= TP) {
      const gross = shares * (sell - entry.entryPrice);
      return { exit: 'cashout', sell, pnl: gross - entryFee - fee(sell, shares) };
    }
    if (stop != null && sell <= stop) {
      const gross = shares * (sell - entry.entryPrice);
      return { exit: 'stop', sell, pnl: gross - entryFee - fee(sell, shares) };
    }
  }

  // Held to settlement — winners pay $1, losers $0, no exit-side fee.
  const won = (entry.side === 'YES' && row.settledYes) ||
              (entry.side === 'NO' && !row.settledYes);
  const gross = won ? shares * (1 - entry.entryPrice) : -shares * entry.entryPrice;
  return { exit: won ? 'settle-win' : 'settle-loss', sell: won ? 1 : 0, pnl: gross - entryFee };
}

// ── run ─────────────────────────────────────────────

function summarize(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const be = (avgWin + avgLoss) ? avgLoss / (avgWin + avgLoss) : 0;
  const mix = {};
  for (const t of trades) mix[t.exit] = (mix[t.exit] || 0) + 1;
  return {
    n: trades.length, pnl, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin, avgLoss, breakeven: be, mix
  };
}

function main() {
  const coins = bot.COINS.map(c => c.sym);
  const entered = [];        // entries are stop-independent, computed once
  let pool = 0, skippedNoData = 0;

  for (const sym of coins) {
    let ds;
    try { ds = loadCoin(sym); }
    catch (e) { console.log(`  (no data for ${sym}: ${e.code || e.message})`); continue; }
    for (const row of ds.rows) {
      pool++;
      const e = decideEntry(row, ds.byTime);
      if (!e) continue;
      entered.push({ sym, row, entry: e });
    }
  }

  const pct = x => (x * 100).toFixed(1) + '%';
  const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);

  console.log('');
  console.log('  INDICATORS STOP-LOSS REPLAY');
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  coins: ${coins.join(' ')}   fees: ${MODEL_FEES ? `on (coef ${FEE_COEF})` : 'OFF'}`);
  console.log(`  markets scanned: ${pool}   entries taken: ${entered.length} ` +
    `(${pct(entered.length / pool)} of pool)`);
  console.log('  ' + '─'.repeat(74));
  console.log('  entry gate reproduced from bot.js: engine >=85% + 2/4 indicators + 25-90c band');
  console.log('  leak-free: decision sees only candles closed before entry; settlement read only to grade');
  console.log('  ' + '─'.repeat(74));
  console.log('');
  console.log('  stop    trades   net PnL     win%    avgWin   avgLoss   b/e     exit mix (cashout/settle-win/settle-loss/stop)');

  const rows = [];
  for (const stop of STOP_LEVELS) {
    const trades = entered.map(x => ({ ...simulateExit(x.row, x.entry, stop), sym: x.sym }));
    const s = summarize(trades);
    rows.push({ stop, s });
    const m = s.mix;
    const label = stop == null ? 'none' : Math.round(stop * 100) + 'c';
    console.log(
      `  ${label.padEnd(6)}  ${String(s.n).padStart(5)}   ${usd(s.pnl).padStart(9)}  ` +
      `${pct(s.winRate).padStart(6)}  ${usd(s.avgWin).padStart(7)}  ${('-$' + s.avgLoss.toFixed(2)).padStart(7)}  ` +
      `${pct(s.breakeven).padStart(6)}   ` +
      `${m.cashout || 0}/${m['settle-win'] || 0}/${m['settle-loss'] || 0}/${m.stop || 0}`
    );
  }

  // Verdict, stated against the baseline.
  const base = rows.find(r => r.stop == null).s;
  const best = rows.slice().sort((a, b) => b.s.pnl - a.s.pnl)[0];
  console.log('');
  console.log('  ' + '─'.repeat(74));
  console.log(`  no-stop baseline : ${usd(base.pnl)} over ${base.n} trades, win ${pct(base.winRate)}, breakeven ${pct(base.breakeven)}`);
  if (best.stop == null) {
    console.log('  best stop        : NONE — no swept stop beats holding to settlement on this data.');
    console.log('  => a stop is not the fix here; the entry gate or payoff target is. See notes.');
  } else {
    const delta = best.s.pnl - base.pnl;
    console.log(`  best stop        : ${Math.round(best.stop * 100)}c -> ${usd(best.s.pnl)} ` +
      `(${usd(delta)} vs no stop), win ${pct(best.s.winRate)}`);
    console.log(`  => a ${Math.round(best.stop * 100)}c stop turns the payoff from ${usd(base.pnl)} to ${usd(best.s.pnl)} on ${base.n} trades.`);
  }
  console.log('  ' + '─'.repeat(74));
  console.log('  NB: per-trade economics with flat 30 shares; portfolio caps (MAX_POS, bankroll%) not modelled.');
  console.log('');

  auditRobustness(entered, pct, usd);
}

/**
 * The +EV baseline is only trustworthy if it is not (a) one lucky coin, (b) one
 * calm stretch of a ~3-day window, or (c) the thin-payoff favorites that a quiet
 * backtest flatters. This prints the three cuts that would expose each.
 */
function auditRobustness(entered, pct, usd) {
  const base = e => simulateExit(e.row, e.entry, null);

  // (a) per coin — is the edge broad or carried by one symbol?
  console.log('  ROBUSTNESS 1 — per coin (no stop):');
  const bySym = {};
  for (const x of entered) (bySym[x.sym] ||= []).push({ ...base(x), sym: x.sym });
  for (const sym of Object.keys(bySym)) {
    const s = summarize(bySym[sym]);
    console.log(`    ${sym.padEnd(5)} ${String(s.n).padStart(4)} trades   ${usd(s.pnl).padStart(9)}   win ${pct(s.winRate).padStart(6)}   b/e ${pct(s.breakeven)}`);
  }

  // (b) chronological halves — does the edge survive out of the first half?
  const chron = entered.slice().sort((a, b) => a.row.closeMs - b.row.closeMs);
  const mid = Math.floor(chron.length / 2);
  const h1 = summarize(chron.slice(0, mid).map(x => base(x)));
  const h2 = summarize(chron.slice(mid).map(x => base(x)));
  console.log('  ROBUSTNESS 2 — chronological split (no stop):');
  console.log(`    first half  ${String(h1.n).padStart(4)}   ${usd(h1.pnl).padStart(9)}   win ${pct(h1.winRate)}`);
  console.log(`    second half ${String(h2.n).padStart(4)}   ${usd(h2.pnl).padStart(9)}   win ${pct(h2.winRate)}`);
  console.log(`    => ${h1.pnl > 0 && h2.pnl > 0 ? 'edge present in BOTH halves' : 'edge NOT in both halves — fragile / regime-dependent'}`);

  // (c) entry price cap — the losses are dear favorites flipping. Does refusing
  // the priciest entries help? This is the lever the stop was NOT.
  console.log('  ROBUSTNESS 3 — max entry price cap (no stop):');
  console.log('    cap    trades   net PnL     win%    avgLoss   note');
  for (const cap of [0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60]) {
    const sub = entered.filter(x => x.entry.entryPrice <= cap).map(x => base(x));
    if (!sub.length) continue;
    const s = summarize(sub);
    console.log(`    ${(Math.round(cap * 100) + 'c').padEnd(5)}  ${String(s.n).padStart(5)}   ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ${('-$' + s.avgLoss.toFixed(2)).padStart(7)}`);
  }
  console.log('');

  // (d) take-profit level — the competitor banks winners EARLY (86-97c) rather
  // than holding for our 97c cashout. Does lowering the take-profit help? Sweeps
  // the cashout threshold with NO stop. It can only ever (i) trim the profit on
  // the winners that already reach 97c, or (ii) rescue a settle-loss IF that
  // loser briefly traded up to the lower TP before collapsing. This measures
  // which effect dominates on real paths — the one competitor lever not yet tested.
  console.log('  ROBUSTNESS 4 — take-profit level (no stop):');
  console.log('    tp     trades   net PnL     win%    avgWin   avgLoss   exit mix (cashout/settle-win/settle-loss)');
  for (const tp of [0.97, 0.95, 0.93, 0.90, 0.87, 0.85, 0.80]) {
    const trades = entered.map(x => simulateExit(x.row, x.entry, null, tp));
    const s = summarize(trades);
    const m = s.mix;
    console.log(`    ${(Math.round(tp * 100) + 'c').padEnd(5)}  ${String(s.n).padStart(5)}   ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ${usd(s.avgWin).padStart(7)}  ${('-$' + s.avgLoss.toFixed(2)).padStart(7)}   ${m.cashout || 0}/${m['settle-win'] || 0}/${m['settle-loss'] || 0}`);
  }
  console.log('');

  // (e) confidence calibration — the prerequisite for confidence-scaled sizing.
  // Fixed 30 shares leaves money on the table IF higher engine confidence really
  // means a higher win rate. But scaling size by a MIScalibrated confidence just
  // over-bets losers. So bucket entries by the engine's stated confidence and
  // show the REALIZED win rate + $/trade per bucket. Sizing up is only justified
  // if realized win rate and avg P&L rise monotonically with stated confidence.
  console.log('  ROBUSTNESS 5 — confidence calibration (no stop):');
  console.log('    conf-bucket   trades   realized-win%   avg P&L/trade   net PnL');
  const buckets = [[85, 87], [88, 90], [91, 93], [94, 96], [97, 100]];
  for (const [lo, hi] of buckets) {
    const sub = entered.filter(x => x.entry.confidence >= lo && x.entry.confidence <= hi).map(x => base(x));
    if (!sub.length) { console.log(`    ${(lo + '-' + hi + '%').padEnd(11)}   ${'0'.padStart(5)}`); continue; }
    const s = summarize(sub);
    const perTrade = s.pnl / s.n;
    console.log(`    ${(lo + '-' + hi + '%').padEnd(11)}   ${String(s.n).padStart(5)}   ${pct(s.winRate).padStart(11)}   ${usd(perTrade).padStart(11)}   ${usd(s.pnl).padStart(9)}`);
  }
  console.log('');
}

main();
