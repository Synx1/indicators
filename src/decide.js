/**
 * The decision maths, and nothing else.
 *
 * Lifted verbatim out of bot.js — the legacy single-bankroll script — so the multi-account bot
 * and the original cannot disagree about what a signal IS. Extracted programmatically rather
 * than retyped: hand-copying is how two implementations start life 0.01% apart, and on a
 * probability that drives both the entry gate and the size, 0.01% is a different trade.
 *
 * test/decide.test.js asserts these still match bot.js function-for-function. When bot.js is
 * retired this file becomes canonical and that test retires with it.
 *
 * Pure: no clock, no network, no state. Everything it needs is an argument.
 */

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

function fee(price, shares) {
  return Math.ceil(0.07 * shares * price * (1 - price) * 100) / 100;
}

module.exports = { calcRSI, calcEMA, calcBollingerBands, calcVWAP, realizedVol, engineEvaluate, fee };
