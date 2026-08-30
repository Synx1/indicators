#!/usr/bin/env node
/**
 * WHY IS IT LOSING? The same question, asked of 1806 markets instead of 52 trades.
 *
 * "I want a good margin" is a reasonable thing to want, and the honest way to answer it is not an
 * opinion about Kelly fractions — it is to walk a real sequence of this strategy's own trades and see
 * where the money ends up at 5%, 10%, 25% and beyond.
 *
 * ── why a distribution rather than one path ──
 *
 * A single chronological run is ONE sample. It says what happened in the order it happened, and at
 * 25% risk the order matters enormously: the same trades dealt in a different sequence can end at
 * four figures or at nothing, because a loss early compounds down and a loss late compounds off a
 * bigger base. So the trades are reshuffled many times and the spread is reported — median, bad-luck
 * percentile, worst drawdown, and how often the account is finished.
 *
 * ── how sizing is modelled ──
 *
 * Exactly as src/trader.js does it: shares = floor(bank * risk / 0.80), whole contracts only, and a
 * pass is skipped when that works out to zero. So a small bankroll genuinely cannot trade, which is
 * what "ruin" means here — not a balance of zero, but a balance too small to buy one contract.
 *
 * ── the regime knob ──
 *
 * The replay's hit rate is 84%; live is running 76%. Nobody knows which is the truth, so both are
 * simulated: `--degrade` flips the required fraction of wins into losses at random to model a worse
 * regime, which is the only honest way to ask "what if the edge is thinner than the sample says".
 *
 * Run: node research-risk.js            (replay's own outcomes)
 *      node research-risk.js --degrade  (same trades, hit rate knocked down to live's 76%)
 */

const fs = require('fs');
const path = require('path');
const bot = require('./bot');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const MIN_CANDLES = 20;
const FEE_COEF = 0.07;
const CAP = 0.80;



const fee = (price, contracts) =>
  Math.ceil(FEE_COEF * contracts * price * (1 - price) * 100) / 100;
const usd = n => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
const pct = n => `${(n * 100).toFixed(1)}%`;

/** Seeded, so a rerun says the same thing. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { sym, rows: j.rows || [], byTime };
}

function closedBefore(byTime, ts, depth) {
  const out = [];
  let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) {
    const c = byTime.get(t);
    if (c) out.push(c);
  }
  return out;
}

/** The live gate exactly: engine >= 85%, 3 of 4 indicators, 25-80c. First qualifying look. */
function firstQualifying(row, byTime) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;

    const spot = candles[0].close;
    const res = bot.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || res.confidence < bot.MIN_CONF) continue;

    const rsi = bot.calcRSI(candles, 14);
    const ema9 = bot.calcEMA(candles, 9);
    const ema20 = bot.calcEMA(candles, 20);
    const bb = bot.calcBollingerBands(candles, 20);
    const vwap = bot.calcVWAP(candles, 20);
    let confirm = 0;
    if (res.side === 'YES') {
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
    if (confirm < bot.MIN_CONFIRM) continue;

    const price = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (!(price >= 0.25 && price <= CAP)) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    // The same DIP/MOVE test src/trader.js:215 makes, on the same five closes.
    const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
    const style = (res.side === 'YES')
      ? (spot < avgClose ? 'DIP' : 'MOVE')
      : (spot > avgClose ? 'DIP' : 'MOVE');
    return { price, won, closeMs: row.closeMs, sym: row.sym, min,
      conf: res.confidence, confirm, style,
      pnl: (won ? bot.SHARES * (1 - price) : -bot.SHARES * price) - fee(price, bot.SHARES) };
  }
  return null;
}

// ── every trade the live gate would have taken, over the whole record ────────────
const trades = [];
let markets = 0;
for (const c of bot.COINS) {
  let ds;
  try { ds = loadCoin(c.sym); } catch (_) { continue; }
  for (const row of ds.rows) {
    markets++;
    const t = firstQualifying({ ...row, sym: c.sym }, ds.byTime);
    if (t) trades.push(t);
  }
}
trades.sort((a, b) => a.closeMs - b.closeMs);

function tally(name, rs) {
  if (!rs.length) return null;
  const w = rs.filter(r => r.won);
  const l = rs.filter(r => !r.won);
  const net = rs.reduce((a, r) => a + r.pnl, 0);
  const aw = w.length ? w.reduce((a, r) => a + r.pnl, 0) / w.length : 0;
  const al = l.length ? Math.abs(l.reduce((a, r) => a + r.pnl, 0) / l.length) : 0;
  const be = (aw + al) ? al / (aw + al) : 0;
  const hit = w.length / rs.length;
  console.log(`  ${name.padEnd(22)} n=${String(rs.length).padStart(4)}  hit ${pct(hit).padStart(6)}  ` +
    `net ${usd(net).padStart(10)}  ${usd(net / rs.length).padStart(8)}/trade  ` +
    `needs ${pct(be).padStart(6)}  margin ${((hit - be) * 100).toFixed(1).padStart(6)}pp`);
  return { n: rs.length, hit, net, per: net / rs.length, be };
}

const d = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log('');
console.log('='.repeat(104));
console.log(`  WHY IS IT LOSING — ${trades.length} trades the live gate would have taken, from ${markets} markets`);
console.log(`  ${d(trades[0].closeMs)} .. ${d(trades[trades.length - 1].closeMs)} · 30 contracts · hold to settlement`);
console.log('='.repeat(104));

console.log('\n  BASELINE');
tally('all trades', trades);

console.log('\n  1) DIP vs MOVE — live, almost every trade read "chased a move"');
tally('bought a dip', trades.filter(t => t.style === 'DIP'));
tally('chased a move', trades.filter(t => t.style === 'MOVE'));

console.log('\n  2) INDICATOR AGREEMENT — live, 4/4 lost more than 3/4');
tally('3 of 4 agreed', trades.filter(t => t.confirm === 3));
tally('4 of 4 agreed', trades.filter(t => t.confirm === 4));

console.log('\n  3) HAS THE EDGE DECAYED? chronological quarters');
const q4 = Math.ceil(trades.length / 4);
for (let i = 0; i < 4; i++) {
  const chunk = trades.slice(i * q4, (i + 1) * q4);
  if (chunk.length) tally(`Q${i + 1} ${d(chunk[0].closeMs)}`, chunk);
}

console.log('\n  4) PRICE PAID — live, 72-78c was 77% of the damage');
for (const [lo, hi] of [[0.25, 0.65], [0.65, 0.72], [0.72, 0.78], [0.78, 0.81]]) {
  tally(`${Math.round(lo * 100)}-${Math.round(hi * 100)}c`, trades.filter(t => t.price >= lo && t.price < hi));
}

console.log('\n  5) THE CROSS: style x agreement — where the money actually is');
for (const st of ['DIP', 'MOVE']) {
  for (const cf of [3, 4]) {
    tally(`${st} + ${cf}/4`, trades.filter(t => t.style === st && t.confirm === cf));
  }
}

console.log('\n  6) MINUTES LEFT AT ENTRY');
for (const [lo, hi] of [[4, 6], [6, 9], [9, 12], [12, 14]]) {
  tally(`${lo}-${hi} min out`, trades.filter(t => t.min >= lo && t.min < hi));
}
console.log('');
