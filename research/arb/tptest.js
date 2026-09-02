'use strict';
/**
 * The take-profit question, on real paths: does exiting a cheap entry at 95-99¢ beat holding it?
 *
 * ── the one thing this measures that nothing before it did ──
 *
 * Every earlier grading in this project was hold-to-settle, which needs one number per market — the
 * result. A take-profit changes the PAYOFF, not the prediction: a market that runs to 97¢ and then
 * reverses is a loss when held and a win when sold. So the question is entirely about how often that
 * reversal happens, and it is answerable only from the price path.
 *
 * ── how an entry and an exit are decided, and why not more generously ──
 *
 * ENTRY takes the minute's CLOSING ask. A bot polling once a minute sees that price and can hit it;
 * using the minute's low instead would be buying at a price that may have existed for one second in
 * the middle of a minute nobody was watching.
 *
 * EXIT takes a later minute's BEST BID. That is not optimism — a take-profit is a resting limit sell,
 * and a resting sell at 97¢ fills the moment the bid touches 97¢, whether or not anyone is looking.
 * The conservative variant (the bid still there at the minute's close) is reported alongside it so the
 * gap between "a limit order would have caught it" and "it was unmistakably there" is visible rather
 * than assumed.
 *
 * Both sides are charged the full TAKER fee. A resting exit would really pay the smaller maker fee,
 * so every take-profit number here is a floor.
 */
const fs = require('fs');
const path = require('path');
const { takerFee } = require('./kx');

const FILE = path.join(__dirname, 'paths.jsonl');
const SIZE = 100;                 // contracts per round — fixed, as the strategy requires
let MIN_ENTRY = 0.20;
let MAX_ENTRY = 0.40;
const FIRST_MIN_SKIP = 5;         // no entry in the first 5 minutes -> minutesLeft <= 10
const LAST_MIN_SKIP = 2;          // no entry in the last 2 minutes  -> minutesLeft >= 2

const A_LO = 0, A_HI = 1, A_CL = 2;   // [low, high, close] as paths.js stores each side

function load() {
  const out = [];
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || !Array.isArray(r.p) || !r.p.length) continue;
    // Oldest minute first, so "later" means what it says.
    r.p.sort((a, b) => b[0] - a[0]);
    out.push(r);
  }
  out.sort((a, b) => a.c - b.c);
  return out;
}

/**
 * One trade on one market, or null when nothing qualified.
 *
 * `side` is which contract gets bought. YES prices come straight off the ask; NO prices are the
 * mirror of the YES book — a NO ask at q is a YES bid at 1−q — so the NO path is read off yes_bid
 * inverted rather than from a second data source that could disagree with the first.
 */
function trade(m, side, tp, conservative) {
  const rows = m.p;
  let entry = null, entryIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const [left, ask, bid] = rows[i];
    if (left > 15 - FIRST_MIN_SKIP) continue;
    if (left < LAST_MIN_SKIP) break;
    // The price this side could be BOUGHT at, at the close of this minute.
    let px = null;
    if (side === 'YES') px = ask && ask[A_CL] != null ? ask[A_CL] : null;
    else px = bid && bid[A_CL] != null ? +(1 - bid[A_CL]).toFixed(4) : null;
    if (px == null || px < MIN_ENTRY || px > MAX_ENTRY) continue;
    entry = px; entryIdx = i; break;
  }
  if (entry == null) return null;

  // Did a resting sell at `tp` fill in any LATER minute?
  let exit = null;
  for (let i = entryIdx + 1; i < rows.length; i++) {
    const [, ask, bid] = rows[i];
    // The price this side could be SOLD at, in this minute.
    let best = null;
    if (side === 'YES') best = bid ? bid[conservative ? A_CL : A_HI] : null;
    else best = ask && ask[conservative ? A_CL : A_LO] != null ? +(1 - ask[conservative ? A_CL : A_LO]).toFixed(4) : null;
    if (best != null && best >= tp) { exit = tp; break; }
  }

  const won = side === 'YES' ? m.r === 1 : m.r === 0;
  const cost = SIZE * entry + takerFee(SIZE, entry);
  const gross = exit != null ? SIZE * exit : (won ? SIZE * 1 : 0);
  const exitFee = exit != null ? takerFee(SIZE, exit) : 0;
  return { sym: m.s, close: m.c, side, entry, exit, won, pnl: +(gross - exitFee - cost).toFixed(4), cost: +cost.toFixed(4) };
}

