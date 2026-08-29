/**
 * Reading back what actually filled.
 *
 * This is the highest-consequence parse in the bot and it was wrong: trader.js filtered fills by
 * `f.order_id` while kalshitrade.fills() normalises that field to `orderId`, so the filter matched
 * nothing, `contracts` came out 0, and every real fill was reported as "no fill — the book moved".
 * On 2026-08-28 that left four live positions (BTC 2, ETH 2, XRP 7, SOL 14, about $19) on the
 * exchange with NO record in the book: unmanaged, unexitable, invisible to the position cap, and
 * re-entered because the per-ticker guard could not see them.
 *
 * So the fixtures below are the REAL normalised shape, and the real raw shape beside it, because
 * "which field name" is exactly what went wrong.
 *
 * Run: node test/fill-reconcile.test.js
 */
const assert = require('assert');
const { reconcileFills } = require('../src/trader');

let checks = 0;
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what}: got ${a}, want ${b}`); checks++; };

const ORDER = '01a04afd-acf0-7c7b-89a7-56a0c7596a46';

// As kalshitrade.fills() returns it — camelCase, price already resolved to OUR side.
const normalised = [
  { fillId: 'a', orderId: ORDER, ticker: 'KXXRP15M-26AUG282100-00', side: 'NO',
    count: 4, priceCents: 83, feeDollars: 0.0396, at: '2026-08-29T00:48:54Z' },
  { fillId: 'b', orderId: ORDER, ticker: 'KXXRP15M-26AUG282100-00', side: 'NO',
    count: 3, priceCents: 85, feeDollars: 0.0296, at: '2026-08-29T00:48:54Z' },
  { fillId: 'c', orderId: 'someone-elses-order', ticker: 'KXXRP15M-26AUG282100-00', side: 'NO',
    count: 9, priceCents: 10, feeDollars: 1.0, at: '2026-08-29T00:40:00Z' }
];

const r = reconcileFills(normalised, ORDER);
eq(r.contracts, 7, 'both fills of OUR order counted, the third ignored');
eq(r.avgCents, 83.86, 'weighted average of 4@83 and 3@85, not a plain mean');
eq(r.feeDollars, 0.0692, "the exchange's own fee, summed");

// The raw Kalshi payload, verbatim from GET /portfolio/fills on 2026-08-29. If anything ever hands
// this straight through, it must still reconcile rather than silently reporting a miss.
const raw = [{
  action: 'sell', book_side: 'ask', count_fp: '7.00', created_time: '2026-08-29T00:48:54.24397Z',
  exchange_index: 2, fee_cost: '0.069200', fill_id: '0721610b', is_taker: true,
  market_ticker: 'KXXRP15M-26AUG282100-00', no_price_dollars: '0.8300', order_id: ORDER,
  outcome_side: 'no', side: 'no', subaccount_number: 0, ticker: 'KXXRP15M-26AUG282100-00',
  yes_price_dollars: '0.1700'
}];
const rr = reconcileFills(raw, ORDER, 'NO');
eq(rr.contracts, 7, 'the raw count_fp string is read as 7');
eq(rr.avgCents, 83, 'and priced on OUR leg (no_price_dollars), not the yes leg');
eq(rr.feeDollars, 0.0692, 'fee_cost read from the raw name too');

// ── the miss that is a genuine miss ──
eq(reconcileFills([], ORDER).contracts, 0, 'no fills at all is a real miss');
eq(reconcileFills(normalised, 'never-placed').contracts, 0, 'and so is nobody matching our order');
eq(reconcileFills(null, ORDER).contracts, 0, 'a failed fills read is a miss, not a crash');

// ── fractional artefacts must not reach the book ──
// A 16-contract fill once read back as 16.01 and the exit sold 16, stranding dust no order can clear.
eq(reconcileFills([{ orderId: ORDER, count: 16.01, priceCents: 70, feeDollars: 0 }], ORDER).contracts,
  16, 'a fixed-point artefact is rounded to whole contracts');

// ── a fill with no usable price still counts as a FILL ──
// Reporting a miss because the price field was unreadable is how a real position goes unrecorded.
const noPrice = reconcileFills([{ orderId: ORDER, count: 5, feeDollars: 0.05 }], ORDER);
eq(noPrice.contracts, 5, 'the contracts are real even when the price is not readable');
eq(noPrice.avgCents, null, 'and the price is reported as unknown rather than as zero');

console.log(`PASS fill-reconcile — ${checks} assertions (a fill is never read as a miss)`);
