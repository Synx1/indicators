/**
 * The per-user store: one record per Discord id, holding their settings, their position book
 * and their daily risk ledger.
 *
 * ── the isolation rule ──
 *
 * A record is only ever reached by an id the caller has ALREADY authenticated. In practice that
 * means a Discord interaction's `user.id`, and nothing else — never an id read out of a message
 * body or a query string. That one rule is what makes "multiple accounts" mean separate money
 * rather than a shared pot with names on it.
 *
 * ── writes are debounced, and that has bitten before ──
 *
 * save() marks the store dirty and schedules a flush rather than writing immediately, because
 * the trading loop can touch a record several times in a pass. The consequence is that a value
 * set and then read back from DISK in the same tick is not there yet. flush() exists for the
 * cases that cannot wait, and an exit hook guarantees a pending change still lands when the
 * process goes down.
 *
 * ── arming never survives a restart ──
 *
 * init() clears `armed` on every record it loads. A crash loop, a redeploy or an unattended
 * reboot therefore all come back in paper, and real money can only be trading because somebody
 * armed it since this process started.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, OWNER_ID } = require('./config');
const settings = require('./settings');
const book = require('./book');

const FILE = path.join(DATA_DIR, 'users.json');
const SAVE_MS = 1500;

let store = { users: {} };
let dirty = false;
let timer = null;
let hooked = false;
let log = () => {};

/** A Discord snowflake and nothing else. Guards against an id arriving from a bad path. */
function validId(id) {
  return typeof id === 'string' && /^[0-9]{15,25}$/.test(id);
}

function blankUser(id) {
  return {
    userId: id,
    createdAt: new Date().toISOString(),
    lastSeen: null,
    tag: null,
    settings: settings.defaults(),
    book: book.blank(),
    // Realised P&L per ET day, for the daily stop. Keyed by date so yesterday's loss cannot
    // trip today's limit.
    day: { date: null, realised: 0, n: 0 },
    balance: null,
    balanceAt: null,
    // ── the owner's switch, and why it is on the RECORD and not in settings ──
    //
    // Settings are the user's own; this one is not theirs to change. A new account can look at its
    // panel, hold a paper book and read its own balance from the moment it appears, but nothing
    // trades — paper or live — until the owner enables it. Default false, and the owner is exempt
    // because somebody has to be able to approve the first account.
    approved: false,
    approvedAt: null,
    approvedBy: null
  };
}

function read() {
  try {
    if (!fs.existsSync(FILE)) return { users: {} };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = { users: {} };
    for (const [id, u] of Object.entries(raw.users || {})) {
      if (!validId(id)) continue;
      out.users[id] = {
        // Spread over a blank so a record written by an older build gains new fields rather
        // than reading as undefined all over the place.
        ...blankUser(id),
        ...u,
        settings: { ...settings.defaults(), ...(u.settings || {}) },
        // Repaired rather than trusted: normalise rebuilds the seq counter from the trade log,
        // so an interrupted write cannot lead to two positions sharing an id.
        book: book.normalise(u.book)
      };
    }
    return out;
  } catch (e) {
    // A corrupt file is moved aside rather than overwritten. Losing a trade history to a parse
    // error is not recoverable; losing it to a bad write on top of it is not either.
    const aside = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, aside); log(`  !! users.json unreadable (${e.message}) — moved to ${aside}`); }
    catch (_) { log(`  !! users.json unreadable (${e.message}) and could not be moved aside`); }
    return { users: {} };
  }
}

