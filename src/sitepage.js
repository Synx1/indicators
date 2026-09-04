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
/* ── tokens ──
   Colour carries exactly two meanings and they are kept apart. AMBER is liveness: the heartbeat, the
   playhead, a coin sitting in the entry band. GREEN and RED are money and nothing else. The old sheet
   used green for both "scanner healthy" and "made a profit", so a green dot and a green number meant
   unrelated things and the eye had to read the label to know which. */
:root{
  --ground:#0b1017; --raised:#141b28; --raised2:#1a2333; --sunk:#080c12;
  --rule:#1f2939; --rule2:#2c3a52;
  --tx:#e6ebf5; --muted:#8b95a8; --faint:#5d6779;
  --live:#f2a63b; --gain:#46d391; --loss:#f2695f;
  --up:#46d391; --down:#f2695f; --warn:#f2a63b; --accent:#7fa6ff;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --r:12px;
  /* Depth comes from ONE shared shadow plus a hairline rather than a border colour per block.
     Competing border colours are what made the surfaces read as separate patches. */
  --lift:0 1px 2px rgba(0,0,0,.32), 0 8px 24px -12px rgba(0,0,0,.5);
  --hair:inset 0 0 0 1px rgba(255,255,255,.045);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-gutter:stable}
body{background:var(--ground);color:var(--tx);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;
  text-rendering:optimizeLegibility}
.wrap{max-width:1080px;margin:0 auto;padding:26px 20px 90px}
b,strong{font-weight:600}

/* ── header ── */
header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}
h1{font-size:19px;font-weight:640;letter-spacing:-.015em}
.sub{color:var(--muted);font-size:13px}
.sub b{color:var(--tx);font-weight:560}
.hstats{margin-left:auto;display:flex;gap:22px;align-items:baseline;
  font-size:12px;color:var(--faint)}
.hstats span b{font-family:var(--mono);color:var(--muted);font-weight:500}

/* The heartbeat. It pulses once per completed pass and holds steady between — a dot that blinks on a
   timer would look alive even after the loop stopped, which is the one thing it must never do. */
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint);display:inline-block;
  vertical-align:-1px}
.dot.ok{background:var(--live)}
.dot.bad{background:var(--loss);box-shadow:0 0 0 3px rgba(242,105,95,.16)}
.dot.beat{animation:beat .5s ease-out}
@keyframes beat{
  from{box-shadow:0 0 0 0 rgba(242,166,59,.55)}
  to{box-shadow:0 0 0 9px rgba(242,166,59,0)}
}

/* ── the scan strip: the hero ──
   A 15-minute settlement window drawn to scale, with the minutes the gate is allowed to act shaded and
   a playhead that advances continuously. "Is it looking" is answered by movement, and by the coin rows
   underneath showing what it is looking at. */
.scan{background:var(--raised);border:1px solid var(--rule);border-radius:var(--r);
  padding:15px 17px 13px;margin-bottom:14px}
.scanhead{display:flex;align-items:baseline;gap:10px;margin-bottom:11px}
.scanhead .t{font-size:13px;color:var(--muted)}
.scanhead .t b{color:var(--tx);font-weight:560}
.scanhead .clockend{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--faint)}
.win{position:relative;height:34px;border-radius:6px;background:var(--sunk);
  border:1px solid var(--rule);overflow:hidden}
.win .gate{position:absolute;top:0;bottom:0;overflow:hidden;background:rgba(242,166,59,.10);
  border-left:1px solid rgba(242,166,59,.30);border-right:1px solid rgba(242,166,59,.30)}
.win .gate i{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  font-style:normal;font-size:10.5px;color:rgba(242,166,59,.85);white-space:nowrap;letter-spacing:.02em}
.win .head{position:absolute;top:-1px;bottom:-1px;width:2px;background:var(--live);
  box-shadow:0 0 8px rgba(242,166,59,.7)}
.win .head b{position:absolute;top:-1px;left:-3px;width:8px;height:8px;border-radius:50%;
  background:var(--live)}
.wintick{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;
  color:var(--faint);padding:5px 1px 0}

/* one row per coin: which way it leans, how far from the band */
.scanwhy{font-size:12.5px;color:var(--loss);padding:7px 1px 0;line-height:1.5}
.scanwhy:empty{display:none}
.scanwhy b{color:var(--loss)}
.watch{margin-top:12px;display:grid;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.wrow{display:grid;grid-template-columns:52px 62px 1fr 92px;align-items:center;gap:12px;
  background:var(--raised);padding:8px 12px;font-size:13px}
.wrow.off{opacity:.34}
.wrow .s{font-weight:600;letter-spacing:-.01em}
.wrow .p{font-family:var(--mono);font-size:14px;text-align:right;white-space:nowrap}
.wrow .lean{font-size:11.5px;color:var(--faint)}
.wrow .bar{position:relative;height:6px;border-radius:3px;background:var(--sunk);overflow:hidden}
.wrow .bar u{position:absolute;left:0;top:0;bottom:0;background:var(--rule2);border-radius:3px;
  transition:width .45s cubic-bezier(.22,.61,.36,1)}
.wrow .bar em{position:absolute;top:-2px;bottom:-2px;background:rgba(242,166,59,.20);
  border-left:1px solid rgba(242,166,59,.55);border-right:1px solid rgba(242,166,59,.55)}
.wrow .d{font-family:var(--mono);font-size:12px;color:var(--faint);text-align:right;white-space:nowrap}
.wrow.hot{background:rgba(242,166,59,.07)}
.wrow.hot .p{color:var(--live)}
.wrow.hot .bar u{background:var(--live)}
.wrow.hot .d{color:var(--live)}
.wrow.quiet .p{color:var(--faint)}

/* ── money ──
   Four figures at full size and the rest small. Eleven equal tiles meant none of them was the answer. */
.money{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;
  margin-bottom:1px}
.cell{background:var(--raised);padding:14px 16px}
.cell .k{color:var(--muted);font-size:12px;font-weight:500;letter-spacing:0}
.cell .v{font-family:var(--mono);font-size:25px;font-weight:550;margin-top:5px;letter-spacing:-.03em}
.cell .s{color:var(--faint);font-size:12px;margin-top:2px}
.minor{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-top:0;
  border-radius:0 0 var(--r) var(--r);overflow:hidden;margin-bottom:20px}
.minor .cell{padding:9px 14px}
.minor .cell .v{font-size:15px;margin-top:2px}
.minor .cell .s{font-size:11px}

/* ── tabs ── */
nav{display:flex;gap:2px;border-bottom:1px solid var(--rule);margin-bottom:18px;
  overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;font-weight:540;
  padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
nav button:hover{color:var(--tx)}
nav button[aria-selected=true]{color:var(--tx);border-bottom-color:var(--live)}
nav button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:4px}
nav .count{color:var(--faint);font-size:12px;margin-left:6px;font-family:var(--mono)}

section{display:none}
section.on{display:block}
/* Reserved height. Tables that grow and shrink between polls made the whole page jump, which is most of
   what "choppy" was. */
#decbody,#trabody,#coinbody,#gatbody,#hrsbody,#setbody,#accbody{min-height:220px}

/* ── tables ── */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--muted);font-size:12px;font-weight:540;letter-spacing:0;
  padding:0 10px 8px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
