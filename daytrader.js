'use strict';
/**
 * Day trading indicators for the 15-min crypto engine.
 * 
 * 7 indicators scored as bullish/bearish. Used as a confirmation layer:
 * the engine only acts when 6/7 indicators agree with the model's direction.
 *
 * Indicators:
 *   1. RSI (14) — momentum oscillator
 *   2. EMA 9/20 crossover — short-term trend
 *   3. EMA 50 — medium-term trend
 *   4. Bollinger Bands — price position
 *   5. VWAP — institutional flow
 *   6. MACD — momentum direction
 *   7. Stochastic %K — overbought/oversold
 */

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    const diff = candles[i].close - candles[i + 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
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

function calcMACD(candles) {
  if (candles.length < 30) return 0;
  const prices = candles.map(c => c.close).reverse();
  const ema = (arr, p) => { const k = 2/(p+1); let e = arr[0]; for (let i=1; i<arr.length; i++) e = arr[i]*k + e*(1-k); return e; };
  return ema(prices.slice(-26), 12) - ema(prices, 26);
}

function calcStochastic(candles, period = 14) {
  if (candles.length < period) return 50;
  const slice = candles.slice(0, period);
  const highest = Math.max(...slice.map(c => c.high));
  const lowest = Math.min(...slice.map(c => c.low));
  if (highest === lowest) return 50;
  return ((candles[0].close - lowest) / (highest - lowest)) * 100;
}

/**
 * Score 7 indicators as bullish or bearish.
 * @param {object[]} candles — newest-first, 1-min candles (need 50+)
 * @returns {{ bullScore, bearScore, rsi, stoch, details }}
 */
function score(candles) {
  if (!candles || candles.length < 30) return { bullScore: 0, bearScore: 0, rsi: 50, stoch: 50, details: {} };
  
  const spot = candles[0].close;
  const rsi = calcRSI(candles, 14);
  const ema9 = calcEMA(candles, 9);
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const bb = calcBollingerBands(candles, 20);
  const vwap = calcVWAP(candles, 20);
  const macd = calcMACD(candles);
  const stoch = calcStochastic(candles, 14);

  let bullScore = 0, bearScore = 0;
  if (rsi > 50) bullScore++; else bearScore++;
  if (ema9 > ema20) bullScore++; else bearScore++;
  if (spot > ema50) bullScore++; else bearScore++;
  if (bb && spot > bb.middle) bullScore++; else bearScore++;
  if (spot > vwap) bullScore++; else bearScore++;
  if (macd > 0) bullScore++; else bearScore++;
  if (stoch > 50) bullScore++; else bearScore++;

  return {
    bullScore, bearScore, rsi: +rsi.toFixed(1), stoch: +stoch.toFixed(1),
    details: {
      rsi: rsi > 50 ? 'bull' : 'bear',
      emaCross: ema9 > ema20 ? 'bull' : 'bear',
      ema50: spot > ema50 ? 'bull' : 'bear',
      bollinger: bb && spot > bb.middle ? 'bull' : 'bear',
      vwap: spot > vwap ? 'bull' : 'bear',
      macd: macd > 0 ? 'bull' : 'bear',
      stochastic: stoch > 50 ? 'bull' : 'bear'
    }
  };
}

/**
 * Should the engine act on this trade?
 * @param {object[]} candles — newest-first
 * @param {string} side — 'YES' or 'NO' (model's chosen side)
 * @returns {{ confirmed, bullScore, bearScore, rsi, reason }}
 */
function confirms(candles, side) {
  const s = score12(candles);
  const modelUp = side === 'YES';
  
  // 6/7 indicators must agree with model direction
  if (modelUp && s.bullScore >= 10 && s.strongTrend) return { confirmed: true, ...s, reason: `${s.bullScore}/7 bull confirms UP` };
  if (!modelUp && s.bearScore >= 10 && s.strongTrend && s.rsi < 30) return { confirmed: true, ...s, reason: `${s.bearScore}/7 bear confirms DOWN (RSI ${s.rsi})` };
  
  // Model direction disagrees with strong indicator consensus
  if (modelUp && s.bearScore >= 8) return { confirmed: false, ...s, reason: `${s.bearScore}/7 bearish — model UP rejected` };
  if (!modelUp && s.bullScore >= 8) return { confirmed: false, ...s, reason: `${s.bullScore}/7 bullish — model DOWN rejected` };
  
  // Mixed signals — allow if model confidence is high (handled by gate)
  return { confirmed: true, ...s, reason: `mixed (${s.bullScore}/${s.bearScore}) — defer to model` };
}

module.exports = { score, confirms, calcRSI, calcEMA, calcBollingerBands, calcVWAP, calcMACD, calcStochastic };

// === ADDITIONAL INDICATORS (v1.7+) ===

/** ADX — trend strength. >25 = strong trend, <20 = choppy. */
function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 25; // neutral default
  let sumDX = 0;
  for (let i = 0; i < period; i++) {
    const hi = candles[i].high - candles[i+1].high;
    const lo = candles[i+1].low - candles[i].low;
    const plusDM = hi > lo && hi > 0 ? hi : 0;
    const minusDM = lo > hi && lo > 0 ? lo : 0;
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i+1].close), Math.abs(candles[i].low - candles[i+1].close));
    if (tr > 0) sumDX += Math.abs(plusDM - minusDM) / tr;
  }
  return (sumDX / period) * 100;
}

