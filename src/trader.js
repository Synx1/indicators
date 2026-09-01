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
 * A paper fill is recorded through the same book.open() as a real one, with the same fee arithmetic
 * — and, since 2026-08-29, the same execution risk. It waits the same fill grace, re-reads the same
 * book, and MISSES when nobody is still offering inside the limit, at the price actually on offer
 * rather than the quote the decision saw.
 *
 * That sentence used to read "the one honest difference is that paper cannot miss a fill", which was
 * the largest remaining flattery in this file: six live orders missed on one day while every paper
 * entry filled perfectly, so paper was scoring a strategy nobody could have executed. Paper is only
 * worth running if it is trying to be wrong in the same ways live is.
 */

const decide = require('./decide');
const gl = require('./markets');
const users = require('./users');
const book = require('./book');
const kt = require('./kalshitrade');
const auth = require('./kalshiauth');
const notify = require('./notify');
const activity = require('./activity');
const shadow = require('./shadow');
const { KALSHI_API_BASE, COINBASE_BASE } = require('./config');

const axios = require('axios');

// ── the indicators bot's own constants, named as it names them ──
/**
 * The confidence floor, lowered from 85 to 83 on 2026-08-29 by measurement rather than by feel.
 *
 * research-frequency.js enumerates every candidate loosely over 1806 collected markets and then
 * varies one gate at a time. Decomposed by confidence band, at the live 80¢ ceiling:
 *
 *   90-101%   +$2.65/trade   +8.7pp margin
 *   83-85%    +$1.99/trade   +6.5pp      <- the band this opens
 *   82-83%    +$1.71/trade   +6.0pp
 *   80-82%    +$1.56/trade   +5.3pp
 *   75-80%    -$0.96/trade   -3.3pp      <- the cliff
 *
 * 83-85% is better per trade than 85-90% (+$0.61), which reads as a contradiction until you notice
 * what confidence buys: a higher model reading means a dearer contract, so the edge lives where the
 * model is confident and the market has NOT finished pricing it. Whole-config, taking the first
 * qualifying look exactly as the live loop does: 416 trades and +$1040.83 against 327 and +$905.73 —
 * 89 more trades (+27%) for +$135 (+15%), $2.50/trade against $2.77, positive in both chronological
 * halves.
 *
 * Not lower than 83, even though 80-82% is profitable in isolation: taking those entries drops the
 * total to +$864, BELOW the 85% baseline. The bot enters on the first qualifying look, so a cheap
 * early entry displaces a better one later in the same market. The sequential simulation is what the
 * bot actually does, so it outranks the bucket arithmetic.
 *
 * bot.js keeps 85 deliberately — gridsearch.js and replay.js enumerate their pools through
 * `bot.MIN_CONF`, so moving it there would silently reprice every historical baseline they print.
 *
 * ── REVERTED to 85 on 2026-08-29, on live evidence ──
 *
 * The replay said 83 was worth +$135 over 1806 markets. Live, on the day, it was losing — so it went
 * back to 85 while that disagreement was explained rather than argued with.
 *
 * ── and then to 80, WITH a 65c ceiling, which is a different change entirely ──
 *
 * Lowering the floor on its own was wrong, and it is worth being precise about why: at an 80c
 * ceiling a looser floor just buys more expensive contracts. The floor and the ceiling are not two
 * independent dials, they are one decision about WHERE the edge is.
 *
 * A competitor bot posts its fills publicly and enters at 51-62c. That is not a better signal, it is
 * a better position: at 51c a win pays +49c and break-even is 51%, while at 79c a win pays +21c and
 * break-even is 79%. Measured on this bot's own 1806 markets (research-value.js), the region it had
 * been designed to avoid:
 *
 *   gate                    n    hit    avg entry   $/trade   break-even   margin
 *   25-80c, conf 85 (was)  327  84.4%      74c       +$2.77      74.8%      +9.6pp
 *   25-65c, conf 80 (now)   97  75.3%      58c       +$4.72      58.7%     +16.6pp
 *
 * 70% more per trade, and the margin over break-even nearly doubles. The margin is the part that
 * matters: the old gate could absorb a 9.6-point fall in hit rate before losing money, and on
 * 2026-08-29 the hit rate fell 8 points and it lost $57.63. The new gate absorbs 16.6, so the same
 * regime shift leaves it profitable instead of underwater. Positive in both chronological halves,
 * and the neighbouring cells agree rather than one lucky corner (65c/83 = 14.8pp, 60c/78 = 14.7pp).
 *
 * Fewer trades — 97 against 327 on the same four days — which is the price of only taking a position
 * where the payoff is not already spent.
 *
 * Same caveat as every other number here: the sample is 2026-08-05..08. This ships to PAPER, which
 * now models missed fills honestly, and the fresh sample is what earns it real money.
 */
const MIN_CONF = 80;
const MIN_CONFIRM = 3;

/**
 * A direction must exist before the fully-priced entry appears.
 *
 * Both 2026-08-31 live losses were the same failure: a first-minute dump made RSI, EMA, Bollinger
 * and VWAP all point DOWN at once, but those are four lagging views of one move. HYPE reversed in
 * the next minute; SOL briefly gained 7c and then crossed the strike. Requiring a direction to have
 * existed for one minute rejects the impulse without pretending volume is a directional oracle.
 *
 * The observer starts at 60%, below the 80% entry floor: it asks only "was this already the model's
 * direction?" The CURRENT read must still clear every real gate. On the 1,806-market corpus this
 * kept 52/61 entries, raised 85.2% -> 86.5%, raised $7.21 -> $7.80/trade, cut max drawdown $39 ->
 * $22, and stayed positive in both halves and all seven coins.
 */
const SIGNAL_OBSERVE_CONF = 60;
const SIGNAL_CONFIRM_MS = 60 * 1000;

function createSignalTracker() {
  const watches = new Map();
  return {
    observe(sym, observation, now = Date.now()) {
      const key = String(sym || '');
      const at = Number(now);
      const valid = key && observation && observation.ticker && observation.side &&
        Number.isFinite(Number(observation.confidence)) &&
        Number(observation.confidence) >= SIGNAL_OBSERVE_CONF && Number.isFinite(at);
      if (!valid) {
        if (key) watches.delete(key);
        return { ready: false, ageMs: 0 };
      }

      let watch = watches.get(key);
      if (!watch || watch.ticker !== observation.ticker || watch.side !== observation.side ||
          at < watch.lastAt) {
        watch = { ticker: observation.ticker, side: observation.side, since: at, lastAt: at };
        watches.set(key, watch);
        return { ready: false, ageMs: 0, since: at };
      }

      watch.lastAt = at;
      const ageMs = Math.max(0, at - watch.since);
      return { ready: ageMs >= SIGNAL_CONFIRM_MS, ageMs, since: watch.since };
    },
    clear(sym) { watches.delete(String(sym || '')); },
    get size() { return watches.size; }
  };
}

