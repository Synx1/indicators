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
const notify = require('./notify');
const activity = require('./activity');
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
    sym: coin.sym, market,
    // The shard this market lives on, taken from Kalshi's own field rather than inferred. The
    // collateral check happens inside that shard's matching engine, so it is what an
    // affordability test has to be measured against.
    exchangeIndex: market.exchange_index == null ? null : Number(market.exchange_index),
    strike, minutesLeft,
    side: r.side, direction: r.side === 'YES' ? 'UP' : 'DOWN',
    confidence: r.confidence, z: r.z, confirm, rsi: Math.round(rsi),
    price, pricePct: Math.round(price * 100), style,
    spot: s.price, spotAgeMs: s.ageMs, candleAgeMs: Math.round(candleAgeMs),
    modelPct: r.confidence, edgePt: Math.round(r.confidence - price * 100)
  };
}

/**
 * The balance a size should be measured against.
 *
 * Live uses the real Kalshi cash; paper uses the configured bankroll plus what it has actually
 * made, because a paper book that sizes off its starting figure forever is not simulating anything
 * — it would bet the same on a doubled account as on a halved one.
 */
function liveOrPaperBalance(t) {
  if (t.get('live')) {
    const real = Number(t.rec.balance);
    const cap = t.get('liveBankroll');
    const bank = Number.isFinite(real) ? real : 0;
    return cap != null ? Math.min(bank, Number(cap)) : bank;
  }
  const eq = book.equity(t.rec.book, {
    start: Number(t.get('paperBankroll')) || 0,
    liveOnly: false,
    sinceMs: t.get('paperResetAt') == null ? null : Number(t.get('paperResetAt'))
  });
  return eq.free;
}

/**
 * How many contracts to buy.
 *
 * Fixed by default. With autoShares on, sized so a trade at the bot's 80¢ CEILING still fits
 * inside riskPerTrade of the balance — deliberately not at the price of THIS signal, because a
 * size that only fits a 30¢ entry would be refused on the next 78¢ one and the account would trade
 * erratically depending on what the book happened to offer.
 *
 * Floors to whole contracts. Kalshi does not sell fractions and rounding up is how an order becomes
 * unaffordable by one contract.
 */
function sharesFor(t, d) {
  const fixed = Math.floor(Number(t.get('shares')) || 0);
  if (!t.get('autoShares')) return fixed;

  const bank = liveOrPaperBalance(t);
  const risk = Number(t.get('riskPerTrade'));
  if (!(bank > 0) || !(risk > 0)) return 0;
  const budget = bank * risk;
  // Auto size DECIDES. An earlier version capped it at the fixed `shares` setting, reasoning that
  // it should only ever size down — but `shares` has a default of 30, so that silently capped a
  // $500 account at the same size as a $100 one and the risk dial looked broken. The safety here is
  // riskPerTrade, plus maxOrderCost if one is set; a leftover default is not a safety rail.
  return Math.floor(budget / MAX_PRICE);
}

// ── applying one decision to every account ──────────────────────

/**
 * Why this account cannot take this decision, or null.
 *
 * Every refusal is a sentence with the numbers in it. A refusal that hides its arithmetic is
 * indistinguishable from a bug, and that cost a real evening on the other bot.
 */
/**
 * Cash on one exchange shard, or null when the split is not known yet.
 *
 * Kalshi's balance endpoint reports a per-shard breakdown; panel.balanceFor() caches it. Null means
 * "no breakdown read yet", which must fall back to the total rather than to zero — refusing every
 * order because a cache is cold would be worse than the bug this exists for.
 */
