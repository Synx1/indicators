#!/usr/bin/env node
/**
 * What each risk-per-trade setting actually does to a real bankroll.
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

const START = Number(process.env.START || 30.64);
const RUNS = Number(process.env.RUNS || 2000);
const DEGRADE = process.argv.includes('--degrade');
const TARGET_HIT = 0.76;

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
    return { price, won, closeMs: row.closeMs, sym: row.sym };
  }
  return null;
}

// ── the trade sequence, built once from the live gate ───────────
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

const rawHit = trades.filter(t => t.won).length / trades.length;

/**
 * Optionally knock the hit rate down to what live is actually doing, by flipping wins to losses at
 * random. It is a blunt instrument — it assumes the extra losses are spread evenly rather than
 * clustered in some band — but it answers the question that matters: does this setting survive a
 * regime 8 points worse than the sample?
 */
function applyRegime(list, rand) {
  if (!DEGRADE) return list;
  const need = Math.max(0, Math.round((rawHit - TARGET_HIT) * list.length));
  const winIdx = list.map((t, i) => (t.won ? i : -1)).filter(i => i >= 0);
  for (let i = winIdx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [winIdx[i], winIdx[j]] = [winIdx[j], winIdx[i]];
  }
  const flip = new Set(winIdx.slice(0, need));
  return list.map((t, i) => (flip.has(i) ? { ...t, won: false } : t));
}

/** One bankroll path. Sizing is src/trader.js's, to the contract. */
function walk(seq, risk) {
  let bank = START;
  let peak = START;
  let maxDd = 0;
  let taken = 0;
  let skippedBroke = 0;
  for (const t of seq) {
    const shares = Math.floor((bank * risk) / CAP);
    if (shares < 1) { skippedBroke++; continue; }
    const cost = shares * t.price;
    if (cost > bank) { skippedBroke++; continue; }
    const f = fee(t.price, shares);
    bank += (t.won ? shares * (1 - t.price) : -cost) - f;
    taken++;
    if (bank > peak) peak = bank;
    const dd = (peak - bank) / peak;
    if (dd > maxDd) maxDd = dd;
    if (bank < CAP) break;                 // cannot buy a single contract again
  }
  return { bank, maxDd, taken, skippedBroke, ruined: bank < CAP };
}

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const q = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
};

console.log('');
console.log('='.repeat(96));
console.log(`  WHAT RISK-PER-TRADE DOES TO $${START.toFixed(2)}`);
console.log(`  ${trades.length} qualifying trades from ${markets} markets · live gate (85% conf, 3/4, 25-80c) · hold to settlement`);
console.log(`  sample hit rate ${pct(rawHit)}${DEGRADE ? `  ->  DEGRADED to ${pct(TARGET_HIT)} to model the live regime` : ''}`);
console.log(`  ${RUNS} reshuffles per setting, because the ORDER of the same trades changes the outcome`);
console.log('='.repeat(96));
console.log('');
console.log('  risk   median end    5th pct      95th pct   median maxDD   ruined   trades taken');

for (const risk of [0.05, 0.10, 0.15, 0.20, 0.25, 0.33, 0.50]) {
  const ends = [], dds = [], takens = [];
  let ruins = 0;
  for (let r = 0; r < RUNS; r++) {
    const rand = rng(1000 + r * 7919);
    const seq = shuffled(applyRegime(trades, rand), rand);
    const out = walk(seq, risk);
    ends.push(out.bank); dds.push(out.maxDd); takens.push(out.taken);
    if (out.ruined) ruins++;
  }
  console.log(
    `  ${String(Math.round(risk * 100)).padStart(3)}%  ${usd(q(ends, 0.5)).padStart(11)}  ` +
    `${usd(q(ends, 0.05)).padStart(11)}  ${usd(q(ends, 0.95)).padStart(12)}  ` +
    `${pct(q(dds, 0.5)).padStart(12)}  ${pct(ruins / RUNS).padStart(7)}  ` +
    `${String(Math.round(q(takens, 0.5))).padStart(9)}`);
}

// The one real sample: the trades in the order they actually happened.
console.log('\n  and in the ACTUAL chronological order (one sample, not a distribution):');
for (const risk of [0.05, 0.10, 0.25]) {
  const out = walk(applyRegime(trades, rng(1)), risk);
  console.log(`  ${String(Math.round(risk * 100)).padStart(3)}%  ends ${usd(out.bank).padStart(11)}   ` +
    `worst drawdown ${pct(out.maxDd)}   ${out.taken} trades taken` +
    (out.ruined ? '   RUINED' : ''));
}
console.log('');
