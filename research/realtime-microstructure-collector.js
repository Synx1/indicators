#!/usr/bin/env node
'use strict';

/**
 * Credential-free, observe-only microstructure collector.
 *
 * The target is not raw crypto direction. It is the residual probability of a 15-minute Kalshi
 * contract settling YES after conditioning on the contemporaneous Kalshi book. The historical
 * project data contain minute closes, not the event path needed to test that hypothesis, so this
 * collector creates the missing forward-only population without touching credentials or orders.
 *
 * Sources:
 *   - Coinbase public Advanced Trade WebSocket: guaranteed-delivery L2 updates and public trades.
 *     Raw events are reduced into receive-time one-second frames so future research cannot use an
 *     exchange timestamp before the event was actually observable.
 *   - Kalshi public REST: full YES/NO bid ladders. Kalshi's delta WebSocket requires authentication;
 *     this process deliberately does not read a key, so two-second snapshots are the honest limit.
 *
 * Example:
 *   node research/realtime-microstructure-collector.js --minutes 10080 \
 *     --out /tmp/indicators-microstructure.jsonl \
 *     --status-out /tmp/indicators-microstructure.status.json
 *
 * JSONL is append-only. Every record has source and receive timing where the upstream source makes
 * both available. No component imports production config, user state, auth, or an order client.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');

const SCHEMA_VERSION = 1;
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const COINBASE_WS = 'wss://advanced-trade-ws.coinbase.com';
const SERIES = [
  { sym: 'BTC', series: 'KXBTC15M', product: 'BTC-USD' },
  { sym: 'ETH', series: 'KXETH15M', product: 'ETH-USD' },
  { sym: 'SOL', series: 'KXSOL15M', product: 'SOL-USD' },
  { sym: 'XRP', series: 'KXXRP15M', product: 'XRP-USD' },
  { sym: 'BNB', series: 'KXBNB15M', product: null },
  { sym: 'DOGE', series: 'KXDOGE15M', product: 'DOGE-USD' },
  { sym: 'HYPE', series: 'KXHYPE15M', product: null }
];
const PRODUCTS = SERIES.map(x => x.product).filter(Boolean);
const FRAME_MS = 1000;
const DEFAULT_BOOK_POLL_MS = 2000;
const DISCOVER_MS = 15000;
const SETTLE_MS = 30000;
const STATUS_MS = 15000;
const MAX_ACTIVE_MINUTES = 17;
/** Retain far more depth than the widest modeled feature without scanning absurd tail quotes. */
const RETAIN_BPS = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const num = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const sourceMs = value => {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) ? n : null;
};

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}

class JsonlWriter {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.output = fs.createWriteStream(this.file, { flags: 'a' });
    this.compressed = this.file.endsWith('.gz');
    this.stream = this.compressed ? zlib.createGzip({ level: 6 }) : this.output;
    if (this.compressed) this.stream.pipe(this.output);
    this.records = 0;
    this.bytes = 0;
    this.backpressureEvents = 0;
    this.error = null;
    this.closed = false;
    const fail = error => { this.error = error; };
    this.stream.on('error', fail);
    if (this.output !== this.stream) this.output.on('error', fail);
  }

  write(record) {
    if (this.closed) return false;
    const line = JSON.stringify({ v: SCHEMA_VERSION, ...record }) + '\n';
    this.records++;
    this.bytes += Buffer.byteLength(line);
    if (!this.stream.write(line)) this.backpressureEvents++;
    return true;
  }

  end() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (!this.compressed) return new Promise(resolve => this.stream.end(resolve));
    // Wait for the FILE stream, not merely gzip's readable side, so a complete status really means
    // the compressed trailer and every prior record are durable.
    return new Promise(resolve => {
      this.output.once('finish', resolve);
      this.stream.end();
    });
  }
}

function normalizeBookSide(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'bid' || s === 'buy') return 'bid';
  if (s === 'ask' || s === 'offer' || s === 'sell') return 'ask';
  return null;
}

/** In-memory Coinbase book. Snapshot loads never count as order flow. */
class L2Book {
  constructor(product) {
    this.product = product;
    this.bids = new Map();
    this.asks = new Map();
    this.ready = false;
  }

