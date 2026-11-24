/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const {
  MarketStream,
  integer,
  timeNs,
  fresh,
  rows,
  fail,
  amount,
  decimal,
  calibrateClock,
  projectTime,
  clockMetadata,
} = require('./market-stream');
const ENDPOINT = 'wss://advanced-trade-ws.coinbase.com';
const { products: PRODUCTS } = require('../../../shared/quant-native-venues.json');
function parseFrame(text) {
  return JSON.parse(text, (key, value, context) =>
    ['sequence_num', 'trade_id', 'heartbeat_counter'].includes(key)
      ? integer(value, context?.source).toString()
      : value,
  );
}
class CoinbaseStream extends MarketStream {
  constructor(options = {}) {
    if (!PRODUCTS.includes(options.product)) fail('SOURCE_MARKET_INVALID');
    super({ ...options, venue: 'coinbase', endpoint: ENDPOINT });
  }
  subscriptionMessages() {
    return ['level2', 'market_trades', 'heartbeats'].map((channel) => ({
      type: 'subscribe',
      channel,
      product_ids: [this.product],
    }));
  }
  async process(s, text) {
    this.checkLocalClock(s);
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
      s.needsSnapshotSince = this.now();
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
      await this.publishSnapshot(s, stamp, providerStamp, clock);
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
