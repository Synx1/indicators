#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — "how many trades overnight, roughly?"
 *
 * Counts SIGNALS per night at the current gate (min-gap floor included), then applies the two things
 * that stop a signal becoming a trade on a $30 bankroll:
 *
 *   maxOpen 3            — the total-concurrency cap
 *   free cash            — 13 contracts at ~59c is ~$7.65 committed, so $30 holds about three
 *
 * The gap between those two numbers is the point: the gate is not the binding constraint on a small
 * bankroll, the money is. Reported per night and per hour, with the spread, because an average of
 * "6 a night" hides whether that is 6-and-6-and-6 or 1-and-2-and-15.
 *
 * Engine/indicators/gate from src/*.js. `node research-nightcount.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, FEE_COEF = 0.07;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const NIGHT = new Set([0, 1, 2, 3, 4, 5, 6, 7]);          // midnight-8am ET
const BANKROLL = 30, RISK = 0.25, MAX_OPEN = 3;
const fee = (p, n) => Math.ceil(FEE_COEF * n * p * (1 - p) * 100) / 100;
const et = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
const etHour = ms => Number(et(ms).split(', ')[1].slice(0, 2)) % 24;
/** The night a timestamp belongs to: 2am Tuesday belongs to Monday night. */
const nightOf = ms => {
  const h = etHour(ms);
  const d = new Date(ms - (h < 8 ? 24 : 0) * 3600 * 1000);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
};

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
function signal(row, byTime, sym, shares) {
  for (const min of ENTRY_SCAN) {
    const q = row.entries[String(min)] || row.entries[min];
    if (!q || !(q.ask > 0) || !(q.ask < 1) || !(q.bid >= 0)) continue;
    const ts = Math.floor(row.closeMs / 1000) - min * 60;
    const candles = closedBefore(byTime, ts, 60);
    if (candles.length < MIN_CANDLES) continue;
    const spot = candles[0].close;
    const res = decide.engineEvaluate(spot, row.strike, min, candles);
    if (!res.side || !trader.confOK(res.confidence)) continue;
    if (!trader.gapOK(spot, row.strike)) continue;
    const rsi = decide.calcRSI(candles, 14), e9 = decide.calcEMA(candles, 9), e20 = decide.calcEMA(candles, 20);
    const bb = decide.calcBollingerBands(candles, 20), vw = decide.calcVWAP(candles, 20);
    let cf = 0;
    if (res.side === 'YES') { if (rsi > 50) cf++; if (e9 > e20) cf++; if (bb && spot > bb.middle) cf++; if (spot > vw) cf++; }
    else { if (rsi < 50) cf++; if (e9 < e20) cf++; if (bb && spot < bb.middle) cf++; if (spot < vw) cf++; }
    if (cf < trader.MIN_CONFIRM) continue;
    const ep = res.side === 'YES' ? q.ask : (1 - q.bid);
    if (ep < trader.MIN_PRICE || ep > trader.MAX_PRICE) continue;
    const won = (res.side === 'YES' && row.settledYes) || (res.side === 'NO' && !row.settledYes);
    return {
      sym, side: res.side, entryPrice: ep, won,
      cost: +(shares * ep).toFixed(2),
      pnl: (won ? shares * (1 - ep) : -shares * ep) - fee(ep, shares),
      openMs: row.closeMs - min * 60 * 1000, closeMs: row.closeMs,
      hour: etHour(row.closeMs), night: nightOf(row.closeMs)
    };
  }
  return null;
}

const SHARES = Math.max(1, Math.floor((BANKROLL * RISK) / 0.57));
const datasets = [];
for (const s of COINS) { try { datasets.push(loadCoin(s)); } catch (e) {} }
const all = [];
for (const ds of datasets) for (const r of ds.rows) { const e = signal(r, ds.byTime, ds.sym, SHARES); if (e) all.push(e); }
all.sort((a, b) => a.openMs - b.openMs);
const nightSignals = all.filter(e => NIGHT.has(e.hour));

/** Walk the night in order, applying maxOpen AND the cash the bankroll actually has. */
function takeable(list) {
  const open = []; const taken = []; const refused = { cap: 0, cash: 0 };
  let cash = BANKROLL;
  for (const e of list) {
    while (open.length && open[0].closeMs <= e.openMs) {
      const done = open.shift();
      cash += done.cost + done.pnl;                 // settlement returns the stake plus/minus the result
    }
    if (open.length >= MAX_OPEN) { refused.cap++; continue; }
    if (cash < e.cost) { refused.cash++; continue; }
    cash -= e.cost;
    taken.push(e); open.push(e); open.sort((a, b) => a.closeMs - b.closeMs);
  }
  return { taken, refused };
}

const pct = x => (x * 100).toFixed(0) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);

console.log('\n  HOW MANY TRADES OVERNIGHT — current gate (conf>=80, 3/4, 25-65c, 8<ml<14, gap>=0.03%)');
console.log(`  $${BANKROLL} bankroll, ${pct(RISK)} risk => ${SHARES} contracts (~$${(SHARES * 0.57).toFixed(2)} per position), maxOpen ${MAX_OPEN}`);
console.log('  ' + '─'.repeat(84));

const byNight = {};
for (const e of nightSignals) (byNight[e.night] ||= []).push(e);
console.log('  night (ET)     signals   takeable on $30   refused: cap / cash   net on the takeable');
let totS = 0, totT = 0;
for (const n of Object.keys(byNight).sort()) {
  const list = byNight[n];
  const { taken, refused } = takeable(list);
  totS += list.length; totT += taken.length;
  const net = taken.reduce((a, e) => a + e.pnl, 0);
  console.log(`  ${n.padEnd(13)}  ${String(list.length).padStart(6)}   ${String(taken.length).padStart(15)}   ` +
    `${String(refused.cap).padStart(9)} / ${String(refused.cash).padEnd(4)}   ${usd(net).padStart(9)}`);
}
const nights = Object.keys(byNight).length;
console.log(`  ${'─'.repeat(84)}`);
console.log(`  ${nights} nights: ${totS} signals (${(totS / nights).toFixed(1)}/night), ` +
  `${totT} takeable (${(totT / nights).toFixed(1)}/night)`);

console.log('\n  WHEN, by ET hour — the overnight shape');
const byHour = {};
for (const e of nightSignals) byHour[e.hour] = (byHour[e.hour] || 0) + 1;
for (const h of [...NIGHT].sort((a, b) => a - b)) {
  const n = byHour[h] || 0;
  const label = h === 0 ? '12 AM' : h + ' AM';
  console.log(`   ${label.padStart(5)}  ${'█'.repeat(n)}${n ? ' ' + n : ' —'}`);
}

console.log('\n  ── the shape of one night, for scale ──');
console.log(`  a 15-min round closes 4x/hour on each of ${datasets.length} coins, so an 8-hour night offers`);
console.log(`  ~${8 * 4 * datasets.length} rounds. ${totS} of them signalled: the gate declines about ` +
  `${pct(1 - totS / (nights * 8 * 4 * datasets.length))} of everything it looks at.`);
const spread = Object.values(byNight).map(l => l.length);
console.log(`  per-night spread: ${Math.min(...spread)} to ${Math.max(...spread)} signals — ` +
  `an average of ${(totS / nights).toFixed(1)} hides that.`);
console.log('');
