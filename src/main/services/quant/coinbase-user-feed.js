/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { WebSocket } = require('undici');
const network = require('../../net-proxy');
const { userSubscription, products, id, environment } = require('./coinbase-exchange');

const urls = Object.freeze({
  sandbox: 'wss://ws-feed-public.sandbox.exchange.coinbase.com',
  live: 'wss://ws-feed.exchange.coinbase.com',
});
const frameLimit = 64 * 1024;
const lifecycleTypes = new Set(['received', 'open', 'match', 'change', 'done', 'activate']);

class CoinbaseUserFeed {
  constructor({
    env,
    account,
    onStatus,
    onHint,
    socketFactory = (url, options) => new WebSocket(url, options),
    createDispatcher = network.createWebSocketDispatcher,
    onPolicyChange = network.onPolicyChange,
    retryDelay = (attempt) => Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)),
  }) {
    Object.assign(this, { account, onStatus, onHint, socketFactory, createDispatcher, retryDelay });
    this.url = urls[environment(env)];
    this.products = [];
    this.attempts = 0;
    this.unsubscribe = onPolicyChange(() => {
      this.detach();
      this.attempts = 0;
      if (this.products.length) void this.connect();
    });
  }
  setProducts(values) {
    const next = products.filter((product) => values.includes(product));
    if (next.join(',') === this.products.join(',') || this.closed) return;
    this.products = next;
    this.detach();
    this.attempts = 0;
    if (next.length) void this.connect();
    else this.onStatus('idle');
  }
  detach() {
    clearTimeout(this.retry);
    const session = this.session;
    this.session = null;
    if (!session) return;
    clearTimeout(session.deadline);
    try {
      session.socket?.close();
    } catch {
      /* Already closed. */
    }
    if (session.dispatcher) void session.dispatcher.destroy().catch(() => {});
  }
  async connect() {
    if (this.closed || !this.products.length || this.session) return;
    const session = { products: this.products, subscribed: false };
    this.session = session;
    const fail = (error) => {
      if (this.session !== session) return;
      this.detach();
      this.onStatus('fallback', error);
      this.retry = setTimeout(() => void this.connect(), this.retryDelay(this.attempts++));
      this.retry.unref?.();
    };
    const deadline = (ms) => {
      clearTimeout(session.deadline);
      session.deadline = setTimeout(() => fail('EXCHANGE_WATCH_TIMEOUT'), ms);
      session.deadline.unref?.();
    };
    this.onStatus('connecting');
    deadline(10000);
    try {
      const dispatcher = await this.createDispatcher(this.url, { maxPayloadSize: frameLimit });
      if (this.session !== session) {
        await dispatcher.destroy();
        return;
      }
      session.dispatcher = dispatcher;
      const socket = this.socketFactory(this.url, { dispatcher });
      session.socket = socket;
      socket.addEventListener('open', () => {
        if (this.session !== session) return;
        try {
          if (new URL(socket.url).origin !== new URL(this.url).origin)
            throw Error('EXCHANGE_WATCH_NETWORK');
          deadline(5000);
          socket.send(JSON.stringify(userSubscription(this.account, session.products)));
        } catch {
          fail('EXCHANGE_WATCH_NETWORK');
        }
      });
      socket.addEventListener('error', () => fail('EXCHANGE_WATCH_NETWORK'));
      socket.addEventListener('close', () => fail('EXCHANGE_WATCH_NETWORK'));
      socket.addEventListener('message', ({ data }) => {
        if (this.session !== session) return;
        let frame;
        try {
          if (typeof data !== 'string' || Buffer.byteLength(data) > frameLimit)
            throw Error('EXCHANGE_WATCH_FORMAT');
          frame = JSON.parse(data);
          if (!frame || typeof frame.type !== 'string') throw Error('EXCHANGE_WATCH_FORMAT');
        } catch {
          fail('EXCHANGE_WATCH_FORMAT');
          return;
        }
        if (frame.type === 'error') return fail('EXCHANGE_WATCH_SUBSCRIPTION');
        if (frame.type === 'subscriptions') {
          const covers = (name) =>
            Array.isArray(frame.channels) &&
            frame.channels.some(
              (channel) =>
                channel?.name === name &&
                Array.isArray(channel.product_ids) &&
                session.products.every((product) => channel.product_ids.includes(product)),
            );
          if (!covers('user') || !covers('heartbeat')) return fail('EXCHANGE_WATCH_SUBSCRIPTION');
          if (!session.subscribed) {
            session.subscribed = true;
            this.onStatus('live');
          }
          deadline(15000);
          return;
        }
        if (!session.subscribed || !session.products.includes(frame.product_id)) return;
        if (frame.type === 'heartbeat') {
          this.attempts = 0;
          deadline(15000);
          return;
        }
        if (
          !lifecycleTypes.has(frame.type) ||
          (frame.profile_id != null && frame.profile_id !== this.account.profileId)
        )
          return;
        const references =
          frame.type === 'match' ? [frame.maker_order_id, frame.taker_order_id] : [frame.order_id];
        const orderIds = references.filter((value) => typeof value === 'string' && id.test(value));
        const clientId =
          typeof frame.client_oid === 'string' && id.test(frame.client_oid)
            ? frame.client_oid
            : null;
        if (orderIds.length || clientId) this.onHint(frame.product_id, orderIds, clientId);
      });
    } catch {
      fail('EXCHANGE_WATCH_NETWORK');
    }
  }
  dispose() {
    this.closed = true;
    this.detach();
    this.unsubscribe?.();
    this.account = null;
  }
}

module.exports = { CoinbaseUserFeed };