function stats(trades) {
  const n = trades.length;
  if (!n) return null;
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const staked = trades.reduce((a, t) => a + t.cost, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const avgEntry = trades.reduce((a, t) => a + t.entry, 0) / n;
  const tpHits = trades.filter(t => t.exit != null).length;
  // The equity curve is what killed every earlier finding, so it is measured, not inferred.
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  return { n, pnl: +pnl.toFixed(2), roi: +(pnl / staked * 100).toFixed(2), winPct: +(wins / n * 100).toFixed(1),
           avgEntry: +avgEntry.toFixed(4), tpPct: +(tpHits / n * 100).toFixed(1), maxDD: +dd.toFixed(2) };
}

function halves(trades) {
  const mid = Math.floor(trades.length / 2);
  return [stats(trades.slice(0, mid)), stats(trades.slice(mid))];
}

const ms = load();
console.log(`markets with a price path: ${ms.length}`);
if (ms.length) console.log(`range: ${new Date(ms[0].c).toISOString().slice(0, 10)} .. ${new Date(ms[ms.length - 1].c).toISOString().slice(0, 10)}`);

/**
 * The entry BAND, not just a ceiling.
 *
 * "Anything at or under 40¢" sounds like one rule and is really two very different trades. Scanning
 * for the first minute at or under 40¢ buys a 2¢ contract whenever one is offered, and a 2¢ contract
 * is the lottery ticket the strategy explicitly warns against. So the floor is swept alongside the
 * ceiling — and the fee is the reason it matters more than it looks: as a share of the money put up,
 * Kalshi's fee is 0.07·(1−p), which is 6.9% of the stake at 1¢ and 0.4% at 94¢. Cheap contracts are
 * the WORST place to pay this fee relative to what is risked, which is the opposite of the usual
 * "fees vanish at the ends" reading.
 */
const BANDS = [[0.02, 0.40], [0.10, 0.40], [0.20, 0.40], [0.25, 0.40], [0.30, 0.40],
               [0.30, 0.45], [0.35, 0.45], [0.30, 0.55], [0.40, 0.55], [0.45, 0.55]];
const TPS = [null, 0.99, 0.97, 0.95];

console.log(`\nminutes 5..13, one entry per round, ${SIZE} contracts, taker fees both ways\n`);
console.log('band        exit      n      avgEnt  win%   TP%    ROI%     PnL$      maxDD$  | h1 ROI  h2 ROI  worse half');
const out = [];
for (const [lo, hi] of BANDS) {
  MIN_ENTRY = lo; MAX_ENTRY = hi;
  for (const tp of TPS) {
    const ts = [];
    for (const m of ms) {
      const t = trade(m, 'YES', tp == null ? 2 : tp, false) || trade(m, 'NO', tp == null ? 2 : tp, false);
      if (t) ts.push(t);
    }
    const s = stats(ts);
    if (!s || s.n < 40) continue;
    const [h1, h2] = halves(ts);
    const worse = Math.min(h1 ? h1.roi : -999, h2 ? h2.roi : -999);
    out.push({ lo, hi, tp, s, h1, h2, worse });
    const el = tp == null ? 'settle' : `TP ${(tp * 100).toFixed(0)}c`;
    console.log(`${lo.toFixed(2)}-${hi.toFixed(2)}  ${el.padEnd(7)} ${String(s.n).padStart(6)} ${String(s.avgEntry).padStart(7)} ${String(s.winPct).padStart(6)} ${String(s.tpPct).padStart(6)} ${String(s.roi).padStart(8)} ${String(s.pnl).padStart(9)} ${String(s.maxDD).padStart(9)}  | ${String(h1 ? h1.roi : '-').padStart(7)} ${String(h2 ? h2.roi : '-').padStart(7)}  ${String(worse.toFixed(2)).padStart(8)}`);
  }
}
const best = out.slice().sort((a, b) => b.worse - a.worse).slice(0, 5);
console.log('\nranked by the WORSE half (the only ranking that has ever survived here):');
for (const r of best) console.log(`  worse half ${String(r.worse.toFixed(2)).padStart(8)}%   ${r.lo.toFixed(2)}-${r.hi.toFixed(2)} ${r.tp == null ? 'settle' : 'TP ' + (r.tp * 100).toFixed(0) + 'c'}  overall ${r.s.roi}%  n=${r.s.n}`);
fs.writeFileSync(path.join(__dirname, 'tptest.json'), JSON.stringify({ at: Date.now(), markets: ms.length, out }, null, 1));
console.log('\n-> tptest.json');
