/**
 * The web dashboard, served from inside the bot process.
 *
 * ── why in-process ──
 *
 * server.js used to be a second process reading state.json off disk. That is one restart away from
 * showing a stale file, and on a platform with a mounted volume it also means two processes with
 * two ideas of the truth. Serving from here reads the SAME in-memory book the trader writes, so the
 * site cannot disagree with the Discord panel.
 *
 * ── privacy ──
 *
 * The global trade tab shows what the BOT decided — market, direction, price, confidence, the reason
 * a round was skipped. That carries no account information and serves openly.
 *
 * Anything naming a person or their money — per-account P&L, balances — needs WEB_TOKEN and
 * ?key=. With no token configured those endpoints stay closed rather than open, because the safe
 * default for "is this secret" is yes.
 *
 * Never throws into the caller. A dashboard fault must not touch the trading loop.
 */

const http = require('http');
const users = require('./users');
const book = require('./book');
const gl = require('./markets');
const activity = require('./activity');
const {
  WEB_TOKEN, DATA_DIR, DATA_DIR_SOURCE, KEY_DIR_SOURCE, KEY_DIR_PERSISTENT, INSTANCE
} = require('./config');

const NAME = 'Indicators';

/** Fleet view: aggregate only, no names. */
function publicState() {
  let trader = null;
  try { trader = require('./trader').stats; } catch (_) { trader = null; }

  const all = users.all();
  let closed = 0, wins = 0, net = 0, open = 0, atRisk = 0, fees = 0;
  // Live and paper are accumulated apart as well as together. Pooling them produces a figure that
  // describes neither book and lets a good paper run hide a bad live one — which is exactly the
  // comparison this bot exists to make. `dayHigh` is the best each book has been TODAY, which no
  // total can reconstruct: a book at +$5 that was +$60 this morning is a different day.
  const side = mode => ({ closed: 0, wins: 0, net: 0, open: 0, atRisk: 0, today: 0, dayHigh: 0, mode });
  const live = side('live');
  const paper = side('paper');
  // Directional exposure and the by-direction win rate — the ONE health signal this strategy
  // actually needs. The book is a structural short (most entries are NO/DOWN), so its P&L lives or
  // dies on whether the DOWN book keeps winning; when a rally turns that book, the loss shows up
  // here BEFORE it shows up in the total. `open` is the tilt right now; `recent` is the last trades
  // per side, which is the timely read (all-time hit is dominated by a good early window).
  const dir = { open: { up: 0, down: 0 }, up: { n: 0, wins: 0, net: 0 }, down: { n: 0, wins: 0, net: 0 }, recent: [] };
  // Which book a position belongs to. Written as an explicit three-way rather than
  // `direction === 'DOWN' ? down : up`, because that form sends every UNRECOGNISED value to the UP
  // book — so a legacy position saved before `direction` existed, or a lowercase one, would quietly
  // move a DOWN loss into the UP column and stop the warn from ever firing. A health signal whose
  // failure mode is "looks healthier" is worse than none. side is the fallback (it is what the
  // exchange was told); anything classifiable by neither is excluded rather than guessed.
  const sideOf = p => {
    const d = String(p.direction || '').toUpperCase();
    if (d === 'DOWN') return dir.down;
    if (d === 'UP') return dir.up;
    const s = String(p.side || '').toUpperCase();
    if (s === 'NO') return dir.down;
    if (s === 'YES') return dir.up;
    return null;
  };
  // Per-coin scoreboard. The backtest ranked the coins (BNB the workhorse, ETH negative, XRP/HYPE
  // 100% on ~8 trades) but every one of those numbers came from ONE four-day corpus, and two of them
  // flipped sign when the gate changed. So the useful thing is not the backtest's ranking — it is
  // watching which coins hold up as REAL trades land, which is what this publishes. Aggregate across
  // accounts, so it names nobody and is safe on the open route.
  const coins = new Map();
  const coinOf = sym => {
    const k = String(sym || '?').toUpperCase();
    if (!coins.has(k)) coins.set(k, { sym: k, n: 0, wins: 0, net: 0, open: 0, live: 0, lastAt: null });
    return coins.get(k);
  };
  for (const t of all) {
    const b = t.rec.book;
    const s = book.stats(b);
    closed += s.n; wins += s.wins; net += s.net; fees += s.fees;
    open += book.openPositions(b).length;
    atRisk += book.atRisk(b);
    for (const p of book.openPositions(b)) {
      const acc = sideOf(p);
      if (acc === dir.down) dir.open.down++; else if (acc === dir.up) dir.open.up++;
      coinOf(p.sym).open++;
    }
    for (const p of book.closedPositions(b)) {
      if (p.pnl == null) continue;                       // win by SIGN of realised P&L, as book.stats does
      const c = coinOf(p.sym);
      c.n++; c.net += p.pnl; if (p.pnl > 0) c.wins++;
      if (p.live) c.live++;
      const at = new Date(p.exitAt || p.at || 0).getTime();
      if (Number.isFinite(at) && at > 0 && (c.lastAt == null || at > c.lastAt)) c.lastAt = at;
      const acc = sideOf(p);
      if (!acc) continue;
      acc.n++; acc.net += p.pnl; if (p.pnl > 0) acc.wins++;
      dir.recent.push({ down: acc === dir.down, pnl: p.pnl, t: new Date(p.exitAt || p.at || 0).getTime() });
    }

    const baseline = t.get('paperResetAt');
    const pairs = [
      [live, book.stats(b, { liveOnly: true }),
        book.equity(b, { start: Number(t.get('liveBankroll')) || 0, liveOnly: true })],
      [paper, book.stats(b, { liveOnly: false, sinceMs: baseline == null ? null : Number(baseline) }),
        book.equity(b, {
          start: Number(t.get('paperBankroll')) || 0, liveOnly: false,
          sinceMs: baseline == null ? null : Number(baseline)
        })]
    ];
    for (const [acc, st, curve] of pairs) {
      acc.closed += st.n; acc.wins += st.wins; acc.net += st.net;
      acc.open += st.open; acc.atRisk += st.atRisk;
      acc.today += curve.todayNet;
      acc.dayHigh += curve.todayPeak;
    }
  }
  const round = a => ({
    ...a,
    losses: a.closed - a.wins,
    hit: a.closed ? a.wins / a.closed : null,
    net: +a.net.toFixed(2), today: +a.today.toFixed(2),
    dayHigh: +a.dayHigh.toFixed(2), atRisk: +a.atRisk.toFixed(2)
  });
  const lastPass = trader && trader.lastPass ? new Date(trader.lastPass).getTime() : null;
  // Recent-window hit per side (last 30 settled each), the timely read. warn fires when the DOWN
  // book — the structural side — slips under 65% on a real sample, the memory's "tilt has turned".
  dir.recent.sort((a, b) => b.t - a.t);
  const recentHit = down => {
    const r = dir.recent.filter(x => x.down === down).slice(0, 30);
    return { n: r.length, hit: r.length ? r.filter(x => x.pnl > 0).length / r.length : null };
  };
  const rDown = recentHit(true), rUp = recentHit(false);
  const byDir = a => ({ n: a.n, wins: a.wins, hit: a.n ? a.wins / a.n : null, net: +a.net.toFixed(2) });
  const direction = {
    open: dir.open,
    up: { ...byDir(dir.up), recentHit: rUp.hit, recentN: rUp.n },
    down: { ...byDir(dir.down), recentHit: rDown.hit, recentN: rDown.n },
    warn: rDown.hit != null && rDown.n >= 8 && rDown.hit < 0.65
  };
  // What the bot WOULD have earned above its own price ceiling. Read defensively: the shadow module is
  // only initialised by index.js, so a harness that loads sitedata alone must get a null rather than a
  // throw — the dashboard must never be the reason a pass fails.
  let shadow = null;
  try { shadow = require('./shadow').report(); } catch (_) { shadow = null; }
  // The depth experiment, so weeks of accumulation are visible instead of silent.
  let depthReport = null;
  try { depthReport = require('./depth').report(); } catch (_) { depthReport = null; }

  // Every tradeable coin appears, including ones with no closed trades yet, so an absent row means
  // "not traded" rather than "not shown". `trust` is deliberately conservative: a hit rate on fewer
  // than 10 settled trades is not a measurement, and saying so on the page is the whole point —
  // the backtest's two 100% coins were 7 and 9 trades, and one of them was a net LOSER under the
  // previous gate. Sorted worst-net first so a bleeding coin is the first thing read.
  for (const sym of gl.SYMS) coinOf(sym);
  const coinRows = [...coins.values()].map(c => ({
    sym: c.sym, n: c.n, wins: c.wins, losses: c.n - c.wins,
    hit: c.n ? c.wins / c.n : null,
    net: +c.net.toFixed(2), per: c.n ? +(c.net / c.n).toFixed(2) : null,
    open: c.open, live: c.live, lastAt: c.lastAt,
    trust: c.n === 0 ? 'none' : (c.n < 10 ? 'thin' : (c.n < 30 ? 'fair' : 'good')),
    on: gl.isEnabled(c.sym)
  })).sort((a, b) => (a.n === 0) - (b.n === 0) || a.net - b.net);
  return {
    asOf: Date.now(),
    name: NAME,
    scanner: {
      lastPass,
      ageSec: lastPass ? Math.round((Date.now() - lastPass) / 1000) : null,
      // Two poll intervals of silence means the loop is not turning, whatever the process is doing.
      healthy: lastPass ? (Date.now() - lastPass) < 45000 : false,
      passes: trader ? trader.passes : 0,
      decisions: trader ? trader.decisions : 0,
      entries: trader ? trader.entries : 0,
      lastError: trader ? trader.lastError : null
    },
    markets: gl.SYMS.map(sym => ({ sym, on: gl.isEnabled(sym) })),
    killed: gl.isKilled(),
    fleet: {
      accounts: all.length, closed, wins, losses: closed - wins,
      hit: closed ? wins / closed : null,
      net: +net.toFixed(2), fees: +fees.toFixed(2),
      open, atRisk: +atRisk.toFixed(2)
    },
    // Per book, because "how is it doing" has two answers and only one of them is real money.
    // dayHigh is summed across accounts: a fleet high-water mark, not any one account's.
    live: round(live),
    paper: round(paper),
    // The key store is reported alongside the book because it is the half that was silently
    // ephemeral. `keys` is a SOURCE and a boolean, never a path with a credential in it.
    storage: {
      dataDir: DATA_DIR, source: DATA_DIR_SOURCE,
      keys: KEY_DIR_SOURCE, keysPersistent: KEY_DIR_PERSISTENT
    },
    instance: INSTANCE,
    skips: activity.skipCounts(),
    direction,
    coins: coinRows,
    // The shadow book is OPEN data: it is a measurement of the SIGNAL at prices the bot refuses, with
    // no account, no balance and no person in it. Served here rather than behind the token because it
    // answers a question about the strategy, not about anybody's money.
    shadow,
    // Same reasoning as the shadow book: a measurement of the SIGNAL, naming no account and no money,
    // so it stays open. This one is the last untested hypothesis and it accrues forward only.
    depth: depthReport
  };
}

