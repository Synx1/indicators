#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-30) — the ONE transferable DirectionalBot idea, tested honestly:
 * early take-profit vs hold-to-settlement, over the same live-gate entries as the
 * new-levers spike. Same leak-free discipline; entry set is IDENTICAL across strategies
 * so only the EXIT differs (apples to apples).
 *
 * Intra-window prices come from the per-minute `entries` snapshots (minutes-left 14..0):
 * after entering at minute m0 we scan later snapshots (m < m0) for the first minute the
 * position is sellable at >= the take-profit price, and sell into the BID (cross the
 * spread, conservative) — YES sells at yes_bid, NO sells at (1 - yes_ask). Two-sided fee.
 *
 * `node research-takeprofit.js`. Delete when done.
 */

const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const MIN_CONF = 80, MIN_CONFIRM = 3, MIN_PRICE = 0.25, MAX_PRICE = 0.65;
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(FEE_COEF * n * p * (1 - p) * 100) / 100;

function loadCoin(sym) {
  const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `multimarket-${sym}.json`), 'utf8'));
  const byTime = new Map();
  for (const c of j.candles || []) byTime.set(Math.floor(c.time / 60) * 60, c);
  return { rows: j.rows || [], byTime };
}
function closedBefore(byTime, ts, depth) {
  const out = []; let t = Math.floor(ts / 60) * 60 - 60;
  for (let i = 0; i < depth && out.length < depth; i++, t -= 60) { const c = byTime.get(t); if (c) out.push(c); }
  return out;
}
function decideEntry(row, byTime) {
  for (const m0 of ENTRY_SCAN) {
    const q = row.entries[String(m0)] || row.entries[m0];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - m0 * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, m0, candles);
    if (!res.side || res.confidence < MIN_CONF) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let c = 0;
    if (res.side === 'YES') { if (rsi > 50) c++; if (e9 > e20) c++; if (bb && spot > bb.middle) c++; if (spot > vw) c++; }
    else { if (rsi < 50) c++; if (e9 < e20) c++; if (bb && spot < bb.middle) c++; if (spot < vw) c++; }
    if (c < MIN_CONFIRM) continue;
    const entryPrice = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (entryPrice < MIN_PRICE || entryPrice > MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    return { side: res.side, entryPrice, m0, won, closeMs: row.closeMs, ent: row.entries };
  }
  return null;
}

/** Exit sim: sell `frac` of the position at first later minute sellable >= tp, hold the rest. */
function simExit(e, tp, frac) {
  const entryFee = fee(e.entryPrice, SHARES);
  const settleVal = e.won ? 1 : 0;
  let sellPrice = null;
  for (let m = e.m0 - 1; m >= 1; m--) {
    const q = e.ent[String(m)] || e.ent[m];
    if (!q || !(q.ask > 0) || !(q.bid >= 0)) continue;
    const sp = e.side === 'YES' ? q.bid : (1 - q.ask);
    if (sp >= tp) { sellPrice = sp; break; }
  }
  if (sellPrice == null) return { pnl: SHARES * (settleVal - e.entryPrice) - entryFee, exited: false };
  const sh1 = Math.round(SHARES * frac), sh2 = SHARES - sh1;
  const pnl = sh1 * (sellPrice - e.entryPrice) - fee(sellPrice, sh1)
    + sh2 * (settleVal - e.entryPrice) - entryFee;
  return { pnl, exited: true, rescued: !e.won, capped: e.won };
}

const E = [];
for (const sym of COINS) {
  let ds; try { ds = loadCoin(sym); } catch (_) { continue; }
  for (const row of ds.rows) { const e = decideEntry(row, ds.byTime); if (e) { e.sym = sym; E.push(e); } }
}
E.sort((a, b) => a.closeMs - b.closeMs);

const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
const pct = x => (x * 100).toFixed(1) + '%';
function stats(pnls) {
  const n = pnls.length, tot = pnls.reduce((a, b) => a + b, 0), mean = tot / n;
  const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const wins = pnls.filter(p => p > 0).length;
  return { n, tot, per: mean, sd, winRate: wins / n };
}

console.log(`\n  TAKE-PROFIT A/B — ${E.length} identical live-gate entries, exit rule varied`);
console.log(`  data: ${DATA_DIR}   shares/trade: ${SHARES}   (sell into the bid, two-sided fee)\n`);
console.log('  strategy         net       $/trade   win%    sd/trade   Sharpe*   exits(TP)  rescued  capped');

function run(label, tp, frac) {
  const rs = E.map(e => tp == null
    ? { pnl: (e.won ? SHARES * (1 - e.entryPrice) : -SHARES * e.entryPrice) - fee(e.entryPrice, SHARES), exited: false }
    : simExit(e, tp, frac));
  const s = stats(rs.map(r => r.pnl));
  const ex = rs.filter(r => r.exited).length;
  const resc = rs.filter(r => r.rescued).length, cap = rs.filter(r => r.capped).length;
  const sharpe = s.sd > 0 ? s.per / s.sd : 0;
  console.log(`  ${label.padEnd(15)} ${usd(s.tot).padStart(8)}  ${usd(s.per).padStart(8)}  ${pct(s.winRate).padStart(6)}  ` +
    `${usd(s.sd).padStart(8)}   ${sharpe.toFixed(3).padStart(6)}   ${String(ex).padStart(3)}/${E.length}     ${String(resc).padStart(3)}     ${String(cap).padStart(3)}`);
  return { label, ...s, sharpe };
}

const hold = run('HOLD (base)', null, 1);
run('sell-all @85c', 0.85, 1);
run('sell-all @90c', 0.90, 1);
run('sell-all @95c', 0.95, 1);
run('sell-half @90c', 0.90, 0.5);
run('sell-half @95c', 0.95, 0.5);

console.log('\n  * Sharpe here = mean/sd per trade (unitless), a variance-adjusted comparison, NOT annualized.');
console.log('  rescued = TP-exit trades that would have LOST at settlement (TP saved them)');
console.log('  capped  = TP-exit trades that would have WON anyway (TP gave up the last cents)\n');

// chronological halves for the two most interesting strategies
const mid = Math.floor(E.length / 2);
for (const [label, tp, frac] of [['HOLD (base)', null, 1], ['sell-all @90c', 0.90, 1], ['sell-half @90c', 0.90, 0.5]]) {
  const pnl = e => tp == null ? (e.won ? SHARES * (1 - e.entryPrice) : -SHARES * e.entryPrice) - fee(e.entryPrice, SHARES) : simExit(e, tp, frac).pnl;
  const h1 = stats(E.slice(0, mid).map(pnl)), h2 = stats(E.slice(mid).map(pnl));
  console.log(`  halves ${label.padEnd(15)} first ${usd(h1.tot).padStart(8)} (${pct(h1.winRate)})  second ${usd(h2.tot).padStart(8)} (${pct(h2.winRate)})`);
}
console.log('');
