/**
 * The site's single page. One file, no build step, no CDN.
 *
 * ── why no framework and no CDN ──
 *
 * The bot has to keep trading if a CDN is slow or blocked, and a build step is a way for the
 * deployed page to drift from the source in the repo. Everything here is inline: one stylesheet,
 * one script, no dependencies. The whole page is smaller than a single charting library.
 *
 * ── the design, and why it is not decoration ──
 *
 * Numbers are the content, so they get a monospaced tabular font and right alignment — a column of
 * figures that does not line up cannot be scanned, which is most of why the old panel read badly.
 * Colour carries exactly one meaning (green made money, red lost it) and is never used for
 * emphasis, so a red number always means the same thing.
 *
 * The Decisions tab is the point of the whole page: it shows the SKIPS as well as the fills.
 * A list of fills says what happened; the skips say what the gate is doing, which on a bot that
 * declines most rounds is nearly all of what there is to understand.
 */

module.exports = function page() {
  return `<!doctype html><html lang=en><head>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Indicators</title>
<style>
:root{
  --bg:#0a0b0e; --panel:#12141a; --line:#1e222b; --line2:#2a2f3a;
  --tx:#e7e9ee; --dim:#8b91a1; --faint:#5a6070;
  --up:#3ddc84; --down:#ff6b6b; --warn:#ffc857; --accent:#7aa2ff;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 80px}

header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:22px}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);display:inline-block}
.dot.ok{background:var(--up);box-shadow:0 0 0 3px rgba(61,220,132,.15)}
.dot.bad{background:var(--down);box-shadow:0 0 0 3px rgba(255,107,107,.15)}
.sub{color:var(--dim);font-size:13px}
.sub b{color:var(--tx);font-weight:550}

/* hero */
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;
  margin-bottom:22px}
.cell{background:var(--panel);padding:16px 18px}
.cell .k{color:var(--dim);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  font-weight:600}
.cell .v{font-family:var(--mono);font-size:24px;font-weight:600;margin-top:6px;letter-spacing:-.02em}
.cell .s{color:var(--faint);font-size:12px;margin-top:3px}

/* tabs */
nav{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:18px}
nav button{background:none;border:0;color:var(--dim);font:inherit;font-size:14px;font-weight:550;
  padding:10px 15px;cursor:pointer;border-bottom:2px solid transparent;transition:color .12s}
nav button:hover{color:var(--tx)}
nav button[aria-selected=true]{color:var(--tx);border-bottom-color:var(--accent)}
nav .count{color:var(--faint);font-size:12px;margin-left:5px;font-family:var(--mono)}

section{display:none}
section.on{display:block}

/* tables */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--dim);font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  font-weight:600;padding:0 10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:hover{background:#15171e}
.num{font-family:var(--mono);text-align:right;white-space:nowrap}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}.dim{color:var(--dim)}
.faint{color:var(--faint)}
.sym{font-weight:600}
.pill{display:inline-block;font-size:10.5px;font-weight:650;letter-spacing:.04em;
  padding:2px 7px;border-radius:5px;background:#1c2029;color:var(--dim);text-transform:uppercase}
.pill.win{background:rgba(61,220,132,.13);color:var(--up)}
.pill.loss{background:rgba(255,107,107,.13);color:var(--down)}
.pill.open{background:rgba(122,162,255,.13);color:var(--accent)}
.pill.live{background:rgba(255,107,107,.13);color:var(--down)}
.pill.paper{background:#1c2029;color:var(--dim)}
.why{color:var(--dim);font-size:12.5px;line-height:1.45}
.mkt{display:flex;gap:6px;flex-wrap:wrap}
.mkt span{font-family:var(--mono);font-size:12px;padding:3px 8px;border-radius:5px;
  background:#1c2029;color:var(--faint)}
.mkt span.on{background:rgba(61,220,132,.12);color:var(--up)}
.note{color:var(--faint);font-size:12.5px;line-height:1.6;margin-top:14px;max-width:74ch}
.empty{color:var(--faint);padding:26px 10px;font-size:13.5px}
.bars{display:grid;grid-template-columns:auto 1fr auto;gap:5px 12px;align-items:center;
  font-size:13px;margin-top:4px}
.bars .lbl{color:var(--dim)}
.bars .track{height:7px;background:#171a21;border-radius:3px;overflow:hidden}
.bars .fill{display:block;height:100%;min-width:2px;background:var(--accent);opacity:.8;border-radius:3px}
.bars .n{font-family:var(--mono);color:var(--faint);font-size:12px;text-align:right}
.locked{border:1px dashed var(--line2);border-radius:10px;padding:20px;color:var(--dim);
  font-size:13.5px;line-height:1.6}
.locked code{font-family:var(--mono);background:#1c2029;padding:1px 6px;border-radius:4px;
  color:var(--warn)}
@media(max-width:640px){.wrap{padding:18px 13px 60px}.cell .v{font-size:20px}
  th,td{padding-left:7px;padding-right:7px}}
</style></head><body><div class=wrap>

<header>
  <h1>Indicators</h1>
  <span class=sub><span class="dot" id=hdot></span> <span id=hstat>connecting…</span></span>
  <span class=sub style="margin-left:auto" id=hasof></span>
</header>

<div class=hero id=hero></div>

<nav id=tabs>
  <button data-t=decisions aria-selected=true>Decisions<span class=count id=cdec></span></button>
  <button data-t=trades aria-selected=false>Trades<span class=count id=ctra></span></button>
  <button data-t=hours aria-selected=false>Hours<span class=count id=chrs></span></button>
  <button data-t=accounts aria-selected=false>Accounts<span class=count id=cacc></span></button>
</nav>

<section id=s-decisions class=on>
  <div id=decbody></div>
  <div class=note><b>This tab is the point of the page.</b> It shows what the bot decided every
  pass, including the rounds it <em>declined</em> — a list of fills tells you what happened, but
  the skips tell you what the gate is doing, which on a bot that passes on most rounds is nearly
  all there is to understand. Each row carries the numbers the decision was made on, so it can be
  audited rather than taken on trust.</div>
</section>

<section id=s-trades><div id=trabody></div></section>
<section id=s-hours><div id=hrsbody></div></section>
<section id=s-accounts><div id=accbody></div></section>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
const q = KEY ? '?key=' + encodeURIComponent(KEY) : '';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2));
const signed = n => (n == null ? '—' : (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(2));
const cls = n => (n == null ? 'dim' : n > 0 ? 'up' : n < 0 ? 'down' : 'dim');
const pct = n => (n == null ? '—' : (n * 100).toFixed(0) + '%');
const ago = ms => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
};
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let tab = 'decisions';
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  tab = b.dataset.t;
  [...$('tabs').querySelectorAll('button')].forEach(x =>
    x.setAttribute('aria-selected', String(x.dataset.t === tab)));
  ['decisions','trades','hours','accounts'].forEach(t =>
    $('s-' + t).classList.toggle('on', t === tab));
  refresh();
});

function heroCells(d) {
  const f = d.fleet, sc = d.scanner;
  // Live first and on its own, because it is the only row that is real money. A single pooled
  // "Net" let a good paper run stand in for a live book that had never traded — the same mislabel
  // the Discord panel had, where today's paper figure sat above an all-time live one.
  const lv = d.live || { net: 0, closed: 0, today: 0, dayHigh: 0 };
  const pp = d.paper || { net: 0, closed: 0, today: 0, dayHigh: 0 };
  // Directional health: this book is a structural short, so the DOWN side's recent hit rate is the
  // earliest warning that a rally has turned the edge — it moves before the total does.
  const dr = d.direction || { open: { up: 0, down: 0 }, up: {}, down: {} };
  const dHit = dr.down && dr.down.recentHit != null ? pct(dr.down.recentHit) : '—';
  return [
    ['Live P&L', signed(lv.net), cls(lv.net),
      lv.closed ? lv.closed + ' closed · today ' + signed(lv.today) : 'no live trades yet'],
    ['Live day high', money(lv.dayHigh), 'dim',
      lv.today || lv.closed ? 'best equity today' : 'nothing closed today'],
    ['Paper P&L', signed(pp.net), cls(pp.net),
      pp.closed ? pp.closed + ' closed · today ' + signed(pp.today) : 'no paper trades yet'],
    ['Paper day high', money(pp.dayHigh), 'dim', 'best equity today'],
    ['Win rate', f.closed ? pct(f.hit) : '—', '', f.closed ? f.wins + 'W / ' + f.losses + 'L' : 'no trades yet'],
    ['Open', String(f.open), '', f.atRisk ? money(f.atRisk) + ' at risk' : 'nothing at risk'],
    ['Direction now', (dr.open.down || 0) + '↓ / ' + (dr.open.up || 0) + '↑', '',
      'open exposure by side'],
    ['DOWN book', dHit, dr.warn ? 'down' : '',
      dr.down && dr.down.recentN ? 'last ' + dr.down.recentN + (dr.warn ? ' · tilt turning' : ' · structural side') : 'no DOWN trades yet'],
    ['Fees', money(f.fees), 'dim', 'paid to Kalshi'],
    ['Accounts', String(f.accounts), '', d.killed ? 'HALTED' : (sc.healthy ? 'scanning' : 'scanner quiet')],
    ['Signals', String(sc.decisions), '', sc.entries + ' filled · ' + sc.passes + ' passes']
  ].map(c => '<div class=cell><div class=k>' + c[0] + '</div><div class="v ' + c[2] + '">' +
    c[1] + '</div><div class=s>' + esc(c[3]) + '</div></div>').join('');
}

const KIND = {
  TAKEN:  ['SIGNAL', 'pill open'],
  EXIT:   ['FILLED', 'pill win'],
  SETTLE: ['CLOSED', 'pill'],
  SKIP:   ['SKIPPED', 'pill'],
  ERROR:  ['ERROR', 'pill loss']
};

function renderDecisions(d, pub) {
  $('cdec').textContent = d.events.length ? d.events.length : '';
  const counts = Object.entries(d.counts || {});
  const top = counts.slice(0, 6);
  const max = Math.max(1, ...top.map(c => c[1]));
  const bars = top.length ? '<div class=bars>' + top.map(([k, v]) =>
    '<span class=lbl>' + esc(k) + '</span>' +
    '<span class=track><span class=fill style="width:' + (v / max * 100).toFixed(1) + '%"></span></span>' +
    '<span class=n>' + v + '</span>').join('') + '</div>' : '';

  const mk = '<div class=mkt style="margin-bottom:16px">' + pub.markets.map(m =>
    '<span class="' + (m.on ? 'on' : '') + '">' + m.sym + '</span>').join('') + '</div>';

  if (!d.events.length) {
    $('decbody').innerHTML = mk + '<div class=empty>Nothing decided yet — the first pass runs within 20 seconds of startup.</div>';
    return;
  }
  $('decbody').innerHTML = mk +
    (bars ? '<div class=note style="margin:0 0 16px"><b>Why rounds were declined</b></div>' + bars + '<div style="height:20px"></div>' : '') +
    '<table><thead><tr><th>when</th><th>market</th><th></th><th>what happened</th><th class=num>conf</th><th class=num>ind</th></tr></thead><tbody>' +
    d.events.map(e => {
      const k = KIND[e.kind] || ['—', 'pill'];
      const m = e.meta || {};
      return '<tr><td class=faint style="white-space:nowrap">' + clock(e.at) +
        '<div class=faint style="font-size:11px">' + ago(e.at) + '</div></td>' +
        '<td class=sym>' + esc(e.sym || '—') +
        (m.direction ? ' <span class=faint>' + (m.direction === 'UP' ? '▲' : '▼') + '</span>' : '') + '</td>' +
        '<td><span class="' + k[1] + '">' + k[0] + '</span></td>' +
        '<td class=why>' + esc(e.detail) +
        (m.spotAgeMs != null ? '<div class=faint style="font-size:11px">spot ' +
          (m.spotAgeMs / 1000).toFixed(1) + 's old · ' + (m.minutesLeft != null ? m.minutesLeft + 'm to close' : '') + '</div>' : '') +
        '</td>' +
        '<td class="num dim">' + (m.confidence != null ? m.confidence + '%' : '') + '</td>' +
        '<td class="num dim">' + (m.confirm != null ? m.confirm + '/4' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderTrades(d) {
  if (d.locked) { $('trabody').innerHTML = lockedBox('Trades name the account that took them'); return; }
  $('ctra').textContent = d.trades.length ? d.trades.length : '';
  if (!d.trades.length) { $('trabody').innerHTML = '<div class=empty>No positions yet.</div>'; return; }
  $('trabody').innerHTML =
    '<table><thead><tr><th>when</th><th>market</th><th>account</th><th></th>' +
    '<th class=num>size</th><th class=num>entry</th><th class=num>exit</th>' +
    '<th class=num>fees</th><th class=num>P&L</th><th>read</th></tr></thead><tbody>' +
    d.trades.map(t => {
      const p = t.outcome === 'OPEN' ? 'pill open' : t.outcome === 'WIN' ? 'pill win'
        : t.outcome === 'LOSS' ? 'pill loss' : 'pill';
      const when = t.exitAt || t.at;
      return '<tr><td class=faint style="white-space:nowrap">' + clock(new Date(when).getTime()) +
        '<div class=faint style="font-size:11px">' + ago(new Date(when).getTime()) + '</div></td>' +
        '<td class=sym>' + esc(t.sym) + ' <span class=faint>' + (t.direction === 'UP' ? '▲' : '▼') + '</span></td>' +
        '<td class=dim>' + esc(t.who) + ' <span class="pill ' + (t.live ? 'live' : 'paper') + '">' +
          (t.live ? 'live' : 'paper') + '</span></td>' +
        '<td><span class="' + p + '">' + esc(t.outcome) + '</span></td>' +
        '<td class=num>' + t.contracts + '</td>' +
        '<td class=num>' + t.priceCents + '¢</td>' +
        '<td class=num>' + (t.exitCents == null ? '—' : t.exitCents + '¢') + '</td>' +
        '<td class="num faint">' + money(t.fees) + '</td>' +
        '<td class="num ' + cls(t.pnl) + '">' + (t.pnl == null ? '—' : signed(t.pnl)) + '</td>' +
        '<td class=why>' + (t.style === 'DIP' ? 'bought a dip' : 'chased a move') +
        '<div class=faint style="font-size:11px">' + (t.confidence || '—') + '% · ' +
        (t.confirm == null ? '—' : t.confirm + '/4') + '</div></td></tr>';
    }).join('') + '</tbody></table>';
}

const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM';
function renderHours(d) {
  if (d.locked) { $('hrsbody').innerHTML = lockedBox('Hourly P&L is account money'); return; }
  $('chrs').textContent = d.totalClosed ? d.totalClosed : '';
  const rows = (d.hours || []).filter(h => h.taken > 0);
  if (!rows.length) { $('hrsbody').innerHTML = '<div class=empty>No settled trades yet — the hourly breakdown fills in as positions close.</div>'; return; }
  const maxAbs = Math.max(1, ...rows.map(h => Math.abs(h.net)));
  // "best time" headline needs a floor on sample size so a lucky 1-trade hour can't win it
  const solid = rows.filter(h => h.taken >= 3);
  const best = (solid.length ? solid : rows).reduce((a, b) => b.net > a.net ? b : a);
  const worst = (solid.length ? solid : rows).reduce((a, b) => b.net < a.net ? b : a);
  const bar = n => { const w = (Math.abs(n) / maxAbs * 100).toFixed(1);
    return '<span style="display:flex;height:8px;background:#171a21;border-radius:3px;overflow:hidden;justify-content:' +
      (n < 0 ? 'flex-end' : 'flex-start') + '"><span style="display:block;height:100%;min-width:2px;border-radius:3px;width:' +
      w + '%;background:' + (n < 0 ? 'var(--down)' : 'var(--up)') + '"></span></span>'; };
  $('hrsbody').innerHTML =
    '<div class=note style="margin:0 0 14px"><b>Best time to trade — profit by the ET hour a position was opened.</b> ' +
    'Best so far: <b class=up>' + hourLabel(best.hour) + '</b> (' + signed(best.net) + ' on ' + best.taken + '), ' +
    'worst: <b class=down>' + hourLabel(worst.hour) + '</b> (' + signed(worst.net) + ' on ' + worst.taken + '). ' +
    'Read the <b>taken</b> column — a few days of data makes thin hours noisy, so a big number on 2 trades is luck, not a pattern.</div>' +
    '<table><thead><tr><th>hour (ET)</th><th class=num>taken</th><th class=num>W / L</th>' +
    '<th class=num>win%</th><th class=num>net P&L</th><th style="width:34%">by hour</th></tr></thead><tbody>' +
    rows.map(h => '<tr><td class=sym>' + hourLabel(h.hour) + '</td>' +
      '<td class=num>' + h.taken + '</td>' +
      '<td class=num>' + h.wins + ' / ' + h.losses + '</td>' +
      '<td class=num>' + (h.taken ? pct(h.hit) : '—') + '</td>' +
      '<td class="num ' + cls(h.net) + '">' + signed(h.net) + '</td>' +
      '<td>' + bar(h.net) + '</td></tr>').join('') + '</tbody></table>';
}

function renderAccounts(d) {
  if (d.locked) { $('accbody').innerHTML = lockedBox('Account P&L is per-person money'); return; }
  $('cacc').textContent = d.accounts.length ? d.accounts.length : '';
  if (!d.accounts.length) { $('accbody').innerHTML = '<div class=empty>No accounts yet.</div>'; return; }
  $('accbody').innerHTML =
    '<table><thead><tr><th>account</th><th></th><th class=num>equity</th><th class=num>started</th>' +
    '<th class=num>realised</th><th class=num>peak</th><th class=num>today</th>' +
    '<th class=num>closed</th><th class=num>win%</th><th class=num>open</th></tr></thead><tbody>' +
    d.accounts.map(a => {
      const state = a.live ? (a.armed ? '<span class="pill live">armed</span>' : '<span class=pill>live</span>')
        : '<span class="pill paper">paper</span>';
      return '<tr><td class=sym>' + esc(a.who) + '</td><td>' + state + '</td>' +
        '<td class="num ' + cls(a.realised) + '">' + money(a.equity) + '</td>' +
        '<td class="num faint">' + money(a.start) + '</td>' +
        '<td class="num ' + cls(a.realised) + '">' + signed(a.realised) + '</td>' +
        '<td class=num>' + money(a.peak) +
          (a.fromPeak > 0.005 ? '<div class="faint" style="font-size:11px">-' + a.fromPeak.toFixed(2) + ' off</div>' : '') + '</td>' +
        '<td class="num ' + cls(a.today.net) + '">' + signed(a.today.net) + '</td>' +
        '<td class=num>' + a.closed + '</td>' +
        '<td class=num>' + (a.closed ? pct(a.hit) : '—') + '</td>' +
        '<td class=num>' + a.open + (a.atRisk ? '<div class="faint" style="font-size:11px">' + money(a.atRisk) + '</div>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function lockedBox(what) {
  return '<div class=locked><b>' + esc(what) + ', so this tab is private.</b><br><br>' +
    'Set <code>WEB_TOKEN</code> on the service and open this page with <code>?key=YOUR_TOKEN</code>. ' +
    'The Decisions tab stays open either way — it describes what the bot decided, which names nobody.</div>';
}

async function get(path) {
  try {
    const r = await fetch(path + q);
    if (r.status === 401) return { locked: true };
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

let pub = null;
async function refresh() {
  const s = await get('/api/state');
  if (s) {
    pub = s;
    $('hero').innerHTML = heroCells(s);
    const sc = s.scanner;
    $('hdot').className = 'dot ' + (s.killed ? 'bad' : sc.healthy ? 'ok' : 'bad');
    $('hstat').innerHTML = s.killed
      ? '<b class=down>halted — kill switch on</b>'
      : sc.healthy
        ? 'scanning · last pass <b>' + sc.ageSec + 's</b> ago'
        : (sc.lastPass ? '<b class=warn>scanner quiet — last pass ' + sc.ageSec + 's ago</b>' : 'starting…');
    $('hasof').textContent = 'updated ' + new Date(s.asOf).toLocaleTimeString();
  }
  if (tab === 'decisions') { const d = await get('/api/decisions'); if (d && pub) renderDecisions(d, pub); }
  if (tab === 'trades')    { const d = await get('/api/trades');    if (d) renderTrades(d); }
  if (tab === 'hours')     { const d = await get('/api/hours');     if (d) renderHours(d); }
  if (tab === 'accounts')  { const d = await get('/api/accounts');  if (d) renderAccounts(d); }
}

refresh();
// Every 5s. The underlying data cannot change faster than the 20s scan, so polling harder would
// only cost the trading process CPU for no new information.
setInterval(refresh, 5000);
</script>
</div></body></html>`;
};
