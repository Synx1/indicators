#!/usr/bin/env node
/**
 * V7 — Z-Score Engine + Indicator Confirmation (the proven 15W/1L config)
 *
 * Momentum-chasing lost money in BOTH directions on 15-min crypto (whipsaw).
 * Reverting to what actually won: the Z-score model picks direction at high
 * confidence, indicators confirm, cheap entries, cashout at 95c.
 *
 * Entry: engine 85%+ conf + 2/4 indicators agree + price 25-90c
 * Cashout: 97c | No stop | 30 shares | status=open market query (critical fix)
 * Fees: Kalshi ceil(0.07*C*P*(1-P)) modeled on entry + cashout so PnL is honest.
 * Sweeper: force-settles positions still open long after their market closed.
 */
const axios = require('axios');
const fs = require('fs');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = 'https://api.exchange.coinbase.com/products';
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';

// PID lock — only when run as the live bot, never when required by the replay
// harness (which imports the decision functions below and must not touch the
// live bot's pidfile or send it a SIGTERM).
if (require.main === module) {
  const LOCK_FILE = './bot.pid';
  try {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
    try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGTERM'); } catch(_) {}
  } catch(_) {}
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch(_) {} });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

const COINS = [
  { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' },
  { sym: 'ETH', series: 'KXETH15M', product: 'ETH-USD' },
  { sym: 'SOL', series: 'KXSOL15M', product: 'SOL-USD' },
  { sym: 'XRP', series: 'KXXRP15M', product: 'XRP-USD' },
  { sym: 'HYPE', series: 'KXHYPE15M', product: 'HYPE-USD' },
  { sym: 'DOGE', series: 'KXDOGE15M', product: 'DOGE-USD' },
  { sym: 'BNB', series: 'KXBNB15M', product: 'BNB-USD' }
];

const SHARES = 30, CASHOUT = 0.97, MAX_POS = 3, MIN_CONF = 85;
const STATE_FILE = './state.json';
let state = { bankroll: 100, trades: [], open: [], startedAt: new Date().toISOString() };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function log(m) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
  console.log(`[${t}] ${m}`);
}
async function webhook(msg) {
  if (!WEBHOOK) return;
  try { await axios.post(WEBHOOK, { content: msg }, { timeout: 5000 }); } catch (_) {}
}

// ── FEES + SWEEPER TIMING ──
// Kalshi charges ceil(0.07 * contracts * price * (1-price)) rounded up to the
// cent on every fill — entry and any cashout sell. Holding to settlement is not
// a fill, so it has no exit fee. Modeled so reported PnL/bankroll match what
// Kalshi actually takes instead of running ~$0.34/round-trip optimistic.
function fee(price, shares) {
  return Math.ceil(0.07 * shares * price * (1 - price) * 100) / 100;
}
// A 15-minute market finalizes within ~a minute of close_time. A position still
// open well past that means its settlement fetch is failing; with MAX_POS such
// positions the bot silently stops entering. These windows drive the sweeper.
const SETTLE_GRACE_MS = 3 * 60 * 1000;    // past this, a held market must be graded
const FORCE_GRACE_MS = 45 * 60 * 1000;    // ungradeable this long => unwedge (as loss)

