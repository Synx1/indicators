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
  <button data-t=coins aria-selected=false>Coins<span class=count id=ccoin></span></button>
  <button data-t=trades aria-selected=false>Trades<span class=count id=ctra></span></button>
  <button data-t=hours aria-selected=false>Hours<span class=count id=chrs></span></button>
  <button data-t=gates aria-selected=false>Gates<span class=count id=cgat></span></button>
  <button data-t=setup aria-selected=false>Setup<span class=count id=cset></span></button>
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

<section id=s-coins><div id=coinbody></div>
  <div class=note><b>Which markets actually pay.</b> A four-day backtest ranked the coins
  (BNB the workhorse, ETH negative, XRP and HYPE at 100%) — but two of those numbers flipped sign
  when the entry gate changed, and the 100% ones were 7 and 9 trades. So this table is the real
  scoreboard: settled trades only, as they land. Read the <b>trust</b> column before the win rate.
  Nothing here is per-account — it is the fleet total, so it names nobody.</div>
</section>
<section id=s-trades><div id=trabody></div></section>
<section id=s-hours><div id=hrsbody></div></section>
<section id=s-gates><div id=gatbody></div>
  <div class=note><b>Do the gates earn their place?</b> Two assumptions are worth doubting. <b>Confirm</b>
  assumes more indicator agreement is better — nothing measured supports that, and four-of-four may
  simply mean the move is fully extended. <b>RSI</b> is the one lever that survived a chronological
  split: refusing a DOWN entry whose RSI is already deeply oversold dropped 14 backtest trades that
  went 8/14. Read <b>margin</b>, not the win rate: it is the win rate minus what the entry price
  already demands, so 68% at 64¢ is a <i>losing</i> bucket. Anything under ~30 settled trades cannot
  tell a gate from a run.</div>
</section>
<section id=s-setup><div id=setbody></div>
  <div class=note><b>What to set, and the arithmetic behind it.</b> Every row shows what you have,
  what it should be, and why — derived from measurements, not taste. Two rows are load-bearing:
  <b>Auto size</b>, because the default 30 contracts costs more than a small bankroll can re-bet after
  one loss, and <b>Risk per trade</b>, because the 25% default is close to full Kelly at the win rate
  the LIVE book is showing rather than the backtest's. Over-betting a real edge still loses.</div>
</section>
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
  ['decisions','coins','trades','hours','setup','accounts'].forEach(t =>
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
  MISS:   ['MISSED', 'pill loss'],
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
    '<span class="' + (m.on ? 'on' : '') + '">' + esc(m.sym) + '</span>').join('') + '</div>';

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

