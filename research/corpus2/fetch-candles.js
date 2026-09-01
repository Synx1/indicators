'use strict';
/**
 * 1-minute underlying candles covering the whole market corpus, per coin.
 *
 * Stored as [ms, low, high, close, volume] — open is unused and the file is large enough already.
 * Thin coins have minutes with no trades and therefore no candle; the gaps are left as gaps rather than
 * filled, because a synthetic bar would become a feature the live bot never sees.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'candles');
const MARKETS = path.join(__dirname, 'markets.json');
const PRODUCT = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', BNB: 'BNB-USD', DOGE: 'DOGE-USD', HYPE: 'HYPE-USD' };
const CHUNK = 290 * 60000;

function get(url, tries = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'indicators-corpus' } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (tries > 0) return setTimeout(() => get(url, tries - 1).then(resolve, reject), 1500);
          return reject(new Error(`${res.statusCode}`));
        }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`${res.statusCode} ${b.slice(0, 100)}`)); }
      });
    }).on('error', e => (tries > 0 ? setTimeout(() => get(url, tries - 1).then(resolve, reject), 1500) : reject(e)));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const markets = JSON.parse(fs.readFileSync(MARKETS, 'utf8'));
  for (const [sym, product] of Object.entries(PRODUCT)) {
    const file = path.join(OUT, `${sym}.json`);
    if (fs.existsSync(file)) {
      const n = JSON.parse(fs.readFileSync(file, 'utf8')).length;
      if (n > 50000) { console.log(`${sym}: cached ${n}`); continue; }
    }
    const rows = markets[sym] || [];
    if (!rows.length) continue;
    // 90 minutes of lead-in so the first market's indicator lookbacks are not truncated.
    const from = rows[0][1] - 105 * 60000;
    const to = rows.at(-1)[1] + 60000;
    const out = [];
    let done = 0;
    const chunks = Math.ceil((to - from) / CHUNK);
    for (let s = from; s < to; s += CHUNK) {
      const e = Math.min(s + CHUNK, to);
      try {
        const raw = await get(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=60&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`);
        if (Array.isArray(raw)) for (const [t, low, high, , close, volume] of raw) out.push([t * 1000, low, high, close, volume]);
      } catch (err) { /* a lost chunk is a gap, not a failure — the join skips minutes it lacks */ }
      done++;
      if (done % 50 === 0) process.stdout.write(`  ${sym} ${done}/${chunks} chunks, ${out.length} candles\n`);
      await new Promise(r => setTimeout(r, 230));
    }
    const seen = new Set();
    const clean = out.filter(c => !seen.has(c[0]) && seen.add(c[0])).sort((a, b) => a[0] - b[0]);
    fs.writeFileSync(file, JSON.stringify(clean));
    console.log(`${sym}: ${clean.length} candles over ${((clean.at(-1)[0] - clean[0][0]) / 86400000).toFixed(1)} days`);
  }
  console.log('candles done');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
