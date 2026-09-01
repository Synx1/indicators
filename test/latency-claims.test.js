/**
 * claimBlock: the in-pass correlation guard that keeps the place/settle split safe.
 *
 * A position is no longer in the book by the time the next coin is placed in the same pass, so the
 * book-reading accountBlock() cannot see it yet. claimBlock() is what stands in for the book during
 * a pass. The property that matters: it must refuse the two things that turn one pass into a
 * correlated double — the same round twice, and the same direction in the same settlement window —
 * while still allowing a genuine hedge (opposite side, same window) and unrelated windows.
 */

const assert = require('assert');
const trader = require('../src/trader');

const { claimBlock } = trader;
assert.strictEqual(typeof claimBlock, 'function', 'claimBlock must be exported');

// A decision, shaped the way trader builds it: claimBlock reads market.ticker, side, market.close_time.
function dec({ ticker, side, close, dir }) {
  return { market: { ticker, close_time: close }, side, direction: dir || (side === 'YES' ? 'UP' : 'DOWN') };
}
// A claims map already carrying one committed order for account "u1".
function claimsWith(claim) {
  const m = new Map();
  if (claim) m.set('u1', [{ ticker: claim.ticker, side: claim.side, closeTime: claim.close }]);
  return m;
}

const CT_A = '2026-08-31T20:00:00Z';
const CT_B = '2026-08-31T20:15:00Z';

// 1. Nothing claimed yet → clear.
assert.strictEqual(claimBlock(new Map(), 'u1', dec({ ticker: 'T1', side: 'YES', close: CT_A })), null);

// 2. Same ticker already claimed → blocked, whatever the side.
{
  const c = claimsWith({ ticker: 'T1', side: 'YES', close: CT_A });
  assert.ok(claimBlock(c, 'u1', dec({ ticker: 'T1', side: 'NO', close: CT_A })),
    'the same round twice must be blocked');
}

// 3. Different ticker, same side, same settlement window → blocked (the slow correlated double).
{
  const c = claimsWith({ ticker: 'T1', side: 'YES', close: CT_A });
  assert.ok(claimBlock(c, 'u1', dec({ ticker: 'T2', side: 'YES', close: CT_A })),
    'same direction + same window must be blocked even on a different ticker');
}

// 4. Opposite side, same window → allowed (a hedge is not a double).
{
  const c = claimsWith({ ticker: 'T1', side: 'YES', close: CT_A });
  assert.strictEqual(claimBlock(c, 'u1', dec({ ticker: 'T2', side: 'NO', close: CT_A })), null,
    'opposite side in the same window is a hedge, not a correlated bet');
}

// 5. Same side, different window → allowed (accumulation across windows is maxOpen's job, not this).
{
  const c = claimsWith({ ticker: 'T1', side: 'YES', close: CT_A });
  assert.strictEqual(claimBlock(c, 'u1', dec({ ticker: 'T2', side: 'YES', close: CT_B })), null,
    'same direction in a different settlement window is not blocked here');
}

// 6. A claim belongs to one account only — another account is unaffected.
{
  const c = claimsWith({ ticker: 'T1', side: 'YES', close: CT_A });
  assert.strictEqual(claimBlock(c, 'u2', dec({ ticker: 'T1', side: 'YES', close: CT_A })), null,
    "one account's claim must not block another account");
}

console.log('latency-claims: all assertions passed');