// The per-coin scoreboard. Reads /api/state, which is OPEN — these are fleet aggregates naming
// nobody, so this tab needs no token and stays visible like Decisions does.
//
// TRUST is rendered before the win rate on purpose. Every previous attempt to pick coins off this
// bot's numbers was defeated by sample size: two coins showed 100% on 7-9 backtest trades and one of
// them was a net LOSER under the previous gate. A win rate with no n beside it is the single most
// misleading number this page could print, so the n and its verdict come first.
const TRUST = {
  none: ['—', 'dim', 'no settled trades yet'],
  thin: ['thin', 'warn', 'under 10 trades — this win rate is not a measurement'],
  fair: ['fair', '', '10-29 trades — suggestive, not settled'],
  good: ['good', 'up', '30+ trades — enough to lean on']
};
function renderCoins(pub) {
  const rows = (pub && pub.coins) || [];
  const traded = rows.filter(c => c.n > 0);
  $('ccoin').textContent = traded.length ? traded.length : '';
  if (!rows.length) { $('coinbody').innerHTML = '<div class=empty>No market list yet.</div>'; return; }
  if (!traded.length) {
    $('coinbody').innerHTML = '<div class=empty>No settled trades yet — every coin below is armed ' +
      'and waiting. This table fills in as positions close.</div>' + coinTable(rows);
    return;
  }
  // Headline only from coins with a real sample; if none qualify, say so rather than crowning a
  // 2-trade coin the best market on the page.
  const solid = traded.filter(c => c.n >= 10);
  const head = solid.length
    ? (() => {
        const best = solid.reduce((a, b) => b.net > a.net ? b : a);
        const worst = solid.reduce((a, b) => b.net < a.net ? b : a);
        return 'On a real sample so far, best is <b class=up>' + esc(best.sym) + '</b> (' +
          signed(best.net) + ' on ' + best.n + ', ' + pct(best.hit) + ')' +
          (worst.sym === best.sym ? '' : ', worst is <b class=down>' + esc(worst.sym) + '</b> (' +
          signed(worst.net) + ' on ' + worst.n + ', ' + pct(worst.hit) + ')') + '.';
      })()
    : '<b class=warn>No coin has 10 settled trades yet</b>, so there is no best market to name — ' +
      'the rows below are early readings, not rankings.';
  $('coinbody').innerHTML = '<div class=note style="margin:0 0 14px">' + head + '</div>' + coinTable(rows);
}
function coinTable(rows) {
  const maxAbs = Math.max(1, ...rows.map(c => Math.abs(c.net)));
  const bar = n => { const w = (Math.abs(n) / maxAbs * 100).toFixed(1);
    return '<span style="display:flex;height:8px;background:#171a21;border-radius:3px;overflow:hidden;justify-content:' +
      (n < 0 ? 'flex-end' : 'flex-start') + '"><span style="display:block;height:100%;min-width:2px;border-radius:3px;width:' +
      w + '%;background:' + (n < 0 ? 'var(--down)' : 'var(--up)') + '"></span></span>'; };
  return '<table><thead><tr><th>coin</th><th></th><th class=num>settled</th><th class=num>W / L</th>' +
    '<th class=num>win%</th><th class=num>net P&L</th><th class=num>per trade</th>' +
    '<th class=num>open</th><th>trust</th><th style="width:22%">net</th></tr></thead><tbody>' +
    rows.map(c => {
      const t = TRUST[c.trust] || TRUST.none;
      return '<tr><td class=sym>' + esc(c.sym) + '</td>' +
        '<td>' + (c.on ? '' : '<span class=pill>off</span>') + '</td>' +
        '<td class=num>' + c.n + (c.live ? '<div class="faint" style="font-size:11px">' + c.live + ' live</div>' : '') + '</td>' +
        '<td class=num>' + (c.n ? c.wins + ' / ' + c.losses : '—') + '</td>' +
        '<td class=num>' + (c.n ? pct(c.hit) : '—') + '</td>' +
        '<td class="num ' + cls(c.net) + '">' + (c.n ? signed(c.net) : '—') + '</td>' +
        '<td class="num ' + cls(c.per) + '">' + (c.n ? signed(c.per) : '—') + '</td>' +
        '<td class=num>' + (c.open || '—') + '</td>' +
        '<td><span class="' + (t[1] ? t[1] : 'dim') + '" title="' + esc(t[2]) + '">' + t[0] + '</span>' +
        (c.lastAt ? '<div class=faint style="font-size:11px">' + ago(c.lastAt) + '</div>' : '') + '</td>' +
        '<td>' + (c.n ? bar(c.net) : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderGates(d) {
  const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
  // Margin is the number that matters and it is signed, so it gets the colour. A positive win rate
  // with a negative margin is the exact mistake this tab exists to make visible.
  const marg = v => v == null ? '<td class=dim>—</td>'
    : '<td class=' + (v >= 0 ? 'win' : 'loss') + '>' + (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'pt</td>';
  const row = b => '<tr><td>' + esc(b.label) + '</td><td class=' + (b.taken < 30 ? 'dim' : '') + '>' + b.taken +
    '</td><td>' + (b.taken ? b.wins : '—') + '</td><td>' + pct(b.rate) + '</td><td class=dim>' + pct(b.needRate) +
    '</td>' + marg(b.margin) + '<td class=' + (b.net >= 0 ? 'win' : 'loss') + '>' +
    (b.net >= 0 ? '+' : '') + '$' + Math.abs(b.net).toFixed(2) + '</td></tr>';
  const table = (title, rows) => '<h3>' + esc(title) + '</h3><table><thead><tr><th>bucket</th><th>taken</th>' +
    '<th>won</th><th>rate</th><th>needs</th><th>margin</th><th>net</th></tr></thead><tbody>' +
    rows.map(row).join('') + '</tbody></table>';
  $('gatbody').innerHTML =
    (d.settled ? '' : '<div class=note>No settled trades yet — nothing to judge.</div>') +
    table('Overall', [d.overall]) +
    table('By indicator agreement', d.byConfirm) +
    table('By RSI stretch' + (d.withRsi < d.settled ? ' (' + (d.settled - d.withRsi) + ' older trades carry no RSI)' : ''), d.byRsi) +
    table('By direction', d.byDirection);
  $('cgat').textContent = d.settled || '';
}

const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM';function renderHours(d) {
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

// The setup sheet. Private, because the "now" column is one account's configuration.
//
// Severity drives colour, but the ✓/✗ column drives the READ: the whole point of a setup sheet is
// that it can be scanned in one pass, so a settled row must be visibly settled rather than merely
// un-highlighted. Rows arrive in declaration order (sizing, then risk, then exits, then execution),
// which is the order they should be set in — NOT sorted by severity, because re-ordering on refresh
// would make a page that reads as new information arriving every five seconds.
const SEV = { high: ['must fix', 'down'], warn: ['should fix', 'warn'], note: ['fine', 'dim'] };
// The shadow book, rendered above the settings it informs.
//
// This is the answer to "should the ceiling go up", and it is the only out-of-sample evidence that
// exists on the question: the live book contains nothing above 65c by construction, so a backtest and
// an assumption were the only things available before this. The "enough" flag gates the verdict on
// purpose: under 20 settled trades a band's win rate is not a measurement, and reading one as though
// it were is the mistake that has cost this bot the most.
function shadowBlock(pub) {
  const sh = pub && pub.shadow;
  if (!sh || !sh.bands || !sh.bands.length) return '';
  if (!sh.total) {
    return '<div class=note style="margin:0 0 18px"><b>Shadow book: nothing recorded yet.</b> ' +
      'Every round that clears the whole gate but is refused for price alone gets logged here and ' +
      'graded at settlement, so the question "does the edge hold above ' + pct(sh.liveCeiling) +
      '?" becomes a measurement instead of an argument. It risks nothing.</div>';
  }
  const rows = sh.bands.map(b => {
    const verdict = !b.enough
      ? '<span class=faint>needs ' + (sh.minSample - b.n) + ' more</span>'
      : b.margin > 0.05 ? '<b class=up>edge holds</b>'
        : b.margin > 0 ? '<span class=warn>thin</span>'
          : '<b class=down>would have lost</b>';
    return '<tr><td class=sym>' + esc(b.band) + '</td>' +
      '<td class=num>' + b.n + (b.pending ? '<div class="faint" style="font-size:11px">' + b.pending + ' open</div>' : '') + '</td>' +
      '<td class=num>' + (b.n ? b.wins + ' / ' + b.losses : '—') + '</td>' +
      '<td class=num>' + (b.hit == null ? '—' : pct(b.hit)) + '</td>' +
      '<td class=num>' + (b.avgEntry == null ? '—' : pct(b.avgEntry)) + '</td>' +
      '<td class="num ' + cls(b.margin) + '">' + (b.margin == null ? '—' : (b.margin * 100).toFixed(1) + 'pp') + '</td>' +
      '<td>' + verdict + '</td></tr>';
  }).join('');
  return '<div class=note style="margin:0 0 12px"><b>Shadow book — what the bot would have earned ' +
    'above its own ' + pct(sh.liveCeiling) + ' ceiling.</b> ' + sh.settled + ' settled, ' + sh.pending +
    ' still open. These trades were never taken and risked nothing; they are the only out-of-sample ' +
    'read on whether raising the ceiling is worth it. <b>margin</b> is win% minus average entry — on a ' +
    'binary that IS the edge per contract, because breakeven equals the price you paid.</div>' +
    '<table style="margin-bottom:22px"><thead><tr><th>band</th><th class=num>settled</th>' +
    '<th class=num>W / L</th><th class=num>win%</th><th class=num>avg entry</th>' +
    '<th class=num>margin</th><th>verdict</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderSetup(d, pub) {
  if (d.locked) { $('setbody').innerHTML = lockedBox('Your settings and bankroll are account data'); return; }
  const accs = d.accounts || [];
  const attention = accs.reduce((a, x) => a + (x.attention || 0), 0);
  $('cset').textContent = attention ? attention : '';
  const shadowHtml = shadowBlock(pub);
  if (!accs.length) { $('setbody').innerHTML = shadowHtml + '<div class=empty>No accounts yet.</div>'; return; }
  $('setbody').innerHTML = shadowHtml + accs.map(a => {
    const s = a.summary;
    const head = '<div class=note style="margin:0 0 14px"><b>' + esc(a.who) + '</b> ' +
      '<span class="pill ' + (a.live ? (a.armed ? 'live' : '') : 'paper') + '">' +
      (a.live ? (a.armed ? 'armed' : 'live, not armed') : 'paper') + '</span> · bankroll ' +
      (a.bankroll == null ? '<span class=warn>not set</span>' : money(a.bankroll)) + ' · ' +
      (a.attention
        ? '<b class=down>' + a.attention + ' setting' + (a.attention === 1 ? '' : 's') + ' to change</b>'
        : '<b class=up>all settings look right</b>') + '</div>';
    // What the recommendation COSTS, in dollars. A sheet of safer numbers with no visible price is
    // how a conservative recommendation gets ignored — so the per-night arithmetic sits beside it.
    const box = !s ? '' : (s.tooSmall
      ? '<div class=locked style="margin:0 0 16px"><b>' + esc(s.note) + '</b></div>'
      : '<div class=hero style="margin:0 0 18px">' + [
          ['At recommended size', s.shares + ' contracts', '', money(s.cost) + ' per position'],
          ['A win pays', signed(s.win), 'up', 'a loss costs ' + signed(s.loss)],
          ['Per night, backtest', signed(s.nightly.backtest), cls(s.nightly.backtest),
            s.tradesPerNight + ' trades at ' + pct(0.839)],
          ['Per night, live rate', signed(s.nightly.live), cls(s.nightly.live),
            'at the ' + pct(0.73) + ' the live book shows']
        ].map(c => '<div class=cell><div class=k>' + c[0] + '</div><div class="v ' + c[2] + '">' +
          c[1] + '</div><div class=s>' + esc(c[3]) + '</div></div>').join('') + '</div>' +
        '<div class=note style="margin:-4px 0 16px">' + esc(s.note) + '</div>');
    const table = '<table><thead><tr><th>setting</th><th>now</th><th>recommended</th>' +
      '<th></th><th style="width:46%">why</th></tr></thead><tbody>' +
      (a.rows || []).map(r => {
        const sv = SEV[r.severity] || SEV.note;
        return '<tr><td class=sym>' + esc(r.label) + '</td>' +
          '<td class="' + (r.ok ? 'dim' : sv[1]) + '">' + esc(r.current) + '</td>' +
          '<td><b>' + esc(r.recommended) + '</b></td>' +
          '<td class=num>' + (r.ok
            ? '<span class=up title="already right">✓</span>'
            : '<span class="' + sv[1] + '" title="' + sv[0] + '">✗</span>') + '</td>' +
          '<td class=why>' + esc(r.why) +
          (r.note ? '<div class=faint style="font-size:11px;margin-top:3px">' + esc(r.note) + '</div>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table>';
    return head + box + table + '<div style="height:26px"></div>';
  }).join('');
}

function renderAccounts(d) {  if (d.locked) { $('accbody').innerHTML = lockedBox('Account P&L is per-person money'); return; }
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
        '<td class="num ' + cls((a.today || {}).net) + '">' + signed((a.today || {}).net) + '</td>' +
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
  if (tab === 'coins')     { if (pub) renderCoins(pub); }
  if (tab === 'trades')    { const d = await get('/api/trades');    if (d) renderTrades(d); }
  if (tab === 'hours')     { const d = await get('/api/hours');     if (d) renderHours(d); }
  if (tab === 'gates')     { const d = await get('/api/gates');     if (d) renderGates(d); }
  if (tab === 'setup')     { const d = await get('/api/recommend'); if (d) renderSetup(d, pub); }
  if (tab === 'accounts')  { const d = await get('/api/accounts');  if (d) renderAccounts(d); }
}

refresh();
// Every 5s. The underlying data cannot change faster than the 20s scan, so polling harder would
// only cost the trading process CPU for no new information.
setInterval(refresh, 5000);
</script>
</div></body></html>`;
};
