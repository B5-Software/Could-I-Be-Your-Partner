/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const { SubscriptionPacer } = require('./subscription-pacer');
const { CoinbaseStream, PRODUCTS, amount, decimal, calibrateClock } = require('./coinbase-stream');
const { KrakenStream } = require('./kraken-stream');
const { venues } = require('../../../shared/quant-native-venues.json');
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
function nativeSourceKey(product, venue = 'coinbase') {
  if (!venues.some((item) => item.id === venue) || !PRODUCTS.includes(product))
    fail('SOURCE_MARKET_INVALID');
  return venue === 'coinbase' ? product : venue + ':' + product;
}
function selectNativeSource(sources, product, venue = 'coinbase') {
  nativeSourceKey(product, venue);
  return sources.find(
    (source) => source.product === product && (source.venue || 'coinbase') === venue,
  );
}
async function marketRules(market, product, venue) {
  const [base, quote] = product.split('-');
  if (venue === 'kraken') {
    const metadata = await market.krakenProduct(product);
    const legacyBase = base === 'BTC' ? 'XBT' : base;
    if (
      metadata.wsname !== legacyBase + '/' + quote ||
      metadata.altname !== legacyBase + quote ||
      metadata.aclass_base !== 'currency' ||
      metadata.aclass_quote !== 'currency'
    )
      fail('SOURCE_PRODUCT_MISMATCH');
    if (metadata.status !== 'online') fail('SOURCE_MARKET_UNAVAILABLE');
    if (
      !Number.isInteger(metadata.lot_decimals) ||
      metadata.lot_decimals < 0 ||
      metadata.lot_decimals > 18 ||
      metadata.lot_multiplier !== 1
    )
      fail('SOURCE_MARKET_RULES_INVALID');
    return {
      base,
      quote,
      tick: decimal(amount(metadata.tick_size, true)),
      lot: decimal(10n ** BigInt(18 - metadata.lot_decimals)),
      min_notional: decimal(amount(metadata.costmin, true)),
      min_quantity: decimal(amount(metadata.ordermin, true)),
    };
  }
  const metadata = await market.publicProduct(product);
  if (
    metadata.product_id !== product ||
    metadata.product_type !== 'SPOT' ||
    metadata.base_currency_id !== base ||
    metadata.quote_currency_id !== quote
  )
    fail('SOURCE_PRODUCT_MISMATCH');
  if (
    metadata.is_disabled ||
    metadata.trading_disabled ||
    metadata.cancel_only ||
    metadata.auction_mode
  )
    fail('SOURCE_MARKET_UNAVAILABLE');
  return {
    base,
    quote,
    tick: decimal(amount(metadata.price_increment, true)),
    lot: decimal(amount(metadata.base_increment, true)),
    min_notional: decimal(amount(metadata.quote_min_size, true)),
  };
}
class NativeMarkets {
  constructor({ engine, market, publish = () => {}, sourceOptions = {} }) {
    Object.assign(this, { engine, market, publish, sourceOptions });
    this.sources = new Map();
    this.starting = new Map();
    this.revisions = new Map();
    this.pending = new Map();
    this.disposed = false;
    this.subscriptions = new SubscriptionPacer();
  }
  inspect() {
    return {
      venue: 'coinbase',
      products: PRODUCTS,
      venues: venues.map((venue) => ({ ...venue, products: PRODUCTS })),
      sources: [...new Set([...this.sources.keys(), ...this.pending.keys()])].map(
        (product) =>
          this.pending.get(product) || {
            ...this.sources.get(product).source.inspect(),
            assumptions: this.sources.get(product).assumptions,
          },
      ),
    };
  }
  changed() {
    try {
      this.publish({ type: 'quant-market-sources-changed', ...this.inspect() });
    } catch {}
  }
  async start({ product, venue = 'coinbase', feeBps = 10 } = {}) {
    const key = nativeSourceKey(product, venue);
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) fail('SOURCE_FEE_INVALID');
    const pending = this.starting.get(key);
    if (pending) {
      if (pending.feeBps !== feeBps) fail('SOURCE_STOP_BEFORE_FEE_CHANGE');
      return pending.task;
    }
    const task = this.begin(key, product, venue, feeBps).finally(() => this.starting.delete(key));
    this.starting.set(key, { task, feeBps });
    return task;
  }
  async begin(key, product, venue, feeBps) {
    if (this.disposed) fail('QUANT_STOPPED');
    if (this.engine.state !== 'connected') fail('NATIVE_NOT_RUNNING');
    const previous = this.sources.get(key);
    if (previous?.source.desired) {
      if (previous.assumptions.feeBps !== feeBps) fail('SOURCE_STOP_BEFORE_FEE_CHANGE');
      return { ...previous.source.inspect(), assumptions: previous.assumptions };
    }
    const revision = (this.revisions.get(key) || 0) + 1;
    this.revisions.set(key, revision);
    this.pending.set(key, {
      product,
      venue,
      phase: 'resolving',
      desired: true,
      lastError: null,
    });
    this.changed();
    try {
      const rules = await marketRules(this.market, product, venue);
      if (this.disposed || this.revisions.get(key) !== revision)
        return { product, venue, phase: 'stopped', desired: false };
      const config = { ...rules, fee_bps: feeBps };
      const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
      const instrument = { id: venue + ':' + product + ':' + hash, ...config };
      await this.engine.call('instrument.register', instrument);
      if (this.disposed || this.revisions.get(key) !== revision)
        return { product, venue, phase: 'stopped', desired: false };
      if (previous) await previous.source.stop();
      if (this.disposed || this.revisions.get(key) !== revision)
        return { product, venue, phase: 'stopped', desired: false };
      const assumptions = {
        feeBps,
        feeKind: 'assumed-maker',
        tick: config.tick,
        lot: config.lot,
        minNotional: config.min_notional,
        venue,
        quoteCurrency: config.quote,
        ...(config.min_quantity && { minQuantity: config.min_quantity }),
        execution: 'paper-only',
        baseAmm: false,
      };
      const Stream = venue === 'kraken' ? KrakenStream : CoinbaseStream;
      const source = new Stream({
        engine: this.engine,
        product,
        instrument: instrument.id,
        publish: this.publish,
        ...(venue === 'coinbase' && {
          calibrate: () => calibrateClock(() => this.market.publicTime()),
        }),
        subscribe: (send) => this.subscriptions.run(send),
        ...this.sourceOptions,
      });
      this.sources.set(key, { source, assumptions, instrument });
      this.pending.delete(key);
      const state = await source.start();
      this.changed();
      return { ...state, assumptions };
    } catch (error) {
      if (this.revisions.get(key) === revision && !this.disposed) {
        const code = /^[A-Z][A-Z_0-9]{1,80}$/.test(error.code || error.message || '')
          ? error.code || error.message
          : 'SOURCE_METADATA_FAILED';
        this.pending.set(key, {
          product,
          venue,
          phase: 'failed',
          desired: false,
          lastError: code,
        });
        this.changed();
        throw Error(code);
      }
      return { product, venue, phase: 'stopped', desired: false };
    }
  }
  async stop(product, venue) {
    const key = nativeSourceKey(product, venue);
    this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    this.pending.delete(key);
    await this.sources.get(key)?.source.stop();
    this.changed();
    return this.inspect();
  }
  async stopAll() {
    for (const key of [...this.sources.keys(), ...this.starting.keys()])
      this.revisions.set(key, (this.revisions.get(key) || 0) + 1);
    this.pending.clear();
    await Promise.all([...this.sources.values()].map(({ source }) => source.stop()));
    this.changed();
  }
  async book(product, venue) {
    const key = nativeSourceKey(product, venue);
    const entry = this.sources.get(key);
    if (!entry) fail('SOURCE_NOT_STARTED');
    const inactive = (reason) => ({
      valid: false,
      eligible: false,
      reason,
      bids: [],
      asks: [],
      source: entry.source.inspect(),
      assumptions: entry.assumptions,
    });
    if (this.engine.state !== 'connected') return inactive('NATIVE_NOT_RUNNING');
    let book;
    try {
      book = await this.engine.call('book', { id: entry.source.instrument });
    } catch (error) {
      if (this.engine.state !== 'connected') return inactive('NATIVE_NOT_RUNNING');
      if (error.code === 'BOOK_SNAPSHOT_REQUIRED') return inactive('SOURCE_NOT_READY');
      throw error;
    }
    const source = entry.source.inspect();
    return {
      ...book,
      eligible: source.phase === 'ready' && book.eligible,
      source,
      assumptions: entry.assumptions,
    };
  }
  nativeChanged(event) {
    if (
      event.type === 'quant-native-changed' &&
      !['connected', 'starting'].includes(event.native?.state)
    )
      void this.stopAll().catch(() => {});
  }
  dispose() {
    this.disposed = true;
    void this.stopAll().catch(() => {});
  }
}
module.exports = { NativeMarkets, nativeSourceKey, selectNativeSource };
