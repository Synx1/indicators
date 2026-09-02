'use strict';
/**
 * The bare Kalshi read client the arb research shares. Public endpoints only — no key, no account,
 * nothing that can place an order. A scanner that cannot trade cannot cost anything while it learns.
 */
const https = require('https');

/**
 * One pooled, keep-alive agent for every request.
 *
 * Without it each of the 45,030 candlestick fetches pays a fresh TLS handshake, and the handshake —
 * not the exchange's rate limit — is what caps throughput at ~3/s. Reusing sockets is the difference
 * between a four-hour fetch and a twenty-minute one.
 */
const agent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 });

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function get(url, tries = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent, headers: { 'User-Agent': 'indicators-arb', Connection: 'keep-alive' } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          if (tries > 0) return setTimeout(() => get(url, tries - 1).then(resolve, reject), 1100);
          return reject(new Error(`${res.statusCode} after retries`));
        }
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error(`${res.statusCode} ${b.slice(0, 140)}`)); }
      });
    }).on('error', e => (tries > 0 ? setTimeout(() => get(url, tries - 1).then(resolve, reject), 1100) : reject(e)));
  });
}

/**
 * Kalshi's taker fee, to the cent, as the exchange computes it: 7% of the contract's variance,
 * rounded UP on the whole order rather than per contract.
 *
 * The rounding is the part that matters and the part that is easy to get wrong. One contract of a
 * 99¢ NO owes 0.069¢ in theory and 1¢ in practice — a 14x penalty that turns a real edge into a
 * loss. The same order at 100 contracts owes 7¢, or 0.07¢ each. Every number this research reports
 * is computed at the size it would actually be traded at, never per-contract-then-multiplied.
 */
function takerFee(contracts, price) {
  const c = Number(contracts), p = Number(price);
  if (!(c > 0) || !(p > 0) || !(p < 1)) return 0;
  return Math.ceil(0.07 * c * p * (1 - p) * 100) / 100;
}

/** Every open event, with its legs and their top-of-book. ~45 requests for the whole exchange. */
async function openEvents({ log = () => {}, maxPages = 80 } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `${BASE}/events?status=open&limit=200&with_nested_markets=true${cursor ? `&cursor=${cursor}` : ''}`;
    let j;
    try { j = await get(url); }
    catch (e) { log(`  events page ${page + 1} failed: ${e.message}`); break; }
    const evs = j.events || [];
    out.push(...evs);
    cursor = j.cursor;
    if (!cursor || !evs.length) break;
  }
  return out;
}

const num = v => (v == null ? NaN : Number(v));

module.exports = { BASE, get, takerFee, openEvents, num, agent };
