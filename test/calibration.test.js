'use strict';

/** Regressions for the calibration gate. Pure function, no network, no bot state. */
const assert = require('assert');
const cal = require('../src/calibration');

let checks = 0;
const ok = (v, m) => { checks++; assert.ok(v, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const near = (a, b, tol = 1e-6, m = 'differ') => {
  checks++;
  assert.ok(Math.abs(a - b) <= tol, `${m}: got ${a}, expected ${b}`);
};

const at9 = extra => ({ minutesLeft: 9, ...extra });

// Live trading must stay fail-closed; paper is allowed so forward evidence can accumulate.
{
  eq(cal.CAL_LIVE_READY, false, 'the calibration gate is NOT cleared for real money');
  eq(cal.CAL_FORWARD_READY, true, 'paper entries are permitted');
  eq(cal.CAL_GRACE_CENTS, 1, 'the live shadow measured 1c as the best grace allowance');
  eq(cal.CAL_MAX_SPREAD_CENTS, 1.05);
  eq(cal.CAL_FITTED.markets, 25159);
  ok(Object.isFrozen(cal.CAL_BUCKETS), 'the bucket table cannot be mutated at runtime');
}

// Only the three supported bands are active, and >=95c / mid prices are refused.
{
  eq(cal.CAL_BUCKETS.map(b => b.label), ['75-90c', '90-95c', '10-25c-NO']);
  eq(cal.bucketFor(0.82).side, 'YES');
  eq(cal.bucketFor(0.92).side, 'YES');
  eq(cal.bucketFor(0.15).side, 'NO', 'a 15c YES mid means NO is the underpriced favourite');
  eq(cal.bucketFor(0.96), null, '>=95c failed its own t-test');
  eq(cal.bucketFor(0.50), null, 'mid prices are the costliest and are excluded');
  eq(cal.bucketFor(0.08), null, 'the 5-10c mirror is negative by construction');
  eq(cal.bucketFor(null), null);
}

// The clock band gates entry, defaulting to the measured 9-minute decision point.
{
  eq(cal.evaluate({ yesBid: 0.84, yesAsk: 0.85, minutesLeft: 12 }).skip, 'cal-too-early');
  eq(cal.evaluate({ yesBid: 0.84, yesAsk: 0.85, minutesLeft: 3 }).skip, 'cal-too-late');
  eq(cal.evaluate({ yesBid: 0.84, yesAsk: 0.85, minutesLeft: null }).skip, 'cal-no-clock');
  ok(!cal.evaluate(at9({ yesBid: 0.84, yesAsk: 0.85 })).skip, '9 minutes left is inside the band');
  eq(cal.CAL_DECIDE_TARGET, 9);
  ok(cal.CAL_DECIDE_MIN < 9 && cal.CAL_DECIDE_MAX > 9);
}

// Entry must fire AT the decision point, never on the early edge of a tolerance band.
{
  const q = { yesBid: 0.84, yesAsk: 0.85 };
  // Anything before the target is refused, so a poller cannot enter 30-45s early and trade a different
  // population than the corpus was sampled from.
  eq(cal.evaluate({ ...q, minutesLeft: 9.7 }).skip, 'cal-too-early',
    '9.7m is inside the old tolerance band but BEFORE the decision point');
  eq(cal.evaluate({ ...q, minutesLeft: 9.05 }).skip, 'cal-too-early');
  ok(!cal.evaluate({ ...q, minutesLeft: 9.0 }).skip, 'exactly 9m is the first tradable poll');
  ok(!cal.evaluate({ ...q, minutesLeft: 8.5 }).skip, 'slightly later still trades');
  eq(cal.evaluate({ ...q, minutesLeft: 8.0 }).skip, 'cal-too-late', 'past the floor is refused');
  // A caller passing a wider custom window cannot reintroduce the early bias.
  eq(cal.evaluate({ ...q, minutesLeft: 9.6, minLeft: 5, maxLeft: 14 }).skip, 'cal-too-early',
    'a custom window may narrow the entry but never push it earlier than the target');
}

// The session gate excludes exactly the two hours that survived split-half validation.
{
  eq([...cal.CAL_SKIP_ET_HOURS], [7, 8], 'only 7 and 8 ET — not the better-looking in-sample picks');
  ok(Object.isFrozen(cal.CAL_SKIP_ET_HOURS));

  // 11:15Z is 07:15 ET and 12:15Z is 08:15 ET during daylight saving.
  eq(cal.etHour('2026-09-04T11:15:00Z'), 7);
  eq(cal.etHour('2026-09-04T12:15:00Z'), 8);
  eq(cal.etHour('2026-09-04T13:15:00Z'), 9);
  eq(cal.etHour(null), null);
  eq(cal.etHour('not a date'), null);

  const q = { yesBid: 0.84, yesAsk: 0.85, minutesLeft: 9 };
  eq(cal.evaluate({ ...q, closeTime: '2026-09-04T11:15:00Z' }).skip, 'cal-skip-hour');
  eq(cal.evaluate({ ...q, closeTime: '2026-09-04T12:15:00Z' }).skip, 'cal-skip-hour');
  eq(cal.evaluate({ ...q, closeTime: '2026-09-04T12:15:00Z' }).etHour, 8,
    'the refusal reports which hour it was, so a reader is not left guessing');
  ok(!cal.evaluate({ ...q, closeTime: '2026-09-04T13:15:00Z' }).skip, '9 ET trades normally');
  ok(!cal.evaluate({ ...q, closeTime: '2026-09-04T06:15:00Z' }).skip, '2 ET trades normally');

  // A caller that supplies no close time must not be silently blocked — the gate goes inert instead.
  ok(!cal.evaluate(q).skip, 'the session gate is inert without a close time rather than failing shut');

  // The hour gate runs BEFORE the quote checks, so an excluded hour refuses even on a broken book.
  eq(cal.evaluate({ yesBid: null, yesAsk: null, minutesLeft: 9,
    closeTime: '2026-09-04T11:15:00Z' }).skip, 'cal-skip-hour',
    'an excluded hour is refused without needing a usable quote');

  // In January the same UTC hour is EST, one hour off — the zone must handle it, not a fixed offset.
  eq(cal.etHour('2027-01-15T12:15:00Z'), 7, 'EST: 12:15Z is 07:15 ET');
  eq(cal.etHour('2027-01-15T13:15:00Z'), 8, 'EST: 13:15Z is 08:15 ET');
}

// An absent quote must never become a free contract.
{
  eq(cal.evaluate(at9({ yesBid: null, yesAsk: 0.85 })).skip, 'cal-no-quote',
    'Number(null) is 0 and finite, so null must be rejected explicitly');
  eq(cal.evaluate(at9({ yesBid: '', yesAsk: 0.85 })).skip, 'cal-no-quote');
  eq(cal.evaluate(at9({ yesBid: 0.84, yesAsk: 1 })).skip, 'cal-no-quote', 'a 100c ask is not a quote');
  eq(cal.evaluate(at9({ yesBid: 0, yesAsk: 0.85 })).skip, 'cal-no-quote');
  eq(cal.evaluate(at9({ yesBid: 0.86, yesAsk: 0.85 })).skip, 'cal-crossed');
}

// A UP favourite inside the band and the spread gate produces a YES entry at ask plus grace.
{
  const d = cal.evaluate(at9({ yesBid: 0.84, yesAsk: 0.85 }));
  eq(d.side, 'YES');
  eq(d.bucket, '75-90c');
  eq(d.marginal, false);
  near(d.price, 0.85, 1e-9, 'the YES entry pays the YES ask');
  near(d.limit, 0.86, 1e-9, 'the limit is the ask plus the 1c grace');
  eq(d.spreadCents, 1);
  near(d.mid, 0.845);
  ok(d.winPct > 84 && d.winPct < 93, 'the win estimate is the side mid plus the bucket bias');
  ok(d.edgePt > 2 && d.tStat > 4, 'the surplus and t-statistic are carried for the panel');
}

// A DOWN favourite inverts the ladder and is flagged marginal.
{
  const d = cal.evaluate(at9({ yesBid: 0.14, yesAsk: 0.15 }));
  eq(d.side, 'NO');
  eq(d.bucket, '10-25c-NO');
  eq(d.marginal, true, 'the DOWN mirror is weaker and must be labelled');
  near(d.price, 0.86, 1e-9, 'the NO ask is 1 minus the YES bid');
  near(d.limit, 0.87, 1e-9);
  ok(d.tStat < 2, 'its surplus does not clear two standard errors');
  ok(d.winPct > 80, 'a NO favourite still estimates a high win rate');
}

// The spread gate refuses a wide book even when the price is in band.
{
  const wide = cal.evaluate(at9({ yesBid: 0.80, yesAsk: 0.85 }));
  eq(wide.skip, 'cal-wide-spread');
  eq(wide.spreadCents, 5);
  eq(wide.bucket, '75-90c', 'the refusal still reports which band it would have been');
  ok(!cal.evaluate(at9({ yesBid: 0.845, yesAsk: 0.85 })).skip, 'a 0.5c spread passes the gate');
}

// An off-band price refuses with the structured context a panel needs.
{
  const off = cal.evaluate(at9({ yesBid: 0.49, yesAsk: 0.50 }));
  eq(off.skip, 'cal-off-band');
  near(off.mid, 0.495);
  eq(off.spreadCents, 1);
  ok(/outside the supported bands/.test(off.why));
}

// The grace limit never exceeds 99c, so a 99c favourite cannot produce an impossible limit.
{
  near(cal.entryLimit(0.99), 0.99, 1e-9);
  near(cal.entryLimit(0.985), 0.99, 1e-9, 'the limit is capped rather than rounding past 1');
  near(cal.entryLimit(0.50, 2), 0.52, 1e-9);
  eq(cal.entryLimit(null), null);
}

// Fee and break-even match the production formula used everywhere else.
{
  near(cal.feePt(0.85), 0.07 * 0.85 * 0.15, 1e-12);
  near(cal.breakEven(0.85), 0.85 + cal.feePt(0.85), 1e-12);
  ok(cal.feePt(0.5) > cal.feePt(0.9), 'the fee is largest at mid prices');
}

console.log(`PASS calibration gate — ${checks} checks`);
