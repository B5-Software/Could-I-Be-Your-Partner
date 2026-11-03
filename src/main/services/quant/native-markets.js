/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash } = require('node:crypto');
const { SubscriptionPacer } = require('./subscription-pacer');
const { CoinbaseStream, PRODUCTS, amount, decimal, calibrateClock } = require('./coinbase-stream');
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
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
  start(input = {}) {
    const { product } = input;
    if (!PRODUCTS.includes(product)) return Promise.reject(Error('SOURCE_MARKET_INVALID'));
    if (this.starting.has(product)) return this.starting.get(product);
    const task = this.begin(product, input).finally(() => this.starting.delete(product));
    this.starting.set(product, task);
    return task;
  }
  async begin(product, input) {
    if (this.disposed) fail('QUANT_STOPPED');
    if (this.engine.state !== 'connected') fail('NATIVE_NOT_RUNNING');
    const feeBps = input.feeBps ?? 10;
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) fail('SOURCE_FEE_INVALID');
    const previous = this.sources.get(product);
    if (previous?.source.desired) {
      if (previous.assumptions.feeBps !== feeBps) fail('SOURCE_STOP_BEFORE_FEE_CHANGE');
      return { ...previous.source.inspect(), assumptions: previous.assumptions };
    }
    const revision = (this.revisions.get(product) || 0) + 1;
    this.revisions.set(product, revision);
    this.pending.set(product, {
      product,
      venue: 'coinbase',
      phase: 'resolving',
      desired: true,
      lastError: null,
    });
    this.changed();
    try {
      const metadata = await this.market.publicProduct(product);
      if (this.disposed || this.revisions.get(product) !== revision)
        return { product, phase: 'stopped', desired: false };
      const [base, quote] = product.split('-');
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
      const config = {
        base,
        quote,
        tick: decimal(amount(metadata.price_increment, true)),
        lot: decimal(amount(metadata.base_increment, true)),
        min_notional: decimal(amount(metadata.quote_min_size, true)),
        fee_bps: feeBps,
      };
      const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
      const instrument = { id: 'coinbase:' + product + ':' + hash, ...config };
      await this.engine.call('instrument.register', instrument);
      if (this.disposed || this.revisions.get(product) !== revision)
        return { product, phase: 'stopped', desired: false };
      if (previous) await previous.source.stop();
      if (this.disposed || this.revisions.get(product) !== revision)
        return { product, phase: 'stopped', desired: false };
      const assumptions = {
        feeBps,
        feeKind: 'assumed-maker',
        tick: config.tick,
        lot: config.lot,
        minNotional: config.min_notional,
        venue: 'coinbase',
        quoteCurrency: quote,
        execution: 'paper-only',
        baseAmm: false,
      };
      const source = new CoinbaseStream({
        engine: this.engine,
        product,
        instrument: instrument.id,
        publish: this.publish,
        calibrate: () => calibrateClock(() => this.market.publicTime()),
        subscribe: (send) => this.subscriptions.run(send),
        ...this.sourceOptions,
      });
      this.sources.set(product, { source, assumptions, instrument });
      this.pending.delete(product);
      const state = await source.start();
      this.changed();
      return { ...state, assumptions };
    } catch (error) {
      if (this.revisions.get(product) === revision && !this.disposed) {
        const code = /^[A-Z][A-Z_0-9]{1,80}$/.test(error.code || error.message || '')
          ? error.code || error.message
          : 'SOURCE_METADATA_FAILED';
        this.pending.set(product, {
          product,
          venue: 'coinbase',
          phase: 'failed',
          desired: false,
          lastError: code,
        });
        this.changed();
        throw Error(code);
      }
      return { product, phase: 'stopped', desired: false };
    }
  }
  async stop(product) {
    if (!PRODUCTS.includes(product)) fail('SOURCE_MARKET_INVALID');
    this.revisions.set(product, (this.revisions.get(product) || 0) + 1);
    this.pending.delete(product);
    await this.sources.get(product)?.source.stop();
    this.changed();
    return this.inspect();
  }
  async stopAll() {
    for (const product of PRODUCTS)
      this.revisions.set(product, (this.revisions.get(product) || 0) + 1);
    this.pending.clear();
    await Promise.all([...this.sources.values()].map(({ source }) => source.stop()));
    this.changed();
  }
  async book(product) {
    const entry = this.sources.get(product);
    if (!entry) fail('SOURCE_NOT_STARTED');
    const inactive = () => ({
      valid: false,
      eligible: false,
      reason: 'NATIVE_NOT_RUNNING',
      bids: [],
      asks: [],
      source: entry.source.inspect(),
      assumptions: entry.assumptions,
    });
    if (this.engine.state !== 'connected') return inactive();
    let book;
    try {
      book = await this.engine.call('book', { id: entry.source.instrument });
    } catch (error) {
      if (this.engine.state !== 'connected') return inactive();
      throw error;
    }
    return {
      ...book,
      source: entry.source.inspect(),
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
module.exports = { NativeMarkets };
