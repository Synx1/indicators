'use strict';

/**
 * Per-minute books for a stratified sample of markets.
 *
 * A decision rule cannot be scored without the price it would have paid, and Kalshi serves books one
 * market at a time — 45,030 requests is hours. So this samples N markets per day per coin, spread
 * across the whole 68 days, which measures a rule's win rate and ROI to within a point or two while
 * keeping every regime in the sample. Sampling by DAY rather than at random matters: a uniform random
 * draw over a corpus with uneven daily density quietly overweights the busiest days.
 *
 * Deterministic sampling (a fixed stride, not Math.random) so a rerun scores the same markets and two
 * rules are always compared on identical rows.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'books.json');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const PER_DAY_PER_COIN = Number(process.env.PER_DAY || 6);
const DAY = 86400000;

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'indicators-corpus' } }, res => {
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

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

(async () => {
  const markets = JSON.parse(fs.readFileSync(path.join(DIR, 'markets.json'), 'utf8'));
  const store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

  // Build the sample: stride through each (coin, day) bucket so the picks are spread within the day too.
  const wanted = [];
  for (const [sym, rows] of Object.entries(markets)) {
    const byDay = new Map();
    for (const r of rows) {
      const d = Math.floor(r[1] / DAY);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    for (const [, list] of byDay) {
      const stride = Math.max(1, Math.floor(list.length / PER_DAY_PER_COIN));
      for (let i = 0; i < list.length && wanted.length % 1e9 >= 0; i += stride) {
        wanted.push([sym, list[i][0], list[i][1], list[i][2], list[i][3]]);
        if (Math.floor(i / stride) + 1 >= PER_DAY_PER_COIN) break;
      }
    }
  }
  const todo = wanted.filter(w => !store[w[1]]);
  console.log(`sample ${wanted.length} markets · ${todo.length} still to fetch · ~${(todo.length * 0.26 / 60).toFixed(0)} min`);

  let done = 0, failed = 0;
  for (const [sym, ticker, closeMs] of todo) {
    const openMs = closeMs - 15 * 60000;
    const url = `${BASE}/series/KX${sym}15M/markets/${ticker}/candlesticks` +
      `?start_ts=${Math.floor(openMs / 1000)}&end_ts=${Math.floor(closeMs / 1000)}&period_interval=1`;
    try {
      const j = await get(url);
      const cs = j.candlesticks || [];
      // Keep only what a decision needs: the minute and both asks. yes_ask is quoted; the NO ask is
      // 1 - yes_bid, because selling YES at the bid is what buying NO costs.
      const rows = [];
      for (const c of cs) {
        const ts = Number(c.end_period_ts) * 1000;
        const ya = num(c.yes_ask && c.yes_ask.close_dollars);
        const yb = num(c.yes_bid && c.yes_bid.close_dollars);
        if (ts && ya != null && yb != null) rows.push([ts, +ya.toFixed(4), +yb.toFixed(4)]);
      }
      store[ticker] = rows;
    } catch (e) { failed++; store[ticker] = []; }
    done++;
    if (done % 200 === 0) { fs.writeFileSync(OUT, JSON.stringify(store)); console.log(`  ${done}/${todo.length} (${failed} failed)`); }
    await new Promise(r => setTimeout(r, 240));
  }
  fs.writeFileSync(OUT, JSON.stringify(store));
  const priced = Object.values(store).filter(v => v.length).length;
  console.log(`books for ${priced} markets (${failed} failed) -> ${OUT}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
