#!/usr/bin/env node
/**
 * V8 — Z-Score Engine + Indicator Confirmation, on a FRESH spot price.
 *
 * ── why V8 exists: the stale-spot bug ──
 * V7 ran $100 -> $301 -> $14.75 over 135 trades while its own backtest said the
 * same gate was worth +$2.09/trade over 1806 settled markets. The gap was not
 * luck. V7 read spot from `candles[0].close` — Coinbase's 1-minute candle feed —
 * and that feed runs 1 to 5 MINUTES behind the wall clock (measured: BTC 1m,
 * ETH 2m, SOL/XRP 3m, HYPE 4m, DOGE/BNB 5m; mean 8.9 bps and up to 29 bps away
 * from the ticker price). A 15-minute crypto binary usually sits only tens of bps
 * from its strike, so V7 decided on a gap the Kalshi book had already repriced,
 * and paid the ask for the privilege. It was the slow side of every trade.
 *
 * It compounded: sigma = vol * sqrt(minutesLeft) took minutesLeft from Kalshi's
 * clock (fresh) while spot came from minutes earlier, so the true horizon was
 * longer than the one priced. Understated sigma inflates |z|, which inflates
 * confidence — V7 reported 85%+ on phantom edges and produced conf>=97% on 8.9%
 * of trades where a fresh-spot backtest produces it on 1.2%. Those top-confidence
 * trades were its worst bucket: 42% win rate, -$112.58.
 *
 * Injecting the same lag into the backtest reproduces the live result on two
 * independent signatures (see stalecheck.js):
 *      lag 0m -> 83.1% win, +$2.09/trade, conf>=97% on 1.2%
 *      lag 2m -> 70.2% win, -$0.07/trade, conf>=97% on 7.3%
 *      lag 3m -> 67.2% win, +$0.06/trade, conf>=97% on 8.7%
 *      LIVE   -> 71.1% win, -$0.63/trade, conf>=97% on 8.9%
 * Live lands between 2 and 3 minutes of lag, exactly the measured feed age.
 *
 * ── the fix ──
 * spot now comes from Coinbase's /ticker (median age 1.8s, 32ms round trip, 0/21
 * failures) instead of the candle feed. Candles still supply the trend indicators
 * and the vol estimate, where a couple of minutes is second-order. If the ticker
 * fails we SKIP the coin rather than fall back to the stale candle — falling back
 * is the bug. A hard candle-age ceiling rejects windows too old to compute vol on.
 *
 * Entry: engine 85%+ conf + 3/4 indicators agree + price 25-80c   (was 2/4:
 *   3/4 scores +$800.92 vs +$717.81 over the same 1806 markets, +$2.45/trade,
 *   84.7% win, breakeven margin 8.6pp vs 7.5pp, positive in both halves)
 * Cashout: 97c | No stop | 30 shares | status=open market query
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
// Indicator confirmations required out of 4. Raised from 2 in V8: over the same
// 1806 settled markets, >=3/4 nets +$800.92 (+$2.45/trade, 84.7% win, 8.6pp of
// breakeven margin) against >=2/4's +$717.81 (+$2.09, 83.1%, 7.5pp), and stays
// positive in both chronological halves. 4/4 gives no further margin and drops
// 19% of the entries, so 3 is the knee.
const MIN_CONFIRM = 3;
// A spot price older than this is not worth trading on — see the V8 note above.
// The ticker normally reports a last trade 1-3s old; 45s means the venue has gone
// quiet or the feed is degraded, and the whole edge here is being timely.
const MAX_SPOT_AGE_MS = 45 * 1000;
// The candle window only supplies trend indicators and the vol estimate, both of
// which tolerate some lag — but past ~12 minutes a 15-minute market's realized
// vol is being measured on a different regime than the one being traded.
const MAX_CANDLE_AGE_MS = 12 * 60 * 1000;

// State lives on the Railway volume (mounted at /data) so the bankroll + trade
// history survive redeploys. The container filesystem is wiped on every deploy,
// which is exactly what kept resetting the paper bankroll to $100. Railway sets
// RAILWAY_VOLUME_MOUNT_PATH automatically when a volume is attached; STATE_DIR
// overrides it; and we fall back to the cwd locally (no volume — replay/smoke
// tests). If the volume isn't attached yet the bot still runs, just not
// persistently, so this is safe to ship before the volume exists.
const DATA_DIR = process.env.STATE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : '.');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const STATE_FILE = `${DATA_DIR}/state.json`;
let state = { bankroll: 100, trades: [], open: [], startedAt: new Date().toISOString() };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}

// One-time bankroll reset. State persists on the /data volume, so a normal
// redeploy reloads the old state.json above and does NOT reset the paper
// bankroll. To force a clean $100 restart, bump RESET_TOKEN: on the next boot
// the stored token won't match, so we wipe to a fresh $100 baseline exactly once
// and record the new token — every later redeploy then keeps trading from there.
//
// This bump is deliberate and authorized: V7 ended at $14.75 on the stale-spot
// bug, and V8's record has to start from a clean $100 or the two configs are
// mixed in one equity curve and neither can be judged. The V7 trades are archived
// under state.archive so the autopsy stays readable.
const RESET_TOKEN = '2026-08-27-v8-freshspot-100';
if (state.resetToken !== RESET_TOKEN) {
  const prior = {
    endedAt: new Date().toISOString(), token: state.resetToken || null,
    bankroll: state.bankroll, trades: (state.trades || []).length,
    note: 'V7 — spot read from the lagging Coinbase candle feed; see bot.js header'
  };
  const archive = (state.archive || []).concat([prior]).slice(-5);
  state = { bankroll: 100, trades: [], open: [], startedAt: new Date().toISOString(),
    resetToken: RESET_TOKEN, version: 'V8', archive };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

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
  // .toFixed(6) before the ceiling: without it 0.07*shares*price*(1-price)*100 lands on values like
  // 175.00000000000003 and Math.ceil overstates a $1.75 fee as $1.76. Matches kalshitrade.feeDollars
  // and src/decide.fee, which the equivalence test holds identical.
  const rawCents = 0.07 * shares * price * (1 - price) * 100;
  return Math.ceil(+rawCents.toFixed(6)) / 100;
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
/**
 * The current traded price, and how old it is.
 *
 * This exists because `candles[0].close` — what V7 used — is not the current
 * price. Coinbase's 1-minute candle feed lags the wall clock by 1-5 minutes
 * depending on the product, and the z-score gap (spot - strike) is the entire
 * directional signal, so a stale spot is a wrong signal that the Kalshi book has
 * already corrected. /ticker reports the last trade with its timestamp; measured
 * median age 1.8s against the candle feed's minutes.
 *
 * Returns null on a failed or stale read. The caller must SKIP on null — never
 * fall back to the candle close, because that is precisely the defect.
 */
