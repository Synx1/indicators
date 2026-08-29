#!/usr/bin/env node
/**
 * Can it fire more often WITHOUT chasing noise?
 *
 * gridsearch.js cannot answer this, and the reason is subtle enough to be worth stating: it
 * enumerates candidates through bot.js's OWN gate — `confidence < MIN_CONF` and
 * `confirm < MIN_CONFIRM` are dropped before the pool is built. So its "confirm >= 2/4" row is
 * identical to "3/4" not because the dial does nothing, but because no 2-confirm candidate was ever
 * in the pool to be counted. Its price axis also stops AT 80c and only looks downward, which is the
 * wrong direction for this question: 65% of live candidates are currently refused as too dear.
 *
 * So this enumerates LOOSE — every minute where the model produced a side at all, keeping the
 * confidence and confirm count on each candidate — and then sweeps the three gates that could add
 * trades: the price ceiling, the confidence floor, and the confirmation count.
 *
 * ── the rule this exists to respect ──
 *
 * Cumulative sweeps MISLEAD. A cap of 90c reads as "fine at scale" because the profitable 75-80c
 * band is inside it and carries the loss-making 85-90c band on its back. So every config here is
 * also decomposed by entry-price BUCKET, which is the decomposition that reversed this exact
 * decision once before: 85-90c was net negative while 75-80c was the money.
 *
 * A config is only interesting if it adds trades AND keeps a positive edge in both chronological
 * halves. One good half is a coin flip with extra steps.
 *
 * LEAKAGE: identical discipline to gridsearch.js — candidates use candles that closed strictly
 * before the entry minute, and settlement is read only to grade a position already opened.
 *
 * Run: node research-frequency.js
 */

const fs = require('fs');
const path = require('path');
const bot = require('./bot');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const MIN_CANDLES = 20;
const FEE_COEF = 0.07;

/** Enumerate this loosely, so the sweep has something to sweep. */
const POOL_MIN_CONF = 70;
const POOL_MIN_CONFIRM = 1;

const fee = (price, contracts) =>
  Math.ceil(FEE_COEF * contracts * price * (1 - price) * 100) / 100;

const usd = n => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
const pct = n => `${(n * 100).toFixed(1)}%`;

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

function candidates(row, byTime) {
  const out = [];
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;

    const spot = candles[0].close;
    const res = bot.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || res.confidence < POOL_MIN_CONF) continue;

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
    if (confirm < POOL_MIN_CONFIRM) continue;

    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (!(entryPrice > 0) || !(entryPrice < 1)) continue;
    out.push({ min, side: res.side, entryPrice, confidence: res.confidence, confirm });
  }
  return out;
}

/** Hold to settlement, which the live bot's default does. */
function exitOf(row, entry) {
  const shares = bot.SHARES;
  const entryFee = fee(entry.entryPrice, shares);
  const won = (entry.side === 'YES' && row.settledYes) || (entry.side === 'NO' && !row.settledYes);
  return {
    won,
    pnl: (won ? shares * (1 - entry.entryPrice) : -shares * entry.entryPrice) - entryFee
  };
}