  best(side) {
    const map = side === 'bid' ? this.bids : this.asks;
    let out = side === 'bid' ? -Infinity : Infinity;
    for (const p of map.keys()) out = side === 'bid' ? Math.max(out, p) : Math.min(out, p);
    return Number.isFinite(out) ? out : null;
  }

  top() {
    const bid = this.best('bid');
    const ask = this.best('ask');
    return {
      bid,
      ask,
      mid: bid != null && ask != null ? (bid + ask) / 2 : null
    };
  }

  /** Whether a changed level was observable at the touch or within a normalized bps band. */
  static inBand(side, price, top, bps) {
    if (!top || top.bid == null || top.ask == null || top.mid == null) return false;
    if (bps === 0) return side === 'bid' ? price === top.bid : price === top.ask;
    return side === 'bid'
      ? price >= top.bid - top.mid * bps / 10000
      : price <= top.ask + top.mid * bps / 10000;
  }

  static inRetention(side, price, top) {
    const best = side === 'bid' ? top && top.bid : top && top.ask;
    if (best == null) return true;
    return side === 'bid'
      ? price >= best * (1 - RETAIN_BPS / 10000)
      : price <= best * (1 + RETAIN_BPS / 10000);
  }

  apply(updates, { snapshot = false } = {}) {
    const parsed = [];
    for (const update of Array.isArray(updates) ? updates : []) {
      const side = normalizeBookSide(update && update.side);
      const price = num(update && (update.price_level ?? update.price));
      const quantity = num(update && (update.new_quantity ?? update.quantity ?? update.size));
      if (!side || !(price > 0) || quantity == null || quantity < 0) continue;
      parsed.push({ side, price, quantity });
    }

    if (snapshot) {
      this.bids.clear();
      this.asks.clear();
      let bid = null, ask = null;
      for (const row of parsed) {
        if (!(row.quantity > 0)) continue;
        if (row.side === 'bid') bid = bid == null ? row.price : Math.max(bid, row.price);
        else ask = ask == null ? row.price : Math.min(ask, row.price);
      }
      const top = { bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : null };
      for (const row of parsed) {
        if (!(row.quantity > 0) || !L2Book.inRetention(row.side, row.price, top)) continue;
        (row.side === 'bid' ? this.bids : this.asks).set(row.price, row.quantity);
      }
      this.ready = this.bids.size > 0 && this.asks.size > 0;
      return { touch: 0, bps5: 0, bps10: 0, absolute: 0, updates: parsed.length };
    }

    const before = this.top();
    const changes = new Map();
    for (const row of parsed) {
      const map = row.side === 'bid' ? this.bids : this.asks;
      // Ignore untouched tail levels. Existing retained levels and any new price near/better than the
      // current touch remain tracked; a later reconnect refreshes the retained one-percent envelope.
      if (!map.has(row.price) && row.quantity > 0 && !L2Book.inRetention(row.side, row.price, before)) continue;
      const key = `${row.side}|${row.price}`;
      if (!changes.has(key)) changes.set(key, {
        side: row.side, price: row.price, old: map.get(row.price) || 0, next: row.quantity
      });
      else changes.get(key).next = row.quantity;
      if (row.quantity === 0) map.delete(row.price);
      else map.set(row.price, row.quantity);
    }
    const after = this.top();
    const flow = { touch: 0, bps5: 0, bps10: 0, absolute: 0, updates: parsed.length };
    for (const change of changes.values()) {
      // Positive always means pressure toward a higher underlying price: bid added or ask removed.
      const signed = change.side === 'bid' ? change.next - change.old : change.old - change.next;
      flow.absolute += Math.abs(signed);
      for (const [name, bps] of [['touch', 0], ['bps5', 5], ['bps10', 10]]) {
        if (L2Book.inBand(change.side, change.price, before, bps) ||
            L2Book.inBand(change.side, change.price, after, bps)) flow[name] += signed;
      }
    }
    this.ready = this.bids.size > 0 && this.asks.size > 0;
    return flow;
  }

  prune(top) {
    for (const price of this.bids.keys()) if (!L2Book.inRetention('bid', price, top)) this.bids.delete(price);
    for (const price of this.asks.keys()) if (!L2Book.inRetention('ask', price, top)) this.asks.delete(price);
  }