async function getSpot(product) {
  try {
    const { data } = await axios.get(`${COINBASE}/${product}/ticker`, { timeout: 8000 });
    const price = parseFloat(data && data.price);
    if (!(price > 0)) return null;
    // `time` is the last trade's timestamp. A missing one means we cannot prove
    // freshness, and an unprovable spot is treated as stale.
    const ts = data.time ? new Date(data.time).getTime() : NaN;
    if (!Number.isFinite(ts)) return null;
    const ageMs = Date.now() - ts;
    if (ageMs > MAX_SPOT_AGE_MS) return { price, ageMs, stale: true };
    return { price, ageMs, stale: false };
  } catch (_) { return null; }
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

      // The candle window feeds the indicators and the vol estimate only. If it
      // is far enough behind that its realized vol describes a different regime,
      // there is nothing here worth sizing a bet on.
      const candleAgeMs = Date.now() - candles[0].time * 1000;
      if (candleAgeMs > MAX_CANDLE_AGE_MS) {
        log(`⏭️  ${coin.sym} skipped — candle feed ${Math.round(candleAgeMs / 60000)}m stale`);
        continue;
      }

      // SPOT comes from the ticker, not from candles[0].close. This one line is
      // the V7 -> V8 fix; see the header note. No fallback on failure — trading a
      // stale spot is the bug we are removing, so a failed read means skip.
      const s = await getSpot(coin.product);
      if (!s || s.stale) {
        if (s && s.stale) log(`⏭️  ${coin.sym} skipped — spot ${Math.round(s.ageMs / 1000)}s stale`);
        continue;
      }
      const spot = s.price;
      const minLeft = (new Date(market.close_time) - Date.now()) / 60000;
      const yesAsk = parseFloat(market.yes_ask_dollars || 0);
      const noAsk = parseFloat(market.no_ask_dollars || 0);
      const strike = parseFloat(market.floor_strike || 0);

      // ENGINE picks direction at high confidence
      const result = engineEvaluate(spot, strike, minLeft, candles);
      if (result.confidence < MIN_CONF || !result.side) continue;

      // 3/4 INDICATOR CONFIRMATION (was 2/4 — see MIN_CONFIRM)
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
      if (confirm < MIN_CONFIRM) continue;

      const side = result.side;
      // Correlation guard — 15-min crypto moves as one asset class, so multiple
      // same-direction bets settling in the SAME window are a single leveraged
      // position, not diversification. On 2026-08-26 the bot went DOGE/XRP/ETH
      // all DOWN in the same 05:30 window and lost all three together ($100 ->
      // $35.62). Cap to one position per direction per settlement window; an
      // opposite-direction bet in the same window is still allowed (it hedges).
      if (state.open.some(p => p.side === side && p.closeTime === market.close_time)) continue;
      const price = side === 'YES' ? yesAsk : noAsk;
      // Upper cap 0.80 (was 0.90): a binary bought at price p needs ~p win-rate
      // just to break even, so 85-90c entries require ~85-90% and bleed on the
      // ~10% that flip (XRP@86c / ETH@83c cost -$25 each on 2026-08-26). Replay
      // over 837 settled markets: the 85-90c band is net -$72 and 80-85c only
      // +$18, while 75-80c is +$458 (90% win). Capping at 0.80 sheds the losing
      // and marginal bands, keeps the profitable core (+$650 vs +$596 baseline).
      // Lower bound unchanged — cheap entries have the best risk/reward.
      if (price < 0.25 || price > 0.80) continue;

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
        // spotAgeMs / candleAgeMs are recorded on every fill so the stale-spot
        // defect can never silently return: if these start creeping into minutes,
        // the V7 failure mode is back and the dashboard will show it.
        spotAgeMs: s.ageMs, candleAgeMs: Math.round(candleAgeMs),
        confidence: result.confidence, z: result.z, rsi: Math.round(rsi), confirm, entryType, enteredAt: new Date().toISOString() };
      state.open.push(pos);
      save();
      log(`🎯 ${coin.sym} ${direction} @${Math.round(price*100)}c | ENGINE ${result.confidence}% z=${result.z} ${confirm}/4 | spot ${(s.ageMs/1000).toFixed(1)}s old | fee $${entryFee.toFixed(2)} | ${entryType}`);
      webhook(`🎯 **ENTRY** ${coin.sym} ${direction} @${Math.round(price*100)}c | ENGINE ${result.confidence}% (${confirm}/4 ind) | ${entryType} | Bank: $${state.bankroll.toFixed(2)}`);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
}

async function main() {
  log('=== V8 ENGINE + INDICATORS — FRESH SPOT ===');
  log(`Engine ${MIN_CONF}%+ | ${MIN_CONFIRM}/4 indicators | Entry 25-80c | Cashout ${Math.round(CASHOUT*100)}c | ${SHARES}sh`);
  log(`spot from /ticker (max ${MAX_SPOT_AGE_MS/1000}s old) — V7 read it from the candle feed, 1-5 MINUTES behind`);
  log(`Bankroll: $${state.bankroll.toFixed(2)} | Trades: ${state.trades.length} | Open: ${state.open.length}`);
  log('');
  webhook(`🚀 **V8 STARTED — stale-spot bug fixed**\nV7 lost 85% of bank reading spot from a candle feed 1-5min behind the clock. Spot now comes from /ticker (~2s old).\nEngine ${MIN_CONF}%+ + ${MIN_CONFIRM}/4 indicators | 25-80c | cashout 97c\nBankroll: $${state.bankroll.toFixed(2)}`);
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
  getSpot, getCandles,
  COINS, SHARES, CASHOUT, MAX_POS, MIN_CONF, MIN_CONFIRM
};
