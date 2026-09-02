'use strict';
/**
 * Seven series say the favourite is underpriced. Seven say the opposite. What separates them?
 *
 * The band earns +1.55pp across BTC, ETH, SOL, XRP, BNB, DOGE and HYPE, and LOSES on all seven series the
 * bot does not trade: GOLD −4.45, SILVER −2.53, WTI −1.83, COPPER −2.17, NATGAS −6.24, NEAR −3.76,
 * ZEC −13.66. Seven for and seven against is not a detail — it is either a mechanism or a verdict.
 *
 *   If liquidity explains it, there is a filter: trade the well-made books, skip the thin ones, and the
 *   crypto result stands on a stated reason rather than on which seven happened to be in the sample.
 *
 *   If nothing explains it, then fourteen series scattered around zero is the honest distribution, the
 *   +1.55pp is the lucky half of it, and the strategy should not be trusted with size.
 *
 * This asks the question directly: rank all fourteen by how heavily their markets trade, and see whether
 * edge follows.
 */
const fs = require('fs');
const { get } = require('./kx');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Measured with the shipped gate: 85-90c, T-12..T-6, hold to settle. Crypto seven from paths.jsonl,
// the other seven from the bounded comm samples.
const EDGE = {
  BTC: null, ETH: null, SOL: null, XRP: null, BNB: null, DOGE: null, HYPE: null,
  GOLD: -4.45, SILVER: -2.53, WTI: -1.83, COPPER: -2.17, NATGAS: -6.24, NEAR: -3.76, ZEC: -13.66
};
const A_CL = 2;
function loadCrypto() {
  const by = {};
  for (const line of fs.readFileSync('paths.jsonl', 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
    r.p.sort((a, b) => b[0] - a[0]);
    let e = null;
    for (const row of r.p) {
      const left = row[0];
      if (left > 12) continue;
      if (left < 6) break;
      const ask = row[1], bid = row[2];
      const a = ask && ask[A_CL] != null ? ask[A_CL] : null;
      const b = bid && bid[A_CL] != null ? bid[A_CL] : null;
      if (a == null || b == null || !(a > 0 && a < 1 && b > 0 && b < 1) || a < b) continue;
      const no = +(1 - b).toFixed(4);
      if (a >= 0.85 && a <= 0.90) { e = { side: 'YES', px: a }; break; }
      if (no >= 0.85 && no <= 0.90) { e = { side: 'NO', px: no }; break; }
    }
    if (!e) continue;
    (by[r.s] = by[r.s] || []).push({ px: e.px, won: e.side === 'YES' ? r.r === 1 : r.r === 0 });
  }
  for (const [sym, ts] of Object.entries(by)) {
    const win = ts.filter(t => t.won).length / ts.length;
    const px = ts.reduce((a, t) => a + t.px, 0) / ts.length;
    EDGE[sym] = +((win - (px + 0.07 * px * (1 - px))) * 100).toFixed(2);
    EDGE[sym + '_n'] = ts.length;
  }
}
loadCrypto();

(async () => {
  const rows = [];
  for (const sym of Object.keys(EDGE).filter(k => !k.endsWith('_n'))) {
    let vol = null, oi = null;
    try {
      const j = await get(`${BASE}/markets?series_ticker=KX${sym}15M&status=settled&limit=200`);
      const vs = (j.markets || []).map(m => Number(m.volume_fp)).filter(Number.isFinite).sort((a, b) => a - b);
      const os = (j.markets || []).map(m => Number(m.open_interest_fp)).filter(Number.isFinite).sort((a, b) => a - b);
      if (vs.length) vol = vs[Math.floor(vs.length / 2)];
      if (os.length) oi = os[Math.floor(os.length / 2)];
    } catch (_) {}
    rows.push({ sym, edge: EDGE[sym], n: EDGE[sym + '_n'] || null, vol, oi,
                traded: ['BTC','ETH','SOL','XRP','BNB','DOGE','HYPE'].includes(sym) });
  }
  rows.sort((a, b) => (b.vol || 0) - (a.vol || 0));
  console.log('series ranked by median contracts traded per market\n');
  console.log('series    median volume   median OI     edge(pp)    n   in the bot?');
  for (const r of rows) {
    console.log(`  ${r.sym.padEnd(8)} ${String(r.vol == null ? '?' : Math.round(r.vol)).padStart(12)} ${String(r.oi == null ? '?' : Math.round(r.oi)).padStart(12)} ${String(r.edge == null ? '?' : r.edge).padStart(11)} ${String(r.n || '').padStart(5)}   ${r.traded ? 'yes' : 'no'}`);
  }
  const ok = rows.filter(r => r.vol != null && r.edge != null);
  const lv = ok.map(r => Math.log(Math.max(1, r.vol))), ev = ok.map(r => r.edge);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const mx = mean(lv), my = mean(ev);
  const cov = lv.reduce((a, x, i) => a + (x - mx) * (ev[i] - my), 0);
  const sx = Math.sqrt(lv.reduce((a, x) => a + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ev.reduce((a, y) => a + (y - my) ** 2, 0));
  console.log(`\ncorrelation between log(volume) and edge across ${ok.length} series: ${(cov / (sx * sy)).toFixed(3)}`);
  const hi = ok.filter(r => r.vol >= 20000), lo = ok.filter(r => r.vol < 20000);
  if (hi.length && lo.length) {
    console.log(`  heavily traded (>=20k median): ${hi.length} series, mean edge ${mean(hi.map(r => r.edge)).toFixed(2)}pp  [${hi.map(r => r.sym).join(' ')}]`);
    console.log(`  thinly traded  (<20k median): ${lo.length} series, mean edge ${mean(lo.map(r => r.edge)).toFixed(2)}pp  [${lo.map(r => r.sym).join(' ')}]`);
  }
})();
