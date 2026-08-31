/**
 * The privacy boundary: what a stranger with the URL is allowed to see.
 *
 * ── why this file exists ──
 *
 * src/site.js says of its open routes "No account, no name, no balance", and src/sitedata.js says
 * the open feed "carries no account information". On 2026-08-30 both were false: /api/decisions
 * served the activity ring verbatim, and four of the trader's six push sites interpolate
 * `t.rec.tag || t.userId` into the sentence AND meta.who. So a settle, a fill, a cashout or an
 * account-level skip published a Discord handle — or a raw Discord user ID — next to that person's
 * per-trade P&L, their position cost and their daily stop figure, to anyone holding the link.
 *
 * A mutation test the same day confirmed nothing was watching: turning `authed()` into
 * `return true` and disabling redaction outright both left all twelve suites green.
 *
 * Two rules are asserted here, and they are the whole contract:
 *   1. WITHOUT a token: no account name, no Discord ID, and no dollar figure may appear anywhere in
 *      an open payload — and the private routes answer 401 rather than data.
 *   2. WITH the token: the owner still sees everything, because a privacy fix that blinds the owner
 *      would just be turned off again.
 *
 * Run: node test/privacy.test.js
 */
const assert = require('assert');
const http = require('http');
const Module = require('module');

const TOKEN = 'test-token-not-a-real-one';
// The fail-closed half of the contract runs as a CHILD of this suite with WEB_TOKEN unset, because
// the token is read once at require time and "no token configured" is a whole-process condition.
// Turning `if (!token) return false` into `return true` left all twelve old suites green; the block
// at the bottom of this file is what now catches it.
const NO_TOKEN_MODE = process.env.PRIVACY_TEST_NO_TOKEN === '1';
process.env.WEB_TOKEN = NO_TOKEN_MODE ? '' : TOKEN;

// A synthetic account, so the redactor has a known identity to strip and no real book is touched.
const TAG = 'someones_handle';
const UID = '222222222222222222';
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './users') {
    return {
      all: () => [{ userId: UID, rec: { tag: TAG, book: { positions: [] } }, get: () => null }],
      money: n => '$' + Number(n).toFixed(2)
    };
  }
  // publicState reaches for the trader's live stats; it already tolerates the module being absent.
  if (request === './trader') throw new Error('trader not started in this test');
  return origLoad.apply(this, arguments);
};

// Capture the request handler without binding a port — this suite must not open a socket.
let handler = null;
const realCreateServer = http.createServer;
http.createServer = fn => { handler = fn; return { on() { return this; }, listen() { return this; } }; };
require('../src/site').start({ log: () => {} });
http.createServer = realCreateServer;

const activity = require('../src/activity');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const GET = (url, headers = {}) => {
  let code = null, body = null;
  handler({ url, headers }, { writeHead(c) { code = c; }, end(b) { body = b; } });
  return { code, body: body == null ? '' : String(body) };
};

// The four identity-bearing shapes, copied from the trader's own push sites (cashout, settle, fill,
// account skip) so this suite fails if those sites start carrying something new.
activity.clear();
activity.push({
  sym: 'BTC', kind: 'SETTLE', reason: 'won',
  detail: `${TAG} — DOWN @57¢ settled 100¢, +$12.40`,
  meta: { who: TAG, pnl: 12.4, live: true, seq: 91 }
});
activity.push({
  sym: 'ETH', kind: 'EXIT', reason: 'filled-live',
  detail: `${UID} — LIVE 40× @57¢, cost $22.80`,
  meta: { who: UID, live: true, seq: 92 }
});
activity.push({
  sym: 'SOL', kind: 'SKIP', reason: 'account',
  detail: `${TAG} — daily stop hit — live is -$57.30 today against a $50.00 limit.`,
  meta: { who: TAG }
});
// And two market events, which name nobody and must survive untouched.
activity.push({ sym: 'XRP', kind: 'SKIP', reason: 'stale-spot', detail: 'spot is 61s old' });
activity.push({
  sym: 'DOGE', kind: 'TAKEN', reason: 'signal',
  detail: 'DOWN @57¢ — 84% confidence, 3/4 indicators agreed, chased a move',
  meta: { direction: 'DOWN', confidence: 84, confirm: 3, spotAgeMs: 1200, minutesLeft: 9.4, pricePct: 57 }
});

// ── 4. with NO token configured, private stays private ───────────
//
// The safe answer to "is this secret?" is yes. An unconfigured WEB_TOKEN must CLOSE the private
// routes, not open them — the opposite of how most gates fail.
if (NO_TOKEN_MODE) {
  for (const path of ['/api/trades', '/api/accounts', '/api/hours', '/api/recommend']) {
    const r = GET(path);
    eq(r.code, 401, `${path} is 401 when no WEB_TOKEN is configured`);
    ok(!r.body.includes(TAG) && !r.body.includes(UID), `${path} still names nobody`);
  }
  // And no key can be guessed into working, because there is nothing to match.
  for (const g of ['', 'x', 'undefined', 'null', 'true', TOKEN]) {
    eq(GET('/api/accounts?key=' + encodeURIComponent(g)).code, 401,
      `no token configured: key ${JSON.stringify(g)} is still refused`);
    eq(GET('/api/accounts', { 'x-web-key': g }).code, 401,
      `no token configured: header ${JSON.stringify(g)} is still refused`);
  }
  // The open feed must still be redacted, since nobody can ever authenticate.
  const feed = GET('/api/decisions');
  eq(feed.code, 200, 'the open feed still serves with no token configured');
  ok(!feed.body.includes(TAG) && !feed.body.includes(UID),
    'with no token configured the feed is redacted for everyone');
  console.log(`  fail-closed (no WEB_TOKEN): ${checks} checks`);
  process.exit(0);
}

