/**
 * Paper has to be able to miss, and the daily stop has to count real money only.
 *
 * Both of these were flatteries rather than bugs in the ordinary sense — the code did exactly what
 * it said, and what it said was too kind:
 *
 *   1. src/trader.js's own header claimed "the one honest difference is that paper cannot miss a
 *      fill". On 2026-08-29 six LIVE orders missed and every paper entry filled at the quote, so
 *      paper was scoring a strategy nobody could have executed. A live order is
 *      immediate-or-cancel at quote + slippage: it fills only if somebody is still offering inside
 *      that limit when it lands, and it fills at THEIR price.
 *   2. noteRealised() counted paper and live into one daily figure that the stop then judged. Paper
 *      is sized off its own bankroll, so its swings are larger: a -$105 paper day halted real
 *      trading, and a +$100 paper day would have hidden a -$50 live one.
 *
 * Run: node test/paper-realism.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'indic-paper-'));
process.env.STATE_DIR = DIR;

const { paperFill } = require('../src/trader');
const users = require('../src/users');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

// ── the fill model ──────────────────────────────────────────────
// Quoted 74c, 2c allowance, so the limit is 76c.
const at = askNowCents => paperFill({ askNowCents, limitCents: 76, quotedCents: 74 });

eq(at(74).filled, true, 'unchanged book fills');
eq(at(74).priceCents, 74, 'at the quote it saw');
eq(at(74).slippedCents, 0, 'with no slippage');

eq(at(76).filled, true, 'a book that moved TO the limit still fills');
eq(at(76).priceCents, 76, 'at the limit');
eq(at(76).slippedCents, 2, 'and the 2c chased is recorded, because it comes off the edge');

eq(at(77).filled, false, 'one cent past the limit is a MISS, not a fill at 77c');
assert.match(at(77).why, /moved to 77c, past the 76c limit/, 'and says what happened'); checks++;
eq(at(95).filled, false, 'a book that ran away is a miss');

eq(at(70).filled, true, 'a book that moved in our favour fills');
eq(at(70).priceCents, 70, 'at the better price, because that is a real outcome');
eq(at(70).slippedCents, -4, 'recorded as negative slippage rather than hidden');

// Absence of an offer is not a price — the same rule sellPrice() applies on the way out.
eq(at(null).filled, false, 'no ask at all is a miss');
eq(at(0).filled, false, 'and so is a zero ask');
eq(at(NaN).filled, false, 'and so is an unparseable one');
assert.match(at(null).why, /nothing offered/, 'said in those words'); checks++;

// A zero allowance means the book must not have moved at all.
eq(paperFill({ askNowCents: 75, limitCents: 74, quotedCents: 74 }).filled, false,
  'with no slippage allowance, one cent against us is a miss');

// ── the daily stop counts real money only ───────────────────────
users.init({ log: () => {} });
const t = users.tenant('384033277595484160', { create: true });
t.set('live', 'on');
t.set('armed', 'on');
t.set('dailyStopLoss', '10');

eq(t.liveBlock(), null, 'a fresh armed day is not blocked');

// A paper hammering must not touch the live stop.
t.noteRealised(-60, false);
t.noteRealised(-45, false);
eq(t.day().realised, -105, 'the day total carries the paper losses, for the panel');
eq(t.day().live, 0, 'but the LIVE ledger is untouched');
eq(t.liveBlock(), null, '-$105 of paper does not stop real trading');

// Real losses do.
t.noteRealised(-4, true);
eq(t.day().live, -4, 'a live loss lands on the live ledger');
eq(t.liveBlock(), null, '-$4 is inside a $10 limit');
t.noteRealised(-7, true);
eq(t.day().live, -11, 'now past it');
assert.match(String(t.liveBlock()), /daily stop hit — live is -\$11\.00 today/,
  'and the stop trips, quoting the live figure rather than the pooled one'); checks++;

// And the dangerous direction: paper WINS must not mask real losses.
const u = users.tenant('111111111111111111', { create: true });
u.set('live', 'on'); u.set('armed', 'on'); u.set('dailyStopLoss', '10');
u.noteRealised(+100, false);
u.noteRealised(-12, true);
eq(u.day().realised, 88, 'the pooled figure reads +$88');
eq(u.day().live, -12, 'while real money is -$12');
assert.match(String(u.liveBlock()), /daily stop hit/,
  'the stop still trips — a paper win cannot hide a real loss'); checks++;

// A record written before the split has no `live` field and must not go NaN.
const legacy = users.tenant('222222222222222222', { create: true });
legacy.set('live', 'on'); legacy.set('armed', 'on'); legacy.set('dailyStopLoss', '10');
legacy.rec.day = { date: users.today(), realised: -500, n: 9 };
eq(legacy.liveBlock(), null, 'a legacy ledger reads as 0 live, not as NaN or -500');
legacy.noteRealised(-11, true);
assert.match(String(legacy.liveBlock()), /daily stop hit/, 'and starts working from the next result'); checks++;

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`PASS paper-realism — ${checks} assertions (paper can miss; the stop counts real money only)`);
