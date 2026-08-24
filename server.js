const http = require('http');
const fs = require('fs');
const STATE_FILE = './state.json';

function getState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(_) { return { bankroll: 100, trades: [], open: [] }; }
}

function buildPage() {
  const s = getState();
  const wins = s.trades.filter(t => t.pnl > 0);
  const losses = s.trades.filter(t => t.pnl <= 0);
  const pnl = s.trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const hitRate = s.trades.length > 0 ? Math.round(wins.length / s.trades.length * 100) : 0;
  
  // Time analysis
  const byHour = {};
  for (const t of s.trades) {
    const h = new Date(t.enteredAt).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'America/New_York' });
    if (!byHour[h]) byHour[h] = { w: 0, l: 0, pnl: 0 };
    if (t.pnl > 0) byHour[h].w++; else byHour[h].l++;
    byHour[h].pnl += t.pnl || 0;
  }
  
  // By coin
  const byCoin = {};
  for (const t of s.trades) {
    if (!byCoin[t.sym]) byCoin[t.sym] = { w: 0, l: 0, pnl: 0 };
    if (t.pnl > 0) byCoin[t.sym].w++; else byCoin[t.sym].l++;
    byCoin[t.sym].pnl += t.pnl || 0;
  }
  
  // By entry type
  const byType = { dip: { w: 0, l: 0, pnl: 0 }, chase: { w: 0, l: 0, pnl: 0 } };
  for (const t of s.trades) {
    const key = (t.entryType || '').includes('dip') ? 'dip' : 'chase';
    if (t.pnl > 0) byType[key].w++; else byType[key].l++;
    byType[key].pnl += t.pnl || 0;
  }
  
  // By direction
  const byDir = { UP: { w: 0, l: 0, pnl: 0 }, DOWN: { w: 0, l: 0, pnl: 0 } };
  for (const t of s.trades) {
    const d = t.direction || 'UP';
    if (t.pnl > 0) byDir[d].w++; else byDir[d].l++;
    byDir[d].pnl += t.pnl || 0;
  }

  // By confidence tier
  const byConf = { probe: { w:0, l:0, pnl:0, label:'10sh (40-49)' }, med: { w:0, l:0, pnl:0, label:'30sh (50-69)' }, high: { w:0, l:0, pnl:0, label:'60sh (70-89)' }, max: { w:0, l:0, pnl:0, label:'100sh (90+)' } };
  for (const t of s.trades) {
    const c = t.confidence || 50;
    const tier = c >= 90 ? 'max' : c >= 70 ? 'high' : c >= 50 ? 'med' : 'probe';
    if (t.pnl > 0) byConf[tier].w++; else byConf[tier].l++;
    byConf[tier].pnl += t.pnl || 0;
  }

  // Best timeframe recommendation
  let bestHour = null, bestPnl = -Infinity;
  for (const [h, d] of Object.entries(byHour)) {
    if (d.pnl > bestPnl && (d.w + d.l) >= 3) { bestPnl = d.pnl; bestHour = h; }
  }

  const hourRows = Object.entries(byHour).map(([h, d]) => {
    const total = d.w + d.l;
    const rate = total > 0 ? Math.round(d.w / total * 100) : 0;
    const isBest = h === bestHour;
    return `<tr class="${isBest ? 'best' : ''} ${d.pnl >= 0 ? 'green' : 'red'}"><td>${h}</td><td>${d.w}W/${d.l}L</td><td>${rate}%</td><td>${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}</td></tr>`;
  }).join('');

  const coinRows = Object.entries(byCoin).map(([sym, d]) => {
    const total = d.w + d.l;
    const rate = total > 0 ? Math.round(d.w / total * 100) : 0;
    return `<tr class="${d.pnl >= 0 ? 'green' : 'red'}"><td>${sym}</td><td>${d.w}W/${d.l}L</td><td>${rate}%</td><td>${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)}</td></tr>`;
  }).join('');

  const tradeRows = s.trades.slice(-20).reverse().map(t => {
    const time = new Date(t.enteredAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    const emoji = t.pnl > 0 ? '✅' : '❌';
    return `<tr class="${t.pnl > 0 ? 'green' : 'red'}"><td>${emoji}</td><td>${time}</td><td>${t.sym}</td><td>${t.direction}</td><td>${Math.round(t.price*100)}c</td><td>${t.shares}sh</td><td>${t.entryType || ''}</td><td>${t.pnl >= 0 ? '+' : ''}$${(t.pnl||0).toFixed(2)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>V6 Momentum Bot</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:-apple-system,sans-serif;padding:20px}
h1{color:#fff;font-size:1.8em;margin-bottom:5px}
.subtitle{color:#888;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.card{background:#12121a;border:1px solid #222;border-radius:12px;padding:20px}
.card h2{color:#aaa;font-size:0.85em;text-transform:uppercase;margin-bottom:12px;letter-spacing:1px}
.big{font-size:2.2em;font-weight:700}
.green{color:#00e676}.red{color:#ff5252}
.stat-row{display:flex;justify-content:space-between;margin:8px 0}
.stat-label{color:#888}
table{width:100%;border-collapse:collapse;font-size:0.85em}
th{text-align:left;color:#666;padding:8px 6px;border-bottom:1px solid #222}
td{padding:8px 6px;border-bottom:1px solid #111}
tr.best{background:#1a2e1a;border-left:3px solid #00e676}
tr.green td:last-child{color:#00e676}
tr.red td:last-child{color:#ff5252}
.recommendation{background:linear-gradient(135deg,#1a2e1a,#0a1a0a);border:1px solid #00e676;border-radius:12px;padding:20px;margin-bottom:24px}
.recommendation h2{color:#00e676;margin-bottom:8px}
.open{background:#1a1a2e;border-color:#448aff}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75em;margin-right:4px}
.tag-dip{background:#1a2e1a;color:#00e676}
.tag-chase{background:#2e1a1a;color:#ff9100}
.refresh{color:#555;font-size:0.8em;margin-top:20px}
</style></head><body>
<h1>⚡ V6 Momentum Bot</h1>
<p class="subtitle">React to moves. Scale in. Asymmetric risk.</p>

<div class="grid">
  <div class="card">
    <h2>Bankroll</h2>
    <div class="big ${pnl >= 0 ? 'green' : 'red'}">$${s.bankroll.toFixed(2)}</div>
    <div class="stat-row"><span class="stat-label">PNL</span><span class="${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span></div>
    <div class="stat-row"><span class="stat-label">ROI</span><span>${((s.bankroll - 100) / 100 * 100).toFixed(1)}%</span></div>
  </div>
  <div class="card">
    <h2>Performance</h2>
    <div class="big">${wins.length}W / ${losses.length}L</div>
    <div class="stat-row"><span class="stat-label">Win Rate</span><span>${hitRate}%</span></div>
    <div class="stat-row"><span class="stat-label">Avg Win</span><span class="green">+$${wins.length ? (wins.reduce((a,t)=>a+t.pnl,0)/wins.length).toFixed(2) : '0'}</span></div>
    <div class="stat-row"><span class="stat-label">Avg Loss</span><span class="red">-$${losses.length ? Math.abs(losses.reduce((a,t)=>a+t.pnl,0)/losses.length).toFixed(2) : '0'}</span></div>
  </div>
  <div class="card">
    <h2>Entry Type</h2>
    <div class="stat-row"><span class="tag tag-dip">📉 Bought Dip</span><span>${byType.dip.w}W/${byType.dip.l}L | ${byType.dip.pnl>=0?'+':''}$${byType.dip.pnl.toFixed(2)}</span></div>
    <div class="stat-row"><span class="tag tag-chase">🚀 Chased Move</span><span>${byType.chase.w}W/${byType.chase.l}L | ${byType.chase.pnl>=0?'+':''}$${byType.chase.pnl.toFixed(2)}</span></div>
    <div style="margin-top:12px"><h2>Direction</h2></div>
    <div class="stat-row"><span>📈 UP</span><span>${byDir.UP.w}W/${byDir.UP.l}L | ${byDir.UP.pnl>=0?'+':''}$${byDir.UP.pnl.toFixed(2)}</span></div>
    <div class="stat-row"><span>📉 DOWN</span><span>${byDir.DOWN.w}W/${byDir.DOWN.l}L | ${byDir.DOWN.pnl>=0?'+':''}$${byDir.DOWN.pnl.toFixed(2)}</span></div>
  </div>
</div>

${bestHour ? `<div class="recommendation"><h2>🎯 Best Timeframe</h2><p><strong>${bestHour} ET</strong> — +$${bestPnl.toFixed(2)} PNL (${byHour[bestHour].w}W/${byHour[bestHour].l}L). Trade hardest during this window.</p></div>` : '<div class="recommendation"><h2>🎯 Best Timeframe</h2><p>Need more data (3+ trades per hour) to recommend. Keep running.</p></div>'}

${s.open.length ? `<div class="card open"><h2>⏳ Open Positions (${s.open.length})</h2><table><tr><th>Coin</th><th>Dir</th><th>Entry</th><th>Shares</th><th>Conf</th><th>Type</th></tr>${s.open.map(o => `<tr><td>${o.sym}</td><td>${o.direction}</td><td>${Math.round(o.price*100)}c</td><td>${o.shares}</td><td>${o.confidence||'?'}</td><td>${o.entryType||''}</td></tr>`).join('')}</table></div>` : ''}

<div class="grid">
  <div class="card">
    <h2>📊 By Hour (ET)</h2>
    <table><tr><th>Hour</th><th>Record</th><th>Win%</th><th>PNL</th></tr>${hourRows || '<tr><td colspan=4>No data yet</td></tr>'}</table>
  </div>
  <div class="card">
    <h2>🪙 By Coin</h2>
    <table><tr><th>Coin</th><th>Record</th><th>Win%</th><th>PNL</th></tr>${coinRows || '<tr><td colspan=4>No data yet</td></tr>'}</table>
  </div>
</div>

<div class="card" style="margin-top:16px">
  <h2>📜 Recent Trades (last 20)</h2>
  <table><tr><th></th><th>Time</th><th>Coin</th><th>Dir</th><th>Entry</th><th>Size</th><th>Type</th><th>PNL</th></tr>${tradeRows || '<tr><td colspan=8>No trades yet</td></tr>'}</table>
</div>

<div class="card" style="margin-top:16px">
  <h2>📈 Confidence Tiers</h2>
  <table><tr><th>Tier</th><th>Record</th><th>PNL</th></tr>
  ${Object.entries(byConf).map(([k,d]) => `<tr class="${d.pnl>=0?'green':'red'}"><td>${d.label}</td><td>${d.w}W/${d.l}L</td><td>${d.pnl>=0?'+':''}$${d.pnl.toFixed(2)}</td></tr>`).join('')}
  </table>
</div>

<p class="refresh">Auto-refreshes every 30s. Started ${new Date(s.startedAt).toLocaleString('en-US', {timeZone:'America/New_York'})}</p>
<script>setTimeout(()=>location.reload(), 30000)</script>
</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(STATE_FILE, 'utf8'));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildPage());
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Dashboard on port ${process.env.PORT || 3000}`);
});