tbody tr:hover{background:#18202f}
.num{font-family:var(--mono);text-align:right;white-space:nowrap}
.up{color:var(--up)}.down{color:var(--down)}.warn{color:var(--warn)}.dim{color:var(--muted)}
.faint{color:var(--faint)}
.sym{font-weight:600}
.pill{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.01em;
  padding:2px 7px;border-radius:5px;background:#1d2637;color:var(--muted)}
.pill.win{background:rgba(70,211,145,.13);color:var(--gain)}
.pill.loss{background:rgba(242,105,95,.13);color:var(--loss)}
.pill.open{background:rgba(127,166,255,.13);color:var(--accent)}
.pill.live{background:rgba(242,105,95,.13);color:var(--loss)}
.pill.paper{background:#1d2637;color:var(--muted)}
.why{color:var(--muted);font-size:12.5px;line-height:1.45}
.mkt{display:flex;gap:6px;flex-wrap:wrap}
.mkt span{font-family:var(--mono);font-size:12px;padding:3px 8px;border-radius:5px;
  background:#1d2637;color:var(--faint)}
.mkt span.on{background:rgba(70,211,145,.12);color:var(--gain)}
.note{color:var(--faint);font-size:12.5px;line-height:1.65;margin-top:16px;max-width:72ch}
.note b{color:var(--muted)}
.empty{color:var(--faint);padding:26px 10px;font-size:13.5px}
.coinbar{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.coinbar button{background:#18202f;color:var(--muted);border:1px solid var(--rule2);border-radius:7px;
  padding:6px 11px;font:600 12px/1 inherit;cursor:pointer;letter-spacing:.02em}
.coinbar button[aria-selected=true]{background:rgba(242,166,59,.13);color:var(--live);
  border-color:rgba(242,166,59,.5)}
.coinbar button.off{opacity:.42}
.chartwrap{border:1px solid var(--rule);border-radius:var(--r);background:var(--raised);
  padding:12px 10px 4px}
.chartwrap+.chartwrap{margin-top:10px}
.chartwrap svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;gap:15px;flex-wrap:wrap;color:var(--faint);font-size:11.5px;padding:9px 4px 3px}
.legend i{display:inline-block;width:10px;height:2px;vertical-align:middle;margin-right:5px}
.legend i.sq{width:7px;height:7px;border-radius:1px}
.readout{font-family:var(--mono);font-size:11.5px;color:var(--muted);padding:7px 4px 2px;min-height:18px}
.bars{display:grid;grid-template-columns:auto 1fr auto;gap:5px 12px;align-items:center;
  font-size:13px;margin-top:4px}
.bars .lbl{color:var(--muted)}
.bars .track{height:7px;background:var(--sunk);border-radius:3px;overflow:hidden}
.bars .fill{display:block;height:100%;min-width:2px;background:var(--accent);opacity:.85;border-radius:3px}
.bars .n{font-family:var(--mono);color:var(--faint);font-size:12px;text-align:right}
.locked{border:1px dashed var(--rule2);border-radius:var(--r);padding:20px;color:var(--muted);
  font-size:13.5px;line-height:1.65}
.locked code{font-family:var(--mono);background:#1d2637;padding:1px 6px;border-radius:4px;
  color:var(--live)}

@media(max-width:640px){
  .wrap{padding:16px 12px 60px}
  .cell .v{font-size:21px}
  th,td{padding-left:7px;padding-right:7px}
  .hstats{width:100%;margin-left:0;gap:16px}
  .wrow{grid-template-columns:42px 74px 1fr;gap:9px}
  .wrow .d{display:none}
  /* The strip's own status line already says where the clock is, so the label inside the shaded zone is
     redundant on a phone and there is no room for it. */
  .win .gate i{display:none}
  .scan{padding:13px 13px 11px}
}
@media(prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}

/* ── surface polish ──
   Appended last so it layers over the sheet above without renaming a single class. Every selector
   targets a block that already exists; no markup or behaviour changes. */
.hero,.mkt,.gate,.readout,.chartwrap,.coinbar,.legend{
  background:linear-gradient(180deg,var(--raised2) 0%,var(--raised) 100%);
  border-radius:var(--r);box-shadow:var(--lift),var(--hair);border:0}
.head,.scanhead{letter-spacing:.02em;text-transform:uppercase;font-size:11px;
  font-weight:650;color:var(--faint)}
.cell{border-radius:calc(var(--r) - 4px)}
.cell .k,.lbl{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--faint)}
.num,.money{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.pill{border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}
.track,.bar,.bars,.fill{border-radius:999px}
th{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--faint);font-weight:650}
tbody tr:hover{background:rgba(127,166,255,.05)}
.note,.scanwhy{color:var(--muted);line-height:1.5}
.empty{color:var(--faint);text-align:center;padding:22px 12px}
/* The heartbeat is decoration; the numbers are the content. */
@media (prefers-reduced-motion:reduce){.dot.beat{animation:none}}
</style></head><body><div class=wrap>

<header>
  <h1>Indicators</h1>
  <span class=sub><span class="dot" id=hdot></span> <span id=hstat>connecting…</span></span>
  <span class=hstats id=hstats></span>
</header>

<!-- The scan strip. A 15-minute settlement window drawn to scale: the shaded band is the stretch of the
     clock where the gate is allowed to act, the playhead advances every 100ms, and each coin row shows
     the price the book is charging on the leaning side and how far it still is from the entry band. -->
<div class=scan id=scan>
  <div class=scanhead>
    <span class=t id=scant>waiting for the first pass…</span>
    <span class=clockend id=scanend></span>
  </div>
  <div class=win id=win>
    <div class=gate id=wingate><i id=wingatelbl></i></div>
    <div class=head id=winhead><b></b></div>
  </div>
  <div class=wintick><span id=winopen></span><span id=winclose></span></div>
  <div class=scanwhy id=scanwhy></div>
  <div class=watch id=watch></div>
</div>

<div class=money id=hero></div>
<div class=minor id=heromin></div>

<nav id=tabs>
  <button data-t=decisions aria-selected=true>Decisions<span class=count id=cdec></span></button>
  <button data-t=coins aria-selected=false>Coins<span class=count id=ccoin></span></button>
  <button data-t=chart aria-selected=false>Chart<span class=count id=cchr></span></button>
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
<section id=s-chart>
  <div class=coinbar id=coinbar></div>
  <div id=chrbody></div>
  <div class=note><b>What the bot saw, one point per scan pass.</b> The price line is the spot the bot
  actually read on that pass, not a fresh pull — a chart drawn from a later fetch would show a price no
  decision was ever made against. The <b>Kalshi ask</b> is the line that matters: on this strategy the
  entry is decided from the order book and the clock, and from nothing else.<br><br>
  <b>The indicators below are observed, not used.</b> RSI, drift and realised volatility are recorded here
  because a chart is more legible with them, but they are not inputs — measured over 386,958 rows, adding
  the indicators on top of the ask made the forecast <em>worse</em>. Treating this strip as the reason for
  an entry would be reading it backwards.<br><br>
  Buy and sell marks need the token, because a fill is somebody's position. The series itself names
  nobody, so it stays open.</div>
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
  // Every section, not a subset. 'gates' was missing from this list, so selecting that tab hid every
  // other section and never showed its own — a blank page on a tab that had a working renderer.
  ['decisions','coins','chart','trades','hours','gates','setup','accounts'].forEach(t =>
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
  // The first four are the headline; everything after is the quiet row. Live money leads, paper follows,
  // then the two numbers that say whether the edge is working and what is exposed right now.
  return [
    ['Live P&L', signed(lv.net), cls(lv.net),
      lv.closed ? lv.closed + ' closed, today ' + signed(lv.today) : 'no live trades yet'],
    ['Paper P&L', signed(pp.net), cls(pp.net),
      pp.closed ? pp.closed + ' closed, today ' + signed(pp.today) : 'no paper trades yet'],
    ['Win rate', f.closed ? pct(f.hit) : '—', '', f.closed ? f.wins + ' won, ' + f.losses + ' lost' : 'no trades yet'],
    ['Open now', String(f.open), '', f.atRisk ? money(f.atRisk) + ' at risk' : 'nothing at risk'],
    ['Live day high', money(lv.dayHigh), 'dim',
      lv.today || lv.closed ? 'best equity today' : 'nothing closed today'],
    ['Paper day high', money(pp.dayHigh), 'dim', 'best equity today'],
    ['Direction now', (dr.open.down || 0) + '↓ / ' + (dr.open.up || 0) + '↑', '',
      'open exposure by side'],
    ['Down book', dHit, dr.warn ? 'down' : '',
      dr.down && dr.down.recentN
        ? 'last ' + dr.down.recentN + (dr.warn ? ', tilt turning' : ', the structural side')
        : 'no down trades yet'],
    ['Fees', money(f.fees), 'dim', 'paid to Kalshi'],
    ['Accounts', String(f.accounts), '', f.accounts === 1 ? 'one account armed or paper' : 'armed or paper'],
    ['Signals', String(sc.decisions), '', sc.entries + ' filled, ' + sc.passes + ' passes']
  ];
}
/**
 * The four figures that answer "is it making money", at full size.
 *
 * Eleven equal tiles meant none of them was the answer — the eye had nowhere to land, which is half of
 * why the panel read as noise. These four are the ones somebody opens the page for; the other seven are
 * still here, one line down and quiet, because they are worth having and not worth shouting.
 */
const CELL = c => '<div class=cell><div class=k>' + c[0] + '</div><div class="v ' + c[2] + '">' +
  c[1] + '</div><div class=s>' + esc(c[3]) + '</div></div>';
function heroMain(d) { return heroCells(d).slice(0, 4).map(CELL).join(''); }
function heroMinor(d) { return heroCells(d).slice(4).map(CELL).join(''); }

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
    writeIf('decbody', mk + '<div class=empty>Nothing decided yet — the first pass runs within 20 seconds of startup.</div>');
    return;
  }
  writeIf('decbody', mk +
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
    }).join('') + '</tbody></table>');
}

