const http = require('http');
const fs = require('fs');
const STATE_FILE = './state.json';

const server = http.createServer((req, res) => {
  let state = { bankroll: 100, trades: [], open: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
  
  const wins = state.trades.filter(t => t.pnl > 0).length;
  const losses = state.trades.filter(t => t.pnl <= 0).length;
  const pnl = state.trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const hitRate = state.trades.length > 0 ? Math.round(wins / state.trades.length * 100) : 0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    version: 'V5 Time-Drift/Fade',
    bankroll: state.bankroll,
    trades: state.trades.length,
    open: state.open.length,
    wins, losses, hitRate, pnl: pnl.toFixed(2),
    lastTrades: state.trades.slice(-5).reverse(),
    openPositions: state.open
  }));
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Health check on port ${process.env.PORT || 3000}`);
});
