/**
 * The fleet risk presets: the bundles, and the WIRING that makes them bind.
 *
 * ── why the wiring half matters more ──
 *
 * A preset that sets three fields nobody reads is worse than no preset, because the panel would print a
 * measured win rate over a configuration that is not running. The mutation sweep on this project already
 * proved a correct predicate which is never called passes every suite. So each bundle is checked, and then
 * the three consumers are checked to be actually reading it: the favourite gate's clock, the round-search
 * window, and the ceiling on concurrent positions.
 *
 * ── the property that is easiest to break by accident ──
 *
 * `maxOpen` on a preset is a CEILING over each user's own setting, never an assignment. An edit that makes
 * it an assignment would silently widen somebody who deliberately chose 1 position up to Aggro's 6, which
 * is a money bug in the direction nobody checks. There is an assertion for both directions of that.
 *
 * Run: node test/presets.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A scratch DATA_DIR, so the real globals.json is never touched and persistence is tested for real.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-test-'));
process.env.DATA_DIR = DIR;

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

const presets = require('../src/presets');
const gl = require('../src/markets');
const fav = require('../src/favourite');

// ── the bundles ──
eq(presets.NAMES, ['passive', 'neutral', 'aggro'], 'three tiers, ordered least to most');
eq(presets.DEFAULT, 'neutral', 'neutral is the default — it beat aggro in both corpus halves');

for (const name of presets.NAMES) {
  const p = presets.get(name);
  ok(p.coins.length >= 1 && p.coins.every(c => presets.ALL.includes(c)), `${name}: coins are real symbols`);
  ok(p.minLeft >= 1 && p.maxLeft <= 14 && p.minLeft <= p.maxLeft, `${name}: clock is a sane window`);
  ok(p.maxOpen >= 1, `${name}: allows at least one position`);
  ok(p.measured && p.measured.n > 500, `${name}: carries a measured row with a usable sample`);
  ok(p.measured.edge > 0, `${name}: the measured edge clears break-even`);
  ok(p.measured.h1 > 0 && p.measured.h2 > 0, `${name}: positive in BOTH chronological halves`);
}

// The tiers must actually differ in the direction their names claim: more coins and more positions as you
// move up, and never less edge per trade than the tier above it.
const [pa, ne, ag] = presets.NAMES.map(presets.get);
ok(pa.coins.length < ne.coins.length && ne.coins.length < ag.coins.length, 'coin count rises with risk');
ok(pa.maxOpen < ne.maxOpen && ne.maxOpen < ag.maxOpen, 'position ceiling rises with risk');
ok(pa.measured.edge > ne.measured.edge && ne.measured.edge > ag.measured.edge, 'edge per trade falls as it widens');
ok(pa.measured.n < ne.measured.n && ne.measured.n < ag.measured.n, 'trade count rises as it widens');

// T-6 is the minute that loses money in both halves, so only aggro may reach it.
eq(pa.minLeft, 7, 'passive stops at T-7');
eq(ne.minLeft, 7, 'neutral stops at T-7');
eq(ag.minLeft, 6, 'aggro is the only tier that trades T-6');
ok(!pa.coins.includes('XRP') && !ne.coins.includes('XRP'), 'XRP is excluded below aggro — its second half went negative');
eq(ag.coins.length, presets.ALL.length, 'aggro runs every market');

// ── applying one ──
gl.init({ log: () => {} });
eq(gl.preset, 'neutral', 'a fresh install boots on the default');

for (const name of presets.NAMES) {
  const r = gl.setPreset(name, 'owner-1');
  eq(r.ok, true, `${name} applies`);
  eq(gl.preset, name, `${name} is the live label`);
  eq(gl.enabledSyms().sort(), presets.get(name).coins.slice().sort(), `${name} sets exactly its markets`);
  eq(gl.activeClock(), { minLeft: presets.get(name).minLeft, maxLeft: presets.get(name).maxLeft }, `${name} sets its clock`);
  eq(gl.maxOpenCap(), presets.get(name).maxOpen, `${name} sets its ceiling`);
}

eq(gl.setPreset('nonsense').ok, false, 'an unknown name is refused, not applied');
eq(gl.preset, 'aggro', 'and a refused switch leaves the previous preset alone');

// ── the label follows the values, never the reverse ──
gl.setPreset('neutral');
gl.toggleMarket('BTC');
eq(gl.preset, presets.CUSTOM, 'toggling a coin off makes the configuration custom');
gl.toggleMarket('BTC');
eq(gl.preset, 'neutral', 'and putting it back restores the name — custom is not a trap');

eq(gl.setClock(3, 12).preset, presets.CUSTOM, 'moving the clock by hand is custom too');
eq(gl.setClock(9, 4).ok, false, 'a floor above the ceiling is refused');
eq(gl.setClock(0, 12).ok, false, 'a bound outside 1-14 is refused');
eq(gl.activeClock(), { minLeft: 3, maxLeft: 12 }, 'and a refused clock edit leaves the previous one alone');

// A hand-edited file that lies about its name reads as what it IS, not what it says.
gl.flush();
const raw = JSON.parse(fs.readFileSync(gl.FILE, 'utf8'));
raw.preset = 'passive';
fs.writeFileSync(gl.FILE, JSON.stringify(raw));
gl.init({ log: () => {} });
eq(gl.preset, presets.CUSTOM, 'a stale label in the file does not survive a reload');

// An unreadable clock falls back to a measured configuration rather than to zero, which would refuse
// every market while looking like a working setting.
const raw2 = JSON.parse(fs.readFileSync(gl.FILE, 'utf8'));
raw2.minLeft = 'banana'; raw2.maxLeft = null; raw2.maxOpen = -4;
fs.writeFileSync(gl.FILE, JSON.stringify(raw2));
gl.init({ log: () => {} });
eq(gl.activeClock(), { minLeft: 7, maxLeft: 12 }, 'a junk clock falls back to the default preset window');
eq(gl.maxOpenCap(), 3, 'a junk ceiling falls back too');

// ── a globals.json written before presets existed ──
//
// The bug this pins shipped: merging left seven coins on a Neutral clock, a combination with no measured
// row, and the panel read 'Custom' one minute after the commit promised Neutral.
fs.writeFileSync(gl.FILE, JSON.stringify({ disabled: [], killed: false }));
gl.init({ log: () => {} });
eq(gl.preset, 'neutral', 'a pre-presets file adopts the default preset, not a half-merge');
eq(gl.enabledSyms().sort(), presets.get('neutral').coins.slice().sort(), 'and its markets');
eq(gl.activeClock(), { minLeft: 7, maxLeft: 12 }, 'and its clock');
eq(gl.maxOpenCap(), 3, 'and its ceiling');

// A coin the owner had deliberately turned off stays off through the migration, even though the default
// preset would have it on. A deliberate disable outranks a default.
fs.writeFileSync(gl.FILE, JSON.stringify({ disabled: ['BNB'], killed: false }));
gl.init({ log: () => {} });
ok(!gl.isEnabled('BNB'), 'a deliberate disable survives the migration');
ok(!gl.isEnabled('XRP'), 'and the preset still applies its own exclusion');
eq(gl.preset, presets.CUSTOM, 'the union is not a preset, so it honestly reads custom');

// Migrating twice must not undo a later change: the second boot sees a `preset` key and leaves it alone.
gl.setPreset('aggro');
gl.flush();
gl.init({ log: () => {} });
eq(gl.preset, 'aggro', 'a file that already has a preset is not re-migrated');
ok(gl.isEnabled('XRP'), 'and aggro keeps every market on across a restart');

// ── the gate reads the clock it is given ──
const q = { yesAsk: 0.87, noAsk: 0.14, yesBid: 0.86 };
eq(fav.evaluate({ ...q, minutesLeft: 6.5, minLeft: 7, maxLeft: 12 }).skip, 'fav-too-late', 'T-6.5 is refused under a 7m floor');
ok(!fav.evaluate({ ...q, minutesLeft: 6.5, minLeft: 6, maxLeft: 12 }).skip, 'and taken under a 6m floor');
ok(!fav.evaluate({ ...q, minutesLeft: 6.5 }).skip, 'an omitted window falls back to the module band');

// ── the ceiling is a ceiling, in both directions ──
//
// Mirrors the arithmetic in trader.js so a later edit that turns Math.min into an assignment fails here.
const bind = (mine, cap) => Math.min(Number(mine) || 3, cap);
eq(bind(2, 6), 2, 'aggro does not widen a user who chose 2');
eq(bind(6, 1), 1, 'passive does tighten a user who chose 6');
eq(bind(null, 3), 3, 'an unset user setting falls back to 3, still under the cap');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS presets — ${checks} checks`);