function flush() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Write-then-rename, so a crash mid-write leaves the previous file intact rather than a
    // truncated one. The whole registry is one file; a partial write is every account.
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! COULD NOT WRITE ${FILE}: ${e.message} — changes are in memory only`);
    return false;
  }
}

function save() {
  dirty = true;
  if (!hooked) {
    hooked = true;
    for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
      process.on(sig, () => { flush(); if (sig !== 'exit') process.exit(0); });
    }
  }
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, SAVE_MS);
    // Never hold the process open for a bookkeeping write; the exit hook covers shutdown.
    if (timer.unref) timer.unref();
  }
  return true;
}

function init(opts = {}) {
  log = opts.log || log;
  store = read();
  const disarmed = [];
  for (const u of Object.values(store.users)) {
    if (u.settings && u.settings.armed) { u.settings.armed = false; disarmed.push(u.userId); }
  }
  if (disarmed.length) {
    save();
    log(`  ${disarmed.length} user(s) were armed — forced to DISARMED on startup:`);
    for (const id of disarmed) log(`    ${id}`);
    log('  They must re-arm from /dashboard.');
  }
  log(`  users: ${Object.keys(store.users).length} loaded from ${FILE}`);
  // Handed back so the caller can TELL the people it happened to. A disarm nobody is told about is
  // indistinguishable from the bot disarming itself for no reason.
  store.forcedDisarm = disarmed;
  return store;
}

/** Today, in the exchange's calendar. The daily stop is about the trading day, not the viewer's. */
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Signed dollars, with the sign OUTSIDE the symbol: -$26.10, not $-26.10. */
const money = n => `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n) || 0).toFixed(2)}`;

/**
 * A handle on one user.
 *
 * `create` is true only where the person is demonstrably present — a Discord interaction from
 * them. Every other lookup reads somebody else's id and must not conjure a record from it.
 */
function tenant(userId, { create = false } = {}) {
  if (!validId(userId)) return null;
  let rec = store.users[userId];
  if (!rec) {
    if (!create) return null;
    rec = store.users[userId] = blankUser(userId);
    save();
  }

  const t = {
    userId,
    rec,
    isOwner: userId === OWNER_ID,
    get: key => rec.settings[key],
    fmt: key => settings.format(key, rec.settings[key]),
    set(key, raw) {
      const c = settings.coerce(key, raw);
      if (!c.ok) return c;
      const was = rec.settings[key];
      rec.settings[key] = c.value;
      save();
      return { ok: true, value: c.value, was };
    },
    /** Realised P&L today, resetting itself when the ET date rolls. */
    day() {
      const d = today();
      if (rec.day.date !== d) { rec.day = { date: d, realised: 0, n: 0 }; save(); }
      return rec.day;
    },
    noteRealised(pnl) {
      const day = t.day();
      day.realised = +(day.realised + (Number(pnl) || 0)).toFixed(4);
      day.n++;
      save();
      return day;
    },
    /**
     * Whether the owner has enabled this account to trade at all.
     *
     * The owner is approved implicitly: the alternative is a bot that cannot approve its own first
     * account. Everybody else waits for a press.
     */
    isApproved() {
      return userId === OWNER_ID || rec.approved === true;
    },
    /** Enable or disable an account. Only ever called from an owner-gated path. */
    setApproved(on, byUserId) {
      rec.approved = Boolean(on);
      rec.approvedAt = rec.approved ? new Date().toISOString() : null;
      rec.approvedBy = rec.approved ? String(byUserId || '') : null;
      save();
      return rec.approved;
    },
    /** Why this account cannot open a live position, or null when it can. */
    liveBlock() {
      if (!rec.settings.live) return 'live mode is off';
      if (!rec.settings.armed) return 'not armed';
      const stop = rec.settings.dailyStopLoss;
      const day = t.day();
      if (stop != null && day.realised <= -Math.abs(stop)) {
        // Says the two numbers, not just that a limit was hit. A refusal that does not show
        // its arithmetic is the thing that wasted an evening on the other bot.
        return `daily stop hit — today is ${money(day.realised)} against a ` +
          `${money(Math.abs(stop))} limit. It resets at midnight ET; nothing open was sold.`;
      }
      return null;
    },
    save
  };
  return t;
}

/**
 * Record a balance read onto a user record — the ONE writer of these fields.
 *
 * The panel refreshes a balance when somebody opens it; the trader refreshes one before it sizes an
 * armed account. Two writers with two copies of this logic is how the panel and the trader end up
 * disagreeing about the same fact, which is the shape of nearly every bug this bot has had. So both
 * call this.
 *
 * `balanceShards` is the per-exchange-shard split. Kalshi checks an order's collateral against the
 * shard its market lives on, so the total is not the spendable figure and both callers need the
 * breakdown, not just the sum.
 */
function noteBalance(t, b) {
  if (!t || !b || !b.ok || b.dollars == null) return false;
  const rec = t.rec;
  rec.balance = b.dollars;
  rec.balanceExact = b.exact != null ? b.exact : b.dollars;
  rec.balanceAt = new Date().toISOString();
  if (Array.isArray(b.breakdown)) {
    const byShard = {};
    for (const row of b.breakdown) {
      if (row && row.index != null) byShard[String(row.index)] = Number(row.dollars) || 0;
    }
    rec.balanceShards = byShard;
  }
  save();
  return true;
}

function all() {
  return Object.keys(store.users).map(id => tenant(id)).filter(Boolean);
}

function touch(userId, tag) {
  const rec = store.users[userId];
  if (!rec) return;
  rec.lastSeen = new Date().toISOString();
  if (tag && rec.tag !== tag) rec.tag = tag;
  save();
}

module.exports = {
  init, tenant, all, touch, save, flush, validId, today, money, noteBalance, FILE
};
