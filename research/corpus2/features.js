'use strict';

/**
 * Point-in-time feature matrix for the whole 68-day corpus.
 *
 * ── the problem being modelled ──
 *
 * At minute m of a 15-minute round, with `left = 15 - m` minutes to go, predict P(close > strike).
 * That is the only question the bot ever needs answered, and the live engine answers it with a single
 * number: z = gap / (vol * sqrt(left)). Everything else — RSI, the two EMAs, Bollinger, VWAP — only
 * votes on whether to allow the z-derived direction, and traded volume is not consulted at all.
 *
 * So the rebuild is not a new dial. It is asking whether those signals carry information the z-only
 * model is throwing away, and it can only be answered by fitting them jointly.
 *
 * ── leakage rules, enforced not assumed ──
 *
 * Every feature at minute m is computed from candles with ts <= the minute's open. `assertNoLookahead`
 * fails the build rather than warning, because a silent lookahead produces a beautiful model that
 * cannot be traded. The label comes from Kalshi's settlement, never from the candle series, so a
 * close-price rounding difference can never leak into the target.
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'features.json');
const WINDOW = 15;
const FIRST_MIN = 1;      // minute 0 has no completed bar inside the round
const LAST_MIN = 13;      // a fill needs time; minute 14 is unreachable in practice

const NAMES = [
  'z',            // the incumbent's whole model — the benchmark feature
  'gapBps',       // raw distance to the strike, scale-free
  'leftMin',      // minutes remaining
  'rsi14',        // exhaustion / momentum
  'emaSpread',    // ema9/ema20 - 1, trend direction and strength
  'vwapSpread',   // spot/vwap - 1, position against volume-weighted price
  'bbSpread',     // spot/bbMid - 1
  'ret1Bps',      // last minute's return
  'ret5Bps',      // 5-minute drift
  'ret15Bps',     // 15-minute drift
  'volRatio',     // this minute's volume over its trailing median — participation
  'volAccel',     // realized vol over 10 min / over 30 min: is volatility itself rising
  'volBps'        // realized vol per minute, in bps
];

const finite = v => (Number.isFinite(v) ? v : null);

function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (gain + loss === 0) return 50;
  const rs = loss === 0 ? 100 : gain / loss;
  return 100 - 100 / (1 + rs);
}

function sd(values) {
  if (values.length < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  // n-1: the live realizedVol divides by n and understates by ~5% at n=10. Not copied here — a
  // benchmark should not inherit a defect it is being compared against.
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

/** Every feature for one (market, minute), or null when the history is too thin to be honest. */
function featurize(hist, spot, strike, left) {
  if (!hist.length || !(spot > 0) || !(strike > 0)) return null;
  const closes = hist.map(c => c[3]).filter(v => v > 0);
  if (closes.length < 31) return null;                       // need 30 bars for volAccel

  const rets = logReturns(closes.slice(-31));
  const volPerMin = sd(rets.slice(-10));
  if (!(volPerMin > 0)) return null;
  const sigma = volPerMin * Math.sqrt(left);
  const gap = (spot - strike) / strike;
  const z = sigma > 1e-9 ? gap / sigma : null;
  if (z == null) return null;

  const vol30 = sd(rets.slice(-30));
  const ema9 = ema(closes.slice(-40), 9);
  const ema20 = ema(closes.slice(-40), 20);
  const bbMid = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);

  const last20 = hist.slice(-20);
  let vp = 0, vv = 0;
  for (const c of last20) {
    const typical = (c[1] + c[2] + c[3]) / 3;
    const v = Number(c[4]) || 0;
    vp += typical * v; vv += v;
  }
  const vwap = vv > 0 ? vp / vv : bbMid;

  const vols = last20.map(c => Number(c[4]) || 0).sort((a, b) => a - b);
  const medVol = vols.length >= 10 ? vols[Math.floor(vols.length / 2)] : null;
  const thisVol = Number(hist.at(-1)[4]) || 0;

  const at = n => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const retBps = n => { const p = at(n); return p > 0 ? Math.log(spot / p) * 1e4 : null; };

  const row = [
    z,
    gap * 1e4,
    left,
    rsi(closes, 14),
    ema9 && ema20 ? ema9 / ema20 - 1 : null,
    vwap > 0 ? spot / vwap - 1 : null,
    bbMid > 0 ? spot / bbMid - 1 : null,
    retBps(1), retBps(5), retBps(15),
    medVol > 0 ? thisVol / medVol : null,
    vol30 > 0 ? volPerMin / vol30 : null,
    volPerMin * 1e4
  ];
  return row.every(v => finite(v) != null) ? row : null;
}

/** Fail the build on any row whose history reaches at or past the minute it is predicting from. */
function assertNoLookahead(histLastMs, minuteMs, ticker) {
  if (histLastMs >= minuteMs) {
    throw new Error(`LOOKAHEAD: ${ticker} used a candle at ${new Date(histLastMs).toISOString()} ` +
      `to predict from ${new Date(minuteMs).toISOString()}`);
  }
}

function build() {
  const markets = JSON.parse(fs.readFileSync(path.join(DIR, 'markets.json'), 'utf8'));
  const X = [], y = [], meta = [];
  let skippedThin = 0, checked = 0;

  for (const sym of Object.keys(markets)) {
    const file = path.join(DIR, 'candles', `${sym}.json`);
    if (!fs.existsSync(file)) { console.log(`  ${sym}: no candles, skipped`); continue; }
    const candles = JSON.parse(fs.readFileSync(file, 'utf8'));
    const times = candles.map(c => c[0]);
    // Index by minute so the per-row history slice is a binary search, not a scan of 100k rows.
    const idxOf = ms => {
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] < ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;                                            // last candle STRICTLY before ms
    };

    let kept = 0;
    for (const [ticker, closeMs, strike, label] of markets[sym]) {
      const openMs = closeMs - WINDOW * 60000;
      for (let el = FIRST_MIN; el <= LAST_MIN; el++) {
        const minuteMs = openMs + el * 60000;
        const i = idxOf(minuteMs);
        if (i < 60) { skippedThin++; continue; }
        const hist = candles.slice(Math.max(0, i - 79), i + 1);
        assertNoLookahead(hist.at(-1)[0], minuteMs, ticker); checked++;
        const spot = hist.at(-1)[3];
        const row = featurize(hist, spot, strike, WINDOW - el);
        if (!row) { skippedThin++; continue; }
        X.push(row.map(v => +v.toFixed(5)));
        y.push(label);
        meta.push([sym, closeMs, el, +strike, +spot.toFixed(6)]);
        kept++;
      }
    }
    console.log(`  ${sym}: ${kept} rows from ${markets[sym].length} markets`);
  }

  // reduce, not Math.max(...spread): spreading 300k+ arguments overflows the call stack.
  let minMs = Infinity, maxMs = -Infinity;
  for (const m of meta) { if (m[1] < minMs) minMs = m[1]; if (m[1] > maxMs) maxMs = m[1]; }
  const days = meta.length ? (maxMs - minMs) / 86400000 : 0;
  console.log(`\n${X.length} rows · ${NAMES.length} features · ${days.toFixed(1)} days · ` +
    `${(y.reduce((a, b) => a + b, 0) / y.length * 100).toFixed(2)}% YES · ${skippedThin} skipped for thin history`);
  console.log(`lookahead assertions passed: ${checked}`);
  fs.writeFileSync(OUT, JSON.stringify({ names: NAMES, X, y, meta }));
  console.log(`-> ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

if (require.main === module) build();
module.exports = { NAMES, featurize, rsi, ema, sd, logReturns, build };
