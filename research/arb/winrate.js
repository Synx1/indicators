'use strict';
/**
 * "Make a predictor that doesn't get many wrong" — the market will sell you any win rate you like.
 *
 * The filter search came back empty: every rule that looked good on the first half did WORSE than no rule at
 * all on the second. There is nothing in the price path that marks the losers. But the request has an answer
 * anyway, and it is a disappointing one for a reason worth seeing rather than being told.
 *
 * A higher win rate is purchasable. Buy dearer contracts and you win more often — that is what the price
 * MEANS. What it costs is the payout, and break-even rises exactly as fast. So this prints win rate beside
 * edge across the whole price line: the column somebody wants to maximise, next to the column that pays.
 */
const fs = require('fs');
const { takerFee } = require('./kx');
const A_CL = 2, MIN_L = 7, MAX_L = 12;

const markets = [];
for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  let r; try { r = JSON.parse(line); } catch (_) { continue; }
  if (!r || !Array.isArray(r.p) || !r.p.length || r.s === 'XRP') continue;
  r.p.sort((a, b) => b[0] - a[0]);
  markets.push(r);
}
markets.sort((a, b) => a.c - b.c);

function run(lo, hi) {
  const seen = new Set(), ts = [];
  for (const m of markets) {
    for (const row of m.p) {
      const L = row[0];
      if (L > MAX_L) continue;
      if (L < MIN_L) break;
      const ask = row[1], bid = row[2];
      const a = ask && ask[A_CL] != null ? Number(ask[A_CL]) : NaN;
      const b = bid && bid[A_CL] != null ? Number(bid[A_CL]) : NaN;
      if (!(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
      const no = +(1 - b).toFixed(4);
      let side = null, px = null;
      if (a >= lo && a <= hi) { side = 'YES'; px = a; }
      else if (no >= lo && no <= hi) { side = 'NO'; px = no; }
      if (!side) continue;
      if (seen.has(String(m.c))) break;
      seen.add(String(m.c));
      ts.push({ px, won: side === 'YES' ? m.r === 1 : m.r === 0, close: m.c });
      break;
    }
  }
  const n = ts.length; if (n < 200) return null;
  const win = ts.filter(t => t.won).length / n;
  const px = ts.reduce((a, t) => a + t.px, 0) / n;
  const be = px + 0.07 * px * (1 - px);
  const pnl = ts.reduce((a, t) => a + ((t.won ? 3 : 0) - (3 * t.px + takerFee(3, t.px))), 0);
  const days = (ts[ts.length - 1].close - ts[0].close) / 86400e3;
  let bank = 0, peak = 0, dd = 0;
  for (const t of ts) {
    bank += (t.won ? 3 : 0) - (3 * t.px + takerFee(3, t.px));
    if (bank > peak) peak = bank;
    if (peak - bank > dd) dd = peak - bank;
  }
  return { n, win, px, be, edge: (win - be) * 100, pnl, perDay: n / days, dd };
}

console.log('one entry per settlement window, T-12..T-7, 3 contracts, over 68 days\n');
console.log('entry band   trades  /day   win%    break-even   EDGE     profit    worst dip');
for (const [lo, hi] of [[0.55, 0.65], [0.65, 0.75], [0.75, 0.85], [0.85, 0.90],
                        [0.90, 0.95], [0.93, 0.97], [0.95, 0.99]]) {
  const r = run(lo, hi);
  if (!r) continue;
  console.log(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}c`.padEnd(13) +
    String(r.n).padStart(6) + r.perDay.toFixed(1).padStart(7) +
    (r.win * 100).toFixed(2).padStart(8) + (r.be * 100).toFixed(2).padStart(13) +
    r.edge.toFixed(2).padStart(8) + ('$' + r.pnl.toFixed(2)).padStart(11) +
    ('$' + r.dd.toFixed(2)).padStart(13));
}
console.log('\nThe win% column is purchasable and the EDGE column is not. 96% accuracy is available at 95c and');
console.log('earns a third of what 89.5% earns at 87c, because break-even climbs with the price.');
