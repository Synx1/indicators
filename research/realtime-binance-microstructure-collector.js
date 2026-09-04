#!/usr/bin/env node
'use strict';

/**
 * Credential-free Binance USD-M perpetual challenger collector.
 *
 * Why separate: peer-reviewed cross-venue evidence identifies Binance's USDT perpetual as an
 * important volatility transmitter, but that does not prove it improves Kalshi settlement
 * probabilities. Keeping this in a separate corpus lets the Coinbase-only baseline stand on its own.
 *
 * Why partial depth: this host receives HTTP 451 from Binance Futures REST, so a REST snapshot plus
 * incremental depth reconstruction is unavailable. The public `depth20` WebSocket stream is
 * self-contained: every message contains the current top 20 levels. Changes between those snapshots
 * are useful challenger inputs but are explicitly *not* called event-complete OFI because levels can
 * enter or leave at the top-20 boundary between 100ms observations.
 *
 * No production config, credentials, user state, auth headers, or order endpoints are imported.
 */

const fs = require('fs');
const path = require('path');
const {
  SCHEMA_VERSION, JsonlWriter, num, iso, arg, atomicWrite
} = require('./realtime-microstructure-collector');

const SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'HYPEUSDT'
]);
const STREAM_ROOT = 'wss://fstream.binance.com/stream?streams=';
const FRAME_MS = 1000;
const STATUS_MS = 15000;

const baseSymbol = symbol => String(symbol).replace(/USDT$/, '');
const createMetrics = () => ({
  sourceEventFirstMs: null, sourceEventLastMs: null,
  sourceTransactionFirstMs: null, sourceTransactionLastMs: null,
  recvFirstMs: null, recvLastMs: null,
  messages: 0, depthSnapshots: 0, sequenceDiscontinuities: 0,
  snapshotFlow: { touch: 0, top20: 0, absolute: 0, normalizedSum: 0 },
  trades: 0, tradeBase: 0, tradeNotional: 0,
  aggressorBuyBase: 0, aggressorSellBase: 0
});

function touchTiming(metrics, eventMs, transactionMs, recvMs) {
  const setRange = (first, last, value) => {
    if (!Number.isFinite(value)) return;
    metrics[first] = metrics[first] == null ? value : Math.min(metrics[first], value);
    metrics[last] = metrics[last] == null ? value : Math.max(metrics[last], value);
  };
  setRange('sourceEventFirstMs', 'sourceEventLastMs', eventMs);
  setRange('sourceTransactionFirstMs', 'sourceTransactionLastMs', transactionMs);
  setRange('recvFirstMs', 'recvLastMs', recvMs);
}

function parseLevels(rows, side) {
  const levels = (Array.isArray(rows) ? rows : []).map(row => ({
    price: num(row && row[0]), size: num(row && row[1])
  })).filter(row => row.price > 0 && row.size >= 0);
  levels.sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price);
  return levels.slice(0, 20);
}

function summarizePartialDepth(message) {
  const bids = parseLevels(message && message.b, 'bid');
  const asks = parseLevels(message && message.a, 'ask');
  if (!bids.length || !asks.length || asks[0].price < bids[0].price) return null;
  const bid = bids[0].price, ask = asks[0].price, mid = (bid + ask) / 2;
  const bidTouch = bids[0].size, askTouch = asks[0].size, touchTotal = bidTouch + askTouch;
  const depth = (bps = Infinity) => {
    const bidSize = bids.filter(row => bid - row.price <= mid * bps / 10000)
      .reduce((sum, row) => sum + row.size, 0);
    const askSize = asks.filter(row => row.price - ask <= mid * bps / 10000)
      .reduce((sum, row) => sum + row.size, 0);
    return {
      bid: bidSize, ask: askSize,
      imbalance: bidSize + askSize > 0 ? (bidSize - askSize) / (bidSize + askSize) : null
    };
  };
  const microprice = touchTotal > 0 ? (ask * bidTouch + bid * askTouch) / touchTotal : mid;
  return {
    bids, asks, bid, ask, mid,
    spreadBps: mid > 0 ? (ask - bid) / mid * 10000 : null,
    bidTouch, askTouch,
    touchImbalance: touchTotal > 0 ? (bidTouch - askTouch) / touchTotal : null,
    microprice, micropriceOffsetBps: mid > 0 ? (microprice - mid) / mid * 10000 : null,
    depth1Bps: depth(1), depthTop20: depth(Infinity),
    levels: { bid: bids.length, ask: asks.length, semantics: 'complete top-20 snapshot' }
  };
}

