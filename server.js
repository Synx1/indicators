const http = require('http');
const fs = require('fs');
const path = require('path');

// Read state from the same place bot.js writes it — the Railway volume (/data)
// when attached, else the local dir. This MUST match bot.js's resolution, or the
// dashboard would read a stale/empty file while the bot writes to the volume.
const DATA_DIR = process.env.STATE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync('/data') ? '/data' : '.');
const STATE_FILE = `${DATA_DIR}/state.json`;

function getState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(_) { return { bankroll: 100, trades: [], open: [] }; }
}

// The dashboard is a self-contained client-side app (dashboard.html) that fetches
// /api/state and renders all tabs + charts in the browser. Serving it as a static
// file — rather than building the HTML here with template literals — keeps the
// client's own backticks and ${} out of the server's string, which is what made
// the old buildPage() brittle. Read from disk per request so a redeploy that
// ships a new dashboard.html is picked up without a code change here.
const DASHBOARD = path.join(__dirname, 'dashboard.html');
function page() {
  try { return fs.readFileSync(DASHBOARD, 'utf8'); }
  catch(_) { return '<!doctype html><meta charset=utf-8><body style="font:16px sans-serif;background:#0a0c11;color:#e6e9ef;padding:40px">Dashboard file missing. <a style="color:#5b9dff" href="/api/state">/api/state</a> is still live.</body>'; }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getState()));
  } else if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page());
  }
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Dashboard on port ${process.env.PORT || 3000}`);
});
