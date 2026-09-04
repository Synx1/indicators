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

// 10. the checker reads its thresholds from the gate, so tightening the gate tightens the audit
ok(audit.violations({ ...CLEAN, calSpreadCents: calibration.CAL_MAX_SPREAD_CENTS }).length === 0,
  'a spread exactly at the gate is allowed');
ok(audit.violations({ ...CLEAN, calSpreadCents: calibration.CAL_MAX_SPREAD_CENTS + 0.01 })
  .some(v => v.kind === 'spread'), 'a spread one hundredth past the gate is refused');

console.log(`PASS calibration forward audit — ${checks} checks`);
