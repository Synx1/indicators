/**
 * The setup sheet: every recommended setting, and the arithmetic that produces it.
 *
 * ── why this file exists ──
 *
 * src/recommend.js is the one module whose whole output is ADVICE about money. A wrong threshold here
 * does not crash anything and does not show up in a log — it quietly tells somebody to bet four times
 * too much, in a confident table, with a paragraph of justification beside it. So the numbers are
 * pinned at their boundaries, and the two that matter most are pinned hardest:
 *
 *   - the SIZING rows, because the whole reason the sheet exists is that `shares: 30` (the schema
 *     default) costs ~$18 a position and a $30 bankroll cannot re-bet after one loss;
 *   - `riskPerTrade`, because it must be quarter-Kelly at the PESSIMISTIC win rate. Computing it at
 *     the backtest's 83.9% instead would recommend 15% where 9% is right — a 66% over-bet, from a
 *     one-character change.
 *
 * Also asserted: the module stays PURE. It must not require ./trader, because trader pulls axios and
 * the whole Kalshi client at require time, and this file is loaded by the site.
 *
 * Run: node test/recommend.test.js
 */
const assert = require('assert');
const recommend = require('../src/recommend');

let checks = 0;
const eq = (a, b, m) => { checks++; assert.deepStrictEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };
const near = (a, b, m, e = 1e-9) => { checks++; assert.ok(Math.abs(a - b) < e, `${m} (got ${a}, want ${b})`); };

/** The schema defaults, which is the state an account is actually in before anybody touches it. */
const DEFAULTS = {
  who: 'tester', bankroll: 30, live: true, shares: 30, autoShares: false,
  riskPerTrade: 0.25, dailyStopLoss: null, maxOpen: 3, maxPerDir: null,
  maxOrderCost: null, slippageCents: 2, fillGrace: 3, cashoutAt: null, downWarn: false
};
const rowsFor = over => recommend.review({ ...DEFAULTS, ...over });
const row = (over, key) => rowsFor(over).find(r => r.key === key);

