/**
 * A per-coin time series of what the market looked like on every scan pass — for the chart, and for
 * nothing else.
 *
 * ── observation only, and that is a hard boundary ──
 *
 * Nothing in this file may ever be read by a decision. The favourite gate reads the order book and the
 * clock, deliberately, because the one time this project let a lagging Coinbase candle into a decision it
 * cost 85% of the bankroll. A chart needs the candles and the indicators anyway, so they get recorded
 * here — one way, after the gate has already decided, wrapped so a throw in this file cannot reach the
 * trading path. `record()` returns a boolean and swallows its own failures for exactly that reason.
 *
 * That boundary is also why the site labels these series "observed". On this strategy RSI and drift are
 * not inputs: adding them on top of the ask made Brier worse by 0.0024 over 386,958 rows. A chart that
 * implied they drove the entry would be the one dishonest thing the page could do.
 *
 * ── why rows and not objects ──
 *
 * Seven coins x 720 points is 5,040 rows. As objects with a dozen named keys each that is ~1.2 MB of JSON
 * rewritten on every flush; as fixed-order arrays it is ~300 KB. The order is documented in COLS and
 * `point()` is the only thing that builds a row, so the compactness costs one indirection and no
 * readability at the call site.
 *
 * ── persisted, because a deploy should not blank the page ──
 *
 * activity.js is in memory and that is right for it: a skip reason is interesting for a minute. A chart
 * is a history, and this bot redeploys often enough that an in-memory series would be empty most times
 * anybody looked. Same atomic write-temp-then-rename as markets.js, debounced hard — a minute, not a
 * second, because nobody is reading a chart at 20-second resolution the instant it is written.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'series.json');

/** Four hours at a 20-second poll. Enough to see a session; small enough to hold seven of them. */
const MAX_POINTS = 720;
/** A minute. This is a chart, not a ledger — see the header. */
const FLUSH_MS = 60000;

/** The row order. `point()` is the only writer and `expand()` the only reader. */
const COLS = ['at', 'spot', 'strike', 'yesAsk', 'yesBid', 'noAsk', 'minutesLeft',
  'rsi', 'gapBps', 'drift10Bps', 'realizedVolBps', 'volumeRatio', 'taken', 'reason'];

let series = null;
let dirty = false;
let timer = null;
let log = () => {};

/**
 * A finite number, or null.
 *
 * The explicit rejections are the whole function. `Number(null)`, `Number('')` and `Number(false)` are all
 * 0 — a finite number that sails through `Number.isFinite` — and `Number(true)` is 1. Written the short
 * way, this helper stored a spot of 0 for a market whose feed was dead, which a price chart would draw as
 * a real line at zero. test/series.test.js caught it on the first run, which is the third time this exact
 * coercion has produced a false number in this project.
 */
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function point(o) {
  return [
    num(o.at) || Date.now(), num(o.spot), num(o.strike),
    num(o.yesAsk), num(o.yesBid), num(o.noAsk), num(o.minutesLeft),
    num(o.rsi), num(o.gapBps), num(o.drift10Bps), num(o.realizedVolBps), num(o.volumeRatio),
    o.taken ? 1 : 0, o.reason ? String(o.reason).slice(0, 40) : null
  ];
}

const expand = row => {
  const o = COLS.reduce((a, k, i) => (a[k] = row[i], a), {});
  o.taken = row[COLS.indexOf('taken')] === 1;
  return o;
};

function read() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = {};
    for (const [sym, rows] of Object.entries(raw && raw.coins ? raw.coins : {})) {
      if (!Array.isArray(rows)) continue;
      // A row of the wrong width is a format change, not data. Dropping it beats charting a column
      // shifted by one, which would look like a real price and be a lie.
      out[sym] = rows.filter(r => Array.isArray(r) && r.length === COLS.length).slice(-MAX_POINTS);
    }
    return out;
  } catch (e) {
    log(`  !! series.json unreadable (${e.message}) — starting empty`);
    return {};
  }
}

function flush() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cols: COLS, updatedAt: Date.now(), coins: series }));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! COULD NOT WRITE ${FILE}: ${e.message}`);
    return false;
  }
}

function save() {
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
    if (timer.unref) timer.unref();
  }
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
    if (!save[`hooked_${sig}`]) {
      save[`hooked_${sig}`] = true;
      process.on(sig, () => { flush(); if (sig !== 'exit') process.exit(0); });
    }
  }
}

function init(opts = {}) {
  log = opts.log || log;
  series = read();
  const n = Object.values(series).reduce((a, r) => a + r.length, 0);
  if (n) log(`  series: ${n} observations across ${Object.keys(series).length} market(s)`);
  return series;
}

/**
 * Record one pass's observation of one market.
 *
 * Returns true when it stored something. NEVER throws: a chart that breaks the trader is worse than no
 * chart, and this is called from inside the scan loop.
 */
function record(o) {
  try {
    if (!series) series = {};
    const sym = o && o.sym;
    if (!sym) return false;
    const rows = series[sym] || (series[sym] = []);
    rows.push(point(o));
    if (rows.length > MAX_POINTS) rows.splice(0, rows.length - MAX_POINTS);
    save();
    return true;
  } catch (_) {
    return false;
  }
}

/** One market's observations, oldest first. */
function forSym(sym, limit = MAX_POINTS) {
  const rows = (series && series[sym]) || [];
  return rows.slice(-Math.max(1, Math.min(limit, MAX_POINTS))).map(expand);
}

/** How many points each market holds, for the tab counter. */
function counts() {
  const out = {};
  for (const [sym, rows] of Object.entries(series || {})) out[sym] = rows.length;
  return out;
}

const size = () => Object.values(series || {}).reduce((a, r) => a + r.length, 0);

module.exports = { init, record, forSym, counts, size, flush, save, FILE, COLS, MAX_POINTS };
