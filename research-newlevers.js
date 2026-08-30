#!/usr/bin/env node
/**
 * THROWAWAY SPIKE (2026-08-30) — measures three "higher success rate" levers on the
 * CURRENT live gate, not the legacy bot.js 85/80c one the other harnesses print.
 *
 *   1. Calibration      — does stated confidence match realized win rate?
 *   2. Dip vs momentum  — the competitor's new v2.2 filter; we already log `style`.
 *   3. Per-coin         — which symbols carry the edge, which bleed it.
 *
 * Gate reproduced from src/trader.js as of this date (MIN_CONF 80, 3/4 confirm,
 * 25-65c band, 8<ml<14 window). Engine + indicators imported from src/decide.js so
 * this cannot compute a different number than production. Hold-to-settlement only
 * (the live default; cashoutAt is an off-by-default per-user setting).
 *
 * LEAKAGE: identical discipline to replay.js/gridsearch.js — the decision sees only
 * candles that CLOSED strictly before the entry minute; settlement is read only to
 * grade a position already opened.
 *
 * Not wired into anything. `node research-newlevers.js`. Delete when done.
 */

const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';

// ── the LIVE gate, copied from src/trader.js (source of truth) ──
const MIN_CONF = 80;
const MIN_CONFIRM = 3;
const MIN_PRICE = 0.25;
const MAX_PRICE = 0.65;
const ENTRY_SCAN = [13, 12, 11, 10, 9];   // 8 < minutesLeft < 14, earliest look first
const MIN_CANDLES = 20;
const SHARES = 30;
const FEE_COEF = 0.07;

// Live coins only (data dir also carries NEAR/ZEC the bot does not trade).
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

const fee = (price, n) => Math.ceil(FEE_COEF * n * price * (1 - price) * 100) / 100;

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

/** First qualifying entry for one market, or null. Mirrors trader.decideFor(). */
function decideEntry(row, byTime) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;

    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;

    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || res.confidence < MIN_CONF) continue;

    const rsi = decide.calcRSI(candles, 14);
    const ema9 = decide.calcEMA(candles, 9);
    const ema20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20);
    const vwap = decide.calcVWAP(candles, 20);
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
    if (confirm < MIN_CONFIRM) continue;

    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < MIN_PRICE || entryPrice > MAX_PRICE) continue;

    // style, exactly as src/trader.js records it
    const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
    const style = (res.side === 'YES')
      ? (spot < avgClose ? 'DIP' : 'MOVE')
      : (spot > avgClose ? 'DIP' : 'MOVE');

    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    const pnl = (won ? SHARES * (1 - entryPrice) : -SHARES * entryPrice) - fee(entryPrice, SHARES);
    return { min, side: res.side, entryPrice, confidence: res.confidence, style, won, pnl, closeMs: row.closeMs };
  }
  return null;
}

function summarize(ts) {
  const w = ts.filter(t => t.won);
  const pnl = ts.reduce((a, t) => a + t.pnl, 0);
  const avgEntry = ts.length ? ts.reduce((a, t) => a + t.entryPrice, 0) / ts.length : 0;
  const winRate = ts.length ? w.length / ts.length : 0;
  return { n: ts.length, wins: w.length, winRate, pnl, per: ts.length ? pnl / ts.length : 0,
    avgEntry, margin: winRate - avgEntry };
}

const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
const half = ts => {
  const c = ts.slice().sort((a, b) => a.closeMs - b.closeMs);
  const m = Math.floor(c.length / 2);
  return [summarize(c.slice(0, m)), summarize(c.slice(m))];
};

// ── build entries ──
const entries = [];
let scanned = 0;
for (const sym of COINS) {
  let ds;
  try { ds = loadCoin(sym); } catch (e) { console.log(`  (no data ${sym})`); continue; }
  for (const row of ds.rows) {
    scanned++;
    const e = decideEntry(row, ds.byTime);
    if (e) entries.push({ ...e, sym });
  }
}

