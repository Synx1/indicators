#!/usr/bin/env node
/**
 * THROWAWAY (2026-08-31) — reverse-engineer the DirectionalBot's entry conditions from real market data.
 *
 * Five trades were published with exact timestamps (12:56 and 1:03 AM ET, 2026-08-31), coins, sides and
 * entry prices. That is enough to reconstruct what the market actually looked like at the instant their
 * bot fired, using the same engine and indicators this bot runs — and therefore to say precisely which
 * of our gates would have refused each one, and why.
 *
 * ── the inversion that makes this work ──
 *
 * We do not know the strike they traded. But their ENTRY PRICE is the market's own implied probability:
 * paying 43¢ for UP means the book thought there was a ~43% chance of closing above the strike. So the
 * strike can be solved for — find the one that makes OUR model agree with the market's 43% — and then
 * the model's read at that strike can be compared against what they paid. If the two agree, their bot
 * is not using a probability model at all; it is using something else.
 *
 * Candles come from Coinbase's public API and are cached to /tmp by the caller. Leakage discipline is
 * the same as every other harness here: only candles that CLOSED strictly before the entry minute.
 *
 * `node research-dbot-entries.js`
 */
const fs = require('fs');
const decide = require('./src/decide');
const trader = require('./src/trader');

/** The published trades. `min` is minutes left in the 15-minute round at placement. */
const TRADES = [
  { id: 1, sym: 'BTC', product: 'BTC-USD', side: 'YES', entry: 0.51, n: 100, atUtc: '2026-08-31T04:56:00Z', closeUtc: '2026-08-31T05:00:00Z' },
  { id: 2, sym: 'BTC', product: 'BTC-USD', side: 'YES', entry: 0.43, n: 100, atUtc: '2026-08-31T05:03:00Z', closeUtc: '2026-08-31T05:15:00Z' },
  { id: 3, sym: 'DOGE', product: 'DOGE-USD', side: 'YES', entry: 0.48, n: 100, atUtc: '2026-08-31T05:03:00Z', closeUtc: '2026-08-31T05:15:00Z' },
  { id: 4, sym: 'BTC', product: 'BTC-USD', side: 'YES', entry: 0.45, n: 100, atUtc: '2026-08-31T05:03:00Z', closeUtc: '2026-08-31T05:15:00Z' },
  { id: 5, sym: 'BTC', product: 'BTC-USD', side: 'YES', entry: 0.43, n: 22, atUtc: '2026-08-31T05:03:00Z', closeUtc: '2026-08-31T05:15:00Z' }
];

/** Coinbase rows are [time, low, high, open, close, volume], newest first. */
function load(product) {
  const raw = JSON.parse(fs.readFileSync(`/tmp/c-${product}.json`, 'utf8'));
  return raw.map(r => ({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] }))
    .sort((a, b) => b.time - a.time);
}
/** Candles that CLOSED strictly before `ts`, newest first — the leakage rule. */
const closedBefore = (all, ts, depth = 60) => all.filter(c => c.time < ts).slice(0, depth);
const at = (all, ts) => all.find(c => c.time === Math.floor(ts / 60) * 60) || null;

/** Solve for the strike that makes OUR model report `targetP` for YES. Monotonic in strike. */
function strikeFor(spot, targetP, minutesLeft, candles) {
  let lo = spot * 0.90, hi = spot * 1.10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const r = decide.engineEvaluate(spot, mid, minutesLeft, candles);
    // engineEvaluate reports max(pYes, 1-pYes); recover the signed pYes.
    const pYes = r.side === 'YES' ? r.confidence / 100 : 1 - r.confidence / 100;
    if (!Number.isFinite(pYes)) return null;
    if (pYes > targetP) lo = mid; else hi = mid;      // higher strike -> lower pYes
  }
  return (lo + hi) / 2;
}

const pct = x => (x * 100).toFixed(1) + '%';
const cache = {};
console.log('\n  DIRECTIONALBOT ENTRIES, RECONSTRUCTED FROM REAL MARKET DATA (2026-08-31)');
console.log('  candles: Coinbase 1-minute, only bars CLOSED before the entry minute');