// ── 1. private routes stay private ─────────────────────────────
// /api/recommend is in this list because its `current` column is one account's settings and bankroll.
// The recommendations themselves are generic arithmetic (src/recommend.js is pure and has no account
// in it), but reporting them beside what somebody actually has set is account data.
for (const path of ['/api/trades', '/api/accounts', '/api/hours', '/api/recommend']) {
  const r = GET(path);
  eq(r.code, 401, `${path} without a key is 401`);
  ok(!r.body.includes(TAG) && !r.body.includes(UID), `${path} 401 body names nobody`);
}
for (const badKey of ['', 'x', TOKEN.slice(0, -1), TOKEN + 'x', TOKEN.toUpperCase(), ' ' + TOKEN]) {
  eq(GET('/api/accounts?key=' + encodeURIComponent(badKey)).code, 401,
    `a wrong key ${JSON.stringify(badKey)} is refused`);
}
eq(GET('/api/accounts?key=' + TOKEN).code, 200, 'the right key in the query string is accepted');
eq(GET('/api/accounts', { 'x-web-key': TOKEN }).code, 200, 'the right key in the header is accepted');
// Equal length but different bytes — the constant-time compare must refuse, not throw.
eq(GET('/api/accounts?key=' + encodeURIComponent('é'.repeat(TOKEN.length))).code, 401,
  'a same-length unicode key is refused without throwing');

// ── 2. the OPEN feed carries no identity and no money ───────────
const anon = GET('/api/decisions');
eq(anon.code, 200, 'the open decisions feed still serves — the skip log is the point of the tab');
ok(!anon.body.includes(TAG), 'no account handle anywhere in the open payload');
ok(!anon.body.includes(UID), 'no Discord user ID anywhere in the open payload');
const moneyLeft = anon.body.replace(/\$—/g, '').match(/\$\s?-?[\d,]+\.?\d*/g);
ok(!moneyLeft, `no dollar figure survives redaction (found ${JSON.stringify(moneyLeft)})`);
const events = JSON.parse(anon.body).events;
eq(events.length, 5, 'every event is still served, redacted rather than dropped');
for (const e of events) {
  ok(!(e.meta && e.meta.who), `${e.kind}: meta.who is gone`);
  ok(!(e.meta && 'pnl' in e.meta), `${e.kind}: meta.pnl is gone`);
  ok(!(e.meta && 'seq' in e.meta), `${e.kind}: the book sequence number is gone`);
}
// Redaction must keep what makes the feed worth reading.
const byReason = r => events.find(e => e.reason === r);
eq(byReason('won').detail, 'DOWN @57¢ settled 100¢, $—', 'a settle keeps its market facts');
eq(byReason('filled-live').detail, 'LIVE 40× @57¢, cost $—', 'a fill keeps size and price');
ok(/daily stop hit/.test(byReason('account').detail), 'an account skip still says WHY it skipped');
eq(byReason('stale-spot').detail, 'spot is 61s old', 'a market skip passes through untouched');
eq(byReason('signal').detail, 'DOWN @57¢ — 84% confidence, 3/4 indicators agreed, chased a move',
  'a signal passes through untouched');
const sig = byReason('signal').meta;
ok(sig.confidence === 84 && sig.confirm === 3 && sig.direction === 'DOWN' && sig.spotAgeMs === 1200,
  'the signal meta the dashboard renders survives redaction');
ok(Object.keys(JSON.parse(anon.body).counts).length > 0, 'the skip-reason counts still serve');

// /api/state is the other open route.
const state = GET('/api/state');
eq(state.code, 200, '/api/state serves openly');
ok(!state.body.includes(TAG), '/api/state names no account');
ok(!state.body.includes(UID), '/api/state carries no Discord ID');

// ── 3. the owner, holding the token, still sees everything ──────
for (const [how, r] of [
  ['?key=', GET('/api/decisions?key=' + TOKEN)],
  ['x-web-key', GET('/api/decisions', { 'x-web-key': TOKEN })]
]) {
  eq(r.code, 200, `${how}: the owner's feed serves`);
  ok(r.body.includes(TAG), `${how}: the owner still sees the handle`);
  ok(/12\.4/.test(r.body), `${how}: the owner still sees the per-trade P&L`);
}
// A WRONG key must fall back to the redacted feed, not the full one.
ok(!GET('/api/decisions?key=wrong').body.includes(TAG),
  'a wrong key gets the redacted feed, not the owner view');

const { spawnSync } = require('child_process');
const child = spawnSync(process.execPath, [__filename], {
  env: { ...process.env, WEB_TOKEN: '', PRIVACY_TEST_NO_TOKEN: '1' },
  encoding: 'utf8'
});
checks++;
assert.strictEqual(child.status, 0,
  `the no-token fail-closed pass must succeed:\n${child.stdout}\n${child.stderr}`);
process.stdout.write(child.stdout);

console.log(`PASS privacy boundary — ${checks} checks`);


