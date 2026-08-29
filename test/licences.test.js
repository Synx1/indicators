/**
 * Access keys: generation, redemption, and the clock.
 *
 * Every rule here is one somebody would notice if it were wrong, and two of them are the kind that
 * would be noticed as theft: a key redeemed twice, and a renewal that resets the clock instead of
 * extending it. So both are asserted directly rather than left to the shape of the code.
 *
 * The clock is passed in everywhere — a test that only passes today is not a test.
 *
 * Run: node test/licences.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'indic-lic-'));
process.env.STATE_DIR = DIR;

const licences = require('../src/licences');
const users = require('../src/users');
const OWNER = require('../src/config').OWNER_ID;

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };
const ok = (c, what) => { assert.ok(c, what); checks++; };

const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const T0 = new Date('2026-09-01T12:00:00Z').getTime();
const DAY = 86400000;

licences.init({ log: () => {} });
users.init({ log: () => {} });

// ── minting ─────────────────────────────────────────────────────
const k = licences.generate({ days: 30, byUserId: OWNER, note: 'for alice', now: T0 });
ok(k.ok, 'a 30-day key generates');
assert.match(k.key, /^IND-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
  `key looks like IND-XXXX-XXXX-XXXX, got ${k.key}`); checks++;
ok(!/[01OIL]/.test(k.key.slice(4)), 'and avoids characters that get misread off a screen');
eq(k.days, 30, 'carrying its duration');
eq(k.note, 'for alice', 'and the note the owner left themselves');
eq(licences.generate({ days: 0, byUserId: OWNER }).ok, false, 'zero days is refused');
eq(licences.generate({ days: -5, byUserId: OWNER }).ok, false, 'and so is negative');
eq(licences.generate({ days: 99999, byUserId: OWNER }).ok, false, 'and so is 273 years');
eq(licences.generate({ days: 'abc', byUserId: OWNER }).ok, false, 'and so is nonsense');

// Two keys are never the same key.
const many = new Set(Array.from({ length: 200 }, () => licences.generate({ days: 1, byUserId: OWNER }).key));
eq(many.size, 200, '200 keys, 200 distinct codes');

// ── typing it back in ───────────────────────────────────────────
eq(licences.normalise(k.key), k.key, 'the exact code normalises to itself');
eq(licences.normalise(k.key.toLowerCase()), k.key, 'lower case is the same key');
eq(licences.normalise(k.key.replace(/-/g, '')), k.key, 'so is pasting it without dashes');
eq(licences.normalise(` ${k.key} `), k.key, 'and with stray spaces');
eq(licences.normalise('IND-1111-1111-1111'), null, 'a code using excluded characters is not a key');
eq(licences.normalise('hello'), null, 'and nor is a word');

// ── redeeming ───────────────────────────────────────────────────
const r = licences.redeem(k.key, ALICE, T0);
ok(r.ok, 'alice redeems it');
eq(r.days, 30, 'and is told what it is worth');
eq(licences.find(k.key).redeemedBy, ALICE, 'the key records who spent it');

const again = licences.redeem(k.key, BOB, T0);
eq(again.ok, false, 'bob cannot spend the same key');
assert.match(again.why, /already been used/, 'and is told why'); checks++;
const selfAgain = licences.redeem(k.key, ALICE, T0);
eq(selfAgain.ok, false, 'nor can alice spend it twice');
assert.match(selfAgain.why, /already used that key/, 'with a message aimed at her'); checks++;
eq(licences.redeem('IND-2222-3333-4444', ALICE, T0).ok, false, 'an invented key is refused');

// ── revoking ────────────────────────────────────────────────────
const spare = licences.generate({ days: 7, byUserId: OWNER, now: T0 });
ok(licences.revoke(spare.key, T0).ok, 'an unused key can be revoked');
eq(licences.redeem(spare.key, BOB, T0).ok, false, 'and then cannot be spent');
eq(licences.unused().some(x => x.key === spare.key), false, 'it leaves the unused list');

// ── the clock on a user record ───────────────────────────────────
const alice = users.tenant(ALICE, { create: true });
eq(alice.hasAccess(T0), false, 'before any key, no access');
const g = alice.grantAccess(30, k.key, T0);
ok(g.ok, '30 days granted');
eq(alice.hasAccess(T0), true, 'access now');
eq(alice.hasAccess(T0 + 29 * DAY), true, 'still there on day 29');
eq(alice.hasAccess(T0 + 30 * DAY + 1000), false, 'and gone just after day 30');
eq(Math.round(alice.accessLeftMs(T0) / DAY), 30, 'the panel can say 30 days left');

// Extending must ADD to what is left, not restart it.
const g2 = alice.grantAccess(7, 'IND-AAAA-BBBB-CCCC', T0 + 10 * DAY);
eq(g2.extended, true, 'a renewal inside the period is an extension');
eq(Math.round((new Date(g2.until).getTime() - T0) / DAY), 37,
  '30 + 7 = 37 days from the start, not 17 from the renewal');
// A key redeemed after a lapse starts from the moment of redemption.
const lapsed = users.tenant(BOB, { create: true });
lapsed.grantAccess(1, 'IND-DDDD-EEEE-FFFF', T0);
const g3 = lapsed.grantAccess(7, 'IND-GGGG-HHHH-JJJJ', T0 + 5 * DAY);
eq(g3.extended, false, 'past the end, it is a fresh start');
eq(Math.round((new Date(g3.until).getTime() - (T0 + 5 * DAY)) / DAY), 7, 'seven days from now');

// ── the owner needs no key, and a block beats one ───────────────
const owner = users.tenant(OWNER, { create: true });
eq(owner.hasAccess(T0), true, 'the owner always has access — they generate the keys');
eq(owner.accessLeftMs(T0), Infinity, 'with no clock to show');
alice.setBlocked(true);
eq(alice.hasAccess(T0), false, 'a block denies even with 37 days on the clock');
eq(Math.round(alice.accessLeftMs(T0) / DAY), 37, 'and the clock keeps running while blocked');
alice.setBlocked(false);
eq(alice.hasAccess(T0), true, 'unblocking restores what was already paid for');

// ── it all survives a restart ───────────────────────────────────
licences.flush();
users.flush();
const before = licences.find(k.key).redeemedBy;
licences.init({ log: () => {} });
users.init({ log: () => {} });
eq(licences.find(k.key).redeemedBy, before, 'the key ledger reloads');
eq(users.tenant(ALICE).hasAccess(T0), true, 'and so does the access it bought');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS licences — ${checks} assertions (single use, extends not resets, owner exempt)`);
