#!/usr/bin/env node
/**
 * V6 — Momentum Continuation (DirectionalBot method)
 * 
 * NOT predicting. REACTING to moves already happening.
 * 
 * Method:
 * 1. Wait for round to develop (price moves away from 50c)
 * 2. Bet on continuation of the move
 * 3. Scale in: small probe -> bigger if it works
 * 4. Asymmetric risk: tiny losses, big wins
 * 5. Multiple entries per round allowed
 * 6. Cash out winners at 90c+ or ride to settlement
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

const MAX_RISK_PER_TRADE = 0.15; // max 15% of bankroll per entry
const CASHOUT_TARGET = 0.90; // cash out at 90c (take profit fast)
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

// ═══════════════════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════════════════

async function getCandles(product) {
  const { data } = await axios.get(`${COINBASE}/${product}/candles`, { params: { granularity: 60 }, timeout: 10000 });
  return (data || []).slice(0, 15).map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
}

async function getActiveMarkets(series) {
  try {
    const { data } = await axios.get(`${KALSHI}/markets?series_ticker=${series}&limit=10`, { timeout: 15000 });
    const now = Date.now();
    // Get markets with 3-12 minutes left (let the round develop, don't enter too late)
    return (data.markets || []).filter(m => {
      if (m.status !== 'active') return false;
      const minLeft = (new Date(m.close_time) - now) / 60000;
      return minLeft > 2 && minLeft < 14;
    });
  } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════════════
// MOMENTUM DETECTION
// ═══════════════════════════════════════════════════════════

function detectMomentum(candles, market) {
  if (!candles || candles.length < 5) return null;
  
  const spot = candles[0].close;
  const strike = parseFloat(market.floor_strike || 0);
  if (!strike) return null;
  
  const yesAsk = parseFloat(market.yes_ask_dollars || 0);
  const noAsk = parseFloat(market.no_ask_dollars || 0);
  
  // How far has price moved from strike?
  const gapPct = (spot - strike) / strike * 100;
  
  // Price momentum over last 5 candles
  const momentum = (candles[0].close - candles[4].close) / candles[4].close * 100;
  
  // Volume acceleration
  const recentVol = candles.slice(0, 3).reduce((a, c) => a + (c.volume || 0), 0) / 3;
  const olderVol = candles.slice(3, 6).reduce((a, c) => a + (c.volume || 0), 0) / 3;
  const volSpike = olderVol > 0 ? recentVol / olderVol : 1;
  
  // SIGNAL: Price is moving away from strike with momentum
  let signal = null;
  let confidence = 0; // 0-100, determines sizing
  
  // UP signal: price above strike AND still climbing
  if (gapPct > 0.01 && momentum > 0.005) {
    signal = 'UP';
    confidence = Math.min(100, Math.round(gapPct * 20 + momentum * 50));
    // Bonus for volume confirmation
    if (volSpike > 1.5) confidence = Math.min(100, confidence + 20);
  }
  // DOWN signal: price below strike AND still falling  
  else if (gapPct < -0.01 && momentum < -0.005) {
    signal = 'DOWN';
    confidence = Math.min(100, Math.round(Math.abs(gapPct) * 20 + Math.abs(momentum) * 50));
    if (volSpike > 1.5) confidence = Math.min(100, confidence + 20);
  }
  
  if (!signal) return null;
  
  // Entry price — we want cheap entries (the move is already showing)
  const price = signal === 'UP' ? yesAsk : noAsk;
  
  // Only enter at cheap prices (15-70c) — the whole edge is asymmetric risk
  if (price < 0.15 || price > 0.70) return null;
  
  return { signal, confidence, price, side: signal === 'UP' ? 'YES' : 'NO', gapPct, momentum, volSpike };
}

// ═══════════════════════════════════════════════════════════
// POSITION SIZING (competitor method: scale with conviction)
// ═══════════════════════════════════════════════════════════

function getShares(confidence, price, bankroll) {
  // Low confidence (30-50): 10 shares (probe)
  // Medium (50-70): 30 shares
  // High (70-90): 60 shares  
  // Very high (90+): 100 shares
  let shares;
  if (confidence >= 90) shares = 100;
  else if (confidence >= 70) shares = 60;
  else if (confidence >= 50) shares = 30;
  else shares = 10;
  
  // But never risk more than 15% of bankroll
  const maxCost = bankroll * MAX_RISK_PER_TRADE;
  const maxShares = Math.floor(maxCost / price);
  shares = Math.min(shares, maxShares);
  
  // Minimum 5 shares
  return Math.max(5, shares);
}

// ═══════════════════════════════════════════════════════════
// TRADING LOGIC
// ═══════════════════════════════════════════════════════════

async function checkExits() {
  for (let i = state.open.length - 1; i >= 0; i--) {
    const pos = state.open[i];
    try {
      const { data } = await axios.get(`${KALSHI}/markets/${pos.ticker}`, { timeout: 10000 });
      const m = data.market;
      const sell = pos.side === 'YES' ? parseFloat(m.yes_bid_dollars || 0) : parseFloat(m.no_bid_dollars || 0);

      // Cash out at 90c+ (take profit fast like competitor)
      if (sell >= CASHOUT_TARGET && m.status === 'active') {
        const pnl = (sell - pos.price) * pos.shares;
        state.bankroll += pos.shares * sell;
        pos.result = 'CASHOUT'; pos.exitPrice = sell; pos.pnl = pnl; pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`💰 CASHOUT ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c -> ${Math.round(sell*100)}c | +$${pnl.toFixed(2)}`);
        webhook(`💰 **CASHOUT** ${pos.sym} ${pos.direction} @${Math.round(pos.price*100)}c → ${Math.round(sell*100)}c | +$${pnl.toFixed(2)} | Bank: $${state.bankroll.toFixed(2)}`);
        save(); continue;
      }
      
      // Settlement
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

async function scan() {
  // Allow up to 5 open positions (multiple per coin allowed)
  if (state.open.length >= 5) return;

  for (const coin of COINS) {
    if (state.open.length >= 5) break;
    
    // Allow max 2 positions per coin (ladder in)
    const coinPositions = state.open.filter(p => p.sym === coin.sym);
    if (coinPositions.length >= 2) continue;

    try {
      const markets = await getActiveMarkets(coin.series);
      if (!markets.length) continue;
      
      const market = markets[0];
      const candles = await getCandles(coin.product);
      if (!candles || candles.length < 5) continue;

      const signal = detectMomentum(candles, market);
      if (!signal) continue;
      
      // Only enter if confidence is at least 40
      if (signal.confidence < 40) continue;
      
      // If we already have a position in this direction on this coin, 
      // only add if confidence is HIGH (scaling in)
      if (coinPositions.length > 0) {
        const sameDir = coinPositions.find(p => p.direction === (signal.signal === 'UP' ? 'UP' : 'DOWN'));
        if (sameDir && signal.confidence < 70) continue; // need high confidence to add
      }

      const shares = getShares(signal.confidence, signal.price, state.bankroll);
      const cost = shares * signal.price;
      
      if (cost > state.bankroll * 0.3) continue; // never more than 30% in one trade
      if (cost < 1) continue;

      // ENTER
      state.bankroll -= cost;
      const direction = signal.signal;
      const entryType = signal.momentum > 0.03 || signal.momentum < -0.03 ? '🚀 chased a move' : '📉 bought the dip';
      const pos = {
        ticker: market.ticker, sym: coin.sym, side: signal.side,
        direction, price: signal.price, shares, cost,
        confidence: signal.confidence, entryType,
        gapPct: signal.gapPct.toFixed(3), momentum: signal.momentum.toFixed(4),
        enteredAt: new Date().toISOString()
      };
      state.open.push(pos);
      save();
      log(`🎯 ${coin.sym} ${direction} @${Math.round(signal.price*100)}c | ${entryType} | ${shares}sh conf:${signal.confidence} gap:${signal.gapPct.toFixed(2)}%`);
      webhook(`🎯 **ENTRY** ${coin.sym} ${direction} @${Math.round(signal.price*100)}c | ${entryType} | ${shares}sh (conf:${signal.confidence}) | Bank: $${state.bankroll.toFixed(2)}`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  log('=== V6 MOMENTUM CONTINUATION BOT ===');
  log('Method: React to moves, scale in, asymmetric risk');
  log(`Bankroll: $${state.bankroll.toFixed(2)} | Entry: 15-70c | Cashout: 90c+ | Max 5 open`);
  log(`Trades: ${state.trades.length} | Open: ${state.open.length}`);
  log('');
  
  webhook(`🚀 **V6 MOMENTUM BOT STARTED**\nMethod: React to moves already happening, scale in winners\nEntry: 15-70c | Cashout: 90c+ | Variable sizing 5-100sh\nBankroll: $${state.bankroll.toFixed(2)}`);

  while (true) {
    try { await checkExits(); await scan(); } catch (e) { log('Err: ' + e.message); }
    await new Promise(r => setTimeout(r, 100)); // scan every 10s (faster than before)
  }
}

main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