for (const t of TRADES) {
  if (!cache[t.product]) cache[t.product] = load(t.product);
  const all = cache[t.product];
  const ts = Math.floor(new Date(t.atUtc).getTime() / 1000);
  const closeTs = Math.floor(new Date(t.closeUtc).getTime() / 1000);
  const minutesLeft = (closeTs - ts) / 60;
  const hist = closedBefore(all, ts);
  const entryBar = at(all, ts), closeBar = at(all, closeTs);
  const spot = hist.length ? hist[0].close : null;

  console.log('\n  ' + '─'.repeat(94));
  console.log(`  #${t.id}  ${t.sym} ${t.side === 'YES' ? 'UP' : 'DOWN'}  placed ${t.atUtc.slice(11, 16)}Z ` +
    `(${new Date(t.atUtc).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true, hour: 'numeric', minute: '2-digit' })} ET)` +
    `  entry ${(t.entry * 100).toFixed(0)}¢  ${t.n} sh  |  ${minutesLeft.toFixed(0)} min to close`);
  if (!spot || hist.length < 20) { console.log('   insufficient candle history'); continue; }

  const vol = decide.realizedVol(hist, 10);
  const rsi = decide.calcRSI(hist, 14), e9 = decide.calcEMA(hist, 9), e20 = decide.calcEMA(hist, 20);
  const bb = decide.calcBollingerBands(hist, 20), vw = decide.calcVWAP(hist, 20);
  const up = t.side === 'YES';
  const agree = {
    RSI: up ? rsi > 50 : rsi < 50,
    EMA: up ? e9 > e20 : e9 < e20,
    BB: bb ? (up ? spot > bb.middle : spot < bb.middle) : false,
    VWAP: up ? spot > vw : spot < vw
  };
  const confirm = Object.values(agree).filter(Boolean).length;
  // Momentum over the last 5 and 15 closed minutes — what an "onset" detector would be reading.
  const back = k => (hist[k] ? (spot - hist[k].close) / hist[k].close * 100 : NaN);

  console.log(`   spot ${spot}   realizedVol ${vol.toExponential(3)}   sigma@${minutesLeft}m ${(vol * Math.sqrt(minutesLeft)).toExponential(3)}`);
  console.log(`   momentum: 1m ${back(1).toFixed(3)}%   5m ${back(5).toFixed(3)}%   15m ${back(15).toFixed(3)}%   30m ${back(30).toFixed(3)}%`);
  console.log(`   indicators for ${up ? 'UP' : 'DOWN'}: ` +
    Object.entries(agree).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ') + `  => ${confirm}/4` +
    (confirm >= trader.MIN_CONFIRM ? '  PASSES' : `  FAILS (needs ${trader.MIN_CONFIRM})`));

  // Invert their price into the strike the market was pricing, then read our model at that strike.
  const strike = strikeFor(spot, t.entry, minutesLeft, hist);
  if (strike) {
    const r = decide.engineEvaluate(spot, strike, minutesLeft, hist);
    const gapPct = Math.abs((spot - strike) / strike) * 100;
    console.log(`   implied strike ${strike.toFixed(t.sym === 'DOGE' ? 5 : 2)}  ` +
      `(spot is ${spot > strike ? 'ABOVE' : 'BELOW'} it by ${gapPct.toFixed(3)}%)`);
    console.log(`   our model at that strike: ${r.side} ${r.confidence}%  ` +
      `| their price ${(t.entry * 100).toFixed(0)}¢  => model edge ${((r.confidence / 100 - t.entry) * 100).toFixed(1)}pp`);
    // Every gate, in the order decideFor applies them.
    const gates = [];
    if (!(minutesLeft > trader.MIN_MINUTES && minutesLeft < trader.MAX_MINUTES)) gates.push(`no-window (${minutesLeft}m outside ${trader.MIN_MINUTES}-${trader.MAX_MINUTES})`);
    if (!r.side) gates.push('no-read');
    else if (!trader.confOK(r.confidence)) gates.push(`below-conf (${r.confidence}% < ${trader.MIN_CONF}%)`);
    if (!trader.gapOK(spot, strike)) gates.push(`on-strike (${gapPct.toFixed(3)}% < ${trader.MIN_GAP_PCT}%)`);
    if (confirm < trader.MIN_CONFIRM) gates.push(`indicators (${confirm}/4)`);
    if (t.entry < trader.MIN_PRICE) gates.push('too-cheap');
    if (t.entry > trader.MAX_PRICE) gates.push('too-dear');
    console.log(`   OUR VERDICT: ${gates.length ? 'SKIP — ' + gates.join('; ') : 'WOULD HAVE TAKEN IT'}`);
  }
  if (entryBar && closeBar) {
    const moved = (closeBar.close - entryBar.close) / entryBar.close * 100;
    console.log(`   what happened: ${entryBar.close} -> ${closeBar.close}  (${moved >= 0 ? '+' : ''}${moved.toFixed(3)}% over the round)`);
  }
}
console.log('');