function renderTrades(d) {
  if (d.locked) { writeIf('trabody', lockedBox('Trades name the account that took them')); return; }
  $('ctra').textContent = d.trades.length ? d.trades.length : '';
  if (!d.trades.length) { writeIf('trabody', '<div class=empty>No positions yet.</div>'); return; }
  writeIf('trabody',
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
    }).join('') + '</tbody></table>');
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
  if (!rows.length) { writeIf('coinbody', '<div class=empty>No market list yet.</div>'); return; }
  if (!traded.length) {
    writeIf('coinbody', '<div class=empty>No settled trades yet — every coin below is armed ' +
      'and waiting. This table fills in as positions close.</div>' + coinTable(rows));
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
  writeIf('coinbody', '<div class=note style="margin:0 0 14px">' + head + '</div>' + coinTable(rows));
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
  writeIf('gatbody',
    (d.settled ? '' : '<div class=note>No settled trades yet — nothing to judge.</div>') +
    table('Overall', [d.overall]) +
    table('By indicator agreement', d.byConfirm) +
    table('By RSI stretch' + (d.withRsi < d.settled ? ' (' + (d.settled - d.withRsi) + ' older trades carry no RSI)' : ''), d.byRsi) +
    table('By direction', d.byDirection));
  $('cgat').textContent = d.settled || '';
}

