#!/usr/bin/env node
/**
 * BETTER SUCCESS, LOWER COST OF LOSS — measured, not asserted.
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
    return { price, won, closeMs: row.closeMs, sym: row.sym, min, side: res.side,
      conf: res.confidence, confirm, style, row };
  }
  return null;
}

// ── every entry the live gate would have taken, with its market kept for the exit walk ──
const entries = [];
let markets = 0;
for (const c of bot.COINS) {
  let ds;
  try { ds = loadCoin(c.sym); } catch (_) { continue; }
  for (const row of ds.rows) {
    markets++;
    const t = firstQualifying({ ...row, sym: c.sym }, ds.byTime);
    if (t) entries.push(t);
  }
}
entries.sort((a, b) => a.closeMs - b.closeMs);

const SHARES = bot.SHARES;

/**
 * Grade one entry under an exit policy, walking the minutes the way the live bot's poll does.
 *
 * `tp`  sell when the position can be sold at or above this            (take profit, exists today)
 * `sl`  sell when it can only be sold at or below this                 (stop loss, does NOT exist)
 *
 * Whichever triggers FIRST in time wins, because that is what a bot polling every 20s would hit.
 * Both pay a second fee; settlement is fee-free, which is exactly why an early exit has to earn it.
 */
function grade(e, { tp = null, sl = null } = {}) {
  const entryFee = fee(e.price, SHARES);
  for (let min = e.min - 1; min >= 0; min--) {
    const q = e.row.entries[String(min)] || e.row.entries[min];
    if (!q || !(q.bid >= 0) || !(q.ask > 0)) continue;
    // What we could SELL at: the bid for a YES holding, 1-ask for a NO holding.
    const sell = e.side === 'YES' ? q.bid : (1 - q.ask);
    if (!(sell > 0) || !(sell < 1)) continue;
    if (tp != null && sell >= tp) {
      return { exit: 'tp', pnl: SHARES * (sell - e.price) - entryFee - fee(sell, SHARES) };
    }
    if (sl != null && sell <= sl) {
      return { exit: 'sl', pnl: SHARES * (sell - e.price) - entryFee - fee(sell, SHARES) };
    }
  }
  return {
    exit: e.won ? 'win' : 'loss',
    pnl: (e.won ? SHARES * (1 - e.price) : -SHARES * e.price) - entryFee
  };
}

function stats(rs) {
  const w = rs.filter(r => r.pnl > 0), l = rs.filter(r => r.pnl <= 0);
  const net = rs.reduce((a, r) => a + r.pnl, 0);
  const aw = w.length ? w.reduce((a, r) => a + r.pnl, 0) / w.length : 0;
  const al = l.length ? Math.abs(l.reduce((a, r) => a + r.pnl, 0) / l.length) : 0;
  return { n: rs.length, hit: rs.length ? w.length / rs.length : 0, net,
    per: rs.length ? net / rs.length : 0, aw, al,
    be: (aw + al) ? al / (aw + al) : 0 };
}
const row = (label, s) => console.log(
  `  ${label.padEnd(26)} n=${String(s.n).padStart(4)}  hit ${pct(s.hit).padStart(6)}  ` +
  `net ${usd(s.net).padStart(10)}  ${usd(s.per).padStart(8)}/t  ` +
  `avgW ${usd(s.aw).padStart(7)}  avgL ${usd(-s.al).padStart(8)}  ` +
  `needs ${pct(s.be).padStart(6)}  margin ${((s.hit - s.be) * 100).toFixed(1).padStart(6)}pp`);

console.log('');
console.log('='.repeat(118));
console.log(`  LOWERING THE COST OF A LOSS — ${entries.length} entries from ${markets} markets, ${SHARES} contracts each`);
console.log('='.repeat(118));

console.log('\n  WHERE IT STANDS');
row('hold to settlement', stats(entries.map(e => grade(e))));
row('cashout 97c (a setting)', stats(entries.map(e => grade(e, { tp: 0.97 }))));

console.log('\n  1) STOP LOSS — sell when the position can only be sold at or below X');
for (const sl of [0.60, 0.50, 0.40, 0.30, 0.20, 0.10]) {
  row(`stop at ${Math.round(sl * 100)}c`, stats(entries.map(e => grade(e, { sl }))));
}

console.log('\n  2) STOP LOSS + the 97c cashout together');
for (const sl of [0.50, 0.40, 0.30, 0.20]) {
  row(`stop ${Math.round(sl * 100)}c + tp 97c`, stats(entries.map(e => grade(e, { sl, tp: 0.97 }))));
}

console.log('\n  3) BETTER SUCCESS — only enter with 9+ minutes left');
const early = entries.filter(e => e.min >= 9);
row('9+ min, hold', stats(early.map(e => grade(e))));
row('9+ min, stop 30c', stats(early.map(e => grade(e, { sl: 0.30 }))));
row('9+ min, stop 30c + tp 97c', stats(early.map(e => grade(e, { sl: 0.30, tp: 0.97 }))));
console.log(`  (drops ${entries.length - early.length} of ${entries.length} entries)`);

console.log('\n  4) THE BEST COMBINATION FOUND, per trade and in total');
const cands = [];
for (const minLeft of [0, 9]) {
  for (const sl of [null, 0.40, 0.30, 0.20]) {
    for (const tp of [null, 0.97]) {
      const set = entries.filter(e => e.min >= minLeft);
      const s = stats(set.map(e => grade(e, { sl, tp })));
      cands.push({ label: `${minLeft ? '9+min' : 'all'} · ${sl ? 'sl' + Math.round(sl * 100) : 'no sl'} · ${tp ? 'tp97' : 'hold'}`, s });
    }
  }
}
cands.sort((a, b) => b.s.net - a.s.net);
for (const c of cands.slice(0, 6)) row(c.label, c.s);
console.log('');