  features() {
    const { bid, ask, mid } = this.top();
    if (!this.ready || bid == null || ask == null || !(ask >= bid)) {
      return { ready: false, bid, ask, mid, spreadBps: null };
    }
    this.prune({ bid, ask, mid });
    const bidTouch = this.bids.get(bid) || 0;
    const askTouch = this.asks.get(ask) || 0;
    const depth = bps => {
      let bidSize = 0, askSize = 0;
      for (const [price, size] of this.bids) if (price >= bid - mid * bps / 10000) bidSize += size;
      for (const [price, size] of this.asks) if (price <= ask + mid * bps / 10000) askSize += size;
      const total = bidSize + askSize;
      return {
        bid: +bidSize.toFixed(8), ask: +askSize.toFixed(8),
        imbalance: total > 0 ? +((bidSize - askSize) / total).toFixed(8) : null
      };
    };
    const touchTotal = bidTouch + askTouch;
    const microprice = touchTotal > 0 ? (ask * bidTouch + bid * askTouch) / touchTotal : mid;
    return {
      ready: true,
      bid, ask, mid,
      spreadBps: mid > 0 ? +((ask - bid) / mid * 10000).toFixed(6) : null,
      bidTouch: +bidTouch.toFixed(8), askTouch: +askTouch.toFixed(8),
      touchImbalance: touchTotal > 0 ? +((bidTouch - askTouch) / touchTotal).toFixed(8) : null,
      microprice: +microprice.toFixed(8),
      micropriceOffsetBps: mid > 0 ? +((microprice - mid) / mid * 10000).toFixed(6) : null,
      depth5Bps: depth(5), depth10Bps: depth(10),
      levels: { bid: this.bids.size, ask: this.asks.size, retainedBps: RETAIN_BPS }
    };
  }
}

function createFrameMetrics() {
  return {
    sourceFirstMs: null, sourceLastMs: null, recvFirstMs: null, recvLastMs: null,
    messages: 0, l2Events: 0, l2Updates: 0, sequenceGaps: 0,
    flow: { touch: 0, bps5: 0, bps10: 0, absolute: 0 },
    trades: 0, tradeBase: 0, tradeNotional: 0,
    reportedBuyBase: 0, reportedSellBase: 0, unknownSideBase: 0
  };
}

function touchTiming(metrics, srcMs, recvMs) {
  if (srcMs != null) {
    metrics.sourceFirstMs = metrics.sourceFirstMs == null ? srcMs : Math.min(metrics.sourceFirstMs, srcMs);
    metrics.sourceLastMs = metrics.sourceLastMs == null ? srcMs : Math.max(metrics.sourceLastMs, srcMs);
  }
  metrics.recvFirstMs = metrics.recvFirstMs == null ? recvMs : Math.min(metrics.recvFirstMs, recvMs);
  metrics.recvLastMs = metrics.recvLastMs == null ? recvMs : Math.max(metrics.recvLastMs, recvMs);
}

function addTradeToFrame(metrics, trade) {
  const size = num(trade && trade.size);
  const price = num(trade && trade.price);
  if (!(size > 0) || !(price > 0)) return false;
  metrics.trades++;
  metrics.tradeBase += size;
  metrics.tradeNotional += size * price;
  const side = String(trade.side || '').toUpperCase();
  // Coinbase labels this field only as the reported market-trade side. We retain that wording rather
  // than silently claiming it is aggressor side; the L2-derived OFI has unambiguous direction.
  if (side === 'BUY') metrics.reportedBuyBase += size;
  else if (side === 'SELL') metrics.reportedSellBase += size;
  else metrics.unknownSideBase += size;
  return true;
}

