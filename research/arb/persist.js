'use strict';
/**
 * The live bot takes no trades, and this is why: gateSignal holds every entry until the signal has
 * PERSISTED for 60 seconds, and it deletes the watch on any pass that does not produce an observation.
 *
 * The favourite gate carries no observation when it is out of band, so the watch is destroyed the moment
 * the price leaves 85-90c. In practice that means the dear side has to sit inside a five-cent band
 * continuously for a full minute before an order goes in — while the measurement that produced the edge
 * took the FIRST in-band minute and never asked it to stay there.
 *
 * Two questions, in order:
 *   1. How much volume does the persistence requirement destroy?
 *   2. Does it buy anything? If entries that survived a minute in band win MORE, the requirement is a
 *      filter worth keeping and the fix is to widen the band. If they win the same or less, it is pure
 *      loss and FAVOURITE should be exempt from it.
 *
 * Minute candles are the finest resolution available, so "two consecutive in-band minutes" stands in for
 * "in band for sixty seconds". That understates persistence slightly and is the conservative direction.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2;
const LO = 0.85, HI = 0.90;

const rows = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length) continue;
  r.p.sort((a, b) => b[0] - a[0]);
  rows.push(r);
}
rows.sort((a, b) => a.c - b.c);

/** The dear side's price in one minute, or null when the book was not two-sided. */
function dear(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
  const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
  if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  const no = +(1 - b).toFixed(4);
  if (a >= LO && a <= HI) return { side: 'YES', px: a };
  if (no >= LO && no <= HI) return { side: 'NO', px: no };
  return null;
}

/** mode 'first' = enter on the first in-band minute. 'persist' = require the previous minute in band too. */
function run(mode) {
  const ts = [];
  for (const m of rows) {
    let prev = null, e = null;
    for (const row of m.p) {
      const L = row[0];
      if (L > 12) { prev = null; continue; }
      if (L < 6) break;
      const d = dear(row);
      if (!d) { prev = null; continue; }
      if (mode === 'first') { e = { ...d, left: L }; break; }
      // The same side, in band, in the immediately preceding minute — the watch survived.
      if (prev && prev.side === d.side) { e = { ...d, left: L }; break; }
      prev = d;
    }
    if (!e) continue;
    const won = e.side === 'YES' ? m.r === 1 : m.r === 0;
    const cost = 100 * e.px + takerFee(100, e.px);
    ts.push({ px: e.px, won, side: e.side, sym: m.s, close: m.c, pnl: (won ? 100 : 0) - cost, cost });
  }
  const n = ts.length; if (!n) return null;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  const pnl = ts.reduce((a, t) => a + t.pnl, 0), staked = ts.reduce((a, t) => a + t.cost, 0);
  const z = 1.96, d = 1 + z * z / n, c = (win + z * z / (2 * n)) / d;
  const hw = z * Math.sqrt(win * (1 - win) / n + z * z / (4 * n * n)) / d;
  return { n, win: +(win * 100).toFixed(2), px: +(px * 100).toFixed(2), be: +(be * 100).toFixed(2),
           edge: +((win - be) * 100).toFixed(2), lo95: +((c - hw) * 100).toFixed(2),
           roi: +(pnl / staked * 100).toFixed(3), pnl: +pnl.toFixed(0), ts };
}

const A = run('first'), B = run('persist');
console.log(`markets ${rows.length}\n`);
console.log('entry rule                             n    fires%  price   win%   b/e     edge    ROI%');
for (const [nm, r] of [['first in-band minute (measured) ', A], ['in band a second minute (live gate)', B]]) {
  if (!r) { console.log(`${nm}  none`); continue; }
  console.log(`${nm} ${String(r.n).padStart(5)} ${(r.n / rows.length * 100).toFixed(0).padStart(6)}% ${String(r.px).padStart(7)} ${String(r.win).padStart(6)} ${String(r.be).padStart(7)} ${String(r.edge).padStart(7)} ${String(r.roi).padStart(7)}`);
}
if (A && B) {
  console.log(`\nvolume kept by the persistence rule: ${(B.n / A.n * 100).toFixed(0)}% (${B.n} of ${A.n})`);
  console.log(`edge change: ${A.edge}pp -> ${B.edge}pp  (${(B.edge - A.edge >= 0 ? '+' : '')}${(B.edge - A.edge).toFixed(2)}pp)`);
  console.log(`total profit at 100 contracts: $${A.pnl} -> $${B.pnl}`);
  const verdict = B.edge > A.edge + 0.5 ? 'KEEP it and widen the band'
    : B.edge < A.edge - 0.5 ? 'DROP it — persistence actively hurts'
    : 'DROP it — it buys nothing and costs most of the volume';
  console.log(`\nverdict: ${verdict}`);
  // Halves on the persistence variant, in case it is better but only in one stretch.
  const half = ts => {
    const k = Math.floor(ts.length / 2);
    const q = s => {
      const w = s.filter(t => t.won).length / s.length, p = s.reduce((a, t) => a + t.px, 0) / s.length;
      return +((w - (p + 0.07 * p * (1 - p))) * 100).toFixed(2);
    };
    return [q(ts.slice(0, k)), q(ts.slice(k))];
  };
  console.log(`halves — first rule: ${half(A.ts).join(' / ')}pp    persistence rule: ${half(B.ts).join(' / ')}pp`);
}
