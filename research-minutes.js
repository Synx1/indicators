#!/usr/bin/env node
/**
 * WHERE TO CASH OUT, at cheap entries versus expensive ones.
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
let GATE_CONF = 85;
let GATE_CAP = 0.80;



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
    if (!res.side || res.confidence < GATE_CONF) continue;

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
    if (confirm < 3) continue;

    const price = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (!(price >= 0.25 && price <= GATE_CAP)) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    // The same DIP/MOVE test src/trader.js:215 makes, on the same five closes.
    const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
    const style = (res.side === 'YES')
      ? (spot < avgClose ? 'DIP' : 'MOVE')
      : (spot > avgClose ? 'DIP' : 'MOVE');
    return { price, won, closeMs: row.closeMs, sym: row.sym, min, side: res.side,
      conf: res.confidence, confirm, style, row };
  }
  return null;
}

const SHARES = bot.SHARES;

function build() {
  const out = [];
  for (const c of bot.COINS) {
    let ds;
    try { ds = loadCoin(c.sym); } catch (_) { continue; }
    for (const row of ds.rows) {
      const t = firstQualifying({ ...row, sym: c.sym }, ds.byTime);
      if (t) out.push(t);
    }
  }
  return out.sort((a, b) => a.closeMs - b.closeMs);
}

/** Whichever of tp / settlement comes first in time, the way a polling bot would meet it. */
function grade(e, tp) {
  const entryFee = fee(e.price, SHARES);
  if (tp != null) {
    for (let min = e.min - 1; min >= 0; min--) {
      const q = e.row.entries[String(min)] || e.row.entries[min];
      if (!q || !(q.bid >= 0) || !(q.ask > 0)) continue;
      const sell = e.side === 'YES' ? q.bid : (1 - q.ask);
      if (!(sell > 0) || !(sell < 1)) continue;
      if (sell >= tp) {
        return { pnl: SHARES * (sell - e.price) - entryFee - fee(sell, SHARES), exit: 'tp', sell };
      }
    }
  }
  return { pnl: (e.won ? SHARES * (1 - e.price) : -SHARES * e.price) - entryFee,
    exit: e.won ? 'win' : 'loss' };
}

function report(title, minLeft = 0) {
  const es = build().filter(e => e.min >= minLeft);
  const avgEntry = es.reduce((a, e) => a + e.price, 0) / es.length;
  console.log(`\n  ${title}  —  n=${es.length}, average entry ${(avgEntry * 100).toFixed(0)}c`);
  console.log('    exit policy      net        $/trade   cashouts   held to settle   avg cashout');
  for (const tp of [null, 0.99, 0.97, 0.95, 0.92, 0.90, 0.85]) {
    const gs = es.map(e => grade(e, tp));
    const net = gs.reduce((a, g) => a + g.pnl, 0);
    const cash = gs.filter(g => g.exit === 'tp');
    const avgSell = cash.length ? cash.reduce((a, g) => a + g.sell, 0) / cash.length : 0;
    console.log(`    ${(tp == null ? 'hold' : `cash at ${Math.round(tp * 100)}c`).padEnd(15)} ` +
      `${usd(net).padStart(10)}  ${usd(net / es.length).padStart(9)}   ` +
      `${String(cash.length).padStart(8)}   ${String(es.length - cash.length).padStart(14)}   ` +
      `${cash.length ? (avgSell * 100).toFixed(1) + 'c' : '—'}`);
  }
}


function summary(title, minLeft) {
  const es = build().filter(e => e.min >= minLeft);
  const gs = es.map(e => grade(e, null));
  const w = gs.filter(g => g.pnl > 0), l = gs.filter(g => g.pnl <= 0);
  const net = gs.reduce((a, g) => a + g.pnl, 0);
  const aw = w.length ? w.reduce((a, g) => a + g.pnl, 0) / w.length : 0;
  const al = l.length ? Math.abs(l.reduce((a, g) => a + g.pnl, 0) / l.length) : 0;
  const be = (aw + al) ? al / (aw + al) : 0;
  const hit = w.length / gs.length;
  const s2 = es.slice().sort((a, b) => a.closeMs - b.closeMs);
  const mid = Math.floor(s2.length / 2);
  const half = arr => { const g = arr.map(e => grade(e, null)); return g.reduce((a, x) => a + x.pnl, 0) / (g.length || 1); };
  const h1 = half(s2.slice(0, mid)), h2 = half(s2.slice(mid));
  console.log(`  ${title.padEnd(30)} n=${String(es.length).padStart(4)}  hit ${pct(hit).padStart(6)}  ` +
    `net ${usd(net).padStart(10)}  ${usd(net / es.length).padStart(8)}/t  needs ${pct(be).padStart(6)}  ` +
    `margin ${((hit - be) * 100).toFixed(1).padStart(6)}pp   halves ${usd(h1)} / ${usd(h2)}  ` +
    `${h1 > 0 && h2 > 0 ? 'both+' : 'NOT both+'}`);
}

console.log('');
console.log('='.repeat(126));
console.log('  DOES THE 9-MINUTE RULE STILL HELP ON THE NEW CHEAP BAND?  (hold to settlement throughout)');
console.log('='.repeat(126));

GATE_CONF = 85; GATE_CAP = 0.80;
console.log('\n  the OLD band (25-80c, conf 85) — where the 9-minute rule was first measured');
summary('all minutes', 0);
summary('9+ minutes left', 9);
summary('10+ minutes left', 10);

GATE_CONF = 80; GATE_CAP = 0.65;
console.log('\n  the NEW band (25-65c, conf 80) — what is actually running now');
summary('all minutes', 0);
summary('8+ minutes left', 8);
summary('9+ minutes left', 9);
summary('10+ minutes left', 10);
summary('11+ minutes left', 11);
console.log('');