const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM';function renderHours(d) {
  if (d.locked) { writeIf('hrsbody', lockedBox('Hourly P&L is account money')); return; }
  $('chrs').textContent = d.totalClosed ? d.totalClosed : '';
  const rows = (d.hours || []).filter(h => h.taken > 0);
  if (!rows.length) { writeIf('hrsbody', '<div class=empty>No settled trades yet — the hourly breakdown fills in as positions close.</div>'); return; }
  const maxAbs = Math.max(1, ...rows.map(h => Math.abs(h.net)));
  // "best time" headline needs a floor on sample size so a lucky 1-trade hour can't win it
  const solid = rows.filter(h => h.taken >= 3);
  const best = (solid.length ? solid : rows).reduce((a, b) => b.net > a.net ? b : a);
  const worst = (solid.length ? solid : rows).reduce((a, b) => b.net < a.net ? b : a);
  const bar = n => { const w = (Math.abs(n) / maxAbs * 100).toFixed(1);
    return '<span style="display:flex;height:8px;background:#171a21;border-radius:3px;overflow:hidden;justify-content:' +
      (n < 0 ? 'flex-end' : 'flex-start') + '"><span style="display:block;height:100%;min-width:2px;border-radius:3px;width:' +
      w + '%;background:' + (n < 0 ? 'var(--down)' : 'var(--up)') + '"></span></span>'; };
  writeIf('hrsbody',
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
      '<td>' + bar(h.net) + '</td></tr>').join('') + '</tbody></table>');
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
  if (d.locked) { writeIf('setbody', lockedBox('Your settings and bankroll are account data')); return; }
  const accs = d.accounts || [];
  const attention = accs.reduce((a, x) => a + (x.attention || 0), 0);
  $('cset').textContent = attention ? attention : '';
  const shadowHtml = shadowBlock(pub);
  if (!accs.length) { writeIf('setbody', shadowHtml + '<div class=empty>No accounts yet.</div>'); return; }
  writeIf('setbody', shadowHtml + accs.map(a => {
    const s = a.summary;
    const head = '<div class=note style="margin:0 0 14px"><b>' + esc(a.who) + '</b> ' +
      '<span class="pill ' + (a.live ? (a.armed ? 'live' : '') : 'paper') + '">' +
      (a.live ? (a.armed ? 'armed' : 'paper, not armed') : 'paper') + '</span>  bankroll ' +
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
  }).join(''));
}

function renderAccounts(d) {  if (d.locked) { writeIf('accbody', lockedBox('Account P&L is per-person money')); return; }
  $('cacc').textContent = d.accounts.length ? d.accounts.length : '';
  if (!d.accounts.length) { writeIf('accbody', '<div class=empty>No accounts yet.</div>'); return; }
  writeIf('accbody',
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
    }).join('') + '</tbody></table>');
}


// ── the chart ────────────────────────────────────────────────────────────────────────────────────
//
// Inline SVG, built as a string, no library. The rest of this page is one self-contained file served by
// the trading process; pulling a charting bundle off a CDN would put a third party in the path of the
// page you check when you want to know whether the bot is alive.

var chartSym = 'BTC';
var chartPts = [];
var chartGeom = null;

function coinButtons(pub) {
  var ms = (pub && pub.markets) || [];
  if (!ms.length) return '';
  return ms.map(function (m) {
    return '<button data-c="' + m.sym + '" aria-selected="' + (m.sym === chartSym) + '"' +
      (m.on ? '' : ' class=off') + '>' + m.sym + (m.on ? '' : ' · off') + '</button>';
  }).join('');
}

// Segments rather than one polyline: a gap in the data must show as a gap. Joining across a null would
// draw a straight line through a period the bot could not read a price, which is the most misleading
// thing a price chart can do.
// NOTE ON ' />': the space is load-bearing. This page is parsed as HTML, not XML, so an unquoted
// attribute value directly before '/>' swallows the slash — 'stroke-width=1/>' becomes
// stroke-width="1/" on an element that never closes, and every element after it becomes its child.
// Children of <line> are not rendered, so the whole chart silently drew nothing but the axes.
function segs(pts, pick, X, Y) {
  var out = [], cur = [];
  for (var i = 0; i < pts.length; i++) {
    var v = pick(pts[i]);
    if (v === null || v === undefined || !isFinite(v)) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    cur.push(X(pts[i].at).toFixed(1) + ',' + Y(v).toFixed(1));
  }
  if (cur.length > 1) out.push(cur);
  return out.map(function (c) { return c.join(' '); });
}

function niceNum(v, dp) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return Number(v).toFixed(dp === undefined ? 2 : dp);
}

