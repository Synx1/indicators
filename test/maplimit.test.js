/**
 * The bounded fan-out the scan pass uses to place orders for many accounts.
 *
 * Asserted because both failure modes are invisible in production: unbounded would work fine at
 * two accounts and hammer Kalshi at twenty, and serial would work fine at two accounts and let a
 * pass outlive the freshness of the spot price it was computed from — which is not a slow bot, it
 * is the stale-spot bug that cost 85% of a bankroll. Neither shows up as an error.
 *
 * Run: node test/maplimit.test.js
 */
const assert = require('assert');
const { mapLimit } = require('../src/trader');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

const tick = () => new Promise(r => setImmediate(r));

(async () => {
  assert.strictEqual(typeof mapLimit, 'function', 'trader must export mapLimit');

  // ── the bound is real, and it is not 1 ──
  let inFlight = 0, maxInFlight = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = await mapLimit(items, 4, async n => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    // Several turns, so an implementation that only appears concurrent is caught.
    await tick(); await tick(); await tick();
    inFlight--;
    return n * 2;
  });
  eq(maxInFlight, 4, 'exactly four ran at once — not one (serial), not ten (unbounded)');
  eq(out.length, 10, 'every item produced a result');
  eq(out.map(r => r.value).join(','), '2,4,6,8,10,12,14,16,18,20',
    'results come back in INPUT order, not completion order');
  eq(out.every(r => r.ok), true, 'and all are marked ok');

  // ── one failure must not cost the others their entry ──
  const mixed = await mapLimit([1, 2, 3], 2, async n => {
    await tick();
    if (n === 2) throw new Error('account 2 exploded');
    return n;
  });
  eq(mixed[0].ok, true, 'the account before the failure still went through');
  eq(mixed[1].ok, false, 'the failing account is marked, not thrown');
  eq(mixed[1].error.message, 'account 2 exploded', 'and keeps its reason for the log');
  eq(mixed[2].ok, true, 'the account after the failure still went through');

  // ── degenerate inputs ──
  eq((await mapLimit([], 4, async () => 1)).length, 0, 'no accounts is not an error');
  const one = await mapLimit([7], 4, async n => n);
  eq(one.length, 1, 'one account with room for four does not hang');
  eq(one[0].value, 7, 'and returns its value');

  // Completion order deliberately differs from input order here: the slowest item is first.
  const delays = [30, 1, 1];
  const ordered = await mapLimit(delays, 3, async ms => {
    await new Promise(r => setTimeout(r, ms));
    return ms;
  });
  eq(ordered.map(r => r.value).join(','), '30,1,1',
    'input order survives even when the first item finishes last');

  console.log(`PASS maplimit — ${checks} assertions (bounded, ordered, failure-isolated)`);
})().catch(e => { console.error(e); process.exit(1); });