function summarize(trades) {
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgW = w.length ? w.reduce((a, t) => a + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? Math.abs(l.reduce((a, t) => a + t.pnl, 0) / l.length) : 0;
  return {
    n: trades.length, pnl, wins: w.length,
    winRate: trades.length ? w.length / trades.length : 0,
    avgW, avgL,
    be: (avgW + avgL) ? avgL / (avgW + avgL) : 0,
    per: trades.length ? pnl / trades.length : 0
  };
}

function halves(trades) {
  const s = trades.slice().sort((a, b) => a.closeMs - b.closeMs);
  const mid = Math.floor(s.length / 2);
  return [summarize(s.slice(0, mid)), summarize(s.slice(mid))];
}

// ── the pool, built once ────────────────────────────────────────
const pool = [];
let markets = 0;
for (const c of bot.COINS) {
  let ds;
  try { ds = loadCoin(c.sym); } catch (_) { console.log(`  (no data for ${c.sym})`); continue; }
  for (const row of ds.rows) {
    markets++;
    const cands = candidates(row, ds.byTime);
    if (cands.length) pool.push({ sym: c.sym, row, cands });
  }
}

/** First candidate that clears the config — the same "first qualifying look" the live bot takes. */
function run(cfg) {
  const trades = [];
  for (const p of pool) {
    const hit = p.cands.find(c =>
      c.entryPrice >= cfg.minPrice && c.entryPrice <= cfg.maxPrice &&
      c.confidence >= cfg.minConf && c.confirm >= cfg.minConfirm);
    if (!hit) continue;
    trades.push({
      ...exitOf(p.row, hit), sym: p.sym, price: hit.entryPrice,
      conf: hit.confidence, confirm: hit.confirm, closeMs: p.row.closeMs
    });
  }
  return trades;
}

const LIVE = { minPrice: 0.25, maxPrice: 0.80, minConf: 85, minConfirm: 3 };

console.log('');
console.log('='.repeat(94));
console.log(`  MORE SETUPS WITHOUT MORE NOISE — ${markets} markets, ${pool.length} with a candidate`);
console.log(`  pool enumerated at conf >= ${POOL_MIN_CONF}%, confirm >= ${POOL_MIN_CONFIRM}/4 (deliberately looser than live)`);
console.log('='.repeat(94));

const base = summarize(run(LIVE));
const [bh1, bh2] = halves(run(LIVE));
console.log(`\n  LIVE CONFIG  cap ${LIVE.maxPrice * 100}c · conf >= ${LIVE.minConf}% · confirm >= ${LIVE.minConfirm}/4`);
console.log(`    ${base.n} trades   ${usd(base.pnl)}   ${usd(base.per)}/trade   win ${pct(base.winRate)}   ` +
  `needs ${pct(base.be)}   margin ${((base.winRate - base.be) * 100).toFixed(1)}pp`);
console.log(`    halves: ${usd(bh1.per)}/trade (n=${bh1.n})  and  ${usd(bh2.per)}/trade (n=${bh2.n})`);

const header = () => console.log(
  '\n  config                          n    net PnL    $/trade    win%    needs   margin   ' +
  'h1 $/t   h2 $/t   both+');
const line = (label, cfg) => {
  const t = run(cfg);
  const s = summarize(t);
  const [h1, h2] = halves(t);
  const both = h1.per > 0 && h2.per > 0;
  console.log(
    `  ${label.padEnd(30)} ${String(s.n).padStart(4)} ${usd(s.pnl).padStart(10)} ` +
    `${usd(s.per).padStart(9)} ${pct(s.winRate).padStart(7)} ${pct(s.be).padStart(7)} ` +
    `${((s.winRate - s.be) * 100).toFixed(1).padStart(6)}pp ${usd(h1.per).padStart(8)} ` +
    `${usd(h2.per).padStart(8)}   ${both ? 'yes' : 'NO'}`);
  return { label, cfg, s, h1, h2, both };
};

const results = [];

// ── 1. the price ceiling, upward — the direction gridsearch never looked ──
console.log('\n  1) PRICE CEILING (everything else live)');
header();
for (const cap of [0.80, 0.82, 0.85, 0.88, 0.90, 0.95]) {
  results.push(line(`cap ${Math.round(cap * 100)}c`, { ...LIVE, maxPrice: cap }));
}

// ── 2. the confidence floor, downward ──
console.log('\n  2) CONFIDENCE FLOOR (cap stays 80c)');
header();
for (const mc of [85, 83, 82, 80, 78, 75]) {
  results.push(line(`conf >= ${mc}%`, { ...LIVE, minConf: mc }));
}

// ── 3. how many indicators must agree ──
console.log('\n  3) CONFIRMATIONS (cap 80c, conf 85%) — now measurable, because the pool keeps 1s and 2s');
header();
for (const cf of [4, 3, 2, 1]) {
  results.push(line(`confirm >= ${cf}/4`, { ...LIVE, minConfirm: cf }));
}

// ── 4. the two loosenings together, since each alone may look tame ──
console.log('\n  4) JOINT — a looser floor AND a higher ceiling');
header();
for (const cap of [0.80, 0.85, 0.90]) {
  for (const mc of [85, 82, 80]) {
    if (cap === 0.80 && mc === 85) continue;
    results.push(line(`cap ${Math.round(cap * 100)}c · conf ${mc}%`, { ...LIVE, maxPrice: cap, minConf: mc }));
  }
}

// ── 5. where the money actually is, by entry price ──
//
// The decomposition that reversed this decision once already. A cumulative cap looks fine while it
// carries a loss-making band on the back of a profitable one.
console.log('\n  5) BY ENTRY-PRICE BUCKET — the same 95c-cap pool, split by what was paid');
const wide = run({ ...LIVE, maxPrice: 0.95, minConf: 75, minConfirm: 2 });
const BUCKETS = [[0.25, 0.55], [0.55, 0.65], [0.65, 0.70], [0.70, 0.75], [0.75, 0.80],
  [0.80, 0.85], [0.85, 0.90], [0.90, 0.96]];
console.log('     band        n    net PnL    $/trade    win%    needs   margin');
for (const [lo, hi] of BUCKETS) {
  const t = wide.filter(x => x.price >= lo && x.price < hi);
  if (!t.length) continue;
  const s = summarize(t);
  console.log(`     ${Math.round(lo * 100)}-${Math.round(hi * 100)}c ` +
    `${String(s.n).padStart(6)} ${usd(s.pnl).padStart(10)} ${usd(s.per).padStart(9)} ` +
    `${pct(s.winRate).padStart(7)} ${pct(s.be).padStart(7)} ` +
    `${((s.winRate - s.be) * 100).toFixed(1).padStart(6)}pp`);
}

// ── 6. and by confidence, for the same reason ──
console.log('\n  6) BY CONFIDENCE BUCKET — is a looser floor buying good trades or bad ones?');
console.log('     band        n    net PnL    $/trade    win%    needs   margin');
for (const [lo, hi] of [[75, 80], [80, 83], [83, 85], [85, 90], [90, 95], [95, 101]]) {
  const t = wide.filter(x => x.conf >= lo && x.conf < hi);
  if (!t.length) continue;
  const s = summarize(t);
  console.log(`     ${lo}-${hi}%${String(s.n).padStart(7)} ${usd(s.pnl).padStart(10)} ` +
    `${usd(s.per).padStart(9)} ${pct(s.winRate).padStart(7)} ${pct(s.be).padStart(7)} ` +
    `${((s.winRate - s.be) * 100).toFixed(1).padStart(6)}pp`);
}

// ── 7. the price decomposition that actually answers the ceiling question ──
//
// Section 5 mixed two loosenings at once: its pool was conf >= 75, so its "75-80c" band is full of
// 75-80% confidence trades and the price bands wear the blame for a confidence problem. Holding the
// live floor and varying ONLY what was paid is the honest version.
console.log('\n  7) BY ENTRY PRICE, AT THE LIVE CONFIDENCE FLOOR (conf >= 85%, confirm >= 3/4)');
const cleanPool = run({ ...LIVE, maxPrice: 0.99 });
console.log('     band        n    net PnL    $/trade    win%    needs   margin   verdict');
for (const [lo, hi] of BUCKETS.concat([[0.96, 1.0]])) {
  const t = cleanPool.filter(x => x.price >= lo && x.price < hi);
  if (!t.length) continue;
  const s = summarize(t);
  const m = (s.winRate - s.be) * 100;
  console.log(`     ${Math.round(lo * 100)}-${Math.round(hi * 100)}c ` +
    `${String(s.n).padStart(6)} ${usd(s.pnl).padStart(10)} ${usd(s.per).padStart(9)} ` +
    `${pct(s.winRate).padStart(7)} ${pct(s.be).padStart(7)} ${m.toFixed(1).padStart(6)}pp   ` +
    `${s.per > 0.3 ? 'money' : s.per > 0 ? 'thin' : 'LOSES'}`);
}

// ── 8. and by confidence at the live ceiling, the same way ──
console.log('\n  8) BY CONFIDENCE, AT THE LIVE PRICE CEILING (cap 80c, confirm >= 3/4)');
const cleanConf = run({ ...LIVE, minConf: 70 });
console.log('     band        n    net PnL    $/trade    win%    needs   margin   verdict');
for (const [lo, hi] of [[70, 75], [75, 80], [80, 82], [82, 83], [83, 85], [85, 90], [90, 101]]) {
  const t = cleanConf.filter(x => x.conf >= lo && x.conf < hi);
  if (!t.length) continue;
  const s = summarize(t);
  const m = (s.winRate - s.be) * 100;
  console.log(`     ${lo}-${hi}%${String(s.n).padStart(7)} ${usd(s.pnl).padStart(10)} ` +
    `${usd(s.per).padStart(9)} ${pct(s.winRate).padStart(7)} ${pct(s.be).padStart(7)} ` +
    `${m.toFixed(1).padStart(6)}pp   ${s.per > 0.3 ? 'money' : s.per > 0 ? 'thin' : 'LOSES'}`);
}

// ── the verdict ──
console.log('\n  ' + '='.repeat(92));
const better = results.filter(r => r.s.n > base.n && r.both && r.s.per > 0)
  .sort((a, b) => (b.s.pnl - base.pnl) - (a.s.pnl - base.pnl));
if (!better.length) {
  console.log('  NOTHING in this sweep adds trades while keeping a positive edge in BOTH halves.');
  console.log('  The live gate is the frequency ceiling on this data, not a conservatism to relax.');
} else {
  console.log('  Configs that add trades AND stay positive in both halves, best total first:');
  for (const r of better.slice(0, 8)) {
    console.log(`    ${r.label.padEnd(28)} +${r.s.n - base.n} trades   ` +
      `total ${usd(r.s.pnl)} (${usd(r.s.pnl - base.pnl)} vs live)   ${usd(r.s.per)}/trade`);
  }
}
console.log('  ' + '='.repeat(92) + '\n');