/** Positive means upward pressure: bid quantity added or ask quantity removed. */
function partialSnapshotFlow(previous, current) {
  if (!previous || !current) return null;
  const map = rows => new Map(rows.map(row => [row.price, row.size]));
  const priorBid = map(previous.bids), nextBid = map(current.bids);
  const priorAsk = map(previous.asks), nextAsk = map(current.asks);
  let top20 = 0, absolute = 0, touch = 0;
  const accumulate = (oldMap, newMap, sign, oldTouch, newTouch) => {
    for (const price of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const delta = ((newMap.get(price) || 0) - (oldMap.get(price) || 0)) * sign;
      top20 += delta;
      absolute += Math.abs(delta);
      if (price === oldTouch || price === newTouch) touch += delta;
    }
  };
  accumulate(priorBid, nextBid, 1, previous.bid, current.bid);
  accumulate(priorAsk, nextAsk, -1, previous.ask, current.ask);
  return { touch, top20, absolute, normalized: absolute > 0 ? top20 / absolute : 0 };
}

function addTrade(metrics, message) {
  const price = num(message && message.p), size = num(message && message.q);
  if (!(price > 0) || !(size > 0)) return false;
  metrics.trades++;
  metrics.tradeBase += size;
  metrics.tradeNotional += price * size;
  // Binance documents m=true as "buyer is market maker": the seller crossed the spread.
  if (message.m === true) metrics.aggressorSellBase += size;
  else if (message.m === false) metrics.aggressorBuyBase += size;
  return true;
}

