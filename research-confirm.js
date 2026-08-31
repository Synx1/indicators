#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — "would more indicator confirmations be better?"
 *
 * MIN_CONFIRM is 3 of 4 (RSI, EMA9/20, Bollinger middle, VWAP). The question is whether demanding
 * 4/4 — full agreement — raises the win rate, and whether 2/4 would trade more without losing it.
 *
 * The dissection in research-coindetail.js already hinted at the answer on three coins: the LOSING
 * trades averaged 4.00 confirmations against the winners' 3.85. More agreement, worse outcome. This
 * checks whether that holds across the whole corpus, which is the difference between an artefact of
 * nineteen trades and a property of the signal.
 *
 * The mechanism to have in mind: all four indicators are computed from the SAME 60 one-minute candles.
 * They are not four independent opinions, they are four views of one trend. So 4/4 does not buy
 * confirmation, it buys a filter for "the trend is unusually clean" — and a clean trend is one the
 * market has already priced, which is the same trap the entry-price research kept finding.
 *
 * `node research-confirm.js`
 */
const fs = require('fs');
const path = require('path');
const decide = require('./src/decide');
const trader = require('./src/trader');

const DATA_DIR = process.env.MM_DATA_DIR || '/Users/bento/workplace/BETSSSSS/data';
const ENTRY_SCAN = [13, 12, 11, 10, 9], MIN_CANDLES = 20, SHARES = 30;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];
const fee = (p, n) => Math.ceil(+(0.07 * n * p * (1 - p) * 100).toFixed(6)) / 100;

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
/**
 * The candidate for one market, WITH its confirmation count and which indicators agreed.
 * `minConfirm` is applied by the caller, so one scan serves every threshold.
 */
