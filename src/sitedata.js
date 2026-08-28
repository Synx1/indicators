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
  for (const t of all) {
    const s = book.stats(t.rec.book);
    closed += s.n; wins += s.wins; net += s.net; fees += s.fees;
    open += book.openPositions(t.rec.book).length;
    atRisk += book.atRisk(t.rec.book);
  }
  const lastPass = trader && trader.lastPass ? new Date(trader.lastPass).getTime() : null;
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
    // The key store is reported alongside the book because it is the half that was silently
    // ephemeral. `keys` is a SOURCE and a boolean, never a path with a credential in it.
    storage: {
      dataDir: DATA_DIR, source: DATA_DIR_SOURCE,
      keys: KEY_DIR_SOURCE, keysPersistent: KEY_DIR_PERSISTENT
    },
    instance: INSTANCE,
    skips: activity.skipCounts()
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
      const eq = book.equity(b, {
        start: Number(live ? t.get('liveBankroll') : t.get('paperBankroll')) || 0,
        liveOnly: live ? true : false
      });
      const s = book.stats(b);
      const today = book.todayStats(b);
      return {
        who: t.rec.tag || t.userId,
        live, armed: t.get('armed') === true,
        shares: t.get('shares'),
        equity: eq.equity, start: eq.start, realised: eq.realised,
        peak: eq.peak, fromPeak: eq.fromPeak, maxDrawdown: eq.maxDrawdown,
        atRisk: eq.atRisk, open: book.openPositions(b).length,
        closed: s.n, wins: s.wins, losses: s.n - s.wins, hit: s.hit, fees: s.fees,
        today: { net: today.net, n: today.n, wins: today.wins },
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

module.exports = { publicState, decisions, accounts, trades, NAME, WEB_TOKEN };
