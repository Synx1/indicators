#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — is there a better fourth indicator, and is there a bad time of day?
 *
 * Two questions from the live book, tested on the corpus so the answer is not fitted to one week.
 *
 * ── 1. the indicator review ──
 *
 * research-confirm.js found the Bollinger check NEVER DISSENTS: in 60 live-gate trades it agreed every
 * single time, because if spot is on the right side of the trend it is always on the right side of a
 * 20-bar mean. It is a free pass occupying one of four slots. So the real question is not "add a fifth"
 * but "replace the dead one", and the candidates are chosen for INDEPENDENCE rather than popularity:
 * RSI, EMA and VWAP all read close prices, so another close-price oscillator adds a correlated opinion.
 * Volume and true range are the only genuinely different information a candle carries.
 *
 * ── 2. the hour-of-day question ──
 *
 * The live book's hourly table shows 7 AM - 1 PM ET at -$203 across 41 trades while 2 PM - 5 PM is
 * +$133 across 36. That is either the most valuable filter available or the most obvious curve-fit in
 * the book, and the corpus is how to tell: a session effect that appears in BOTH is a property of the
 * market, one that appears in neither is a property of one week.
 *
 * `node research-indicators.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(+(0.07 * n * p * (1 - p) * 100).toFixed(6)) / 100;
const etHour = ms => Number(new Date(ms).toLocaleString('en-US',
  { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;

// ── candidate indicators, all computed from the same candle array (newest first) ──
/** Classic MACD histogram: EMA12 - EMA26, versus its own 9-period signal. Sign is the read. */
function macdHist(c) {
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let e = arr[0];
    for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  };
  const closes = c.map(x => x.close).reverse();          // oldest -> newest
  if (closes.length < 35) return 0;
  const line = t => ema(closes.slice(0, t), 12) - ema(closes.slice(0, t), 26);
  const macdNow = line(closes.length);
  // Signal = EMA9 of the MACD line, walked over the last 9 points.
  const hist = [];
  for (let i = closes.length - 9; i <= closes.length; i++) hist.push(line(i));
  const sig = ema(hist, 9);
  return macdNow - sig;
}
/** Stochastic %K over `p` bars: where the last close sits in its own high-low range. */
function stoch(c, p = 14) {
  const w = c.slice(0, p);
  if (w.length < p) return 50;
  const hi = Math.max(...w.map(x => x.high)), lo = Math.min(...w.map(x => x.low));
  return hi === lo ? 50 : ((c[0].close - lo) / (hi - lo)) * 100;
}
/** Rate of change over `p` bars, in percent. */
const roc = (c, p) => (c[p] ? ((c[0].close - c[p].close) / c[p].close) * 100 : 0);
/** Volume now against its own 30-bar average — the one genuinely non-price signal a candle carries. */
function volRatio(c, p = 30) {
  const w = c.slice(0, p);
  const avg = w.reduce((a, x) => a + (x.volume || 0), 0) / (w.length || 1);
  return avg > 0 ? (c[0].volume || 0) / avg : 1;
}
/** On-balance-volume slope over `p` bars: volume signed by the direction it traded on. */
function obvSlope(c, p = 10) {
  let obv = 0;
  const series = [];
  for (let i = Math.min(p, c.length - 1); i >= 0; i--) {
    const prev = c[i + 1];
    if (prev) obv += (c[i].close > prev.close ? 1 : c[i].close < prev.close ? -1 : 0) * (c[i].volume || 0);
    series.push(obv);
  }
  return series[series.length - 1] - series[0];
}
/** Average true range, as a fraction of price — a volatility regime read rather than a direction one. */
function atrPct(c, p = 14) {
  let sum = 0, n = 0;
  for (let i = 0; i < Math.min(p, c.length - 1); i++) {
    const tr = Math.max(c[i].high - c[i].low,
      Math.abs(c[i].high - c[i + 1].close), Math.abs(c[i].low - c[i + 1].close));
    sum += tr; n++;
  }
  return n ? (sum / n) / c[0].close : 0;
}

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { sym, rows: j.rows || [], byTime };
}
function closedBefore(byTime, ts, depth) {
  const out = []; let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) { const c = byTime.get(t); if (c) out.push(c); }
  return out;
}
/** Every candidate at the live gate, carrying each indicator's verdict for the chosen side. */
function candidate(row, byTime, sym) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const c = closedBefore(byTime, ts, 60);
    if (c.length < MIN_CANDLES) continue;
    const spot = c[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, c);
    if (!res.side || !trader.confOK(res.confidence)) continue;
    if (!trader.gapOK(spot, row.strike)) continue;
    const up = res.side === 'YES';
    const rsi = decide.calcRSI(c, 14), e9 = decide.calcEMA(c, 9), e20 = decide.calcEMA(c, 20);
    const bb = decide.calcBollingerBands(c, 20), vw = decide.calcVWAP(c, 20);
    // The four in production.
    const live = {
      RSI: up ? rsi > 50 : rsi < 50,
      EMA: up ? e9 > e20 : e9 < e20,
      BB: bb ? (up ? spot > bb.middle : spot < bb.middle) : false,
      VWAP: up ? spot > vw : spot < vw
    };
    const confirm = Object.values(live).filter(Boolean).length;
    if (confirm < trader.MIN_CONFIRM) continue;
    const ep = up ? q.ask : (1 - q.bid);
    if (ep < trader.MIN_PRICE || ep > trader.MAX_PRICE) continue;
    // The candidates, each as a boolean "agrees with the chosen side".
    const sign = v => (up ? v > 0 : v < 0);
    const cand = {
      MACD: sign(macdHist(c)),
      STOCH: up ? stoch(c, 14) > 50 : stoch(c, 14) < 50,
      ROC5: sign(roc(c, 5)),
      ROC15: sign(roc(c, 15)),
      VOLUP: volRatio(c, 30) > 1,            // is this minute busier than usual?
      VOLQUIET: volRatio(c, 30) < 1,         // ...or quieter? tested both ways on purpose
      OBV: sign(obvSlope(c, 10)),
      CALMVOL: atrPct(c, 14) < 0.0006        // a low-volatility regime, direction-agnostic
    };
    const won = (up && row.settledYes) || (!up && !row.settledYes);
    return {
      sym, side: res.side, entryPrice: ep, confidence: res.confidence, won, confirm, live, cand,
      pnl: (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES),
      closeMs: row.closeMs, hour: etHour(row.closeMs), atr: atrPct(c, 14), vr: volRatio(c, 30)
    };
  }
  return null;
}
const pct = x => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function stats(list) {
  const s = list.slice().sort((a, b) => a.closeMs - b.closeMs);
  const w = s.filter(e => e.won).length, p = s.reduce((a, e) => a + e.pnl, 0);
  const mid = Math.floor(s.length / 2);
  const h = x => (x.length ? x.filter(e => e.won).length / x.length : null);
  return {
    n: s.length, wr: s.length ? w / s.length : null, p, per: s.length ? p / s.length : 0,
    h1: h(s.slice(0, mid)), h2: h(s.slice(mid))
  };
}

const all = [];
for (const sym of COINS) {
  let ds; try { ds = loadCoin(sym); } catch (e) { continue; }
  for (const r of ds.rows) { const c = candidate(r, ds.byTime, sym); if (c) all.push(c); }
}
const base = stats(all);
console.log(`\n  INDICATOR REVIEW — ${all.length} live-gate entries, ${SHARES}sh, hold to settlement`);
console.log(`  baseline: win ${pct(base.wr)}, net ${usd(base.p)}, halves ${pct(base.h1)} / ${pct(base.h2)}`);

console.log('\n  1) THE FOUR IN PRODUCTION — does each one ever disagree, and does it matter?');
console.log('  indicator   agrees  win%    | dissents  win%    | LIFT     verdict');
for (const key of ['RSI', 'EMA', 'BB', 'VWAP']) {
  const yes = stats(all.filter(e => e.live[key])), no = stats(all.filter(e => !e.live[key]));
  const lift = (yes.wr != null && no.wr != null) ? yes.wr - no.wr : null;
  const verdict = no.n === 0 ? 'NEVER DISSENTS — a free pass, contributes nothing'
    : no.n < 5 ? `only ${no.n} dissents — no information to read`
      : (lift > 0.02 ? 'carries signal' : 'no usable lift');
  console.log(`  ${key.padEnd(10)} ${String(yes.n).padStart(6)}  ${pct(yes.wr).padStart(6)} ` +
    `  | ${String(no.n).padStart(8)}  ${pct(no.wr).padStart(6)}  | ` +
    `${(lift == null ? '—' : (lift >= 0 ? '+' : '') + (lift * 100).toFixed(1) + 'pp').padStart(7)}  ${verdict}`);
}

console.log('\n  2) CANDIDATE REPLACEMENTS — chosen for INDEPENDENCE from close price, not popularity');
console.log('  candidate   agrees  win%    net      | dissents  win%    net      | LIFT');
for (const key of Object.keys(all[0].cand)) {
  const yes = stats(all.filter(e => e.cand[key])), no = stats(all.filter(e => !e.cand[key]));
  const lift = (yes.wr != null && no.wr != null) ? yes.wr - no.wr : null;
  console.log(`  ${key.padEnd(10)} ${String(yes.n).padStart(6)}  ${pct(yes.wr).padStart(6)}  ${usd(yes.p).padStart(8)} ` +
    `| ${String(no.n).padStart(8)}  ${pct(no.wr).padStart(6)}  ${usd(no.p).padStart(8)} | ` +
    `${(lift == null ? '—' : (lift >= 0 ? '+' : '') + (lift * 100).toFixed(1) + 'pp').padStart(7)}`);
}

console.log('\n  3) SESSION EFFECT — the live book says 7 AM-1 PM ET bleeds. Does the corpus agree?');
console.log('  session (ET)        n     win%     net      $/trade  | halves win%');
const SESSIONS = [
  ['overnight 12-3am', h => h >= 0 && h < 3], ['early 3-7am', h => h >= 3 && h < 7],
  ['US open 7am-1pm', h => h >= 7 && h < 13], ['afternoon 1-5pm', h => h >= 13 && h < 17],
  ['evening 5pm-12am', h => h >= 17]
];
for (const [label, fn] of SESSIONS) {
  const s = stats(all.filter(e => fn(e.hour)));
  console.log(`  ${label.padEnd(19)} ${String(s.n).padStart(3)}  ${pct(s.wr).padStart(6)}  ${usd(s.p).padStart(9)}  ` +
    `${usd(s.per).padStart(7)}  | ${pct(s.h1)} / ${pct(s.h2)}`);
}
console.log('\n  4) VOLATILITY REGIME — the mechanism a session filter would really be proxying for');
console.log('  ATR band            n     win%     net      $/trade');
const atrs = all.map(e => e.atr).sort((a, b) => a - b);
const q = f => atrs[Math.floor(atrs.length * f)] || 0;
for (const [label, lo, hi] of [['calmest quartile', 0, q(0.25)], ['second', q(0.25), q(0.5)],
  ['third', q(0.5), q(0.75)], ['most volatile quartile', q(0.75), Infinity]]) {
  const s = stats(all.filter(e => e.atr >= lo && e.atr < hi));
  console.log(`  ${label.padEnd(19)} ${String(s.n).padStart(3)}  ${pct(s.wr).padStart(6)}  ${usd(s.p).padStart(9)}  ${usd(s.per).padStart(7)}`);
}
// ── 5. the actual proposal: SWAP the dead slot, do not add a fifth ──
//
// BB never dissents, so `3 of 4` today really means `2 of 3 that can vary`. Putting a live indicator in
// that slot makes the threshold mean what it says — which is a stricter gate even at the same number,
// and the honest way to measure it is end to end rather than as a lift.
function maxDD(list) {
  let eq = 0, peak = 0, dd = 0;
  for (const e of list.slice().sort((a, b) => a.closeMs - b.closeMs)) {
    eq += e.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}
console.log('\n  5) SWAPPING THE DEAD SLOT — BB out, one candidate in, MIN_CONFIRM still 3 of 4');
console.log('  fourth slot     n     win%     net      $/trade   maxDD  net/DD | halves win%');
for (const [label, key] of [['BB (today)', 'BB'], ['MACD', 'MACD'], ['OBV', 'OBV'],
  ['ROC5', 'ROC5'], ['VOLUP', 'VOLUP'], ['STOCH', 'STOCH']]) {
  const kept = all.filter(e => {
    const four = key === 'BB'
      ? [e.live.RSI, e.live.EMA, e.live.VWAP, e.live.BB]
      : [e.live.RSI, e.live.EMA, e.live.VWAP, e.cand[key]];
    return four.filter(Boolean).length >= trader.MIN_CONFIRM;
  });
  const s = stats(kept), dd = maxDD(kept);
  console.log(`  ${label.padEnd(14)} ${String(s.n).padStart(3)}  ${pct(s.wr).padStart(6)}  ${usd(s.p).padStart(9)}  ` +
    `${usd(s.per).padStart(7)}  ${('$' + dd.toFixed(0)).padStart(6)}  ${(dd > 0 ? (s.p / dd).toFixed(1) : '∞').padStart(5)}  | ` +
    `${pct(s.h1)} / ${pct(s.h2)}${key === 'BB' ? '   <- LIVE' : ''}`);
}
console.log('');