class CoinbaseFeed {
  constructor({ products, writer, counters, frameMs = FRAME_MS, now = Date.now() }) {
    this.products = products;
    this.writer = writer;
    this.counters = counters;
    this.frameMs = frameMs;
    this.books = new Map(products.map(product => [product, new L2Book(product)]));
    this.frames = new Map(products.map(product => [product, createFrameMetrics()]));
    this.nextFrameEnd = Math.floor(now / frameMs) * frameMs + frameMs;
    this.lastSequence = null;
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  roll(now) {
    while (this.nextFrameEnd <= now) {
      const end = this.nextFrameEnd;
      for (const product of this.products) {
        const metrics = this.frames.get(product);
        const book = this.books.get(product).features();
        const normalizer5 = book.ready ? book.depth5Bps.bid + book.depth5Bps.ask : 0;
        const normalizer10 = book.ready ? book.depth10Bps.bid + book.depth10Bps.ask : 0;
        this.writer.write({
          kind: 'coinbase_frame', source: 'coinbase_advanced_trade', product,
          bucketStartMs: end - this.frameMs, bucketEndMs: end,
          bucketStart: iso(end - this.frameMs), bucketEnd: iso(end),
          sourceFirstMs: metrics.sourceFirstMs, sourceLastMs: metrics.sourceLastMs,
          recvFirstMs: metrics.recvFirstMs, recvLastMs: metrics.recvLastMs,
          messages: metrics.messages, l2Events: metrics.l2Events,
          l2Updates: metrics.l2Updates, sequenceGaps: metrics.sequenceGaps,
          flow: {
            touch: +metrics.flow.touch.toFixed(8),
            bps5: +metrics.flow.bps5.toFixed(8),
            bps10: +metrics.flow.bps10.toFixed(8),
            absolute: +metrics.flow.absolute.toFixed(8),
            bps5Normalized: normalizer5 > 0 ? +(metrics.flow.bps5 / normalizer5).toFixed(8) : null,
            bps10Normalized: normalizer10 > 0 ? +(metrics.flow.bps10 / normalizer10).toFixed(8) : null
          },
          trade: {
            count: metrics.trades,
            base: +metrics.tradeBase.toFixed(8),
            notional: +metrics.tradeNotional.toFixed(2),
            reportedBuyBase: +metrics.reportedBuyBase.toFixed(8),
            reportedSellBase: +metrics.reportedSellBase.toFixed(8),
            unknownSideBase: +metrics.unknownSideBase.toFixed(8)
          },
          book
        });
        this.frames.set(product, createFrameMetrics());
        this.counters.coinbaseFrames++;
      }
      this.nextFrameEnd += this.frameMs;
    }
  }

  markSequence(sequence) {
    const seq = num(sequence);
    if (seq == null) return 0;
    // Advanced Trade numbers every message on the CONNECTION, across l2_data, trades,
    // subscriptions and heartbeats. Tracking one counter per channel fabricates gaps whenever another
    // channel occupies the intervening number (observed directly in the public feed).
    const prior = this.lastSequence;
    this.lastSequence = seq;
    const gaps = prior != null && seq > prior + 1 ? seq - prior - 1 : 0;
    if (gaps > 0) {
      this.counters.coinbaseSequenceGaps += gaps;
      // A connection-level gap cannot be attributed to one product, so every frame is marked.
      for (const product of this.products) this.frames.get(product).sequenceGaps += gaps;
    }
    return gaps;
  }

  onMessage(raw, recvMs = Date.now()) {
    this.roll(recvMs); // receive-time buckets: nothing can land before it was observable locally
    let message;
    try { message = JSON.parse(String(raw)); }
    catch (_) { this.counters.coinbaseParseErrors++; return false; }
    const channel = String(message.channel || message.type || 'unknown');
    const src = sourceMs(message.timestamp);
    const touched = new Set();

    if (channel === 'l2_data') {
      for (const event of Array.isArray(message.events) ? message.events : []) {
        const updates = Array.isArray(event.updates) ? event.updates : [];
        const product = event.product_id || (updates[0] && updates[0].product_id);
        if (!this.books.has(product)) continue;
        const frame = this.frames.get(product);
        touchTiming(frame, src, recvMs);
        frame.l2Events++;
        const flow = this.books.get(product).apply(updates, { snapshot: event.type === 'snapshot' });
        frame.l2Updates += flow.updates;
        for (const key of ['touch', 'bps5', 'bps10', 'absolute']) frame.flow[key] += flow[key];
        touched.add(product);
      }
    } else if (channel === 'market_trades') {
      for (const event of Array.isArray(message.events) ? message.events : []) {
        for (const trade of Array.isArray(event.trades) ? event.trades : []) {
          const product = trade.product_id || event.product_id;
          if (!this.frames.has(product)) continue;
          const frame = this.frames.get(product);
          touchTiming(frame, sourceMs(trade.time) ?? src, recvMs);
          addTradeToFrame(frame, trade);
          touched.add(product);
        }
      }
    } else if (channel === 'heartbeats') {
      this.counters.coinbaseHeartbeats++;
    } else if (message.type === 'error' || channel === 'error') {
      this.counters.coinbaseSourceErrors++;
      this.writer.write({ kind: 'source_error', source: 'coinbase_advanced_trade', recvMs,
        message: String(message.message || message.error || 'unknown websocket error').slice(0, 300) });
    }

    for (const product of touched) this.frames.get(product).messages++;
    this.markSequence(message.sequence_num);
    this.counters.coinbaseMessages++;
    return true;
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(COINBASE_WS); }
    catch (error) { this.scheduleReconnect(error); return; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.lastSequence = null;
      this.counters.coinbaseConnects++;
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'level2', product_ids: this.products }));
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'market_trades', product_ids: this.products }));
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
    });
    ws.addEventListener('message', event => this.onMessage(event.data, Date.now()));
    ws.addEventListener('error', () => { this.counters.coinbaseSocketErrors++; });
    ws.addEventListener('close', event => {
      this.counters.coinbaseCloses++;
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect(new Error(`close ${event.code}`));
    });
  }

  scheduleReconnect(error) {
    if (this.stopped || this.reconnectTimer) return;
    this.counters.coinbaseReconnects++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.writer.write({ kind: 'source_error', source: 'coinbase_advanced_trade', recvMs: Date.now(),
      retryInMs: delay, message: String(error && error.message || error).slice(0, 300) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.roll(Date.now());
    if (this.ws) {
      try { this.ws.close(1000, 'collector complete'); } catch (_) { /* already closed */ }
    }
  }
}

function parseKalshiRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    price: num(row && row[0]), size: num(row && row[1])
  })).filter(row => row.price != null && row.price >= 0 && row.price <= 1 && row.size > 0)
    .sort((a, b) => b.price - a.price);
}

