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
  for (const t of all) {
    const b = t.rec.book;
    const s = book.stats(b);
    closed += s.n; wins += s.wins; net += s.net; fees += s.fees;
    open += book.openPositions(b).length;
    atRisk += book.atRisk(b);
    for (const p of book.openPositions(b)) {
      if (p.direction === 'DOWN') dir.open.down++; else dir.open.up++;
    }
    for (const p of book.closedPositions(b)) {
      if (p.pnl == null) continue;                       // win by SIGN of realised P&L, as book.stats does
      const acc = p.direction === 'DOWN' ? dir.down : dir.up;
      acc.n++; acc.net += p.pnl; if (p.pnl > 0) acc.wins++;
      dir.recent.push({ down: p.direction === 'DOWN', pnl: p.pnl, t: new Date(p.exitAt || p.at || 0).getTime() });
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
    direction
  };
}

/**
 * Every decision the bot has made, newest first — the "why" tab.
 *
 * Deliberately includes SKIPS. A list of fills tells you what happened; the skips tell you what the
 * gate is doing, which is most of what there is to understand about a bot that trades rarely.
 */
function decisions(limit = 250) {
  return { asOf: Date.now(), events: activity.recent(limit), counts: activity.skipCounts() };
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
        confidence: p.confidence, confirm: p.confirm, style: p.style,
        at: p.at, exitAt: p.exitAt, closeTime: p.closeTime,
        spotAgeMs: p.spotAgeMs, open: false
      });
    }
    for (const p of book.openPositions(t.rec.book)) {
      out.push({
        who, sym: p.sym, direction: p.direction, live: !!p.live,
        contracts: p.contracts, priceCents: p.priceCents, exitCents: null,
        cost: p.cost, fees: +(Number(p.entryFee) || 0).toFixed(2),
        pnl: null, outcome: 'OPEN',
        confidence: p.confidence, confirm: p.confirm, style: p.style,
        at: p.at, exitAt: null, closeTime: p.closeTime,
        spotAgeMs: p.spotAgeMs, open: true
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

module.exports = { publicState, decisions, accounts, trades, hours, NAME, WEB_TOKEN };
