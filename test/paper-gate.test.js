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

/**
 * ── the state must not call itself Live ──
 *
 * paperAllowed(true, false) is true, which is correct: selecting real money without arming still fills as
 * paper. The panel used to title that state "Live, not trading", leading with the word Live, so it read as
 * confirmation that real trading had started — and then paper fills arrived. Reported in exactly those
 * words: "when I click LIVE and I don't arm it it's also PAPER, very confusing".
 *
 * The behaviour was right and the label was lying about it. This pins the label: whenever the next signal
 * will fill as paper, the state's title must SAY paper, whatever the user selected.
 */
const panel = require('../src/panel');
if (typeof panel.statusLine === 'function') {
  const fake = (live, armed) => ({
    get: k => ({ live, armed, dailyStopLoss: null })[k],
    hasAccess: () => true,
    liveBlock: () => (!live ? 'live mode is off' : !armed ? 'not armed' : null),
    rec: { blocked: false, accessUntil: new Date(Date.now() + 8.64e7).toISOString(),
           settings: { live, armed, dailyStopLoss: null }, day: {} },
    day: () => ({ live: 0 })
  });
  const mid = panel.statusLine(fake(true, false));
  assert.ok(/^Paper/i.test(mid.title),
    'real money selected but not armed must be titled Paper, not Live — got: ' + mid.title);
  assert.ok(/not armed/i.test(mid.text) && /paper/i.test(mid.text),
    'and the body must say both that it is not armed and that fills are paper');
  const real = panel.statusLine(fake(true, true));
  assert.ok(/live/i.test(real.title), 'armed and live is the only state allowed to call itself live');
  checks += 3;
  console.log(`PASS paper-gate labels — 3 more assertions (${checks} total)`);
} else {
  console.log('note: panel.statusLine is not exported, label assertions skipped');
}