const signalTracker = createSignalTracker();

/** Turn a fresh qualifying impulse into a visible skip until its direction has persisted. */
function gateSignal(coin, d, now = Date.now(), tracker = signalTracker) {
  const seen = tracker.observe(coin && coin.sym, d && d.observation, now);
  if (!d || d.skip) return d;
  if (!seen.ready) {
    const ageSec = Math.floor(seen.ageMs / 1000);
    return {
      ...d,
      skip: 'signal-young',
      why: `${d.direction} model direction is only ${ageSec}s old — waiting for ` +
        `${SIGNAL_CONFIRM_MS / 1000}s persistence before entry`,
      skipMeta: {
        direction: d.direction, confidence: d.confidence, confirm: d.confirm,
        signalAgeMs: seen.ageMs, ticker: d.market && d.market.ticker
      }
    };
  }
  return { ...d, signalAgeMs: seen.ageMs };
}

/**
 * Does the model's reading clear the floor?
 *
 * A named predicate rather than an inline comparison for the same reason gradeWin is one: a mutation
 * test on 2026-08-30 changed `>= MIN_CONF` to `> MIN_CONF` — silently discarding every entry at
 * exactly the floor, which is a real slice of the sample — and all twelve suites still passed. The
 * finite check is belt and braces with decide.engineEvaluate's own fail-closed: NaN >= 80 is false,
 * so a garbage reading is refused here too rather than relying on one guard.
 */
function confOK(confidence) {
  return Number.isFinite(confidence) && confidence >= MIN_CONF;
}
/**
 * Is spot far enough from the strike for the reading to be meaningful? See MIN_GAP_PCT.
 *
 * A named predicate for the same reason confOK is one — a mutation from `>=` to `>` or a dropped
 * Math.abs would silently change which trades are taken, and both are one keystroke. The finite
 * check refuses a garbage spot or strike rather than letting NaN sail through: `NaN < floor` is
 * false, so an unguarded comparison would treat unreadable inputs as a clean, distant strike.
 */
function gapOK(spot, strike) {
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || strike === 0) return false;
  return Math.abs((spot - strike) / strike) * 100 >= MIN_GAP_PCT;
}
/**
 * The cheapest this bot will pay, raised from 0.25 on 2026-08-31.
 *
 * This is a test of a hypothesis rather than a tuned dial. Confidence and price are the SAME quantity
 * here — both are P(closes past the strike) — so a 25¢ contract the model calls 85% is a SIXTY-point
 * disagreement with the market. Either that is the richest edge in the book or it is where the model is
 * most wrong, and until now nobody had looked.
 *
 * It is where the model is wrong. research-config-sweep.js over the 1806-market corpus:
 *
 *   >= 25c   n=62  win 83.9%  +$434.67  |  halves 96.8% +$326.50 / 71.0% +$108.17
 *   >= 35c   n=61  win 85.2%  +$439.53  |  halves 96.7% +$315.89 / 74.2% +$123.64
 *   >= 45c   n=58  win 86.2%  +$416.47  |  halves 96.6% +$295.69 / 75.9% +$120.78
 *   >= 50c   n=55  win 87.3%  +$400.06  |  halves 96.3% +$271.81 / 78.6% +$128.25
 *
 * 0.35 costs exactly ONE trade and improves every other number, including the weaker (rally) half —
 * which is the test MIN_MINUTES and MIN_GAP_PCT also had to pass, and the reason this ships where the
 * price-CEILING changes did not. 35c and 40c are identical (nothing trades between them) and the trend
 * continues monotonically to 50c, so it is a plateau rather than a spike.
 *
 * Not pushed further than 0.35 because beyond it the gain stops being free: 50c buys 3.4pp of win rate
 * with $35 of net and seven trades, which is a judgement call rather than a correction.
 */
const MIN_PRICE = 0.35;
/**
 * The dearest this bot will pay. 0.80 until 2026-08-30 — see MIN_CONF above for why it moved and
 * why the two had to move together. src/panel.js and src/advice.js carry this figure for their
 * affordability arithmetic and must be kept in step.
 */
const MAX_PRICE = 0.65;
/**
 * The entry window, raised from 3 minutes to 8 on 2026-08-30.
 *
 * Measured on the band this bot now trades (25-65c, conf 80), holding to settlement, over 1806
 * markets — research-minutes.js:
 *
 *   all minutes      n=97  hit 75.3%  +$4.72/trade  margin 16.6pp   halves $7.82 / $1.68
 *   8+ minutes left  n=74  hit 81.1%  +$6.22/trade  margin 21.8pp   halves $9.11 / $3.33
 *   9+ minutes left  n=68  hit 80.9%  +$6.13/trade  margin 21.5pp
 *
 * 8 rather than 9 because it keeps six more trades at the same margin. The reason to believe it is
 * the halves: it doubles the WEAKER half, $1.68 to $3.33. A filter that improves the bad stretch is
 * the opposite of one fitted to the good one.
 *
 * Mechanically it also narrows what findActive() will even look at, so a round inside eight minutes
 * is no longer a candidate at all — the late entries this drops are the ones where the signal only
 * appeared once the clock had eaten the room to be wrong in.
 */
