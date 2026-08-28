/**
 * Kalshi TRADING client — the authenticated half of the API, bound to one user.
 *
 * src/kalshi.js is public market data and deliberately sends no credentials. This
 * module is everything that requires a signature: the account balance, the
 * positions, and the order endpoints that move money. They are separate files
 * because they carry different risk. A bug in the read-only client wastes a poll; a
 * bug in this one buys the wrong thing, for the wrong person.
 *
 * ── forUser() is the whole design ──
 *
 * There is no module-level credential and no default account. A client is built for
 * one user and closes over their auth provider, so it cannot be re-pointed at
 * another account afterwards. In a bot holding several people's trading keys, the
 * question "could this place an order on the wrong account" should be answerable
 * structurally rather than by reading every call site.
 *
 * ── prices are integer CENTS here ──
 *
 * Every other module works in dollars as a 0-1 probability, because that is what the
 * model produces and what `yes_bid_dollars` reports. The order API takes `yes_price`
 * / `no_price` as WHOLE CENTS, 1-99. The conversion happens at this boundary and
 * nowhere else, and the parameter is named `limitCents` so a dollars value passed by
 * mistake is visible at the call site rather than silently becoming a 1-cent order.
 *
 * ── buying NO is not selling YES ──
 *
 * Kalshi has genuine NO contracts. To take the DOWN side the order is
 * `{ side: 'no', action: 'buy', no_price: <cents> }`, not a sell of YES. Selling YES
 * you do not hold is a different instruction. markets.sideLabel() maps YES/NO to
 * UP/DOWN for display; the exchange's vocabulary is preserved everywhere that touches
 * this file, because a sign error here is unrecoverable.
 *
 * ── the throttle is shared across users, on purpose ──
 *
 * One queue for every account. Kalshi rate-limits per credential, but the practical
 * failure this prevents is different: ten users scanning the same six markets on the
 * same 20-second clock produce a burst that looks like an attack, and a 429 storm
 * would delay an EXIT order. Serialising everything keeps the request rate
 * predictable no matter how many users are armed, and an exit that arrives late is
 * the one request in this bot with a direct dollar cost.
 */

const axios = require('axios');
const crypto = require('crypto');

const { KALSHI_API_BASE } = require('./config');

const api = axios.create({
  baseURL: KALSHI_API_BASE,
  timeout: 20000,
  headers: { Accept: 'application/json' }
});

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Parse a number out of a field that may be a decimal STRING, a number, or absent.
 *
 * The V2 schema reports money and quantities as strings ("0.5600", "10.00") to avoid
 * float ambiguity on the wire. Returns null rather than 0 for absent, because 0 is a
 * legitimate price and a missing field is not — conflating them is how a fee of unknown
 * size becomes a fee of zero.
 */
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

/**
 * Translate (contract side, action, our price) into the exchange's (book_side, yes price).
 *
 * Extracted and exported so it can be tested without a network call. This is the single
 * highest-risk conversion in the project — get it backwards and the bot buys the exact
 * opposite of what the model chose, at a price that looks plausible — so it is one pure
 * function with the published truth table beside it and a test that asserts all four rows.
 *
 * From https://docs.kalshi.com/getting_started/order_direction : `bid ≡ yes, ask ≡ no,
 * always`, and "direction does not change the price" — an order's price is always on the
 * YES scale whichever side you take.
 *
 *   legacy action  legacy side   outcome_side   book_side
 *   buy            yes           yes            bid
 *   sell           no            yes            bid
 *   buy            no            no             ask
 *   sell           yes           no             ask
 *
 * So: `bid` when the order increases long-YES exposure, `ask` when it increases long-NO
 * exposure. Worked through against a 34/40 book:
 *
 *   buy  YES @66c  ->  bid @0.66   (lifting the yes ask)
 *   buy  NO  @66c  ->  ask @0.34   (offering yes at 34c == buying no at 66c)
 *   sell YES @92c  ->  ask @0.92
 *   sell NO  @30c  ->  bid @0.70   (bidding yes at 70c == selling no at 30c)
 *
 * @param {'YES'|'NO'} contractSide
 * @param {'buy'|'sell'} action
 * @param {number} ourCents  price for OUR side, whole cents
 */
