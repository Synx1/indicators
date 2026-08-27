#!/usr/bin/env node
/**
 * Grid search over the entry gate, run against the collected market history.
 *
 * WHY THIS EXISTS
 * The live bot went $100 -> $301 -> $14.75 over 135 trades. The autopsy of those
 * trades says the payoff geometry is broken: avg win +$7.36 vs avg loss -$20.29
 * needs a 73.4% win rate and the bot delivers 71.1%. 48% of its fills land in
 * 75-80c, a band that needs ~81% and delivers 75%. But 135 trades is far too few
 * to retune on — that is exactly how the last config got picked. So every
 * candidate fix is scored here, over ~1800 settled markets, before anything ships.
 *
 * DESIGN
 * Candidate minutes are enumerated ONCE per market (every minute in the live
 * scan window where the engine fires and >=2 indicators confirm, with the fill
 * price it would have paid). A config then just filters that list and takes the
 * first survivor — identical to what the live bot's first-qualifying-look does,
 * but without recomputing indicators per config, so a 100-cell grid is seconds
 * rather than hours.
 *
 * LEAKAGE: candidate enumeration uses bot.js's own functions on candles that
 * closed strictly before the entry minute. Settlement is read only to grade a
 * position that was already opened. Same discipline as replay.js.
 */

const fs = require('fs');
const path = require('path');
const bot = require('./bot');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
const MIN_CANDLES = 20;
const FEE_COEF = 0.07;

function fee(price, contracts) {
  return Math.ceil(FEE_COEF * contracts * price * (1 - price) * 100) / 100;
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

/** Every minute this market would have offered a signal, with its fill price. */
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

    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (!(entryPrice > 0) || !(entryPrice < 1)) continue;
    out.push({ min, side: res.side, entryPrice, confidence: res.confidence,
      z: Math.abs(parseFloat(res.z)), confirm });
  }
  return out;
}

/** Grade a fixed entry: cash out at tp, else hold to settlement. */
function exitOf(row, entry, tp) {
  const shares = bot.SHARES;
  const entryFee = fee(entry.entryPrice, shares);
  for (let min = entry.min - 1; min >= 0; min--) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.bid >= 0) || !(q.ask > 0)) continue;
    const sell = entry.side === 'YES' ? q.bid : (1 - q.ask);
    if (sell >= tp) {
      return { exit: 'cashout', pnl: shares * (sell - entry.entryPrice) - entryFee - fee(sell, shares) };
    }
  }
  const won = (entry.side === 'YES' && row.settledYes) || (entry.side === 'NO' && !row.settledYes);
  return { exit: won ? 'settle-win' : 'settle-loss',
    pnl: (won ? shares * (1 - entry.entryPrice) : -shares * entry.entryPrice) - entryFee };
}

function summarize(trades) {
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgW = w.length ? w.reduce((a, t) => a + t.pnl, 0) / w.length : 0;
  const avgL = l.length ? Math.abs(l.reduce((a, t) => a + t.pnl, 0) / l.length) : 0;
  return { n: trades.length, pnl, wins: w.length, losses: l.length,
    winRate: trades.length ? w.length / trades.length : 0,
    avgW, avgL, be: (avgW + avgL) ? avgL / (avgW + avgL) : 0,
    per: trades.length ? pnl / trades.length : 0 };
}

// ── build the candidate pool once ───────────────────────────
const pool = [];   // { sym, row, cands[] }
let scanned = 0;
for (const c of bot.COINS) {
  let ds;
  try { ds = loadCoin(c.sym); } catch (e) { console.log(`  (no data ${c.sym})`); continue; }
  for (const row of ds.rows) {
    scanned++;
    const cands = candidates(row, ds.byTime);
    if (cands.length) pool.push({ sym: c.sym, row, cands });
  }
}

/** Apply a config to the pool: first candidate that passes every filter. */
function run(cfg) {
  const trades = [];
  for (const p of pool) {
    const hit = p.cands.find(c =>
      c.entryPrice >= cfg.minPrice && c.entryPrice <= cfg.maxPrice &&
      c.confidence <= cfg.maxConf && c.confidence >= cfg.minConf &&
      c.z <= cfg.maxZ && c.confirm >= cfg.minConfirm);
    if (!hit) continue;
    trades.push({ ...exitOf(p.row, hit, cfg.tp), sym: p.sym, price: hit.entryPrice,
      conf: hit.confidence, closeMs: p.row.closeMs });
  }
  return trades;
}

const BASE = { minPrice: 0.25, maxPrice: 0.80, minConf: 85, maxConf: 100, maxZ: 1e9, minConfirm: bot.MIN_CONFIRM, tp: 0.97 };
const usd = n => (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2);
const pct = n => (n * 100).toFixed(1) + '%';

console.log('');
console.log('  ENTRY-GATE GRID SEARCH');
console.log(`  markets scanned: ${scanned}   markets with >=1 signal: ${pool.length}`);
console.log('  ' + '='.repeat(86));

function line(label, trades) {
  const s = summarize(trades);
  console.log(`  ${label.padEnd(26)} ${String(s.n).padStart(4)}  ${usd(s.pnl).padStart(10)}  ` +
    `${usd(s.per).padStart(8)}  ${pct(s.winRate).padStart(6)}  ${usd(s.avgW).padStart(7)}  ` +
    `${('-$' + s.avgL.toFixed(2)).padStart(8)}  ${pct(s.be).padStart(6)}  ` +
    `${(s.winRate - s.be >= 0 ? '+' : '') + ((s.winRate - s.be) * 100).toFixed(1) + 'pp'}`);
  return s;
}
const HEAD = '  config                     n     net PnL     $/trade    win%    avgWin   avgLoss    b/e   margin';