/**
 * Every decision the bot has made, newest first — the "why" tab.
 *
 * Deliberately includes SKIPS. A list of fills tells you what happened; the skips tell you what the
 * gate is doing, which is most of what there is to understand about a bot that trades rarely.
 *
 * ── the privacy boundary, added 2026-08-30 ──
 *
 * This served activity.recent() VERBATIM on an open route, and four of the trader's six push sites
 * interpolate `t.rec.tag || t.userId` into both the sentence and meta.who. So a settle, a fill, a
 * cashout or an account-level skip published a Discord handle — or a raw Discord user ID — beside
 * that person's per-trade P&L, position cost and daily stop figure, to anyone holding the URL. Two
 * lines above, this file promises the open routes carry "no account information"; site.js says "No
 * account, no name, no balance". Both were false. Reproduced against the real handler with no
 * credential: HTTP 200, three of three account events fully exposed.
 *
 * A MARKET event — a signal, a market skip, an error — names nobody and passes through untouched;
 * that feed is the documented point of the tab. An ACCOUNT event keeps its shape, its timing and its
 * market facts, and loses the two things that make it personal: who, and how much money.
 *
 * The owner loses nothing. Redaction applies only to an UNAUTHENTICATED request, so the dashboard
 * opened with ?key= still shows every name and every figure.
 */
