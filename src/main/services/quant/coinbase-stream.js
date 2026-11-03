/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { WebSocket } = require('undici');
const { performance } = require('node:perf_hooks');
const network = require('../../net-proxy');
const ENDPOINT = 'wss://advanced-trade-ws.coinbase.com';
const PRODUCTS = ['ETH-USD', 'BTC-USD', 'SOL-USD'];
const SCALE = 10n ** 18n,
  MAX = (1n << 127n) - 1n;
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function integer(value, source) {
  const text =
    typeof value === 'string'
      ? value
      : source || (Number.isSafeInteger(value) ? String(value) : '');
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > (1n << 64n) - 1n) fail('SOURCE_INTEGER_INVALID');
  return BigInt(text);
}
function parseFrame(text) {
  return JSON.parse(text, (key, value, context) =>
    ['sequence_num', 'trade_id', 'heartbeat_counter'].includes(key)
      ? integer(value, context?.source).toString()
      : value,
  );
}
function amount(value, positive = false) {
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value))
    fail('SOURCE_AMOUNT_INVALID');
  const [whole, fraction = ''] = value.split('.');
  const atoms = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (atoms > MAX || (positive && atoms === 0n)) fail('SOURCE_AMOUNT_INVALID');
  return atoms;
}
function decimal(atoms) {
  const fraction = (atoms % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (atoms / SCALE).toString() + (fraction ? '.' + fraction : '');
}
function timeNs(value) {
  if (typeof value !== 'string') fail('SOURCE_TIME_INVALID');
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !m ||
    Number(m[2]) < 1 ||
    Number(m[2]) > 12 ||
    Number(m[3]) < 1 ||
    Number(m[3]) > new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59 ||
    Number(m[6]) > 59
  )
    fail('SOURCE_TIME_INVALID');
  const ms = Date.parse(value.slice(0, 19) + m[8]);
  if (!Number.isSafeInteger(ms) || ms < 0) fail('SOURCE_TIME_INVALID');
  return BigInt(ms) * 1000000n + BigInt((m[7] || '').padEnd(9, '0'));
}
function fresh(time, now) {
  const current = BigInt(now) * 1000000n;
  if (time > current + 250000000n || current - time > 2000000000n) fail('SOURCE_TIME_STALE');
}
function rows(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail('SOURCE_EVENT_LIMIT');
  return value;
}
function errorCode(error) {
  return /^[A-Z][A-Z_0-9]{1,80}$/.test(error?.code || error?.message || '')
    ? error.code || error.message
    : 'SOURCE_TRANSPORT_ERROR';
}
async function calibrateClock(read, now = Date.now, monotonic = () => performance.now()) {
  let best;
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = now(),
      mono = monotonic(),
      sample = await read(),
      end = now(),
      elapsed = monotonic() - mono;
    if (end < start || Math.abs(end - start - elapsed) > 50) fail('SOURCE_LOCAL_CLOCK_CHANGED');
    const server = integer(sample.epochMillis),
      lower = (server - BigInt(end) - 25n) * 1000000n,
      upper = (server - BigInt(start) + 25n) * 1000000n;
    const width = upper - lower;
    if (upper > 60000000000n || lower < -60000000000n) fail('SOURCE_CLOCK_OFFSET_TOO_LARGE');
    if (!best || width < BigInt(best.uncertainty_ns))
      best = {
        offset_ns: upper.toString(),
        uncertainty_ns: width.toString(),
        calibrated_at_ns: (BigInt(end) * 1000000n).toString(),
      };
    if (width <= 350000000n) break;
  }
  if (!best || BigInt(best.uncertainty_ns) > 2000000000n) fail('SOURCE_CLOCK_UNCERTAIN');
  return best;
}
function projectTime(provider, clock) {
  return clock ? provider - BigInt(clock.offset_ns) : provider;
}
function clockMetadata(provider, clock) {
  return clock ? { provider_time_ns: provider.toString(), source_clock: clock } : {};
}

