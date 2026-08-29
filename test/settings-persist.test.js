/**
 * Every visible setting survives a write and a reload, and `armed` is not one of them.
 *
 * Two separate promises, asserted together because they are the same complaint: "have all settings
 * save, and remove the arm thing from settings because I don't know what it does".
 *
 * The arm toggle had to go for a better reason than confusion. The Settings screen writes with a
 * bare t.set(), so toggling `armed` there bypassed every check the Arm button makes — no key, no
 * live mode, no affordability warning. It was a way to put real money at risk with none of the
 * guards that exist to stop exactly that.
 *
 * Run: node test/settings-persist.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// A scratch store, so this never touches a real book.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'indic-settings-'));
process.env.STATE_DIR = DIR;

const settings = require('../src/settings');
const users = require('../src/users');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

const ID = '384033277595484160';
const onDisk = () => JSON.parse(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8')).users[ID].settings;

// ── the arm toggle is gone from the screen ──────────────────────
const visible = settings.visibleKeys();
assert.ok(!visible.includes('armed'),
  `armed must not be offered as a setting — it bypasses the Arm button's key, live and ` +
  `affordability checks. Visible: [${visible.join(', ')}]`);
checks++;
assert.ok(settings.SCHEMA.armed, 'but it still EXISTS as a stored field, or nothing could arm'); checks++;
assert.ok(settings.SCHEMA.armed.hidden === true, 'hidden is how it is withheld, not deletion'); checks++;
assert.ok(!visible.includes('paperResetAt'), 'the internal baseline stays hidden too'); checks++;
assert.ok(visible.includes('live'), 'live mode is still a setting — on its own it risks nothing'); checks++;

// ── every visible setting writes and reloads ────────────────────
users.init({ log: () => {} });
const t = users.tenant(ID, { create: true });

/** A valid, DIFFERENT value for each type, so a no-op cannot pass as a save. */
function sample(key) {
  const s = settings.SCHEMA[key];
  switch (s.type) {
    case settings.TYPE.BOOL: return t.get(key) === true ? 'off' : 'on';
    case settings.TYPE.PCT: return '30';                       // typed as a percentage
    case settings.TYPE.CENTS: return '92';                     // typed in cents
    case settings.TYPE.MONEY: return '37';
    case settings.TYPE.SECONDS: return '7';
    case settings.TYPE.INT: return String(Math.min(s.max == null ? 9 : s.max, Math.max(s.min == null ? 1 : s.min, 9)));
    default: throw new Error(`test does not know how to sample ${s.type}`);
  }
}

const wrote = {};
for (const key of visible) {
  const res = t.set(key, sample(key));
  assert.ok(res.ok, `${key}: set(${sample(key)}) was rejected — ${res.why}`);
  checks++;
  wrote[key] = t.get(key);
}

// flush(), not a wait: the store debounces by 1.5s and a test must not race it.
users.flush();
const disk = onDisk();
for (const key of visible) {
  eq(JSON.stringify(disk[key]), JSON.stringify(wrote[key]), `${key} survived the write to disk`);
}

// ── and a reload sees them ──────────────────────────────────────
const reloaded = users.init({ log: () => {} });
const t2 = users.tenant(ID);
for (const key of visible) {
  if (key === 'armed') continue;
  eq(JSON.stringify(t2.get(key)), JSON.stringify(wrote[key]), `${key} survived a restart`);
}

// ── the one exception, on purpose ───────────────────────────────
// A crash loop, a redeploy or an unattended reboot must all come back in paper.
t2.set('armed', 'on');
users.flush();
eq(onDisk().armed, true, 'armed does persist to disk while the process runs');
users.init({ log: () => {} });
eq(users.tenant(ID).get('armed'), false, 'but a restart clears it — real money needs a live human');
assert.ok(Array.isArray(reloaded.forcedDisarm), 'and the disarm is reported so the user can be told');
checks++;

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS settings-persist — ${checks} assertions (${visible.length} settings round-trip; armed is hidden)`);