/** OBV — On-Balance Volume direction. Returns 'up' or 'down'. */
function calcOBV(candles, period = 10) {
  if (candles.length < period) return 'neutral';
  let obv = 0;
  for (let i = 0; i < period - 1; i++) {
    if (candles[i].close > candles[i+1].close) obv += (candles[i].volume || 1);
    else if (candles[i].close < candles[i+1].close) obv -= (candles[i].volume || 1);
  }
  return obv > 0 ? 'up' : 'down';
}

/** CCI — Commodity Channel Index. >100 overbought, <-100 oversold. */
function calcCCI(candles, period = 14) {
  if (candles.length < period) return 0;
  const tps = candles.slice(0, period).map(c => (c.high + c.low + c.close) / 3);
  const mean = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((a, tp) => a + Math.abs(tp - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[0] - mean) / (0.015 * meanDev);
}

/** Williams %R. -20 to 0 = overbought, -80 to -100 = oversold. */
function calcWilliamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(0, period);
  const highest = Math.max(...slice.map(c => c.high));
  const lowest = Math.min(...slice.map(c => c.low));
  if (highest === lowest) return -50;
  return ((highest - candles[0].close) / (highest - lowest)) * -100;
}

/** MFI — Money Flow Index (volume-weighted RSI). */
function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = 0; i < period; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i+1].high + candles[i+1].low + candles[i+1].close) / 3;
    const mf = tp * (candles[i].volume || 1);
    if (tp > prevTp) posFlow += mf;
    else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - (100 / (1 + ratio));
}

// Updated score function with 12 indicators
function score12(candles) {
  if (!candles || candles.length < 30) return { bullScore: 0, bearScore: 0, total: 12, rsi: 50 };
  
  const spot = candles[0].close;
  const rsi = calcRSI(candles, 14);
  const ema9 = calcEMA(candles, 9);
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const bb = calcBollingerBands(candles, 20);
  const vwap = calcVWAP(candles, 20);
  const macd = calcMACD(candles);
  const stoch = calcStochastic(candles, 14);
  const adx = calcADX(candles, 14);
  const obv = calcOBV(candles, 10);
  const cci = calcCCI(candles, 14);
  const williamsR = calcWilliamsR(candles, 14);
  const mfi = calcMFI(candles, 14);

  let bull = 0, bear = 0;
  // Original 7
  if (rsi > 50) bull++; else bear++;
  if (ema9 > ema20) bull++; else bear++;
  if (spot > ema50) bull++; else bear++;
  if (bb && spot > bb.middle) bull++; else bear++;
  if (spot > vwap) bull++; else bear++;
  if (macd > 0) bull++; else bear++;
  if (stoch > 50) bull++; else bear++;
  // New 5
  if (obv === 'up') bull++; else bear++;      // volume direction
  if (cci > 0) bull++; else bear++;           // deviation
  if (williamsR > -50) bull++; else bear++;   // overbought/oversold
  if (mfi > 50) bull++; else bear++;          // volume-weighted momentum
  // ADX is special — it measures STRENGTH not direction
  // If ADX < 20, trend is weak → don't trade either direction
  const strongTrend = adx > 20;

  return { bullScore: bull, bearScore: bear, total: 12, rsi: +rsi.toFixed(1), adx: +adx.toFixed(1), strongTrend, mfi: +mfi.toFixed(1), cci: +cci.toFixed(1) };
}

module.exports.calcADX = calcADX;
module.exports.calcOBV = calcOBV;
module.exports.calcCCI = calcCCI;
module.exports.calcWilliamsR = calcWilliamsR;
module.exports.calcMFI = calcMFI;
module.exports.score12 = score12;

/**
 * Volume gate — checks if BTC 1-min volume is above threshold.
 * Below 4 BTC/min = dead market, no reliable trends.
 * @param {object[]} candles — BTC 1-min candles newest-first
 * @returns {{ ok, avgVol, reason }}
 */
function volumeGate(candles, minVol = 4, gapBps = 0) {
  if (!candles || candles.length < 10) return { ok: true, avgVol: 0, reason: 'no data' };
  const avg = candles.slice(0, 15).reduce((a, c) => a + (c.volume || 0), 0) / 15;
  if (avg < minVol && Math.abs(gapBps) < 20) return { ok: false, avgVol: +avg.toFixed(2), reason: 'volume ' + avg.toFixed(1) + ' BTC/min < ' + minVol + ' threshold — slow market' };
  return { ok: true, avgVol: +avg.toFixed(2), reason: 'volume OK' };
}

