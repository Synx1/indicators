'use strict';
/** What the exchange actually looks like right now: leg counts, strike shapes, and how the sums land. */
const fs = require('fs');
const path = require('path');
const { openEvents, num } = require('./kx');

(async () => {
  const t0 = Date.now();
  const evs = await openEvents({ log: console.log });
  console.log(`open events: ${evs.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const strikeTypes = new Map();
  const notional = new Map();
  let mutex = 0, multi = 0, mutexMulti = 0;
  const sums = [];

  for (const ev of evs) {
    const ms = (ev.markets || []).filter(m => m.status === 'active' || m.status === 'open');
    if (ms.length > 1) multi++;
    if (ev.mutually_exclusive) mutex++;
    if (ev.mutually_exclusive && ms.length > 1) mutexMulti++;
    for (const m of ms) {
      strikeTypes.set(m.strike_type || '(none)', (strikeTypes.get(m.strike_type || '(none)') || 0) + 1);
      notional.set(String(m.notional_value_dollars), (notional.get(String(m.notional_value_dollars)) || 0) + 1);
    }
    if (ev.mutually_exclusive && ms.length > 1) {
      let sb = 0, sa = 0, ok = true;
      for (const m of ms) {
        const yb = num(m.yes_bid_dollars), ya = num(m.yes_ask_dollars);
        if (!Number.isFinite(yb) || !Number.isFinite(ya)) { ok = false; break; }
        sb += yb; sa += ya;
      }
      if (ok) sums.push({ t: ev.event_ticker, n: ms.length, sb: +sb.toFixed(4), sa: +sa.toFixed(4), cat: ev.category });
    }
  }

  console.log(`\nmulti-leg events: ${multi}   mutually_exclusive: ${mutex}   both: ${mutexMulti}`);
  console.log('\nstrike_type census:');
  for (const [k, v] of [...strikeTypes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(20)} ${v}`);
  console.log('\nnotional census:');
  for (const [k, v] of [...notional].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${String(k).padEnd(20)} ${v}`);

  const over = sums.filter(s => s.sb > 1).sort((a, b) => b.sb - a.sb);
  const under = sums.filter(s => s.sa < 1).sort((a, b) => a.sa - b.sa);
  console.log(`\nmutex events priced: ${sums.length}`);
  console.log(`  sum(yesBid) > 1  (sell-all-legs candidates): ${over.length}`);
  console.log(`  sum(yesAsk) < 1  (buy-all-legs candidates):  ${under.length}`);
  console.log('\ntop over-round:');
  for (const s of over.slice(0, 20)) console.log(`  +${((s.sb - 1) * 100).toFixed(1)}pt  ${s.t.padEnd(34)} legs ${String(s.n).padStart(3)}  ${s.cat}`);
  console.log('\ntop under-round:');
  for (const s of under.slice(0, 20)) console.log(`  +${((1 - s.sa) * 100).toFixed(1)}pt  ${s.t.padEnd(34)} legs ${String(s.n).padStart(3)}  ${s.cat}`);

  fs.writeFileSync(path.join(__dirname, 'census.json'), JSON.stringify({ at: Date.now(), events: evs.length, multi, mutex, mutexMulti, over, under }, null, 1));
  console.log('\n-> census.json');
})();
