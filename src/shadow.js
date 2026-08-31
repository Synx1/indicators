/**
 * The shadow book: what the bot WOULD have done at a gate it is not running.
 *
 * ── why this exists ──
 *
 * Every strategy decision tonight came down to one unresolved number. The backtest says the win rate
 * is 83.9%; the live book says ~73%. Those two produce completely different futures, and there was no
 * way to tell them apart except waiting for slow live trades at ~15 a day.
 *
 * Worse, the question that mattered most — "does the edge hold at DEARER entries?" — had NO
 * out-of-sample evidence at all. The live book only contains ~59¢ entries, because MAX_PRICE refuses
 * everything above 65¢. So a ceiling change could only ever be argued from a backtest and an
 * assumption, which is exactly how the vol floor and the stop-loss got shipped and reverted.
 *
 * This closes that gap. When a market passes EVERY gate except the price ceiling, the would-be entry
 * is recorded here and graded when the market settles. After a few days there is a real, out-of-sample
 * win rate for the 65-80¢ band, measured on live market data, at zero risk. Then the ceiling becomes
 * an evidence question instead of an argument.
 *
 * ── it can never touch money ──
 *
 * Nothing in this file opens a position, reads a balance, or knows an account exists. It is a
 * per-market record, not a per-account one: the whole point is that it is the SIGNAL being measured,
 * not anybody's book. BETSSSSS keeps its late-cheap counterfactual isolated the same way and for the
 * same reason — a shadow trade that leaked into the real record would corrupt the thing it exists to
 * measure.
 *
 * ── persisted, because the answer takes days ──
 *
 * A restart must not reset the sample. Written to DATA_DIR with the same atomic
 * write-temp-then-rename that markets.js uses, and bounded so a long-running process cannot grow
 * without limit.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'shadow.json');
/** Bounded: this is diagnostic, and the aggregate is what gets read, not the individual rows. */
const MAX = 4000;
/**
 * The bands measured. The lower bound is the live ceiling, so band 0 starts exactly where the real
 * book stops — which is what makes the two comparable rather than overlapping.
 */
const BANDS = [[0.65, 0.70], [0.70, 0.75], [0.75, 0.80]];
/** Above this, not even recorded: the question is about the next slice up, not about 95¢ lottery tickets. */
const SHADOW_MAX = 0.80;

let log = () => {};
let state = null;
let dirty = false;
let timer = null;

const blank = () => ({ v: 1, entries: [], updatedAt: null });

function read() {
  try {
    if (!fs.existsSync(FILE)) return blank();
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const s = { ...blank(), ...raw };
    s.entries = Array.isArray(s.entries) ? s.entries.filter(e => e && e.ticker) : [];
    return s;
  } catch (e) {
    log(`  !! shadow.json unreadable (${e.message}) — starting a fresh shadow book`);
    return blank();
  }
}

