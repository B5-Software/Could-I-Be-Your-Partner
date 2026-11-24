/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHmac } = require('node:crypto');

const origins = Object.freeze({
  sandbox: 'https://api-public.sandbox.exchange.coinbase.com',
  live: 'https://api.exchange.coinbase.com',
});
const id = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const products = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const fail = (code) => {
  throw Error(code);
};

function environment(value) {
  if (typeof value !== 'string' || !Object.hasOwn(origins, value)) fail('EXCHANGE_ENVIRONMENT');
  return value;
}

function credentials({ key, secret, passphrase }) {
  const ascii = (value) => typeof value === 'string' && /^[!-~]{1,256}$/.test(value);
  if (
    !ascii(key) ||
    !ascii(passphrase) ||
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(secret) ||
    Buffer.from(secret, 'base64').toString('base64') !== secret
  )
    fail('EXCHANGE_CREDENTIAL_FORMAT');
  return { key, secret, passphrase };
}

function authHeaders(account, timestamp, method, route, payload = '') {
  const key = Buffer.from(account.secret, 'base64');
  try {
    return {
      'CB-ACCESS-KEY': account.key,
      'CB-ACCESS-PASSPHRASE': account.passphrase,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-ACCESS-SIGN': createHmac('sha256', key)
        .update(timestamp + method + route + payload)
        .digest('base64'),
    };
  } finally {
    key.fill(0);
  }
}

function userSubscription(account, productIds, now = Date.now()) {
  const timestamp = String(now / 1000);
  const headers = authHeaders(account, timestamp, 'GET', '/users/self/verify');
  return {
    type: 'subscribe',
    channels: ['user', 'heartbeat'].map((name) => ({ name, product_ids: productIds })),
    timestamp,
    key: headers['CB-ACCESS-KEY'],
    passphrase: headers['CB-ACCESS-PASSPHRASE'],
    signature: headers['CB-ACCESS-SIGN'],
  };
}

class CoinbaseExchange {
  constructor(fetch) {
    this.fetch = fetch;
    this.next = new Map();
  }
  async request(env, method, route, account, body, beforeSend, signal) {
    const origin = origins[environment(env)];
    // Reserve one slot synchronously across all workspaces and keys for this host.
    const now = performance.now();
    const slot = Math.max(now, this.next.get(env) || 0);
    if (slot - now > 2500) fail('EXCHANGE_RATE_LIMIT');
    this.next.set(env, slot + 130);
    if (slot > now)
      await require('node:timers/promises').setTimeout(Math.ceil(slot - now), undefined, {
        signal,
      });
    signal?.throwIfAborted();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timeout = AbortSignal.timeout(10000);
    const headers = account
      ? authHeaders(account, String(Date.now() / 1000), method, route.split('?')[0], payload)
      : {};
    const request = {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(payload && { 'Content-Type': 'application/json' }),
      },
      ...(payload && { body: payload }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
    // Persist the operation first, then recheck local authority immediately before I/O.
    beforeSend?.();
    let response;
    try {
      response = await this.fetch(origin + route, request);
    } catch {
      fail('EXCHANGE_NETWORK');
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      this.next.set(
        env,
        Math.max(
          this.next.get(env) || 0,
          performance.now() +
            (Number.isFinite(retry) && retry > 0 ? Math.min(60, retry) * 1000 : 1000),
        ),
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(
        Error(
          response.status === 404
            ? 'EXCHANGE_ORDER_NOT_FOUND'
            : response.status === 401 || response.status === 403
              ? 'EXCHANGE_AUTH'
              : response.status === 429
                ? 'EXCHANGE_RATE_LIMIT'
                : 'EXCHANGE_HTTP',
        ),
        { httpStatus: response.status },
      );
    }
    try {
      const reader = response.body.getReader();
      const parts = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) fail('EXCHANGE_RESPONSE');
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(parts, bytes).toString('utf8'));
    } catch {
      fail('EXCHANGE_RESPONSE');
    }
  }
  accounts(env, account, signal) {
    return this.request(env, 'GET', '/accounts', account, undefined, undefined, signal);
  }
  fees(env, account, signal) {
    return this.request(env, 'GET', '/fees', account, undefined, undefined, signal);
  }
  product(env, product, signal) {
    if (!products.includes(product)) fail('EXCHANGE_PRODUCT');
    return this.request(env, 'GET', '/products/' + product, null, undefined, undefined, signal);
  }
  submit(env, account, body, beforeSend, signal) {
    return this.request(env, 'POST', '/orders', account, body, beforeSend, signal);
  }
  lookup(env, account, order, signal) {
    if (!id.test(order.clientId) || (order.venueId && !id.test(order.venueId)))
      fail('EXCHANGE_ORDER_ID');
    return this.request(
      env,
      'GET',
      '/orders/' + (order.venueId || 'client:' + order.clientId),
      account,
      undefined,
      undefined,
      signal,
    );
  }
  cancel(env, account, order, beforeSend, signal) {
    if (!id.test(order.clientId) || (order.venueId && !id.test(order.venueId)))
      fail('EXCHANGE_ORDER_ID');
    if (!products.includes(order.product) || account.profileId !== order.profileId)
      fail('EXCHANGE_PRODUCT');
    const target = order.venueId || 'client:' + order.clientId;
    return this.request(
      env,
      'DELETE',
      '/orders/' + target + '?product_id=' + order.product,
      account,
      undefined,
      beforeSend,
      signal,
    );
  }
}

module.exports = { CoinbaseExchange, environment, credentials, id, products, userSubscription };