function orderDirection(contractSide, action, ourCents) {
  const s = String(contractSide || '').toUpperCase();
  const act = String(action || 'buy').toLowerCase();
  const longYes = (s === 'YES') === (act === 'buy');
  return {
    bookSide: longYes ? 'bid' : 'ask',
    // Integer arithmetic on purpose: 100 - 66 is exact where 1 - 0.66 is not.
    yesCents: s === 'YES' ? ourCents : 100 - ourCents
  };
}

// ── throttle ──────────────────────────────────────────────────

const MIN_GAP_MS = 120;
const MAX_RETRIES = 3;

/**
 * One throttle lane PER API KEY, not one for the whole bot.
 *
 * This used to be a single module-level queue, which meant every user's requests were chained
 * behind every other user's. Kalshi rate-limits per API key, so that was throttling people
 * against each other for no reason — and it had two costs that mattered:
 *
 *   - Entries got slower the more users there were. Each entry is four or five signed calls,
 *     so at a 120ms floor plus real latency, eight users could not place orders inside a few
 *     seconds of each other no matter how the caller was written. By the time the last user's
 *     order landed the quote that justified it was tens of seconds old, which in a 15-minute
 *     market is enough for the price to leave the limit entirely.
 *   - A 429 from ONE key set a cooldown that stalled EVERY key. One user hammering their own
 *     limit stopped everybody else's stops and exits from going out.
 *
 * Lanes are keyed by user id, and each keeps its own serialisation, its own last-request
 * stamp and its own cooldown. Within a lane the behaviour is exactly as before: strictly
 * ordered with a minimum gap, because that part is about respecting one key's limit.
 */
const lanes = new Map();

function laneFor(key) {
  const id = String(key || 'shared');
  let lane = lanes.get(id);
  if (!lane) {
    lane = { queue: Promise.resolve(), lastRequestAt: 0, cooldownUntil: 0 };
    lanes.set(id, lane);
  }
  return lane;
}

function enqueue(key, fn) {
  const lane = laneFor(key);
  const run = async () => {
    const now = Date.now();
    if (lane.cooldownUntil > now) await delay(lane.cooldownUntil - now);
    const since = Date.now() - lane.lastRequestAt;
    if (since < MIN_GAP_MS) await delay(MIN_GAP_MS - since);
    lane.lastRequestAt = Date.now();
    return fn();
  };
  const result = lane.queue.then(run, run);
  lane.queue = result.then(() => undefined, () => undefined);
  return result;
}

/** Everything an API failure needs to be acted on, as a plain object. */
function describeError(err, label) {
  const status = err.response?.status;
  const body = err.response?.data;
  const apiMsg = body?.error?.message || body?.message ||
    (typeof body === 'string' ? body.slice(0, 300) : null);

  if (status === 401) {
    return {
      status,
      why: 'Kalshi rejected the signature (401). The Key ID and the private key must ' +
        'be from the SAME key, the key must still exist in Kalshi account settings, ' +
        'and the host clock must be roughly correct — the timestamp is signed.'
    };
  }
  if (status === 403) {
    return {
      status,
      why: 'Kalshi accepted the key but refused the action (403). Usually the key ' +
        'lacks trading permission, or the account is not approved for this market.' +
        `${apiMsg ? ` Kalshi said: ${apiMsg}` : ''}`
    };
  }
  if (status === 400) {
    return { status, why: `Kalshi rejected the request as invalid (400)${apiMsg ? `: ${apiMsg}` : ''}` };
  }
  if (status === 429) return { status, why: 'rate limited by Kalshi (429)' };
  return { status: status || null, why: `${label} failed: ${apiMsg || err.message}` };
}

/**
 * One signed request on behalf of one user.
 *
 * The signature covers the timestamp, the method and the path — NOT the body — so a
 * POST signs exactly like a GET. Headers are rebuilt per attempt rather than once,
 * because each carries its own timestamp and a retry reusing an old one would look
 * like a replay.
 */
