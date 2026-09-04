#!/usr/bin/env node
'use strict';
/**
 * Regressions for the calibration forward audit.
 *
 * A compliance checker that cannot fail is worse than none: it prints reassurance over a broken gate.
 * So each check is proven to FIRE on a violating trade and to stay quiet on a clean one, and the
 * window key is proven to collapse trades that settle together into one observation.
 *
 * Network-free and clock-free — every trade here is a literal.
 */

const assert = require('assert');
const audit = require('../research/calibration-forward-audit');
const calibration = require('../src/calibration');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const kinds = p => audit.violations(p).map(v => v.kind).sort();

// A trade that satisfies every gate. 13:00 ET close is outside the excluded [7, 8] hours.
const CLEAN = {
  seq: 1, sym: 'ETH', direction: 'UP', price: 0.79, priceCents: 79, cost: 19.75, pnl: 5.25,
  strategy: 'CALIBRATION', calBucket: '75-90c', calSpreadCents: 1.0, calGraceCents: 1,
  minutesLeft: 9.0, slippageCents: 0,
  closeTime: '2026-09-04T17:00:00Z', closeMs: Date.parse('2026-09-04T17:00:00Z')
};

// 1. a clean trade produces no violations
eq(kinds(CLEAN), [], 'a fully compliant trade reports nothing');

// 2. every individual gate fires
eq(kinds({ ...CLEAN, calSpreadCents: 2.5 }), ['spread'], 'a 2.5c spread is caught');
eq(kinds({ ...CLEAN, calBucket: '40-60c' }), ['bucket'], 'an inactive bucket is caught');
eq(kinds({ ...CLEAN, minutesLeft: 12.5 }), ['timing'], 'an early entry is caught');
eq(kinds({ ...CLEAN, minutesLeft: 3 }), ['timing'], 'a late entry is caught');
eq(kinds({ ...CLEAN, calSpreadCents: null }), ['spread-missing'], 'a bucket without a spread is caught');
eq(kinds({ ...CLEAN, slippageCents: 3 }), ['grace'], 'slippage past the grace allowance is caught');

// 3. the session gate fires on an excluded ET hour and only then.
// 12:00Z is 08:00 ET, which is excluded; 17:00Z is 13:00 ET, which is not.
const at = iso => ({ ...CLEAN, closeTime: iso, closeMs: Date.parse(iso) });
eq(kinds(at('2026-09-04T12:00:00Z')), ['session'], 'an 08:00 ET close is caught');
eq(kinds(at('2026-09-04T11:00:00Z')), ['session'], 'a 07:00 ET close is caught');
eq(kinds(at('2026-09-04T13:00:00Z')), [], 'a 09:00 ET close is allowed');
eq(audit.etHour(Date.parse('2026-09-04T12:00:00Z')), 8, 'ET hour resolves through the IANA zone');

// 4. the DISABLED bucket must be caught as inactive, not waved through.
// It exists in CAL_BUCKETS for provenance and would otherwise look like a legitimate label.
const down = calibration.CAL_BUCKETS.find(b => b.enabled === false);
ok(down, 'a disabled bucket is present in the config for provenance');
eq(kinds({ ...CLEAN, calBucket: down.label }), ['bucket'],
  `the disabled ${down.label} bucket is caught if it ever trades`);

// 5. several violations at once are all reported, not just the first
eq(kinds({ ...CLEAN, calSpreadCents: 4, minutesLeft: 13, calBucket: '10-25c' }),
  ['bucket', 'spread', 'timing'], 'independent violations are reported together');

// 6. a pre-fix trade is UNAUDITABLE, never silently compliant.
// This is the distinction that stops the audit printing a clean bill of health over trades it
// could not inspect at all.
const pre = { ...CLEAN, calBucket: undefined, calSpreadCents: undefined, calGraceCents: undefined };
eq(kinds(pre), ['unauditable'], 'a trade with no bucket is unauditable rather than clean');
ok(audit.violations(pre)[0].detail.includes('pre-fix'), 'and says why');

// 7. the window key collapses trades that settle together.
// This is the whole basis of the honest unit: 7 coins in one round is ONE observation, and a key
// built off entry time or coin would report it as seven.
const w = '2026-09-04T17:00:00Z';
const a = { ...CLEAN, sym: 'BTC', closeMs: Date.parse(w), closeTime: w };
const b = { ...CLEAN, sym: 'SOL', closeMs: Date.parse(w) + 400, closeTime: w };  // 400ms apart
const c = { ...CLEAN, sym: 'XRP', closeMs: Date.parse('2026-09-04T17:15:00Z') };
eq(audit.windowKey(a), audit.windowKey(b), 'two coins settling in the same round share one window');
ok(audit.windowKey(a) !== audit.windowKey(c), 'a different round is a different window');

