#!/usr/bin/env node
'use strict';
/**
 * Audit the calibration gate's FORWARD record on the bot's own paper book.
 *
 * ── why this exists ──
 *
 * Four paper trades went 2W/2L for -$30.41 and the first question asked of them was "which gate
 * failed?". That question could not be answered. Entry timing and the ET session hours were on the
 * record, but the spread paid was not, so the 1.05c gate could only be INFERRED from the absence of
 * slippage. `record()` now persists the gate's own inputs; this reads them back and answers the
 * question directly.
 *
 * Two jobs, and the first matters more than the second:
 *
 *  1. COMPLIANCE. Every settled trade is checked against the gate that was validated — bucket in the
 *     active set, spread inside CAL_MAX_SPREAD_CENTS, entry inside the decide window, ET close hour
 *     not in the excluded set. A violation is a BUG and is reported as one. This is the part that is
 *     preventive: a gate that silently stops applying looks exactly like an edge that decayed, and
 *     without this check the two are indistinguishable from the P&L alone.
 *
 *  2. ATTRIBUTION. Per bucket, and per INDEPENDENT SETTLEMENT WINDOW. The unit matters enormously:
 *     signals arrive correlated (up to 7 coins can qualify in one 15-minute window, and a one-way
 *     regime is exactly when that happens), so N trades are not N independent observations. A
 *     7-win window is one event. Reporting per-trade confidence on correlated trades is how a small
 *     sample gets mistaken for evidence, in either direction.
 *
 * ── what this deliberately does NOT do ──
 *
 * It does not suggest a config change, rank coins, or search for a filter that would have avoided the
 * losses. That search was already run on 25,159 settled markets and every variant of it failed out of
 * sample: momentum into the decision, band position, volume, per-coin thresholds, hour-of-day ranking.
 * At an ~89% win rate the losses are the other 11% and they carry no signature. A filter fitted to
 * the handful of trades already in the book is curve-fitting with extra steps.
 *
 * Read-only. Opens no orders, touches no settings, writes nothing.
 */

const path = require('path');
const calibration = require('../src/calibration');
const { dayClusteredMeanCI } = require('./realtime-microstructure-evaluate');

const OWNER = process.env.AUDIT_USER || '384033277595484160';

/** Minutes-left window the gate is allowed to fire in, from the gate itself. */
const MIN_LEFT = calibration.CAL_DECIDE_MIN;
const MAX_LEFT = calibration.CAL_DECIDE_MAX;

const etHour = ms => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hour12: false
}).format(new Date(ms)));

const etDay = ms => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(ms));

/**
 * The settlement window a trade belongs to.
 *
 * Keyed on close time, NOT on entry time or coin: two coins settling in the same 15-minute round
 * share the move that decides them, so they are one observation and not two.
 */
function windowKey(p) {
  const ms = p.closeMs || Date.parse(p.closeTime || '') || null;
  if (!ms) return null;
  return new Date(Math.round(ms / 60000) * 60000).toISOString();
}

/** Settled calibration trades from a tenant's book, oldest first. */
function settledTrades(book) {
  const all = (book && book.positions) || [];
  return all
    .filter(p => p.strategy === 'CALIBRATION' && p.pnl != null && Number.isFinite(p.pnl))
    .sort((a, b) => (a.closeMs || 0) - (b.closeMs || 0));
}

/**
 * Check one trade against the validated gate.
 *
 * Returns the violations found. An empty array means the trade is provably compliant rather than
 * assumed compliant, which is the whole point.
 */