/** Kalshi returns bid ladders on both outcome sides; NO bids translate into YES asks at 1-price. */
function summarizeKalshiBook(payload) {
  const raw = payload && (payload.orderbook_fp || payload.orderbook);
  if (!raw) return null;
  const yes = parseKalshiRows(raw.yes_dollars || raw.yes);
  const no = parseKalshiRows(raw.no_dollars || raw.no);
  if (!yes.length && !no.length) return null;
  const yesBid = yes.length ? yes[0].price : null;
  const bestNoBid = no.length ? no[0].price : null;
  const yesAsk = bestNoBid != null ? +(1 - bestNoBid).toFixed(4) : null;
  const spread = yesBid != null && yesAsk != null ? +(yesAsk - yesBid).toFixed(4) : null;
  const bidTouch = yes.length ? yes[0].size : 0;
  const askTouch = no.length ? no[0].size : 0;
  const touchTotal = bidTouch + askTouch;
  const mid = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : null;
  const microprice = mid != null && touchTotal > 0
    ? (yesAsk * bidTouch + yesBid * askTouch) / touchTotal : mid;
  const near = (rows, best, cents) => best == null ? 0 : rows
    .filter(row => row.price >= best - cents / 100).reduce((sum, row) => sum + row.size, 0);
  const yes5 = near(yes, yesBid, 5), no5 = near(no, bestNoBid, 5);
  const yes10 = near(yes, yesBid, 10), no10 = near(no, bestNoBid, 10);
  const ratio = (a, b) => a + b > 0 ? +((a - b) / (a + b)).toFixed(8) : null;
  return {
    yes, no, yesBid, yesAsk, spread, mid,
    bidTouch: +bidTouch.toFixed(4), askTouch: +askTouch.toFixed(4),
    touchImbalance: ratio(bidTouch, askTouch),
    microprice: microprice == null ? null : +microprice.toFixed(6),
    micropriceOffset: microprice != null && mid != null ? +(microprice - mid).toFixed(6) : null,
    depth5c: { yes: +yes5.toFixed(4), no: +no5.toFixed(4), imbalance: ratio(yes5, no5) },
    depth10c: { yes: +yes10.toFixed(4), no: +no10.toFixed(4), imbalance: ratio(yes10, no10) }
  };
}