class CoinbaseStream {
  constructor({
    engine,
    product,
    instrument,
    publish = () => {},
    createDispatcher = network.createWebSocketDispatcher,
    socketFactory = (url, options) => new WebSocket(url, options),
    onPolicyChange = network.onPolicyChange,
    now = Date.now,
    monotonic = () => performance.now(),
    calibrate,
    subscribe,
    depth = 1000,
    random = Math.random,
  } = {}) {
    if (
      !PRODUCTS.includes(product) ||
      !/^[\w:.-]{1,128}$/.test(instrument || '') ||
      !Number.isInteger(depth) ||
      depth < 1 ||
      depth > 2000
    )
      fail('SOURCE_MARKET_INVALID');
    Object.assign(this, {
      engine,
      product,
      instrument,
      publish,
      createDispatcher,
      socketFactory,
      onPolicyChange,
      now,
      monotonic,
      calibrate,
      subscribe,
      depth,
      random,
    });
    this.phase = 'stopped';
    this.desired = false;
    this.generation = 0;
    this.attempts = 0;
    this.lastError = null;
    this.session = null;
    this.metrics = {
      connectionAttempts: 0,
      latencyHolds: 0,
      duplicateFrames: 0,
      duplicateTrades: 0,
      ignoredHistoricalTrades: 0,
      ignoredPreReadyTrades: 0,
      appliedTrades: 0,
      filledOrders: 0,
    };
  }
  inspect() {
    const s = this.session;
    return {
      venue: 'coinbase',
      product: this.product,
      instrument: this.instrument,
      phase: this.phase,
      desired: this.desired,
      lastError: this.lastError,
      receivedSequence: s?.sequence?.toString() ?? null,
      lastMessageAt: s?.lastReceived ?? null,
      lastBookAt: s?.lastBook ?? null,
      queuedBytes: s?.queuedBytes || 0,
      sourceLagMs: s?.sourceLagMs ?? null,
      clock: s?.clock
        ? {
            estimatedOffsetMs:
              Number(BigInt(s.clock.offset_ns) - BigInt(s.clock.uncertainty_ns) / 2n) / 1000000,
            uncertaintyMs: Number(BigInt(s.clock.uncertainty_ns)) / 2000000,
            calibratedAt: Number(BigInt(s.clock.calibrated_at_ns) / 1000000n),
          }
        : null,
      coverage: s?.bids
        ? {
            bidFloor: decimal(s.bidFloor),
            askCeiling: decimal(s.askCeiling),
            bids: s.bids.size,
            asks: s.asks.size,
          }
        : null,
      ...this.metrics,
      model: 'conservative-l2-fifo',
      liveExecution: false,
    };
  }
  emit(force = false) {
    const now = this.now();
    if (!force && now - (this.lastEmitted || 0) < 1000) return;
    this.lastEmitted = now;
    try {
      this.publish({ type: 'quant-market-source-changed', source: this.inspect() });
    } catch {
      /* Observers are not source authority. */
    }
  }
  start() {
    if (this.starting) return this.starting;
    this.starting = this.begin().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async begin() {
    if (this.desired) return this.inspect();
    if (this.engine.state !== 'connected') fail('NATIVE_NOT_RUNNING');
    this.desired = true;
    const generation = ++this.generation;
    try {
      const status = await this.engine.call('status');
      if (!this.desired || generation !== this.generation) return this.inspect();
      if (status.feed?.version !== 1 || !status.feed.boundedDepth || !status.feed.sourceClock)
        fail('NATIVE_FEED_VERSION_REQUIRED');
      if (this.calibrate && !status.feed.clockNormalization) fail('NATIVE_FEED_VERSION_REQUIRED');
    } catch (error) {
      if (generation === this.generation) {
        this.desired = false;
        this.phase = 'failed';
        this.lastError = errorCode(error);
        this.emit(true);
      }
      throw error;
    }
    this.unsubscribe = this.onPolicyChange(() => {
      void this.disconnect('SOURCE_NETWORK_POLICY_CHANGED', true);
    });
    await this.connect();
    return this.inspect();
  }
  current(s) {
    return this.desired && this.session === s && s.generation === this.generation;
  }
  async connect() {
    if (!this.desired) return;
    clearTimeout(this.retry);
    const generation = ++this.generation;
    this.metrics.connectionAttempts++;
    this.phase = 'connecting';
    this.emit(true);
    let dispatcher;
    try {
      await this.engine.feed('market.invalidate', { id: this.instrument });
      if (!this.desired || generation !== this.generation) return;
      const clock = this.calibrate ? await this.calibrate() : null;
      if (!this.desired || generation !== this.generation) return;
      dispatcher = await this.createDispatcher(ENDPOINT, { maxPayloadSize: 16 * 1024 * 1024 });
      if (!this.desired || generation !== this.generation) {
        await dispatcher.destroy();
        return;
      }
      const socket = this.socketFactory(ENDPOINT, { dispatcher });
      const s = {
        generation,
        socket,
        dispatcher,
        epoch: randomUUID(),
        sequence: null,
        lastHash: null,
        bookSequence: 0n,
        tradeSequence: 0n,
        chain: Promise.resolve(),
        queuedBytes: 0,
        queuedFrames: 0,
        created: this.now(),
        lastReceived: this.now(),
        lastHeartbeat: null,
        lastBook: null,
        nativePublished: false,
        tradeSnapshot: false,
        clock,
        clockWall: this.now(),
        clockMono: this.monotonic(),
        calibrating: false,
      };
      this.session = s;
      socket.addEventListener('open', () => {
        if (!this.current(s)) return;
        this.phase = 'snapshot';
        this.emit(true);
        try {
          const send = (channel) => {
            if (!this.current(s)) return false;
            socket.send(
              JSON.stringify({ type: 'subscribe', channel, product_ids: [this.product] }),
            );
            return true;
          };
          if (this.subscribe)
            void (async () => {
              for (const channel of ['level2', 'market_trades', 'heartbeats']) {
                if (!this.current(s)) return;
                await this.subscribe(() => send(channel));
              }
            })().catch(() => {
              if (this.current(s)) void this.disconnect('SOURCE_SUBSCRIPTION_ERROR');
            });
          else for (const channel of ['level2', 'market_trades', 'heartbeats']) send(channel);
        } catch {
          void this.disconnect('SOURCE_SUBSCRIPTION_ERROR');
        }
      });
      socket.addEventListener('message', (event) => this.enqueue(s, event.data));
      socket.addEventListener('close', () => {
        if (this.current(s)) void this.disconnect('SOURCE_CONNECTION_CLOSED');
      });
      socket.addEventListener('error', () => {
        if (this.current(s)) void this.disconnect('SOURCE_TRANSPORT_ERROR');
      });
      this.watch(s);
    } catch (error) {
      if (dispatcher && this.session?.generation !== generation)
        await dispatcher.destroy().catch(() => {});
      if (generation !== this.generation || !this.desired) return;
      await this.disconnect(errorCode(error));
    }
  }
  watch(s) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (!this.current(s)) return;
      const now = this.now();
      if (
        this.calibrate &&
        s.clock &&
        !s.calibrating &&
        now - Number(BigInt(s.clock.calibrated_at_ns) / 1000000n) > 30000
      )
        void this.refreshClock(s);
      if (
        now < s.lastReceived ||
        now - s.lastReceived > 10000 ||
        (!s.nativePublished && now - s.created > 15000) ||
        (s.lastHeartbeat && now - s.lastHeartbeat > 6000)
      )
        void this.disconnect('SOURCE_HEARTBEAT_TIMEOUT');
      else {
        this.emit();
        this.watch(s);
      }
    }, 1000);
    this.watchdog.unref?.();
  }
  async refreshClock(s) {
    s.calibrating = true;
    try {
      const clock = await this.calibrate();
      if (this.current(s))
        await (s.chain = s.chain.then(() => {
          if (this.current(s)) s.clock = clock;
        }));
    } catch (error) {
      if (this.current(s)) void this.disconnect(errorCode(error));
    } finally {
      s.calibrating = false;
    }
  }
  enqueue(s, text) {
    if (!this.current(s)) return;
    if (typeof text !== 'string') {
      void this.disconnect('SOURCE_NON_TEXT_FRAME');
      return;
    }
    const bytes = Buffer.byteLength(text);
    if (
      bytes > 16 * 1024 * 1024 ||
      s.queuedBytes + bytes > 32 * 1024 * 1024 ||
      s.queuedFrames >= 256
    ) {
      void this.disconnect('SOURCE_BACKPRESSURE');
      return;
    }
    s.lastReceived = this.now();
    s.queuedBytes += bytes;
    s.queuedFrames++;
    s.chain = s.chain
      .then(async () => {
        if (this.current(s)) await this.process(s, text);
      })
      .catch((error) => {
        if (this.current(s)) return this.disconnect(errorCode(error));
      })
      .finally(() => {
        s.queuedBytes -= bytes;
        s.queuedFrames--;
      });
  }
  async process(s, text) {
    const wall = this.now(),
      mono = this.monotonic();
    if (Math.abs(wall - s.clockWall - (mono - s.clockMono)) > 100)
      fail('SOURCE_LOCAL_CLOCK_CHANGED');
    s.clockWall = wall;
    s.clockMono = mono;
    const frame = parseFrame(text);
    if (frame.type === 'error') fail('SOURCE_SUBSCRIPTION_ERROR');
    const sequence = integer(frame.sequence_num),
      hash = createHash('sha256').update(text).digest('hex');
    if (s.sequence !== null) {
      if (sequence === s.sequence && hash === s.lastHash) {
        this.metrics.duplicateFrames++;
        return;
      }
      if (sequence !== s.sequence + 1n)
        fail(sequence <= s.sequence ? 'SOURCE_SEQUENCE_CONFLICT' : 'SOURCE_SEQUENCE_GAP');
    }
    const providerStamp = timeNs(frame.timestamp),
      clock = s.clock;
    const stamp = projectTime(providerStamp, clock),
      current = BigInt(this.now()) * 1000000n;
    if (stamp > current + 250000000n || current - stamp > 30000000000n) fail('SOURCE_TIME_STALE');
    s.sourceLagMs = Math.max(0, Number((current - stamp) / 1000000n));
    // A multi-megabyte bootstrap snapshot can arrive behind the live stream.
    // Consume every sequenced update until caught up; never use its old clock
    // to manufacture a fresh book or replay missed executions.
    if (s.nativePublished && s.sourceLagMs > 1000) {
      this.metrics.latencyHolds++;
      await this.engine.feed('market.invalidate', { id: this.instrument });
      if (!this.current(s)) return;
      s.nativePublished = false;
      this.phase = 'delayed';
      this.lastError = 'SOURCE_CATCHING_UP';
      this.emit(true);
    }
    if (!s.nativePublished && s.sourceLagMs > 750) this.phase = 'delayed';
    s.sequence = sequence;
    s.lastHash = hash;
    const events = rows(frame.events, 100);
    if (frame.channel === 'l2_data') {
      const updates = new Map();
      for (const event of events) this.levels(s, event, updates);
      if (s.nativePublished)
        await this.delta(s, [...updates.values()], stamp, providerStamp, clock);
    } else if (frame.channel === 'heartbeats') {
      if (!events.length || events.some((event) => event.heartbeat_counter === undefined))
        fail('SOURCE_HEARTBEAT_INVALID');
      for (const event of events) {
        const counter = integer(event.heartbeat_counter);
        if (s.heartbeatCounter !== undefined && counter <= s.heartbeatCounter)
          fail('SOURCE_HEARTBEAT_INVALID');
        s.heartbeatCounter = counter;
      }
      s.lastHeartbeat = this.now();
      if (s.nativePublished) await this.delta(s, [], stamp, providerStamp, clock);
    } else if (frame.channel === 'market_trades') {
      const trades = [];
      for (const event of events) {
        const values = rows(event.trades, 5000);
        if (values.some((trade) => trade.product_id !== this.product))
          fail('SOURCE_PRODUCT_MISMATCH');
        if (event.type === 'snapshot') {
          if (s.tradeSnapshot) fail('SOURCE_REINITIALIZED');
          s.tradeSnapshot = true;
          this.metrics.ignoredHistoricalTrades += values.length;
        } else if (event.type === 'update' && s.tradeSnapshot) trades.push(...values);
        else fail('SOURCE_TRADE_SNAPSHOT_REQUIRED');
      }
      if (trades.length > 5000) fail('SOURCE_EVENT_LIMIT');
      if (s.nativePublished) await this.trades(s, trades);
      else this.metrics.ignoredPreReadyTrades += trades.length;
    } else if (frame.channel !== 'subscriptions') fail('SOURCE_CHANNEL_UNEXPECTED');
    if (!this.current(s)) return;
    if (
      !s.nativePublished &&
      s.bids &&
      s.tradeSnapshot &&
      s.lastHeartbeat !== null &&
      s.sourceLagMs <= 750
    ) {
      const result = await this.engine.feed('market.snapshot', {
        instrument: this.instrument,
        epoch: s.epoch,
        sequence: (++s.bookSequence).toString(),
        source_time_ns: stamp.toString(),
        ...clockMetadata(providerStamp, clock),
        bids: [...s.bids].map(([p, q]) => [decimal(p), q]),
        asks: [...s.asks].map(([p, q]) => [decimal(p), q]),
        coverage: { bid_floor: decimal(s.bidFloor), ask_ceiling: decimal(s.askCeiling) },
      });
      if (!result.valid) fail('SOURCE_SNAPSHOT_REJECTED');
      s.bookTime = { source_time_ns: stamp.toString(), ...clockMetadata(providerStamp, clock) };
      if (!this.current(s)) return;
      s.nativePublished = true;
      s.lastBook = this.now();
      s.readyAt = this.now();
      this.phase = 'ready';
      this.lastError = null;
      this.emit(true);
    }
    this.emit();
  }
  levels(s, event, changed) {
    if (event.product_id !== this.product) fail('SOURCE_PRODUCT_MISMATCH');
    const values = rows(event.updates, event.type === 'snapshot' ? 100000 : 10000);
    const snapshot = event.type === 'snapshot';
    if (snapshot && s.bids) fail('SOURCE_REINITIALIZED');
    if (!snapshot && (event.type !== 'update' || !s.bids)) fail('SOURCE_BOOK_SNAPSHOT_REQUIRED');
    const bids = snapshot ? new Map() : s.bids,
      asks = snapshot ? new Map() : s.asks;
    for (const value of values) {
      const side =
        value.side === 'bid' ? 'bid' : value.side === 'offer' ? 'ask' : fail('SOURCE_SIDE_INVALID');
      const price = amount(value.price_level, true),
        quantity = decimal(amount(value.new_quantity));
      if (
        !snapshot &&
        ((side === 'bid' && price < s.bidFloor) || (side === 'ask' && price > s.askCeiling))
      )
        continue;
      const levels = side === 'bid' ? bids : asks;
      if (snapshot && levels.has(price)) fail('SOURCE_DUPLICATE_LEVEL');
      if (quantity === '0') levels.delete(price);
      else levels.set(price, quantity);
      if (!snapshot) changed.set(side + ':' + price, { side, price: decimal(price), quantity });
    }
    if (!bids.size || !asks.size) fail('SOURCE_BOOK_EMPTY');
    if (snapshot) {
      const compare = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      s.bids = new Map([...bids].sort((a, b) => -compare(a, b)).slice(0, this.depth));
      s.asks = new Map([...asks].sort(compare).slice(0, this.depth));
      s.bidFloor = [...s.bids.keys()].at(-1);
      s.askCeiling = [...s.asks.keys()].at(-1);
    } else if (bids.size > 4000 || asks.size > 4000 || changed.size > 8000)
      fail('SOURCE_DEPTH_LIMIT');
  }
  async delta(s, updates, stamp, providerStamp, clock) {
    if (!this.current(s)) return;
    await this.engine.feed('market.delta', {
      instrument: this.instrument,
      epoch: s.epoch,
      sequence: (++s.bookSequence).toString(),
      updates,
      source_time_ns: stamp.toString(),
      ...clockMetadata(providerStamp, clock),
    });
    s.bookTime = { source_time_ns: stamp.toString(), ...clockMetadata(providerStamp, clock) };
    if (this.current(s)) s.lastBook = this.now();
  }
  captureSnapshot(capture) {
    const s = this.session;
    if (!s) return Promise.reject(Error('SOURCE_NOT_READY'));
    const task = s.chain.then(() => {
      if (
        !this.current(s) ||
        !s.nativePublished ||
        this.phase !== 'ready' ||
        this.now() - s.lastBook > 750
      )
        fail('SOURCE_NOT_READY');
      return capture({
        instrument: this.instrument,
        epoch: s.epoch,
        sequence: s.bookSequence.toString(),
        ...s.bookTime,
        bids: [...s.bids].map(([p, q]) => [decimal(p), q]),
        asks: [...s.asks].map(([p, q]) => [decimal(p), q]),
        coverage: { bid_floor: decimal(s.bidFloor), ask_ceiling: decimal(s.askCeiling) },
      });
    });
    s.chain = task.catch(() => {});
    return task;
  }
  async trades(s, trades) {
    const clock = s.clock;
    const ordered = trades
      .map((trade) => ({ trade, time: timeNs(trade.time), id: integer(trade.trade_id) }))
      .sort((a, b) =>
        a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
    for (const { trade, time, id } of ordered) {
      if (!this.current(s)) return;
      const normalized = projectTime(time, clock);
      fresh(normalized, this.now());
      const side =
        trade.side === 'BUY' ? 'bid' : trade.side === 'SELL' ? 'ask' : fail('SOURCE_SIDE_INVALID');
      const result = await this.engine.feed('market.trade', {
        instrument: this.instrument,
        epoch: s.epoch,
        sequence: (++s.tradeSequence).toString(),
        venue: 'coinbase-advanced',
        event_id: id.toString(),
        time_ns: normalized.toString(),
        ...clockMetadata(time, clock),
        maker_side: side,
        price: decimal(amount(trade.price, true)),
        quantity: decimal(amount(trade.size, true)),
      });
      if (result.duplicate) this.metrics.duplicateTrades++;
      else this.metrics.appliedTrades++;
      this.metrics.filledOrders += result.filled_orders || 0;
    }
  }
  async disconnect(reason, immediate = false) {
    const s = this.session;
    this.session = null;
    const generation = ++this.generation;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    if (s) {
      try {
        s.socket.close();
      } catch {}
      void s.dispatcher.destroy().catch(() => {});
      if (s.readyAt && this.now() - s.readyAt > 30000) this.attempts = 0;
    }
    this.lastError = reason || null;
    this.phase = !this.desired
      ? 'stopped'
      : reason === 'CIBYP_PRIVACY_UNAVAILABLE'
        ? 'blocked'
        : 'reconnecting';
    if (this.engine.state !== 'connected') {
      this.desired = false;
      this.phase = 'stopped';
    }
    if (!this.desired) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    this.emit(true);
    try {
      if (this.engine.state === 'connected')
        await this.engine.feed('market.invalidate', { id: this.instrument });
    } catch {
      if (generation === this.generation) {
        this.desired = false;
        this.phase = 'stopped';
      }
    }
    if (generation !== this.generation) return;
    if (!this.desired || this.phase === 'blocked') return;
    const delay = immediate
      ? 0
      : Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) * (0.8 + this.random() * 0.4);
    this.retry = setTimeout(() => void this.connect(), delay);
    this.retry.unref?.();
  }
  async stop() {
    this.desired = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.disconnect(null);
    return this.inspect();
  }
  drain() {
    return this.session?.chain || Promise.resolve();
  }
}
module.exports = {
  CoinbaseStream,
  ENDPOINT,
  PRODUCTS,
  parseFrame,
  timeNs,
  amount,
  decimal,
  calibrateClock,
};