const SAFE_META = new Set(['direction', 'price', 'pricePct', 'confidence', 'confirm', 'z', 'rsi',
  'style', 'spot', 'strike', 'minutesLeft', 'edgePt', 'ticker', 'closeTime', 'spotAgeMs', 'live',
  'signalAgeMs', 'gapBps', 'oneMinuteBps', 'drift10Bps', 'volumeRatio', 'realizedVolBps']);
const MONEY = /[+-]?\$\s?[\d,]+(?:\.\d+)?/g;

function redactEvent(e, ids) {
  // meta.who is set by every identity-bearing push site; reason 'account' is belt and braces.
  if (!(e.meta && e.meta.who) && e.reason !== 'account') return e;
  let detail = String(e.detail || '');
  // Those sites all format the sentence as `${who} — …`, so the identity is the first segment and
  // the FIRST separator is the one that follows it, even when the reason contains another.
  const cut = detail.indexOf(' — ');
  if (cut > 0) detail = detail.slice(cut + 3);
  for (const id of ids) if (id && detail.includes(id)) detail = detail.split(id).join('an account');
  detail = detail.replace(MONEY, () => '$—');
  const meta = {};
  for (const k of Object.keys(e.meta || {})) if (SAFE_META.has(k)) meta[k] = e.meta[k];
  return { ...e, detail, meta: Object.keys(meta).length ? meta : null };
}

