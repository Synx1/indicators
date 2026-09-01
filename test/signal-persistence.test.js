/**
 * A one-minute impulse may make four lagging indicators agree. The entry is allowed only after the
 * model has pointed the same way for a full minute, and every live entry stores enough market
 * context to replay volume and drift later.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const trader = require('../src/trader');

let checks = 0;
const eq = (a, b, why) => { assert.deepStrictEqual(a, b, why); checks++; };
const ok = (v, why) => { assert.ok(v, why); checks++; };
const obs = (ticker = 'KXBTC-1', side = 'NO', confidence = 60) => ({ ticker, side, confidence });

// First sight starts the clock; 59.999s is still too young; the exact 60s boundary passes.
let tracker = trader.createSignalTracker();
let r = tracker.observe('BTC', obs(), 1000);
eq(r.ready, false, 'a first sighting cannot enter');
eq(r.ageMs, 0, 'its age starts at zero');
eq(tracker.observe('BTC', obs(), 60999).ready, false, 'one millisecond under the hold still waits');
r = tracker.observe('BTC', obs(), 61000);
eq(r.ready, true, 'the exact persistence boundary is allowed');
eq(r.ageMs, trader.SIGNAL_CONFIRM_MS, 'and reports the age that justified it');

// A side flip, a new ticker, weak confidence, or a missing read resets rather than inheriting age.
eq(tracker.observe('BTC', obs('KXBTC-1', 'YES'), 70000).ready, false, 'a side flip restarts the clock');
eq(tracker.observe('BTC', obs('KXBTC-2', 'YES'), 140000).ready, false, 'a new round cannot inherit the old round age');
eq(tracker.observe('BTC', obs('KXBTC-2', 'YES', 59), 210000).ready, false, 'a weak direction clears the watch');
eq(tracker.size, 0, 'the weak read really removed it');
tracker.observe('BTC', obs('KXBTC-2', 'YES', 80), 220000);
eq(tracker.observe('BTC', null, 250000).ready, false, 'a missing model observation clears the watch');
eq(tracker.size, 0, 'the missing read really removed it');
eq(tracker.observe('BTC', obs('KXBTC-2', 'YES', 80), 280000).ageMs, 0,
  'a direction after a blind spot starts from zero');

// The wiring helper converts a fully-qualified fresh decision into a visible skip, then releases it.
tracker = trader.createSignalTracker();
const decision = {
  direction: 'DOWN', confidence: 82, confirm: 4,
  market: { ticker: 'KXSOL-1' }, observation: obs('KXSOL-1', 'NO', 82)
};
r = trader.gateSignal({ sym: 'SOL' }, decision, 0, tracker);
eq(r.skip, 'signal-young', 'a fresh impulse is converted to a skip');
ok(/waiting for 60s persistence/.test(r.why), 'the dashboard says exactly what is waiting');
r = trader.gateSignal({ sym: 'SOL' }, decision, trader.SIGNAL_CONFIRM_MS, tracker);
ok(!r.skip, 'the same fully-qualified direction is released after one minute');
eq(r.signalAgeMs, trader.SIGNAL_CONFIRM_MS, 'the persisted age rides with the entry');

// A pre-existing skip stays a skip but still warms the direction tracker (e.g. price was too dear).
tracker = trader.createSignalTracker();
const dear = { ...decision, skip: 'too-dear', why: '70c is over 65c' };
eq(trader.gateSignal({ sym: 'SOL' }, dear, 0, tracker).skip, 'too-dear', 'persistence never overwrites a real gate');
r = trader.gateSignal({ sym: 'SOL' }, decision, trader.SIGNAL_CONFIRM_MS, tracker);
ok(!r.skip, 'a direction observed while price was dear may enter later when price is valid');

// Diagnostics use completed candles only, so a partial current minute cannot look falsely quiet.
const now = 1_800_000;
const candles = [{
  time: now / 1000, close: 999, high: 1000, low: 998, volume: 1000
}, ...Array.from({ length: 12 }, (_, i) => ({
  time: (now / 1000) - (i + 1) * 60,
  close: 100 - i, high: 101 - i, low: 99 - i,
  volume: i === 0 ? 20 : 10
}))];
const d = trader.marketDiagnostics(candles, 101, 100, now);
eq(d.gapBps, 100, 'gap is recorded in basis points');
eq(d.oneMinuteBps, 100, 'the partial 999 candle is excluded in favor of the completed 100 close');
ok(d.drift10Bps > 1000, 'ten-minute drift keeps its sign and magnitude');
ok(d.volumeRatio > 1.9 && d.volumeRatio < 2.1,
  'the partial 1000-volume candle is excluded from completed-minute normalization');
ok(Number.isFinite(d.realizedVolBps), 'realized volatility is persisted too');

// Mutation guard: the production pass must actually invoke the helper, not merely export it.
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'trader.js'), 'utf8');
ok(/gateSignal\(coin, await decideFor\(coin\)\)/.test(source), 'runOnce wires persistence after every market decision');

console.log(`PASS signal-persistence — ${checks} assertions`);