function candidate(row, byTime, sym) {
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
    const up = res.side === 'YES';
    const agree = {
      rsi: up ? rsi > 50 : rsi < 50,
      ema: up ? e9 > e20 : e9 < e20,
      bb: bb ? (up ? spot > bb.middle : spot < bb.middle) : false,
      vwap: up ? spot > vw : spot < vw
    };
    const confirm = Object.values(agree).filter(Boolean).length;
    const ep = up ? q.ask : (1 - q.bid);
    if (ep < trader.MIN_PRICE || ep > trader.MAX_PRICE) continue;
    const won = (up && row.settledYes) || (!up && !row.settledYes);
    return {
      sym, side: res.side, entryPrice: ep, confidence: res.confidence, confirm, agree, won,
      pnl: (won ? SHARES * (1 - ep) : -SHARES * ep) - fee(ep, SHARES), closeMs: row.closeMs
    };
  }
  return null;
}
const pct = x => (x * 100).toFixed(1) + '%';
const usd = x => (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2);
function maxDD(list) {
  let eq = 0, peak = 0, dd = 0;
  for (const e of list.slice().sort((a, b) => a.closeMs - b.closeMs)) {
    eq += e.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}
function stats(list) {
  const s = list.slice().sort((a, b) => a.closeMs - b.closeMs);
  const w = s.filter(e => e.won).length, p = s.reduce((a, e) => a + e.pnl, 0);
  const ae = s.length ? s.reduce((a, e) => a + e.entryPrice, 0) / s.length : 0;
  const wr = s.length ? w / s.length : 0;
  const mid = Math.floor(s.length / 2);
  const h = x => (x.length ? x.filter(e => e.won).length / x.length : 0);
  return {
    n: s.length, wr, p, per: s.length ? p / s.length : 0, avgEntry: ae, margin: wr - ae,
    dd: maxDD(s), h1: h(s.slice(0, mid)), h2: h(s.slice(mid))
  };
}

const all = [];
for (const sym of COINS) {
  let ds; try { ds = loadCoin(sym); } catch (e) { continue; }
  for (const r of ds.rows) { const c = candidate(r, ds.byTime, sym); if (c) all.push(c); }
}

console.log('\n  INDICATOR CONFIRMATIONS — same engine, same gate, only MIN_CONFIRM varies');
console.log(`  pool: ${all.length} markets clearing conf>=${trader.MIN_CONF}, the gap floor and the ${trader.MIN_PRICE * 100}-${trader.MAX_PRICE * 100}c band`);
console.log('  ' + '─'.repeat(92));
console.log('  MIN_CONFIRM    n      net      win%   $/trade  avgEntry  margin   maxDD | halves win%');
for (const k of [1, 2, 3, 4]) {
  const s = stats(all.filter(e => e.confirm >= k));
  const now = k === trader.MIN_CONFIRM ? '  <- LIVE' : '';
  console.log(`  ${(k + '/4').padEnd(11)} ${String(s.n).padStart(4)}  ${usd(s.p).padStart(9)}  ${pct(s.wr).padStart(6)}  ` +
    `${usd(s.per).padStart(7)}  ${pct(s.avgEntry).padStart(7)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}  ` +
    `${('$' + s.dd.toFixed(0)).padStart(5)} | ${pct(s.h1)} / ${pct(s.h2)}${now}`);
}

// EXACTLY k, not k-or-more: this is the question "is 4/4 better than 3/4", which the cumulative
// rows above cannot answer because 4/4 is a subset of 3-or-more.
console.log('\n  EXACTLY k confirmations — the only view that can compare 4/4 against 3/4 directly');
console.log('  confirm      n      net      win%   $/trade  avgEntry  margin');
for (const k of [1, 2, 3, 4]) {
  const s = stats(all.filter(e => e.confirm === k));
  if (!s.n) { console.log(`  ${('exactly ' + k).padEnd(11)}    0`); continue; }
  console.log(`  ${('exactly ' + k).padEnd(11)} ${String(s.n).padStart(4)}  ${usd(s.p).padStart(9)}  ${pct(s.wr).padStart(6)}  ` +
    `${usd(s.per).padStart(7)}  ${pct(s.avgEntry).padStart(7)}  ${((s.margin * 100).toFixed(1) + 'pp').padStart(6)}`);
}

// The direct test of the hint from research-coindetail.js, now across every coin.
const W = all.filter(e => e.confirm >= 3 && e.won), L = all.filter(e => e.confirm >= 3 && !e.won);
const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : NaN);
console.log('\n  WINNERS vs LOSERS at the live gate — do the losers have FEWER confirmations?');
console.log(`  winners (n=${W.length}): ${avg(W, e => e.confirm).toFixed(2)} confirmations, ` +
  `${pct(avg(W, e => e.entryPrice))} entry, ${avg(W, e => e.confidence).toFixed(1)}% confidence`);
console.log(`  losers  (n=${L.length}): ${avg(L, e => e.confirm).toFixed(2)} confirmations, ` +
  `${pct(avg(L, e => e.entryPrice))} entry, ${avg(L, e => e.confidence).toFixed(1)}% confidence`);
const diff = avg(L, e => e.confirm) - avg(W, e => e.confirm);
console.log(`  => losers carry ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} confirmations vs winners` +
  (diff >= 0 ? ' — MORE agreement, worse outcome' : ' — fewer, so the filter has something to bite on'));

// Which single indicator is actually carrying information, if any.
console.log('\n  PER INDICATOR — win rate when it agrees vs when it does not (live gate pool)');
console.log('  indicator   agrees: n   win%   |  dissents: n   win%   | lift');
for (const key of ['rsi', 'ema', 'bb', 'vwap']) {
  const pool = all.filter(e => e.confirm >= 3);
  const yes = stats(pool.filter(e => e.agree[key])), no = stats(pool.filter(e => !e.agree[key]));
  const lift = (yes.n && no.n) ? yes.wr - no.wr : NaN;
  console.log(`  ${key.padEnd(10)} ${String(yes.n).padStart(9)}  ${pct(yes.wr).padStart(6)}   |  ` +
    `${String(no.n).padStart(9)}  ${(no.n ? pct(no.wr) : '—').padStart(6)}   | ` +
    (Number.isFinite(lift) ? ((lift >= 0 ? '+' : '') + (lift * 100).toFixed(1) + 'pp') : '—'));
}
console.log('\n  All four read the SAME 60 one-minute candles, so they are four views of one trend rather');
console.log('  than four independent opinions. That is why the threshold does less than it looks like.\n');