/** Signed change between public snapshots. It is snapshot flow, not falsely labelled event OFI. */
function kalshiSnapshotFlow(previous, current) {
  if (!previous || !current) return null;
  const map = rows => new Map(rows.map(row => [row.price, row.size]));
  const oldYes = map(previous.yes), newYes = map(current.yes);
  const oldNo = map(previous.no), newNo = map(current.no);
  const nearDelta = (oldMap, newMap, oldBest, newBest, cents) => {
    const prices = new Set([...oldMap.keys(), ...newMap.keys()]);
    let delta = 0, absolute = 0;
    for (const price of prices) {
      const nearOld = oldBest != null && price >= oldBest - cents / 100;
      const nearNew = newBest != null && price >= newBest - cents / 100;
      if (!nearOld && !nearNew) continue;
      const d = (newMap.get(price) || 0) - (oldMap.get(price) || 0);
      delta += d;
      absolute += Math.abs(d);
    }
    return { delta, absolute };
  };
  const yes = nearDelta(oldYes, newYes, previous.yesBid, current.yesBid, 5);
  const oldNoBest = previous.yesAsk == null ? null : 1 - previous.yesAsk;
  const newNoBest = current.yesAsk == null ? null : 1 - current.yesAsk;
  const no = nearDelta(oldNo, newNo, oldNoBest, newNoBest, 5);
  const signed = yes.delta - no.delta;
  const absolute = yes.absolute + no.absolute;
  return {
    near5cSigned: +signed.toFixed(4),
    near5cAbsolute: +absolute.toFixed(4),
    near5cNormalized: absolute > 0 ? +(signed / absolute).toFixed(8) : 0,
    intervalMs: null
  };
}

function marketMeta(market, spec) {
  return {
    sym: spec.sym, series: spec.series, ticker: String(market.ticker || ''),
    openTime: market.open_time || null, closeTime: market.close_time || null,
    expectedExpirationTime: market.expected_expiration_time || null,
    strike: num(market.floor_strike), status: market.status || null,
    title: market.title || null, subtitle: market.subtitle || market.yes_sub_title || null
  };
}

function selectActiveMarkets(markets, now, spec) {
  return (Array.isArray(markets) ? markets : []).filter(market => {
    const close = sourceMs(market && market.close_time);
    const left = (close - now) / 60000;
    const status = String(market && market.status || '').toLowerCase();
    return market && market.ticker && Number.isFinite(left) && left > -0.5 &&
      left <= MAX_ACTIVE_MINUTES && (!status || status === 'open' || status === 'active');
  }).sort((a, b) => sourceMs(a.close_time) - sourceMs(b.close_time))
    .slice(0, 1).map(market => marketMeta(market, spec));
}

class KalshiPoller {
  constructor({ writer, counters, bookPollMs = DEFAULT_BOOK_POLL_MS }) {
    this.writer = writer;
    this.counters = counters;
    this.bookPollMs = bookPollMs;
    this.active = new Map();
    this.known = new Map();
    this.previous = new Map();
    this.settled = new Set();
    this.discovering = false;
    this.polling = false;
    this.settling = false;
    this.http = axios.create({
      baseURL: KALSHI_BASE, timeout: 7000,
      headers: { Accept: 'application/json', 'User-Agent': 'indicators-observe-only-microstructure' }
    });
  }