function shardCash(t, exchangeIndex) {
  if (exchangeIndex == null) return null;
  const byShard = t.rec.balanceShards;
  if (!byShard || typeof byShard !== 'object') return null;
  const v = byShard[String(exchangeIndex)];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function accountBlock(t, d) {
  // Access comes before every other question. Without a key on the clock this account does not trade
  // at all — not live, and not paper either, because a paper book built without access is a record
  // of trades nobody was entitled to run, and it would arrive with a P&L attached the moment a key
  // was entered.
  if (!t.hasAccess()) {
    return t.rec.blocked === true
      ? 'blocked by the owner'
      : (t.rec.accessUntil ? 'access has expired — a new key is needed' : 'no access key entered');
  }

  const b = t.rec.book;

  // ── which book these guards may count ──
  //
  // This entry lands in the LIVE book only when the account is armed (see paperAllowed), so that is
  // the book the three guards below are about. A paper position is not exposure — no money is at
  // stake — and must not hold a live slot. book.js says exactly this about atRisk, and the
  // free-cash check at the bottom already honours it; these three did not, so two paper positions
  // left over from before an arm were quietly holding two of three live slots, and a signal in the
  // same window as one of them would have been refused outright. Scoped, not removed: in paper mode
  // the paper book guards itself the same way.
  const willBeLive = !paperAllowed(t);
  const mine = book.openPositions(b).filter(p => Boolean(p.live) === willBeLive);

  // One position per ticker per account: a second entry on the same round is not a second
  // opinion, it is the same bet twice at a worse average.
  if (mine.some(p => p.ticker === d.market.ticker)) return 'already holding this round';

  // Same-direction positions settling in the SAME window are one leveraged bet, not
  // diversification. bot.js learned this on 2026-08-26: DOGE, XRP and ETH all DOWN in the
  // 05:30 window lost together, $100 -> $35.62. An opposite-direction bet is still allowed
  // because it genuinely hedges.
  const sameWindow = mine.filter(p =>
    p.side === d.side && p.closeTime === d.market.close_time);
  if (sameWindow.length) {
    return `already ${d.direction} in the ${new Date(d.market.close_time).toISOString().slice(11, 16)} ` +
      `window on ${sameWindow[0].sym} — same direction, same settlement, so it is one bet twice`;
  }

  // The backstop on TOTAL exposure. The correlation rule above refuses a second bet in the same
  // direction and window; this stops positions accumulating across DIFFERENT windows until the
  // account is out of money mid-round and Kalshi starts refusing orders. bot.js had it as
  // MAX_POS = 3 and it was not ported with the rest — this closes that gap.
  const openN = mine.length;
  const maxOpen = Number(t.get('maxOpen')) || 3;
  if (openN >= maxOpen) {
    return `${openN} positions already open, at the ${maxOpen} limit`;
  }

  const shares = sharesFor(t, d);
  if (!(shares >= 1)) {
    // Auto size resolving to zero is a real answer, not a misconfiguration, so it says the
    // arithmetic rather than "shares not set".
    if (t.get('autoShares')) {
      const bank = liveOrPaperBalance(t);
      return `auto size works out to 0 contracts — ${users.money(bank)} at ` +
        `${Math.round(Number(t.get('riskPerTrade')) * 100)}% risk is ` +
        `${users.money(bank * Number(t.get('riskPerTrade')))} per trade, and one contract at ` +
        `${MAX_PRICE * 100}¢ costs ${users.money(MAX_PRICE)}`;
    }
    return 'shares per trade is not set';
  }
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

  // ── live: refuse what the account cannot pay for, rather than letting Kalshi refuse it ──
  //
  // The cached balance is CASH, so money already committed to open positions has left it — but a
  // position opened earlier in this same pass has not settled into that figure yet, so at-risk is
  // subtracted to be safe. Refusing here produces a sentence with two numbers in it; letting the
  // order go produces an insufficient-funds rejection that says nothing about how far short it was.
  if (live && t.rec.balance != null) {
    // ── measured against the shard, not the account ──
    //
    // Kalshi holds cash per exchange shard and the matching engine checks the order against the
    // shard the market lives on. $24.17 parked on shard 0 will not back a crypto order on shard 2:
    // that is a "400 insufficient balance" from an account whose balance looks ample. So when the
    // per-shard split is known, the shard's own cash is the figure, and the refusal says where the
    // money actually is rather than repeating a total that cannot be spent here.
    const shard = shardCash(t, d.exchangeIndex);
    const usable = shard == null ? Number(t.rec.balance) : shard;
    const free = +(usable - book.atRisk(b, { liveOnly: true })).toFixed(2);
    if (cost > free) {
      const where = shard == null ? '' :
        `. Your balance is ${users.money(t.rec.balance)} but only ${users.money(shard)} of it is ` +
        `on exchange shard ${d.exchangeIndex}, which is where this market trades — Kalshi checks ` +
        'the order against that shard, so the rest cannot back it until it is transferred';
      return `${users.money(cost)} for ${shares} at ${d.pricePct}¢ but only ` +
        `${users.money(free)} is free` +
        (openN ? ` (${users.money(book.atRisk(b, { liveOnly: true }))} committed to ${openN} open)` : '') +
        `${where}. ${Math.floor(free / d.price)} contracts would fit.`;
    }
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

/**
 * Whether a blocked entry may still be recorded as paper.
 *
 * Paper exists so a decision the bot made is never lost from the record — that is why a live
 * account that cannot trade still gets the paper fill. But ARMED means somebody is watching real
 * money right now, and a paper position landing in that state is worse than a gap: it appears on
 * the live panel, counts nowhere, and reads as the arm having been ignored. It was reported in
 * those words. So armed is the one state where a blocked entry is skipped and says why.
 *
 * Live-but-not-armed still fills paper, because that is what the panel promises out loud when you
 * press Go live: "signals will keep filling as paper until you press Arm".
 */
function paperAllowed(t) {
  return !(t.get('live') && t.get('armed'));
}

/**
 * One DM per distinct rejection reason per half hour.
 *
 * The same refusal arrives on every signal on every market — seven an hour is a notification the
 * user stops reading, which defeats the point of sending it at all. A CHANGED reason is news and
 * goes out immediately.
 */
const REJECT_DM_MS = 30 * 60 * 1000;
const rejectSeen = new Map();
function rejectIsNew(userId, why) {
  const sig = String(why || '').slice(0, 120);
  const prev = rejectSeen.get(userId);
  const now = Date.now();
  if (prev && prev.sig === sig && (now - prev.at) < REJECT_DM_MS) return false;
  rejectSeen.set(userId, { sig, at: now });
  return true;
}

/**
 * What actually filled for one order, from a fills list.
 *
 * ── the bug this exists to make impossible ──
 *
 * This was inline, and it filtered on `f.order_id` while kalshitrade.fills() normalises that field
 * to `orderId`. The filter therefore matched nothing on every order ever placed: `contracts` came
 * out 0, the code took the missed-fill branch, and the user was told "the book moved or nothing was
 * offered" while the position sat filled on the exchange. Four live positions — BTC 2, ETH 2, XRP 7,
 * SOL 14, about $19 — ended up held with no record in the book: no exit management, no settlement,
 * invisible to the position cap, and re-entered because the per-ticker guard could not see them.
 * The price and fee were read from the wrong names too (`yes_price`, `fee_cost_dollars`).
 *
 * So it is one function, it accepts BOTH the normalised and the raw field names, and it is tested
 * against the real payloads. `forSide` prices the raw shape on the leg we actually hold — a NO fill
 * read off `yes_price_dollars` reports an 83c purchase as 17c, which turns a loss into a profit.
 */
function reconcileFills(fills, orderId, forSide) {
  const list = Array.isArray(fills) ? fills : [];
  const mine = list.filter(f => {
    const id = f.orderId != null ? f.orderId : f.order_id;
    return id != null && orderId != null && String(id) === String(orderId);
  });
  const want = String(forSide || '').toUpperCase();
  let contracts = 0;
  let centsTotal = 0;
  let priced = 0;
  let fee = 0;
  for (const f of mine) {
    const rawCount = f.count != null ? f.count : f.count_fp;
    // Rounded: a contract is indivisible, and the fixed-point field has produced 16.01 before,
    // which the book stored and the exit could not clear.
    const n = Math.round(Number(rawCount) || 0);
    if (!(n > 0)) continue;
    contracts += n;

    let cents = f.priceCents != null ? Number(f.priceCents) : null;
    if (cents == null) {
      const side = String(f.outcome_side || f.side || want || '').toUpperCase();
      const leg = want || side;
      const d = leg === 'NO' ? f.no_price_dollars : f.yes_price_dollars;
      if (d != null) cents = Number(d) * 100;
      else {
        const legacy = leg === 'NO' ? f.no_price : f.yes_price;
        if (legacy != null) cents = Number(legacy);
      }
    }
    if (cents != null && Number.isFinite(cents)) { centsTotal += cents * n; priced += n; }

    const feeRaw = f.feeDollars != null ? f.feeDollars : f.fee_cost;
    fee += Number(feeRaw) || 0;
  }
  return {
    contracts,
    // Weighted by contract, over the fills that carried a price. Null rather than 0 when none did:
    // a zero price would record a free position.
    avgCents: priced > 0 ? +(centsTotal / priced).toFixed(2) : null,
    feeDollars: +fee.toFixed(4),
    fills: mine.length
  };
}

async function applyTo(t, d) {
  const why = accountBlock(t, d);
  if (why) return { taken: false, why };

  // The SAME sizer the guard used, or auto size would decide whether a trade is allowed while the
  // fixed number decided how big it is — the two disagreeing is a money bug.
  const shares = sharesFor(t, d);
  const liveWanted = t.get('live');
  const block = liveWanted ? t.liveBlock() : null;

  // Paper whenever live is off, or live is on but something blocks it. A blocked live account
  // still gets the paper record, so the decision is not lost from its history — the reason it
  // did not trade for real is in the log, not a gap in the book.
  if (!liveWanted || block) {
    // Armed and blocked: skip it. See paperAllowed(). The reason travels with the skip so the
    // decisions feed still explains what happened — a daily stop that stops trading silently is
    // indistinguishable from a bot that has died.
    if (!paperAllowed(t)) return { taken: false, why: block || 'armed — paper is off' };
    const fee = decide.fee(d.price, shares);
    const p = record(t, d, {
      contracts: shares, priceCents: d.pricePct, price: d.price,
      cost: +(shares * d.price).toFixed(2), fee, live: false, requested: shares
    });
    await notify.entry(t, p, { live: false });
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
  if (!res.ok) {
    // A rejection is not a market condition. It repeats on every signal until something changes, and
    // with paper off while armed nothing is being recorded in the meantime — so it is recorded on the
    // account, DM'd once, and surfaced by advice.js rather than living in a log line.
    t.rec.lastReject = { why: res.why, sym: d.sym, at: new Date().toISOString(), status: res.status || null };
    t.save();
    if (rejectIsNew(t.userId, res.why)) await notify.orderRejected(t, d, res.why);
    return { taken: false, why: `order rejected: ${res.why}` };
  }

  // Wait the user's grace, then read what actually filled. Never assume the order filled at the
  // limit: a partial at a worse average is the normal case and recording the ask as the fill is
  // how a live book starts flattering itself.
  await new Promise(r => setTimeout(r, (Number(t.get('fillGrace')) || 3) * 1000));
  let fills = null;
  try { fills = await client.fills({ ticker: d.market.ticker, limit: 50, forSide: d.side }); }
  catch (e) { fills = { ok: false, why: e.message }; }

  const orderId = res.order && res.order.order_id;
  const got = (fills && fills.ok && Array.isArray(fills.fills)) ? fills.fills : [];
  const rec0 = reconcileFills(got, orderId, d.side);
  const contracts = rec0.contracts;
  if (!contracts) {
    // Not a rejection and not a fault: the order was placed correctly and nobody sold into it.
    // Said in those words, because the natural reading of silence here is "the bot is broken".
    await notify.missedFill(t, d, { limitCents });
    return { taken: false, why: `no fill at ${limitCents}c — the book moved or nothing was offered` };
  }
  // The LIMIT, not the quote, when the price cannot be read: it is the worst we agreed to pay, so a
  // book that records it can only understate the edge. A quote-priced fallback flatters.
  const avgCents = rec0.avgCents != null ? rec0.avgCents : limitCents;
  const charged = rec0.feeDollars;
  const p = record(t, d, {
    contracts, requested: shares,
    priceCents: +avgCents.toFixed(2), price: +(avgCents / 100).toFixed(4),
    cost: +(contracts * avgCents / 100).toFixed(4),
    // Kalshi's own fee when it reports one, the formula only as a fallback.
    fee: charged > 0 ? +charged.toFixed(2) : kt.feeDollars(contracts, avgCents / 100),
    live: true, orderId: res.order && res.order.order_id,
    slippageCents: +(avgCents - d.pricePct).toFixed(2)
  });
  await notify.entry(t, p, { live: true });
  return { taken: true, live: true, position: p, partial: contracts < shares };
}

// ── exits ───────────────────────────────────────────────────────
//
// Two ways a position ends. The user's cashout price, if they set one, or the exchange grading it
// at the close. Nothing else closes a position: there is no stop, because on this entry band a
// stop books the loss that the round would often have recovered, and holding to a fee-free
// settlement is the measured default.

/** How long after the close before "not graded yet" is worth mentioning once. */
const SETTLE_NOTE_AFTER_MIN = 6;
/** Positions this far past their close with no result are force-graded from the series list. */
const FORCE_AFTER_MIN = 45;

async function getMarket(ticker) {
  try {
    const { data } = await axios.get(`${KALSHI_API_BASE}/markets/${ticker}`, { timeout: 10000 });
    return (data && data.market) || null;
  } catch (_) { return null; }
}

/**
 * The exchange's verdict for a ticker, or null while it is still unknown.
 *
 * Tries the market directly, then the series list, because the single-ticker fetch has been seen
 * to fail for a market that the list still reports correctly. A position stuck open because ONE
 * endpoint was unhappy is the failure this second lookup exists for.
 */
async function resultFor(p) {
  const m = await getMarket(p.ticker);
  if (m && m.result) return String(m.result).toLowerCase();
  if (m && (m.status === 'finalized' || m.status === 'settled') && m.result) {
    return String(m.result).toLowerCase();
  }
  const coin = gl.COINS.find(c => c.sym === p.sym);
  if (!coin) return null;
  try {
    const { data } = await axios.get(
      `${KALSHI_API_BASE}/markets?series_ticker=${coin.series}&status=settled&limit=50`,
      { timeout: 12000 });
    const hit = (data.markets || []).find(x => x.ticker === p.ticker);
    if (hit && hit.result) return String(hit.result).toLowerCase();
  } catch (_) { /* fall through: unknown is a valid answer, a wrong grade is not */ }
  return null;
}

/** What this position could be SOLD at right now — the bid side for YES, 1-ask for NO. */
function sellPrice(p, m) {
  if (!m) return null;
  if (p.side === 'YES') {
    const bid = parseFloat(m.yes_bid_dollars);
    return Number.isFinite(bid) && bid > 0 && bid <= 1 ? bid : null;
  }
  const ask = parseFloat(m.yes_ask_dollars);
  // A MISSING ask must not read as a 100¢ sell price: `1 - 0` is 1.00, which would fire any
  // cashout instantly on a price that does not exist. Absence of an offer is not a price.
  return Number.isFinite(ask) && ask > 0 && ask <= 1 ? 1 - ask : null;
}

/** Close one position for one user, paper or live. */
async function closePosition(t, p, sell, reason) {
  const contracts = p.contracts;
  const proceeds = +(contracts * sell).toFixed(4);
  const exitFee = decide.fee(sell, contracts);

  if (p.live) {
    const client = kt.forUser(auth.forUser(t.userId));
    const slip = Number(t.get('slippageCents')) || 0;
    const limitCents = Math.max(1, Math.min(99, Math.round(sell * 100) - slip));
    const res = await client.placeOrder({
      ticker: p.ticker, side: p.side, action: 'sell',
      count: contracts, limitCents, ioc: true, reduceOnly: true
    });
    if (!res.ok) return { sold: false, why: res.why };
    await new Promise(r => setTimeout(r, (Number(t.get('fillGrace')) || 3) * 1000));
    let f = null;
    try { f = await client.fills({ ticker: p.ticker, limit: 50, forSide: p.side }); }
    catch (_) { f = null; }
    const orderId = res.order && res.order.order_id;
    const got = (f && f.ok && Array.isArray(f.fills)) ? f.fills : [];
    // Same reconciliation as the entry, for the same reason: reading these fields by the wrong
    // names reported every fill as a miss. On a SELL that is worse than on a buy — it would leave a
    // position marked as held when it had actually been sold, and try to sell it again.
    const recx = reconcileFills(got, orderId, p.side);
    const n = recx.contracts;
    // A failed SELL is more serious than a failed buy: the position is STILL EXPOSED with the
    // clock running. Reported as unsold so the next pass tries again.
    if (!n) return { sold: false, why: `no fill at ${limitCents}¢ — still holding` };
    // The limit is the floor we agreed to accept, so it can only understate the proceeds.
    const avg = (recx.avgCents != null ? recx.avgCents : limitCents) / 100;
    const charged = recx.feeDollars;
    const closed = book.close(t.rec.book, p, {
      contracts: n, priceCents: Math.round(avg * 100), price: +avg.toFixed(4),
      proceeds: +(n * avg).toFixed(4),
      fee: charged > 0 ? +charged.toFixed(2) : kt.feeDollars(n, avg), reason
    });
    t.save(); t.noteRealised(closed.pnl);
    return { sold: true, position: closed };
  }

  const closed = book.close(t.rec.book, p, {
    contracts, priceCents: Math.round(sell * 100), price: +sell.toFixed(4),
    proceeds, fee: exitFee, reason
  });
  t.save(); t.noteRealised(closed.pnl);
  return { sold: true, position: closed };
}

/**
 * Walk every account's open positions: cash out what has reached its target, settle what the
 * exchange has graded, and force-grade anything left far too long.
 */
async function checkExits() {
  const now = Date.now();
  // One market fetch per TICKER, shared across every account holding it. Seven markets and five
  // users must not be thirty-five identical requests.
  const quotes = new Map();
  const results = new Map();

  for (const t of users.all()) {
    const target = t.get('cashoutAt');
    for (const p of book.openPositions(t.rec.book).slice()) {
      const closeMs = p.closeMs || (p.closeTime ? new Date(p.closeTime).getTime() : 0);
      const lateMin = closeMs ? (now - closeMs) / 60000 : -1;

      // ── before the close: the cashout target, if there is one ──
      if (lateMin < 0) {
        if (target == null) continue;
        if (!quotes.has(p.ticker)) quotes.set(p.ticker, await getMarket(p.ticker));
        const m = quotes.get(p.ticker);
        if (!m || String(m.status).toLowerCase() !== 'active') continue;
        const sell = sellPrice(p, m);
        if (sell == null || sell < Number(target)) continue;
        const r = await closePosition(t, p, sell, 'CASHOUT');
        if (r.sold) {
          log(`  💰 ${t.rec.tag || t.userId}: cashed out ${p.sym} ${p.direction} ` +
            `${Math.round(p.price * 100)}c → ${Math.round(sell * 100)}c  ${r.position.pnl >= 0 ? '+' : ''}${r.position.pnl}`);
          activity.push({
            sym: p.sym, kind: 'SETTLE', reason: 'cashout',
            detail: `${t.rec.tag || t.userId} — cashed out ${Math.round(p.price * 100)}¢ → ` +
              `${Math.round(sell * 100)}¢, ${r.position.pnl >= 0 ? '+' : ''}${users.money(r.position.pnl)}`,
            meta: { who: t.rec.tag || t.userId, pnl: r.position.pnl, live: p.live }
          });
          await notify.cashout(t, r.position);
        } else {
          log(`  ${t.rec.tag || t.userId}: cashout failed on ${p.sym} — ${r.why}`);
        }
        continue;
      }

      // ── after the close: the exchange's verdict ──
      if (!results.has(p.ticker)) results.set(p.ticker, await resultFor(p));
      const result = results.get(p.ticker);

      if (result !== 'yes' && result !== 'no') {
        // Not graded yet. Said once, so silence is not mistaken for the bot losing the position.
        if (lateMin >= SETTLE_NOTE_AFTER_MIN && !p.lateNoted) {
          p.lateNoted = true; t.save();
          await notify.awaitingSettlement(t, p, lateMin);
          log(`  ⏳ ${p.sym} ${p.ticker} closed ${lateMin.toFixed(0)}m ago, no result yet`);
        }
        if (lateMin >= FORCE_AFTER_MIN) {
          log(`  !! ${p.sym} ${p.ticker} is ${lateMin.toFixed(0)}m past close with no result — ` +
            `leaving it open rather than guessing an outcome`);
        }
        continue;
      }

      const won = (p.side === 'YES' && result === 'yes') || (p.side === 'NO' && result === 'no');
      const closed = book.settle(t.rec.book, p, won);
      t.save(); t.noteRealised(closed.pnl);
      log(`  ${won ? '✅' : '❌'} ${t.rec.tag || t.userId}: ${p.sym} ${p.direction} ` +
        `@${p.priceCents}c → ${won ? '100' : '0'}c  ${closed.pnl >= 0 ? '+' : ''}${closed.pnl}`);
      activity.push({
        sym: p.sym, kind: 'SETTLE', reason: won ? 'won' : 'lost',
        detail: `${t.rec.tag || t.userId} — ${p.direction} @${p.priceCents}¢ settled ` +
          `${won ? '100¢' : '0¢'}, ${closed.pnl >= 0 ? '+' : ''}${users.money(closed.pnl)}`,
        meta: { who: t.rec.tag || t.userId, pnl: closed.pnl, live: p.live, seq: closed.seq }
      });
      await notify.settled(t, closed, won);
    }
  }
}

// ── the loop ────────────────────────────────────────────────────

/**
 * How many accounts may be placing an order at the same moment.
 *
 * The per-account step is a network round trip plus the user's own fill grace (3s by default), so
 * running accounts one after another adds all of that to the pass. At twenty accounts a pass would
 * outlast the freshness of the spot price it was computed from, and a stale spot is not a slow bot
 * — it is the bug that cost this bot 85% of its bankroll once already. Four at a time keeps a pass
 * bounded without turning seven markets into a burst against Kalshi.
 */
const ACCOUNT_CONCURRENCY = 4;

/**
 * Run `fn` over `items`, at most `limit` at a time, returning results in INPUT order.
 *
 * Order matters even though execution does not: the pass log is read as a record of what happened
 * to each account, and interleaving it by whichever network call answered first makes two runs of
 * the same pass look like different events. A thrown error is captured per item rather than
 * rejecting the whole batch — one account's failure must never cost another account its entry.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try { out[i] = { ok: true, value: await fn(items[i], i) }; }
        catch (e) { out[i] = { ok: false, error: e }; }
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/**
 * How stale an armed account's balance may be before the trader re-reads it.
 *
 * Nothing but the Discord panel ever refreshed a balance, so an armed account that nobody had
 * opened the panel for sized itself off a figure from whenever it was last looked at — or off
 * nothing at all. Auto sizing and the free-cash guard both read it, so a stale balance is a wrong
 * size and a guard that cannot fire. Once a minute per armed account is one request a minute.
 */
const BAL_REFRESH_MS = 60000;

/**
 * Re-read the balance of every armed account whose copy has gone stale.
 *
 * Only armed accounts: a paper account sizes off its paper book and asking Kalshi about it would be
 * a request per pass for a number nothing uses. Failures are ignored on purpose — a balance that
 * cannot be read leaves the previous one in place, and the guards treat a missing balance as
 * "unknown" rather than "zero".
 */
async function refreshBalances(accounts) {
  const due = accounts.filter(t =>
    t.get('live') && t.get('armed') && auth.isImported(t.userId) &&
    (!t.rec.balanceAt || (Date.now() - new Date(t.rec.balanceAt).getTime()) > BAL_REFRESH_MS));
  if (!due.length) return;
  await mapLimit(due, ACCOUNT_CONCURRENCY, async t => {
    const b = await kt.forUser(auth.forUser(t.userId)).balance();
    if (b && b.ok) users.noteBalance(t, b);
    else log(`  balance for ${t.rec.tag || t.userId} unreadable: ${b && b.why}`);
  });
}

async function runOnce() {
  stats.passes++;
  const accounts = users.all();

  // A lapse must not leave `armed` set. Otherwise entering a new key weeks later makes the account
  // instantly hot with real money and no fresh human decision — the same reasoning that makes
  // "Go paper" disarm, and that clears arming on every restart.
  for (const t of accounts) {
    if (t.get('armed') && !t.hasAccess()) {
      t.set('armed', 'off');
      log(`  ${t.rec.tag || t.userId}: access lapsed — disarmed`);
    }
  }

  // Before any sizing decision, so the size and the affordability guard are computed against a
  // balance from this minute rather than from whenever somebody last opened the panel.
  try { await refreshBalances(accounts); }
  catch (e) { log(`  !! balance refresh failed: ${e.message}`); }

  // Exits BEFORE entries. A position already carrying money is more urgent than a new one, and
  // settling first also frees the correlation slot so the same window can be re-entered honestly.
  try { await checkExits(); }
  catch (e) { stats.lastError = `exits: ${e.message}`; log(`  !! exits pass failed: ${e.message}`); }

  for (const coin of gl.COINS) {
    let d;
    try { d = await decideFor(coin); }
    catch (e) { noteSkip('error'); stats.lastError = `${coin.sym}: ${e.message}`; continue; }

    if (d.skip) {
      noteSkip(d.skip);
      activity.push({ sym: coin.sym, kind: 'SKIP', reason: d.skip, detail: d.why });
      continue;
    }
    stats.decisions++;
    activity.push({
      sym: coin.sym, kind: 'TAKEN', reason: 'signal',
      detail: `${d.direction} @${d.pricePct}¢ — ${d.confidence}% confidence, ${d.confirm}/4 ` +
        `indicators agreed, ${d.style === 'DIP' ? 'bought a dip' : 'chased a move'}`,
      meta: {
        direction: d.direction, price: d.price, pricePct: d.pricePct,
        confidence: d.confidence, confirm: d.confirm, z: d.z, rsi: d.rsi,
        style: d.style, spot: d.spot, strike: d.strike,
        spotAgeMs: d.spotAgeMs, minutesLeft: +d.minutesLeft.toFixed(2),
        edgePt: d.edgePt, ticker: d.market.ticker, closeTime: d.market.close_time
      }
    });
    log(`  ${coin.sym} ${d.direction} @${d.pricePct}c  conf ${d.confidence}%  ${d.confirm}/4  ` +
      `z=${d.z}  spot ${(d.spotAgeMs / 1000).toFixed(1)}s old  ${d.style}`);

    // Every account decides on the SAME decision object, concurrently but bounded. See mapLimit().
    const results = await mapLimit(accounts, ACCOUNT_CONCURRENCY, t => applyTo(t, d));
    results.forEach((res, i) => {
      const t = accounts[i];
      const who = t.rec.tag || t.userId;
      if (!res.ok) { log(`    ${who}: failed — ${res.error.message}`); return; }
      const r = res.value;
      if (r.taken) {
        stats.entries++;
        log(`    ${who}: ${r.live ? 'LIVE' : 'paper'} ` +
          `${r.position.contracts}× @${r.position.priceCents}c` +
          (r.why && r.why !== 'paper' ? `  (live blocked: ${r.why})` : ''));
        activity.push({
          sym: coin.sym, kind: 'EXIT', reason: r.live ? 'filled-live' : 'filled-paper',
          detail: `${who} — ${r.live ? 'LIVE' : 'paper'} ` +
            `${r.position.contracts}× @${r.position.priceCents}¢, cost ` +
            `${users.money(r.position.cost)}` +
            (r.why && r.why !== 'paper' ? `  (live blocked: ${r.why})` : ''),
          meta: { who, live: r.live, seq: r.position.seq }
        });
      } else {
        log(`    ${who}: skipped — ${r.why}`);
        activity.push({
          sym: coin.sym, kind: 'SKIP', reason: 'account',
          detail: `${who} — ${r.why}`,
          meta: { who }
        });
      }
    });
    // Spaced so seven markets do not arrive at Kalshi as a burst.
    await new Promise(r => setTimeout(r, 300));
  }
  // Stamped at the END, so the panel's Scanner line means "a pass finished" rather than "a pass
  // started" — a loop that wedges mid-pass must show as stale, not as healthy.
  stats.lastPass = new Date().toISOString();
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
  activity,
  sharesFor, liveOrPaperBalance, paperAllowed, mapLimit, shardCash, refreshBalances, reconcileFills,
  start, stop, runOnce, decideFor, applyTo, accountBlock,
  checkExits, closePosition, resultFor, sellPrice, getMarket,
  findActive, getSpot, getCandles, stats,
  MIN_CONF, MIN_CONFIRM, MIN_PRICE, MAX_PRICE, MAX_SPOT_AGE_MS, POLL_MS
};
