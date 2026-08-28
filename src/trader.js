/**
 * The trading loop: one decision path, many accounts.
 *
 * ── what changed from bot.js ──
 *
 * bot.js decides and fills for ONE bankroll held in one JSON file. This decides once per market
 * per round and then applies that decision to every account separately, against each user's own
 * settings, own book and own risk ledger. The decision is shared; the money never is.
 *
 * That split is the whole reason the panel can be multi-account: a signal is a property of the
 * market, so computing it per user would be seven times the API calls for identical answers, and
 * any drift between two users' copies would be a bug nobody could see.
 *
 * ── the gates, in the order they are cheapest to fail ──
 *
 * Market enabled and not killed, then the clock, then a FRESH spot, then the model, then the
 * indicators, then the price band. Ordering matters only for cost: the freshness check comes
 * before the model because a stale spot makes every number after it meaningless — that was the
 * entire V7 failure, where the signal was computed on a price the exchange had already repriced.
 *
 * ── paper and live are the same bookkeeping ──
 *
 * A paper fill is recorded through the same book.open() as a real one, at the same price, with
 * the same fee arithmetic. Paper that fills at a better price than live would is a paper book
 * that flatters, and the whole point of running paper is to learn what live would have done.
 * The one honest difference is that paper cannot miss a fill.
 */

const decide = require('./decide');
const gl = require('./markets');
const users = require('./users');
const book = require('./book');
const kt = require('./kalshitrade');
const auth = require('./kalshiauth');
const { KALSHI_API_BASE, COINBASE_BASE } = require('./config');

const axios = require('axios');

// ── the indicators bot's own constants, named as it names them ──
const MIN_CONF = 85;
const MIN_CONFIRM = 3;
const MIN_PRICE = 0.25;
const MAX_PRICE = 0.80;
const MIN_MINUTES = 3;
const MAX_MINUTES = 14;
/**
 * A spot older than this is not worth trading on.
 *
 * The ticker normally reports a last trade 1-3 seconds old. 45 seconds means the venue has gone
 * quiet or the feed is degraded, and the entire edge here is being timely: a 15-minute binary
 * sits tens of basis points from its strike, so a stale price is a wrong SIDE, not a slightly
 * wrong number. Never falls back to the candle close — that fallback is precisely the defect.
 */
const MAX_SPOT_AGE_MS = 45 * 1000;
const MAX_CANDLE_AGE_MS = 12 * 60 * 1000;
const POLL_MS = 20000;

let log = () => {};
let running = false;
let timer = null;
const stats = { passes: 0, decisions: 0, entries: 0, skips: {}, lastPass: null, lastError: null };

const noteSkip = code => { stats.skips[code] = (stats.skips[code] || 0) + 1; };

// ── market data ─────────────────────────────────────────────────

/**
 * The round that is actually tradeable.
 *
 * The window test doubles as the closed-market guard: a market that has already closed has a
 * negative minutesLeft and fails `> MIN_MINUTES`. That matters because Kalshi's `status=open`
 * query returns recently-closed-but-unsettled markets too — the other bot picked the
 * soonest-closing market from that list, locked onto a dead round, and sat idle for two hours
 * with a perfectly healthy loop.
 */