  async discover(now = Date.now()) {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const found = await Promise.all(SERIES.map(async spec => {
        try {
          const { data } = await this.http.get('/markets', {
            params: { series_ticker: spec.series, status: 'open', limit: 10 }
          });
          return selectActiveMarkets(data && data.markets, now, spec);
        } catch (error) {
          this.counters.kalshiDiscoverErrors++;
          return [];
        }
      }));
      const next = new Map();
      for (const meta of found.flat()) {
        next.set(meta.ticker, meta);
        this.known.set(meta.ticker, meta);
      }
      this.active = next;
      this.counters.kalshiDiscoveries++;
    } finally { this.discovering = false; }
  }

  async pollBooks(now = Date.now()) {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.active.values()].map(async meta => {
        const requestStartMs = Date.now();
        try {
          const { data } = await this.http.get(`/markets/${encodeURIComponent(meta.ticker)}/orderbook`, {
            params: { depth: 20 }
          });
          const recvMs = Date.now();
          const summary = summarizeKalshiBook(data);
          if (!summary) { this.counters.kalshiInvalidBooks++; return; }
          const flow = kalshiSnapshotFlow(this.previous.get(meta.ticker), summary);
          if (flow) flow.intervalMs = recvMs - this.previous.get(meta.ticker).recvMs;
          summary.recvMs = recvMs;
          this.previous.set(meta.ticker, summary);
          this.writer.write({
            kind: 'kalshi_book', source: 'kalshi_public_rest', ...meta,
            sourceMs: null, requestStartMs, recvMs, recv: iso(recvMs),
            latencyMs: recvMs - requestStartMs,
            secondsLeft: meta.closeTime ? +(sourceMs(meta.closeTime) - recvMs) / 1000 : null,
            snapshotFlow: flow,
            book: {
              yesBid: summary.yesBid, yesAsk: summary.yesAsk, spread: summary.spread,
              mid: summary.mid, bidTouch: summary.bidTouch, askTouch: summary.askTouch,
              touchImbalance: summary.touchImbalance, microprice: summary.microprice,
              micropriceOffset: summary.micropriceOffset,
              depth5c: summary.depth5c, depth10c: summary.depth10c,
              yes: summary.yes, no: summary.no
            }
          });
          this.counters.kalshiBooks++;
        } catch (error) {
          this.counters.kalshiBookErrors++;
          const status = error && error.response && error.response.status;
          if (status === 401 || status === 403) this.counters.kalshiAuthRefusals++;
        }
      }));
    } finally { this.polling = false; }
  }

  async settleDue(now = Date.now()) {
    if (this.settling) return;
    const due = [...this.known.values()].filter(meta => {
      const close = sourceMs(meta.closeTime);
      return close != null && now >= close + 20000 && !this.settled.has(meta.ticker);
    });
    if (!due.length) return;
    this.settling = true;
    try {
      await Promise.all(due.map(async meta => {
        try {
          const { data } = await this.http.get(`/markets/${encodeURIComponent(meta.ticker)}`);
          const market = data && data.market;
          const result = String(market && (market.result || market.settlement_value) || '').toLowerCase();
          let side = null;
          if (result === 'yes' || result === '1' || result === '1.0000') side = 'YES';
          if (result === 'no' || result === '0' || result === '0.0000') side = 'NO';
          if (!side) return;
          this.settled.add(meta.ticker);
          const recvMs = Date.now();
          this.writer.write({ kind: 'kalshi_settlement', source: 'kalshi_public_rest', ...meta,
            recvMs, recv: iso(recvMs), result: side,
            expirationValue: num(market.expiration_value), settledTime: market.settled_time || null });
          this.counters.kalshiSettlements++;
        } catch (_) { this.counters.kalshiSettleErrors++; }
      }));
    } finally { this.settling = false; }
  }

  status() {
    return {
      active: [...this.active.values()], known: this.known.size, settled: this.settled.size,
      credentialFreeLimitation: 'Kalshi delta WebSocket requires authentication; these are REST snapshots, not event-complete deltas.'
    };
  }
}