function renderChart(d, tr, pub) {
  writeIf('coinbar', coinButtons(pub));
  var body = $('chrbody');
  if (!d || !d.ok) { body.innerHTML = '<div class=empty>' + esc((d && d.why) || 'no series yet') + '</div>'; return; }
  var pts = (d.points || []).filter(function (p) { return p && p.at; });
  chartPts = pts;
  if (pts.length < 2) {
    body.innerHTML = '<div class=empty>Only ' + pts.length + ' observation' + (pts.length === 1 ? '' : 's') +
      ' for ' + esc(d.sym) + ' so far. The scanner records one per pass — give it a few minutes.</div>';
    return;
  }

  var W = 1000, PL = 54, PR = 48, H1 = 250, H2 = 78, H3 = 78, GAP = 8;
  var t0 = pts[0].at, t1 = pts[pts.length - 1].at, span = (t1 - t0) || 1;
  var X = function (t) { return PL + ((t - t0) / span) * (W - PL - PR); };

  // Price scale spans the spot AND the strike: a strike drawn off the top of the panel is worse than no
  // strike, because the distance to it is the whole question the market is asking.
  var vals = [];
  pts.forEach(function (p) {
    if (isFinite(p.spot) && p.spot !== null) vals.push(p.spot);
    if (isFinite(p.strike) && p.strike !== null) vals.push(p.strike);
  });
  if (!vals.length) { body.innerHTML = '<div class=empty>no price in the series yet</div>'; return; }
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var padv = (hi - lo) * 0.08 || (hi * 0.001) || 1;
  lo -= padv; hi += padv;
  var Y1 = function (v) { return 12 + (1 - (v - lo) / (hi - lo)) * (H1 - 24); };
  // The ask axis is fixed 0..1, never autoscaled. The 85-90c band has to sit in the same place on every
  // coin or the one thing this chart exists to show — how far the book is from the gate — moves around.
  var Ya = function (v) { return 12 + (1 - v) * (H1 - 24); };

  var svg = [];
  svg.push('<svg viewBox="0 0 ' + W + ' ' + H1 + '" preserveAspectRatio="none" id=chsvg>');
  // the gate band, on the ask axis
  svg.push('<rect x=' + PL + ' y=' + Ya(0.90).toFixed(1) + ' width=' + (W - PL - PR) +
    ' height=' + (Ya(0.85) - Ya(0.90)).toFixed(1) + ' fill="rgba(255,200,87,.10)"/>');
  svg.push('<text x=' + (W - PR + 5) + ' y=' + (Ya(0.875) + 3).toFixed(1) +
    ' fill="#5a6070" font-size=9>85-90c</text>');
  // right axis ticks for the ask
  [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
    svg.push('<line x1=' + PL + ' y1=' + Ya(v).toFixed(1) + ' x2=' + (W - PR) + ' y2=' + Ya(v).toFixed(1) +
      ' stroke="#1e222b" stroke-width=1 />');
    svg.push('<text x=' + (W - PR + 5) + ' y=' + (Ya(v) + 3).toFixed(1) + ' fill="#5a6070" font-size=9>' +
      Math.round(v * 100) + 'c</text>');
  });
  // left axis ticks for the price
  [0, 0.5, 1].forEach(function (f) {
    var v = lo + f * (hi - lo);
    svg.push('<text x=' + (PL - 6) + ' y=' + (Y1(v) + 3).toFixed(1) +
      ' fill="#5a6070" font-size=9 text-anchor=end>' + niceNum(v, v > 100 ? 0 : 4) + '</text>');
  });
  // the strike, per window, as flat segments — it is a step function, so it must not be interpolated
  segs(pts, function (p) { return p.strike; }, X, Y1).forEach(function (d2) {
    svg.push('<polyline points="' + d2 + '" fill=none stroke="#8b91a1" stroke-width=1 ' +
      'stroke-dasharray="3 3" vector-effect=non-scaling-stroke />');
  });
  // the favourite ask: the side the book prices dear, which is the side the gate tests
  segs(pts, function (p) {
    var a = [p.yesAsk, p.noAsk].filter(function (x) { return x !== null && isFinite(x) && x > 0 && x < 1; });
    return a.length ? Math.max.apply(null, a) : null;
  }, X, Ya).forEach(function (d2) {
    svg.push('<polyline points="' + d2 + '" fill=none stroke="#ffc857" stroke-width=1.4 ' +
      'vector-effect=non-scaling-stroke />');
  });
  // spot last, so it draws over the rest
  segs(pts, function (p) { return p.spot; }, X, Y1).forEach(function (d2) {
    svg.push('<polyline points="' + d2 + '" fill=none stroke="#7aa2ff" stroke-width=1.6 ' +
      'vector-effect=non-scaling-stroke />');
  });
  // eligibility ticks: the passes where the clock alone allowed a trade
  var cl = d.clock || { minLeft: 6, maxLeft: 12 };
  pts.forEach(function (p) {
    if (p.minutesLeft === null || !isFinite(p.minutesLeft)) return;
    if (p.minutesLeft < cl.minLeft || p.minutesLeft > cl.maxLeft) return;
    svg.push('<line x1=' + X(p.at).toFixed(1) + ' y1=' + (H1 - 5) + ' x2=' + X(p.at).toFixed(1) +
      ' y2=' + (H1 - 1) + ' stroke="#3ddc84" stroke-width=1 opacity=.5 />');
  });

  // ── entry marks ──
  var mine = [];
  if (tr && tr.trades) {
    mine = tr.trades.filter(function (t) {
      return t.sym === d.sym && t.at && new Date(t.at).getTime() >= t0 && new Date(t.at).getTime() <= t1;
    });
    mine.forEach(function (t) {
      var at = new Date(t.at).getTime();
      var col = t.outcome === 'OPEN' ? '#7aa2ff' : (Number(t.pnl) > 0 ? '#3ddc84' : '#ff6b6b');
      var up = String(t.direction || '').toUpperCase().indexOf('UP') >= 0 ||
        String(t.direction || '').toUpperCase().indexOf('YES') >= 0;
      var yy = (t.spot !== null && isFinite(t.spot)) ? Y1(t.spot) : Ya(Number(t.priceCents) / 100);
      var x = X(at);
      svg.push('<path d="M' + x.toFixed(1) + ' ' + (yy + (up ? -9 : 9)).toFixed(1) +
        ' L' + (x - 5).toFixed(1) + ' ' + (yy + (up ? -1 : 1)).toFixed(1) +
        ' L' + (x + 5).toFixed(1) + ' ' + (yy + (up ? -1 : 1)).toFixed(1) + ' Z" fill="' + col + '"/>');
      if (t.exitAt) {
        var xa = X(new Date(t.exitAt).getTime());
        svg.push('<line x1=' + xa.toFixed(1) + ' y1=12 x2=' + xa.toFixed(1) + ' y2=' + (H1 - 12) +
          ' stroke="' + col + '" stroke-width=1 stroke-dasharray="2 4" opacity=.55 />');
      }
    });
  }
  svg.push('</svg>');

  // ── RSI and gap strips ──
  function strip(h, pick, dom, guides, colour, label) {
    var g = [];
    g.push('<svg viewBox="0 0 ' + W + ' ' + h + '" preserveAspectRatio="none">');
    var Y = function (v) { return 10 + (1 - (v - dom[0]) / (dom[1] - dom[0])) * (h - 20); };
    guides.forEach(function (v) {
      g.push('<line x1=' + PL + ' y1=' + Y(v).toFixed(1) + ' x2=' + (W - PR) + ' y2=' + Y(v).toFixed(1) +
        ' stroke="#1e222b" stroke-width=1 />');
      g.push('<text x=' + (PL - 6) + ' y=' + (Y(v) + 3).toFixed(1) +
        ' fill="#5a6070" font-size=9 text-anchor=end>' + v + '</text>');
    });
    segs(pts, pick, X, Y).forEach(function (d2) {
      g.push('<polyline points="' + d2 + '" fill=none stroke="' + colour + '" stroke-width=1.3 ' +
        'vector-effect=non-scaling-stroke />');
    });
    g.push('<text x=' + (PL + 4) + ' y=11 fill="#5a6070" font-size=9>' + label + '</text>');
    g.push('</svg>');
    return g.join('');
  }
  var gaps = pts.map(function (p) { return isFinite(p.gapBps) && p.gapBps !== null ? Math.abs(p.gapBps) : null; })
    .filter(function (v) { return v !== null; });
  var gmax = gaps.length ? Math.max(10, Math.ceil(Math.max.apply(null, gaps) / 10) * 10) : 10;

  var when = function (ms) { return new Date(ms).toLocaleTimeString(); };
  body.innerHTML =
    '<div class=chartwrap>' + svg.join('') +
    '<div class=legend>' +
      '<span><i style="background:#7aa2ff"></i>spot (left axis)</span>' +
      '<span><i style="background:#ffc857"></i>favourite ask (right axis)</span>' +
      '<span><i style="background:#8b91a1"></i>strike</span>' +
      '<span><i class=sq style="background:#3ddc84"></i>win</span>' +
      '<span><i class=sq style="background:#ff6b6b"></i>loss</span>' +
      '<span><i class=sq style="background:#7aa2ff"></i>open</span>' +
      '<span>green ticks: clock allowed a trade</span>' +
    '</div>' +
    '<div class=readout id=chread>' + esc(d.sym) + ' · ' + pts.length + ' passes · ' +
      when(t0) + ' → ' + when(t1) + ' · hover for the numbers</div>' +
    '</div>' +
    '<div class=chartwrap>' + strip(H2, function (p) { return p.rsi; }, [0, 100], [30, 50, 70], '#8b91a1', 'RSI (observed)') + '</div>' +
    '<div class=chartwrap>' + strip(H3, function (p) {
      return isFinite(p.gapBps) && p.gapBps !== null ? Math.abs(p.gapBps) : null;
    }, [0, gmax], [0, Math.round(gmax / 2), gmax], '#8b91a1', 'distance to strike, bp (observed)') + '</div>' +
    tradesForCoin(mine, tr, d.sym);

  chartGeom = { t0: t0, t1: t1, PL: PL, PR: PR, W: W };
}