// 1 ── price cap sweep (the primary suspect)
console.log('\n  1) MAX ENTRY PRICE  — live bot puts 48% of fills in 75-80c\n' + HEAD);
const baseS = line('BASELINE (cap 80c)', run(BASE));
const capRows = [];
for (const cap of [0.75, 0.70, 0.65, 0.60, 0.55, 0.50, 0.45]) {
  capRows.push({ cap, s: line(`cap ${Math.round(cap * 100)}c`, run({ ...BASE, maxPrice: cap })) });
}

// 2 ── confidence ceiling (97-100% is -$112 live at 42% win)
console.log('\n  2) CONFIDENCE CEILING  — extreme conf comes from a collapsed vol estimate\n' + HEAD);
for (const mc of [100, 97, 96, 95, 93, 91]) {
  line(`maxConf ${mc}%`, run({ ...BASE, maxConf: mc }));
}

// 3 ── |z| ceiling, the same artifact measured directly
console.log('\n  3) |z| CEILING\n' + HEAD);
for (const mz of [1e9, 3.0, 2.5, 2.0, 1.5]) {
  line(`maxZ ${mz === 1e9 ? 'none' : mz.toFixed(1)}`, run({ ...BASE, maxZ: mz }));
}

// 4 ── confirmation strictness
console.log('\n  4) INDICATOR CONFIRMATIONS REQUIRED\n' + HEAD);
for (const mc of [2, 3, 4]) line(`confirm >= ${mc}/4`, run({ ...BASE, minConfirm: mc }));

// 5 ── the joint grid: cap x conf-ceiling, since they interact
console.log('\n  5) JOINT GRID  cap x maxConf   (cell = net PnL / n / $per-trade)');
const caps = [0.80, 0.75, 0.70, 0.65, 0.60, 0.55];
const confs = [100, 97, 95, 93];
process.stdout.write('      cap\\conf ');
for (const c of confs) process.stdout.write(String(c + '%').padStart(22));
console.log('');
let best = null;
for (const cap of caps) {
  process.stdout.write(`      ${(Math.round(cap * 100) + 'c').padEnd(9)}`);
  for (const c of confs) {
    const s = summarize(run({ ...BASE, maxPrice: cap, maxConf: c }));
    if (!best || s.pnl > best.s.pnl) best = { cap, conf: c, s };
    process.stdout.write(`${usd(s.pnl)}/${s.n}/${usd(s.per)}`.padStart(22));
  }
  console.log('');
}

// 6 ── take-profit re-swept at the winning cap: cheaper entries change the geometry
console.log(`\n  6) TAKE-PROFIT at cap ${Math.round(best.cap * 100)}c / maxConf ${best.conf}%\n` + HEAD);
let bestTp = null;
for (const tp of [0.99, 0.97, 0.95, 0.92, 0.90, 0.87]) {
  const s = line(`tp ${Math.round(tp * 100)}c`, run({ ...BASE, maxPrice: best.cap, maxConf: best.conf, tp }));
  if (!bestTp || s.pnl > bestTp.s.pnl) bestTp = { tp, s };
}

// 7 ── robustness of the winner: per coin + chronological halves
const WIN = { ...BASE, maxPrice: best.cap, maxConf: best.conf, tp: bestTp.tp };
console.log(`\n  7) ROBUSTNESS of cap ${Math.round(WIN.maxPrice * 100)}c / maxConf ${WIN.maxConf}% / tp ${Math.round(WIN.tp * 100)}c`);
const wt = run(WIN);
console.log('     per coin:');
const bySym = {};
for (const t of wt) (bySym[t.sym] ||= []).push(t);
for (const sym of Object.keys(bySym).sort()) {
  const s = summarize(bySym[sym]);
  console.log(`       ${sym.padEnd(5)} n=${String(s.n).padStart(3)} ${usd(s.pnl).padStart(9)} win ${pct(s.winRate).padStart(6)} per ${usd(s.per)}`);
}
const chron = wt.slice().sort((a, b) => a.closeMs - b.closeMs);
const mid = Math.floor(chron.length / 2);
const h1 = summarize(chron.slice(0, mid)), h2 = summarize(chron.slice(mid));
console.log('     chronological halves:');
console.log(`       first  n=${h1.n} ${usd(h1.pnl)} win ${pct(h1.winRate)} per ${usd(h1.per)}`);
console.log(`       second n=${h2.n} ${usd(h2.pnl)} win ${pct(h2.winRate)} per ${usd(h2.per)}`);
console.log(`       => ${h1.pnl > 0 && h2.pnl > 0 ? 'POSITIVE IN BOTH HALVES' : 'NOT positive in both halves — fragile'}`);

console.log('\n  ' + '='.repeat(86));
console.log(`  BASELINE (live config): ${usd(baseS.pnl)} over ${baseS.n} trades, ${usd(baseS.per)}/trade, win ${pct(baseS.winRate)}, needs ${pct(baseS.be)}`);
const ws = summarize(wt);
console.log(`  BEST CONFIG          : cap ${Math.round(WIN.maxPrice * 100)}c, maxConf ${WIN.maxConf}%, tp ${Math.round(WIN.tp * 100)}c`);
console.log(`                         ${usd(ws.pnl)} over ${ws.n} trades, ${usd(ws.per)}/trade, win ${pct(ws.winRate)}, needs ${pct(ws.be)} (margin ${((ws.winRate - ws.be) * 100).toFixed(1)}pp)`);
console.log(`  DELTA                : ${usd(ws.pnl - baseS.pnl)} and ${usd(ws.per - baseS.per)}/trade vs the config that just lost 85% of the bankroll`);
console.log('');