function decisions(limit = 250, { redact = false } = {}) {
  let events = activity.recent(limit);
  if (redact) {
    const ids = [];
    for (const t of users.all()) { if (t.rec.tag) ids.push(t.rec.tag); if (t.userId) ids.push(String(t.userId)); }
    events = events.map(e => redactEvent(e, ids));
  }
  return { asOf: Date.now(), events, counts: activity.skipCounts() };
}

/** Per-account rows. Names and money, so this is token-gated. */
function accounts() {
  return {
    asOf: Date.now(),
    accounts: users.all().map(t => {
      const b = t.rec.book;
      const live = t.get('live');
      const baseline = t.get('paperResetAt');
      // Each book measured against ITS OWN start, and reported under its own name. The row used to
      // carry a mode-scoped equity beside a whole-book trade count, so a live account with no live
      // trades read as "0 realised, 11 closed" — two true numbers making one false impression.
      const per = (liveOnly, start, sinceMs) => {
        const curve = book.equity(b, { start: Number(start) || 0, liveOnly, sinceMs });
        const st = book.stats(b, { liveOnly, sinceMs });
        return {
          equity: curve.equity, start: curve.start, realised: curve.realised,
          peak: curve.peak, fromPeak: curve.fromPeak, maxDrawdown: curve.maxDrawdown,
          // Kept as an OBJECT because the served page reads today.net; the day's high joins it
          // rather than becoming a sibling key, so there is one place to look for "today".
          today: { net: curve.todayNet, n: curve.todayN, high: curve.todayPeak },
          atRisk: curve.atRisk, open: st.open,
          closed: st.n, wins: st.wins, losses: st.losses, hit: st.hit, fees: st.fees
        };
      };
      const liveSide = per(true, t.get('liveBankroll'), null);
      const paperSide = per(false, t.get('paperBankroll'),
        baseline == null ? null : Number(baseline));
      const active = live ? liveSide : paperSide;
      return {
        who: t.rec.tag || t.userId,
        live, armed: t.get('armed') === true,
        shares: t.get('shares'),
        // The active book, kept at the top level so existing readers of this endpoint still work.
        ...active,
        live_book: liveSide,
        paper_book: paperSide,
        days: book.byDay(b).slice(-30)
      };
    }).sort((a, b) => b.realised - a.realised)
  };
}

/** Every position across every account, newest first. Token-gated: it names people. */
function trades(limit = 300) {
  const out = [];
  for (const t of users.all()) {
    const who = t.rec.tag || t.userId;
    for (const p of book.closedPositions(t.rec.book)) {
      out.push({
        who, sym: p.sym, direction: p.direction, live: !!p.live,
        contracts: p.contracts, priceCents: p.priceCents, exitCents: p.exitPriceCents,
        cost: p.cost, fees: +((Number(p.entryFee) || 0) + (Number(p.exitFee) || 0)).toFixed(2),
        pnl: p.pnl, outcome: p.outcome,
        confidence: p.confidence, confirm: p.confirm, style: p.style, rsi: p.rsi,
        at: p.at, exitAt: p.exitAt, closeTime: p.closeTime,
        ticker: p.ticker, strike: p.strike, spot: p.spot, minutesLeft: p.minutesLeft,
        spotAgeMs: p.spotAgeMs, signalAgeMs: p.signalAgeMs,
        gapBps: p.gapBps, oneMinuteBps: p.oneMinuteBps, drift10Bps: p.drift10Bps,
        volumeRatio: p.volumeRatio, realizedVolBps: p.realizedVolBps, open: false
      });
    }
    for (const p of book.openPositions(t.rec.book)) {
      out.push({
        who, sym: p.sym, direction: p.direction, live: !!p.live,
        contracts: p.contracts, priceCents: p.priceCents, exitCents: null,
        cost: p.cost, fees: +(Number(p.entryFee) || 0).toFixed(2),
        pnl: null, outcome: 'OPEN',
        confidence: p.confidence, confirm: p.confirm, style: p.style, rsi: p.rsi,
        at: p.at, exitAt: null, closeTime: p.closeTime,
        ticker: p.ticker, strike: p.strike, spot: p.spot, minutesLeft: p.minutesLeft,
        spotAgeMs: p.spotAgeMs, signalAgeMs: p.signalAgeMs,
        gapBps: p.gapBps, oneMinuteBps: p.oneMinuteBps, drift10Bps: p.drift10Bps,
        volumeRatio: p.volumeRatio, realizedVolBps: p.realizedVolBps, open: true
      });
    }
  }
  out.sort((a, b) => new Date(b.exitAt || b.at || 0) - new Date(a.exitAt || a.at || 0));
  return { asOf: Date.now(), trades: out.slice(0, limit) };
}

