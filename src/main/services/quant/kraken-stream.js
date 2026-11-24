/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { crc32 } = require('node:zlib');
const {
  MarketStream,
  amount,
  decimal,
  integer,
  rows,
  timeNs,
  projectTime,
  clockMetadata,
  fail,
} = require('./market-stream');
const URL = 'wss://ws.kraken.com/v2';
const DEPTH = 10;
const NANO = 1000000n;
const MAX_LAG = 750n * NANO;

function parseFrame(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key === 'price' || key === 'qty') {
      if (typeof value !== 'number' || !context?.source) fail('SOURCE_AMOUNT_INVALID');
      const match = /^(\d+)(?:\.(\d+))?e-(\d{1,2})$/i.exec(context.source);
      if (!match) return context.source;
      const [, whole, fraction = '', exponent] = match;
      const point = whole.length - Number(exponent);
      const digits = whole + fraction;
      return point > 0
        ? digits.slice(0, point) + '.' + digits.slice(point)
        : '0.' + '0'.repeat(-point) + digits;
    }
    return key === 'trade_id' ? integer(value, context?.source).toString() : value;
  });
}

function updateSide(previous, levels, snapshot, isBid) {
  const next = new Map(previous);
  for (const { price, qty } of rows(levels, snapshot ? DEPTH : 200)) {
    const key = amount(price, true),
      size = amount(qty);
    if (snapshot && (next.has(key) || size === 0n)) fail('SOURCE_BOOK_INVALID');
    if (size)
      next.set(key, {
        digits: price.replace('.', '').replace(/^0+/, '') + qty.replace('.', '').replace(/^0+/, ''),
        size: decimal(size),
      });
    else next.delete(key);
  }
  return new Map(
    [...next].sort(([a], [b]) => (a === b ? 0 : a < b === isBid ? 1 : -1)).slice(0, DEPTH),
  );
}

function checksum(asks, bids) {
  return crc32([...asks.values(), ...bids.values()].map(({ digits }) => digits).join(''));
}

function bookChanges(side, before, after, bound) {
  const changes = [];
  for (const [price, { size }] of after) {
    if (before.get(price)?.size !== size)
      changes.push({ side, price: decimal(price), quantity: size });
  }
  for (const price of before.keys()) {
    // An unseen level outside the new depth is pruned by coverage, not a zero-size event.
    if (!after.has(price) && (side === 'bid' ? price >= bound : price <= bound))
      changes.push({ side, price: decimal(price), quantity: '0' });
  }
  return changes;
}

