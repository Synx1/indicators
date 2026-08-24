#!/usr/bin/env node
/**
 * V5 — Time-Aware Drift/Fade + Engine + Indicators
 * Self-contained for Railway deployment (no external src/ dependencies)
 * 
 * Strategy (backed by 3,959-round 31-day analysis):
 * - DRIFT hours (3,5,11,17 ET): bet WITH 3+ round streak (56-60% continuation)
 * - FADE hours (6,7,12-16,19,20 ET): bet AGAINST 3+ streak (breaks 56-63%)
 * - ENGINE: Z-score model 70%+ confidence + 2/4 indicators agree
 * - FADE MODE: RSI extremes (<25 or >75) contrarian
 * - Drift overrides engine when they disagree
 * 
 * Entry: 15-90c | Cashout: 95c | No stop | 30 shares
 */
const axios = require('axios');
const fs = require('fs');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = 'https://api.exchange.coinbase.com/products';
const WEBHOOK = process.env.DISCORD_WEBHOOK || '';
// PID lock to prevent duplicate processes
const LOCK_FILE = './bot.pid';
const myPid = process.pid;
try {
  const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
  try { process.kill(oldPid, 0); console.log('Another instance running (pid '+oldPid+'), killing it'); process.kill(oldPid, 'SIGTERM'); } catch(_) {}
} catch(_) {}
fs.writeFileSync(LOCK_FILE, String(myPid));
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

