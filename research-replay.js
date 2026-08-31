#!/usr/bin/env node
/**
 * Market replay — step through any moment minute by minute, with the model's own state beside the tape.
 *
 * ── why this exists ──
 *
 * Every analysis in this repo has been aggregate: 1806 markets, win rates, margins. That is the right
 * unit for deciding a gate, and the wrong unit for understanding a single entry. When the question is
 * "what did their bot see at 1:03 AM", an average cannot answer it.
 *
 * This pulls the real Coinbase 1-minute tape and replays it around a chosen instant, showing the price,
 * the volume, the drift, the realized vol, all four indicators and the model's probability AS THEY
 * EVOLVED. With --entry it also marks a hypothetical position to market each minute, so the shape of a
 * win (or a loss) is visible rather than inferred from its endpoint.
 *
 * ── the honest caveat about "ROI" ──
 *
 * Kalshi's historical order book is not available here, so the mark is the MODEL's implied price, not
 * the price the contract actually traded at. Where the two disagree is exactly the 15pp gap that makes
 * this bot's whole strategy work, so a model-implied mark is an optimistic read of an open position.
 * Labelled `model mark` everywhere for that reason. The settlement column is real.
 *
 * Usage:
 *   node research-replay.js --at 2026-08-31T05:03:00Z --product BTC-USD --entry 0.43 --side YES
 *   node research-replay.js --at 2026-08-31T05:03:00Z --product DOGE-USD --before 40 --after 15
 *
 *   --at        UTC instant to centre on (default: 30 minutes ago)
 *   --product   Coinbase product id (default BTC-USD)
 *   --before    minutes of history to show before it (default 30)
 *   --after     minutes to replay after it (default 15)
 *   --entry     entry price 0-1, to mark a hypothetical position to market
 *   --side      YES or NO (default YES)
 *   --strike    strike price, or omitted to solve for the one that makes --entry a fair price
 *   --close     UTC settlement instant (default: next :00/:15/:30/:45 after --at)
 */
const https = require('https');
const decide = require('./src/decide');
const trader = require('./src/trader');

// ── args ──
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PRODUCT = arg('product', 'BTC-USD');
const AT = arg('at') ? new Date(arg('at')) : new Date(Date.now() - 30 * 60000);
const BEFORE = Number(arg('before', 30));
const AFTER = Number(arg('after', 15));
const ENTRY = arg('entry') == null ? null : Number(arg('entry'));
const SIDE = (arg('side', 'YES') || 'YES').toUpperCase() === 'NO' ? 'NO' : 'YES';
const STRIKE_ARG = arg('strike') == null ? null : Number(arg('strike'));
/** Kalshi crypto rounds close on the quarter hour. */
function nextQuarter(d) {
  const t = new Date(d);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(Math.ceil((t.getUTCMinutes() + 0.001) / 15) * 15);
  return t;
}
const CLOSE = arg('close') ? new Date(arg('close')) : nextQuarter(AT);

const get = url => new Promise((res, rej) => {
  https.get(url, { headers: { 'user-agent': 'indicators-replay' } }, r => {
    let b = '';
    r.on('data', c => { b += c; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(`bad JSON from ${url}: ${b.slice(0, 120)}`)); } });
  }).on('error', rej);
});

// ── formatting ──
const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const cents = x => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(0) + '¢');
const money = x => (x == null || !Number.isFinite(x) ? '—' : (x < 0 ? '-$' : '+$') + Math.abs(x).toFixed(2));
const hhmm = ts => new Date(ts * 1000).toISOString().slice(11, 16);
const num = (v, dp) => Number(v).toFixed(dp);

/**
 * An ASCII price chart. Rendered rather than described because the shape of a move is the thing being
 * asked about, and a column of numbers hides it — a 0.2% move on a $77,000 asset is four digits of
 * noise in a table and an obvious ramp in a picture.
 *
 * `mark` draws a horizontal reference (the strike). `split` marks the entry column.
 */