function violations(p) {
  const out = [];
  const active = calibration.CAL_BUCKETS.filter(b => b.enabled !== false).map(b => b.label);

  // A trade with no bucket predates the persistence fix. That is not a gate violation, but it must
  // never be silently counted as compliant either — it is simply unauditable.
  if (p.calBucket == null) return [{ kind: 'unauditable', detail: 'no calBucket on record (pre-fix trade)' }];

  if (!active.includes(p.calBucket)) {
    out.push({ kind: 'bucket', detail: `${p.calBucket} is not in the active set [${active.join(', ')}]` });
  }
  if (p.calSpreadCents == null) {
    out.push({ kind: 'spread-missing', detail: 'bucket recorded but spread was not' });
  } else if (p.calSpreadCents > calibration.CAL_MAX_SPREAD_CENTS + 1e-9) {
    out.push({ kind: 'spread', detail: `paid ${p.calSpreadCents.toFixed(2)}c > ${calibration.CAL_MAX_SPREAD_CENTS}c gate` });
  }
  if (p.minutesLeft != null && (p.minutesLeft < MIN_LEFT - 1e-9 || p.minutesLeft > MAX_LEFT + 1e-9)) {
    out.push({ kind: 'timing', detail: `fired at ${p.minutesLeft.toFixed(2)}m, outside [${MIN_LEFT}, ${MAX_LEFT}]` });
  }
  const closeMs = p.closeMs || Date.parse(p.closeTime || '') || null;
  if (closeMs && calibration.CAL_SKIP_ET_HOURS.includes(etHour(closeMs))) {
    out.push({ kind: 'session', detail: `close hour ${etHour(closeMs)} ET is in the excluded set` });
  }
  // Slippage beyond the grace allowance means the fill was worse than the gate permits.
  if (p.slippageCents != null && p.calGraceCents != null && p.slippageCents > p.calGraceCents + 1e-9) {
    out.push({ kind: 'grace', detail: `slipped ${p.slippageCents}c past the ${p.calGraceCents}c allowance` });
  }
  return out;
}

/** ROI on stake for one trade. Stake is what was actually risked, so cost, not notional. */
const roiOf = p => (p.cost > 0 ? p.pnl / p.cost : null);

function summarize(rows) {
  const n = rows.length;
  if (!n) return null;
  const wins = rows.filter(p => p.pnl > 0).length;
  const staked = rows.reduce((s, p) => s + (p.cost || 0), 0);
  const net = rows.reduce((s, p) => s + p.pnl, 0);
  const entries = rows.map(p => p.price).filter(Number.isFinite);
  const meanEntry = entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : null;
  return {
    n, wins, winPct: (wins / n) * 100,
    staked, net,
    roiPct: staked > 0 ? (net / staked) * 100 : null,
    meanEntry,
    // What the entry price implied, versus what actually happened. This is the bias being harvested,
    // measured forward instead of historically.
    impliedPct: meanEntry != null ? meanEntry * 100 : null,
    realizedMinusImpliedPp: meanEntry != null ? (wins / n) * 100 - meanEntry * 100 : null
  };
}

