/**
 * The position book for real fills.
 *
 * src/challenge.js is the paper equivalent and cannot be reused for this, for one
 * structural reason: it credits and debits at the price the DECISION saw.
 * `challenge.open()` takes a sizing and assumes the position was acquired at
 * `decision.price`, because in a paper book it was. A real fill has three properties
 * a paper one does not:
 *
 *   - an average price that differs from the quote, across possibly several levels
 *   - a contract count that can be less than what was asked for
 *   - a fee, on the way in AND on the way out
 *
 * Every one of those changes the arithmetic, and all three point the same way: a
 * paper book flatters. So this is a separate ledger that records what the exchange
 * actually did, and the difference between the two is the honest measure of what
 * execution costs.
 *
 * ── positions are identified by seq, never by ticker ──
 *
 * The same mistake is available here as in challenge.js, and it was a real bug
 * there. Ticker identity is only unique while one position per market per round is
 * possible; settling or closing "the position on this ticker" would close every
 * position on that market at once and leave the rest of the book unaccounted for.
 *
 * ── nothing here talks to Kalshi ──
 *
 * This module is pure accounting over a plain object. src/execution.js places the
 * orders and reports what filled; this records it. That split is what makes the
 * P&L arithmetic testable without a network or an account.
 */

/**
 * UP/DOWN from YES/NO. Inlined rather than pulling in the other bot's markets module, which
 * carries seven markets' worth of tuned entry config this bot does not use.
 */
const sideLabel = side => (String(side).toUpperCase() === 'YES' ? 'UP' : 'DOWN');

/**
 * The exchange's calendar date for an instant.
 *
 * Every "today" in this file means the trading day in New York, not the viewer's day. Shared by
 * the daily stop, todayStats() and the daily high-water mark so the three cannot disagree about
 * when a day ends.
 */