/**
 * Hourly performance — "when is the best time to trade?" Buckets every SETTLED position by the
 * ET hour it was PLACED (p.at), because that is the hour a human would act on. Entry time, not
 * settlement, so the answer reads as "trades I open at 4pm do X". Open positions are excluded —
 * a bucket only counts money that has actually resolved.
 *
 * CAUTION baked into the payload: `taken` is surfaced per hour so a two-trade hour can't
 * masquerade as a signal. On a few days of data these buckets are thin; read the counts.
 */
const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
function hours() {
  const H = Array.from({ length: 24 }, (_, h) => ({
    hour: h, taken: 0, wins: 0, losses: 0, net: 0, fees: 0,
    live: { taken: 0, net: 0 }, paper: { taken: 0, net: 0 }
  }));
  let totalClosed = 0;
  for (const t of users.all()) {
    for (const p of book.closedPositions(t.rec.book)) {
      if (p.pnl == null || !p.at) continue;              // only resolved money, timestamped
      let h = parseInt(ET_HOUR.format(new Date(p.at)), 10) % 24;
      if (!(h >= 0 && h < 24)) continue;
      const b = H[h], side = p.live ? b.live : b.paper;
      b.taken++; b.net += p.pnl; b.fees += (Number(p.entryFee) || 0) + (Number(p.exitFee) || 0);
      if (p.pnl > 0) b.wins++; else if (p.pnl < 0) b.losses++;
      side.taken++; side.net += p.pnl;
      totalClosed++;
    }
  }
  for (const b of H) {
    b.net = +b.net.toFixed(2); b.fees = +b.fees.toFixed(2);
    b.hit = b.taken ? b.wins / b.taken : null;
    b.live.net = +b.live.net.toFixed(2); b.paper.net = +b.paper.net.toFixed(2);
  }
  return { asOf: Date.now(), totalClosed, hours: H };
}

/**
 * The setup sheet: what each setting is, what it should be, and the arithmetic between them.
 *
 * PRIVATE, because the `current` column is one account's configuration and bankroll. The
 * recommendations themselves are generic — src/recommend.js is pure and has no account in it — but
 * reporting them next to what somebody actually has set is account data.
 *
 * The bankroll used is the one the account is TRADING: live balance when live, paper bankroll
 * otherwise. Recommending a size against a $500 paper default while $30 of real money is armed would
 * be worse than recommending nothing.
 */
function recommendations() {
  const recommend = require('./recommend');
  let warn = false;
  try { warn = Boolean(publicState().direction.warn); } catch (_) { warn = false; }
  return {
    asOf: Date.now(),
    accounts: users.all().map(t => {
      const live = t.get('live') === true;
      // A live account's bankroll is its real balance if Kalshi has reported one, falling back to the
      // configured figure — the configured one is what the sizing actually uses when the balance is
      // not yet read, so a recommendation computed from it is the one that matches behaviour.
      const bankroll = live
        ? (t.rec.balance != null ? Number(t.rec.balance) : Number(t.get('liveBankroll')) || null)
        : Number(t.get('paperBankroll')) || null;
      const snap = {
        who: t.rec.tag || t.userId,
        bankroll, live, armed: t.get('armed') === true,
        shares: t.get('shares'), autoShares: t.get('autoShares') === true,
        riskPerTrade: t.get('riskPerTrade'), dailyStopLoss: t.get('dailyStopLoss'),
        maxOpen: t.get('maxOpen'), maxPerDir: t.get('maxPerDir'),
        maxOrderCost: t.get('maxOrderCost'), slippageCents: t.get('slippageCents'),
        fillGrace: t.get('fillGrace'), cashoutAt: t.get('cashoutAt'),
        downWarn: warn
      };
      const rows = recommend.review(snap);
      return {
        who: snap.who, live, armed: snap.armed, bankroll,
        mode: live ? 'live' : 'paper',
        rows, attention: recommend.needsAttention(rows).length,
        summary: recommend.summary(snap)
      };
    })
  };
}