function atomicWrite(file, value) {
  if (!file) return;
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

function makeCounters() {
  return {
    coinbaseConnects: 0, coinbaseCloses: 0, coinbaseReconnects: 0,
    coinbaseSocketErrors: 0, coinbaseSourceErrors: 0, coinbaseParseErrors: 0,
    coinbaseMessages: 0, coinbaseHeartbeats: 0, coinbaseSequenceGaps: 0,
    coinbaseFrames: 0,
    kalshiDiscoveries: 0, kalshiDiscoverErrors: 0,
    kalshiBooks: 0, kalshiBookErrors: 0, kalshiInvalidBooks: 0, kalshiAuthRefusals: 0,
    kalshiSettlements: 0, kalshiSettleErrors: 0, statusErrors: 0
  };
}

async function main(argv = process.argv.slice(2)) {
  const startedMs = Date.now();
  const stamp = new Date(startedMs).toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const durationMin = Math.max(0.05, num(arg(argv, '--minutes', 360)) || 360);
  const once = argv.includes('--once');
  const out = arg(argv, '--out', `/tmp/indicators-microstructure-${stamp}.jsonl`);
  const statusOut = arg(argv, '--status-out', `${out}.status.json`);
  const bookPollMs = Math.max(1000, num(arg(argv, '--kalshi-poll-ms', DEFAULT_BOOK_POLL_MS)) || DEFAULT_BOOK_POLL_MS);
  const stopAt = once ? startedMs + 5000 : startedMs + durationMin * 60000;
  const counters = makeCounters();
  const writer = new JsonlWriter(out);
  const feed = new CoinbaseFeed({ products: PRODUCTS, writer, counters, now: startedMs });
  const kalshi = new KalshiPoller({ writer, counters, bookPollMs });
  let stopping = false;
  const timers = [];

  const status = state => ({
    v: SCHEMA_VERSION, state, pid: process.pid,
    startedAt: iso(startedMs), updatedAt: new Date().toISOString(), stopAt: iso(stopAt),
    observedMinutes: +((Date.now() - startedMs) / 60000).toFixed(2),
    out: path.resolve(out), statusOut: path.resolve(statusOut),
    safety: { publicDataOnly: true, credentialsLoaded: false, orderEndpoints: false, trading: false },
    config: {
      coinbaseProducts: PRODUCTS, kalshiSeries: SERIES.map(x => x.series),
      frameMs: FRAME_MS, kalshiPollMs: bookPollMs,
      missingDirectUnderlying: SERIES.filter(x => !x.product).map(x => x.sym)
    },
    counters, writer: {
      records: writer.records, rawBytes: writer.bytes, compressed: writer.compressed,
      diskBytes: fs.existsSync(writer.file) ? fs.statSync(writer.file).size : 0,
      backpressureEvents: writer.backpressureEvents, error: writer.error && writer.error.message
    },
    kalshi: kalshi.status()
  });

  const checkpoint = state => {
    try { atomicWrite(statusOut, status(state)); }
    catch (_) { counters.statusErrors++; }
  };

  const finish = async (state = 'complete', fatal = null) => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    feed.stop();
    // A timer may already have launched a REST batch. Closing the stream while that batch resolves
    // makes counters claim records that were never durable, so wait one request timeout for it to drain.
    const drainDeadline = Date.now() + 8000;
    while ((kalshi.discovering || kalshi.polling || kalshi.settling) && Date.now() < drainDeadline) {
      await sleep(25);
    }
    writer.write({ kind: 'collector_end', endedAt: new Date().toISOString(), state,
      fatal: fatal ? String(fatal.stack || fatal) : null, counters });
    await writer.end();
    checkpoint(state);
  };

  writer.write({
    kind: 'collector_start', startedAt: iso(startedMs), pid: process.pid,
    schema: {
      coinbaseFrameClock: 'local receive time',
      coinbaseTradeSide: 'as reported by Coinbase; not asserted to be aggressor side',
      kalshiClock: 'request/receive only; REST payload has no source timestamp',
      kalshiSnapshotFlow: 'change between snapshots; not event-complete OFI'
    },
    safety: { publicDataOnly: true, credentialsLoaded: false, orderEndpoints: false, trading: false },
    config: { products: PRODUCTS, series: SERIES, frameMs: FRAME_MS, bookPollMs }
  });
  checkpoint('starting');

  feed.connect();
  await kalshi.discover();
  await kalshi.pollBooks();
  await kalshi.settleDue();
  checkpoint('running');

  timers.push(setInterval(() => feed.roll(Date.now()), 200));
  timers.push(setInterval(() => { kalshi.discover().catch(() => {}); }, DISCOVER_MS));
  timers.push(setInterval(() => { kalshi.pollBooks().catch(() => {}); }, bookPollMs));
  timers.push(setInterval(() => { kalshi.settleDue().catch(() => {}); }, SETTLE_MS));
  timers.push(setInterval(() => checkpoint('running'), STATUS_MS));

  const stopTimer = setTimeout(() => finish('complete').catch(() => {}), Math.max(0, stopAt - Date.now()));
  timers.push(stopTimer);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish('stopped').catch(() => {}));

  if (once) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, stopAt - Date.now())));
    await finish('one-scan');
  }
}

if (require.main === module) {
  main().catch(async error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA_VERSION, SERIES, PRODUCTS, RETAIN_BPS,
  JsonlWriter, num, iso, arg, atomicWrite,
  L2Book, CoinbaseFeed,
  createFrameMetrics, addTradeToFrame,
  summarizeKalshiBook, kalshiSnapshotFlow,
  selectActiveMarkets, marketMeta, main
};