// ── 1. the module is pure ────────────────────────────────────────
//
// A require of ./trader would pull axios and the Kalshi client into the web server's load path, and
// would break every harness that stubs the trader out (privacy.test.js, dashboard.test.js do exactly
// that). Asserted on the SOURCE because a passing require proves only that it happened to work here.
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../src/recommend'), 'utf8');
ok(!/require\(/.test(src), 'recommend.js requires NOTHING — it is pure arithmetic over a snapshot');
ok(/BAND_HI = 0\.65/.test(src), 'it carries the entry ceiling as a literal, kept in step with trader.js');

// ── 2. Kelly, at both estimates and at the edges ─────────────────
//
// On a binary bought at `price`, odds received are b = (1-price)/price and Kelly is (p·b − q)/b.
// Hand-checked: at p=0.839, price=0.588 -> b=0.7007, f=(0.5878-0.161)/0.7007 = 0.6091.
near(recommend.kellyFraction(0.839, 0.588), 0.6091, 'Kelly at the backtest win rate is ~61%', 1e-3);
near(recommend.kellyFraction(0.73, 0.588), 0.3443, 'Kelly at the LIVE win rate is only ~34%', 1e-3);
// At exactly breakeven the bet has no edge, so the optimal stake is zero — not a tiny positive number.
near(recommend.kellyFraction(0.588, 0.588), 0, 'Kelly at breakeven is exactly zero', 1e-9);
eq(recommend.kellyFraction(0.4, 0.588), 0, 'a losing bet returns 0, not a negative stake');
eq(recommend.kellyFraction(0.3, 0.588), 0, 'and a badly losing one is still 0 — this bot cannot take the other side');
// Garbage must not produce a stake. `NaN > 0` is false, so an unguarded version would return NaN and
// the page would render "NaN%" as a recommendation.
for (const junk of [NaN, undefined, null, Infinity, '0.8', {}]) {
  eq(recommend.kellyFraction(junk, 0.588), 0, `a ${JSON.stringify(junk)} win rate yields no stake`);
}
for (const bad of [0, 1, -0.5, 1.5, NaN, null]) {
  eq(recommend.kellyFraction(0.8, bad), 0, `a ${JSON.stringify(bad)} price yields no stake`);
}

// ── 3. riskPerTrade is quarter-Kelly at the PESSIMISTIC rate ─────
//
// This is the assertion that stops the sheet over-betting. Quarter-Kelly at 0.73 is 0.086 -> 9%.
// Computed at the backtest's 0.839 it would be 0.152 -> 15%, which on this bankroll is a 66% larger
// position on the strength of the estimate that is NOT out-of-sample.
let r = row({}, 'riskPerTrade');
eq(r.recommended, '9%', 'the recommendation is quarter-Kelly at the LIVE win rate, not the backtest');
ok(/0\.34|34%/.test(r.why), 'and the reasoning shows both Kelly figures so the choice is auditable');
eq(r.ok, false, 'the 25% DEFAULT does not pass');
eq(r.severity, 'warn', '25% is above 1.5x the recommendation, so it warns');
// Above FULL Kelly at the live rate is a different category: not "aggressive", arithmetically losing.
eq(row({ riskPerTrade: 0.40 }, 'riskPerTrade').severity, 'high',
  '40% is above full Kelly (34%) at the live rate, which is high severity');
eq(row({ riskPerTrade: 0.35 }, 'riskPerTrade').severity, 'high', '35% is still above it');
eq(row({ riskPerTrade: 0.34 }, 'riskPerTrade').severity, 'warn', '34% is at it, not above it');
eq(row({ riskPerTrade: 0.13 }, 'riskPerTrade').ok, true, '13% is inside the 1.5x tolerance and passes');
eq(row({ riskPerTrade: 0.14 }, 'riskPerTrade').ok, false, '14% is outside it');
eq(row({ riskPerTrade: 0.09 }, 'riskPerTrade').ok, true, 'the recommended value itself passes');

// ── 4. the sizing rows: the reason this file exists ──────────────
//
// 30 contracts at a 59¢ typical fill costs ~$18.15. On $30 that is affordable ONCE, and $11.85 cannot
// buy another — the account does not blow up, it stalls, which is harder to notice.
r = row({}, 'autoShares');
eq(r.severity, 'high', 'auto size off on a small bankroll is HIGH severity, not a suggestion');
eq(r.ok, false, 'and it does not pass');
ok(/cannot afford the NEXT position/.test(r.why),
  `the arithmetic names the actual failure — stalling, not busting (${r.why})`);
ok(/\$18\.1/.test(r.why), 'and quotes the real position cost');
// On a bankroll that CAN re-bet, the same row must stop crying wolf.
ok(!/cannot afford the NEXT/.test(row({ bankroll: 500 }, 'autoShares').why),
  'on $500 the stall warning is absent — the rule is arithmetic, not a slogan');
eq(row({ autoShares: true }, 'autoShares').ok, true, 'with auto size on, the row passes');
eq(row({ autoShares: true }, 'autoShares').severity, 'note', 'and drops to note');
// The fixed-shares row only exists while auto size is OFF: advice about a setting that is not in use
// is noise, and this sheet's value is that every row on it is live.
eq(rowsFor({ autoShares: true }).some(x => x.key === 'shares'), false,
  'the Shares row is omitted entirely when auto size is on');
eq(rowsFor({ autoShares: false }).some(x => x.key === 'shares'), true, 'and present when it is off');
// The cap is measured at the CEILING (65¢), not the typical fill: $30 x 25% / 0.65 = 11 contracts.
eq(row({}, 'shares').recommended, '11 or fewer', 'the fixed-share cap is computed at the 65c ceiling');
eq(row({ shares: 11 }, 'shares').ok, true, '11 contracts passes');
eq(row({ shares: 12 }, 'shares').ok, false, '12 does not');
eq(row({ shares: 12 }, 'shares').severity, 'high', 'and over the cap is high severity');
eq(row({ shares: 0 }, 'shares').ok, false, 'zero shares is not a valid setting either');

// ── 4b. Kelly sizing, the transferable half of the $100->$457 challenge ──
//
// Recommended ON, because the reconstruction with a real fee model beat flat sizing on the same trades.
// The row must also stop contradicting itself: riskPerTrade is not read while Kelly is on, and a sheet
// that recommends both a Kelly fraction AND a flat risk share is telling the reader two things.
r = row({}, 'kellySizing');
eq(r.recommended, 'on', 'Kelly sizing is recommended on');
eq(r.ok, false, 'and the default (off) does not pass');
eq(r.severity, 'warn', 'as a warning rather than a must-fix — flat sizing is wrong, not dangerous');
ok(/3\.1x/.test(r.why), 'the reasoning quotes the backtested multiple');
ok(/slippage/.test(r.why), 'and the slippage-charged version, not just the clean one');
ok(/conservative/.test(r.why), 'and states that it sizes SMALLER per trade, which is counter-intuitive');
eq(row({ kellySizing: true }, 'kellySizing').ok, true, 'turning it on satisfies the row');
eq(row({ kellySizing: true }, 'kellySizing').severity, 'note', 'quietly');
// It is a mode of auto size, so the note must say so while auto size is off.
ok(/Needs Auto size/.test(row({ autoShares: false }, 'kellySizing').note),
  'with auto size off the row says Kelly needs it');
eq(row({ autoShares: true }, 'kellySizing').note, null, 'and with auto size on there is no such caveat');
// The riskPerTrade row must defer to Kelly rather than argue with it.
ok(/Not read while Kelly sizing is on/.test(row({ kellySizing: true }, 'riskPerTrade').note),
  'riskPerTrade says it is not read while Kelly is on, so the sheet does not contradict itself');
ok(!/Not read while Kelly/.test(String(row({ kellySizing: false }, 'riskPerTrade').note)),
  'and says nothing of the kind when Kelly is off');

// ── 5. the daily stop, which is the only setting that ends a bad night ──
//
// Sized to absorb STOP_LOSSES typical losses, then floored and capped as a share of the bankroll. At
// $30 with auto size off the typical loss is the $18.15 fixed position, so 2x that is $36.30 — above
// the 50% cap, which clamps it to $15. The cap is the load-bearing half: a stop larger than half the
// account cannot trip before the account is gone anyway, which is a stop that protects nothing.
r = row({}, 'dailyStopLoss');
eq(r.current, 'off', 'blank is reported as off, not as zero');
eq(r.severity, 'high', 'no daily stop at all is HIGH — a bad night otherwise runs until the balance does');
eq(r.ok, false, 'and it does not pass');
eq(r.recommended, '$15.00', 'the recommendation is clamped by the 50% cap at this bankroll');
// With auto size on, the typical loss is much smaller, so the FLOOR binds instead of the cap.
r = row({ autoShares: true, riskPerTrade: 0.09 }, 'dailyStopLoss');
eq(r.recommended, '$8.00', 'at 4 contracts the 25% floor sets the stop, not 2x the loss');
ok(/absorbs about 2 of them/.test(r.why), 'and the reasoning states how many losses it absorbs');
// A stop above half the bankroll is worse than a smaller one, and must say so.
eq(row({ dailyStopLoss: 25 }, 'dailyStopLoss').ok, false, '$25 on a $30 account is over the 50% cap');
eq(row({ dailyStopLoss: 25 }, 'dailyStopLoss').severity, 'warn', 'and warns');
eq(row({ dailyStopLoss: 15 }, 'dailyStopLoss').ok, true, 'exactly half passes — the cap is inclusive');
eq(row({ dailyStopLoss: 10 }, 'dailyStopLoss').ok, true, 'and below it passes');
eq(row({ dailyStopLoss: 10 }, 'dailyStopLoss').severity, 'note', 'with no warning');

// ── 6. concurrency is only real if the bankroll funds it ─────────
//
// maxOpen 3 with positions the balance cannot pay for is not a risk limit, it is a number that never
// binds — the free-cash check refuses those trades first, and the operator is left wondering why.
eq(row({ autoShares: true, riskPerTrade: 0.09 }, 'maxOpen').ok, true,
  '$30 at 4 contracts funds three concurrent positions');
r = row({ bankroll: 20, autoShares: false, shares: 30 }, 'maxOpen');
eq(r.ok, false, '$20 cannot fund three $18 positions, so the cap is not the real limit');
eq(r.severity, 'warn', 'and that warns rather than passing silently');
ok(/does not buy more trades/.test(r.why), 'the reasoning explains why raising it changes nothing');
// No bankroll set: fall back to the documented default rather than dividing by nothing.
eq(row({ bankroll: null }, 'maxOpen').recommended, '3', 'with no bankroll it recommends the default 3');
eq(row({ bankroll: null }, 'maxOpen').ok, true, 'and does not accuse an unconfigured account');
// Affordability must be priced at the CEILING (65¢), not the typical fill (58.8¢) — the whole point of
// the band. At $38 a fixed 30 contracts costs $19.98 at the ceiling but only $18.15 typically, so the
// two prices disagree about whether two concurrent positions fit: 1 vs 2. Sizing against the typical
// fill is what lets a position qualify at 59¢ and get refused at 65¢, i.e. refused exactly when the
// signal is strongest, which is the failure this row exists to prevent.
eq(row({ bankroll: 38, maxOpen: 2 }, 'maxOpen').ok, false,
  '$38 does not fund two 30-contract positions at the 65c CEILING, even though it would at 59c');
ok(/\$19\.9/.test(row({ bankroll: 38, maxOpen: 2 }, 'maxOpen').why),
  'and the reasoning quotes the ceiling price, not the typical one');
eq(row({ bankroll: 40, maxOpen: 2 }, 'maxOpen').ok, true, '$40 does fund two at the ceiling');

// ── 7. maxPerDir is the one row that is genuinely a preference ───
//
// Default OFF, because the backtest says a cap of 1 raises the win rate 80.9%->83.6% but CUTS net
// $417->$381. The sheet must not quietly recommend the lower-expectancy setting as "safer"; it flips
// to recommending 2 only when the DOWN book is actually warning.
r = row({}, 'maxPerDir');
eq(r.recommended, 'off', 'with a healthy book, off is the recommendation — it is higher expectancy');
eq(r.ok, true, 'and off passes');
ok(/CUTS net/.test(r.why), 'the reasoning is explicit that the cap costs money');
r = row({ downWarn: true }, 'maxPerDir');
eq(r.recommended, '2', 'when the DOWN book warns, a cap of 2 becomes the recommendation');
eq(r.severity, 'warn', 'and it warns while unset');
eq(r.ok, false, 'and does not pass while off');
eq(row({ downWarn: true, maxPerDir: 2 }, 'maxPerDir').ok, true, 'setting it to 2 satisfies the warning');
eq(row({ downWarn: true, maxPerDir: 3 }, 'maxPerDir').ok, false, '3 does not');

// ── 8. the rows that must NOT recommend a change ─────────────────
//
// Half the value of a setup sheet is the rows it leaves alone. Take-profit and hold-to-settlement were
// both measured; every take-profit variant lost on BOTH return and Sharpe, so recommending one would
// be actively wrong. The default here is already right, and the sheet has to say so.
r = row({}, 'cashoutAt');
eq(r.recommended, 'off', 'hold-to-settlement is the recommendation, because take-profit was measured and lost');
eq(r.ok, true, 'the default passes');
eq(r.severity, 'note', 'quietly');
ok(/LOST on both return and Sharpe/.test(r.why), 'and the reasoning cites the measurement');
eq(row({ cashoutAt: 0.9 }, 'cashoutAt').ok, false, 'setting a cashout does NOT pass');
eq(row({ cashoutAt: 0.9 }, 'cashoutAt').severity, 'warn', 'it warns');
// Slippage is priced against the EDGE, which is what makes it answerable rather than a preference.
r = row({}, 'slippageCents');
eq(r.recommended, '2¢', 'two cents is the recommendation');
eq(r.ok, true, 'and the default of 2 passes');
ok(/25pp/.test(r.why), 'the reasoning prices each cent against the measured margin');
eq(row({ slippageCents: 0 }, 'slippageCents').ok, false, '0c does not pass — a ticking market simply misses');
eq(row({ slippageCents: 1 }, 'slippageCents').ok, true, '1c passes');
eq(row({ slippageCents: 3 }, 'slippageCents').ok, true, '3c passes');
eq(row({ slippageCents: 4 }, 'slippageCents').ok, false, '4c is outside the band');
eq(row({ slippageCents: 4 }, 'slippageCents').severity, 'note', 'but 4c is not yet a warning');
eq(row({ slippageCents: 5 }, 'slippageCents').severity, 'warn', '5c is — a fifth of the edge chased');
// Fill grace is a READ delay, not an order lifetime. The distinction is the whole row.
r = row({}, 'fillGrace');
eq(r.ok, true, 'the 3s default passes');
ok(/not how long the order rests/.test(r.why), 'and the reasoning corrects the obvious misreading');
eq(row({ fillGrace: 1 }, 'fillGrace').ok, false, '1s risks reading the book before the fill lands');
eq(row({ fillGrace: 6 }, 'fillGrace').ok, true, '6s passes');
eq(row({ fillGrace: 11 }, 'fillGrace').severity, 'warn', '11s warns — it only delays the loop');

// ── 9. every row is well-formed, whatever the input ──────────────
//
// The page renders `why` and `current` straight into a table. A row that produced `undefined` or NaN
// would put that word in front of somebody as advice about money.
for (const over of [
  {}, { bankroll: null }, { bankroll: 0 }, { bankroll: -5 }, { bankroll: 1e9 },
  { shares: null }, { shares: 'x' }, { riskPerTrade: null }, { riskPerTrade: 0 },
  { autoShares: true }, { dailyStopLoss: '' }, { maxOrderCost: '' }, { maxPerDir: '' },
  { slippageCents: null }, { fillGrace: null }, { cashoutAt: '' }, { maxOpen: null },
  { kellySizing: true }, { kellySizing: true, autoShares: true }, { kellySizing: 'yes' }
]) {
  const rs = rowsFor(over);
  ok(rs.length >= 9, `${JSON.stringify(over)} still produces a full sheet`);
  for (const x of rs) {
    ok(x.key && x.label, `${x.key}: has a key and a label`);
    ok(typeof x.why === 'string' && x.why.length > 20, `${x.key}: why is a real sentence`);
    ok(!/undefined|NaN|null/.test(String(x.current) + x.recommended + x.why),
      `${x.key}: no undefined/NaN/null leaks into rendered text (${JSON.stringify(over)})`);
    ok(typeof x.ok === 'boolean', `${x.key}: ok is a boolean`);
    ok(['high', 'warn', 'note'].includes(x.severity), `${x.key}: severity is one of the three`);
  }
}
// needsAttention sorts most-severe first, so a truncated list still leads with what matters.
const att = recommend.needsAttention(rowsFor({}));
ok(att.length > 0, 'the default configuration has findings');
ok(att.every(x => !x.ok), 'needsAttention returns only failing rows');
const rank = { high: 0, warn: 1, note: 2 };
for (let i = 1; i < att.length; i++) {
  ok(rank[att[i - 1].severity] <= rank[att[i].severity], 'findings are ordered most severe first');
}

// ── 10. the summary, which is what the recommendation COSTS ──────
//
// A sheet of safer-sounding numbers with no visible price is how a conservative recommendation gets
// ignored. The summary states the per-night arithmetic at both win-rate estimates, and the row that
// matters most is `breakeven`: at exactly the average entry price the expectation must be NEGATIVE,
// because fees are charged either way. A model that showed breakeven as zero would be flattering.
let s = recommend.summary({ bankroll: 30 });
eq(s.shares, 4, '$30 at the recommended 9% risk buys 4 contracts at the ceiling');
eq(s.tooSmall, false, 'and that is tradeable');
near(s.win + s.cost, 4, 'a winning contract settles at $1, so win + cost = 4 contracts', 0.02);
ok(s.loss < 0 && s.win > 0, 'a win pays and a loss costs');
ok(Math.abs(s.loss) > s.win, 'the loss is BIGGER than the win — the payoff geometry, stated plainly');
ok(s.nightly.backtest > s.nightly.live, 'the optimistic estimate projects more than the live one');
ok(s.nightly.live > 0, 'at the live 73% the expectation is still positive');
ok(s.nightly.breakeven < 0, 'at exactly breakeven the expectation is NEGATIVE — fees are charged either way');
ok(/independent/.test(s.note), 'and the note discloses the independence assumption');
ok(/93%/.test(s.note), 'naming the directional concentration that breaks it');
// Scaling: more bankroll, more contracts, proportionally more per night.
const big = recommend.summary({ bankroll: 300 });
ok(big.shares > s.shares * 8, '10x the bankroll buys roughly 10x the contracts');
ok(big.nightly.live > s.nightly.live * 8, 'and the nightly expectation scales with it');
// A bankroll too small to fund one contract must say so rather than recommending zero contracts.
const tiny = recommend.summary({ bankroll: 5 });
eq(tiny.tooSmall, true, '$5 cannot fund a contract at 9% risk and the summary says so');
eq(tiny.shares, 0, 'with zero contracts');
ok(/does not fund one contract/.test(tiny.note), 'and explains why rather than showing $0.00 rows');
for (const bad of [null, 0, -1, NaN, undefined, 'x']) {
  eq(recommend.summary({ bankroll: bad }), null, `a ${JSON.stringify(bad)} bankroll yields no summary`);
}
eq(recommend.summary(null), null, 'and a missing snapshot yields no summary rather than throwing');
// tradesPerNight is injected, not baked in, so the corpus figure can be revised in one place.
const slow = recommend.summary({ bankroll: 30 }, { tradesPerNight: 1 });
near(slow.nightly.live, s.nightly.live / 6.3, 'the nightly figures scale linearly with trades/night', 0.02);

console.log(`PASS recommended settings — ${checks} checks`);