async function request(authProvider, method, requestPath, { body, params, label } = {}) {
  const name = label || `${method} ${requestPath}`;

  if (!authProvider || !authProvider.isImported()) {
    return {
      ok: false, status: null,
      why: 'no Kalshi API key imported for this user — nothing can be signed'
    };
  }

  let attempt = 0;
  while (true) {
    const h = authProvider.headers(method, requestPath);
    if (!h) return { ok: false, status: null, why: 'no Kalshi API key imported for this user' };

    try {
      const res = await enqueue(authProvider.userId, () => api.request({
        method,
        url: requestPath,
        params,
        data: body,
        headers: body ? { ...h, 'Content-Type': 'application/json' } : h
      }));
      return { ok: true, data: res.data };
    } catch (err) {
      const status = err.response?.status;

      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseFloat(err.response?.headers?.['retry-after']);
        const waitMs = !isNaN(retryAfter)
          ? Math.min(retryAfter * 1000, 15000)
          : Math.min(800 * Math.pow(2, attempt), 8000);
        // This user's lane only. A 429 is a statement about one key's limit, and applying it
        // bot-wide used to stall every other user's exits behind one user's over-use.
        const lane = laneFor(authProvider.userId);
        lane.cooldownUntil = Math.max(lane.cooldownUntil, Date.now() + waitMs);
        attempt++;
        await delay(waitMs);
        continue;
      }

      // Retried only for reads and cancels. A POST that creates an order is NOT
      // retried on a timeout: the request may well have been received and filled, and
      // a blind retry is how one intended position becomes two. The caller is told it
      // is uncertain and reconciles against fills instead.
      const idempotent = method === 'GET' || method === 'DELETE';
      if (idempotent && attempt < 2 &&
          (status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
        attempt++;
        await delay(500 * attempt);
        continue;
      }

      if (!idempotent && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
        return {
          ok: false, status: null, uncertain: true,
          why: `${name} timed out with no response — the order MAY have been ` +
            `accepted. Reconciling against fills rather than resending.`
        };
      }
      return { ok: false, ...describeError(err, name) };
    }
  }
}

// ── fees ──────────────────────────────────────────────────────

/**
 * Kalshi's trading fee, in dollars.
 *
 *     fee = roundUp( multiplier * C * P * (1 - P) )   to the next whole cent
 *
 * per the published fee schedule (kalshi.com/docs/kalshi-fee-schedule.pdf). The
 * multiplier is 0.07 for standard markets. It is a parabola in price, peaking at 50c
 * and falling toward both extremes, which is why an 84c entry is cheap to transact
 * and a 50c one is not.
 *
 * Rounding UP to the cent, per order, is why small orders cost proportionally more: a
 * 3-contract fill at 60c owes half a cent and pays a whole one.
 *
 * Pure and user-independent, so it stays a module export rather than a client method.
 */
function feeDollars(contracts, priceDollars, multiplier = 0.07) {
  const c = Number(contracts) || 0;
  const p = Number(priceDollars);
  if (!(c > 0) || !(p > 0 && p < 1)) return 0;

  // The .toFixed(6) is not cosmetic and removing it overstates the fee.
  //
  // 0.07 * 100 * 0.5 * 0.5 is 1.7500000000000002 in binary floating point, so
  // Math.ceil(raw * 100) sees 175.00000000000003 and returns 176 — reporting the
  // documented maximum fee of $1.75 as $1.76. Rounding to a precision far finer than
  // a cent before taking the ceiling collapses the representation error without
  // affecting any genuine fraction of a cent, which must still round up.
  const rawCents = multiplier * c * p * (1 - p) * 100;
  return +(Math.ceil(+rawCents.toFixed(6)) / 100).toFixed(2);
}

// ── the per-user client ───────────────────────────────────────

/**
 * A trading client for one user.
 *
 * @param {object} authProvider  from kalshiauth.forUser(userId)
 */
