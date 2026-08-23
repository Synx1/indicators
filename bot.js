#!/usr/bin/env node
/**
 * V3 — Regime-Adaptive Paper Trader
 * Proven combos from 260-round backtest:
 *   High vol: candles + gap (73-100%)
 *   Low vol: Bollinger + gap (76.7%)
 *   Dead vol: Bollinger + VWAP + candles (85.7%)
 */
const axios = require('axios');
const fs = require('fs');
const dt = require('./daytrader');

const WEBHOOK = "https://discord.com/api/webhooks/1539540679577964564/l7bTZM3zYVPvA86leywxdvi177hNhVFKMdEZn6nqr9mEaFIGy7OISHH_jf7u8HSMDUsI";
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE = 'https://api.exchange.coinbase.com/products';

const COINS = [
  { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' },
  { sym: 'ETH', series: 'KXETH15M', product: 'ETH-USD' },
  { sym: 'SOL', series: 'KXSOL15M', product: 'SOL-USD' },
  { sym: 'XRP', series: 'KXXRP15M', product: 'XRP-USD' },
  { sym: 'HYPE', series: 'KXHYPE15M', product: 'HYPE-USD' },
  { sym: 'DOGE', series: 'KXDOGE15M', product: 'DOGE-USD' },
  { sym: 'BNB', series: 'KXBNB15M', product: 'BNB-USD' }
];

const SHARES = 100;
const CASHOUT = 0.95;
const STOP = 0.20;
const MAX_POS = 3;
const MAX_ENTRY = 0.80;
const MIN_ENTRY = 0.30;
const MIN_VOL = 2; // BTC/min minimum

const STATE_FILE = './state.json';
let state = { bankroll: 100, trades: [], open: [], startedAt: new Date().toISOString() };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function log(m) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const l = `[${t}] ${m}`;
  console.log(l);
  try { fs.appendFileSync('./bot.log', l + '\n'); } catch (_) {}
}

async function getCandles(product) {
  const { data } = await axios.get(`${COINBASE}/${product}/candles`, { params: { granularity: 60 }, timeout: 10000 });
  return (data || []).slice(0, 60).map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
}

async function findActive(series) {
  try {
    const { data } = await axios.get(`${KALSHI}/markets?series_ticker=${series}&limit=100`, { timeout: 15000 });
    const now = Date.now();
    return (data.markets || []).find(m =>
      m.status === 'active' &&
      (new Date(m.close_time) - now) / 60000 > 3 &&
      (new Date(m.close_time) - now) / 60000 < 15
    ) || null;
  } catch (_) { return null; }
}

