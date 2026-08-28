/**
 * Bot-wide state the owner controls: which markets trade, and the kill switch.
 *
 * Separate from src/users.js because these are not preferences — they are fleet-wide facts. A
 * market turned off is off for everybody, and the kill switch has to stop every account at once
 * or it is not a kill switch. Storing them per-user would mean the owner disabling BNB only
 * disabled it for the owner.
 *
 * ── the kill switch stops OPENING, never selling ──
 *
 * Anything already held keeps being managed and settled. Abandoning an open position is a
 * different and worse thing than declining to open another: a position with nothing watching it
 * cannot be stopped out, and the round still resolves whether or not the bot is paying attention.
 * The same reasoning as the daily stop, and it is worth stating twice because "kill" sounds like
 * it should mean "get me out".
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'globals.json');

/** The seven 15-minute crypto series, and the Coinbase product each prices against. */
const COINS = [
  { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' },
  { sym: 'ETH', series: 'KXETH15M', product: 'ETH-USD' },
  { sym: 'SOL', series: 'KXSOL15M', product: 'SOL-USD' },
  { sym: 'XRP', series: 'KXXRP15M', product: 'XRP-USD' },
  { sym: 'BNB', series: 'KXBNB15M', product: 'BNB-USD' },
  { sym: 'DOGE', series: 'KXDOGE15M', product: 'DOGE-USD' },
  { sym: 'HYPE', series: 'KXHYPE15M', product: 'HYPE-USD' }
];
const SYMS = COINS.map(c => c.sym);

let state = null;
let dirty = false;
let timer = null;
let log = () => {};

function blank() {
  return {
    // Every market on by default. An operator turning one off is a deliberate act; a market
    // silently absent because a config file was empty is not.
    disabled: [],
    // Kill switch. When true nothing opens, for anybody.
    killed: false,
    killedAt: null,
    killedBy: null,
    updatedAt: null
  };
}

function read() {
  try {
    if (!fs.existsSync(FILE)) return blank();
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const b = { ...blank(), ...raw };
    // Only known symbols survive a load, so a renamed or retired market cannot linger as a
    // permanent disable nobody can find in the UI.
    b.disabled = Array.isArray(b.disabled) ? b.disabled.filter(s => SYMS.includes(s)) : [];
    return b;
  } catch (e) {
    log(`  !! globals.json unreadable (${e.message}) — starting from defaults`);
    return blank();
  }
}

function flush() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    log(`  !! COULD NOT WRITE ${FILE}: ${e.message}`);
    return false;
  }
}

function save() {
  state.updatedAt = new Date().toISOString();
  dirty = true;
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush(); }, 1000);
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
  state = read();
  // The kill switch is DELIBERATELY persistent across a restart, unlike arming. Arming resets
  // because a restart means nobody is watching; a kill is a decision that somebody made and it
  // must not be undone by a redeploy.
  if (state.killed) {
    log(`  !! KILL SWITCH IS ON (set ${state.killedAt || 'unknown'}) — nothing will open`);
  }
  if (state.disabled.length) log(`  markets off: ${state.disabled.join(', ')}`);
  return state;
}

const isKilled = () => Boolean(state && state.killed);
const isEnabled = sym => Boolean(state) && !state.disabled.includes(sym);
const enabledSyms = () => SYMS.filter(isEnabled);

function setKilled(on, byUserId = null) {
  const was = Boolean(state.killed);
  state.killed = Boolean(on);
  state.killedAt = state.killed ? new Date().toISOString() : null;
  state.killedBy = state.killed ? byUserId : null;
  save();
  return { changed: was !== state.killed, killed: state.killed };
}

function toggleMarket(sym) {
  if (!SYMS.includes(sym)) return { ok: false, why: `no such market: ${sym}` };
  const i = state.disabled.indexOf(sym);
  if (i >= 0) state.disabled.splice(i, 1); else state.disabled.push(sym);
  save();
  return { ok: true, enabled: isEnabled(sym) };
}

/** Why this market cannot open right now, or null. */
function marketBlock(sym) {
  if (isKilled()) return 'kill switch is on';
  if (!isEnabled(sym)) return `${sym} is turned off`;
  return null;
}

module.exports = {
  COINS, SYMS, FILE,
  init, save, flush,
  isKilled, isEnabled, enabledSyms, setKilled, toggleMarket, marketBlock,
  get state() { return state; }
};