function fmtMoney(v) { return `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`; }
function fmtPct(v, d = 2) { return v == null ? '   n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`; }

function main() {
  const users = require('../src/users');
  users.init({ log: () => {} });
  const t = users.tenant(OWNER, { create: false });
  if (!t) { console.log(`no tenant ${OWNER}`); return; }

  const rows = settledTrades(t.rec.book);
  console.log('CALIBRATION FORWARD AUDIT');
  console.log('='.repeat(72));
  console.log(`book: ${OWNER}   settled calibration trades: ${rows.length}`);
  console.log(`gate: buckets [${calibration.CAL_BUCKETS.filter(b => b.enabled !== false).map(b => b.label).join(', ')}]`
    + `  spread <= ${calibration.CAL_MAX_SPREAD_CENTS}c  decide ${MIN_LEFT}-${MAX_LEFT}m`
    + `  skip ET ${JSON.stringify(calibration.CAL_SKIP_ET_HOURS)}`);
  console.log(`live money: CAL_LIVE_READY=${calibration.CAL_LIVE_READY}`);
  if (!rows.length) { console.log('\nnothing settled yet.'); return; }

  // ── 1. compliance ──
  console.log('\n1. GATE COMPLIANCE');
  console.log('-'.repeat(72));
  let bugs = 0, unauditable = 0;
  for (const p of rows) {
    const v = violations(p);
    if (!v.length) continue;
    if (v[0].kind === 'unauditable') { unauditable++; continue; }
    bugs++;
    console.log(`  !! ${p.sym} ${p.direction} @${p.priceCents}c ${String(p.closeTime || '').slice(11, 16)}`);
    for (const x of v) console.log(`       ${x.kind}: ${x.detail}`);
  }
  const auditable = rows.length - unauditable;
  if (bugs === 0 && auditable > 0) {
    console.log(`  ${auditable} of ${rows.length} trades provably compliant with every validated gate.`);
  } else if (bugs === 0) {
    // Not the same thing as compliant, and must never be printed as if it were: nothing was checked.
    console.log(`  NOTHING CHECKABLE — 0 of ${rows.length} trades carry the gate's inputs.`);
    console.log('     No violation was found because no violation COULD be found. Not a clean bill of health.');
  } else {
    console.log(`  ${bugs} TRADE(S) VIOLATED THE GATE — this is a bug, not variance. Fix before reading P&L.`);
  }
  if (unauditable) {
    console.log(`  ${unauditable} trade(s) predate the diagnostics fix and cannot be audited or attributed.`);
    console.log('     They still count in the overall figures below, but not in the per-bucket table.');
  }

  // ── 2. overall, on the honest unit ──
  const windows = new Map();
  for (const p of rows) {
    const k = windowKey(p) || `t${p.seq}`;
    if (!windows.has(k)) windows.set(k, []);
    windows.get(k).push(p);
  }
  const all = summarize(rows);
  console.log('\n2. OVERALL');
  console.log('-'.repeat(72));
  console.log(`  trades ${all.n}   independent settlement windows ${windows.size}`
    + `   correlation factor ${(all.n / windows.size).toFixed(2)}x`);
  console.log(`  ${all.wins}W/${all.n - all.wins}L = ${all.winPct.toFixed(1)}% win`
    + `   mean entry ${(all.meanEntry * 100).toFixed(1)}c`);
  console.log(`  staked $${all.staked.toFixed(2)}   net ${fmtMoney(all.net)}   ROI ${fmtPct(all.roiPct)}`);
  console.log(`  realized win% minus entry-implied: ${fmtPct(all.realizedMinusImpliedPp, 2).replace('%', 'pp')}`
    + '   (this is the bias, forward)');

  // Day-clustered CI on per-trade ROI. Clustering by settlement day is the same treatment the
  // historical estimate got, so the two numbers are comparable rather than merely adjacent.
  const byDay = new Map();
  for (const p of rows) {
    const ms = p.closeMs || Date.parse(p.closeTime || '') || null;
    const k = ms ? etDay(ms) : 'unknown';
    if (!byDay.has(k)) byDay.set(k, []);
    const r = roiOf(p);
    if (r != null) byDay.get(k).push(r);
  }
  console.log(`  settlement days: ${byDay.size}`);
  if (byDay.size >= 2) {
    try {
      const ci = dayClusteredMeanCI([...byDay.values()]);
      const lo = (ci.lo != null ? ci.lo : ci.lower) * 100;
      const hi = (ci.hi != null ? ci.hi : ci.upper) * 100;
      console.log(`  day-clustered 95% CI on ROI: [${fmtPct(lo)}, ${fmtPct(hi)}]`);
      console.log(lo > 0
        ? '  lower bound is ABOVE ZERO — this is the shape the live-money bar asks for.'
        : '  lower bound includes zero — NOT sufficient for live money. Keep CAL_LIVE_READY=false.');
    } catch (e) {
      console.log(`  day-clustered CI unavailable: ${e.message}`);
    }
  } else {
    console.log('  fewer than 2 settlement days — a day-clustered interval is not defined yet,');
    console.log('  so no forward interval exists and CAL_LIVE_READY must stay false.');
  }

  // ── 3. per bucket ──
  console.log('\n3. PER BUCKET  (the edge is measured over each bucket\'s OWN cost)');
  console.log('-'.repeat(72));
  const auditableRows = rows.filter(p => p.calBucket != null);
  if (!auditableRows.length) {
    console.log('  no trade carries a bucket yet — every settled trade predates the fix.');
  } else {
    console.log('  bucket      n   win%   entry   real-impl   staked      net      ROI   validated');
    for (const b of calibration.CAL_BUCKETS) {
      const mine = auditableRows.filter(p => p.calBucket === b.label);
      if (!mine.length) continue;
      const s = summarize(mine);
      console.log(`  ${b.label.padEnd(10)} ${String(s.n).padStart(3)}`
        + `  ${s.winPct.toFixed(1).padStart(5)}`
        + `  ${(s.meanEntry * 100).toFixed(1).padStart(5)}c`
        + `  ${fmtPct(s.realizedMinusImpliedPp, 1).replace('%', 'pp').padStart(9)}`
        + `  $${s.staked.toFixed(2).padStart(8)}`
        + `  ${fmtMoney(s.net).padStart(8)}`
        + `  ${fmtPct(s.roiPct, 1).padStart(7)}`
        + `   bias ${b.biasPp > 0 ? '+' : ''}${b.biasPp.toFixed(2)}pp / cost ${b.costPp.toFixed(2)}pp`);
    }
    // Deployment-vs-validation mismatch. The walk-forward ROI blends both buckets; if live signals only
    // ever land in one of them, the headline figure is not what this bot will earn.
    const seen = new Set(auditableRows.map(p => p.calBucket));
    const activeLabels = calibration.CAL_BUCKETS.filter(b => b.enabled !== false).map(b => b.label);
    const unused = activeLabels.filter(l => !seen.has(l));
    if (unused.length) {
      console.log(`\n  note: ${unused.join(', ')} enabled but never traded forward. The validated blended`);
      console.log('  ROI assumes both buckets contribute; if one never fires, it does not apply as quoted.');
    }
  }

  // ── 4. per settlement window ──
  console.log('\n4. PER SETTLEMENT WINDOW  (correlated trades are ONE observation)');
  console.log('-'.repeat(72));
  const wins = [...windows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let wWon = 0;
  for (const [k, ps] of wins) {
    const s = summarize(ps);
    if (s.net > 0) wWon++;
    const syms = ps.map(p => `${p.sym}${p.pnl > 0 ? '+' : '-'}`).join(' ');
    console.log(`  ${k.slice(5, 16).replace('T', ' ')}  ${String(ps.length).padStart(2)} trade(s)`
      + `  ${fmtMoney(s.net).padStart(8)}  ${fmtPct(s.roiPct, 1).padStart(7)}   ${syms}`);
  }
  console.log(`\n  windows net-positive: ${wWon}/${windows.size}`);
  if (windows.size < 20) {
    console.log(`  ${windows.size} independent windows is a small sample. At the validated ~87% win rate a`);
    console.log('  single trade moves a 4-trade ROI by roughly 25 points, so read direction, not magnitude.');
  }

  console.log('\n' + '='.repeat(72));
  if (bugs) console.log('VERDICT: gate violation present. Investigate the gate, not the strategy.');
  else if (auditable === 0) {
    console.log('VERDICT: unverifiable. No settled trade carries the gate\'s inputs, so compliance is');
    console.log('  unknown rather than confirmed. Re-run once trades settle on the current code.');
  } else if (byDay.size < 2) console.log('VERDICT: compliant, sample too small for any forward inference.');
  else console.log('VERDICT: compliant. Read the day-clustered interval above, not the raw ROI.');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

module.exports = { violations, windowKey, settledTrades, summarize, roiOf, etHour, etDay };