async function checkCashouts() {
  for (let i = state.open.length - 1; i >= 0; i--) {
    const pos = state.open[i];
    try {
      const { data } = await axios.get(`${KALSHI}/markets/${pos.ticker}`, { timeout: 10000 });
      const m = data.market;
      const sell = pos.side === 'YES'
        ? parseFloat(m.yes_bid_dollars || 0)
        : parseFloat(m.no_bid_dollars || 0);

      // Stop loss
      if (sell <= STOP && m.status === 'active' && sell > 0.01) {
        const pnl = (sell - pos.price) * pos.shares;
        state.bankroll += pos.shares * sell;
        pos.result = 'STOPPED'; pos.exitPrice = sell; pos.pnl = pnl;
        pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`  🛑 STOP ${pos.sym} ${pos.direction} @${(pos.price*100).toFixed(0)}c -> ${(sell*100).toFixed(0)}c | $${pnl.toFixed(2)} | bankroll: $${state.bankroll.toFixed(2)}`);
        save(); continue;
      }

      // Cashout
      if (sell >= CASHOUT && m.status === 'active') {
        const pnl = (sell - pos.price) * pos.shares;
        state.bankroll += pos.shares * sell;
        pos.result = 'CASHOUT'; pos.exitPrice = sell; pos.pnl = pnl;
        pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`  💰 CASHOUT ${pos.sym} ${pos.direction} @${(pos.price*100).toFixed(0)}c -> ${(sell*100).toFixed(0)}c | +$${pnl.toFixed(2)} | bankroll: $${state.bankroll.toFixed(2)}`);
        save(); continue;
      }

      // Settlement
      if (m.status === 'finalized' || m.result) {
        const won = (pos.side === 'YES' && m.result === 'yes') || (pos.side === 'NO' && m.result === 'no');
        const payout = won ? pos.shares : 0;
        state.bankroll += payout;
        pos.result = won ? 'WIN' : 'LOSS';
        pos.pnl = won ? pos.shares * (1 - pos.price) : -pos.cost;
        pos.settledAt = new Date().toISOString();
        state.trades.push(pos); state.open.splice(i, 1);
        log(`  ${won ? '✅ WIN' : '❌ LOSS'} ${pos.sym} ${pos.direction} @${(pos.price*100).toFixed(0)}c | ${won?'+':''}$${pos.pnl.toFixed(2)} | bankroll: $${state.bankroll.toFixed(2)}`);
        save();
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
}

async function scan() {
  // Volume check on BTC
  try {
    const { data } = await axios.get(`${COINBASE}/BTC-USD/candles`, { params: { granularity: 60 }, timeout: 10000 });
    const avg = data.slice(0, 15).reduce((a, c) => a + c[5], 0) / 15;
    if (avg < MIN_VOL) return;
  } catch (_) { return; }

  if (state.open.length >= MAX_POS) return;

  for (const coin of COINS) {
    if (state.open.length >= MAX_POS) break;
    if (state.open.find(p => p.sym === coin.sym)) continue;

    try {
      const market = await findActive(coin.series);
      if (!market) continue;

      const candles = await getCandles(coin.product);
      if (candles.length < 30) continue;

      const spot = candles[0].close;
      const strike = parseFloat(market.floor_strike);
      const gapBps = (spot / strike - 1) * 10000;
      const avgVol = candles.slice(0, 15).reduce((a, c) => a + (c.volume || 0), 0) / 15;

      // Indicators
      const bb = dt.calcBollingerBands(candles, 20);
      const vwap = dt.calcVWAP(candles, 20);
      const bbAbove = bb ? spot > bb.middle : false;
      const aboveVwap = spot > vwap;
      const greens = candles.slice(0, 5).filter(c => c.close > c.open).length;
      const bullCandles = greens >= 4;
      const bearCandles = greens <= 1;

      // REGIME-ADAPTIVE DIRECTION
      let direction = null;

      if (avgVol >= 8) {
        // HIGH VOL: candles + gap (73-100% backtested)
        if (bullCandles && gapBps > 10) direction = 'UP';
        else if (bearCandles && gapBps < -10) direction = 'DOWN';
        
        
      } else if (avgVol >= 3) {
        // LOW VOL: Bollinger + gap (76.7% on 30T)
        if (bbAbove && gapBps > 10) direction = 'UP';
        else if (!bbAbove && gapBps < -10) direction = 'DOWN';
      } else {
        // DEAD VOL: BB + VWAP + candles (85.7% on 7T)
        if (bbAbove && aboveVwap && bullCandles) direction = 'UP';
        else if (!bbAbove && !aboveVwap && bearCandles) direction = 'DOWN';
      }

      if (!direction) continue;

      // Find cheap entry on the confirmed side
      const yesAsk = parseFloat(market.yes_ask_dollars || 0);
      const noAsk = parseFloat(market.no_ask_dollars || 0);
      let side = null, price = null;
      if (direction === 'UP' && yesAsk >= MIN_ENTRY && yesAsk <= MAX_ENTRY) { side = 'YES'; price = yesAsk; }
      else if (direction === 'DOWN' && noAsk >= MIN_ENTRY && noAsk <= MAX_ENTRY) { side = 'NO'; price = noAsk; }
      if (!side) continue;

      // Position size check
      const cost = SHARES * price;
      if (cost > state.bankroll * 0.6) continue;

      // ENTER
      state.bankroll -= cost;
      const pos = {
        ticker: market.ticker, sym: coin.sym, side, direction, price, shares: SHARES, cost,
        indicators: { gapBps: +gapBps.toFixed(1), avgVol: +avgVol.toFixed(1), bbAbove, aboveVwap, greens },
        enteredAt: new Date().toISOString()
      };
      state.open.push(pos);
      save();
      log(`🎯 ${coin.sym} ${direction} @${(price*100).toFixed(0)}c | gap:${gapBps.toFixed(0)}bps vol:${avgVol.toFixed(1)} | ${SHARES}sh=$${cost.toFixed(2)} | target 95c (+$${((CASHOUT-price)*SHARES).toFixed(2)})`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

async function main() {
  log('=== V3 CLEAN — Regime-Adaptive (gap + BB + candles) ===');
  log(`Bankroll: $${state.bankroll.toFixed(2)} | ${SHARES}sh | Cashout: ${CASHOUT*100}c | Stop: ${STOP*100}c`);
  log(`High vol: candles+gap | Low vol: BB+gap | Dead: BB+VWAP+candles`);
  log(`Trades: ${state.trades.length} | Open: ${state.open.length}`);
  log('');

  while (true) {
    try {
      await checkCashouts();
      await scan();
    } catch (e) {
      log('Err: ' + e.message);
    }
    await new Promise(r => setTimeout(r, 15000));
  }
}

main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
require('./server');
