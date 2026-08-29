/**
 * Access keys: who is allowed to use this bot, and until when.
 *
 * ── why a key rather than a list of names ──
 *
 * The owner-approval switch this replaces answered "may this person trade" but not "for how long",
 * so every renewal was a conversation and every lapse was a thing to remember. A key carries its own
 * duration: generate a 30-day one, hand it over, and access ends on its own without anybody
 * watching a calendar.
 *
 * ── one key, one person, once ──
 *
 * A key is single-use and binds to the Discord id that redeems it. Not because sharing is
 * catastrophic, but because a key that two people can redeem makes "who is on the bot" unanswerable,
 * and this file is the answer to that question. Redemption stamps who and when, and the key is spent.
 *
 * ── stacking extends, it does not reset ──
 *
 * Redeeming while still inside a period adds to the end of it. Resetting to `now + days` would
 * silently confiscate whatever was left, which is the behaviour a subscriber would rightly call
 * theft.
 *
 * ── plaintext on purpose ──
 *
 * These are not password hashes: the owner has to be able to read a key back to hand it out, and it
 * grants nothing beyond this bot. The file sits beside the book on the volume and is gitignored.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'licences.json');
const SAVE_MS = 800;

/**
 * No 0/O/1/I/L. These codes get read off a screen and typed into a phone, and a key that fails
 * because a zero was read as an O is a support conversation rather than a mistake anybody learns
 * from.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUPS = 3;
const GROUP_LEN = 4;

const MAX_DAYS = 3650;

let store = { keys: {} };
let dirty = false;
let timer = null;
let log = () => {};

function read() {
  try {
    if (!fs.existsSync(FILE)) return { keys: {} };
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { keys: raw && typeof raw.keys === 'object' && raw.keys ? raw.keys : {} };
  } catch (e) {
    // Moved aside rather than overwritten, exactly as the book is: losing the record of who paid
    // for what to a parse error is not recoverable, and losing it to a write on top of it is worse.
    const aside = `${FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(FILE, aside); log(`  !! licences.json unreadable (${e.message}) — moved to ${aside}`); }
    catch (_) { log(`  !! licences.json unreadable (${e.message}) and could not be moved aside`); }
    return { keys: {} };
  }
}

function flush() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! COULD NOT WRITE ${FILE}: ${e.message} — keys are in memory only`);
    return false;
  }
}

function save() {
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, SAVE_MS);
    if (timer.unref) timer.unref();
  }
  return true;
}

function init(opts = {}) {
  log = opts.log || log;
  store = read();
  for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
    process.on(sig, () => { flush(); if (sig !== 'exit') process.exit(0); });
  }
  const n = Object.keys(store.keys).length;
  const live = Object.values(store.keys).filter(k => k.redeemedBy).length;
  log(`  licences: ${n} key(s) from ${FILE}  (${live} redeemed, ${n - live} unused)`);
  return store;
}

/** IND-XXXX-XXXX-XXXX. Random from a CSPRNG, because a guessable key is no gate at all. */
function mint() {
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i++) {
      s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    groups.push(s);
  }
  return `IND-${groups.join('-')}`;
}

/**
 * Accept a key however it was typed.
 *
 * Case, spaces and missing dashes are all things a person does when copying a code by hand, and
 * none of them is a different key.
 */
function normalise(raw) {
  const bare = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = bare.startsWith('IND') ? bare.slice(3) : bare;
  if (body.length !== GROUPS * GROUP_LEN) return null;
  if (![...body].every(c => ALPHABET.includes(c))) return null;
  const out = [];
  for (let i = 0; i < GROUPS; i++) out.push(body.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN));
  return `IND-${out.join('-')}`;
}

/**
 * Create a key worth `days` of access. Returns the record, whose `key` is the thing to hand over.
 *
 * `days` is validated here rather than at the button, because the button is one caller and a key
 * worth 0 days — or 40 years — is a support problem either way.
 */
function generate({ days, byUserId, note = null, now = Date.now() }) {
  const n = Math.floor(Number(days));
  if (!(n >= 1 && n <= MAX_DAYS)) {
    return { ok: false, why: `days must be a whole number between 1 and ${MAX_DAYS}` };
  }
  // A collision is astronomically unlikely; checked anyway because overwriting an outstanding key
  // would silently void whatever somebody had already been given.
  let key = mint();
  let guard = 0;
  while (store.keys[key] && guard++ < 10) key = mint();
  if (store.keys[key]) return { ok: false, why: 'could not mint a unique key' };

  store.keys[key] = {
    key,
    days: n,
    createdAt: new Date(now).toISOString(),
    createdBy: String(byUserId || ''),
    note: note ? String(note).slice(0, 100) : null,
    redeemedBy: null,
    redeemedAt: null,
    revokedAt: null
  };
  save();
  return { ok: true, ...store.keys[key] };
}

/** One key by its code, however it was typed. Null when there is no such key. */
function find(raw) {
  const key = normalise(raw);
  return key && store.keys[key] ? store.keys[key] : null;
}

/**
 * Spend a key on behalf of one user.
 *
 * Returns the DAYS to add, not an expiry — extending an existing period is the caller's business
 * (users.grantAccess), because only the user record knows where the current one ends. Keeping that
 * arithmetic out of here is what lets this file stay a ledger of keys rather than of people.
 */
function redeem(raw, userId, now = Date.now()) {
  const key = normalise(raw);
  if (!key) return { ok: false, why: 'that does not look like a key — they read IND-XXXX-XXXX-XXXX' };
  const rec = store.keys[key];
  if (!rec) return { ok: false, why: 'no such key' };
  if (rec.revokedAt) return { ok: false, why: 'that key was revoked' };
  if (rec.redeemedBy) {
    return {
      ok: false,
      why: rec.redeemedBy === String(userId)
        ? 'you have already used that key'
        : 'that key has already been used by somebody else'
    };
  }
  rec.redeemedBy = String(userId);
  rec.redeemedAt = new Date(now).toISOString();
  save();
  return { ok: true, days: rec.days, key: rec.key };
}

/** Kill a key. An unredeemed one can never be spent; a spent one is left as history. */
function revoke(raw, now = Date.now()) {
  const rec = find(raw);
  if (!rec) return { ok: false, why: 'no such key' };
  if (rec.revokedAt) return { ok: false, why: 'already revoked' };
  rec.revokedAt = new Date(now).toISOString();
  save();
  return { ok: true, ...rec };
}

/** Every key, newest first. */
function all() {
  return Object.values(store.keys)
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/** Keys that can still be handed to somebody. */
function unused() {
  return all().filter(k => !k.redeemedBy && !k.revokedAt);
}

/** What one user has ever redeemed. */
function forUser(userId) {
  const id = String(userId || '');
  return all().filter(k => k.redeemedBy === id);
}

module.exports = {
  FILE, ALPHABET, MAX_DAYS,
  init, save, flush, mint, normalise,
  generate, find, redeem, revoke, all, unused, forUser
};
