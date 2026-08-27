#!/usr/bin/env node
/**
 * Staleness injection — does a lagged spot explain the live shortfall?
 *
 * THE PUZZLE
 *   backtest (leak-free, 343 entries) : 83.1% win, +$2.09/trade, +$717.81
 *   live bot  (135 trades)            : 71.1% win, -$0.63/trade, -$85.25
 * Same code, same gate, same fee model, and the avg win (+$6.81 vs +$7.36) and
 * avg loss (-$21.11 vs -$20.29) MATCH — so fills, fees and exits are modelled
 * right. The entire gap is direction accuracy: 12 percentage points of win rate.
 *
 * THE SUSPECT
 * bot.js takes spot from Coinbase's 1-minute candle feed: `spot = candles[0].close`.
 * Measured live, that newest candle runs 1-5 minutes behind the wall clock
 * (BTC 1m, HYPE 4m, DOGE/BNB 5m), a mean 8.9 bps and up to 29 bps away from the
 * ticker price. A 15-minute crypto binary usually sits only tens of bps from its
 * strike, so the bot is deciding on a gap the market has already repriced — and
 * it pays the ask for that. It is the slow side of the trade.
 *
 * Worse, sigma = vol * sqrt(minutesLeft) uses minutesLeft from Kalshi's clock
 * (fresh) with a spot from minutes ago, so the real horizon is longer than the
 * one priced. Understated sigma inflates |z|, which inflates confidence — which
 * is why live produced conf>=97% on 8.9% of trades where the backtest produces it
 * on 1.2%.
 *
 * THE TEST
 * Re-run the backtest with the spot (and the whole candle window feeding the
 * indicators) deliberately pushed back by LAG minutes, while minutesLeft stays on
 * the true clock — reproducing the live defect exactly. If win rate falls from
 * 83% toward 71% as lag grows, the diagnosis is measured rather than argued.
 */

const fs = require('fs');
const path = require('path');
const bot = require('./bot');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const MIN_CANDLES = 20;
const fee = (p, c) => Math.ceil(0.07 * c * p * (1 - p) * 100) / 100;

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { rows: j.rows || [], byTime };
}
/** Candles closed strictly before ts, newest first. lagMin pushes the window back. */
function windowAt(byTime, ts, depth, lagMin) {
  const out = [];
  let t = Math.floor(ts / 60) * 60 - 60 - lagMin * 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) {
    const c = byTime.get(t);
    if (c) out.push(c);
  }
  return out;
}

function decide(row, byTime, lagMin) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const cd = windowAt(byTime, ts, 60, lagMin);
    if (cd.length < MIN_CANDLES) continue;

    const spot = cd[0].close;                     // stale by lagMin, as live is
    const res = bot.engineEvaluate(spot, row.strike, min, cd);  // minutesLeft = TRUE clock
    if (!res.side || res.confidence < bot.MIN_CONF) continue;

    const rsi = bot.calcRSI(cd, 14), e9 = bot.calcEMA(cd, 9), e20 = bot.calcEMA(cd, 20);
    const bb = bot.calcBollingerBands(cd, 20), vw = bot.calcVWAP(cd, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < 2) continue;

    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < 0.25 || entryPrice > 0.80) continue;
    return { min, side: res.side, entryPrice, confidence: res.confidence };
  }
  return null;
}

function grade(row, e) {
  const sh = bot.SHARES, ef = fee(e.entryPrice, sh);
  for (let min = e.min - 1; min >= 0; min--) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.bid >= 0) || !(q.ask > 0)) continue;
    const sell = e.side === 'YES' ? q.bid : (1 - q.ask);
    if (sell >= bot.CASHOUT) return { pnl: sh * (sell - e.entryPrice) - ef - fee(sell, sh) };
  }
  const won = (e.side === 'YES' && row.settledYes) || (e.side === 'NO' && !row.settledYes);
  return { pnl: (won ? sh * (1 - e.entryPrice) : -sh * e.entryPrice) - ef };
}

const coins = bot.COINS.map(c => c.sym);
const data = {};
for (const s of coins) { try { data[s] = loadCoin(s); } catch (_) {} }

const usd = n => (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2);
console.log('\n  STALENESS INJECTION — spot pushed back N minutes, clock left true\n');
console.log('  lag    trades   net PnL    $/trade   win%    conf>=97%   mean conf');
console.log('  ' + '-'.repeat(72));

const out = [];
for (const lag of [0, 1, 2, 3, 4, 5]) {
  const tr = [];
  for (const s of coins) {
    const d = data[s]; if (!d) continue;
    for (const row of d.rows) {
      const e = decide(row, d.byTime, lag);
      if (e) tr.push({ ...grade(row, e), conf: e.confidence });
    }
  }
  const w = tr.filter(t => t.pnl > 0).length;
  const pnl = tr.reduce((a, t) => a + t.pnl, 0);
  const hi = tr.filter(t => t.conf >= 97).length;
  const mc = tr.reduce((a, t) => a + t.conf, 0) / tr.length;
  out.push({ lag, n: tr.length, pnl, wr: w / tr.length });
  console.log(`  ${(lag + 'm').padEnd(6)} ${String(tr.length).padStart(5)}   ${usd(pnl).padStart(9)}  ` +
    `${usd(pnl / tr.length).padStart(8)}  ${(w / tr.length * 100).toFixed(1).padStart(5)}%   ` +
    `${(hi / tr.length * 100).toFixed(1).padStart(6)}%   ${mc.toFixed(2)}%`);
}
console.log('  ' + '-'.repeat(72));
console.log('  LIVE ACTUAL (135 trades, mixed 1-5m lag by coin):');
console.log('  live      135     -$85.25    -$0.63   71.1%      8.9%   89.00%');
console.log('');
const fresh = out[0], worst = out[out.length - 1];
console.log(`  fresh spot  -> ${(fresh.wr * 100).toFixed(1)}% win, ${usd(fresh.pnl)}`);
console.log(`  ${worst.lag}m stale    -> ${(worst.wr * 100).toFixed(1)}% win, ${usd(worst.pnl)}`);
console.log(`  cost of the lag: ${((fresh.wr - worst.wr) * 100).toFixed(1)}pp of win rate, ` +
  `${usd(worst.pnl - fresh.pnl)} over ~1800 markets`);
console.log('');
