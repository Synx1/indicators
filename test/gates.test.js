/**
 * The gate-evaluation surface, which exists so two doubted assumptions stop being anecdotes.
 *
 * `confirm` assumes more indicator agreement is better; nothing measured supports it (corpus 4/4 67.6%
 * against 3/4's 70.0%, and a live 16-trade afternoon split 3/11 against 5/5). `rsi` is the one lever
 * that survived a chronological split. Both are published with their sample size and their margin over
 * the break-even the entry price already demands — because a 68% win rate at 64¢ is a losing strategy,
 * and that is the mistake this surface is built to make impossible to repeat.
 */
const assert = require('assert');
const Module = require('module');

let ACCOUNTS = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './users') return { all: () => ACCOUNTS, money: n => '$' + Number(n).toFixed(2) };
  if (request === './trader') throw new Error('trader not started in this test');
  return origLoad.apply(this, arguments);
};
const data = require('../src/sitedata');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };

const T0 = Date.UTC(2026, 8, 1, 20, 0, 0);
const pos = over => Object.assign({
  seq: 1, ticker: 'T', sym: 'BNB', side: 'NO', direction: 'DOWN', outcome: 'LOSS',
  live: true, contracts: 10, priceCents: 63, cost: 6.3, entryFee: 0.16, exitFee: 0,
  confirm: 4, rsi: 50, at: new Date(T0).toISOString(), exitAt: new Date(T0).toISOString()
}, over);
const withBook = positions => {
  ACCOUNTS = [{ userId: 'u1', rec: { tag: 'tester', book: { positions } },
    get: k => ({ live: true, liveBankroll: 100, paperBankroll: 100 }[k]) }];
};

// ── the screenshot, reproduced: 8 wins at +$4.21, 8 losses at -$7.37, all but one DOWN ──
withBook([
  ...Array.from({ length: 8 }, (_, i) => pos({ seq: i + 1, outcome: 'CASHOUT', pnl: 4.21, confirm: i < 5 ? 3 : 4, rsi: 45 })),
  ...Array.from({ length: 8 }, (_, i) => pos({ seq: i + 9, outcome: 'LOSS', pnl: -7.37, confirm: 4, rsi: i < 4 ? 28 : 45 }))
]);
const g = data.gates();

eq(g.settled, 16, 'every settled position is counted');
eq(g.withRsi, 16, 'RSI has to be present or the guard is unmeasurable');
eq(g.overall.taken, 16);
eq(g.overall.wins, 8);
eq(g.overall.rate, 0.5);

// The whole point of the surface: a 50% rate at 63c is a LOSS, and margin has to say so.
ok(g.overall.needRate > 0.63, `63c must demand more than 63%, got ${g.overall.needRate}`);
ok(g.overall.margin < 0, 'a 50% rate at 63c must report a negative margin');
eq(g.overall.net, -25.28, 'net must be the sum of realised P&L, not a rate');

// ── confirm split: 3/4 all won, 4/4 mostly lost ──
const c3 = g.byConfirm.find(b => b.label.startsWith('3'));
const c4 = g.byConfirm.find(b => b.label.startsWith('4'));
eq(c3.taken, 5); eq(c3.wins, 5); eq(c3.rate, 1);
eq(c4.taken, 11); eq(c4.wins, 3);
ok(c4.margin < 0, 'the 4/4 bucket must show a negative margin here');
ok(c3.margin > 0, 'the 3/4 bucket must show a positive margin here');

// ── RSI split: the stretched bucket is the one the guard would refuse ──
const stretched = g.byRsi.find(b => b.label.includes('stretched (the guard'));
const normal = g.byRsi.find(b => b.label === 'RSI not stretched');
eq(stretched.taken, 4, 'DOWN entries with RSI under 35 are the stretched bucket');
eq(stretched.wins, 0);
eq(normal.taken, 12);
ok(stretched.net < 0, 'a bucket the guard would refuse should show its cost');

// An UP entry is stretched when RSI is HIGH, not low — the threshold has to flip with direction.
withBook([pos({ direction: 'UP', side: 'YES', rsi: 72, outcome: 'LOSS', pnl: -6 }),
          pos({ seq: 2, direction: 'UP', side: 'YES', rsi: 40, outcome: 'CASHOUT', pnl: 4 })]);
const g2 = data.gates();
eq(g2.byRsi.find(b => b.label.includes('stretched (the guard')).taken, 1,
  'RSI 72 on an UP entry is stretched; RSI 40 on an UP entry is not');

// ── a book with no RSI must not fabricate buckets ──
withBook([pos({ rsi: null, outcome: 'LOSS', pnl: -6 }), pos({ seq: 2, rsi: undefined, outcome: 'CASHOUT', pnl: 4 })]);
const g3 = data.gates();
eq(g3.settled, 2);
eq(g3.withRsi, 0, 'positions predating the rsi field must be reported as missing, not as RSI 0');
eq(g3.byRsi[0].taken, 0);
eq(g3.byRsi[1].taken, 0);
ok(g3.byRsi[0].rate === null, 'an empty bucket reports null, never 0%');

// ── open positions are money that has not resolved and must never score a gate ──
withBook([pos({ outcome: 'OPEN', pnl: null }), pos({ seq: 2, outcome: 'LOSS', pnl: -7.37 })]);
eq(data.gates().settled, 1, 'an open position must not be counted as settled');

ok(/taken/.test(data.gates().caution) && /margin/.test(data.gates().caution),
  'the payload must carry the sample-size caution, not just the numbers');

console.log(`PASS gates — ${checks} checks (margin over break-even, not raw win rate)`);