function etDay(at) {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** A fresh book. */
function blank() {
  return {
    startedAt: new Date().toISOString(),
    seq: 0,
    positions: [],
    // Last known account balance, and when. Cached because the panel wants it on
    // every render and Kalshi should not be asked on every button press.
    balance: null,
    balanceAt: null
  };
}

/** Bring a persisted book up to shape, repairing anything inconsistent. */
function normalise(book) {
  const b = { ...blank(), ...(book && typeof book === 'object' ? book : {}) };
  b.positions = Array.isArray(b.positions) ? b.positions : [];
  // Derived rather than trusted: a seq that has fallen behind the log would issue a
  // duplicate id, and two positions sharing an id is the one thing the seq exists to
  // prevent.
  const maxSeq = b.positions.reduce((m, p) => Math.max(m, Number(p.seq) || 0), 0);
  b.seq = Math.max(Number(b.seq) || 0, maxSeq);
  return b;
}

// ── open ──────────────────────────────────────────────────────

/**
 * Record a position that actually filled.
 *
 * @param {object} book
 * @param {object} o
 * @param {string} o.sym
 * @param {object} o.decision  the engine decision that justified it
 * @param {object} o.market    the Kalshi market
 * @param {object} o.fill      execution.enter() result
 */
function open(book, { sym, decision, market, fill }) {
  if (!fill || !(fill.contracts > 0)) {
    throw new Error('livebook.open: nothing filled, so there is no position to record');
  }

  const p = {
    seq: ++book.seq,
    sym,
    ticker: market.ticker,
    at: new Date().toISOString(),
    closeTime: market.close_time,
    closeMs: new Date(market.close_time).getTime(),
    minutesLeft: decision.minutesLeft,

    // Real money or not. Stored PER POSITION rather than read from settings at
    // display time, because liveMode can be flipped while a position is open and
    // the position's own nature does not change when it is.
    live: Boolean(fill.live),
    orderId: fill.orderId || null,

    side: decision.side,                          // YES/NO, the exchange's wording
    direction: sideLabel(decision.side),  // UP/DOWN, what it means
    strike: decision.strike,
    spot: decision.spot,
    spotAgeMs: decision.spotAgeMs ?? null,   // freshness provenance (see livebot decision stamp)
    spotSource: decision.spotSource ?? null,
    confidence: decision.confidence,
    edgePt: decision.edgePt,
    modelPct: decision.modelPct,
    midPct: decision.midPct,

    // What it ACTUALLY cost, from the fills — not what the quote implied.
    requested: fill.requested ?? fill.contracts,
    contracts: fill.contracts,
    priceCents: fill.priceCents,
    price: fill.price,
    quotedCents: decision.pricePct,
    slippageCents: fill.slippageCents ?? 0,
    // How the order was priced, stored per position so maker and taker can be compared after
    // the fact. Without this the two populations are indistinguishable in the record and the
    // experiment cannot be read.
    entryStyle: fill.style || 'taker',
    limitCents: fill.limitCents ?? null,
    cost: fill.cost,
    entryFee: fill.fee || 0,
    total: fill.total ?? +(fill.cost + (fill.fee || 0)).toFixed(2),

    outcome: null,
    exitPriceCents: null,
    exitPrice: null,
    exitAt: null,
    exitFee: null,
    proceeds: null,
    pnl: null
  };

  book.positions.push(p);
  return p;
}

// ── close ─────────────────────────────────────────────────────

/**
 * Close a position by selling it back.
 *
 * P&L is net of BOTH fees, because that is the number that hits the account:
 *
 *     pnl = proceeds - cost - entryFee - exitFee
 *
 * Reporting it gross of the exit fee is the more flattering and more common error,
 * and on a small position it can be the difference between a profit and a loss —
 * a 3-contract round trip owes a whole cent at each end by the rounding rule.
 */
function close(book, position, sale) {
  if (position.outcome) {
    throw new Error(
      `livebook.close: position ${position.seq} is already ${position.outcome}`);
  }
  if (!sale || !(sale.contracts > 0)) {
    throw new Error('livebook.close: nothing sold');
  }

  // A partial sale splits the position rather than mislabelling it. Recording a
  // partial as fully closed would leave real contracts held by an account the book
  // says is flat — the one state that must never occur.
  if (sale.contracts < position.contracts) {
    // Rounded to whole contracts. `position.contracts - sold` in floating point is what put
    // slivers like 0.9899999999999984 into the book and onto a user's trade list; a contract
    // is indivisible, so the subtraction must land on an integer.
    const sold = Math.round(sale.contracts);
    const kept = Math.round(position.contracts - sold);
    // A sale that rounds to the whole position is a FULL close, not a split leaving nothing.
    if (kept <= 0) return finishClose(position, sale);
    const share = sold / position.contracts;

    // The remainder stays open under the original seq, with its cost basis reduced
    // proportionally, so the two halves still sum to what was paid.
    const soldCost = +(position.cost * share).toFixed(4);
    const soldEntryFee = +(position.entryFee * share).toFixed(4);
    position.cost = +(position.cost - soldCost).toFixed(4);
    position.entryFee = +(position.entryFee - soldEntryFee).toFixed(4);
    position.contracts = kept;
    position.total = +(position.cost + position.entryFee).toFixed(2);

    const part = {
      ...position,
      seq: ++book.seq,
      splitFrom: position.seq,
      contracts: sold,
      cost: soldCost,
      entryFee: soldEntryFee,
      total: +(soldCost + soldEntryFee).toFixed(2)
    };
    book.positions.push(part);
    return finishClose(part, sale);
  }

  return finishClose(position, sale);
}

/**
 * Outcomes a close can produce.
 *
 * EXTERNAL means the user closed it themselves on Kalshi. Recorded as its own outcome rather
 * than folded into CASHOUT because it is not a decision the bot made, and counting it as one
 * would credit or blame the exit policy for a trade it did not close. It still counts in P&L
 * — the money moved either way.
 */
const CLOSE_OUTCOMES = new Set(['CASHOUT', 'STOPPED', 'EXTERNAL']);

function finishClose(position, sale) {
  position.outcome = CLOSE_OUTCOMES.has(sale.reason) ? sale.reason : 'CASHOUT';
  if (sale.reason === 'EXTERNAL') {
    // Whether the exit price is known or inferred, recorded so a reader can tell. An
    // estimated price makes the P&L approximate and that should never be silent.
    position.externalClose = true;
    position.exitPriceEstimated = Boolean(sale.estimated);
  }
  position.exitPriceCents = sale.priceCents;
  position.exitPrice = sale.price;
  position.exitAt = new Date().toISOString();
  position.exitFee = sale.fee || 0;
  position.proceeds = sale.proceeds;
  position.pnl = +(
    sale.proceeds - position.cost - position.entryFee - (sale.fee || 0)
  ).toFixed(4);
  return position;
}

/**
 * Settle a position that was carried to the close.
 *
 * A winning contract pays exactly $1 and a loser pays nothing, so there is no exit
 * fee: settlement is not a trade. That asymmetry is a genuine reason to hold rather
 * than cash out marginally — cashing out at 99c pays a fee that settling at $1 does
 * not.
 */
function settle(book, position, won) {
  if (position.outcome) {
    throw new Error(
      `livebook.settle: position ${position.seq} is already ${position.outcome}`);
  }
  position.outcome = won ? 'WIN' : 'LOSS';
  position.exitAt = new Date().toISOString();
  position.exitPriceCents = won ? 100 : 0;
  position.exitPrice = won ? 1 : 0;
  position.exitFee = 0;
  position.proceeds = won ? +(position.contracts * 1).toFixed(4) : 0;
  position.pnl = +(position.proceeds - position.cost - position.entryFee).toFixed(4);
  return position;
}

// ── queries ───────────────────────────────────────────────────

function openPositions(book) {
  return (book.positions || []).filter(p => !p.outcome);
}

function closedPositions(book) {
  return (book.positions || []).filter(p => p.outcome);
}

/**
 * Cost of everything still held, for a portfolio exposure figure.
 *
 * `liveOnly` matters when this feeds a RISK BUDGET rather than a display. Paper positions are
 * not exposure — no money is at stake — so counting them against a live portfolio cap made a
 * week of paper trading suppress real entries, and enforced the cap against a book that was
 * partly imaginary. Defaults to counting everything, which is right for the admin exposure
 * view where the reader wants the whole book.
 */
function atRisk(book, { liveOnly = false } = {}) {
  return +openPositions(book)
    .filter(p => (liveOnly ? p.live : true))
    .reduce((a, p) => a + (Number(p.cost) || 0), 0).toFixed(2);
}

/** Open positions on one ticker. Used to mirror an exit onto the real book. */
function openOnTicker(book, ticker) {
  return openPositions(book).filter(p => p.ticker === ticker);
}

/**
 * Aggregate P&L.
 *
 * `live` and `paper` are reported SEPARATELY and never pooled. They are different
 * measurements: paper fills at the quote with no fee, live fills at whatever the
 * book gave and pays twice. Pooling them would produce a number that describes
 * neither, and would let a good paper run hide a bad live one — which is precisely
 * the comparison worth being able to make.
 *
 * A win is decided by the SIGN OF REALISED P&L rather than by the outcome label,
 * because a cashout has no settlement result. A position sold at 30c after being
 * bought at 78c is a loss whatever it is called.
 */
function stats(book, { liveOnly = null, sinceMs = null } = {}) {
  let closed = closedPositions(book);
  if (liveOnly === true) closed = closed.filter(p => p.live);
  if (liveOnly === false) closed = closed.filter(p => !p.live);
  // `sinceMs` scopes the CLOSED P&L to positions that settled at or after a timestamp — used by
  // the per-release "this update" view. Keyed on exitAt (when the position closed), the same
  // field todayStats uses, so the two agree. Open positions are left unfiltered: they are the
  // book's current exposure regardless of which release opened them.
  if (sinceMs != null) closed = closed.filter(p => p.exitAt && new Date(p.exitAt).getTime() >= sinceMs);

  const wins = closed.filter(p => (Number(p.pnl) || 0) > 0);
  const net = +closed.reduce((a, p) => a + (Number(p.pnl) || 0), 0).toFixed(2);
  const staked = +closed.reduce((a, p) => a + (Number(p.cost) || 0), 0).toFixed(2);
  const fees = +closed.reduce(
    (a, p) => a + (Number(p.entryFee) || 0) + (Number(p.exitFee) || 0), 0).toFixed(2);

  let opens = openPositions(book);
  if (liveOnly === true) opens = opens.filter(p => p.live);
  if (liveOnly === false) opens = opens.filter(p => !p.live);

  return {
    n: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    hit: closed.length ? wins.length / closed.length : null,
    net,
    staked,
    fees,
    roi: staked ? net / staked : null,
    open: opens.length,
    atRisk: +opens.reduce((a, p) => a + (Number(p.cost) || 0), 0).toFixed(2),
    contracts: closed.reduce((a, p) => a + (Number(p.contracts) || 0), 0)
  };
}

/**
 * Realised P&L today, in the exchange's calendar.
 *
 * Keyed on exit time rather than entry, because the daily loss limit is about money
 * that has actually been lost — a position opened yesterday and stopped today is
 * today's loss.
 */
function todayStats(book, day) {
  const target = day || etDay(new Date());
  const closed = closedPositions(book).filter(p => {
    if (!p.exitAt) return false;
    return etDay(p.exitAt) === target;
  });
  const net = +closed.reduce((a, p) => a + (Number(p.pnl) || 0), 0).toFixed(2);
  const wins = closed.filter(p => (Number(p.pnl) || 0) > 0).length;
  return {
    day: target,
    n: closed.length,
    wins,
    losses: closed.length - wins,
    net,
    live: +closed.filter(p => p.live)
      .reduce((a, p) => a + (Number(p.pnl) || 0), 0).toFixed(2)
  };
}

/** Per-market breakdown, for the "By coin" block on the panel. */
function byMarket(book, { liveOnly = null } = {}) {
  let closed = closedPositions(book);
  if (liveOnly === true) closed = closed.filter(p => p.live);
  if (liveOnly === false) closed = closed.filter(p => !p.live);

  const out = {};
  for (const p of closed) {
    const s = out[p.sym] || (out[p.sym] = { sym: p.sym, n: 0, wins: 0, net: 0, staked: 0 });
    s.n++;
    if ((Number(p.pnl) || 0) > 0) s.wins++;
    s.net = +(s.net + (Number(p.pnl) || 0)).toFixed(2);
    s.staked = +(s.staked + (Number(p.cost) || 0)).toFixed(2);
  }
  return Object.values(out)
    .map(s => ({ ...s, hit: s.n ? s.wins / s.n : null, roi: s.staked ? s.net / s.staked : null }))
    .sort((a, b) => b.net - a.net);
}

/**
 * The equity curve, and the numbers you can only get from walking it.
 *
 * ── why the panel needed this ──
 *
 * It was showing the bankroll SETTING — a frozen number somebody typed — while the account had
 * actually made or lost money against it. $100.00 on screen with $93.93 in the book is not a
 * rounding disagreement, it is the screen describing a different quantity from the one that
 * matters, and it is exactly the display-versus-execution split that made the other bot's sizing
 * page untrustworthy.
 *
 * Peak equity and drawdown cannot be derived from the totals at all. `net` tells you where you
 * ended; only the ORDER of the trades tells you the best you ever had and how far back you have
 * come since. A book that is +$5 having been +$60 is a different situation from one that has
 * climbed steadily to +$5, and the totals report them identically.
 *
 * `sinceMs` scopes the realised P&L to trades that closed at or after a baseline, which is what
 * makes "set my paper balance to X" mean X now rather than X plus a lifetime of history.
 */
function equity(book, { start = 0, liveOnly = null, sinceMs = null, day = null } = {}) {
  let closed = closedPositions(book);
  if (liveOnly === true) closed = closed.filter(p => p.live);
  if (liveOnly === false) closed = closed.filter(p => !p.live);
  if (sinceMs != null) {
    closed = closed.filter(p => p.exitAt && new Date(p.exitAt).getTime() >= sinceMs);
  }
  // Chronological by EXIT, because equity moves when a position realises, not when it opened.
  // A position opened first and closed last belongs at the end of the curve.
  closed.sort((a, b) => new Date(a.exitAt || 0) - new Date(b.exitAt || 0));

  const base = Number(start) || 0;
  let run = base;
  let peak = base;
  let trough = base;
  let maxDd = 0;
  const points = [base];
  // ── the day's high-water mark ──
  //
  // Tracked on this same pass because it cannot be derived from the totals: a book at +$5 today
  // having been +$60 this morning is a different day from one that climbed to +$5, and `net`
  // reports them identically. `todayStart` is where the curve stood when the day opened — not
  // `start`, which is where the whole book opened.
  const target = day || etDay(new Date());
  let todayStart = null;
  let todayPeak = null;
  let todayN = 0;
  for (const p of closed) {
    const onDay = p.exitAt ? etDay(p.exitAt) === target : false;
    // Taken BEFORE this position's P&L is applied, so the opening figure excludes today's first
    // result rather than including it.
    if (onDay && todayStart === null) { todayStart = run; todayPeak = run; }
    run += Number(p.pnl) || 0;
    points.push(+run.toFixed(4));
    if (run > peak) peak = run;
    if (run < trough) trough = run;
    const dd = peak - run;
    if (dd > maxDd) maxDd = dd;
    if (onDay) { todayN++; if (run > todayPeak) todayPeak = run; }
  }
  // A day that closed nothing has not made, lost, or peaked at anything: it stands where the
  // curve already was. Reporting the all-time peak here would claim a high the day never had.
  if (todayStart === null) { todayStart = run; todayPeak = run; }

  const opens = openPositions(book).filter(p => (liveOnly == null ? true : (liveOnly ? p.live : !p.live)));
  const atRisk = +opens.reduce((a, p) => a + (Number(p.cost) || 0), 0).toFixed(2);

  return {
    start: +base.toFixed(2),
    // Realised only. Open positions are money committed, not money made or lost yet.
    realised: +(run - base).toFixed(2),
    equity: +run.toFixed(2),
    // Cash actually free to bet: equity less what is already committed to open positions. This is
    // the number a sizer must use, or the same dollar gets allocated twice.
    free: +(run - atRisk).toFixed(2),
    peak: +peak.toFixed(2),
    trough: +trough.toFixed(2),
    /** How far below the best it has ever been. 0 when sitting at a new high. */
    fromPeak: +(peak - run).toFixed(2),
    /** The deepest peak-to-trough the curve actually took, which `net` cannot show. */
    maxDrawdown: +maxDd.toFixed(2),
    // ── today, in the exchange's calendar ──
    day: target,
    /** Where the curve stood when this trading day opened. */
    todayStart: +todayStart.toFixed(2),
    /** The best it has been TODAY. Equal to todayStart on a day that has closed nothing. */
    todayPeak: +todayPeak.toFixed(2),
    /** Realised today, which is the day's movement rather than the book's total. */
    todayNet: +(run - todayStart).toFixed(2),
    todayN,
    atRisk,
    n: closed.length,
    points
  };
}

/**
 * Realised P&L per ET day, oldest first, with a running total.
 *
 * Keyed on exit day, the same key todayStats uses, so the two can never disagree about which day
 * a trade belongs to.
 */
function byDay(book, { liveOnly = null } = {}) {
  let closed = closedPositions(book);
  if (liveOnly === true) closed = closed.filter(p => p.live);
  if (liveOnly === false) closed = closed.filter(p => !p.live);
  const map = new Map();
  for (const p of closed) {
    if (!p.exitAt) continue;
    const d = new Date(p.exitAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const e = map.get(d) || { day: d, net: 0, n: 0, wins: 0 };
    e.net += Number(p.pnl) || 0; e.n++; if ((Number(p.pnl) || 0) > 0) e.wins++;
    map.set(d, e);
  }
  const days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  let cum = 0;
  for (const d of days) { d.net = +d.net.toFixed(2); cum += d.net; d.cum = +cum.toFixed(2); }
  return days;
}

module.exports = {
  CLOSE_OUTCOMES,
  equity,
  byDay,
  blank,
  normalise,
  open,
  close,
  settle,
  openPositions,
  closedPositions,
  openOnTicker,
  atRisk,
  stats,
  todayStats,
  byMarket
};
