/**
 * src/decide.js was extracted programmatically from bot.js, and its only claim is that the two
 * cannot disagree about what a signal IS. So this asserts exactly that: every function is pulled
 * out of bot.js at run time and compared against the module, on the same inputs.
 *
 * When bot.js is retired this file retires with it — src/decide.js becomes canonical and there is
 * nothing left to be equal to.
 */
const fs = require('fs');
const assert = require('assert');
const mine = require('../src/decide');

const BOT = process.env.LEGACY_BOT || `${__dirname}/../bot.js`;
if (!fs.existsSync(BOT)) {
  console.log(`SKIP decide equivalence — bot.js not found at ${BOT}`);
  console.log('     This is the only check that the extracted maths still matches the original,');
  console.log('     so a skip is a real gap rather than a pass.');
  process.exit(0);
}

const src = fs.readFileSync(BOT, 'utf8');
const NAMES = ['calcRSI', 'calcEMA', 'calcBollingerBands', 'calcVWAP', 'realizedVol', 'engineEvaluate', 'fee'];
const bodies = NAMES.map(n => {
  const m = src.match(new RegExp('(?:^|\\n)(function ' + n + '\\([\\s\\S]*?\\n\\})', 'm'));
  assert.ok(m, `could not find ${n} in bot.js`);
  return m[1];
}).join('\n');
const legacy = new Function(`${bodies}\nreturn { ${NAMES.join(', ')} };`)();

function series(n, start, drift, noise, seed) {
  let x = start, s = seed;
  const out = [];
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    x = x * (1 + drift + noise * rnd());
    out.push({ time: 1700000000 - i * 60, close: x, high: x * 1.0004, low: x * 0.9996, open: x, volume: 5 + (i % 7) });
  }
  return out;
}

const REGIMES = [
  [60000, 0, 0.0004, 7], [60000, 0.0002, 0.0009, 11], [3000, -0.0003, 0.0006, 23],
  [0.62, 0, 0.0015, 31], [240, 0.0001, 0.0002, 47], [1.0, 0, 0.00005, 53]
];
const eq = (a, b, what) => {
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return;
  assert.deepStrictEqual(a, b, what);
};

let checks = 0;
for (const [st, dr, no, sd] of REGIMES) {
  for (const len of [6, 21, 30, 60]) {
    const c = series(len, st, dr, no, sd);
    eq(mine.calcRSI(c), legacy.calcRSI(c), `calcRSI (${st}, ${len})`);
    for (const p of [9, 20]) eq(mine.calcEMA(c, p), legacy.calcEMA(c, p), `calcEMA ${p}`);
    eq(mine.calcBollingerBands(c), legacy.calcBollingerBands(c), 'calcBollingerBands');
    eq(mine.calcVWAP(c), legacy.calcVWAP(c), 'calcVWAP');
    eq(mine.realizedVol(c, 10), legacy.realizedVol(c, 10), `realizedVol (${st}, ${len})`);
    checks += 6;
    const spot = c[0].close;
    for (const mul of [0.99, 0.999, 1, 1.0005, 1.004]) {
      for (const m of [1, 2.9, 3, 5, 9.8, 14]) {
        eq(mine.engineEvaluate(spot, spot * mul, m, c),
          legacy.engineEvaluate(spot, spot * mul, m, c), `engineEvaluate (mul ${mul}, mins ${m})`);
        checks++;
      }
    }
  }
}
for (const price of [0.25, 0.37, 0.5, 0.62, 0.7, 0.8, 0.97]) {
  for (const shares of [1, 3, 30, 137, 500]) {
    eq(mine.fee(price, shares), legacy.fee(price, shares), `fee(${price}, ${shares})`);
    checks++;
  }
}

console.log(`PASS decide equivalence — ${checks} comparisons identical to bot.js`);
