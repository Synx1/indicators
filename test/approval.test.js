/**
 * The owner's switch.
 *
 * "Make an option that the owner has to enable them for it to work, and only once that happens it
 * will start trading." So the promise is narrow and worth pinning exactly: a new account can look
 * at its panel, hold settings and read its own balance from the moment it appears, and NOTHING is
 * acted on — not live, and not paper either, because a paper book built while waiting is a record
 * of trades the owner never agreed to run.
 *
 * The owner is exempt, because otherwise nobody could approve the first account.
 *
 * Run: node test/approval.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'indic-approval-'));
process.env.STATE_DIR = DIR;

const OWNER = require('../src/config').OWNER_ID;
const users = require('../src/users');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };
const STRANGER = '111111111111111111';
const onDisk = id => JSON.parse(fs.readFileSync(path.join(DIR, 'users.json'), 'utf8')).users[id];

users.init({ log: () => {} });

// ── a new account arrives switched off ──────────────────────────
const s1 = users.tenant(STRANGER, { create: true });
eq(s1.isApproved(), false, 'a brand new account is not approved');
eq(s1.rec.approved, false, 'and the field says so explicitly rather than being absent');

// ── the owner never needs approving ─────────────────────────────
const owner = users.tenant(OWNER, { create: true });
eq(owner.isApproved(), true, 'the owner is approved implicitly — somebody has to let the first one in');
eq(owner.rec.approved, false, 'without the stored flag being set, so it is a rule and not a write');

// ── enabling sticks, and records who did it ─────────────────────
s1.setApproved(true, OWNER);
eq(s1.isApproved(), true, 'enabled');
eq(s1.rec.approvedBy, OWNER, 'and the record says who enabled it');
assert.ok(s1.rec.approvedAt, 'and when'); checks++;
users.flush();
eq(onDisk(STRANGER).approved, true, 'it reached disk');

// ── it survives a restart, unlike arming ────────────────────────
users.init({ log: () => {} });
eq(users.tenant(STRANGER).isApproved(), true,
  'approval survives a restart — it is the owner\'s decision, not a session state');

// ── disabling is reversible and clears the provenance ───────────
const s2 = users.tenant(STRANGER);
s2.setApproved(false, OWNER);
eq(s2.isApproved(), false, 'disabled again');
eq(s2.rec.approvedBy, null, 'and the stale provenance is cleared rather than left to mislead');
eq(s2.rec.approvedAt, null, 'both halves of it');
users.flush();
eq(onDisk(STRANGER).approved, false, 'the disable reached disk too');

// ── the trader refuses an unapproved account outright ───────────
const trader = require('../src/trader');
const dec = {
  sym: 'BTC', market: { ticker: 'KXBTC-A', close_time: '2026-08-29T12:00:00Z' },
  side: 'YES', direction: 'UP', price: 0.7, pricePct: 70, strike: 1, spot: 1,
  confidence: 90, edgePt: 5, modelPct: 90, minutesLeft: 8, exchangeIndex: 2
};
const fake = (approved, over = {}) => ({
  rec: { book: { positions: [], seq: 0 }, balance: 50, approved },
  get: k => ({
    live: true, armed: true, autoShares: false, shares: 7, maxOpen: 3, maxOrderCost: null,
    liveBankroll: null, paperBankroll: 100, riskPerTrade: 0.25, paperResetAt: null, ...over
  })[k],
  isApproved: () => approved
});
assert.match(String(trader.accountBlock(fake(false), dec)), /not enabled by the owner yet/,
  'the scanner refuses an unapproved account'); checks++;
eq(trader.accountBlock(fake(true), dec), null, 'and takes the trade once it is enabled');
// Paper too: live off, not armed, still refused.
assert.match(String(trader.accountBlock(fake(false, { live: false, armed: false }), dec)),
  /not enabled by the owner yet/, 'paper is refused as well — waiting means waiting'); checks++;

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS approval — ${checks} assertions (off by default, owner exempt, survives restart)`);
