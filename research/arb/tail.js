'use strict';
/**
 * Few trades, big profit: does the EXTREME tail of any score carry an edge the band sweeps missed?
 *
 * ── the gap this closes ──
 *
 * Every earlier test on cheap entries took a large slice of them — a whole 25-40c band, every qualifying
 * minute. If an edge exists only in the top one percent of some score, a sweep that averages over 18,000
 * entries would bury it completely. "Fewer trades is fine, I want good entries" is precisely a request to
 * look in the tail, and the tail has not been looked at.
 *
 * ── how it is judged ──
 *
 * Both directions of every score, because a score whose top decile is good and whose bottom is bad is a
 * signal, while one that is good at both ends is noise. Each cut is scored on the second chronological half
 * only — the first half is where the cut is allowed to look promising. A tail of 30 trades that returns 40%
 * in-sample and nothing out-of-sample is what this file exists to catch rather than report.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, A_HI = 1, A_LO = 0;

function quote(row) {
  const ask = row[1], bid = row[2];
  const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
  const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
  if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) return null;
  return { a, b, mid: (a + b) / 2 };
}
const markets = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || r.p.length < 5) continue;
  r.p.sort((a, b) => b[0] - a[0]);
  markets.push(r);
}
markets.sort((a, b) => a.c - b.c);

// Cross-market view per (window, minute): each coin's UP probability, for the consensus terms.
const view = new Map();
for (const m of markets) {
  for (const row of m.p) {
    const q = quote(row);
    if (!q) continue;
    const k = m.c + '|' + row[0];
    if (!view.has(k)) view.set(k, []);
    view.get(k).push({ sym: m.s, pUp: q.mid });
  }
}

const rows = [];
for (const m of markets) {
  const byLeft = new Map();
  for (const r of m.p) byLeft.set(r[0], r);
  for (const row of m.p) {
    const L = row[0];
    if (L > 13 || L < 4) continue;
    const q = quote(row);
    if (!q) continue;
    for (const side of ['YES', 'NO']) {
      const px = side === 'YES' ? q.a : +(1 - q.b).toFixed(4);
      if (!(px >= 0.25 && px <= 0.70)) continue;
      const mid = side === 'YES' ? q.mid : 1 - q.mid;
      const q1 = byLeft.get(L + 1) && quote(byLeft.get(L + 1));
      const q2 = byLeft.get(L + 2) && quote(byLeft.get(L + 2));
      if (!q1 || !q2) continue;
      const m1 = side === 'YES' ? q1.mid : 1 - q1.mid;
      const m2 = side === 'YES' ? q2.mid : 1 - q2.mid;

      const others = (view.get(m.c + '|' + L) || []).filter(v => v.sym !== m.s);
      if (others.length < 4) continue;
      const cons = others.reduce((a, v) => a + v.pUp, 0) / others.length;
      const consSide = side === 'YES' ? cons : 1 - cons;

      // The best price this side could later be SOLD into, for the cash-out variant.
      let maxSell = null;
      for (let k = L - 1; k >= 0; k--) {
        const later = byLeft.get(k);
        if (!later) continue;
        const s = side === 'YES'
          ? (later[2] && later[2][A_HI] != null ? Number(later[2][A_HI]) : null)
          : (later[1] && later[1][A_LO] != null ? +(1 - Number(later[1][A_LO])).toFixed(4) : null);
        if (s != null && s > 0 && s < 1 && (maxSell == null || s > maxSell)) maxSell = s;
      }
      rows.push({
        sym: m.s, close: m.c, left: L, side, px, won: side === 'YES' ? m.r === 1 : m.r === 0, maxSell,
        // the scores
        drift: +(mid - m1).toFixed(4),
        drift2: +((mid - m2) / 2).toFixed(4),
        consGap: +(consSide - mid).toFixed(4),      // the rest of the screen minus this market
        consLean: +(consSide - 0.5).toFixed(4),      // how strongly the rest of the screen backs this side
        clock: L,
        vol: Number(row[3]) || 0
      });
      break;
    }
  }
}
rows.sort((a, b) => a.close - b.close);
const mid = Math.floor(rows.length / 2);
const A = rows.slice(0, mid), B = rows.slice(mid);
console.log(`${rows.length} cheap entries (25-70c)   train ${A.length}  test ${B.length}\n`);

function score(rs, target) {
  const n = rs.length; if (!n) return null;
  let pnl = 0, staked = 0, wins = 0;
  for (const r of rs) {
    const tgt = target == null ? null : Math.min(0.97, +(r.px + target).toFixed(4));
    const hit = tgt != null && r.maxSell != null && r.maxSell >= tgt;
    const cost = 100 * r.px + takerFee(100, r.px);
    const gross = hit ? 100 * tgt : (r.won ? 100 : 0);
    pnl += gross - (hit ? takerFee(100, tgt) : 0) - cost;
    staked += cost;
    if (gross > cost) wins++;
  }
  return { n, roi: pnl / staked * 100, pnl, winPct: wins / n * 100 };
}

const SCORES = [
  ['drift up', r => r.drift], ['drift down', r => -r.drift],
  ['2-min drift up', r => r.drift2], ['2-min drift down', r => -r.drift2],
  ['screen backs it', r => r.consLean], ['screen against it', r => -r.consLean],
  ['screen above price', r => r.consGap], ['screen below price', r => -r.consGap],
  ['late in the round', r => -r.clock], ['early in the round', r => r.clock],
  ['heaviest volume', r => r.vol],
];
console.log('top 1% of each score, hold to settle and cash out at +30c, scored on the HELD-OUT half');
console.log('score                  n     train ROI    TEST ROI   TEST +30c ROI');
for (const [name, f] of SCORES) {
  const cutA = A.map(f).sort((a, b) => b - a)[Math.floor(A.length * 0.01)];
  const selA = A.filter(r => f(r) >= cutA), selB = B.filter(r => f(r) >= cutA);
  if (selB.length < 40) { console.log(`${name.padEnd(20)} too few in the test half`); continue; }
  const a = score(selA, null), b = score(selB, null), b30 = score(selB, 0.30);
  console.log(`${name.padEnd(20)} ${String(selB.length).padStart(5)} ${a.roi.toFixed(2).padStart(12)} ${b.roi.toFixed(2).padStart(11)} ${b30.roi.toFixed(2).padStart(15)}`);
}
console.log('\nthe whole cheap band, for reference');
for (const t of [null, 0.30]) {
  const b = score(B, t);
  console.log(`  ${(t == null ? 'hold to settle' : 'cash out at +30c').padEnd(18)} n=${b.n}  ROI ${b.roi.toFixed(2)}%  win ${b.winPct.toFixed(1)}%`);
}