function forUser(authProvider) {
  const call = (method, p, opts) => request(authProvider, method, p, opts);

  /**
   * Account balance, in DOLLARS. Kalshi reports cents as an integer; converted here
   * so no caller has to remember which unit this endpoint uses.
   */
  async function balance() {
    const r = await call('GET', '/portfolio/balance', { label: 'balance' });
    if (!r.ok) return r;
    const d = r.data || {};

    // ── read `balance_dollars` first, and `balance` only as a fallback ──
    //
    // Kalshi returns BOTH, and they do not carry the same precision. Observed on a live account:
    //
    //   { balance: 0, balance_dollars: "0.0058", balance_breakdown: [...] }
    //
    // `balance` is integer cents, so anything under a cent reads as exactly 0 — which is how an
    // account holding real dust reported "$0.00" and looked like a broken parser rather than an
    // empty account. The dollars string keeps the fraction, so it is the honest source.
    const dollarsRaw = d.balance_dollars != null ? Number(d.balance_dollars) : NaN;
    const cents = Number(d.balance);
    const dollars = Number.isFinite(dollarsRaw) ? dollarsRaw
      : (Number.isFinite(cents) ? cents / 100 : NaN);
    if (!Number.isFinite(dollars)) {
      return { ok: false, status: null, why: 'balance response had no usable number' };
    }
    return {
      ok: true,
      // Rounded for display, and the exact figure kept beside it so "is it really zero" is
      // answerable without another request.
      dollars: +dollars.toFixed(2),
      exact: dollars,
      cents: Number.isFinite(cents) ? cents : Math.round(dollars * 100),
      portfolioValue: Number.isFinite(Number(d.portfolio_value)) ? Number(d.portfolio_value) / 100 : null,
      // Kalshi splits the balance across exchange indices. Kept so a balance that is present but
      // sitting somewhere unexpected is visible rather than invisible.
      breakdown: Array.isArray(d.balance_breakdown)
        ? d.balance_breakdown.map(b => ({ index: b.exchange_index, dollars: Number(b.balance) }))
        : null
    };
  }

  /**
   * Open positions.
   *
   * ── the schema is dollar-strings now, and that mattered ──
   *
   * The current response reports `position_fp`, `market_exposure_dollars`,
   * `realized_pnl_dollars` and `fees_paid_dollars`. The legacy names were `position`,
   * `market_exposure`, `realized_pnl` and `fees_paid`, and the money ones were in
   * CENTS.
   *
   * Reading the old names against the new response was silently catastrophic in both
   * directions: `Number(undefined)` made every position read as zero contracts, so the
   * bot believed it held nothing while real contracts sat on the exchange — and the
   * dollar fields, had they been found, would have been divided by 100 a second time,
   * reporting $9.00 of exposure as $0.09. Both are read here, new first.
   *
   * `position_fp` is SIGNED: positive is long YES, negative is long NO. Normalised into
   * an explicit side and an unsigned count, because a sign convention is exactly the
   * sort of thing that reads correctly and is implemented backwards.
   */
  async function positions({ settledOnly = false } = {}) {
    const r = await call('GET', '/portfolio/positions', {
      params: {
        count_filter: 'position',
        settlement_status: settledOnly ? 'settled' : 'unsettled'
      },
      label: 'positions'
    });
    if (!r.ok) return r;

    const out = (r.data?.market_positions || [])
      .map(p => {
        // null, not 0, when neither field is present — so "no data" cannot masquerade as
        // "flat". A position the bot cannot read is dropped below and reported as a
        // problem rather than silently counted as nothing.
        // `position` (a plain integer) is preferred over `position_fp` (fixed point). Reading
        // the fixed-point field first produced counts like 27.01 and 12.000000000000002, and
        // those leaked all the way into the book: a partial sale of a 2-contract position
        // split it into 1.01 and 0.99, and the panel then showed a user
        // "0.9899999999999984 sh". A Kalshi contract is indivisible, so ANY fractional count
        // here is an artefact rather than a holding.
        const raw = num(p.position) ?? num(p.position_fp);
        if (raw == null) return null;
        // Rounded, not floored. Floor would turn a 26.999999 artefact into 26 and silently
        // lose a contract the account actually holds.
        const signed = Math.round(raw);
        if (signed === 0) return null;

        // Dollars when the *_dollars field is present, cents converted otherwise.
        const dollars = (dollarField, centField) => {
          const d = num(p[dollarField]);
          if (d != null) return +d.toFixed(4);
          const c = num(p[centField]);
          return c == null ? 0 : +(c / 100).toFixed(4);
        };

        return {
          ticker: p.ticker || p.market_ticker,
          side: signed >= 0 ? 'YES' : 'NO',
          contracts: Math.abs(signed),
          exposureDollars: dollars('market_exposure_dollars', 'market_exposure'),
          realisedDollars: dollars('realized_pnl_dollars', 'realized_pnl'),
          feesDollars: dollars('fees_paid_dollars', 'fees_paid'),
          restingOrders: num(p.resting_orders_count) ?? 0
        };
      })
      .filter(p => p && p.contracts !== 0);

    const unreadable = (r.data?.market_positions || [])
      .filter(p => (num(p.position_fp) ?? num(p.position)) == null).length;

    return { ok: true, positions: out, unreadable };
  }

  /**
   * Prove the credential works end to end.
   *
   * Reads the balance, because it is the cheapest authenticated endpoint and is also
   * what a panel wants to show anyway. Called right after an import so a bad key is
   * reported when it is entered rather than at the first trade, and again at arming,
   * because a key can be deleted in Kalshi's settings in between.
   */
  async function verify() {
    const b = await balance();
    if (!b.ok) return { ok: false, why: b.why, status: b.status };
    return { ok: true, dollars: b.dollars, keyId: authProvider.maskedKeyId() };
  }

  /**
   * Place one order, against the V2 order endpoint.
   *
   * ── the V2 migration, and why the old call failed ──
   *
   * The legacy `POST /portfolio/orders` now answers "Please switch to the V2
   * endpoints". Orders live at `POST /portfolio/events/orders` and the request body is
   * a different shape: no `action`, no `yes_price`/`no_price`, no `expiration_ts`,
   * `count` and `price` as decimal STRINGS, and direction expressed as `book_side`.
   *
   * ── the direction mapping, which is the dangerous part ──
   *
   * From https://docs.kalshi.com/getting_started/order_direction: `bid ≡ yes,
   * ask ≡ no, always`, and "direction does not change the price" — the price on an
   * order is always on the YES scale, whichever side you are taking.
   *
   * Kalshi's own equivalence table, because buy-no and sell-yes are the SAME order:
   *
   *   legacy action  legacy side   outcome_side   book_side
   *   buy            yes           yes            bid
   *   sell           no            yes            bid
   *   buy            no            no             ask
   *   sell           yes           no             ask
   *
   * So the rule is: `bid` when the order increases long-YES exposure, `ask` when it
   * increases long-NO exposure. Worked through for all four cases at a 34/40 book:
   *
   *   buy  YES @66c  ->  bid @0.66   (lifting the yes ask)
   *   buy  NO  @66c  ->  ask @0.34   (offering yes at 34c == buying no at 66c)
   *   sell YES @92c  ->  ask @0.92
   *   sell NO  @30c  ->  bid @0.70   (bidding yes at 70c == selling no at 30c)
   *
   * The caller keeps speaking in CONTRACT side (YES/NO) and action (buy/sell) with a
   * price for its own side, exactly as before, and the translation happens here and
   * nowhere else. That is deliberate: this is the one conversion in the project where
   * a sign error silently buys the opposite of what the model chose, so it exists in a
   * single place with the truth table next to it.
   *
   * ── immediate-or-cancel is now a first-class field ──
   *
   * `time_in_force: 'immediate_or_cancel'` replaces the old trick of back-dating
   * `expiration_ts`. Same intent: fill what is available now, cancel the rest. Without
   * it an unfilled order RESTS, and a resting buy on a 15-minute market can be
   * acquired minutes after the read that justified it, once the window has shut and
   * the edge is gone.
   *
   * Fill-or-kill is deliberately not used: a partial fill of a Kelly-sized position is
   * a smaller position, which is fine, whereas rejecting the whole order because one
   * contract was missing throws away a good entry over a rounding detail.
   *
   * @param {object} o
   * @param {'YES'|'NO'} o.side       CONTRACT side, the exchange's vocabulary
   * @param {'buy'|'sell'} [o.action]
   * @param {number} o.limitCents     worst acceptable price for THIS side, 1-99
   * @param {boolean} [o.reduceOnly]  true on exits: the order may only CLOSE a
   *                                  position, never open an opposite one
   */
  async function placeOrder({
    ticker, side, action = 'buy', count, limitCents, ioc = true, reduceOnly = false
  }) {
    const n = Math.floor(Number(count));
    const cents = Math.round(Number(limitCents));
    const s = String(side || '').toUpperCase();
    const act = String(action || 'buy').toLowerCase();

    // Validated rather than trusted, because these values are the whole of what the
    // order is and each has a plausible wrong value the API would accept. A 0-count
    // order is a no-op; a 0-cent limit never fills; a 100-cent limit on a buy is "pay
    // anything".
    if (!ticker) return { ok: false, why: 'no ticker', status: null };
    if (s !== 'YES' && s !== 'NO') return { ok: false, why: `bad side ${side}`, status: null };
    if (act !== 'buy' && act !== 'sell') return { ok: false, why: `bad action ${action}`, status: null };
    if (!(n >= 1)) return { ok: false, why: `bad contract count ${count}`, status: null };
    if (!(cents >= 1 && cents <= 99)) {
      return {
        ok: false, status: null,
        why: `limit ${limitCents} is not a whole number of cents between 1 and 99 — ` +
          `this parameter takes CENTS for OUR side, not dollars`
      };
    }

    // See orderDirection() for the published truth table this implements.
    const { bookSide, yesCents } = orderDirection(s, act, cents);

    // Idempotency key. Kalshi rejects a duplicate, which is what turns a retry or a
    // double click into a no-op instead of a second position.
    const clientOrderId = crypto.randomUUID();

    const body = {
      ticker,
      client_order_id: clientOrderId,
      side: bookSide,
      // Decimal strings, per the V2 schema. Sending numbers here is a 400.
      count: n.toFixed(2),
      price: (yesCents / 100).toFixed(4),
      time_in_force: ioc ? 'immediate_or_cancel' : 'good_till_canceled',
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
      // On an exit this is a genuine safety property, not a nicety. Closing a YES
      // position is expressed as an ASK, which is the same instruction as OPENING a NO
      // position — so without reduce_only, an exit that raced a settlement or a
      // double-close could acquire a fresh opposite position instead of flattening.
      reduce_only: Boolean(reduceOnly)
    };

    const r = await call('POST', '/portfolio/events/orders', {
      body,
      label: `order ${act} ${n} ${s} ${ticker} @${cents}c (${bookSide} ${yesCents}c yes)`
    });
    if (!r.ok) return { ...r, clientOrderId };
    return { ok: true, order: r.data?.order || r.data, clientOrderId, bookSide, yesCents };
  }

  /**
   * One order's current state.
   *
   * READS stay on `/portfolio/orders`; only the WRITE paths (create, cancel, amend)
   * moved to `/portfolio/events/orders`. That split is not documented anywhere obvious
   * and was found by trying both: `GET /portfolio/events/orders/{id}` returns a bare
   * "404 page not found", while the legacy read path returns the full order including
   * `outcome_side`, `book_side`, `fill_count_fp` and `remaining_count_fp`.
   */
  async function getOrder(orderId) {
    const r = await call('GET', `/portfolio/orders/${orderId}`, { label: `order ${orderId}` });
    if (!r.ok) return r;
    const o = r.data?.order || r.data;
    if (!o) return { ok: false, status: null, why: 'order response was empty' };
    return {
      ok: true,
      order: o,
      // Normalised, so callers do not each have to know which of the four count fields
      // this version of the API is using. Integer field first and rounded, for the same
      // reason as fills() above: a contract is indivisible, so a fractional count is an
      // artefact of the fixed-point field and it turns into unsellable dust downstream.
      filled: Math.round(num(o.taker_fill_count) ?? num(o.fill_count_fp) ?? 0),
      remaining: Math.round(num(o.remaining_count) ?? num(o.remaining_count_fp) ?? 0),
      side: String(o.outcome_side || o.side || '').toUpperCase() || null,
      status: o.status || null
    };
  }

  /**
   * Cancel a resting order.
   *
   * "Already gone" is treated as success. A cancel races the book by nature: the order
   * may have filled or expired between the decision to cancel and the request, and in
   * both cases the caller's intent — do not leave this resting — is satisfied.
   * Reporting failure would make callers retry something already done.
   */
  async function cancelOrder(orderId) {
    const r = await call('DELETE', `/portfolio/events/orders/${orderId}`,
      { label: `cancel ${orderId}` });
    if (r.ok) return { ok: true, order: r.data?.order || r.data };

    if (r.status === 404) {
      // A 404 has two very different meanings and they must not be conflated: the order
      // is genuinely gone, OR the endpoint path is wrong. Mapping both to success is how
      // a broken cancel path reports "cancelled" while leaving orders resting on the
      // book — and this API has already moved its order paths once.
      //
      // So it is CHECKED, on the read path, which is known to work. One extra request on
      // an exceptional branch is worth not having a silent failure here.
      const o = await getOrder(orderId);
      if (o.ok && o.remaining > 0 && o.status !== 'canceled') {
        return {
          ok: false, status: 404,
          why: `cancel returned 404 but the order still has ${o.remaining} contract(s) ` +
            `resting — the cancel endpoint path is probably wrong, NOT that the order was ` +
            `already gone`
        };
      }
      return { ok: true, alreadyGone: true };
    }
    return r;
  }

  /**
   * Fills, newest first.
   *
   * The source of truth for what was actually bought and at what price. The order
   * response reports an intent and a status; the fills report the transaction. They
   * disagree on partial fills and on price improvement, and when they disagree the
   * fills are right — they are what the account was charged for.
   */
  /**
   * @param {object} o
   * @param {'YES'|'NO'} [o.forSide]  the CONTRACT side we hold or bought. Fills report
   *                                  both legs' prices, so the caller has to say which
   *                                  one it wants priced — see below.
   */
  async function fills({ ticker, orderId, limit = 100, forSide } = {}) {
    const params = { limit: Math.min(Math.max(1, limit), 200) };
    if (ticker) params.ticker = ticker;
    if (orderId) params.order_id = orderId;

    const r = await call('GET', '/portfolio/fills', { params, label: 'fills' });
    if (!r.ok) return r;

    const want = String(forSide || '').toUpperCase();

    const out = (r.data?.fills || []).map(f => {
      // ── direction ──
      //
      // `outcome_side` is the current field; `side` is the legacy one, deprecated with a
      // removal date of 2026-05-28 that has now PASSED. Both are read, new first, so
      // this works whichever the account is being served — and `forSide` is the
      // authoritative fallback because the caller knows what it ordered. Depending on a
      // field whose name is mid-migration to price a fill would be a poor bet.
      const side = String(f.outcome_side || f.side || want || '').toUpperCase();
      const priced = want || side;

      // ── price ──
      //
      // Fills carry BOTH legs (`yes_price_dollars` and `no_price_dollars`), so the leg
      // to use is the side we actually hold. Reading the wrong one reports a 66c
      // purchase as 34c, which would show a loss as a profit.
      const yesD = num(f.yes_price_dollars);
      const noD = num(f.no_price_dollars);
      let dollars = priced === 'NO' ? noD : yesD;
      // Older payloads used integer cents in `yes_price`/`no_price`.
      if (dollars == null) {
        const legacy = priced === 'NO' ? num(f.no_price) : num(f.yes_price);
        if (legacy != null) dollars = legacy / 100;
      }

      // The legacy INTEGER `count` is preferred over the decimal `count_fp`, and the result is
      // rounded. This is where fractional contract counts came from, and they did real damage
      // downstream: a 16-contract fill read back as 16.01, the book stored 16.01, and the exit
      // then sold floor(16.01) = 16 — leaving 0.01 of a contract on the exchange that no order
      // can clear, because an order must be a whole contract. That dust shows in the Kalshi app
      // as a live position costing $0.01 with a $0.01 max payout, and it sits there until
      // settlement. The same artefact produced "0.9899999999999984 sh" on a trade list and
      // 12.000000000000002 in the book.
      //
      // A contract on these markets is indivisible and placeOrder() already refuses a
      // non-whole count, so a fraction here is an artefact of the fixed-point field rather
      // than a real fill.
      const rawCount = num(f.count) ?? num(f.count_fp) ?? 0;
      const count = Math.round(rawCount);

      return {
        fillId: f.fill_id || null,
        tradeId: f.trade_id,
        orderId: f.order_id,
        ticker: f.ticker || f.market_ticker,
        side,
        action: f.action || null,
        count,
        priceCents: dollars == null ? null : +(dollars * 100).toFixed(2),
        // The fee the exchange ACTUALLY charged, when it tells us. Strictly better than
        // recomputing the formula: it needs no assumption about the multiplier and
        // cannot drift if Kalshi changes the schedule.
        feeDollars: num(f.fee_cost),
        isTaker: Boolean(f.is_taker),
        at: f.created_time
      };
    });
    return { ok: true, fills: out };
  }

  /** Orders still resting, so a stale one can be cleaned up at startup. */
  async function restingOrders({ ticker } = {}) {
    const params = { status: 'resting', limit: 200 };
    if (ticker) params.ticker = ticker;
    const r = await call('GET', '/portfolio/orders', { params, label: 'resting orders' });
    if (!r.ok) return r;
    return { ok: true, orders: r.data?.orders || [] };
  }

  return {
    userId: authProvider.userId,
    isImported: () => authProvider.isImported(),
    balance,
    positions,
    verify,
    placeOrder,
    getOrder,
    cancelOrder,
    fills,
    restingOrders
  };
}

module.exports = { forUser, feeDollars, orderDirection, num, request, api };