class BinanceFeed {
  constructor({ symbols = SYMBOLS, writer, counters, frameMs = FRAME_MS, now = Date.now() }) {
    this.symbols = symbols;
    this.writer = writer;
    this.counters = counters;
    this.frameMs = frameMs;
    this.books = new Map(symbols.map(symbol => [symbol, null]));
    this.lastUpdate = new Map(symbols.map(symbol => [symbol, null]));
    this.frames = new Map(symbols.map(symbol => [symbol, createMetrics()]));
    this.nextFrameEnd = Math.floor(now / frameMs) * frameMs + frameMs;
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  streamUrl() {
    const streams = this.symbols.flatMap(symbol => {
      const lower = symbol.toLowerCase();
      return [`${lower}@depth20@100ms`, `${lower}@trade`];
    });
    return STREAM_ROOT + streams.join('/');
  }

  resetConnectionState() {
    for (const symbol of this.symbols) {
      this.books.set(symbol, null);
      this.lastUpdate.set(symbol, null);
    }
  }

  roll(now) {
    while (this.nextFrameEnd <= now) {
      const end = this.nextFrameEnd;
      for (const symbol of this.symbols) {
        const metrics = this.frames.get(symbol);
        const book = this.books.get(symbol);
        this.writer.write({
          kind: 'binance_frame', source: 'binance_usdm_public_ws', symbol,
          sym: baseSymbol(symbol), product: `${baseSymbol(symbol)}-USDT-PERP`,
          bucketStartMs: end - this.frameMs, bucketEndMs: end,
          bucketStart: iso(end - this.frameMs), bucketEnd: iso(end),
          sourceEventFirstMs: metrics.sourceEventFirstMs,
          sourceEventLastMs: metrics.sourceEventLastMs,
          sourceTransactionFirstMs: metrics.sourceTransactionFirstMs,
          sourceTransactionLastMs: metrics.sourceTransactionLastMs,
          recvFirstMs: metrics.recvFirstMs, recvLastMs: metrics.recvLastMs,
          messages: metrics.messages, depthSnapshots: metrics.depthSnapshots,
          sequenceDiscontinuities: metrics.sequenceDiscontinuities,
          snapshotFlow: {
            touch: +metrics.snapshotFlow.touch.toFixed(8),
            top20: +metrics.snapshotFlow.top20.toFixed(8),
            absolute: +metrics.snapshotFlow.absolute.toFixed(8),
            normalizedSum: +metrics.snapshotFlow.normalizedSum.toFixed(8),
            semantics: 'change between complete top-20 snapshots; not event-complete OFI'
          },
          trade: {
            count: metrics.trades, base: +metrics.tradeBase.toFixed(8),
            notional: +metrics.tradeNotional.toFixed(2),
            aggressorBuyBase: +metrics.aggressorBuyBase.toFixed(8),
            aggressorSellBase: +metrics.aggressorSellBase.toFixed(8),
            sideSemantics: 'm=false buy aggressor; m=true sell aggressor'
          },
          book: book ? {
            ready: true, bid: book.bid, ask: book.ask, mid: book.mid,
            spreadBps: +book.spreadBps.toFixed(8),
            bidTouch: +book.bidTouch.toFixed(8), askTouch: +book.askTouch.toFixed(8),
            touchImbalance: book.touchImbalance == null ? null : +book.touchImbalance.toFixed(8),
            microprice: +book.microprice.toFixed(8),
            micropriceOffsetBps: +book.micropriceOffsetBps.toFixed(8),
            depth1Bps: book.depth1Bps, depthTop20: book.depthTop20, levels: book.levels
          } : { ready: false }
        });
        this.frames.set(symbol, createMetrics());
        this.counters.frames++;
      }
      this.nextFrameEnd += this.frameMs;
    }
  }

  onMessage(raw, recvMs = Date.now()) {
    this.roll(recvMs);
    let wrapper;
    try { wrapper = JSON.parse(String(raw)); }
    catch (_) { this.counters.parseErrors++; return false; }
    const message = wrapper && (wrapper.data || wrapper);
    const symbol = String(message && message.s || '');
    if (!this.frames.has(symbol)) return false;
    const metrics = this.frames.get(symbol);
    touchTiming(metrics, num(message.E), num(message.T), recvMs);
    metrics.messages++;
    this.counters.messages++;

    if (message.e === 'depthUpdate') {
      const summary = summarizePartialDepth(message);
      if (!summary) { this.counters.invalidDepth++; return false; }
      const priorUpdate = this.lastUpdate.get(symbol);
      const previousUpdate = num(message.pu);
      if (priorUpdate != null && previousUpdate !== priorUpdate) {
        metrics.sequenceDiscontinuities++;
        this.counters.sequenceDiscontinuities++;
      }
      const previous = this.books.get(symbol);
      const flow = partialSnapshotFlow(previous, summary);
      if (flow) {
        metrics.snapshotFlow.touch += flow.touch;
        metrics.snapshotFlow.top20 += flow.top20;
        metrics.snapshotFlow.absolute += flow.absolute;
        metrics.snapshotFlow.normalizedSum += flow.normalized;
      }
      this.books.set(symbol, summary);
      this.lastUpdate.set(symbol, num(message.u));
      metrics.depthSnapshots++;
      this.counters.depthSnapshots++;
      return true;
    }
    if (message.e === 'trade') {
      if (addTrade(metrics, message)) this.counters.trades++;
      return true;
    }
    return false;
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.streamUrl()); }
    catch (error) { this.scheduleReconnect(error); return; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.resetConnectionState();
      this.counters.connects++;
    });
    ws.addEventListener('message', event => this.onMessage(event.data, Date.now()));
    ws.addEventListener('error', () => { this.counters.socketErrors++; });
    ws.addEventListener('close', event => {
      this.counters.closes++;
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect(new Error(`close ${event.code}`));
    });
  }

  scheduleReconnect(error) {
    if (this.stopped || this.reconnectTimer) return;
    this.counters.reconnects++;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.writer.write({ kind: 'source_error', source: 'binance_usdm_public_ws',
      recvMs: Date.now(), retryInMs: delay, message: String(error && error.message || error).slice(0, 300) });
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

function makeCounters() {
  return {
    connects: 0, closes: 0, reconnects: 0, socketErrors: 0, parseErrors: 0,
    messages: 0, depthSnapshots: 0, trades: 0,
    sequenceDiscontinuities: 0, invalidDepth: 0, frames: 0, statusErrors: 0
  };
}

async function main(argv = process.argv.slice(2)) {
  const startedMs = Date.now();
  const stamp = new Date(startedMs).toISOString().replace(/[-:.]/g, '');
  const durationMin = Math.max(0.05, num(arg(argv, '--minutes', 360)) || 360);
  const once = argv.includes('--once');
  const out = arg(argv, '--out', `/tmp/indicators-binance-microstructure-${stamp}.jsonl`);
  const statusOut = arg(argv, '--status-out', `${out}.status.json`);
  const stopAt = once ? startedMs + 5000 : startedMs + durationMin * 60000;
  const writer = new JsonlWriter(out);
  const counters = makeCounters();
  const feed = new BinanceFeed({ writer, counters, now: startedMs });
  const timers = [];
  let stopping = false;

  const status = state => ({
    v: SCHEMA_VERSION, state, pid: process.pid,
    startedAt: iso(startedMs), updatedAt: new Date().toISOString(), stopAt: iso(stopAt),
    observedMinutes: +((Date.now() - startedMs) / 60000).toFixed(2),
    out: path.resolve(out), statusOut: path.resolve(statusOut),
    safety: { publicDataOnly: true, credentialsLoaded: false, orderEndpoints: false, trading: false },
    config: {
      symbols: SYMBOLS, frameMs: FRAME_MS, depth: 20, depthIntervalMs: 100,
      missingDirectUnderlying: [],
      restSnapshotUsed: false,
      limitation: 'top-20 WebSocket snapshots; derived snapshot flow is not event-complete OFI'
    },
    counters,
    readyBooks: [...feed.books.values()].filter(Boolean).length,
    writer: {
      records: writer.records, rawBytes: writer.bytes, compressed: writer.compressed,
      diskBytes: fs.existsSync(writer.file) ? fs.statSync(writer.file).size : 0,
      backpressureEvents: writer.backpressureEvents, error: writer.error && writer.error.message
    }
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
    writer.write({ kind: 'collector_end', endedAt: new Date().toISOString(), state,
      fatal: fatal ? String(fatal.stack || fatal) : null, counters });
    await writer.end();
    checkpoint(state);
  };

  writer.write({
    kind: 'collector_start', startedAt: iso(startedMs), pid: process.pid,
    schema: {
      frameClock: 'local receive time',
      depth: 'complete top-20 snapshots at up to 100ms; quantities are absolute',
      snapshotFlow: 'change between snapshots; not event-complete OFI',
      tradeSide: 'individual @trade events; m=false buy aggressor; m=true sell aggressor'
    },
    safety: { publicDataOnly: true, credentialsLoaded: false, orderEndpoints: false, trading: false },
    config: { symbols: SYMBOLS, frameMs: FRAME_MS }
  });
  checkpoint('starting');
  feed.connect();
  timers.push(setInterval(() => feed.roll(Date.now()), 200));
  timers.push(setInterval(() => checkpoint('running'), STATUS_MS));
  timers.push(setTimeout(() => finish(once ? 'one-scan' : 'complete').catch(() => {}),
    Math.max(0, stopAt - Date.now())));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => finish('stopped').catch(() => {}));
  if (once) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, stopAt - Date.now())));
    await finish('one-scan');
  }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = {
  SYMBOLS, FRAME_MS, createMetrics, parseLevels, summarizePartialDepth,
  partialSnapshotFlow, addTrade, BinanceFeed, makeCounters, main
};
