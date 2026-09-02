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
const presets = require('./presets');

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

/** A minutes-left bound, or the fallback. Outside 1-14 there is no 15-minute round left to trade. */
function clockBound(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 14 ? Math.round(n) : fallback;
}

function blank() {
  const p = presets.get(presets.DEFAULT);
  return {
    // The fleet-wide risk preset. Fleet-wide because it is the same KIND of fact as the kill switch — a
    // policy somebody decided for everybody, not a per-user taste. See src/presets.js for the measured
    // row behind each name.
    preset: presets.DEFAULT,
    presetBy: null,
    // Derived from the preset on a fresh install, owned by whatever last wrote them after that. An
    // operator turning a market off is a deliberate act; a market silently absent because a config file
    // was empty is not.
    disabled: SYMS.filter(s => !p.coins.includes(s)),
    // The favourite gate's clock window, in minutes left. T-6 loses money in both chronological halves of
    // the corpus, so only aggro reaches down to it.
    minLeft: p.minLeft,
    maxLeft: p.maxLeft,
    // A CEILING on each user's own maxOpen, never an assignment. A fleet policy may tighten risk; it must
    // not be able to force somebody to carry more positions than they chose.
    maxOpen: p.maxOpen,
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
    // ── one-time migration for a globals.json written before presets existed ──
    //
    // The merge alone produces a configuration nobody measured. `disabled` survives from the old file —
    // all seven coins on — while the clock and the ceiling take the new defaults, so the live state comes
    // up as seven coins on a Neutral clock: a combination with no measured row, which is the exact thing
    // this module exists to prevent. Caught on the 9cbb4c0 deploy, where the panel read 'Custom' one
    // minute after a commit message promised Neutral.
    //
    // Coins the owner deliberately turned off STAY off: the preset's list is unioned with the stored one,
    // never substituted for it. A deliberate disable outranks a default, and if that union is not any
    // preset then the label reads custom — which is then true.
    if (raw && raw.preset === undefined) {
      const dflt = presets.get(presets.DEFAULT);
      const off = new Set([...b.disabled, ...SYMS.filter(x => !dflt.coins.includes(x))]);
      b.disabled = SYMS.filter(x => off.has(x));
      b.minLeft = dflt.minLeft;
      b.maxLeft = dflt.maxLeft;
      b.maxOpen = dflt.maxOpen;
    }
    // An unreadable clock bound must not become 0 and silently refuse every market. It falls back to the
    // default preset's, which is a configuration that has a measured row behind it.
    const d = presets.get(presets.DEFAULT);
    b.minLeft = clockBound(b.minLeft, d.minLeft);
    b.maxLeft = clockBound(b.maxLeft, d.maxLeft);
    if (b.minLeft > b.maxLeft) { b.minLeft = d.minLeft; b.maxLeft = d.maxLeft; }
    const mo = Number(b.maxOpen);
    b.maxOpen = Number.isFinite(mo) && mo >= 1 ? Math.min(Math.round(mo), 20) : d.maxOpen;
    // The stored NAME is only a label for the stored VALUES, so it is re-derived rather than trusted. A
    // file hand-edited to say 'passive' while listing seven coins reads as custom, because it is.
    b.preset = presets.match({
      coins: SYMS.filter(s => !b.disabled.includes(s)),
      minLeft: b.minLeft, maxLeft: b.maxLeft, maxOpen: b.maxOpen
    });
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
  log(`  preset: ${presets.summary(state.preset)}`);
  log(`  clock: T-${state.maxLeft}..T-${state.minLeft}   fleet ceiling: ${state.maxOpen} open`);
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
  // A hand-toggled coin means the preset label may no longer describe the configuration. Re-derived
  // rather than forced to 'custom', so toggling a coin off and back on returns the name it had.
  reprice();
  save();
  return { ok: true, enabled: isEnabled(sym), preset: state.preset };
}

/** The favourite gate's clock window. The gate is measured inside it and must not trade outside it. */
const activeClock = () => ({
  minLeft: state ? state.minLeft : presets.get(presets.DEFAULT).minLeft,
  maxLeft: state ? state.maxLeft : presets.get(presets.DEFAULT).maxLeft
});

/** The fleet ceiling on concurrent positions. Each user's own maxOpen still applies underneath it. */
const maxOpenCap = () => (state && Number(state.maxOpen)) || presets.get(presets.DEFAULT).maxOpen;

/**
 * Re-derive the preset name from the values it is supposed to describe.
 *
 * The label is never the source of truth. Keeping it derived is what stops a stale name outliving the
 * configuration it named — the failure mode where a panel reads 'Passive' over seven enabled coins.
 */
function reprice() {
  state.preset = presets.match({
    coins: enabledSyms(), minLeft: state.minLeft, maxLeft: state.maxLeft, maxOpen: state.maxOpen
  });
  return state.preset;
}

/** Apply a named preset to the whole fleet. */
function setPreset(name, byUserId = null) {
  const p = presets.get(name);
  if (!p) return { ok: false, why: `no such preset: ${name} (${presets.NAMES.join(', ')})` };
  const was = state.preset;
  state.disabled = SYMS.filter(s => !p.coins.includes(s));
  state.minLeft = p.minLeft;
  state.maxLeft = p.maxLeft;
  state.maxOpen = p.maxOpen;
  state.preset = String(name).toLowerCase();
  state.presetBy = byUserId;
  save();
  return { ok: true, changed: was !== state.preset, preset: state.preset, summary: presets.summary(state.preset) };
}

/** Move the clock by hand. The label follows the values, so this usually reads back as custom. */
function setClock(minLeft, maxLeft) {
  const lo = clockBound(minLeft, null), hi = clockBound(maxLeft, null);
  if (lo == null || hi == null) return { ok: false, why: 'minutes left must be a whole number, 1-14' };
  if (lo > hi) return { ok: false, why: `floor ${lo}m is above ceiling ${hi}m` };
  state.minLeft = lo;
  state.maxLeft = hi;
  reprice();
  save();
  return { ok: true, minLeft: lo, maxLeft: hi, preset: state.preset };
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
  activeClock, maxOpenCap, setPreset, setClock, reprice, clockBound,
  get preset() { return state ? state.preset : presets.DEFAULT; },
  get state() { return state; }
};
