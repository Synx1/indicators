/**
 * The HTTP server for the dashboard.
 *
 * Split from the page and the data so each can be checked on its own: sitepage.js is markup,
 * sitedata.js is arithmetic, this is routing and the privacy boundary.
 *
 * Never throws into the caller — a dashboard fault must not touch the trading loop.
 */

const http = require('http');
const page = require('./sitepage');
const data = require('./sitedata');
const { WEB_TOKEN, PORT } = require('./config');

function start(opts = {}) {
  const log = opts.log || (() => {});
  const port = Number(opts.port || PORT || 3000);
  const token = (opts.token || WEB_TOKEN || '').trim();

  const authed = req => {
    if (!token) return false;                 // no token configured = private stays private
    try {
      const u = new URL(req.url, 'http://x');
      return u.searchParams.get('key') === token || req.headers['x-web-key'] === token;
    } catch (_) { return false; }
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    try {
      const path = (req.url || '/').split('?')[0];
      if (path === '/health') return json(res, 200, { ok: true });

      // Open: what the BOT decided. No account, no name, no balance.
      if (path === '/api/state') return json(res, 200, data.publicState());
      if (path === '/api/decisions') return json(res, 200, data.decisions(250));

      // Private: anything naming a person or their money. Closed by default when no token is
      // configured, because the safe answer to "is this secret" is yes.
      if (path === '/api/trades') {
        if (!authed(req)) return json(res, 401, { error: 'token required' });
        return json(res, 200, data.trades(300));
      }
      if (path === '/api/accounts') {
        if (!authed(req)) return json(res, 401, { error: 'token required' });
        return json(res, 200, data.accounts());
      }

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      try { json(res, 500, { error: e.message }); } catch (_) { /* socket already gone */ }
    }
  });

  server.on('error', e => log(`  !! site could not listen on ${port}: ${e.message}`));
  server.listen(port, '0.0.0.0', () => {
    log(`  site       http://0.0.0.0:${port}` +
      (token ? '  (Trades and Accounts need ?key=)' : '  (no WEB_TOKEN — Decisions only)'));
  });
  return server;
}

module.exports = { start };