// ── INDICATORS ──
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const diff = candles[i].close - candles[i + 1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function calcEMA(candles, period) {
  // Candles arrive newest-first, so the EMA has to be walked oldest -> newest
  // and must END on the latest bar.
  //
  // The previous version reversed the whole 60-candle array and then capped the
  // loop at period*3 from the *start*, which walked the OLDEST bars and stopped
  // early: ema9 finished ~33 minutes behind the market while ema20 (cap 60, so
  // uncapped) finished at the present. The `ema9 > ema20` crossover was
  // therefore comparing two different points in time, and one of the four
  // indicator confirmations was reading history as if it were now.
  const span = Math.min(candles.length, period * 3);
  const prices = candles.slice(0, span).map(c => c.close).reverse();
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function calcBollingerBands(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;
  const closes = candles.slice(0, period).map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / period;
  return { upper: mean + mult * Math.sqrt(variance), middle: mean, lower: mean - mult * Math.sqrt(variance) };
}
function calcVWAP(candles, periods = 20) {
  let cumVP = 0, cumVol = 0;
  for (let i = 0; i < Math.min(periods, candles.length); i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVP += typical * (candles[i].volume || 1);
    cumVol += (candles[i].volume || 1);
  }
  return cumVol > 0 ? cumVP / cumVol : candles[0].close;
}

// ── Z-SCORE ENGINE ──
function realizedVol(candles, lookback) {
  const returns = [];
  for (let i = 0; i < Math.min(lookback, candles.length - 1); i++) {
    if (candles[i + 1].close > 0) returns.push(Math.log(candles[i].close / candles[i + 1].close));
  }
  if (returns.length < 5) return 0.0006;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}
function engineEvaluate(spot, strike, minutesLeft, candles) {
  if (!spot || !strike || minutesLeft < 3) return { side: null, confidence: 0 };
  const vol = realizedVol(candles, 10);
  const gap = (spot - strike) / strike;
  const sigma = vol * Math.sqrt(minutesLeft);
  if (sigma < 0.0001) return { side: null, confidence: 0 };
  const z = gap / sigma;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const pYes = z >= 0 ? (1 - p) : p;
  const confidence = Math.round(Math.max(pYes, 1 - pYes) * 100);
  const side = pYes >= 0.5 ? 'YES' : 'NO';
  return { side, confidence, z: z.toFixed(3) };
}

// ── MARKET DATA (status=open — the critical fix) ──
async function getCandles(product) {
  const { data } = await axios.get(`${COINBASE}/${product}/candles`, { params: { granularity: 60 }, timeout: 10000 });
  return (data || []).slice(0, 60).map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
}
async function findActive(series) {
  try {
    const { data } = await axios.get(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=10`, { timeout: 15000 });
    const now = Date.now();
    return (data.markets || []).find(m => {
      const ml = (new Date(m.close_time) - now) / 60000;
      return ml > 3 && ml < 14;
    }) || null;
  } catch (_) { return null; }
}

// ── EXITS ──
async function checkCashouts() {
  for (let i = state.open.length - 1; i >= 0; i--) {
    const pos = state.open[i];
    try {
      const { data } = await axios.get(`${KALSHI}/markets/${pos.ticker}`, { timeout: 10000 });
      const m = data.market;
      const sell = pos.side === 'YES' ? parseFloat(m.yes_bid_dollars || 0) : parseFloat(m.no_bid_dollars || 0);
      if (sell >= CASHOUT && m.status === 'active') {
        const eFee = pos.entryFee || 0, xFee = fee(sell, pos.shares);
        const pnl = (sell - pos.price) * pos.shares - eFee - xFee;
        state.bankroll += pos.shares * sell - xFee;
        pos.result = 'CASHOUT'; pos.exitPrice = sell; pos.exitFee = xFee; pos.pnl = pnl; pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`💰 CASHOUT ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c -> ${Math.round(sell*100)}c | +$${pnl.toFixed(2)}`);
        webhook(`💰 **CASHOUT** ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c → ${Math.round(sell*100)}c | +$${pnl.toFixed(2)} | Bank: $${state.bankroll.toFixed(2)}`);
        save(); continue;
      }
      if (m.status === 'finalized' || m.result) {
        const won = (pos.side === 'YES' && m.result === 'yes') || (pos.side === 'NO' && m.result === 'no');
        const eFee = pos.entryFee || 0;
        state.bankroll += won ? pos.shares : 0;
        pos.result = won ? 'WIN' : 'LOSS';
        pos.pnl = (won ? pos.shares * (1 - pos.price) : -(pos.shares * pos.price)) - eFee;
        pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        const emoji = won ? '✅' : '❌';
        log(`${emoji} ${pos.result} ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c | $${pos.pnl.toFixed(2)}`);
        webhook(`${emoji} **${pos.result}** ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c | $${pos.pnl.toFixed(2)} | Bank: $${state.bankroll.toFixed(2)}`);
        save();
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── STUCK-POSITION SWEEPER ──
// checkCashouts swallows every fetch error, so a position whose /markets/{ticker}
// lookup keeps failing (transient network, or Kalshi delisting the ticker after
// settlement) never leaves state.open. With MAX_POS = 3, three such positions
// permanently block scan() from taking any new trade — the bot looks alive but
// is wedged. This runs each cycle: any position still open past SETTLE_GRACE_MS
// after its market closed is graded off the real settlement (direct fetch, then
// the series settled list as a fallback). If it still can't be graded after
// FORCE_GRACE_MS it's closed out as a loss and shouted about, so the bot can
// never silently stop trading.
async function sweepStuck() {
  const now = Date.now();
  for (let i = state.open.length - 1; i >= 0; i--) {
    const pos = state.open[i];
    const closeMs = pos.closeTime ? new Date(pos.closeTime).getTime() : 0;
    if (!closeMs || now < closeMs + SETTLE_GRACE_MS) continue;   // not due to be settled yet

    let result = null;                                           // 'yes' | 'no' once known
    try {
      const { data } = await axios.get(`${KALSHI}/markets/${pos.ticker}`, { timeout: 10000 });
      if (data.market && data.market.result) result = data.market.result;
    } catch (_) {}
    if (!result) {                                               // ticker fetch failed — try the series list
      try {
        const series = pos.ticker.split('-')[0];
        const { data } = await axios.get(`${KALSHI}/markets?series_ticker=${series}&status=settled&limit=200`, { timeout: 15000 });
        const m = (data.markets || []).find(x => x.ticker === pos.ticker);
        if (m && m.result) result = m.result;
      } catch (_) {}
    }

    const eFee = pos.entryFee || 0;
    if (result === 'yes' || result === 'no') {
      const won = (pos.side === 'YES' && result === 'yes') || (pos.side === 'NO' && result === 'no');
      state.bankroll += won ? pos.shares : 0;
      pos.result = won ? 'WIN' : 'LOSS'; pos.recovered = true;
      pos.pnl = (won ? pos.shares * (1 - pos.price) : -(pos.shares * pos.price)) - eFee;
      pos.settledAt = new Date().toISOString();
      state.trades.push(pos); state.open.splice(i, 1); save();
      const emoji = won ? '✅' : '❌';
      log(`${emoji} ${pos.result} (recovered) ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c | $${pos.pnl.toFixed(2)}`);
      webhook(`${emoji} **${pos.result}** (recovered) ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c | $${pos.pnl.toFixed(2)} | Bank: $${state.bankroll.toFixed(2)}`);
    } else if (now > closeMs + FORCE_GRACE_MS) {                 // ungradeable far past close — unwedge
      const mins = Math.round((now - closeMs) / 60000);
      pos.result = 'UNRESOLVED'; pos.forcedClose = true;
      pos.pnl = -(pos.shares * pos.price) - eFee;                // cost already spent; assume the worst
      pos.settledAt = new Date().toISOString();
      state.trades.push(pos); state.open.splice(i, 1); save();
      log(`⚠️ UNRESOLVED force-closed ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c ${mins}m after close | $${pos.pnl.toFixed(2)}`);
      webhook(`⚠️ **UNRESOLVED** force-closed ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c (couldn't grade ${mins}m after close) | Bank: $${state.bankroll.toFixed(2)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── SCAN ──
async function scan() {
  if (state.open.length >= MAX_POS) return;
  for (const coin of COINS) {
    if (state.open.length >= MAX_POS) break;
    if (state.open.find(p => p.sym === coin.sym)) continue;
    try {
      const market = await findActive(coin.series);
      if (!market) continue;
      const candles = await getCandles(coin.product);
      if (candles.length < 15) continue;

      const spot = candles[0].close;
      const minLeft = (new Date(market.close_time) - Date.now()) / 60000;
      const yesAsk = parseFloat(market.yes_ask_dollars || 0);
      const noAsk = parseFloat(market.no_ask_dollars || 0);
      const strike = parseFloat(market.floor_strike || 0);

      // ENGINE picks direction at high confidence
      const result = engineEvaluate(spot, strike, minLeft, candles);
      if (result.confidence < MIN_CONF || !result.side) continue;

      // 2/4 INDICATOR CONFIRMATION
      const rsi = calcRSI(candles, 14);
      const ema9 = calcEMA(candles, 9);
      const ema20 = calcEMA(candles, 20);
      const bb = calcBollingerBands(candles, 20);
      const vwap = calcVWAP(candles, 20);
      let confirm = 0;
      if (result.side === 'YES') {
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

      const side = result.side;
      const price = side === 'YES' ? yesAsk : noAsk;
      if (price < 0.25 || price > 0.90) continue;

      const cost = SHARES * price;
      if (cost > state.bankroll * 0.5) continue;
      const entryFee = fee(price, SHARES);

      // Entry type label
      const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
      const entryType = (side === 'YES')
        ? (spot < avgClose ? '📉 bought the dip' : '🚀 chased a move')
        : (spot > avgClose ? '📉 bought the dip' : '🚀 chased a move');

      state.bankroll -= (cost + entryFee);
      const direction = side === 'YES' ? 'UP' : 'DOWN';
      const pos = { ticker: market.ticker, sym: coin.sym, side, direction, price, shares: SHARES, cost, entryFee,
        closeTime: market.close_time, strike,
        confidence: result.confidence, z: result.z, rsi: Math.round(rsi), confirm, entryType, enteredAt: new Date().toISOString() };
      state.open.push(pos);
      save();
      log(`🎯 ${coin.sym} ${direction} @${Math.round(price*100)}c | ENGINE ${result.confidence}% z=${result.z} ${confirm}/4 | fee $${entryFee.toFixed(2)} | ${entryType}`);
      webhook(`🎯 **ENTRY** ${coin.sym} ${direction} @${Math.round(price*100)}c | ENGINE ${result.confidence}% (${confirm}/4 ind) | ${entryType} | Bank: $${state.bankroll.toFixed(2)}`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

async function main() {
  log('=== V7 ENGINE + INDICATORS (proven 15W/1L config) ===');
  log(`Engine ${MIN_CONF}%+ | 2/4 indicators | Entry 25-90c | Cashout ${Math.round(CASHOUT*100)}c | ${SHARES}sh`);
  log(`Bankroll: $${state.bankroll.toFixed(2)} | Trades: ${state.trades.length} | Open: ${state.open.length}`);
  log('');
  webhook(`🚀 **V7 ENGINE BOT STARTED** — back to the proven winner\nEngine ${MIN_CONF}%+ conf + 2/4 indicators | 25-90c | cashout 97c\nBankroll: $${state.bankroll.toFixed(2)}`);
  while (true) {
    try { await checkCashouts(); await sweepStuck(); await scan(); } catch (e) { log('Err: ' + e.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
}
// Only run the trading loop when invoked directly. When required (by replay.js)
// this file is just a library of the exact decision functions the live bot uses,
// so the backtest cannot drift from production.
if (require.main === module) {
  main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
}

module.exports = {
  engineEvaluate, realizedVol,
  calcRSI, calcEMA, calcBollingerBands, calcVWAP,
  COINS, SHARES, CASHOUT, MAX_POS, MIN_CONF
};