/**
 * Do the gates earn their place? Splits the SETTLED book by the two assumptions worth doubting.
 *
 * ── why these two ──
 *
 * `confirm` assumes more indicator agreement is better. Nothing measured supports that: over the
 * 1,806-market corpus 4/4 went 67.6% against 3/4's 70.0%, and on a live 16-trade afternoon the split
 * was 3/11 for 4/4 against 5/5 for 3/4. The mechanism, if it is real, is that four-of-four agreement
 * means the move is fully extended — maximum consensus is the exhaustion condition, not the
 * conviction condition.
 *
 * `rsi` is the one lever that survived a chronological split. Refusing a DOWN entry whose RSI is
 * already deeply oversold dropped 14 corpus trades that went 8/14 for -$5.34, and it was the only
 * variant not negative in the weaker half.
 *
 * Both are published rather than acted on. Each bucket reports `taken` and the break-even rate its own
 * average entry price demands, because a bucket that wins 100% of five trades is not a finding, and the
 * only number that matters is the margin OVER break-even — a 68% win rate at 64c is a losing strategy.
 */
function gates() {
  const rows = [];
  for (const t of users.all()) {
    for (const p of book.closedPositions(t.rec.book)) {
      if (p.outcome === 'OPEN' || p.pnl == null) continue;
      rows.push({
        live: !!p.live, pnl: Number(p.pnl) || 0,
        won: Number(p.pnl) > 0,
        priceCents: Number(p.priceCents),
        confirm: Number(p.confirm),
        rsi: p.rsi == null ? null : Number(p.rsi),
        direction: p.direction
      });
    }
  }
  // Break-even includes the entry fee, which is the part that makes a 63% win rate at 63c a loss.
  const breakEven = pct => {
    const p = pct / 100;
    return Number.isFinite(p) && p > 0 && p < 1 ? p + 0.07 * p * (1 - p) : null;
  };
  const bucket = (label, list) => {
    if (!list.length) return { label, taken: 0, wins: 0, rate: null, net: 0, avgEntryCents: null, needRate: null, margin: null };
    const wins = list.filter(r => r.won).length;
    const net = +list.reduce((s, r) => s + r.pnl, 0).toFixed(2);
    const avg = list.reduce((s, r) => s + (Number.isFinite(r.priceCents) ? r.priceCents : 0), 0) / list.length;
    const need = breakEven(avg);
    const rate = wins / list.length;
    return {
      label, taken: list.length, wins, rate: +rate.toFixed(4), net,
      avgEntryCents: +avg.toFixed(1),
      needRate: need == null ? null : +need.toFixed(4),
      margin: need == null ? null : +(rate - need).toFixed(4)
    };
  };

  const settled = rows;
  // Oversold/overbought thresholds match the tested variant exactly (35 / 65), not a rounder number.
  const exhausted = r => r.rsi != null && (r.direction === 'DOWN' ? r.rsi < 35 : r.rsi > 65);
  return {
    asOf: Date.now(),
    settled: settled.length,
    withRsi: settled.filter(r => r.rsi != null).length,
    overall: bucket('all settled', settled),
    byConfirm: [3, 4].map(n => bucket(`${n}/4 agreed`, settled.filter(r => r.confirm === n))),
    byRsi: [
      bucket('RSI stretched (the guard would refuse)', settled.filter(exhausted)),
      bucket('RSI not stretched', settled.filter(r => r.rsi != null && !exhausted(r)))
    ],
    byDirection: ['UP', 'DOWN'].map(d => bucket(d, settled.filter(r => r.direction === d))),
    caution: 'A bucket under ~30 settled trades cannot separate a real gate from a run. Read `taken` ' +
      'and `margin` together: margin is the win rate MINUS the rate the entry price already demands, ' +
      'so a positive rate with a negative margin is a losing bucket.'
  };
}

module.exports = { publicState, decisions, accounts, trades, hours, recommendations, gates, NAME, WEB_TOKEN };