// The per-coin fill list. Gated: /api/trades answers 401 without the token, and 'tr.locked' is how 'get()'
// reports that, so the chart still draws and only the marks and this table are withheld.
function tradesForCoin(mine, tr, sym) {
  if (tr && tr.locked) {
    return '<div class=note style="margin-top:14px">' +
      '<b>Buy and sell marks are private.</b> A fill belongs to an account, so it needs ' +
      '<code>?key=YOUR_TOKEN</code>. The series above names nobody and stays open.</div>';
  }
  if (!mine || !mine.length) {
    return '<div class=empty>no ' + esc(sym) + ' fills inside this window</div>';
  }
  var rows = mine.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); }).map(function (t) {
    var cls = t.outcome === 'OPEN' ? 'open' : (Number(t.pnl) > 0 ? 'win' : 'loss');
    return '<tr><td class=num>' + new Date(t.at).toLocaleTimeString() + '</td>' +
      '<td>' + esc(String(t.direction || '')) + ' <span class="pill ' + (t.live ? 'live' : 'paper') + '">' +
      (t.live ? 'live' : 'paper') + '</span></td>' +
      '<td class=num>' + t.contracts + ' @ ' + t.priceCents + 'c</td>' +
      '<td class=num>' + (t.exitCents === null ? '—' : t.exitCents + 'c') + '</td>' +
      '<td class=num>' + (t.pnl === null ? '—' : (Number(t.pnl) >= 0 ? '+' : '') + niceNum(t.pnl)) + '</td>' +
      '<td><span class="pill ' + cls + '">' + esc(String(t.outcome || '')) + '</span></td>' +
      '<td class=num>' + niceNum(t.rsi, 1) + '</td>' +
      '<td class=num>' + niceNum(t.gapBps, 1) + '</td></tr>';
  }).join('');
  return '<table style="margin-top:16px"><thead><tr><th>entry</th><th>side</th><th>size</th>' +
    '<th>exit</th><th>p&l</th><th>outcome</th><th>rsi</th><th>gap bp</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
}

// One listener for the life of the page rather than one per render: re-binding on every 5-second refresh
// is how a page ends up with two hundred handlers and a crosshair that fires each of them.
document.addEventListener('mousemove', function (e) {
  var svgEl = document.getElementById('chsvg');
  if (!svgEl || !chartGeom || !chartPts.length) return;
  var r = svgEl.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top - 4 || e.clientY > r.bottom + 4) return;
  var frac = (e.clientX - r.left) / r.width;
  var xVb = frac * chartGeom.W;
  var g = chartGeom, inner = g.W - g.PL - g.PR;
  var t = g.t0 + Math.max(0, Math.min(1, (xVb - g.PL) / inner)) * (g.t1 - g.t0);
  var best = null, bd = Infinity;
  for (var i = 0; i < chartPts.length; i++) {
    var dd = Math.abs(chartPts[i].at - t);
    if (dd < bd) { bd = dd; best = chartPts[i]; }
  }
  var out = document.getElementById('chread');
  if (!best || !out) return;
  var asks = [best.yesAsk, best.noAsk].filter(function (x) { return x !== null && isFinite(x); });
  out.textContent = new Date(best.at).toLocaleTimeString() +
    '  spot ' + niceNum(best.spot, best.spot > 100 ? 1 : 4) +
    '  strike ' + niceNum(best.strike, best.strike > 100 ? 1 : 4) +
    '  fav ask ' + (asks.length ? Math.round(Math.max.apply(null, asks) * 100) + 'c' : '—') +
    '  T-' + niceNum(best.minutesLeft, 1) + 'm' +
    '  rsi ' + niceNum(best.rsi, 1) +
    '  gap ' + niceNum(best.gapBps, 1) + 'bp' +
    '  drift ' + niceNum(best.drift10Bps, 1) + 'bp' +
    '  vol ' + niceNum(best.realizedVolBps, 1) + 'bp' +
    '  ' + (best.taken ? 'TAKEN' : (best.reason || 'skip'));
});

$('coinbar').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-c]');
  if (!b) return;
  chartSym = b.dataset.c;
  refresh();
});

function lockedBox(what) {
  return '<div class=locked><b>' + esc(what) + ', so this tab is private.</b><br><br>' +
    'Set <code>WEB_TOKEN</code> on the service and open this page with <code>?key=YOUR_TOKEN</code>. ' +
    'The Decisions tab stays open either way — it describes what the bot decided, which names nobody.</div>';
}