function chart(rows, { height = 14, mark = null, split = null, dp = 2 } = {}) {
  const closes = rows.map(r => r.close);
  const lo = Math.min(...closes, ...(mark ? [mark] : []));
  const hi = Math.max(...closes, ...(mark ? [mark] : []));
  const span = hi - lo || 1;
  const row = v => Math.round((1 - (v - lo) / span) * (height - 1));
  const grid = Array.from({ length: height }, () => Array(rows.length).fill(' '));
  const markRow = mark == null ? -1 : row(mark);
  if (markRow >= 0 && markRow < height) grid[markRow].fill('·');
  rows.forEach((r, i) => {
    const y = row(r.close);
    grid[y][i] = '█';
    // Join to the previous point so a gap reads as a move rather than two dots.
    if (i > 0) {
      const py = row(rows[i - 1].close);
      const [a, b] = py < y ? [py + 1, y - 1] : [y + 1, py - 1];
      for (let k = a; k <= b; k++) if (grid[k][i] === ' ' || grid[k][i] === '·') grid[k][i] = '│';
    }
  });
  const out = [];
  for (let y = 0; y < height; y++) {
    const v = lo + (1 - y / (height - 1)) * span;
    const label = num(v, dp).padStart(11);
    out.push(`  ${label} ${y === markRow ? '┈' : ' '}│${grid[y].join('')}`);
  }
  // A time axis, labelled every 5 columns so it stays readable at any window size.
  let axis = '  ' + ' '.repeat(13) + '└';
  let ticks = '  ' + ' '.repeat(14);
  rows.forEach((r, i) => {
    axis += (split != null && i === split) ? '┬' : '─';
    ticks += (i % 5 === 0) ? hhmm(r.time).slice(0, 5).padEnd(5) : '';
  });
  out.push(axis, ticks.trimEnd());
  return out.join('\n');
}

/** A volume histogram under the price, on the same columns. */
function volumeBars(rows, { height = 5 } = {}) {
  const vols = rows.map(r => r.volume || 0);
  const hi = Math.max(...vols) || 1;
  const out = [];
  for (let y = 0; y < height; y++) {
    const thresh = hi * (1 - y / height);
    out.push('  ' + ' '.repeat(11) + (y === 0 ? num(hi, 1).padStart(11) : ' '.repeat(11)).slice(0, 0) +
      ' '.repeat(2) + '│' + rows.map(r => ((r.volume || 0) >= thresh ? '▄' : ' ')).join(''));
  }
  return out.join('\n');
}

