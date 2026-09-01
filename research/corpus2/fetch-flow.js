'use strict';

/**
 * Aggressive trade flow in the entry window, for the sampled markets.
 *
 * ── why this is a different kind of idea ──
 *
 * Every feature tested so far is derived from the price series: indicators are functions of candles, and
 * the ask is the market's own summary of them. So it is unsurprising that none of them beat the ask —
 * they are all downstream of the same information.
 *
 * Order flow is not. `taker_side` says who was AGGRESSIVE — who crossed the spread to get filled. That is
 * the one thing a chart cannot show, it is the classic short-horizon microstructure signal in every other
 * market, and Kalshi publishes it historically, so unlike order-book depth it can be backtested rather
 * than only forward-tested.
 *
 * Scoped to minutes 0-7, the window the bot decides in. Flow after that is worth little: by minute 12 the
 * outcome is mostly known and the tape is just settling up.
 *
 * BTC and ETH are dense enough to hit the 1000-trade cap inside the window, so their coverage is the tail
 * of it rather than all of it. `minutesCovered` is recorded per market so the model can tell the
 * difference instead of treating a partial read as a complete one.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'flow.json');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const WINDOW = 15;
const ENTRY_END = 8;          // minutes 0..7

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'indicators-flow', Accept: 'application/json' } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (tries > 0) return setTimeout(() => get(url, tries - 1).then(resolve, reject), 1500);
          return reject(new Error(String(res.statusCode)));
        }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`${res.statusCode} ${b.slice(0, 90)}`)); }
      });
    }).on('error', e => (tries > 0 ? setTimeout(() => get(url, tries - 1).then(resolve, reject), 1500) : reject(e)));
  });
}

(async () => {
  const books = JSON.parse(fs.readFileSync(path.join(DIR, 'books.json'), 'utf8'));
  const markets = JSON.parse(fs.readFileSync(path.join(DIR, 'markets.json'), 'utf8'));
  const byTicker = new Map();
  for (const [sym, rows] of Object.entries(markets)) for (const r of rows) byTicker.set(r[0], { sym, closeMs: r[1] });

  const wanted = Object.keys(books).filter(t => books[t].length && byTicker.has(t));
  const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const todo = wanted.filter(t => !store[t]);
  console.log(`${wanted.length} priced markets · ${todo.length} to fetch · ~${(todo.length * 0.28 / 60).toFixed(0)} min`);

  let done = 0;
  for (const ticker of todo) {
    const { closeMs } = byTicker.get(ticker);
    const openMs = closeMs - WINDOW * 60000;
    const cut = openMs + ENTRY_END * 60000;
    try {
      const j = await get(`${BASE}/markets/trades?ticker=${ticker}` +
        `&min_ts=${Math.floor(openMs / 1000)}&max_ts=${Math.floor(cut / 1000)}&limit=1000`);
      // Per-minute buckets: [netYesSize, totalSize, tradeCount]. Net is signed by who was aggressive.
      const perMin = {};
      for (const t of (j.trades || [])) {
        const ms = Date.parse(t.created_time);
        const m = Math.floor((ms - openMs) / 60000);
        if (m < 0 || m >= ENTRY_END) continue;
        const n = Number(t.count_fp) || 0;
        if (!perMin[m]) perMin[m] = [0, 0, 0];
        perMin[m][0] += t.taker_side === 'yes' ? n : -n;
        perMin[m][1] += n;
        perMin[m][2] += 1;
      }
      store[ticker] = { perMin, capped: (j.trades || []).length >= 1000 };
    } catch (e) { store[ticker] = { perMin: {}, capped: false, failed: true }; }
    done++;
    if (done % 200 === 0) { fs.writeFileSync(OUT, JSON.stringify(store)); console.log(`  ${done}/${todo.length}`); }
    await new Promise(r => setTimeout(r, 260));
  }
  fs.writeFileSync(OUT, JSON.stringify(store));
  const withFlow = Object.values(store).filter(v => Object.keys(v.perMin || {}).length).length;
  const capped = Object.values(store).filter(v => v.capped).length;
  console.log(`flow for ${withFlow} markets (${capped} hit the 1000-trade cap) -> ${OUT}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
