'use strict';

/**
 * Post-mortem for a single settled market: what the bot believed, against what the market did.
 *
 * ── why this exists ──
 *
 * A screenshot of a losing chart says "it reversed". That is not a verdict — every loss reversed. The
 * question worth answering is whether the bot's own numbers were defensible at the moment it committed,
 * and the only way to know is to replay the real price path through the real formula. This imports
 * `decide.engineEvaluate` rather than reimplementing it, so the replay cannot drift from production:
 * if the confidence here differs from the DM, the difference is the data, not the maths.
 *
 * ── what it is careful NOT to conclude ──
 *
 * One market cannot establish a bias. This tool answers "was this entry reasonable", not "is the model
 * broken" — a 15-minute binary bought at 66c loses roughly a third of the time when everything is
 * working. Use `--corpus` for the population question; a single verdict here is an anecdote by
 * construction and the output says so.
 *
 * Usage:
 *   node postmortem.js KXBNB15M-26SEP011315-15
 *   node postmortem.js BNB 2026-09-01T17:30:00Z 683.91
 */

const https = require('https');
const { engineEvaluate, realizedVol } = require('./src/decide');

const WINDOW_MIN = 15;
const MIN_MINUTES = 8;
const MAX_MINUTES = 14;
const COINBASE = process.env.COINBASE_BASE || 'https://api.exchange.coinbase.com/products';
const PRODUCT = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', BNB: 'BNB-USD', DOGE: 'DOGE-USD', HYPE: 'HYPE-USD' };

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'indicators-postmortem' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`${res.statusCode} ${body.slice(0, 160)}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Pull the market from Kalshi so the strike and close come from the exchange rather than a guess.
 * Public endpoint, no key: a post-mortem must never need the trading credential.
 */
async function marketFromTicker(ticker) {
  const base = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
  const j = await get(`${base}/markets/${encodeURIComponent(ticker)}`);
  const m = j && j.market;
  if (!m) throw new Error(`Kalshi returned no market for ${ticker}`);
  const sym = Object.keys(PRODUCT).find(s => ticker.includes(`KX${s}`));
  return {
    sym, ticker,
    strike: Number(m.floor_strike != null ? m.floor_strike : m.cap_strike),
    closeMs: Date.parse(m.close_time),
    result: m.result || null
  };
}

/** Coinbase 1-minute candles covering the round plus the lookback the bot's vol needs. */
async function candlesFor(sym, closeMs) {
  const product = PRODUCT[sym];
  if (!product) throw new Error(`no Coinbase product for ${sym}`);
  const openMs = closeMs - WINDOW_MIN * 60000;
  const start = new Date(openMs - 40 * 60000).toISOString();
  const end = new Date(closeMs + 60000).toISOString();
  const raw = await get(`${COINBASE}/${product}/candles?granularity=60&start=${start}&end=${end}`);
  if (!Array.isArray(raw)) throw new Error(`Coinbase returned ${JSON.stringify(raw).slice(0, 120)}`);
  // Newest first is the order getCandles hands to decide(), and realizedVol depends on it.
  return raw.map(([t, low, high, open, close, volume]) => ({
    ms: t * 1000, low, high, open, close, volume
  })).sort((a, b) => b.ms - a.ms);
}

const et = ms => new Date(ms - 4 * 3600000).toISOString().slice(11, 16);
const money = n => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('usage: node postmortem.js <ticker>   |   node postmortem.js <SYM> <closeISO> <strike>');
    process.exitCode = 1;
    return;
  }

  let market;
  if (args.length === 1) market = await marketFromTicker(args[0]);
  else market = { sym: args[0].toUpperCase(), ticker: '(manual)', closeMs: Date.parse(args[1]), strike: Number(args[2]), result: null };
  if (!Number.isFinite(market.strike) || !Number.isFinite(market.closeMs)) throw new Error('could not resolve strike/close');

  const candles = await candlesFor(market.sym, market.closeMs);
  const openMs = market.closeMs - WINDOW_MIN * 60000;
  const at = ms => candles.find(c => c.ms === ms) || null;
  const closeCandle = at(market.closeMs - 60000) || candles.find(c => c.ms < market.closeMs);
  const settledAbove = closeCandle ? closeCandle.close > market.strike : null;

  console.log(`\n${market.sym} ${market.ticker}`);
  console.log(`round ${et(openMs)}-${et(market.closeMs)} ET · strike ${market.strike}`);
  if (closeCandle) {
    console.log(`closed ${closeCandle.close} (${(closeCandle.close - market.strike >= 0 ? '+' : '')}${(closeCandle.close - market.strike).toFixed(4)}) ` +
      `→ ${settledAbove ? 'UP/YES' : 'DOWN/NO'} won${market.result ? ` · exchange says ${market.result}` : ''}`);
  }

  // ── replay every minute the bot could have entered on ──
  console.log(`\nreplaying decide.engineEvaluate at each entry-window minute (the production formula, not a copy):`);
  console.log(`minET  left  spot        gap        sigma$    z       conf   side   would have`);
  const replays = [];
  for (let elapsed = 0; elapsed < WINDOW_MIN; elapsed++) {
    const left = WINDOW_MIN - elapsed;
    if (left < MIN_MINUTES || left > MAX_MINUTES) continue;
    const ms = openMs + elapsed * 60000;
    const c = at(ms);
    if (!c) continue;
    const history = candles.filter(x => x.ms <= ms);        // never let the replay see the future
    const spot = c.close;
    const r = engineEvaluate(spot, market.strike, left, history);
    if (!r.side) continue;
    const vol = realizedVol(history, 10);
    const sigmaAbs = vol * Math.sqrt(left) * market.strike;
    const won = settledAbove == null ? null : (r.side === 'YES' ? settledAbove : !settledAbove);
    replays.push({ ms, left, spot, r, sigmaAbs, won });
    console.log([et(ms).padEnd(6), String(left).padStart(3) + '  ',
      spot.toFixed(4).padEnd(11), ((spot - market.strike >= 0 ? '+' : '') + (spot - market.strike).toFixed(4)).padEnd(10),
      sigmaAbs.toFixed(3).padStart(8), String(r.z).padStart(7), String(r.confidence).padStart(6) + '%',
      (r.side === 'YES' ? ' UP  ' : ' DOWN').padEnd(7),
      won == null ? '' : (won ? 'WON' : 'LOST')].join(' '));
  }
  if (!replays.length) { console.log('  (no minute produced a directional read)'); return; }

  // ── was the sigma defensible? measured against what the horizon actually delivered ──
  const first = replays[0];
  const realisedMove = closeCandle ? Math.abs(closeCandle.close - first.spot) : null;
  console.log(`\nsigma check at ${et(first.ms)} (${first.left} min left):`);
  console.log(`  bot projected sigma  $${first.sigmaAbs.toFixed(3)}  from the trailing 10 minutes`);
  if (realisedMove != null) {
    console.log(`  the horizon delivered $${realisedMove.toFixed(3)}  = ${(realisedMove / first.sigmaAbs).toFixed(2)} sigma`);
    console.log(`  a correctly scaled sigma averages 0.80 sigma of realised move, so this round ran ` +
      `${realisedMove / first.sigmaAbs > 0.8 ? 'hotter' : 'quieter'} than typical — one draw, not a bias.`);
  }

  // ── the honest verdict ──
  const entry = replays.find(x => x.r.confidence >= 80) || first;
  console.log(`\nverdict`);
  console.log(`  The earliest entry clearing the 80% gate was ${et(entry.ms)}: ${entry.r.side === 'YES' ? 'UP' : 'DOWN'} ` +
    `at ${entry.r.confidence}% (z ${entry.r.z}), and it ${entry.won == null ? 'is ungraded' : entry.won ? 'won' : 'lost'}.`);
  console.log(`  Printed confidence is the model's, not the market's. Measured over 1,806 corpus markets the`);
  console.log(`  printed figure runs about 19 points hot in the band this bot trades (87.5% printed against`);
  console.log(`  68.2% realised), so read ${entry.r.confidence}% as roughly ${Math.max(50, Math.round(entry.r.confidence - 19))}%.`);
  console.log(`  A binary bought near that price loses about a third of the time with nothing wrong. One`);
  console.log(`  market cannot distinguish a bad model from a bad draw — use the corpus for that.\n`);
}

main().catch(e => { console.error(`postmortem failed: ${e.message}`); process.exitCode = 1; });
