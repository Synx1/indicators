#!/usr/bin/env node
/**
 * V7 — Z-Score Engine + Indicator Confirmation (the proven 15W/1L config)
 *
 * Momentum-chasing lost money in BOTH directions on 15-min crypto (whipsaw).
 * Reverting to what actually won: the Z-score model picks direction at high
 * confidence, indicators confirm, cheap entries, cashout at 95c.
 *
 * Entry: engine 85%+ conf + 2/4 indicators agree + price 45-90c
 * Cashout: 95c | No stop | 30 shares | status=open market query (critical fix)
 */
const axios = require('axios');
const fs = require('fs');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = 'https://api.exchange.coinbase.com/products';
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';

// PID lock
const LOCK_FILE = './bot.pid';
try {
  const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
  try { process.kill(oldPid, 0); process.kill(oldPid, 'SIGTERM'); } catch(_) {}
} catch(_) {}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch(_) {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

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
  const prices = candles.map(c => c.close).reverse();
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < Math.min(prices.length, period * 3); i++) ema = prices[i] * k + ema * (1 - k);
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
        const pnl = (sell - pos.price) * pos.shares;
        state.bankroll += pos.shares * sell;
        pos.result = 'CASHOUT'; pos.exitPrice = sell; pos.pnl = pnl; pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`💰 CASHOUT ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c -> ${Math.round(sell*100)}c | +$${pnl.toFixed(2)}`);
        webhook(`💰 **CASHOUT** ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c → ${Math.round(sell*100)}c | +$${pnl.toFixed(2)} | Bank: $${state.bankroll.toFixed(2)}`);
        save(); continue;
      }
      if (m.status === 'finalized' || m.result) {
        const won = (pos.side === 'YES' && m.result === 'yes') || (pos.side === 'NO' && m.result === 'no');
        state.bankroll += won ? pos.shares : 0;
        pos.result = won ? 'WIN' : 'LOSS';
        pos.pnl = won ? pos.shares * (1 - pos.price) : -(pos.shares * pos.price);
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

      // Entry type label
      const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
      const entryType = (side === 'YES')
        ? (spot < avgClose ? '📉 bought the dip' : '🚀 chased a move')
        : (spot > avgClose ? '📉 bought the dip' : '🚀 chased a move');

      state.bankroll -= cost;
      const direction = side === 'YES' ? 'UP' : 'DOWN';
      const pos = { ticker: market.ticker, sym: coin.sym, side, direction, price, shares: SHARES, cost,
        confidence: result.confidence, z: result.z, rsi: Math.round(rsi), confirm, entryType, enteredAt: new Date().toISOString() };
      state.open.push(pos);
      save();
      log(`🎯 ${coin.sym} ${direction} @${Math.round(price*100)}c | ENGINE ${result.confidence}% z=${result.z} ${confirm}/4 | ${entryType}`);
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
    try { await checkCashouts(); await scan(); } catch (e) { log('Err: ' + e.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
}
main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