const MIN_MINUTES = 8;
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
/**
 * How far spot must sit from the strike before the model's confidence is allowed to mean anything.
 *
 * This is a guard against a DEGENERATE CASE, not a tuned dial, and it is the only "raise the win
 * rate" lever that survived 2026-08-31's testing. The model computes
 *
 *   z = gap / sigma,   sigma = realizedVol(10) * sqrt(minutesLeft)
 *
 * so when crypto goes quiet and realizedVol collapses (~0.0001 on this corpus), sigma goes tiny and
 * even a gap of 0.02% divides out to a large z. The result is 80-89% stated confidence on a market
 * where spot is sitting ON the strike with nine minutes to run — which is physically a coin flip.
 * At gap→0 the true probability is 50% whatever the arithmetic says, so this is wrong on first
 * principles, not merely unlucky. LOSS-AUTOPSY.md named the symptom ("87% on a coin flip") and
 * blamed sub-80 confidence; the actual cause is the near-zero gap, and the MIN_CONF gate cannot
 * screen it because confidence is HIGHEST exactly when sigma is smallest.
 *
 * A vol FLOOR was tried for this before and reverted — it halved profit, because inflating sigma
 * everywhere also destroys the legitimate high-conviction reads. This is the direct form: judge the
 * distance, leave the maths alone.
 *
 * Measured over the 1806-market corpus at the live gate (research-mingap.js), 0.03%:
 *
 *   no floor    n=68  win 80.9%  +$416.59  |  halves: +$329.51 (94.1%) / +$87.08 (67.6%)
 *   0.03%       n=62  win 83.9%  +$434.67  |  halves: +$329.51 (94.1%) / +$105.16 (71.4%)
 *   0.04%       n=55  win 87.3%  +$435.84  |  halves: +$314.41 (96.7%) / +$121.43 (76.0%)
 *
 * The reason to believe it is the same reason MIN_MINUTES moved: it improves the WEAKER half — the
 * Aug 7-8 rally that is the closest thing in the data to what hurt the live book — while the good
 * half is untouched. The trades it drops are 53.8% winners: coin flips, as predicted. 0.03 rather
 * than 0.04 because 0.04 cuts BTC from 8 entries to 2, which is closer to disabling a coin than
 * filtering it, and the extra win rate is bought with volume the sample cannot really price.
 *
 * A module constant rather than a per-user setting, exactly like MIN_CONF and MAX_PRICE: this is
 * what a signal IS, not a risk appetite. Reverting it is one line.
 */
const MIN_GAP_PCT = 0.03;
const MAX_CANDLE_AGE_MS = 12 * 60 * 1000;
/**
 * How often a pass runs. 20s until 2026-08-30.
 *
 * A 15-minute binary near its strike has enormous delta: a small spot move swings the contract 20-30
 * cents in seconds. Two paper misses on 2026-08-30 read "wanted 56c, now 82c" and "wanted 52c, now
 * 85c" — not a thin book, a stale quote. Reaction time IS the edge here, so this is as low as the
 * rate limits allow, which is what the candle cache below pays for: a pass now costs two requests per
 * coin instead of three.
 */
const POLL_MS = 6000;
/**
 * How long a live IOC takes to reach the book, used by the paper simulation.
 *
 * NOT fillGrace. Fill grace is how long live waits to see WHETHER an order filled — seconds, on
 * purpose. An order arrives in a few hundred milliseconds, so reading the book a whole fillGrace
 * later made paper miss drift that live never experienced, and paper's job is to be wrong in the
 * same ways live is rather than in worse ones.
 */
const ORDER_LATENCY_MS = 500;

/**
 * One-minute candles, cached for a minute.
 *
 * They are ONE-MINUTE bars: refetching 60 of them every pass was a third of the bot's request budget
 * spent re-reading numbers that had not changed. Caching them is what makes a 6-second poll
 * affordable. Keyed by product, and the freshness guard downstream still judges the newest bar's age,
 * so a stale cache cannot masquerade as a fresh read.
 */
const CANDLE_TTL_MS = 60000;
const candleCache = new Map();

/**
 * Per-coin cooldown after a 429.
 *
 * A six-second poll across seven coins is roughly three requests a second, and the market-data reads
 * are plain axios with no retry — a rate-limited endpoint would simply be hit again 6 seconds later,
 * forever. Backing off ONE coin keeps the other six trading, which is what the old
 * `lastError: "HYPE: 429"` was quietly costing: one unhappy product, the whole pass's error slot.
 */
const COOL_MS = 20000;
const cooling = new Map();
const isCooling = sym => (cooling.get(sym) || 0) > Date.now();
const coolDown = (sym, why) => {
  cooling.set(sym, Date.now() + COOL_MS);
  log(`  ${sym}: backing off ${COOL_MS / 1000}s — ${why}`);
};
/** Does this error mean "you are asking too often"? */
const isRateLimit = e => e && (e.response?.status === 429 || /429/.test(String(e.message)));

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
  const hit = candleCache.get(product);
  if (hit && (Date.now() - hit.at) < CANDLE_TTL_MS) return hit.candles;
  const { data } = await axios.get(`${COINBASE_BASE}/${product}/candles`,
    { params: { granularity: 60 }, timeout: 10000 });
  const candles = (data || []).slice(0, 60).map(c => ({
    time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5]
  }));
  // Only a usable read is cached. Caching an empty answer would hold the whole coin dark for a
  // minute over one bad response.
  if (candles.length) candleCache.set(product, { at: Date.now(), candles });
  return candles;
}

/**
 * Context that lets a settled trade be replayed instead of guessed at later.
 *
 * Volume uses the latest COMPLETED candle against the previous 30 completed candles. The live
 * candle is partial, so comparing it with full minutes makes every early-in-minute entry look
 * falsely quiet. Drift is the signed ten-minute move; positive means price rose, regardless of the
 * side selected. These are diagnostics, not extra gates.
 */
function marketDiagnostics(candles, spot, strike, now = Date.now()) {
  const completed = (candles || [])
    .filter(c => Number.isFinite(Number(c.time)) && Number(c.time) * 1000 + 60000 <= now)
    .sort((a, b) => Number(b.time) - Number(a.time));
  const latest = completed[0] || null;
  const older = completed[Math.min(10, completed.length - 1)] || null;
  const volumeBase = completed.slice(1, 31).filter(c => Number(c.volume) >= 0);
  const avgVolume = volumeBase.length
    ? volumeBase.reduce((sum, c) => sum + Number(c.volume || 0), 0) / volumeBase.length
    : null;
  const finite = n => Number.isFinite(n) ? +n.toFixed(3) : null;
  return {
    gapBps: finite(strike > 0 ? ((spot - strike) / strike) * 1e4 : NaN),
    oneMinuteBps: finite(latest && latest.close > 0 ? ((spot - latest.close) / latest.close) * 1e4 : NaN),
    drift10Bps: finite(latest && older && older.close > 0
      ? Math.log(latest.close / older.close) * 1e4 : NaN),
    volumeRatio: finite(latest && avgVolume > 0 ? Number(latest.volume || 0) / avgVolume : NaN),
    realizedVolBps: finite(completed.length >= 2 ? decide.realizedVol(completed, 10) * 1e4 : NaN)
  };
}

