/**
 * A ring buffer of what the bot decided, and why.
 *
 * ── why this exists ──
 *
 * The trader already logs every decision and every skip, but a log line is gone the moment the
 * process restarts and cannot be read from a browser. "Why didn't it trade BTC?" was answerable
 * only by having been watching at the time.
 *
 * So every pass records its verdict per market — taken, or skipped with the reason and the numbers
 * behind it. That turns the site's trade tab from a list of fills into an account of the bot's
 * reasoning, which is the difference between trusting it and hoping.
 *
 * ── in memory on purpose ──
 *
 * This is diagnostic, not a ledger. The BOOK is the record that must survive a restart, and it
 * does; losing the last few hundred skip reasons costs nothing and writing them to disk every
 * twenty seconds would be a lot of I/O for something nobody reads twice. Bounded so a long-running
 * process cannot grow without limit.
 */

const MAX = 600;
const events = [];

let seq = 0;

/**
 * Record one market's verdict for one round.
 *
 * @param {object} e
 * @param {string} e.sym
 * @param {'TAKEN'|'SKIP'|'EXIT'|'SETTLE'|'ERROR'} e.kind
 * @param {string} e.reason   machine-ish code, for grouping
 * @param {string} e.detail   the sentence a human reads
 */
function push(e) {
  events.push({
    seq: ++seq,
    at: Date.now(),
    sym: e.sym || null,
    kind: e.kind,
    reason: e.reason || null,
    detail: e.detail || '',
    // Everything numeric the decision was based on, so a row can be audited rather than trusted.
    meta: e.meta || null
  });
  if (events.length > MAX) events.splice(0, events.length - MAX);
  return events[events.length - 1];
}

/** Newest first, optionally filtered. */
function recent(limit = 200, { kind = null, sym = null } = {}) {
  let out = events;
  if (kind) out = out.filter(e => e.kind === kind);
  if (sym) out = out.filter(e => e.sym === sym);
  return out.slice(-limit).reverse();
}

/** How often each skip reason fired, so the gate that is doing the work is visible. */
function skipCounts() {
  const out = {};
  for (const e of events) {
    if (e.kind !== 'SKIP' || !e.reason) continue;
    out[e.reason] = (out[e.reason] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function clear() { events.length = 0; seq = 0; }

module.exports = { push, recent, skipCounts, clear, MAX, get size() { return events.length; } };