function flush() {
  if (!dirty || !state) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! COULD NOT WRITE ${FILE}: ${e.message}`);
    return false;
  }
}

/** Coalesced: a pass can record several shadows and they share one write. */
function save() {
  if (!state) return;
  state.updatedAt = new Date().toISOString();
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, 2000);
    if (timer.unref) timer.unref();
  }
}

function init(opts = {}) {
  log = opts.log || log;
  state = read();
  const open = state.entries.filter(e => !e.outcome).length;
  if (state.entries.length) {
    log(`  shadow book: ${state.entries.length} recorded, ${open} awaiting settlement`);
  }
  return state;
}

/** Which band a price falls in, or null when it is outside the measured range. */
function bandOf(price) {
  if (!Number.isFinite(price)) return null;
  for (const [lo, hi] of BANDS) if (price > lo && price <= hi) return `${lo * 100}-${hi * 100}c`;
  return null;
}

/**
 * Record a would-be entry. Returns the row, or null when it does not belong in the sample.
 *
 * Idempotent per ticker: a pass runs every POLL_MS and the same market stays too-dear for minutes, so
 * without this the sample would count one signal dozens of times and report a win rate weighted by how
 * long each market sat in the band. That is the failure mode that would make this whole file lie.
 */
function record(c) {
  if (!state) return null;
  const price = Number(c && c.price);
  const band = bandOf(price);
  if (!band) return null;
  if (state.entries.some(e => e.ticker === c.ticker)) return null;
  const row = {
    ticker: String(c.ticker), sym: String(c.sym || '?'), band,
    side: c.side === 'YES' ? 'YES' : 'NO',
    price: +price.toFixed(4), pricePct: Math.round(price * 100),
    confidence: Number(c.confidence) || null,
    confirm: Number(c.confirm) || null,
    closeTime: c.closeTime || null,
    at: new Date().toISOString(),
    outcome: null, won: null, settledAt: null
  };
  state.entries.push(row);
  if (state.entries.length > MAX) state.entries.splice(0, state.entries.length - MAX);
  save();
  return row;
}

/**
 * Grade one shadow row against the market's own result.
 *
 * Uses the SAME truth table as the real book (trader.gradeWin) rather than a local copy, so a shadow
 * win and a real win can never mean different things — the reason this takes a grader rather than
 * implementing the comparison itself.
 */
function settle(ticker, result, gradeWin) {
  if (!state) return null;
  const row = state.entries.find(e => e.ticker === ticker && !e.outcome);
  if (!row) return null;
  const r = String(result || '').toLowerCase();
  if (r !== 'yes' && r !== 'no') return null;      // not resolved yet; leave it open
  row.won = Boolean(gradeWin(row.side, r));
  row.outcome = row.won ? 'WIN' : 'LOSS';
  row.settledAt = new Date().toISOString();
  save();
  return row;
}

/** Rows still awaiting a result, oldest first — what a settle pass should look up. */
function pending(limit = 60) {
  if (!state) return [];
  return state.entries.filter(e => !e.outcome).slice(0, limit);
}

/**
 * The whole point: an out-of-sample win rate per price band, and the margin it implies.
 *
 * `margin` is win% − avgEntry, which on a binary IS the edge per contract, because breakeven equals the
 * entry price. A band whose margin is positive is one the ceiling could be raised into; a band at or
 * below zero is one that would have lost money, however confident the model was.
 *
 * `enough` is deliberately conservative. Under 20 settled trades a band's win rate is not a
 * measurement, and the whole reason this file exists is that decisions were being made on samples too
 * small to carry them.
 */
const MIN_SAMPLE = 20;
function report() {
  if (!state) return { asOf: Date.now(), total: 0, settled: 0, pending: 0, bands: [], liveCeiling: 0.65 };
  const settled = state.entries.filter(e => e.outcome);
  const bands = BANDS.map(([lo, hi]) => {
    const key = `${lo * 100}-${hi * 100}c`;
    const rows = settled.filter(e => e.band === key);
    const wins = rows.filter(e => e.won).length;
    const avgEntry = rows.length ? rows.reduce((a, e) => a + e.price, 0) / rows.length : null;
    const hit = rows.length ? wins / rows.length : null;
    return {
      band: key, lo, hi, n: rows.length, wins, losses: rows.length - wins, hit,
      avgEntry: avgEntry == null ? null : +avgEntry.toFixed(4),
      // Breakeven on a binary equals the entry price, so this is the edge per contract.
      //
      // `+ 0` normalises negative zero. A band that wins exactly as often as its price implies has zero
      // edge, and JS renders that subtraction as -0, which the page would print as "-0.0pp" — reading
      // as a small loss when it is precisely break-even. (-0 + 0 is +0 under IEEE 754.)
      margin: hit == null || avgEntry == null ? null : +(hit - avgEntry).toFixed(4) + 0,
      pending: state.entries.filter(e => e.band === key && !e.outcome).length,
      enough: rows.length >= MIN_SAMPLE
    };
  });
  return {
    asOf: Date.now(),
    total: state.entries.length, settled: settled.length,
    pending: state.entries.length - settled.length,
    bands, liveCeiling: 0.65, minSample: MIN_SAMPLE, updatedAt: state.updatedAt
  };
}

/** Test seam: replace the whole book. Never called by the bot. */
function _reset(entries = []) { state = { ...blank(), entries }; dirty = false; }

module.exports = {
  init, record, settle, pending, report, bandOf, flush, _reset,
  FILE, BANDS, SHADOW_MAX, MAX, MIN_SAMPLE,
  get size() { return state ? state.entries.length : 0; }
};
