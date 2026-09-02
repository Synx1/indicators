'use strict';
/**
 * The full price path of every settled 15-minute market: per-minute yes_bid and yes_ask, high and low.
 *
 * ── why the highs and lows are the whole point ──
 *
 * Every measurement in this project so far graded hold-to-settle, which needs one number per market:
 * the result. A take-profit rule needs the PATH — specifically the best price that was ever available
 * to sell into, and the cheapest price that was ever available to buy at. `yes_ask.low` is what a buy
 * could actually have paid in that minute; `yes_bid.high` is what a sell could actually have received.
 * Using close prices instead would test a strategy nobody could have executed.
 *
 * Resumable by design. 45,030 markets is ~40 minutes of requests and a dropped connection halfway
 * through must not mean starting again, so rows land in a JSONL file and tickers already present are
 * skipped on the next run.
 */
const fs = require('fs');
const path = require('path');
const { get } = require('./kx');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MARKETS = path.join(__dirname, '..', 'corpus2', 'markets.json');
const OUT = path.join(__dirname, 'paths.jsonl');
/**
 * Eight, not forty.
 *
 * Raising concurrency made this SLOWER, not faster: at 40 workers the exchange returned 2,881 failures
 * against 2,000 successes and the throughput stayed at 4/s, so more than half the requests were burned
 * on retries that also failed. Eight workers saturate the same limit with no failures, which means every
 * market lands on the first pass instead of needing a second run to fill the holes.
 */
const CONC = 8;

const num = v => (v == null ? NaN : Number(v));
/** A candle side reduced to the two numbers that matter, or null when the side never quoted. */
function side(s) {
  if (!s) return null;
  const lo = num(s.low_dollars), hi = num(s.high_dollars), cl = num(s.close_dollars);
  if (!Number.isFinite(lo) && !Number.isFinite(hi) && !Number.isFinite(cl)) return null;
  return [Number.isFinite(lo) ? +lo.toFixed(4) : null, Number.isFinite(hi) ? +hi.toFixed(4) : null,
          Number.isFinite(cl) ? +cl.toFixed(4) : null];
}

async function one(sym, ticker, closeMs, result) {
  const closeS = Math.floor(closeMs / 1000);
  // 16 minutes back covers the whole life of a 15-minute market plus the boundary minute.
  const j = await get(`${BASE}/series/KX${sym}15M/markets/${ticker}/candlesticks?start_ts=${closeS - 16 * 60}&end_ts=${closeS + 60}&period_interval=1`);
  const cs = (j.candlesticks || []);
  const rows = [];
  for (const c of cs) {
    const left = Math.round((closeS - c.end_period_ts) / 60);
    // A candle whose window ends after the close is settlement noise, not a tradeable minute.
    if (left < 0) continue;
    const a = side(c.yes_ask), b = side(c.yes_bid);
    if (!a && !b) continue;
    rows.push([left, a, b, Number.isFinite(num(c.volume_fp)) ? Math.round(num(c.volume_fp)) : 0]);
  }
  return { t: ticker, s: sym, c: closeMs, r: result, p: rows };
}

(async () => {
  const mk = JSON.parse(fs.readFileSync(MARKETS, 'utf8'));
  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line) continue;
      const i = line.indexOf('"t":"');
      if (i >= 0) done.add(line.slice(i + 5, line.indexOf('"', i + 5)));
    }
  }
  const jobs = [];
  for (const [sym, rows] of Object.entries(mk)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (!Array.isArray(r) || done.has(r[0])) continue;
      jobs.push([sym, r[0], r[1], r[3]]);
    }
  }
  // Chronological first, then interleaved by a stride.
  //
  // The exchange caps this at ~4 requests a second, so the full corpus takes hours and every analysis
  // in between runs on a PARTIAL file. Fetching in date order would make that partial file the oldest
  // weeks only — and the one question that has killed every finding in this project is whether a result
  // survives its weaker chronological half. A stride makes any prefix of the file span all 68 days, so
  // the halves test is available from the first few thousand rows instead of only at the end.
  jobs.sort((a, b) => a[2] - b[2]);
  const STRIDE = 97;
  const woven = [];
  for (let off = 0; off < STRIDE; off++) for (let k = off; k < jobs.length; k += STRIDE) woven.push(jobs[k]);
  jobs.length = 0; jobs.push(...woven);
  console.log(`${done.size} already fetched, ${jobs.length} to go (stride-woven so any prefix spans the range)`);

  const fh = fs.openSync(OUT, 'a');
  let i = 0, ok = 0, bad = 0, empty = 0;
  const t0 = Date.now();
  async function worker() {
    while (i < jobs.length) {
      const j = jobs[i++];
      try {
        const row = await one(j[0], j[1], j[2], j[3]);
        if (!row.p.length) empty++;
        fs.writeSync(fh, JSON.stringify(row) + '\n');
        ok++;
      } catch (e) { bad++; if (bad <= 3) console.log(`  first failures: ${e.message}`); }
      if (ok % 2000 === 0 && ok) {
        const rate = ok / ((Date.now() - t0) / 1000);
        console.log(`  ${ok} ok / ${bad} failed / ${empty} empty · ${rate.toFixed(1)}/s · ${(((jobs.length - i) / rate) / 60).toFixed(0)}min left`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.closeSync(fh);
  console.log(`done: ${ok} written, ${bad} failed, ${empty} with no candles -> ${OUT}`);
})();
