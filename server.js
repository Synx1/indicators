const http = require('http');
const fs = require('fs');
const PORT = process.env.PORT || 3000;
const STATE = './state.json';

// Initialize state
if (!fs.existsSync(STATE)) {
  fs.writeFileSync(STATE, JSON.stringify({bankroll:100,trades:[],open:[],startedAt:new Date().toISOString()}));
}

function getState() {
  try { return JSON.parse(fs.readFileSync(STATE,'utf8')); } catch(_) { return {bankroll:100,trades:[],open:[]}; }
}

const page = () => {
  const s = getState();
  const pnl = s.trades.reduce((a,t)=>a+(t.pnl||0),0);
  const wins = s.trades.filter(t=>t.pnl>0).length;
  const losses = s.trades.filter(t=>t.pnl<=0).length;
  const recent = s.trades.slice(-20).reverse();
  
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Indicators Bot</title>
<style>
:root{--bg:#0a0a0b;--tx:#f2f2f3;--grn:#4ade80;--red:#f87171;--dim:#71717a;--line:#27272a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 system-ui,sans-serif;padding:24px}
h1{font-size:24px;background:linear-gradient(135deg,#4ade80,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.card{background:#18181b;border:1px solid var(--line);border-radius:10px;padding:16px}
.card .k{font-size:10px;text-transform:uppercase;color:var(--dim);letter-spacing:.05em}
.card .v{font-size:26px;font-weight:700;margin-top:4px}
.grn{color:var(--grn)}.red{color:var(--red)}
table{width:100%;border-collapse:collapse;margin:20px 0;font-size:13px}
th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--dim);font-size:10px;text-transform:uppercase}
.status{font-size:12px;color:var(--dim);margin-top:8px}
</style></head><body>
<h1>Indicators Bot</h1>
<p class="status">Regime-adaptive: gap + BB + candles | Cashout 95c | Stop 20c</p>
<div class="cards">
  <div class="card"><div class="k">Bankroll</div><div class="v">$${s.bankroll.toFixed(2)}</div></div>
  <div class="card"><div class="k">PNL</div><div class="v ${pnl>=0?'grn':'red'}">${pnl>=0?'+':''}$${pnl.toFixed(2)}</div></div>
  <div class="card"><div class="k">Record</div><div class="v">${wins}W/${losses}L</div></div>
  <div class="card"><div class="k">Hit Rate</div><div class="v">${s.trades.length?(wins/s.trades.length*100).toFixed(0):0}%</div></div>
  <div class="card"><div class="k">Open</div><div class="v">${s.open.length}</div></div>
</div>
<h2 style="font-size:14px;color:var(--dim)">Recent Trades</h2>
<table><thead><tr><th>Time</th><th>Coin</th><th>Dir</th><th>Entry</th><th>Result</th><th>PNL</th></tr></thead><tbody>
${recent.map(t=>`<tr><td style="color:var(--dim)">${new Date(t.settledAt||t.enteredAt).toLocaleTimeString()}</td><td><b>${t.sym}</b></td><td class="${t.direction==='UP'?'grn':'red'}">${t.direction}</td><td>${(t.price*100).toFixed(0)}c</td><td>${t.result==='CASHOUT'?'💰':t.result==='WIN'?'✅':t.result==='STOPPED'?'🛑':'❌'} ${t.result}</td><td class="${t.pnl>0?'grn':'red'}">${t.pnl>0?'+':''}$${t.pnl.toFixed(2)}</td></tr>`).join('')}
</tbody></table>
<h2 style="font-size:14px;color:var(--dim)">Open Positions</h2>
${s.open.length?s.open.map(o=>`<div class="card"><div class="k">${o.sym} ${o.direction}</div><div class="v">${(o.price*100).toFixed(0)}c → 95c</div></div>`).join(''):'<p style="color:var(--dim)">None</p>'}
<script>setTimeout(()=>location.reload(),10000)</script>
</body></html>`;
};

const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify(getState()));
  }
  res.writeHead(200,{'content-type':'text/html'});
  res.end(page());
});

server.listen(PORT, '0.0.0.0', () => console.log('Dashboard on port ' + PORT));