class KrakenStream extends MarketStream {
  constructor(options) {
    super({ ...options, venue: 'kraken', endpoint: URL, depth: DEPTH });
    this.requiresMovingCoverage = true;
    this.symbol = this.product.replace('-', '/');
  }
  subscriptionMessages() {
    return [
      {
        method: 'subscribe',
        req_id: 1,
        params: { channel: 'book', symbol: [this.symbol], depth: DEPTH, snapshot: true },
      },
      {
        method: 'subscribe',
        req_id: 2,
        params: { channel: 'trade', symbol: [this.symbol], snapshot: false },
      },
    ];
  }
  onOpen(s) {
    this.ping(s);
  }
  onWatch(s, now) {
    if (s.ping && now - s.ping.sent > 5000) fail('SOURCE_CLOCK_TIMEOUT');
    if (!s.ping && s.clock && now - Number(BigInt(s.clock.calibrated_at_ns) / NANO) > 20000)
      this.ping(s);
  }
  ping(s) {
    const id = (s.pingId ?? 100) + 1;
    s.pingId = id;
    s.ping = { id, sent: this.now() };
    s.socket.send(JSON.stringify({ method: 'ping', req_id: id }));
  }
  pong(s, frame, received) {
    if (!s.ping || s.ping.id !== frame.req_id || frame.success === false || frame.error)
      fail('SOURCE_CLOCK_SAMPLE_INVALID');
    const inbound = timeNs(frame.time_in),
      outbound = timeNs(frame.time_out);
    if (received < s.ping.sent || outbound < inbound) fail('SOURCE_CLOCK_SAMPLE_INVALID');
    const lower = outbound - (BigInt(received) + 25n) * NANO;
    const upper = inbound - (BigInt(s.ping.sent) - 25n) * NANO;
    if (lower < -60000000000n || upper > 60000000000n || lower > upper)
      fail('SOURCE_CLOCK_UNCERTAIN');
    if (upper - lower > 2000000000n) {
      s.clockRetries = (s.clockRetries || 0) + 1;
      if (s.clockRetries >= 3) fail('SOURCE_CLOCK_UNCERTAIN');
      return this.ping(s);
    }
    s.clockRetries = 0;
    s.clock = {
      offset_ns: String(upper),
      uncertainty_ns: String(upper - lower),
      calibrated_at_ns: String(BigInt(received) * NANO),
    };
    s.ping = null;
  }
  async process(s, text, received) {
    this.checkLocalClock(s);
    const frame = parseFrame(text);
    if (frame.method === 'pong') this.pong(s, frame, received);
    else if (frame.method === 'subscribe') {
      const { result } = frame;
      if (frame.success !== true || result?.symbol !== this.symbol)
        fail('SOURCE_SUBSCRIPTION_ERROR');
      if (
        frame.req_id === 1 &&
        result.channel === 'book' &&
        result.depth === DEPTH &&
        result.snapshot === true
      )
        s.bookSubscribed = true;
      else if (frame.req_id === 2 && result.channel === 'trade' && result.snapshot === false)
        s.tradeSubscribed = true;
      else fail('SOURCE_SUBSCRIPTION_ERROR');
    } else if (frame.channel === 'status') {
      if (rows(frame.data, 1)[0]?.system !== 'online') fail('SOURCE_MARKET_UNAVAILABLE');
      s.online = true;
    } else if (frame.channel === 'book') {
      const [item] = rows(frame.data, 1);
      await this.bookFrame(s, frame.type, item, received);
    } else if (frame.channel === 'trade' && frame.type === 'update') {
      await this.tradeFrame(s, rows(frame.data, 1000));
    } else if (frame.channel !== 'heartbeat') fail('SOURCE_CHANNEL_UNEXPECTED');
    if (
      s.online &&
      s.clock &&
      s.bookSubscribed &&
      s.tradeSubscribed &&
      s.bookStamp &&
      !s.nativePublished
    ) {
      const { stamp, providerStamp, clock } = s.bookStamp;
      if (BigInt(this.now()) * NANO - stamp <= MAX_LAG)
        await this.publishSnapshot(s, stamp, providerStamp, clock);
    }
    this.emit();
  }
  async hold(s) {
    if (!this.current(s) || !s.nativePublished) return;
    s.nativePublished = false;
    s.needsSnapshotSince = this.now();
    this.metrics.latencyHolds++;
    this.phase = 'delayed';
    this.lastError = 'SOURCE_CATCHING_UP';
    await this.engine.feed('market.invalidate', { id: this.instrument });
    this.emit(true);
  }
  async bookFrame(s, type, item, received) {
    if (item?.symbol !== this.symbol) fail('SOURCE_PRODUCT_MISMATCH');
    const snapshot = type === 'snapshot';
    if (snapshot && s.bids) fail('SOURCE_REINITIALIZED');
    if (!snapshot && (type !== 'update' || !s.bids)) fail('SOURCE_BOOK_SNAPSHOT_REQUIRED');
    const bids = updateSide(s.krakenBids, item.bids, snapshot, true);
    const asks = updateSide(s.krakenAsks, item.asks, snapshot, false);
    if (!bids.size || !asks.size || bids.keys().next().value >= asks.keys().next().value)
      fail('SOURCE_BOOK_INVALID');
    if (checksum(asks, bids) !== item.checksum) fail('SOURCE_CHECKSUM_MISMATCH');
    // Some initial snapshots omit the exchange timestamp. Retain the actual receipt time in that case.
    const clock = item.timestamp ? s.clock : null;
    const providerStamp = item.timestamp ? timeNs(item.timestamp) : null;
    const stamp = clock ? projectTime(providerStamp, clock) : BigInt(received) * NANO;
    const lag = BigInt(this.now()) * NANO - stamp;
    if (lag < -250n * NANO || lag > 30000n * NANO) fail('SOURCE_TIME_STALE');
    s.sourceLagMs = clock ? Math.max(0, Number(lag / NANO)) : null;
    const bidFloor = [...bids.keys()].at(-1),
      askCeiling = [...asks.keys()].at(-1);
    const moving = s.bidFloor !== bidFloor || s.askCeiling !== askCeiling;
    const changes = s.nativePublished
      ? [
          ...bookChanges('bid', s.krakenBids, bids, bidFloor),
          ...bookChanges('ask', s.krakenAsks, asks, askCeiling),
        ]
      : [];
    s.krakenBids = bids;
    s.krakenAsks = asks;
    s.bids = new Map([...bids].map(([price, row]) => [price, row.size]));
    s.asks = new Map([...asks].map(([price, row]) => [price, row.size]));
    s.bidFloor = bidFloor;
    s.askCeiling = askCeiling;
    s.bookStamp = { stamp, providerStamp, clock };
    if (lag > MAX_LAG || ((!snapshot || providerStamp !== null) && !clock)) {
      s.bookStamp = null;
      return this.hold(s);
    }
    if (s.nativePublished)
      await this.delta(
        s,
        changes,
        stamp,
        providerStamp,
        clock,
        moving ? this.coverage(s) : undefined,
      );
  }
  async tradeFrame(s, values) {
    if (values.some((trade) => trade.symbol !== this.symbol)) fail('SOURCE_PRODUCT_MISMATCH');
    if (
      s.nativePublished &&
      BigInt(this.now()) * NANO - BigInt(s.bookTime.source_time_ns) > MAX_LAG
    )
      await this.hold(s);
    if (!s.nativePublished || !this.current(s)) {
      this.metrics.ignoredPreReadyTrades += values.length;
      return;
    }
    const clock = s.clock;
    const ordered = values
      .map((trade) => ({ trade, time: timeNs(trade.timestamp), id: integer(trade.trade_id) }))
      .sort((a, b) =>
        a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
    for (const { trade, time, id } of ordered) {
      if (!this.current(s)) return;
      const side =
        trade.side === 'buy' ? 'ask' : trade.side === 'sell' ? 'bid' : fail('SOURCE_SIDE_INVALID');
      const stamp = projectTime(time, clock);
      const lag = BigInt(this.now()) * NANO - stamp;
      if (lag < -250n * NANO || lag > 2000n * NANO) fail('SOURCE_TIME_STALE');
      const matched = await this.engine.feed('market.trade', {
        instrument: this.instrument,
        epoch: s.epoch,
        sequence: String(++s.tradeSequence),
        venue: 'kraken-spot',
        event_id: String(id),
        time_ns: String(stamp),
        ...clockMetadata(time, clock),
        maker_side: side,
        price: decimal(amount(trade.price, true)),
        quantity: decimal(amount(trade.qty, true)),
      });
      if (matched.duplicate) this.metrics.duplicateTrades++;
      else this.metrics.appliedTrades++;
      this.metrics.filledOrders += matched.filled_orders || 0;
    }
  }
}
module.exports = { KrakenStream, parseFrame };