/** Solve for the strike that makes `targetP` the model's own probability. Monotonic in strike. */
function strikeFor(spot, targetP, minutesLeft, hist) {
  let lo = spot * 0.9, hi = spot * 1.1;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    const r = decide.engineEvaluate(spot, mid, minutesLeft, hist);
    const pYes = r.side === 'YES' ? r.confidence / 100 : 1 - r.confidence / 100;
    if (!Number.isFinite(pYes)) return null;
    if (pYes > targetP) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

(async () => {
  // Coinbase caps a request at 300 candles; this window is far smaller, plus 70 bars of warm-up so the
  // indicators are fully formed at the first row shown rather than ramping into view.
  const startTs = Math.floor(AT.getTime() / 1000) - (BEFORE + 70) * 60;
  const endTs = Math.floor(AT.getTime() / 1000) + AFTER * 60;
  const url = `https://api.exchange.coinbase.com/products/${PRODUCT}/candles` +
    `?granularity=60&start=${new Date(startTs * 1000).toISOString()}&end=${new Date(endTs * 1000).toISOString()}`;
  const raw = await get(url);
  if (!Array.isArray(raw) || !raw.length) throw new Error(`no candles for ${PRODUCT}: ${JSON.stringify(raw).slice(0, 200)}`);
  const all = raw.map(r => ({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] }))
    .sort((a, b) => b.time - a.time);                      // newest first, as decide.js expects
  const dp = all[0].close < 1 ? 5 : 2;

  const atTs = Math.floor(AT.getTime() / 1000 / 60) * 60;
  const closeTs = Math.floor(CLOSE.getTime() / 1000 / 60) * 60;
  const shown = all.filter(c => c.time >= atTs - BEFORE * 60 && c.time <= atTs + AFTER * 60)
    .sort((a, b) => a.time - b.time);                      // oldest first for drawing
  const splitIdx = shown.findIndex(c => c.time === atTs);

  // The model's state at the entry instant, from bars that CLOSED before it.
  const hist0 = all.filter(c => c.time < atTs).slice(0, 60);
  const spot0 = hist0[0].close;
  const ml0 = (closeTs - atTs) / 60;
  const strike = STRIKE_ARG != null ? STRIKE_ARG
    : (ENTRY != null ? strikeFor(spot0, SIDE === 'YES' ? ENTRY : 1 - ENTRY, ml0, hist0) : spot0);

  console.log(`\n  MARKET REPLAY — ${PRODUCT}`);
  console.log(`  centred ${new Date(atTs * 1000).toISOString().slice(0, 16)}Z ` +
    `(${new Date(atTs * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true, hour: 'numeric', minute: '2-digit' })} ET)` +
    `   round closes ${hhmm(closeTs)}Z   ${ml0} min left at entry`);
  console.log(`  strike ${num(strike, dp)}${STRIKE_ARG == null && ENTRY != null ? '  (solved so that ' + cents(ENTRY) + ' is the model\'s own fair price)' : ''}`);
  console.log('');
  console.log(chart(shown, { mark: strike, split: splitIdx, dp }));
  console.log('  volume');
  console.log(volumeBars(shown));
  console.log(`  (┈ = strike, ┬ = entry minute, ${shown.length} minutes shown)`);

  // ── the minute-by-minute tape, with the model's state as it evolved ──
  //
  // drift is the mean 1-minute log return over the last 10 bars, annotated because it is the term
  // BETSSSSS's engine used and the one this engine deliberately omits (adding it WORSENED Brier score).
  // volRel puts volume in context: 1.0x is the 30-bar average, and an onset detector would key off this.
  console.log('\n  time   close        1m      drift10   vol      volRel  RSI  EMA9/20  BB   VWAP  cf  model      mark    ROI');
  const rowsOut = [];
  for (const bar of shown) {
    const hist = all.filter(c => c.time < bar.time).slice(0, 60);
    if (hist.length < 25) continue;
    const spot = bar.close;
    const ml = (closeTs - bar.time) / 60;
    const vol = decide.realizedVol(hist, 10);
    const rets = hist.slice(0, 10).map((c, i) => (hist[i + 1] ? Math.log(c.close / hist[i + 1].close) : 0));
    const drift = rets.reduce((a, b) => a + b, 0) / rets.length;
    const avgVol = hist.slice(0, 30).reduce((a, c) => a + (c.volume || 0), 0) / 30;
    const rsi = decide.calcRSI(hist, 14), e9 = decide.calcEMA(hist, 9), e20 = decide.calcEMA(hist, 20);
    const bb = decide.calcBollingerBands(hist, 20), vw = decide.calcVWAP(hist, 20);
    const up = SIDE === 'YES';
    const cf = [up ? rsi > 50 : rsi < 50, up ? e9 > e20 : e9 < e20,
      bb ? (up ? spot > bb.middle : spot < bb.middle) : false, up ? spot > vw : spot < vw]
      .filter(Boolean).length;
    // After the round closes there is no model read to make; the row still shows the tape.
    const r = ml > 0 ? decide.engineEvaluate(spot, strike, ml, hist) : { side: null, confidence: 0 };
    const pSide = !r.side ? null : (SIDE === 'YES'
      ? (r.side === 'YES' ? r.confidence / 100 : 1 - r.confidence / 100)
      : (r.side === 'NO' ? r.confidence / 100 : 1 - r.confidence / 100));
    const roi = (ENTRY != null && pSide != null) ? (pSide - ENTRY) / ENTRY : null;
    const oneMin = hist[0] ? (spot - hist[0].close) / hist[0].close : NaN;
    const isEntry = bar.time === atTs;
    rowsOut.push({ bar, pSide, cf, roi });
    console.log(`  ${hhmm(bar.time)}${isEntry ? '*' : ' '} ${num(spot, dp).padStart(11)} ` +
      `${pct(oneMin, 3).padStart(8)} ${pct(drift, 4).padStart(9)} ${vol.toExponential(1).padStart(8)} ` +
      `${(avgVol ? ((bar.volume || 0) / avgVol).toFixed(1) + 'x' : '—').padStart(6)} ` +
      `${rsi.toFixed(0).padStart(4)}  ${(e9 > e20 ? 'up  ' : 'down').padStart(6)}  ` +
      `${(bb ? (spot > bb.middle ? 'up' : 'dn') : '—').padStart(2)}  ` +
      `${(spot > vw ? 'up' : 'dn').padStart(4)}  ${cf}/4 ` +
      `${(pSide == null ? '—' : cents(pSide)).padStart(7)}  ` +
      `${(ENTRY == null ? '' : (pSide == null ? '—' : cents(pSide)).padStart(6))}  ` +
      `${(roi == null ? '' : pct(roi, 0).padStart(6))}`);
  }

  // ── what actually happened, which needs no model ──
  const closeBar = all.find(c => c.time === closeTs) || all.filter(c => c.time <= closeTs)[0];
  if (closeBar) {
    const settledYes = closeBar.close > strike;
    const won = (SIDE === 'YES') === settledYes;
    console.log(`\n  SETTLEMENT (real, not modelled): close ${num(closeBar.close, dp)} vs strike ${num(strike, dp)} ` +
      `=> market settled ${settledYes ? 'YES' : 'NO'}, a ${SIDE} bet ${won ? 'WON' : 'LOST'}`);
    const moved = (closeBar.close - spot0) / spot0;
    const sigma = decide.realizedVol(hist0, 10) * Math.sqrt(ml0);
    console.log(`  spot moved ${pct(moved, 3)} from entry, against a sigma of ${pct(sigma, 3)} => ` +
      `${(Math.abs(moved) / sigma).toFixed(2)} sigma`);
    if (ENTRY != null) {
      const n = 100;
      const fee = p => Math.ceil(+(0.07 * n * p * (1 - p) * 100).toFixed(6)) / 100;
      const pnl = (won ? n * (1 - ENTRY) : -n * ENTRY) - fee(ENTRY);
      console.log(`  on ${n} contracts at ${cents(ENTRY)} held to settlement: ${money(pnl)} ` +
        `(entry fee ${money(-fee(ENTRY))}, settlement is fee-free)`);
    }
  }

  // ── what this bot's gate would have said, at the entry minute ──
  const entryRow = rowsOut.find(x => x.bar.time === atTs);
  if (entryRow) {
    const r = decide.engineEvaluate(spot0, strike, ml0, hist0);
    const gapPct = Math.abs((spot0 - strike) / strike) * 100;
    const gates = [];
    if (!(ml0 > trader.MIN_MINUTES && ml0 < trader.MAX_MINUTES)) gates.push(`no-window (${ml0}m)`);
    if (!r.side) gates.push('no-read');
    else if (!trader.confOK(r.confidence)) gates.push(`below-conf (${r.confidence}%)`);
    if (!trader.gapOK(spot0, strike)) gates.push(`on-strike (${gapPct.toFixed(3)}%)`);
    if (entryRow.cf < trader.MIN_CONFIRM) gates.push(`indicators (${entryRow.cf}/4)`);
    if (ENTRY != null && ENTRY < trader.MIN_PRICE) gates.push('too-cheap');
    if (ENTRY != null && ENTRY > trader.MAX_PRICE) gates.push('too-dear');
    console.log(`\n  THIS BOT AT THAT MINUTE: ${gates.length ? 'SKIP — ' + gates.join('; ') : 'would have TAKEN it'}`);
    console.log(`  (model said ${r.side || 'nothing'} ${r.confidence}%, ${entryRow.cf}/4 indicators, ` +
      `${gapPct.toFixed(3)}% from the strike, ${ml0} min left)`);
  }
  console.log('\n  NOTE: `mark` and `ROI` are the MODEL\'s implied price, not Kalshi\'s book — historical');
  console.log('  order books are not available here. Where the two disagree is precisely this bot\'s');
  console.log('  claimed edge, so treat a positive open ROI as the optimistic reading. Settlement is real.\n');
})().catch(e => { console.error('replay failed:', e.message); process.exit(1); });
