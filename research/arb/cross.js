'use strict';
/**
 * The one information source not yet tried: the OTHER coins in the same settlement window.
 *
 * ── why this is structurally different from the eight failures ──
 *
 * Every previous attempt fed the model things measurable from inside the market being predicted — its own
 * price, its own book, its own flow, its own trajectory, the underlying's spot and vol. All eight lost to
 * the ask, which is what an efficiently priced market looks like: whatever a trader can see about a market
 * is in its price already.
 *
 * This uses what is visible about the OTHER markets. Six coins settle in the same fifteen-minute window on
 * correlated underlyings — measured, not assumed: same-window pairs agree 85.1% of the time against 81.7%
 * if they were independent. So when five coins are all priced at 92c for UP and the sixth is at 87c, that
 * is a fact about the sixth market which lives entirely outside its own book.
 *
 * The mechanism is stateable without the backtest: if each coin's makers quote off their own order flow,
 * consensus across the others is information no single book has absorbed. The mechanism for the null is
 * equally clear: the makers are the same firms across all seven, they see the whole screen, and a $2M/day
 * BTC book is not waiting for a DOGE quote to tell it where BTC is.
 *
 * Judged the only way that has ever held here: fit on the first chronological half, score on the second,
 * against the ask alone. A model that needs the half it was fitted on to look good has found nothing.
 */
const fs = require('fs');
const A_CL = 2;

function quote(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
  const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
  if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  return { a, b, mid: (a + b) / 2 };
}

const byWindow = new Map();
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  r.p.sort((a, b) => b[0] - a[0]);
  const k = String(r.c);
  if (!byWindow.has(k)) byWindow.set(k, []);
  byWindow.get(k).push(r);
}
// Only windows carrying at least five coins: the whole point is the consensus, and a consensus of two is not
// one. This is also why the sample is smaller than the 13,269-market corpus it comes from.
const windows = [...byWindow.entries()]
  .filter(([, ms]) => new Set(ms.map(m => m.s)).size >= 5)
  .sort((a, b) => Number(a[0]) - Number(b[0]));
console.log(`windows with 5+ coins present: ${windows.length}`);

/**
 * One row per (market, minute), with the cross-market view attached.
 *
 * `pUp` is each coin's probability of settling UP, read straight off its book — the YES mid. Making every
 * coin's view directional in the same sense is what allows them to be averaged; averaging dear-side prices
 * would add a 92c UP to a 92c DOWN and call it agreement.
 */
const rows = [];
for (const [, ms] of windows) {
  const perCoin = new Map();
  for (const m of ms) {
    const byLeft = new Map();
    for (const r of m.p) byLeft.set(r[0], r);
    perCoin.set(m.s, { m, byLeft });
  }
  for (let L = 12; L >= 7; L--) {
    const view = [];
    for (const [sym, { m, byLeft }] of perCoin) {
      const row = byLeft.get(L);
      const q = row && quote(row);
      if (!q) continue;
      view.push({ sym, pUp: q.mid, ask: q.a, bid: q.b, won: m.r === 1 });
    }
    if (view.length < 5) continue;
    for (const self of view) {
      const others = view.filter(v => v.sym !== self.sym);
      const mean = others.reduce((a, v) => a + v.pUp, 0) / others.length;
      // How lopsided the rest of the screen is, and how far this market sits from it.
      const agree = others.filter(v => (v.pUp > 0.5) === (self.pUp > 0.5)).length / others.length;
      const spread = Math.max(...others.map(v => v.pUp)) - Math.min(...others.map(v => v.pUp));
      rows.push({
        sym: self.sym, close: Number(ms[0].c), left: L,
        pUp: self.pUp, ask: self.ask,
        othersMean: mean,
        gap: +(mean - self.pUp).toFixed(4),      // consensus minus this market
        agree, spread: +spread.toFixed(4),
        y: self.won ? 1 : 0
      });
    }
  }
}
console.log(`rows: ${rows.length}\n`);
fs.writeFileSync('cross.json', JSON.stringify({ n: rows.length, windows: windows.length }));
module.exports = { rows };