function diagnosticText(d) {
  const bits = [];
  if (Number.isFinite(d.signalAgeMs)) bits.push(`signal ${Math.round(d.signalAgeMs / 1000)}s`);
  if (Number.isFinite(d.gapBps)) bits.push(`gap ${d.gapBps.toFixed(1)}bp`);
  if (Number.isFinite(d.drift10Bps)) bits.push(`drift10 ${d.drift10Bps >= 0 ? '+' : ''}${d.drift10Bps.toFixed(1)}bp`);
  if (Number.isFinite(d.volumeRatio)) bits.push(`volume ${d.volumeRatio.toFixed(2)}x`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
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
  if (isCooling(coin.sym)) {
    return { skip: 'cooling', why: 'backing off after a rate limit' };
  }

  // ── the three inputs at once ──
  //
  // They are independent — two Coinbase reads and one Kalshi read — and running them in series cost
  // most of a second per coin, all of it staleness by the time the price gate ran. The candle read is
  // usually a cache hit, so this is normally two requests in the time one used to take.
  let market, s, candles;
  try {
    [market, s, candles] = await Promise.all([
      findActive(coin.series),
      getSpot(coin.product),
      getCandles(coin.product)
    ]);
  } catch (e) {
    if (isRateLimit(e)) {
      coolDown(coin.sym, 'rate limited by the data feed');
      return { skip: 'cooling', why: 'rate limited — backing off' };
    }
    return { skip: 'error', why: e.message };
  }

  if (!market) return { skip: 'no-window', why: `no round between ${MIN_MINUTES} and ${MAX_MINUTES} minutes out` };

  const strike = parseFloat(market.floor_strike);
  if (!(strike > 0)) return { skip: 'no-strike', why: 'market has no floor strike' };

  if (!s) return { skip: 'no-spot', why: 'ticker unreadable or its timestamp missing' };
  if (s.ageMs > MAX_SPOT_AGE_MS) {
    return { skip: 'stale-spot', why: `spot is ${(s.ageMs / 1000).toFixed(0)}s old` };
  }

  if (!candles.length) return { skip: 'no-candles', why: 'no candle history' };
  const candleAgeMs = Date.now() - candles[0].time * 1000;
  if (candleAgeMs > MAX_CANDLE_AGE_MS) {
    return { skip: 'stale-candles', why: `candles are ${(candleAgeMs / 60000).toFixed(1)}m behind` };
  }

  const minutesLeft = (new Date(market.close_time).getTime() - Date.now()) / 60000;
  const r = decide.engineEvaluate(s.price, strike, minutesLeft, candles);
  if (!r.side) return { skip: 'no-read', why: 'model produced no side' };
  const observation = r.confidence >= SIGNAL_OBSERVE_CONF
    ? { ticker: market.ticker, side: r.side, confidence: r.confidence }
    : null;
  const withObservation = value => observation ? { ...value, observation } : value;
  if (!confOK(r.confidence)) {
    return withObservation({ skip: 'below-conf', why: `${r.confidence}% is under the ${MIN_CONF}% floor` });
  }
  // Distance before conviction. A high confidence computed on a near-zero gap is an artifact of a
  // collapsed sigma, not a read — see MIN_GAP_PCT. Checked after the confidence gate only so the
  // skip log distinguishes "no signal" from "signal the maths should not have produced".
  if (!gapOK(s.price, strike)) {
    const gapPct = Math.abs((s.price - strike) / strike) * 100;
    return withObservation({
      skip: 'on-strike',
      why: `spot is only ${gapPct.toFixed(3)}% from the strike (needs ${MIN_GAP_PCT}%) — ` +
        `${r.confidence}% here is a quiet-market artifact, not an edge`
    });
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
    return withObservation({ skip: 'indicators', why: `only ${confirm}/4 agreed with ${r.side}` });
  }

  // ── price it at the LAST possible moment ──
  //
  // The quote arrived at the top of this function, before the spot check, the model and four
  // indicators. That is a second or more of staleness, and near the strike a 15-minute binary moves
  // 20-30 cents in that time — two paper misses on 2026-08-30 read "wanted 56c, now 82c". The gate
  // and the recorded price must both be what the market is offering NOW, not what it offered before
  // the maths ran. One extra request, and only for candidates that already passed everything else.
  const fresh = await getMarket(market.ticker);
  const quoted = fresh || market;
  const yesAsk = parseFloat(quoted.yes_ask_dollars || 0);
  const noAsk = parseFloat(quoted.no_ask_dollars || 0);
  const price = r.side === 'YES' ? yesAsk : noAsk;
  if (!(price > 0)) return withObservation({ skip: 'no-quote', why: 'nothing offered on our side' });
  if (price < MIN_PRICE) {
    return withObservation({ skip: 'too-cheap', why: `${Math.round(price * 100)}c is under ${MIN_PRICE * 100}c` });
  }
  if (price > MAX_PRICE) {
    // The one skip worth recording rather than only counting. This market cleared EVERY other gate —
    // confidence, the gap floor, three of four indicators, the clock — and was refused solely on price.
    // That makes it the exact population the ceiling question is about, and the live book can never
    // contain it. Recorded to the shadow book and graded at settlement, so "does the edge hold at
    // dearer entries" becomes a measurement instead of an argument. Cannot touch money: shadow.js has
    // no account, no book and no balance in it.
    return withObservation({
      skip: 'too-dear',
      why: `${Math.round(price * 100)}c is over ${MAX_PRICE * 100}c`,
      shadow: price <= shadow.SHADOW_MAX ? {
        ticker: quoted.ticker, sym: coin.sym, side: r.side, price,
        confidence: r.confidence, confirm, closeTime: quoted.close_time || market.close_time
      } : null
    });
  }

  // "Bought the dip" versus "chased a move": whether spot sits against or with the recent mean.
  // Recorded per fill so the two styles are measurable after the fact rather than only named.
  const avgClose = candles.slice(0, 5).reduce((a, c) => a + c.close, 0) / 5;
  const style = (r.side === 'YES')
    ? (s.price < avgClose ? 'DIP' : 'MOVE')
    : (s.price > avgClose ? 'DIP' : 'MOVE');
  const diagnostics = marketDiagnostics(candles, s.price, strike);

  return {
    sym: coin.sym, market: quoted, observation,
    // The shard this market lives on, taken from Kalshi's own field rather than inferred. The
    // collateral check happens inside that shard's matching engine, so it is what an
    // affordability test has to be measured against.
    exchangeIndex: market.exchange_index == null ? null : Number(market.exchange_index),
    strike, minutesLeft,
    side: r.side, direction: r.side === 'YES' ? 'UP' : 'DOWN',
    confidence: r.confidence, z: r.z, confirm, rsi: Math.round(rsi),
    price, pricePct: Math.round(price * 100), style,
    spot: s.price, spotAgeMs: s.ageMs, candleAgeMs: Math.round(candleAgeMs),
    modelPct: r.confidence, edgePt: Math.round(r.confidence - price * 100),
    ...diagnostics
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
/**
 * ── correcting the record, 2026-08-29 ──
 *
 * I claimed three times, including in a commit message, that this function was sizing ABOVE its own
 * riskPerTrade limit — "15 contracts where 25% risk implies 7". It was not. I was dividing by a
 * balance figure that was hours stale.
 *
 * Every live fill that day reconciles exactly with floor(balance × risk / 0.80), and `requested`
 * equals `contracts` on all nineteen of them:
 *
 *     7 contracts  <- balance ~$22    15 <- ~$48    25 <- ~$80
 *
 * The stakes grew because the account grew. There is no sizing bug here.
 *
 * What IS true, and worth more than the bug I invented: this design is aggressive by construction. At
 * 25% risk each position costs a quarter of the account, and a binary loses the entire stake — so
 * four consecutive losses is the account, and six losses at ~$19 is the -$110 of gross losses that
 * made 2026-08-29 a -$57 day. riskPerTrade is the dial that decides how much a bad run costs; the
 * entry gate only decides how often one happens.
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

  // Directional-concentration cap (opt-in, blank = no cap). The same-window rule above refuses two
  // bets one direction/one window; this bounds the SLOWER concentration — a book filling up all one
  // way across DIFFERENT windows, which is the structural short that met the 08-07 rally and bled the
  // live DOWN book. Backtested on the 08-05→08-08 corpus: a cap of 1 lifted win rate 80.9%→83.6% but
  // cut net ($416→$381), because the declined shorts still won 69%. So it is off by default and buys a
  // higher hit rate + smaller drawdown at the cost of expected dollars — the user's call, not mine.
  const rawDirCap = t.get('maxPerDir');
  if (rawDirCap != null && rawDirCap !== '') {
    const dirCap = Number(rawDirCap);
    if (dirCap >= 1) {
      const sameDir = mine.filter(p => p.side === d.side).length;
      if (sameDir >= dirCap) {
        const way = d.side === 'YES' ? 'UP' : 'DOWN';
        return `${sameDir} ${way} position${sameDir === 1 ? '' : 's'} already open, at the ` +
          `${dirCap} same-direction limit`;
      }
    }
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
  p.signalAgeMs = d.signalAgeMs;
  p.gapBps = d.gapBps;
  p.oneMinuteBps = d.oneMinuteBps;
  p.drift10Bps = d.drift10Bps;
  p.volumeRatio = d.volumeRatio;
  p.realizedVolBps = d.realizedVolBps;
  t.save();
  return p;
}

/**
 * Would a live IOC order have filled, and at what price?
 *
 * ── why paper has to be able to MISS ──
 *
 * This module's own header claimed "the one honest difference is that paper cannot miss a fill".
 * That difference is not honest, it is the largest remaining flattery in the paper book. A live
 * order is immediate-or-cancel at quote + slippage: it fills only if somebody is still offering at
 * or below that limit a couple of seconds later, and it fills at THEIR price, not at the quote the
 * decision saw. Six live orders missed on 2026-08-29 and every paper entry that day filled
 * perfectly, so paper was scoring a strategy nobody could have executed.
 *
 * Pure so it can be asserted: the caller re-reads the market and hands the ask over.
 *
 *   askNowCents  what our side is offered at when the order would have arrived, null if nothing is
 *   limitCents   quote + the user's slippage allowance, the most we agreed to pay
 *
 * A missing ask is a MISS rather than a fill at the old price. Absence of an offer is not a price —
 * the same rule sellPrice() already applies on the way out.
 */
function paperFill({ askNowCents, limitCents, quotedCents }) {
  if (askNowCents == null || !Number.isFinite(askNowCents) || askNowCents <= 0) {
    return { filled: false, why: 'nothing offered on our side by the time the order would have landed' };
  }
  if (askNowCents > limitCents) {
    return {
      filled: false,
      why: `the book moved to ${Math.round(askNowCents)}c, past the ${limitCents}c limit`
    };
  }
  // Filled at what was ACTUALLY offered. Better than the quote is a real outcome and is kept; the
  // point is that paper stops assuming the quote it saw is the price it gets.
  const paid = Math.min(askNowCents, limitCents);
  return { filled: true, priceCents: +paid.toFixed(2), quotedCents, slippedCents: +(paid - quotedCents).toFixed(2) };
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

// ── in-pass correlation guard ───────────────────────────────────
//
// accountBlock() enforces one-position-per-round and one-direction-per-window by reading the BOOK.
// But an entry is no longer recorded the instant it is placed: to overlap the fill-grace waits (see
// runOnce), an order is PLACED in one phase and RECONCILED into the book in a later one. Between
// those two phases the position is not in the book yet, so two coins signalling the same direction
// in the same settlement window inside ONE pass would both clear accountBlock and double-bet — the
// failure that took $100 to $35.62 on 2026-08-26. So placement records a lightweight CLAIM per
// account, and every later placement in the same pass checks it. Only the two correctness-critical
// guards live here — same ticker, and same side+window; the position cap stays a book-level
// backstop, since being one over it for a single pass is a lesser fault than a correlated double.
function claimBlock(claims, accountId, d) {
  const cl = claims.get(accountId);
  if (!cl || !cl.length) return null;
  if (cl.some(c => c.ticker === d.market.ticker)) {
    return 'an order is already going in on this round this pass';
  }
  if (cl.some(c => c.side === d.side && c.closeTime === d.market.close_time)) {
    return `already ${d.direction} in the ${new Date(d.market.close_time).toISOString().slice(11, 16)} ` +
      'window this pass — same direction, same settlement, so it would be one bet twice';
  }
  return null;
}
function addClaim(claims, accountId, d) {
  const cl = claims.get(accountId) || [];
  cl.push({ ticker: d.market.ticker, side: d.side, closeTime: d.market.close_time });
  claims.set(accountId, cl);
}
/**
 * Phase one of an entry: guard, size, and PLACE the order — but do NOT wait for the fill.
 *
 * Split out of applyTo so runOnce can place every account's order and then wait on all the
 * fill-grace windows AT ONCE rather than paying each one end to end. A grace served serially across
 * coins aged the quote of every coin behind it, which is itself a cause of the misses this reduces.
 *
 * Returns a terminal result ({taken:false, why}) for a block or a rejection, or {pending} for
 * settleEntry to finish. A CLAIM is recorded the moment an order is committed — see claimBlock.
 */
async function placeEntry(t, d, claims) {
  const why = accountBlock(t, d);
  if (why) return { taken: false, why };
  const cwhy = claimBlock(claims, t.userId, d);
  if (cwhy) return { taken: false, why: cwhy };

  // The SAME sizer the guard used, or auto size would decide whether a trade is allowed while the
  // fixed number decided how big it is — the two disagreeing is a money bug.
  const shares = sharesFor(t, d);
  const liveWanted = t.get('live');
  const block = liveWanted ? t.liveBlock() : null;
  const slip = Number(t.get('slippageCents')) || 0;
  const limitCents = Math.max(1, Math.min(99, d.pricePct + slip));

  // Paper whenever live is off, or live is on but something blocks it. A blocked live account still
  // gets the paper record, so the decision is not lost from its history.
  if (!liveWanted || block) {
    if (!paperAllowed(t)) return { taken: false, why: block || 'armed — paper is off' };
    addClaim(claims, t.userId, d);
    return { pending: { kind: 'paper', shares, limitCents, block } };
  }

  // ── real money ── place now, reconcile later.
  const client = kt.forUser(auth.forUser(t.userId));
  const res = await client.placeOrder({
    ticker: d.market.ticker, side: d.side, action: 'buy',
    count: shares, limitCents, ioc: true
  });
  if (!res.ok) {
    // A rejection repeats on every signal until something changes, and with paper off while armed
    // nothing is being recorded meanwhile — so it is stored on the account, DM'd once, surfaced.
    t.rec.lastReject = { why: res.why, sym: d.sym, at: new Date().toISOString(), status: res.status || null };
    t.save();
    if (rejectIsNew(t.userId, res.why)) await notify.orderRejected(t, d, res.why);
    return { taken: false, why: `order rejected: ${res.why}` };
  }
  addClaim(claims, t.userId, d);
  return { pending: { kind: 'live', shares, limitCents, res } };
}

/**
 * Phase two: wait the grace, read what actually filled, and record it — or report the miss.
 *
 * Handed everything phase one committed to. Every one of these runs concurrently in runOnce, so the
 * grace waits overlap instead of summing — that is the whole point of the split.
 */
async function settleEntry({ t, d, kind, shares, limitCents, res, block }) {
  if (kind === 'paper') {
    // The same execution a live order would have had: wait the order's flight time, re-read the
    // book, and fill only if somebody is still offering inside the limit. Paper that always fills at
    // the quote is a paper book that flatters, and the point of paper is to learn what live would do.
    await new Promise(r => setTimeout(r, ORDER_LATENCY_MS));
    let fresh = await getMarket(d.market.ticker);
    if (!fresh) { await new Promise(r => setTimeout(r, 300)); fresh = await getMarket(d.market.ticker); } // one retry so a transient hiccup doesn't blank the "now" price
    const askNow = fresh
      ? parseFloat(d.side === 'YES' ? fresh.yes_ask_dollars : fresh.no_ask_dollars) * 100
      : null;
    const sim = paperFill({ askNowCents: askNow, limitCents, quotedCents: d.pricePct });
    if (!sim.filled) {
      // Always report the cent that blocked the fill. If the re-read failed, fall back to the ask
      // the market showed at decision time (d.pricePct) so the alert is never blank on the one
      // number the user is watching.
      const nowCents = askNow != null ? Math.round(askNow) : d.pricePct;
      await notify.missedFill(t, d, { limitCents, nowCents });
      return { taken: false, miss: true, live: false, wanted: d.pricePct, limitCents, nowCents, why: `paper missed the fill — ${sim.why}` };
    }
    const price = +(sim.priceCents / 100).toFixed(4);
    const fee = decide.fee(price, shares);
    const p = record(t, d, {
      contracts: shares, priceCents: sim.priceCents, price,
      cost: +(shares * price).toFixed(2), fee, live: false, requested: shares,
      slippageCents: sim.slippedCents
    });
    await notify.entry(t, p, { live: false });
    return { taken: true, live: false, position: p, why: block || 'paper' };
  }
  // ── live ── wait the grace, then read what actually filled. Never assume it filled at the limit:
  // a partial at a worse average is the normal case, and recording the ask as the fill is how a live
  // book starts flattering itself.
  await new Promise(r => setTimeout(r, (Number(t.get('fillGrace')) || 3) * 1000));
  let fills = null;
  try { fills = await kt.forUser(auth.forUser(t.userId)).fills({ ticker: d.market.ticker, limit: 50, forSide: d.side }); }
  catch (e) { fills = { ok: false, why: e.message }; }

  const orderId = res.order && res.order.order_id;
  const got = (fills && fills.ok && Array.isArray(fills.fills)) ? fills.fills : [];
  const rec0 = reconcileFills(got, orderId, d.side);
  const contracts = rec0.contracts;
  if (!contracts) {
    // Placed correctly, nobody sold. Re-read the book so the miss shows WHERE the price went:
    // "wanted 44¢, now 82¢" means no slippage would have caught it; "now 46¢" means one cent would.
    // Public endpoint — no auth, no money — and a failed read just omits the figure.
    let nowCents = null;
    try {
      const fresh = await getMarket(d.market.ticker);
      const ask = fresh
        ? parseFloat(d.side === 'YES' ? fresh.yes_ask_dollars : fresh.no_ask_dollars)
        : NaN;
      if (Number.isFinite(ask) && ask > 0) nowCents = Math.round(ask * 100);
    } catch (_) { /* the miss is worth reporting without the now-price */ }
    await notify.missedFill(t, d, { limitCents, nowCents });
    return { taken: false, miss: true, live: true, wanted: d.pricePct, limitCents, nowCents, why: `no fill at ${limitCents}c — the book moved or nothing was offered` };
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

/**
 * Apply one decision to one account end to end. The single-shot path the tests drive and the
 * definition of correct behaviour; runOnce uses placeEntry/settleEntry directly so it can overlap
 * the waits. A fresh claims map means this path guards purely on the book, exactly as it always did.
 */
async function applyTo(t, d) {
  const r = await placeEntry(t, d, new Map());
  if (!r.pending) return r;
  return settleEntry({ t, d, ...r.pending });
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
    t.save(); t.noteRealised(closed.pnl, closed.live === true);
    return { sold: true, position: closed };
  }

  const closed = book.close(t.rec.book, p, {
    contracts, priceCents: Math.round(sell * 100), price: +sell.toFixed(4),
    proceeds, fee: exitFee, reason
  });
  t.save(); t.noteRealised(closed.pnl, closed.live === true);
  return { sold: true, position: closed };
}

/**
 * Did this position win? The single most expensive line in the file, so it is a named function with
 * a truth table in test/grading.test.js rather than an inline boolean nobody can test.
 *
 * A mutation test on 2026-08-30 INVERTED this expression and all twelve suites still passed — every
 * win would have been booked as a loss and nothing would have said so. Only 'yes' and 'no' grade;
 * anything else (void, empty, not settled yet) must never reach here, and the caller waits instead.
 */
function gradeWin(side, result) {
  return (side === 'YES' && result === 'yes') || (side === 'NO' && result === 'no');
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
      // One position's failure — a notify handler throwing, a disk save erroring — must not skip
      // settlement or cashout for every LATER position in this pass. Each is retried next pass, so
      // abandoning the rest is the only outcome here with a real dollar cost. Entries already have
      // this isolation (per-item catch in the apply loop); exits did not until now.
      try {
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

      const won = gradeWin(p.side, result);
      const closed = book.settle(t.rec.book, p, won);
      t.save(); t.noteRealised(closed.pnl, closed.live === true);
      log(`  ${won ? '✅' : '❌'} ${t.rec.tag || t.userId}: ${p.sym} ${p.direction} ` +
        `@${p.priceCents}c → ${won ? '100' : '0'}c  ${closed.pnl >= 0 ? '+' : ''}${closed.pnl}`);
      activity.push({
        sym: p.sym, kind: 'SETTLE', reason: won ? 'won' : 'lost',
        detail: `${t.rec.tag || t.userId} — ${p.direction} @${p.priceCents}¢ settled ` +
          `${won ? '100¢' : '0¢'}, ${closed.pnl >= 0 ? '+' : ''}${users.money(closed.pnl)}`,
        meta: { who: t.rec.tag || t.userId, pnl: closed.pnl, live: p.live, seq: closed.seq }
      });
      await notify.settled(t, closed, won);
      } catch (e) {
        log(`  !! exit handling failed on ${p.sym} ${p.ticker}: ${e.message} — will retry next pass`);
      }
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
 * How many coins may be fetching market data at once.
 *
 * Four, not seven: these reads are unauthenticated and unretried, and firing twenty-one of them in one
 * instant is how the 429s began. Four still cuts a pass from ~9s to ~2s.
 */
const COIN_CONCURRENCY = 4;

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

  // ── decide for every coin AT ONCE, then apply the decisions IN ORDER ──
  //
  // The two halves have opposite requirements and used to share one sequential loop, which is why a
  // pass took eight to ten seconds and every quote in it aged while the coins ahead were fetched.
  //
  // Deciding is pure of the book: it reads market data and runs maths, so seven coins can do it
  // concurrently. Applying is NOT pure — accountBlock() reads the book to enforce one position per
  // ticker, one direction per settlement window, and the position cap. If two coins both cleared
  // those guards before either recorded a position, an account would take the same bet twice in one
  // window, which is the failure that took $100 to $35.62 on 2026-08-26.
  //
  // So application is two phases. PLACEMENT stays ordered per coin (accounts within a coin still
  // fan out, bounded), and records a lightweight in-pass CLAIM the instant an order is committed so
  // the next coin's guard sees it even though the book has not caught up — see claimBlock. SETTLING
  // — the fill-grace wait, the reconcile, the record — is deferred and run for every placed order AT
  // ONCE, so the waits overlap instead of summing. That is where the eight-to-ten-second pass went.
  //
  // Bounded at four rather than seven: the data reads are unauthenticated and unretried, and a burst
  // of twenty-one of them is how the 429s started.
  const decided = await mapLimit(gl.COINS, COIN_CONCURRENCY, async coin => {
    try { return { coin, d: gateSignal(coin, await decideFor(coin)) }; }
    catch (e) {
      // A thrown feed/quote read produced no trustworthy observation. Do not let a watch from an
      // earlier pass age through that blind spot and qualify as continuous persistence later.
      signalTracker.clear(coin.sym);
      return { coin, err: e };
    }
  });

  const claims = new Map();          // per-account, in-pass: what each account already has an order in on
  const pending = [];                // placed orders whose fill we reconcile after the loop

  // Emit the log + activity for one account's result. Taken/blocked are known at placement; a fill
  // or a miss is known only after the deferred grace wait, so both phases funnel through here.
  const emitEntry = (coin, t, r) => {
    const who = t.rec.tag || t.userId;
    if (r.taken) {
      stats.entries++;
      log(`    ${who}: ${r.live ? 'LIVE' : 'paper'} ${r.position.contracts}× @${r.position.priceCents}c` +
        (r.why && r.why !== 'paper' ? `  (live blocked: ${r.why})` : ''));
      activity.push({
        sym: coin.sym, kind: 'EXIT', reason: r.live ? 'filled-live' : 'filled-paper',
        detail: `${who} — ${r.live ? 'LIVE' : 'paper'} ${r.position.contracts}× @${r.position.priceCents}¢, ` +
          `cost ${users.money(r.position.cost)}` +
          (r.why && r.why !== 'paper' ? `  (live blocked: ${r.why})` : ''),
        meta: { who, live: r.live, seq: r.position.seq }
      });
      return;
    }
    if (r.miss) {
      // The one the user asked to see on the site: what we wanted, what we would pay, where the book
      // actually went. meta.who marks it an account event, so privacy.js redacts identity for the
      // open feed; the cents are not money and survive. See notify.missedFill for the DM.
      log(`    ${who}: MISS — ${r.why}`);
      const past = r.nowCents != null ? r.nowCents - r.limitCents : null;
      activity.push({
        sym: coin.sym, kind: 'MISS', reason: 'missed-fill',
        detail: `${who} — wanted ${r.wanted}¢, limit ${r.limitCents}¢` +
          (r.nowCents != null
            ? `, book moved to ${r.nowCents}¢ (${past >= 0 ? '+' : ''}${past}¢ vs limit)`
            : ', nothing offered on our side'),
        meta: { who, live: r.live, wanted: r.wanted, limit: r.limitCents, now: r.nowCents }
      });
      return;
    }
    log(`    ${who}: skipped — ${r.why}`);
    activity.push({ sym: coin.sym, kind: 'SKIP', reason: 'account', detail: `${who} — ${r.why}`, meta: { who } });
  };

  for (const res of decided) {
    if (!res.ok) { noteSkip('error'); stats.lastError = `pass: ${res.error && res.error.message}`; continue; }
    const { coin, d, err } = res.value;
    if (err) { noteSkip('error'); stats.lastError = `${coin.sym}: ${err.message}`; continue; }

    if (d.skip) {
      noteSkip(d.skip);
      // A too-dear market that cleared every other gate is the sample the ceiling question needs, so
      // it is recorded before the skip is logged. record() is idempotent per ticker: a pass runs every
      // POLL_MS and the same market stays too-dear for minutes, so without that the shadow win rate
      // would be weighted by how long each market sat in the band rather than by signals.
      if (d.shadow) {
        try { shadow.record(d.shadow); }
        catch (e) { log(`  !! shadow record failed for ${coin.sym}: ${e.message}`); }
      }
      activity.push({
        sym: coin.sym, kind: 'SKIP', reason: d.skip, detail: d.why,
        meta: d.skipMeta || null
      });
      continue;
    }
    stats.decisions++;
    activity.push({
      sym: coin.sym, kind: 'TAKEN', reason: 'signal',
      detail: `${d.direction} @${d.pricePct}¢ — ${d.confidence}% confidence, ${d.confirm}/4 ` +
        `indicators agreed, ${d.style === 'DIP' ? 'bought a dip' : 'chased a move'}` +
        diagnosticText(d),
      meta: {
        direction: d.direction, price: d.price, pricePct: d.pricePct,
        confidence: d.confidence, confirm: d.confirm, z: d.z, rsi: d.rsi,
        style: d.style, spot: d.spot, strike: d.strike,
        spotAgeMs: d.spotAgeMs, minutesLeft: +d.minutesLeft.toFixed(2),
        edgePt: d.edgePt, ticker: d.market.ticker, closeTime: d.market.close_time,
        signalAgeMs: d.signalAgeMs, gapBps: d.gapBps, oneMinuteBps: d.oneMinuteBps,
        drift10Bps: d.drift10Bps, volumeRatio: d.volumeRatio,
        realizedVolBps: d.realizedVolBps
      }
    });
    log(`  ${coin.sym} ${d.direction} @${d.pricePct}c  conf ${d.confidence}%  ${d.confirm}/4  ` +
      `z=${d.z}  spot ${(d.spotAgeMs / 1000).toFixed(1)}s old  ${d.minutesLeft.toFixed(1)}m left  ` +
      `${d.style}${diagnosticText(d)}`);

    // PLACE every account's order now (guarded, claim recorded); defer the fill-grace wait so the
    // waits across coins overlap in the settle phase below instead of aging each other's quotes.
    const placed = await mapLimit(accounts, ACCOUNT_CONCURRENCY, t => placeEntry(t, d, claims));
    placed.forEach((r2, i) => {
      const t = accounts[i];
      if (!r2.ok) { log(`    ${t.rec.tag || t.userId}: failed — ${r2.error.message}`); return; }
      const r = r2.value;
      if (r.pending) { pending.push({ t, d, coin, ...r.pending }); return; }
      emitEntry(coin, t, r);   // terminal already: blocked or rejected
    });
  }

  // ── settle every placed order AT ONCE, so the fill-grace waits overlap instead of summing ──
  const settled = await Promise.all(pending.map(async pk => {
    try { return { pk, r: await settleEntry(pk) }; }
    catch (e) { return { pk, r: { taken: false, why: `settle failed — ${e.message}` } }; }
  }));
  for (const { pk, r } of settled) emitEntry(pk.coin, pk.t, r);

  // Grade the shadow book LAST, after the money work, because it is diagnostic and must never delay
  // an exit or an entry. Wrapped whole: a shadow fault is worth a log line and nothing else.
  try { await settleShadows(); }
  catch (e) { log(`  !! shadow settle pass failed: ${e.message}`); }

  // Stamped at the END, so the panel's Scanner line means "a pass finished" rather than "a pass
  // started" — a loop that wedges mid-pass must show as stale, not as healthy.
  stats.lastPass = new Date().toISOString();
}

/**
 * Grade shadow rows whose market has settled.
 *
 * Bounded per pass (SHADOW_SETTLE_PER_PASS) because each row costs a market fetch, and the shadow book
 * accumulates faster than the real one — an unbounded sweep would turn a diagnostic into the reason the
 * data feed rate-limits the trading loop. Rows persist, so anything not reached is graded next pass.
 *
 * Only markets whose close time has actually passed are looked up; asking Kalshi for the result of a
 * round still in progress is a request that can only return nothing.
 *
 * Grading goes through gradeWin — the SAME truth table the real book settles on — so a shadow win and
 * a real win can never come to mean different things.
 */
const SHADOW_SETTLE_PER_PASS = 8;
async function settleShadows() {
  const now = Date.now();
  const due = shadow.pending(40).filter(e => {
    const t = e.closeTime ? new Date(e.closeTime).getTime() : NaN;
    return Number.isFinite(t) && t < now;
  }).slice(0, SHADOW_SETTLE_PER_PASS);
  if (!due.length) return;
  for (const row of due) {
    let result = null;
    try { result = await resultFor({ ticker: row.ticker, sym: row.sym }); }
    catch (_) { continue; }                       // unresolved is normal; try again next pass
    if (!result) continue;
    const graded = shadow.settle(row.ticker, result, gradeWin);
    if (graded) {
      // A market SKIP, so it carries no account and no money — it is a fact about the signal.
      activity.push({
        sym: row.sym, kind: 'SETTLE', reason: 'shadow',
        detail: `shadow ${row.band}: ${row.side === 'YES' ? 'UP' : 'DOWN'} @${row.pricePct}¢ ` +
          `would have ${graded.won ? 'WON' : 'LOST'}`,
        meta: {
          shadow: true, band: row.band, pricePct: row.pricePct,
          confidence: row.confidence, confirm: row.confirm, won: graded.won
        }
      });
    }
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
  activity,
  sharesFor, liveOrPaperBalance, paperAllowed, paperFill, mapLimit, shardCash, refreshBalances,
  reconcileFills,
  start, stop, runOnce, decideFor, applyTo, placeEntry, settleEntry, claimBlock, accountBlock,
  checkExits, closePosition, resultFor, sellPrice, getMarket,
  findActive, getSpot, getCandles, stats, gradeWin, confOK, gapOK, settleShadows,
  createSignalTracker, gateSignal, marketDiagnostics, diagnosticText,
  sharesFor,
  MIN_CONF, MIN_CONFIRM, MIN_PRICE, MAX_PRICE, MIN_MINUTES, MAX_MINUTES,
  SIGNAL_OBSERVE_CONF, SIGNAL_CONFIRM_MS,
  MAX_SPOT_AGE_MS, MIN_GAP_PCT, POLL_MS, ORDER_LATENCY_MS, COIN_CONCURRENCY
};
