/**
 * The HTTP server for the dashboard.
 *
 * Split from the page and the data so each can be checked on its own: sitepage.js is markup,
 * sitedata.js is arithmetic, this is routing and the privacy boundary.
 *
 * Never throws into the caller — a dashboard fault must not touch the trading loop.
 */

const http = require('http');
const crypto = require('crypto');
const page = require('./sitepage');
const data = require('./sitedata');
const { WEB_TOKEN, PORT } = require('./config');

function start(opts = {}) {
  const log = opts.log || (() => {});
  const port = Number(opts.port || PORT || 3000);
  const token = (opts.token || WEB_TOKEN || '').trim();

  // Constant-time compare, so the gate cannot be probed a byte at a time. Network jitter already
  // swamps a string-compare difference, but this costs one function and removes the question.
  const sameToken = v => {
    if (typeof v !== 'string' || v.length !== token.length) return false;
    const a = Buffer.from(v), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const authed = req => {
    if (!token) return false;                 // no token configured = private stays private
    try {
      const u = new URL(req.url, 'http://x');
      return sameToken(u.searchParams.get('key')) || sameToken(req.headers['x-web-key']);
    } catch (_) { return false; }
  };
  const json = (res, code, obj) => {
    // Serialise BEFORE the headers go out. With writeHead first, a payload that cannot be stringified
    // — a cycle, a BigInt — threw between the header and the body and left the socket open with no
    // response at all: one hung request per fault, and a dashboard row that silently never fills.
    let body, status = code;
    try {
      body = JSON.stringify(obj);
    } catch (e) {
      log(`  !! site could not serialise a ${code} payload: ${e.message}`);
      body = '{"error":"payload could not be serialised"}'; status = 500;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    try {
      const path = (req.url || '/').split('?')[0];
      if (path === '/health') return json(res, 200, { ok: true });

      // Open: what the BOT decided. No account, no name, no balance.
      //
      // /api/decisions is gate-AWARE rather than gated: the same route serves the full feed to a
      // request carrying the token and a redacted one to everybody else. It used to serve the raw
      // activity ring, which carried account handles, Discord user IDs and per-trade money — see
      // sitedata.redactEvent. Gating it outright would have hidden the skip feed that is the whole
      // point of the open tab; redacting keeps the reasoning public and the people private.
      if (path === '/api/state') return json(res, 200, data.publicState());
      if (path === '/api/decisions') return json(res, 200, data.decisions(250, { redact: !authed(req) }));

      // Open for the same reason as /api/decisions: a price, a strike, a quote, an indicator and the
      // bot's own verdict are market facts. The buy/sell marks drawn on top of this come from
      // /api/trades, which stays gated, so an unauthenticated chart has no fills on it.
      if (path === '/api/series') {
        let sym = '';
        try { sym = new URL(req.url, 'http://x').searchParams.get('sym') || ''; } catch (_) { sym = ''; }
        return json(res, 200, data.seriesFor(String(sym).toUpperCase(), 720));
      }

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
      if (path === '/api/hours') {
        if (!authed(req)) return json(res, 401, { error: 'token required' });
        return json(res, 200, data.hours());
      }
      // Gated for the same reason as /api/hours: the buckets carry realised net dollars. The gate
      // question itself is generic, but the answer is this book's money.
      if (path === '/api/gates') {
        if (!authed(req)) return json(res, 401, { error: 'token required' });
        return json(res, 200, data.gates());
      }
      // Gated because it reads every account's settings and bankroll back to the caller. The
      // recommendations themselves are generic arithmetic, but the CURRENT column is private.
      if (path === '/api/recommend') {
        if (!authed(req)) return json(res, 401, { error: 'token required' });
        return json(res, 200, data.recommendations());
      }

      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      // A FIXED body. The exception text carries absolute data-dir paths and dependency internals,
      // and every route here is reachable unauthenticated, so it went to the log — where it is
      // actually useful — rather than to the caller.
      log(`  !! site failed on ${(req && req.url) || '?'}: ${e && e.message}`);
      try { json(res, 500, { error: 'request failed' }); } catch (_) { /* socket already gone */ }
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