module.exports.volumeGate = volumeGate;

/**
 * Time-of-day directional bias from 3,959 rounds over 31 days.
 * Certain hours consistently favor UP or DOWN.
 * Returns a directional lean that should weight indicator scoring.
 *
 * @param {Date} [now]
 * @returns {{ lean: 'UP'|'DOWN'|null, strength: number, hour: number }}
 */
function timeOfDayBias(now = new Date()) {
  const etHour = (now.getUTCHours() - 4 + 24) % 24;
  
  // Hours with >5pt bias from 50% over 168 samples each
  const BIAS = {
    1: { lean: 'DOWN', strength: 0.06 },   // 44% YES = 56% DOWN
    5: { lean: 'UP', strength: 0.05 },     // 55% YES
    6: { lean: 'UP', strength: 0.05 },     // 55% YES
    7: { lean: 'DOWN', strength: 0.04 },   // 46% YES
    8: { lean: 'DOWN', strength: 0.07 },   // 43% YES = strongest DOWN
    10: { lean: 'UP', strength: 0.08 },    // 58% YES = strongest UP
    11: { lean: 'UP', strength: 0.07 },    // 57% YES
    18: { lean: 'DOWN', strength: 0.05 },  // 45% YES
    19: { lean: 'DOWN', strength: 0.05 },  // 45% YES
    20: { lean: 'DOWN', strength: 0.04 }   // 46% YES
  };
  
  const entry = BIAS[etHour];
  if (!entry) return { lean: null, strength: 0, hour: etHour };
  return { lean: entry.lean, strength: entry.strength, hour: etHour };
}

module.exports.timeOfDayBias = timeOfDayBias;

/**
 * BACKTEST FINDINGS (260 BTC rounds, 2026-08-22):
 *
 * WORKS (55-61% edge):
 *   - Volume spike continuation: 58.8% (68T) — spike direction = settlement direction
 *   - Big gap from strike >20bps: 61.3% YES if above, 54.9% NO if below
 *
 * DOESN'T WORK (coinflip or worse):
 *   - RSI extremes: 43-47% (mean reversion FAILS on 15-min crypto)
 *   - EMA 9/20 cross: 42-44% (worse than random!)
 *   - Candle momentum alone: 51% (nearly random)
 *   - 10-min drift: 48-52%
 *
 * CONCLUSION: Indicators are useful as FILTERS (avoid chop, confirm volume)
 * but not as PREDICTORS. The real edge is:
 *   1. Volume spikes → continuation
 *   2. Big gap from strike → stays there (what z-score model already does)
 *   3. Time-of-day bias (10AM UP 58%, 8AM DOWN 57%)
 *   4. Volume gate (don't trade dead markets)
 */

/**
 * TREND IGNITION DETECTOR
 * 
 * Detects when a trend is STARTING by looking for:
 * 1. Volume spike (>2x avg in last 3 candles)
 * 2. Clear direction (spike candle is strongly directional)
 * 3. Continuation (next candle continues in same direction)
 *
 * From backtest: volume spike continuation = 58.8% win rate.
 * When combined with gap from strike (>20bps) = 61%+.
 *
 * Returns: { ignition, direction, confidence, spike }
 */
function trendIgnition(candles) {
  if (!candles || candles.length < 15) return { ignition: false };
  
  // Average volume over candles 3-15 (baseline)
  const baseline = candles.slice(3, 15).reduce((a, c) => a + (c.volume || 0), 0) / 12;
  if (baseline <= 0) return { ignition: false };
  
  // Check last 3 candles for a spike
  const recent = candles.slice(0, 3);
  const spike = recent.find(c => (c.volume || 0) > baseline * 2);
  if (!spike) return { ignition: false };
  
  // Spike direction (strong body = directional, not noise)
  const body = Math.abs(spike.close - spike.open);
  const wick = spike.high - spike.low;
  if (wick === 0 || body / wick < 0.4) return { ignition: false }; // weak candle, mostly wick
  
  const direction = spike.close > spike.open ? 'UP' : 'DOWN';
  
  // Confirmation: is the most recent candle continuing in the same direction?
  const latest = candles[0];
  const continues = (direction === 'UP' && latest.close > latest.open) ||
                    (direction === 'DOWN' && latest.close < latest.open);
  
  if (!continues) return { ignition: false }; // spike but no follow-through
  
  const multiple = (spike.volume || 0) / baseline;
  const confidence = Math.min(0.95, 0.60 + (multiple - 2) * 0.05 + (body/wick) * 0.1);
  
  return {
    ignition: true,
    direction,
    confidence: +confidence.toFixed(2),
    spikeVol: +(spike.volume || 0).toFixed(2),
    baselineVol: +baseline.toFixed(2),
    multiple: +multiple.toFixed(1),
    bodyRatio: +(body/wick).toFixed(2)
  };
}

module.exports.trendIgnition = trendIgnition;
