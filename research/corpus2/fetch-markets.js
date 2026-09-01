'use strict';
/**
 * Every settled 15-minute market Kalshi still exposes, for all seven coins.
 *
 * The corpus every finding so far rests on is 1,806 markets over 2.81 days — one regime, and a rally.
 * That is why a 68% headline had a negative second half and why a live afternoon at 50% is not
 * distinguishable from it. Kalshi keeps ~63 days, which is enough to fit on one stretch and test on a
 * different one instead of splitting four days in half.
 *
 * Cheap stage: strike, close and result only. No book yet — the model does not need prices to be
 * fitted, only to be priced, and fetching per-minute books for 40,000 markets would take hours. Books
 * come later and only for the markets a model actually wants to enter.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'markets.json');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE'];

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'indicators-corpus' } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (tries > 0) return setTimeout(() => get(url, tries - 1).then(resolve, reject), 1200);
          return reject(new Error(`${res.statusCode} after retries`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`${res.statusCode} ${body.slice(0, 120)}`)); }
      });
    }).on('error', e => (tries > 0 ? setTimeout(() => get(url, tries - 1).then(resolve, reject), 1200) : reject(e)));
  });
}

(async () => {
  const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  for (const sym of SYMS) {
    if (store[sym] && store[sym].length > 4000) { console.log(`${sym}: cached ${store[sym].length}`); continue; }
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 12; page++) {
      const url = `${BASE}/markets?series_ticker=KX${sym}15M&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;
      let j;
      try { j = await get(url); }
      catch (e) { console.log(`  ${sym} page ${page + 1} failed: ${e.message}`); break; }
      const ms = j.markets || [];
      for (const m of ms) {
        const strike = Number(m.floor_strike != null ? m.floor_strike : m.cap_strike);
        const closeMs = Date.parse(m.close_time);
        // A market with no strike or no graded result teaches nothing and must not become a silent row.
        if (!Number.isFinite(strike) || !Number.isFinite(closeMs)) continue;
        if (m.result !== 'yes' && m.result !== 'no') continue;
        rows.push([m.ticker, closeMs, strike, m.result === 'yes' ? 1 : 0]);
      }
      cursor = j.cursor;
      if (!cursor || !ms.length) break;
      await new Promise(r => setTimeout(r, 220));
    }
    const seen = new Set();
    store[sym] = rows.filter(r => !seen.has(r[0]) && seen.add(r[0])).sort((a, b) => a[1] - b[1]);
    fs.writeFileSync(OUT, JSON.stringify(store));
    const span = store[sym].length ? (store[sym].at(-1)[1] - store[sym][0][1]) / 86400000 : 0;
    console.log(`${sym}: ${store[sym].length} markets over ${span.toFixed(1)} days ` +
      `(${new Date(store[sym][0][1]).toISOString().slice(0, 10)} → ${new Date(store[sym].at(-1)[1]).toISOString().slice(0, 10)})`);
  }
  const total = Object.values(store).reduce((s, a) => s + a.length, 0);
  console.log(`\ntotal ${total} settled markets -> ${OUT}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
