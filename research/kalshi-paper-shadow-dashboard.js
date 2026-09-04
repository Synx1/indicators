#!/usr/bin/env node
'use strict';

/**
 * Discord-styled control panel for the calibration paper shadow.
 *
 * Serves the shadow's atomic ledger as JSON plus one self-contained page: live P&L, the trade log with
 * entry and settlement times, each coin's Kalshi target price against live spot, a countdown to the next
 * signal, and the grace-allowance comparison.
 *
 * Security: binds 127.0.0.1 ONLY, never 0.0.0.0, so it is unreachable off this machine. It is a pure
 * reader of one local file — no write path, no command execution, no proxying, no credential or account
 * access. There is no authentication, which is acceptable ONLY because the socket is loopback-bound and
 * every value it serves is already-public market data.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = 8477;
const HOST = '127.0.0.1';

const arg = (argv, flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
};

/** Newest matching ledger, so a restarted shadow is picked up without editing the command. */
function newestLedger(dir = '/tmp') {
  const found = fs.readdirSync(dir)
    .filter(n => /^indicators-calibration-paper-.*\.jsonl\.live\.json$/.test(n))
    .map(n => { const full = path.join(dir, n); return { full, mtime: fs.statSync(full).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].full : null;
}

function readLedger(file) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')), file }; }
  catch (e) { return { ok: false, error: String(e.message || e), file }; }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calibration — Paper Trading</title>
<style>
  :root{
    --bg:#313338; --bg2:#2b2d31; --bg3:#1e1f22; --card:#383a40; --line:#3f4147;
    --fg:#f2f3f5; --dim:#b5bac1; --dimmer:#80848e;
    --blurple:#5865f2; --green:#23a55a; --red:#f23f43; --yellow:#f0b232; --pink:#eb459e;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.45 "gg sans","Noto Sans",Helvetica,Arial,sans-serif;display:flex;min-height:100vh}
  ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--bg3);border-radius:4px}

  /* rail */
  .rail{width:72px;background:var(--bg3);display:flex;flex-direction:column;align-items:center;
    padding:12px 0;gap:8px;flex-shrink:0}
  .orb{width:48px;height:48px;border-radius:16px;background:var(--blurple);display:flex;
    align-items:center;justify-content:center;font-weight:700;font-size:18px;cursor:default}
  .orb.alt{background:var(--card);border-radius:50%;font-size:20px}
  .sep{width:32px;height:2px;background:var(--line);border-radius:1px;margin:4px 0}

  /* sidebar */
  .side{width:240px;background:var(--bg2);display:flex;flex-direction:column;flex-shrink:0}
  .side h1{margin:0;padding:16px;font-size:15px;font-weight:600;border-bottom:1px solid var(--bg3);
    display:flex;align-items:center;gap:8px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--green);flex-shrink:0}
  .dot.off{background:var(--red)}
  .chans{padding:12px 8px;overflow-y:auto;flex:1}
  .cat{color:var(--dimmer);font-size:11px;font-weight:700;text-transform:uppercase;
    letter-spacing:.5px;padding:12px 8px 4px}
  .chan{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:4px;color:var(--dim);
    font-size:14px;cursor:pointer;user-select:none}
  .chan:hover{background:#35373c;color:var(--fg)}
  .chan.on{background:#404249;color:#fff;font-weight:500}
  .chan .hash{color:var(--dimmer);font-size:18px;line-height:1}
  .chan .badge{margin-left:auto;background:var(--red);color:#fff;font-size:11px;font-weight:700;
    border-radius:8px;padding:0 6px;min-width:16px;text-align:center}
  .me{padding:8px;background:#232428;display:flex;align-items:center;gap:8px;font-size:12px}
  .me .av{width:32px;height:32px;border-radius:50%;background:var(--green);flex-shrink:0;
    display:flex;align-items:center;justify-content:center;font-size:14px}
  .me small{color:var(--dimmer);display:block}

  /* main */
  main{flex:1;display:flex;flex-direction:column;min-width:0}
  .top{height:48px;border-bottom:1px solid var(--bg3);display:flex;align-items:center;gap:10px;
    padding:0 16px;flex-shrink:0}
  .top .hash{color:var(--dimmer);font-size:22px}
  .top b{font-size:15px}
  .top .desc{color:var(--dimmer);font-size:13px;border-left:1px solid var(--line);padding-left:10px}
  .top .right{margin-left:auto;color:var(--dimmer);font-size:12px;display:flex;gap:12px;align-items:center}
  .scroll{flex:1;overflow-y:auto;padding:16px}
  .view{display:none}.view.on{display:block}

  /* embeds */
  .embed{background:var(--card);border-left:4px solid var(--blurple);border-radius:4px;
    padding:12px 16px;margin-bottom:12px}
  .embed.good{border-left-color:var(--green)}
  .embed.bad{border-left-color:var(--red)}
  .embed.warn{border-left-color:var(--yellow)}
  .embed .t{font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:8px}
  .embed .b{color:var(--dim);font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}
  .f .k{color:var(--dimmer);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
  .f .v{font-size:17px;font-variant-numeric:tabular-nums;margin-top:2px}
  .f .s{color:var(--dimmer);font-size:11px}

  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--dimmer);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
  th:first-child,td:first-child{text-align:left}
  tbody tr:hover{background:#3a3c42}
  .tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
  .tag.up{background:rgba(35,165,90,.18);color:#4ac57e}
  .tag.dn{background:rgba(242,63,67,.18);color:#f77}
  .tag.g{background:rgba(35,165,90,.18);color:#4ac57e}
  .tag.r{background:rgba(242,63,67,.18);color:#f77}
  .tag.y{background:rgba(240,178,50,.18);color:#f5c471}
  .tag.n{background:#4a4d55;color:var(--dim)}
  .green{color:#4ac57e}.red{color:#f77}.dim{color:var(--dimmer)}.yellow{color:#f5c471}
  .bar{height:5px;background:var(--bg3);border-radius:3px;overflow:hidden;min-width:64px;margin-top:3px}
  .bar>i{display:block;height:100%;background:var(--blurple)}
  .empty{padding:24px;text-align:center;color:var(--dimmer);font-size:14px}
  code{background:var(--bg3);padding:1px 5px;border-radius:3px;font-size:12.5px;color:#dbdee1}
</style></head><body>

<div class="rail">
  <div class="orb">CAL</div><div class="sep"></div>
  <div class="orb alt" title="paper only">📄</div>
  <div class="orb alt" title="zero money">🔒</div>
</div>

<div class="side">
  <h1><span class="dot" id="dot"></span><span id="sideTitle">Calibration Bot</span></h1>
  <div class="chans">
    <div class="cat">Trading</div>
    <div class="chan on" data-v="overview"><span class="hash">#</span>overview</div>
    <div class="chan" data-v="signals"><span class="hash">#</span>live-signals<span class="badge" id="bArmed">0</span></div>
    <div class="chan" data-v="trades"><span class="hash">#</span>trade-log<span class="badge" id="bTrades">0</span></div>
    <div class="chan" data-v="open"><span class="hash">#</span>open-positions<span class="badge" id="bOpen">0</span></div>
    <div class="cat">Analysis</div>
    <div class="chan" data-v="exec"><span class="hash">#</span>execution</div>
    <div class="chan" data-v="config"><span class="hash">#</span>config</div>
  </div>
  <div class="me"><div class="av" id="meAv">P</div>
    <div><b id="meName">paper</b><small id="meSub">zero money</small></div></div>
</div>

<main>
  <div class="top"><span class="hash">#</span><b id="topName">overview</b>
    <span class="desc" id="topDesc"></span>
    <span class="right"><span id="clock"></span></span></div>
  <div class="scroll">
    <div class="view on" id="v-overview"></div>
    <div class="view" id="v-signals"></div>
    <div class="view" id="v-trades"></div>
    <div class="view" id="v-open"></div>
    <div class="view" id="v-exec"></div>
    <div class="view" id="v-config"></div>
  </div>
</main>

<script>
const DESC = {
  overview:'live P&L, both entry styles', signals:'every contract and when it fires',
  trades:'settled trades with times', open:'positions awaiting settlement',
  exec:'grace allowance and adverse selection', config:'the frozen rules being tested'
};
let VIEW='overview';
document.querySelectorAll('.chan').forEach(c=>c.addEventListener('click',()=>{
  document.querySelectorAll('.chan').forEach(x=>x.classList.remove('on'));
  c.classList.add('on'); VIEW=c.dataset.v;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('on'));
  document.getElementById('v-'+VIEW).classList.add('on');
  document.getElementById('topName').textContent=c.textContent.replace(/[0-9]+$/,'').trim();
  document.getElementById('topDesc').textContent=DESC[VIEW]||'';
}));
document.getElementById('topDesc').textContent=DESC.overview;

const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=v=>v==null?'—':(v>=0?'+':'')+Number(v).toFixed(4);
const pct=v=>v==null?'—':(Number(v)*100).toFixed(2)+'%';
const cls=v=>v==null?'dim':v>0?'green':v<0?'red':'dim';
const mmss=s=>{if(s==null)return'—';const n=s<0;s=Math.abs(Math.round(s));
  return (n?'-':'')+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const hm=iso=>iso?esc(String(iso).slice(11,19)):'—';
const field=(k,v,s,c)=>'<div class="f"><div class="k">'+k+'</div><div class="v '+(c||'')+'">'+v+
  '</div><div class="s">'+(s||'')+'</div></div>';
const tbl=(cols,rows,empty)=>rows.length?('<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+
  '</tr></thead><tbody>'+rows.join('')+'</tbody></table>'):('<div class="empty">'+empty+'</div>');

async function tick(){
  let d; try{ d=await (await fetch('/api/ledger',{cache:'no-store'})).json(); }
  catch(e){ document.getElementById('dot').className='dot off'; return; }
  document.getElementById('clock').textContent=new Date().toLocaleTimeString();
  if(!d.ok){ document.getElementById('dot').className='dot off';
    document.getElementById('v-overview').innerHTML='<div class="embed bad"><div class="t">No ledger</div>'+
    '<div class="b">'+esc(d.error)+'</div></div>'; return; }

  const L=d.data, s=L.summary||{}, c=L.counters||{}, f=L.frozenConfig||{};
  const live=L.state==='running', stale=(Date.now()-Date.parse(L.updatedAt))/1000;
  document.getElementById('dot').className='dot'+(live&&stale<60?'':' off');
  document.getElementById('sideTitle').textContent='Calibration '+(live?'· live':'· '+esc(L.state));
  document.getElementById('meSub').textContent='zero money · pid '+esc(L.pid);

  const orders=L.orders||[], settled=orders.filter(o=>o.settled), open=orders.filter(o=>!o.settled);
  const wl=L.watchlist||[];
  const armed=wl.filter(w=>w.wouldSignal&&!w.alreadySignalled).length;
  document.getElementById('bArmed').textContent=armed;
  document.getElementById('bTrades').textContent=settled.length;
  document.getElementById('bOpen').textContent=open.length;
  ['bArmed','bTrades','bOpen'].forEach(id=>{const e=document.getElementById(id);
    e.style.display=e.textContent==='0'?'none':'';});

  // ── overview ──
  const t=s.taker||{}, pv=s.passive||{}, bs=s.bySide||{};
  const kind=(t.net==null)?'':(t.net>0?' good':(t.net<0?' bad':''));
  document.getElementById('v-overview').innerHTML=
    '<div class="embed'+kind+'"><div class="t">💰 Paper P&L <span class="tag n">no real money</span></div>'+
    '<div class="grid">'+
      field('Taker net',money(t.net),(t.n||0)+' trades · ROI '+pct(t.roi),cls(t.net))+
      field('Taker win rate',t.winRate==null?'—':pct(t.winRate),'history 86-89%')+
      field('Passive net',money(pv.net),(pv.n||0)+' fills · ROI '+pct(pv.roi),cls(pv.net))+
      field('Adverse selection',s.adverseSelectionPp==null?'—':s.adverseSelectionPp+'pp',
        'history ≈ -2.6pp',cls(s.adverseSelectionPp))+
    '</div></div>'+
    '<div class="embed"><div class="t">📊 By direction</div><div class="grid">'+
      field('UP (buy YES)',bs.up&&bs.up.taker.roi!=null?pct(bs.up.taker.roi):'—',
        (bs.up?bs.up.taker.n:0)+' trades · win '+(bs.up&&bs.up.taker.winRate!=null?pct(bs.up.taker.winRate):'—'),
        bs.up?cls(bs.up.taker.roi):'')+
      field('DOWN (buy NO)',bs.down&&bs.down.taker.roi!=null?pct(bs.down.taker.roi):'—',
        (bs.down?bs.down.taker.n:0)+' trades · marginal band',bs.down?cls(bs.down.taker.roi):'')+
    '</div></div>'+
    '<div class="embed"><div class="t">⚙️ Loop</div><div class="grid">'+
      field('Runtime',(L.observedMinutes||0).toFixed(0)+'m',esc(L.state))+
      field('Signals',String(c.signals||0),(c.decisionWindowsHit||0)+' windows evaluated')+
      field('Skipped',String((c.skippedOutOfBucket||0)+(c.skippedWideSpread||0)),
        (c.skippedOutOfBucket||0)+' off-band · '+(c.skippedWideSpread||0)+' wide spread')+
      field('Feed errors',String((c.bookErrors||0)+(c.discoverErrors||0)+(c.settleErrors||0)),
        'auth refusals '+(c.authRefusals||0))+
    '</div></div>';

  // ── live signals ──
  document.getElementById('v-signals').innerHTML=tbl(
    ['Coin','Target price','Spot now','Gap','YES mid','Spread','Closes in','Fires in','Band','Status'],
    wl.map(w=>{
      const until=w.secondsUntilDecision;
      const st=w.alreadySignalled?'<span class="tag g">traded</span>'
        :w.wouldSignal?(until>0?'<span class="tag y">armed</span>':'<span class="tag n">missed</span>')
        :w.spreadTooWide?'<span class="tag r">spread</span>':'<span class="tag n">off-band</span>';
      const gap=w.gapPct==null?'<span class="dim">—</span>':
        '<span class="'+(w.aboveTarget?'green':'red')+'">'+(w.aboveTarget?'▲ +':'▼ ')+
        Number(w.gapPct).toFixed(3)+'%</span>';
      return '<tr><td><b>'+esc(w.sym)+'</b></td><td>'+esc(w.strike)+'</td><td>'+esc(w.spot==null?'—':w.spot)+
        '</td><td>'+gap+'</td><td>'+Number(w.mid).toFixed(3)+'</td>'+
        '<td class="'+(w.spreadTooWide?'red':'dim')+'">'+w.spreadCents+'c</td>'+
        '<td>'+mmss(w.secondsLeft)+'</td>'+
        '<td>'+(until>0?mmss(until)+'<div class="bar"><i style="width:'+
          Math.max(0,Math.min(100,100-until/540*100)).toFixed(0)+'%"></i></div>':'<span class="dim">—</span>')+
        '</td><td class="'+(w.inActiveBucket?'green':'dim')+'">'+esc(w.bucket||'—')+'</td><td>'+st+'</td></tr>';
    }),'waiting for the next 15-minute interval');

  // ── trade log ──
  document.getElementById('v-trades').innerHTML=tbl(
    ['Coin','Bet','Target','Entered','Settled','Paid','Result','Taker P&L','Passive P&L'],
    settled.slice().reverse().map(o=>
      '<tr><td><b>'+esc(o.sym)+'</b> <span class="dim">'+esc(o.bucket)+'</span>'+
      (o.marginal?' <span class="tag y">marginal</span>':'')+'</td>'+
      '<td><span class="tag '+(o.side==='YES'?'up':'dn')+'">'+(o.side==='YES'?'UP ▲':'DOWN ▼')+'</span></td>'+
      '<td class="dim">'+esc(o.strike)+'</td>'+
      '<td class="dim">'+hm(o.signalAt)+'</td><td class="dim">'+hm(o.closeTime)+'</td>'+
      '<td>'+Number(o.taker.fill).toFixed(3)+'</td>'+
      '<td class="'+(o.won?'green':'red')+'">'+(o.won?'hit ✓':'miss ✗')+'</td>'+
      '<td class="'+cls(o.takerPnl)+'">'+money(o.takerPnl)+'</td>'+
      '<td class="'+cls(o.passivePnl)+'">'+(o.passivePnl==null?'<span class="dim">no fill</span>':money(o.passivePnl))+
      '</td></tr>'),'no settled trades yet — each settles ~25s after its close');

  // ── open ──
  document.getElementById('v-open').innerHTML=tbl(
    ['Coin','Bet','Target','Entered','Paid','Passive limit','Passive','Closes'],
    open.map(o=>
      '<tr><td><b>'+esc(o.sym)+'</b> <span class="dim">'+esc(o.bucket)+'</span></td>'+
      '<td><span class="tag '+(o.side==='YES'?'up':'dn')+'">'+(o.side==='YES'?'UP ▲':'DOWN ▼')+'</span></td>'+
      '<td class="dim">'+esc(o.strike)+'</td><td class="dim">'+hm(o.signalAt)+'</td>'+
      '<td>'+Number(o.taker.fill).toFixed(3)+'</td><td>'+Number(o.passive.limit).toFixed(3)+'</td>'+
      '<td>'+(o.passive.filled?'<span class="tag g">filled</span>':
        o.passive.expired?'<span class="tag n">no fill</span>':'<span class="tag y">resting</span>')+'</td>'+
      '<td class="dim">'+hm(o.closeTime)+'</td></tr>'),'no open positions');

  // ── execution ──
  const bg=s.byGrace||[];
  const best=bg.filter(g=>g.roi!=null).sort((a,b)=>b.roi-a.roi)[0];
  document.getElementById('v-exec').innerHTML=
    '<div class="embed"><div class="t">⏱️ Grace allowance — a limit order that FAILS if price runs away</div>'+
    '<div class="b">Each signal places all three at once. A wider allowance never overpays: it fills at the '+
    'prevailing ask, not the limit.'+(best?' Best so far: <code>'+best.graceCents+'c</code>.':'')+'</div></div>'+
    tbl(['Grace','Attempts','Filled','Fill rate','Mean move','Win rate','ROI'],
      bg.map(g=>'<tr><td><b>'+g.graceCents+'c</b>'+(best&&g.graceCents===best.graceCents?
        ' <span class="tag g">best</span>':'')+'</td><td>'+g.attempts+'</td><td>'+g.filled+'</td>'+
        '<td>'+(g.fillRate==null?'—':pct(g.fillRate))+'</td>'+
        '<td class="dim">'+(g.meanMoveCents==null?'—':g.meanMoveCents+'c')+'</td>'+
        '<td>'+(g.winRate==null?'—':pct(g.winRate))+'</td>'+
        '<td class="'+cls(g.roi)+'">'+(g.roi==null?'—':pct(g.roi))+'</td></tr>'),
      'no grace attempts resolved yet')+
    '<div class="embed warn" style="margin-top:12px"><div class="t">🎣 Adverse selection</div>'+
    '<div class="b">A resting bid fills when a seller comes down to it — which happens when the favourite is '+
    'weakening. Live reading <b class="'+cls(s.adverseSelectionPp)+'">'+
    (s.adverseSelectionPp==null?'—':s.adverseSelectionPp+'pp')+'</b> against a historical estimate of '+
    '-2.6pp. Passive fill rate '+(s.passiveFillRate==null?'—':pct(s.passiveFillRate))+'.</div></div>';

  // ── config ──
  const fo=f.fittedOn||{};
  document.getElementById('v-config').innerHTML=
    '<div class="embed"><div class="t">🔒 Frozen config <span class="tag n">never refit on live data</span></div>'+
    '<div class="b">Fitted on <b>'+(fo.markets||0).toLocaleString()+'</b> settled markets over <b>'+
    (fo.settlementDays||0)+'</b> days through '+esc(fo.throughDay)+'. Decide at '+
    ((f.decisionSecondsLeft||0)/60).toFixed(0)+'m left, cancel resting orders at '+
    ((f.cancelSecondsLeft||0)/60).toFixed(0)+'m, spread gate <code>'+esc(f.maxSpreadCents)+'c</code>.</div></div>'+
    tbl(['Band','Buy','Bias vs mid','Cost','Surplus','t-stat','Status'],
      (f.buckets||[]).map(b=>'<tr><td><b>'+esc(b.label)+'</b></td>'+
        '<td><span class="tag '+(b.side==='YES'?'up':'dn')+'">'+(b.side==='YES'?'UP ▲':'DOWN ▼')+'</span></td>'+
        '<td>'+Math.abs(b.biasPp).toFixed(2)+'pp</td><td class="dim">'+b.costPp+'pp</td>'+
        '<td class="green">+'+(b.surplusPp==null?'—':b.surplusPp)+'pp</td><td>'+b.t+'</td>'+
        '<td>'+(b.marginal?'<span class="tag y">marginal</span>':'<span class="tag g">confirmed</span>')+
        '</td></tr>'),'no buckets')+
    '<div class="embed bad" style="margin-top:12px"><div class="t">🚫 Live money is disabled</div>'+
    '<div class="b">Walk-forward is +3.01% at a perfect fill but +1.01% with the interval touching zero at '+
    '1c slippage, and signals arrive correlated across coins. Real money waits for a forward interval whose '+
    'lower bound is above zero on independent windows.</div></div>';
}
tick(); setInterval(tick,100);
</script></body></html>`;

function main(argv = process.argv.slice(2)) {
  const port = Number(arg(argv, '--port', DEFAULT_PORT));
  const explicit = arg(argv, '--ledger', null);

  const server = http.createServer((req, res) => {
    const url = String(req.url || '/').split('?')[0];
    if (url === '/api/ledger') {
      const file = explicit || newestLedger();
      const body = file ? readLedger(file)
        : { ok: false, error: 'no calibration paper ledger found in /tmp' };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  // Loopback only. Never bind 0.0.0.0 — this page is unauthenticated by design.
  server.listen(port, HOST, () => {
    process.stdout.write(`${JSON.stringify({
      listening: `http://${HOST}:${port}`, ledger: explicit || newestLedger(),
      bind: HOST, authentication: 'none (loopback-only socket, public market data)'
    })}\n`);
  });
  return server;
}

if (require.main === module) main();

module.exports = { DEFAULT_PORT, HOST, newestLedger, readLedger, main };