const base = summarize(entries);
console.log('\n  NEW-LEVERS SPIKE — live gate (conf>=80, 3/4, 25-65c, 8<ml<14), hold to settlement');
console.log(`  data: ${DATA_DIR}`);
console.log(`  markets scanned: ${scanned}   entries: ${base.n} (${pct(base.n / scanned)})`);
console.log('  ' + '─'.repeat(78));
console.log(`  BASELINE: ${usd(base.pnl)} | win ${pct(base.winRate)} | ${usd(base.per)}/trade | ` +
  `avg entry ${pct(base.avgEntry)} | margin ${(base.margin * 100).toFixed(1)}pp`);
const [bh1, bh2] = half(entries);
console.log(`  halves:   first ${usd(bh1.pnl)} win ${pct(bh1.winRate)} | second ${usd(bh2.pnl)} win ${pct(bh2.winRate)}` +
  `  => ${bh1.pnl > 0 && bh2.pnl > 0 ? 'BOTH positive' : 'NOT both positive — fragile'}`);

// 1 ── calibration
console.log('\n  1) CALIBRATION — stated confidence vs realized win rate (does 80% mean 80%?)');
console.log('     conf-band    n    stated(mid)   realized-win%   gap        $/trade   margin');
for (const [lo, hi] of [[80, 82], [83, 85], [86, 89], [90, 94], [95, 100]]) {
  const sub = entries.filter(e => e.confidence >= lo && e.confidence <= hi);
  if (!sub.length) { console.log(`     ${(lo + '-' + hi + '%').padEnd(9)}    0`); continue; }
  const s = summarize(sub);
  const midConf = (lo + hi) / 2 / 100;
  const gap = s.winRate - midConf;
  console.log(`     ${(lo + '-' + hi + '%').padEnd(9)}  ${String(s.n).padStart(4)}   ${pct(midConf).padStart(8)}   ` +
    `${pct(s.winRate).padStart(12)}   ${((gap >= 0 ? '+' : '') + (gap * 100).toFixed(1) + 'pp').padStart(8)}   ` +
    `${usd(s.per).padStart(8)}   ${((s.margin * 100).toFixed(1) + 'pp').padStart(7)}`);
}

// 2 ── dip vs momentum
console.log('\n  2) DIP vs MOMENTUM — the competitor v2.2 filter (we already log style)');
console.log('     style   n     net PnL    win%     $/trade   margin    halves (win% first/second)');
for (const st of ['DIP', 'MOVE']) {
  const sub = entries.filter(e => e.style === st);
  if (!sub.length) { console.log(`     ${st.padEnd(5)}   0`); continue; }
  const s = summarize(sub);
  const [h1, h2] = half(sub);
  console.log(`     ${st.padEnd(5)}  ${String(s.n).padStart(4)}  ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ` +
    `${usd(s.per).padStart(8)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(7)}    ${pct(h1.winRate)} / ${pct(h2.winRate)}`);
}

// 3 ── per coin
console.log('\n  3) PER COIN — which symbols carry the edge, which bleed it');
console.log('     coin   n     net PnL    win%     $/trade   avg entry   margin');
const bySym = {};
for (const e of entries) (bySym[e.sym] ||= []).push(e);
for (const sym of COINS) {
  const sub = bySym[sym] || [];
  if (!sub.length) { console.log(`     ${sym.padEnd(5)}  0`); continue; }
  const s = summarize(sub);
  const flag = s.margin < 0 ? '  <- negative edge' : (s.margin < 0.03 ? '  <- thin' : '');
  console.log(`     ${sym.padEnd(5)}  ${String(s.n).padStart(4)}  ${usd(s.pnl).padStart(9)}  ${pct(s.winRate).padStart(6)}  ` +
    `${usd(s.per).padStart(8)}  ${pct(s.avgEntry).padStart(8)}   ${((s.margin * 100).toFixed(1) + 'pp').padStart(7)}${flag}`);
}
console.log('');
