'use strict';
/**
 * The candidate filters, chosen on the first half and scored blind on the second.
 *
 * The search found the pattern worth having in the entry PRICE itself. The band's bottom slice, 85.0-86.5c,
 * lost 13.3% of the time in the first half against 7.0% for 86.5-88.0c — and the reason is not subtle:
 * break-even at 85c is 85.9%, so an 86.7% win rate there is a rounding error above the toll, while the same
 * 93% win rate two cents higher clears it by five points. The bottom of the band was carrying almost all of
 * the losses and almost none of the edge.
 *
 * Everything else the search turned up sat on 60-150 trades and is not worth acting on. Reported anyway,
 * because a filter that looks good on 70 trades and is quietly dropped is how the vol floor got shipped.
 */
const { T, A, B, score } = require('./losers');
const { takerFee } = require('./kx');

const FILTERS = [
  ['none (85-90c, as shipped)', () => true],
  ['price >= 86.5c', r => r.px >= 0.865],
  ['price >= 87c', r => r.px >= 0.87],
  ['price 86.5-89.5c', r => r.px >= 0.865 && r.px <= 0.895],
  ['price >= 86.5c and fell in', r => r.px >= 0.865 && r.d1 != null && r.d1 <= 0],
  ['price >= 86.5c, vol not mid', r => r.px >= 0.865 && !(r.vol >= 0.025 && r.vol < 0.05)],
  ['dwell >= 1', r => r.dwell >= 1],
];

console.log('chosen on half A, scored on half B\n');
console.log('filter                        kept    A win%  A edge     B win%  B edge   B ROI%   B loss/win');
for (const [name, f] of FILTERS) {
  const a = score(A.filter(f)), b = score(B.filter(f));
  if (!a || !b || b.n < 120) { console.log(`${name.padEnd(29)} too few`); continue; }
  const kept = (T.filter(f).length / T.length * 100).toFixed(0) + '%';
  const lossN = b.n - Math.round(b.win * b.n), winN = Math.round(b.win * b.n);
  console.log(`${name.padEnd(29)} ${kept.padStart(5)}  ${(a.win * 100).toFixed(2).padStart(8)} ${a.edge.toFixed(2).padStart(7)}  ` +
    `${(b.win * 100).toFixed(2).padStart(8)} ${b.edge.toFixed(2).padStart(7)} ${b.roi.toFixed(2).padStart(8)}   ${lossN} lost / ${winN} won`);
}

/**
 * What the winning filter does to the thing actually complained about: money made, against money at risk in
 * the worst stretch. Fewer trades at a bigger edge can carry MORE total profit at a smaller drawdown, which
 * is the only sense in which "take fewer trades" is not a downgrade.
 */
function replay(rs, contracts) {
  let bank = 0, peak = 0, dd = 0, run = 0, worst = 0;
  for (const r of rs) {
    bank += (r.won ? contracts : 0) - (contracts * r.px + takerFee(contracts, r.px));
    if (bank > peak) peak = bank;
    if (peak - bank > dd) dd = peak - bank;
    if (!r.won) { run++; if (run > worst) worst = run; } else run = 0;
  }
  return { pnl: bank, dd, worst };
}
console.log('\nover the WHOLE run, at 3 contracts');
console.log('filter                        trades  win%    profit    worst dip   worst streak   per day');
const days = (T[T.length - 1].close - T[0].close) / 86400e3;
for (const [name, f] of FILTERS.slice(0, 5)) {
  const rs = T.filter(f);
  const s = score(rs), p = replay(rs, 3);
  console.log(`${name.padEnd(29)} ${String(s.n).padStart(6)} ${(s.win * 100).toFixed(2).padStart(6)} ` +
    `${('$' + p.pnl.toFixed(2)).padStart(9)} ${('$' + p.dd.toFixed(2)).padStart(11)} ${String(p.worst).padStart(14)} ` +
    `${(s.n / days).toFixed(1).padStart(9)}`);
}
console.log('\nper coin under the chosen filter (a filter that only works on two coins is not a filter)');
for (const sym of ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'HYPE']) {
  const s = score(T.filter(r => r.px >= 0.865 && r.sym === sym));
  if (s && s.n >= 40) {
    console.log(`  ${sym.padEnd(5)} n=${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(2)}%  edge ${s.edge.toFixed(2).padStart(6)}pp`);
  }
}