async function findActive(series) {
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${series}&status=open&limit=10`;
  const { data } = await axios.get(url, { timeout: 15000 });
  const now = Date.now();
  return (data.markets || []).find(m => {
    if (!m || !m.close_time) return false;
    const ml = (new Date(m.close_time).getTime() - now) / 60000;
    return ml > MIN_MINUTES && ml < MAX_MINUTES;
  }) || null;
}

/** Last trade and its age. Returns null rather than a guess — the caller must skip on null. */
async function getSpot(product) {
  try {
    const { data } = await axios.get(`${COINBASE_BASE}/${product}/ticker`, { timeout: 8000 });
    const price = parseFloat(data && data.price);
    if (!(price > 0)) return null;
    const ts = data.time ? new Date(data.time).getTime() : NaN;
    // A missing timestamp means freshness cannot be PROVEN, and an unprovable spot is stale.
    if (!Number.isFinite(ts)) return null;
    return { price, ageMs: Date.now() - ts };
  } catch (_) { return null; }
}

async function getCandles(product) {
  const { data } = await axios.get(`${COINBASE_BASE}/${product}/candles`,
    { params: { granularity: 60 }, timeout: 10000 });
  return (data || []).slice(0, 60).map(c => ({
    time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5]
  }));
}

// ── one market, one decision ────────────────────────────────────

/**
 * Decide for one market. Returns a decision, or a skip with the reason.
 *
 * Pure of side effects beyond the network reads, so the loop can be reasoned about and the same
 * function can be driven by a test.
 */
async function decideFor(coin) {
  const blocked = gl.marketBlock(coin.sym);
  if (blocked) return { skip: 'disabled', why: blocked };

  const market = await findActive(coin.series);
  if (!market) return { skip: 'no-window', why: 'no round between 3 and 14 minutes out' };

  const strike = parseFloat(market.floor_strike);
  if (!(strike > 0)) return { skip: 'no-strike', why: 'market has no floor strike' };

  const s = await getSpot(coin.product);
  if (!s) return { skip: 'no-spot', why: 'ticker unreadable or its timestamp missing' };
  if (s.ageMs > MAX_SPOT_AGE_MS) {
    return { skip: 'stale-spot', why: `spot is ${(s.ageMs / 1000).toFixed(0)}s old` };
  }

  const candles = await getCandles(coin.product);
  if (!candles.length) return { skip: 'no-candles', why: 'no candle history' };
  const candleAgeMs = Date.now() - candles[0].time * 1000;
  if (candleAgeMs > MAX_CANDLE_AGE_MS) {
    return { skip: 'stale-candles', why: `candles are ${(candleAgeMs / 60000).toFixed(1)}m behind` };
  }

  const minutesLeft = (new Date(market.close_time).getTime() - Date.now()) / 60000;
  const r = decide.engineEvaluate(s.price, strike, minutesLeft, candles);
  if (!r.side) return { skip: 'no-read', why: 'model produced no side' };
  if (r.confidence < MIN_CONF) {
    return { skip: 'below-conf', why: `${r.confidence}% is under the ${MIN_CONF}% floor` };
  }

  // ── the four indicators ──
  const rsi = decide.calcRSI(candles);
  const ema9 = decide.calcEMA(candles, 9);
  const ema20 = decide.calcEMA(candles, 20);
  const bb = decide.calcBollingerBands(candles);
  const vwap = decide.calcVWAP(candles);
  let confirm = 0;
  if (r.side === 'YES') {
    if (rsi > 50) confirm++;
    if (ema9 > ema20) confirm++;
    if (bb && s.price > bb.middle) confirm++;
    if (s.price > vwap) confirm++;
  } else {
    if (rsi < 50) confirm++;
    if (ema9 < ema20) confirm++;
    if (bb && s.price < bb.middle) confirm++;
    if (s.price < vwap) confirm++;
  }
  if (confirm < MIN_CONFIRM) {
    return { skip: 'indicators', why: `only ${confirm}/4 agreed with ${r.side}` };
  }

  const yesAsk = parseFloat(market.yes_ask_dollars || 0);
  const noAsk = parseFloat(market.no_ask_dollars || 0);
  const price = r.side === 'YES' ? yesAsk : noAsk;
  if (!(price > 0)) return { skip: 'no-quote', why: 'nothing offered on our side' };
  if (price < MIN_PRICE) return { skip: 'too-cheap', why: `${Math.round(price * 100)}c is under ${MIN_PRICE * 100}c` };
  if (price > MAX_PRICE) return { skip: 'too-dear', why: `${Math.round(price * 100)}c is over ${MAX_PRICE * 100}c` };

  // "Bought the dip" versus "chased a move": whether spot sits against or with the recent mean.
  // Recorded per fill so the two styles are measurable after the fact rather than only named.
  const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
  const style = (r.side === 'YES')
    ? (s.price < avgClose ? 'DIP' : 'MOVE')
    : (s.price > avgClose ? 'DIP' : 'MOVE');

  return {
    sym: coin.sym, market, strike, minutesLeft,
    side: r.side, direction: r.side === 'YES' ? 'UP' : 'DOWN',
    confidence: r.confidence, z: r.z, confirm, rsi: Math.round(rsi),
    price, pricePct: Math.round(price * 100), style,
    spot: s.price, spotAgeMs: s.ageMs, candleAgeMs: Math.round(candleAgeMs),
    modelPct: r.confidence, edgePt: Math.round(r.confidence - price * 100)
  };
}

// ── applying one decision to every account ──────────────────────

/**
 * Why this account cannot take this decision, or null.
 *
 * Every refusal is a sentence with the numbers in it. A refusal that hides its arithmetic is
 * indistinguishable from a bug, and that cost a real evening on the other bot.
 */
function accountBlock(t, d) {
  const b = t.rec.book;
  // One position per ticker per account: a second entry on the same round is not a second
  // opinion, it is the same bet twice at a worse average.
  if (book.openOnTicker(b, d.market.ticker).length) return 'already holding this round';

  // Same-direction positions settling in the SAME window are one leveraged bet, not
  // diversification. bot.js learned this on 2026-08-26: DOGE, XRP and ETH all DOWN in the
  // 05:30 window lost together, $100 -> $35.62. An opposite-direction bet is still allowed
  // because it genuinely hedges.
  const sameWindow = book.openPositions(b).filter(p =>
    p.side === d.side && p.closeTime === d.market.close_time);
  if (sameWindow.length) {
    return `already ${d.direction} in the ${new Date(d.market.close_time).toISOString().slice(11, 16)} ` +
      `window on ${sameWindow[0].sym} — same direction, same settlement, so it is one bet twice`;
  }

  const shares = Number(t.get('shares')) || 0;
  if (!(shares >= 1)) return 'shares per trade is not set';
  const cost = +(shares * d.price).toFixed(2);

  const cap = t.get('maxOrderCost');
  if (cap != null && cost > Number(cap)) {
    return `${users.money(cost)} for ${shares} at ${d.pricePct}c is over the ` +
      `${users.money(cap)} per-order cap`;
  }

  const live = t.get('live');
  const bankroll = live ? t.get('liveBankroll') : t.get('paperBankroll');
  // Half the bankroll in one position is the ceiling bot.js used; kept, because the failure it
  // guards against is the correlated one above going wrong anyway.
  if (bankroll != null && cost > Number(bankroll) * 0.5) {
    return `${users.money(cost)} is over half of the ${users.money(bankroll)} bankroll`;
  }
  return null;
}

/** Record a fill — paper or real — through the same book. */
function record(t, d, fill) {
  const decision = {
    side: d.side, strike: d.strike, spot: d.spot, confidence: d.confidence,
    edgePt: d.edgePt, modelPct: d.modelPct, midPct: d.pricePct, minutesLeft: d.minutesLeft,
    pricePct: d.pricePct, spotAgeMs: d.spotAgeMs, spotSource: 'ticker'
  };
  const p = book.open(t.rec.book, { sym: d.sym, decision, market: d.market, fill });
  // Style and the indicator count ride along, so "bought the dip" versus "chased a move" and
  // 3-of-4 versus 4-of-4 are answerable from the record instead of only from a log line.
  p.style = d.style;
  p.confirm = d.confirm;
  p.z = d.z;
  p.candleAgeMs = d.candleAgeMs;
  t.save();
  return p;
}

async function applyTo(t, d) {
  const why = accountBlock(t, d);
  if (why) return { taken: false, why };

  const shares = Number(t.get('shares'));
  const liveWanted = t.get('live');
  const block = liveWanted ? t.liveBlock() : null;

  // Paper whenever live is off, or live is on but something blocks it. A blocked live account
  // still gets the paper record, so the decision is not lost from its history — the reason it
  // did not trade for real is in the log, not a gap in the book.
  if (!liveWanted || block) {
    const fee = decide.fee(d.price, shares);
    const p = record(t, d, {
      contracts: shares, priceCents: d.pricePct, price: d.price,
      cost: +(shares * d.price).toFixed(2), fee, live: false, requested: shares
    });
    return { taken: true, live: false, position: p, why: block || 'paper' };
  }

  // ── real money ──
  const client = kt.forUser(auth.forUser(t.userId));
  const slip = Number(t.get('slippageCents')) || 0;
  const limitCents = Math.max(1, Math.min(99, d.pricePct + slip));
  const res = await client.placeOrder({
    ticker: d.market.ticker, side: d.side, action: 'buy',
    count: shares, limitCents, ioc: true
  });
  if (!res.ok) return { taken: false, why: `order rejected: ${res.why}` };

  // Wait the user's grace, then read what actually filled. Never assume the order filled at the
  // limit: a partial at a worse average is the normal case and recording the ask as the fill is
  // how a live book starts flattering itself.
  await new Promise(r => setTimeout(r, (Number(t.get('fillGrace')) || 3) * 1000));
  let fills = null;
  try { fills = await client.fills({ ticker: d.market.ticker, limit: 50 }); }
  catch (e) { fills = { ok: false, why: e.message }; }

  const got = (fills && fills.ok && Array.isArray(fills.fills))
    ? fills.fills.filter(f => f.order_id === (res.order && res.order.order_id))
    : [];
  const contracts = got.reduce((a, f) => a + (Number(f.count) || 0), 0);
  if (!contracts) {
    return { taken: false, why: `no fill at ${limitCents}c — the book moved or nothing was offered` };
  }
  const centsTotal = got.reduce((a, f) => a + (Number(f.yes_price ?? f.price) || 0) * (Number(f.count) || 0), 0);
  const avgCents = centsTotal / contracts;
  const charged = got.reduce((a, f) => a + (Number(f.fee_cost_dollars ?? 0) || 0), 0);
  const p = record(t, d, {
    contracts, requested: shares,
    priceCents: +avgCents.toFixed(2), price: +(avgCents / 100).toFixed(4),
    cost: +(contracts * avgCents / 100).toFixed(4),
    // Kalshi's own fee when it reports one, the formula only as a fallback.
    fee: charged > 0 ? +charged.toFixed(2) : kt.feeDollars(contracts, avgCents / 100),
    live: true, orderId: res.order && res.order.order_id,
    slippageCents: +(avgCents - d.pricePct).toFixed(2)
  });
  return { taken: true, live: true, position: p, partial: contracts < shares };
}

// ── the loop ────────────────────────────────────────────────────

async function runOnce() {
  stats.passes++;
  stats.lastPass = new Date().toISOString();
  const accounts = users.all();

  for (const coin of gl.COINS) {
    let d;
    try { d = await decideFor(coin); }
    catch (e) { noteSkip('error'); stats.lastError = `${coin.sym}: ${e.message}`; continue; }

    if (d.skip) { noteSkip(d.skip); continue; }
    stats.decisions++;
    log(`  ${coin.sym} ${d.direction} @${d.pricePct}c  conf ${d.confidence}%  ${d.confirm}/4  ` +
      `z=${d.z}  spot ${(d.spotAgeMs / 1000).toFixed(1)}s old  ${d.style}`);

    for (const t of accounts) {
      try {
        const r = await applyTo(t, d);
        if (r.taken) {
          stats.entries++;
          log(`    ${t.rec.tag || t.userId}: ${r.live ? 'LIVE' : 'paper'} ` +
            `${r.position.contracts}× @${r.position.priceCents}c` +
            (r.why && r.why !== 'paper' ? `  (live blocked: ${r.why})` : ''));
        } else {
          log(`    ${t.rec.tag || t.userId}: skipped — ${r.why}`);
        }
      } catch (e) {
        log(`    ${t.rec.tag || t.userId}: failed — ${e.message}`);
      }
    }
    // Spaced so seven markets do not arrive at Kalshi as a burst.
    await new Promise(r => setTimeout(r, 300));
  }
}

function start(opts = {}) {
  log = opts.log || log;
  if (running) return false;
  running = true;
  const tick = async () => {
    try { await runOnce(); }
    catch (e) { stats.lastError = e.message; log(`  !! trader pass failed: ${e.message}`); }
    if (running) timer = setTimeout(tick, POLL_MS);
    if (timer && timer.unref) timer.unref();
  };
  tick();
  log(`  trader: scanning ${gl.enabledSyms().length} market(s) every ${POLL_MS / 1000}s`);
  return true;
}

function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }

module.exports = {
  start, stop, runOnce, decideFor, applyTo, accountBlock,
  findActive, getSpot, getCandles, stats,
  MIN_CONF, MIN_CONFIRM, MIN_PRICE, MAX_PRICE, MAX_SPOT_AGE_MS, POLL_MS
};