const SHARES = 30, CASHOUT = 0.95, MAX_POS = 3;
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
  try {
    await axios.post(WEBHOOK, { content: msg }, { timeout: 5000 });
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
// INDICATORS (self-contained)
// ═══════════════════════════════════════════════════════════

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
  for (let i = 1; i < Math.min(prices.length, period * 3); i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
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

// ═══════════════════════════════════════════════════════════
// Z-SCORE ENGINE (simplified from BETSSSSS)
// ═══════════════════════════════════════════════════════════

function realizedVol(candles, lookback) {
  const returns = [];
  for (let i = 0; i < Math.min(lookback, candles.length - 1); i++) {
    if (candles[i + 1].close > 0) {
      returns.push(Math.log(candles[i].close / candles[i + 1].close));
    }
  }
  if (returns.length < 5) return 0.0006; // fallback
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
  
  // Standard normal CDF approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const pYes = z >= 0 ? (1 - p) : p;
  
  const confidence = Math.round(Math.max(pYes, 1 - pYes) * 100);
  const side = pYes >= 0.5 ? 'YES' : 'NO';
  
  return { side, confidence, pYes: Math.round(pYes * 100), z: z.toFixed(3) };
}

// ═══════════════════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════════════════

async function getCandles(product) {
  const { data } = await axios.get(`${COINBASE}/${product}/candles`, { params: { granularity: 60 }, timeout: 10000 });
  return (data || []).slice(0, 60).map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
}

async function findActive(series) {
  try {
    const { data } = await axios.get(`${KALSHI}/markets?series_ticker=${series}&limit=100`, { timeout: 15000 });
    const now = Date.now();
    return (data.markets || []).find(m => m.status === 'active' && (new Date(m.close_time) - now) / 60000 > 3 && (new Date(m.close_time) - now) / 60000 < 14) || null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════
// DRIFT/FADE with TIME FILTER
// ═══════════════════════════════════════════════════════════

async function getDrift(series) {
  try {
    const etHour = (new Date().getUTCHours() - 4 + 24) % 24;
    const driftHours = [3, 5, 11, 17];
    const fadeHours = [6, 7, 12, 13, 14, 15, 16, 19, 20];
    
    const { data } = await axios.get(KALSHI + '/markets?series_ticker=' + series + '&limit=20', { timeout: 15000 });
    const settled = (data.markets || []).filter(m => m.status === 'finalized' && m.result).slice(0, 5);
    if (settled.length < 3) return null;
    
    const dir = settled[0].result;
    let streak = 0;
    for (const m of settled) { if (m.result === dir) streak++; else break; }
    if (streak < 3) return null;
    
    const streakDir = dir === 'yes' ? 'UP' : 'DOWN';
    
    if (driftHours.includes(etHour)) return streakDir;
    // FADE DISABLED — was losing in trending markets
    return null;
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════
// TRADING LOGIC
// ═══════════════════════════════════════════════════════════

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
        pos.result = won ? 'WIN' : 'LOSS'; pos.pnl = won ? pos.shares * (1 - pos.price) : -pos.cost;
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

      let side = null, price = null, mode = '';

      // MODE 1: ENGINE + INDICATORS
      const result = engineEvaluate(spot, strike, minLeft, candles);
      if (result.confidence >= 85 && result.side) {
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
        if (confirm >= 2) {
          side = result.side;
          price = side === 'YES' ? yesAsk : noAsk;
          mode = `ENGINE ${result.confidence}% z=${result.z}`;
        }
      }

      // MODE 2: DRIFT (time-aware)
      if (!side) {
        const drift = await getDrift(coin.series);
        if (drift) {
          side = drift === 'UP' ? 'YES' : 'NO';
          price = side === 'YES' ? yesAsk : noAsk;
          mode = 'DRIFT';
        }
      }

      // MODE 3: FADE — DISABLED (loses in trending markets)

      // DRIFT OVERRIDE: DISABLED — engine is more reliable than drift

      if (!side || !price) continue;
      if (price < 0.45 || price > 0.90) continue;

      const cost = SHARES * price;
      if (cost > state.bankroll * 0.5) continue;


      // Classify entry type (like competitor)
      const recentCandles = candles.slice(0, 5);
      const avgClose = recentCandles.reduce((a,c) => a + c.close, 0) / recentCandles.length;
      let entryType = '';
      if (side === 'YES') {
        // Buying UP — is price below recent avg? (dip) or above? (chasing momentum)
        entryType = spot < avgClose ? '📉 bought the dip' : '🚀 chased a move';
      } else {
        // Buying DOWN — is price above recent avg? (dip from high) or below? (chasing dump)
        entryType = spot > avgClose ? '📉 bought the dip' : '🚀 chased a move';
      }
      // ENTER
      state.bankroll -= cost;
      const direction = side === 'YES' ? 'UP' : 'DOWN';
      const pos = { ticker: market.ticker, sym: coin.sym, side, direction, price, shares: SHARES, cost, mode, entryType, enteredAt: new Date().toISOString() };
      state.open.push(pos);
      save();
      log(`🎯 ${mode} ${coin.sym} ${direction} @${Math.round(price*100)}c | ${entryType} | ${SHARES}sh=${cost.toFixed(2)}`);
      webhook(`🎯 **ENTRY** [${mode}] ${coin.sym} ${direction} @${Math.round(price*100)}c | ${entryType} | ${SHARES}sh = ${cost.toFixed(2)} | Bank: ${state.bankroll.toFixed(2)}`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════

async function main() {
  log('=== V5 INDICATORS BOT — Railway Deploy ===');
  log(`Strategy: Engine+Indicators | Drift(3,5,11,17 ET) | Fade(6,7,12-16,19,20 ET)`);
  log(`Bankroll: $${state.bankroll.toFixed(2)} | Shares: ${SHARES} | Cashout: ${Math.round(CASHOUT*100)}c | Max pos: ${MAX_POS}`);
  log(`Trades: ${state.trades.length} | Open: ${state.open.length}`);
  log('');
  
  webhook(`🚀 **V5 INDICATORS BOT STARTED**\nStrategy: Engine+Indicators | Time-Drift | Fade\nBankroll: $${state.bankroll.toFixed(2)} | ${state.trades.length} historical trades`);

  while (true) {
    try { await checkCashouts(); await scan(); } catch (e) { log('Err: ' + e.message); }
    await new Promise(r => setTimeout(r, 15000));
  }
}

main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
