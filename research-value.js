#!/usr/bin/env node
/**
 * THE VALUE QUADRANT: cheap contracts, moderate confidence.
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

function stats(trades) {
  const w = trades.filter(t => t.won), l = trades.filter(t => !t.won);
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const aw = w.length ? w.reduce((a, t) => a + t.pnl, 0) / w.length : 0;
  const al = l.length ? Math.abs(l.reduce((a, t) => a + t.pnl, 0) / l.length) : 0;
  return { n: trades.length, hit: trades.length ? w.length / trades.length : 0, net,
    per: trades.length ? net / trades.length : 0, aw, al, avgPrice: trades.length ? trades.reduce((a,t)=>a+t.price,0)/trades.length : 0,
    be: (aw + al) ? al / (aw + al) : 0 };
}
function run2(cfg) {
  const out = [];
  for (const p of pool) {
    const hit = p.cands.find(c =>
      c.entryPrice >= cfg.minPrice && c.entryPrice <= cfg.maxPrice &&
      c.confidence >= cfg.minConf && c.confirm >= cfg.minConfirm);
    if (!hit) continue;
    const e = exitOf(p.row, hit);
    out.push({ ...e, price: hit.entryPrice, conf: hit.confidence, closeMs: p.row.closeMs, sym: p.sym });
  }
  return out;
}
function halves2(ts) {
  const s = ts.slice().sort((a, b) => a.closeMs - b.closeMs);
  const m = Math.floor(s.length / 2);
  return [stats(s.slice(0, m)), stats(s.slice(m))];
}
const line2 = (label, cfg) => {
  const t = run2(cfg);
  const s = stats(t);
  const [h1, h2] = halves2(t);
  const both = h1.per > 0 && h2.per > 0;
  console.log(`  ${label.padEnd(22)} n=${String(s.n).padStart(4)}  hit ${pct(s.hit).padStart(6)}  ` +
    `avg entry ${(s.avgPrice*100).toFixed(0).padStart(3)}c  net ${usd(s.net).padStart(10)}  ` +
    `${usd(s.per).padStart(8)}/t  needs ${pct(s.be).padStart(6)}  ` +
    `margin ${((s.hit - s.be) * 100).toFixed(1).padStart(6)}pp  both+ ${both ? 'yes' : 'NO '}`);
  return { label, s, both };
};

console.log('');
console.log('='.repeat(122));
console.log('  THE VALUE QUADRANT — cheap contracts at moderate confidence, which is what the competitor');
console.log('  visibly trades (entries at 51-62c). The live gate reaches this region almost never.');
console.log('='.repeat(122));

console.log('\n  THE LIVE GATE, for reference');
line2('live 25-80c conf85', LIVE);

console.log('\n  1) CAP THE ENTRY PRICE LOW, keep the 85% floor');
for (const cap of [0.55, 0.60, 0.65, 0.70, 0.75]) {
  line2(`<=${Math.round(cap*100)}c conf85`, { ...LIVE, maxPrice: cap });
}

console.log('\n  2) CHEAP *AND* LOOSER — the quadrant the gate is designed to avoid');
const results = [];
for (const cap of [0.55, 0.60, 0.65, 0.70]) {
  for (const mc of [70, 75, 78, 80, 83]) {
    results.push(line2(`<=${Math.round(cap*100)}c conf${mc}`, { ...LIVE, maxPrice: cap, minConf: mc }));
  }
  console.log('');
}

console.log('  3) and with only 2 of 4 indicators, since a cheap contract needs less agreement');
for (const cap of [0.60, 0.65]) {
  for (const mc of [75, 80]) {
    results.push(line2(`<=${Math.round(cap*100)}c conf${mc} 2/4`, { ...LIVE, maxPrice: cap, minConf: mc, minConfirm: 2 }));
  }
}

console.log('\n  ' + '='.repeat(120));
const base = stats(run2(LIVE));
const good = results.filter(r => r.both && r.s.n >= 40 && r.s.per > 0)
  .sort((a, b) => (b.s.hit - b.s.be) - (a.s.hit - a.s.be));
console.log('  Configs with n>=40, positive in both halves, ranked by MARGIN over break-even:');
for (const r of good.slice(0, 8)) {
  console.log(`    ${r.label.padEnd(22)} ${((r.s.hit - r.s.be)*100).toFixed(1).padStart(5)}pp   ` +
    `${usd(r.s.per)}/t   n=${r.s.n}   avg entry ${(r.s.avgPrice*100).toFixed(0)}c   total ${usd(r.s.net)}`);
}
console.log(`\n  (the live gate: ${((base.hit-base.be)*100).toFixed(1)}pp margin, ${usd(base.per)}/t, n=${base.n}, avg entry ${(base.avgPrice*100).toFixed(0)}c)`);
console.log('');