// 8. summarize computes ROI on stake and the forward bias
const s = audit.summarize([
  { ...CLEAN, price: 0.80, cost: 20, pnl: 5 },
  { ...CLEAN, price: 0.80, cost: 20, pnl: -20.2 }
]);
eq(s.n, 2); eq(s.wins, 1);
ok(Math.abs(s.winPct - 50) < 1e-9, 'win% is computed');
ok(Math.abs(s.staked - 40) < 1e-9, 'stake is the cost actually risked');
ok(Math.abs(s.roiPct - (-15.2 / 40) * 100) < 1e-9, 'ROI is net over stake');
// 50% realized against an 80c entry implying 80% is -30pp of forward bias.
ok(Math.abs(s.realizedMinusImpliedPp - (-30)) < 1e-9, 'forward bias is realized minus implied');

// 9. roiOf refuses to divide by a zero stake rather than returning Infinity
eq(audit.roiOf({ cost: 0, pnl: 5 }), null, 'a zero-cost position yields no ROI');

// 10. the day-clustered CI returns a FINITE interval across two settlement days.
//
// This is the assertion that catches the shape bug. dayClusteredMeanCI reads `.day` and
// `.pnlPerContract` off a FLAT list and returns {low, high}; handing it an array of per-day arrays
// silently produces NaN instead of throwing, and NaN fails a `> 0` guard, so the failure disguises
// itself as a safely-negative verdict. Asserting only "does not throw" would pass on the bug.
const twoDays = [
  { cost: 20, pnl: 4, closeTime: '2026-09-04T17:00:00Z', closeMs: Date.parse('2026-09-04T17:00:00Z') },
  { cost: 20, pnl: 5, closeTime: '2026-09-04T18:00:00Z', closeMs: Date.parse('2026-09-04T18:00:00Z') },
  { cost: 20, pnl: 3, closeTime: '2026-09-05T17:00:00Z', closeMs: Date.parse('2026-09-05T17:00:00Z') },
  { cost: 20, pnl: 6, closeTime: '2026-09-05T18:00:00Z', closeMs: Date.parse('2026-09-05T18:00:00Z') }
];
const ci = audit.roiCI(twoDays);
eq(ci.days, 2, 'two distinct ET settlement days are counted');
ok(Number.isFinite(ci.low) && Number.isFinite(ci.high),
  `the interval is finite, not NaN (got [${ci.low}, ${ci.high}])`);
ok(ci.low <= ci.high, 'the interval is ordered');
// Every trade here is profitable, so a bootstrap over these days cannot straddle zero.
ok(ci.low > 0, `an all-profitable sample yields a positive lower bound (got ${ci.low})`);
// Mean ROI is (0.20+0.25+0.15+0.30)/4 = 0.225, and the bootstrap mean must bracket it.
ok(ci.low <= 0.225 && 0.225 <= ci.high, 'the interval brackets the sample mean ROI');

// A single day gives no interval rather than a fake one.
const oneDay = audit.roiCI(twoDays.slice(0, 2));
eq(oneDay.days, 1, 'one day is reported as one day');
eq(oneDay.low, null, 'a single day yields no lower bound');

// An all-losing sample must produce a NEGATIVE upper bound -- the direction matters, because this is
// the number that would justify calling a config failed.
const losing = twoDays.map((p, i) => ({ ...p, pnl: -20 - i * 0.1 }));
const lci = audit.roiCI(losing);
ok(lci.high < 0, `an all-losing sample yields a negative upper bound (got ${lci.high})`);

// 11. the checker reads its thresholds from the gate, so tightening the gate tightens the audit
ok(audit.violations({ ...CLEAN, calSpreadCents: calibration.CAL_MAX_SPREAD_CENTS }).length === 0,
  'a spread exactly at the gate is allowed');
ok(audit.violations({ ...CLEAN, calSpreadCents: calibration.CAL_MAX_SPREAD_CENTS + 0.01 })
  .some(v => v.kind === 'spread'), 'a spread one hundredth past the gate is refused');

console.log(`PASS calibration forward audit — ${checks} checks`);
