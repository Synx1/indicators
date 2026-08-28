/**
 * Whether a blocked entry may be recorded as paper.
 *
 * The bot's own rule until now was "if live is wanted but something blocks it, write a paper fill
 * so the decision is not lost". That is right up to the moment somebody is armed: they are
 * watching real money, and a paper position appearing in that state reads as the bot ignoring the
 * arm. It was reported in exactly those words — "arming it (live trade) but it gives papers".
 *
 * So the gate is asserted directly rather than left implicit in a branch, because the two states
 * that must still fill paper (live off, and live on but not armed) are the whole point of having
 * a paper mode at all, and breaking them would be silent.
 *
 * Run: node test/paper-gate.test.js
 */
const assert = require('assert');
const trader = require('../src/trader');

let checks = 0;
const t = (live, armed) => ({ get: k => ({ live, armed })[k] });
const yes = (live, armed, why) => {
  assert.strictEqual(trader.paperAllowed(t(live, armed)), true, why); checks++;
};
const no = (live, armed, why) => {
  assert.strictEqual(trader.paperAllowed(t(live, armed)), false, why); checks++;
};

assert.strictEqual(typeof trader.paperAllowed, 'function', 'trader must export paperAllowed(t)');

// Paper mode, which is the default and must keep working.
yes(false, false, 'live off: paper is the whole point');
yes(false, true, 'live off with a stale armed flag: still paper, because live is the master switch');

// Live intent without a watcher. The panel promises this in words: "signals will keep filling as
// paper until you press Arm" — so it must keep doing exactly that.
yes(true, false, 'live on but not armed: paper, as the panel says');

// Armed. The only state where a blocked entry is skipped instead of papered.
no(true, true, 'live and armed: no paper fills at all');

console.log(`PASS paper-gate — ${checks} assertions (paper stops only when armed)`);