async function get(path) {
  try {
    // q is the ?key= for the gated routes. It is JOINED with the correct separator rather than
    // concatenated: the chart passes ?sym=, and a plain concatenation produced '?sym=BTC?key=...', which
    // the server read as a market named 'BTC?key=...' and answered 'no such market'. Caught in a browser,
    // not by a unit test, because both halves were individually correct.
    const sep = (q && path.indexOf('?') >= 0) ? '&' + q.slice(1) : q;
    const r = await fetch(path + sep);
    if (r.status === 401) return { locked: true };
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

/* ── writing to the DOM only when something changed ──
   The old refresh() rewrote whole innerHTML blocks every five seconds whether or not the numbers had
   moved. On a bot that declines most rounds almost nothing changes between polls, so nearly every write
   was a no-op that still destroyed and rebuilt the table you were reading: hover dropped, text reflowed,
   selection vanished, and the page twitched. That twitch was the "choppy". */
const _last = new Map();
function writeIf(id, html) {
  if (_last.get(id) === html) return false;
  _last.set(id, html);
  const el = $(id);
  if (el) el.innerHTML = html;
  return true;
}

/* ── the 15-minute settlement window, from the wall clock ──
   Rounds close on the quarter hour, so the window needs no server field and cannot drift out of step
   with one. Deriving it locally also means the playhead keeps moving if a poll fails, which is exactly
   when a person is staring at the page wondering whether anything is alive. */
const WIN_MS = 15 * 60 * 1000;
function windowNow(at) {
  const close = Math.ceil(at / WIN_MS) * WIN_MS;
  return { open: close - WIN_MS, close: close, frac: (at - (close - WIN_MS)) / WIN_MS };
}

let beatSeen = null;      // scanner.passes at the last pulse, so the dot beats once per real pass
let lastState = null;

/* Paint the strip. Called at 100ms from tick(), so it must do arithmetic and no allocation-heavy work. */
function paintStrip(at) {
  const st = lastState;
  if (!st) return;
  const sc = st.scanner || {};
  const w = windowNow(at);
  const clock = (st.preset && st.preset.clock) || { minLeft: 6, maxLeft: 12 };

  // The stretch of the window where the gate may act, as a share of its width. minLeft/maxLeft are
  // MINUTES LEFT, so they run backwards relative to the strip: T-12 is early, T-7 is late.
  const gl = Math.max(0, (15 - clock.maxLeft) / 15);
  const gr = Math.min(1, (15 - clock.minLeft) / 15);
  const gate = $('wingate');
  if (gate) {
    gate.style.left = (gl * 100).toFixed(2) + '%';
    gate.style.width = ((gr - gl) * 100).toFixed(2) + '%';
  }
  const lbl = $('wingatelbl');
  if (lbl) {
    const txt = 'can enter T-' + clock.maxLeft + ' to T-' + clock.minLeft;
    if (lbl.textContent !== txt) lbl.textContent = txt;
  }
  const head = $('winhead');
  if (head) head.style.left = (Math.min(1, Math.max(0, w.frac)) * 100).toFixed(3) + '%';

  const mins = (w.close - at) / 60000;
  const inGate = mins <= clock.maxLeft && mins >= clock.minLeft;
  const o = $('winopen'), c = $('winclose');
  if (o) o.textContent = clock2(w.open);
  if (c) c.textContent = clock2(w.close) + '  settles';

  // The line that answers "is it looking". It counts in tenths so it is visibly moving, and it says what
  // the loop is doing rather than only how long ago it last did it.
  const since = sc.lastPass ? (at - new Date(sc.lastPass).getTime()) / 1000 : null;
  const every = (sc.pollMs || 6000) / 1000;
  let t;
  if (st.killed) t = '<b class=down>halted</b> — the kill switch is on, nothing is being scanned';
  else if (since == null) t = 'starting up, no pass yet';
  else if (since > every * 6) t = '<b class=warn>quiet</b> — no pass for ' + since.toFixed(1) + 's';
  else if (sc.busy) t = '<b>scanning</b> all ' + (sc.watch ? sc.watch.length : 7) + ' markets now';
  else t = '<b>looking</b> — last pass ' + since.toFixed(1) + 's ago, next in ' +
    Math.max(0, every - since).toFixed(1) + 's';
  const tn = $('scant');
  if (tn) tn.innerHTML = t;
  // The one line that turns "nothing is trading" into a diagnosis. Only shown when accounts have actually
  // refused something: a gate that never offered anything is a different problem and says so on its own.
  const blocks = (sc.blocks || []).filter(b => b.n > 0);
  const WORDS = {
    'no-key': 'no access key on the account',
    'owner-block': 'the owner has blocked the account',
    'no-funds': 'not enough free cash for the order',
    'daily-stop': 'the daily stop is hit',
    'max-open': 'already at the open-position limit',
    'same-window': 'same direction already open in that window',
    'holding-round': 'already holding that round',
    'size-zero': 'size works out to zero contracts',
    'order-cap': 'over the per-order cost cap',
    'armed-no-paper': 'armed, so blocked entries are not papered',
    'rejected': 'Kalshi rejected the order',
    'account': 'refused by the account'
  };
  writeIf('scanwhy', blocks.length
    ? '<b>' + blocks[0].n + ' signal' + (blocks[0].n === 1 ? '' : 's') + ' refused</b> — ' +
      (WORDS[blocks[0].code] || blocks[0].code) +
      (blocks.length > 1 ? '. Also ' + blocks.slice(1, 3).map(b =>
        (WORDS[b.code] || b.code) + ' (' + b.n + ')').join(', ') : '')
    : '');

  const se = $('scanend');
  if (se) {
    se.textContent = inGate
      ? 'inside the entry window, ' + mins.toFixed(1) + 'm to settle'
      : (mins > clock.maxLeft ? 'entry window opens in ' + (mins - clock.maxLeft).toFixed(1) + 'm'
                              : 'entry window closed, ' + mins.toFixed(1) + 'm to settle');
    se.style.color = inGate ? 'var(--live)' : '';
  }
}
const clock2 = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* One row per market: which side the book is charging more for, and how far that price still has to
   travel to reach the entry band. A spinner says the page is alive; this says the BOT is. */
function paintWatch(st) {
  const sc = st.scanner || {};
  const rows = sc.watch || [];
  const band = sc.band || { lo: 0.85, hi: 0.90 };
  const lo = Math.round(band.lo * 100), hi = Math.round(band.hi * 100);
  if (!rows.length) return;
  const html = rows.map(r => {
    if (!r.on) {
      return '<div class="wrow off"><span class=s>' + esc(r.sym) + '</span>' +
        '<span class=p>—</span><span class=bar></span><span class=d>turned off</span></div>';
    }
    if (!r.seen || r.pricePct == null) {
      const why = r.skip === 'no-window' ? 'between rounds' : (r.seen ? 'no quote' : 'not scanned yet');
      return '<div class="wrow quiet"><span class=s>' + esc(r.sym) + '</span>' +
        '<span class=p>—</span><span class=bar></span><span class=d>' + why + '</span></div>';
    }
    // The track is the whole price line, 0 to 100c, with the entry band drawn on it in place. Scaling the
    // track to the band's lower edge instead made a 73c contract fill 86% of the bar and read as nearly
    // there, when it is twelve cents away — the bar has to agree with the number beside it.
    const fill = Math.min(100, Math.max(1.5, r.pricePct));
    const lean = r.side === 'YES' ? 'up' : 'down';
    const dist = r.inBand ? 'in the band'
      : (r.gapPct != null && r.gapPct > 0 ? r.gapPct + '¢ to go' : 'past ' + hi + '¢');
    return '<div class="wrow' + (r.inBand ? ' hot' : '') + '">' +
      '<span class=s>' + esc(r.sym) + '</span>' +
      '<span class=p>' + r.pricePct + '¢<span class=lean> ' + lean + '</span></span>' +
      '<span class=bar><em style="left:' + lo + '%;width:' + (hi - lo) + '%"></em>' +
        '<u style="width:' + fill.toFixed(1) + '%"></u></span>' +
      '<span class=d>' + dist + '</span></div>';
  }).join('');
  writeIf('watch', html);
}

let pub = null;

/**
 * The state poll: cheap, frequent, and the only thing the strip needs.
 *
 * Split from the tab poll because they have different jobs. /api/state is a few kilobytes and carries the
 * heartbeat, so it runs often enough that the strip is never showing a stale pass. The tab payloads are
 * the big ones — decisions, trades, series — and nothing in them can change faster than a pass, so they
 * keep the slower cadence they always had.
 */
async function pollState() {
  const s = await get('/api/state');
  if (!s) return;
  const prev = lastState;
  pub = s;
  lastState = s;
  const sc = s.scanner || {};

  // The dot beats once per COMPLETED pass, driven off the counter rather than a timer. A dot that blinks
  // on an interval looks alive whether or not the loop is turning, which is the one thing it must never do.
  if (prev && sc.passes > (prev.scanner ? prev.scanner.passes : 0)) {
    const dot = $('hdot');
    if (dot) { dot.classList.remove('beat'); void dot.offsetWidth; dot.classList.add('beat'); }
  }
  const dot = $('hdot');
  if (dot) {
    const want = 'dot ' + (s.killed ? 'bad' : sc.healthy ? 'ok' : 'bad') +
      (dot.classList.contains('beat') ? ' beat' : '');
    if (dot.className !== want) dot.className = want;
  }
  const hs = $('hstat');
  if (hs) {
    const t = s.killed ? '<b class=down>halted</b>'
      : sc.healthy ? (s.preset ? esc(s.preset.label) + ' preset' : 'running')
      : '<b class=warn>scanner quiet</b>';
    if (hs.innerHTML !== t) hs.innerHTML = t;
  }
  // The counters that say how much work has been done. Spaced rather than joined with dots, so each is a
  // figure with a name instead of one run-on string.
  writeIf('hstats',
    '<span>passes <b>' + (sc.passes || 0) + '</b></span>' +
    '<span>signals <b>' + (sc.decisions || 0) + '</b></span>' +
    '<span>filled <b>' + (sc.entries || 0) + '</b></span>' +
    (sc.passMs != null ? '<span>pass <b>' + (sc.passMs / 1000).toFixed(1) + 's</b></span>' : '') +
    (sc.lastError ? '<span class=warn>' + esc(String(sc.lastError).slice(0, 60)) + '</span>' : ''));

  writeIf('hero', heroMain(s));
  writeIf('heromin', heroMinor(s));
  paintWatch(s);
}

/** The heavy half: only the tab actually on screen, and only every few seconds. */
async function pollTab() {
  if (tab === 'decisions') { const d = await get('/api/decisions'); if (d && pub) renderDecisions(d, pub); }
  if (tab === 'coins')     { if (pub) renderCoins(pub); }
  if (tab === 'chart') {
    const [ser, tr] = await Promise.all([get('/api/series?sym=' + chartSym), get('/api/trades')]);
    if (ser) renderChart(ser, tr, pub);
    if (ser && ser.counts) {
      const tot = Object.keys(ser.counts).reduce((a, k) => a + ser.counts[k], 0);
      const el = $('cchr');
      if (el && el.textContent !== (tot ? String(tot) : '')) el.textContent = tot ? String(tot) : '';
    }
  }
  if (tab === 'trades')    { const d = await get('/api/trades');    if (d) renderTrades(d); }
  if (tab === 'hours')     { const d = await get('/api/hours');     if (d) renderHours(d); }
  if (tab === 'gates')     { const d = await get('/api/gates');     if (d) renderGates(d); }
  if (tab === 'setup')     { const d = await get('/api/recommend'); if (d) renderSetup(d, pub); }
  if (tab === 'accounts')  { const d = await get('/api/accounts');  if (d) renderAccounts(d); }
}

/** Kept for the tab-switch handler, which wants both halves at once. */
async function refresh() { await pollState(); await pollTab(); }

refresh();

/* ── the three clocks ──
   100ms paints. Nothing is fetched on that beat: the playhead position and the countdown are arithmetic on
   the last known pass time, so they advance smoothly and keep advancing if a poll fails — which is exactly
   when somebody is watching the page wondering whether anything is alive.
   1.5s fetches the heartbeat. The loop itself turns every 6s, so this is fast enough to never show a pass
   that has already been superseded, and slow enough to cost the trading process nothing.
   5s fetches the tab. None of that data can change faster than a pass. */
setInterval(() => paintStrip(Date.now()), 100);
setInterval(pollState, 1500);
setInterval(pollTab, 5000);
// Paint immediately rather than waiting 100ms, so the strip is never briefly empty on load.
paintStrip(Date.now());
</script>
</div></body></html>`;
};
