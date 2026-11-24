/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { CoinbaseUserFeed } = require('../../src/main/services/quant/coinbase-user-feed');
const { ExchangeOrders } = require('../../src/main/services/quant/exchange-orders');

const profileId = '11111111-2222-3333-4444-555555555555';
const clientId = '10000000-2222-3333-4444-555555555555';
const venueId = '90000000-2222-3333-4444-555555555555';
const account = {
  profileId,
  credentialId: '55555555-2222-3333-4444-555555555555',
  key: 'fixture-key',
  passphrase: 'fixture-passphrase',
  secret: Buffer.alloc(64, 17).toString('base64'),
};
const product = 'ETH-USD';
const acknowledged = {
  type: 'subscriptions',
  channels: ['user', 'heartbeat'].map((name) => ({ name, product_ids: [product] })),
};

async function until(check) {
  for (let i = 0; i < 300; i++) {
    const result = check();
    if (result) return result;
    await delay(5);
  }
  assert.fail('Order watch fixture timed out');
}

test('Coinbase user feed signs the fixed endpoint, filters frames, and fences stale sockets', async (t) => {
  class Socket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
    receive(frame) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }
  }
  const sockets = [],
    states = [],
    hints = [];
  let policyChanged,
    destroyed = 0,
    unsubscribed = false;
  const feed = new CoinbaseUserFeed({
    env: 'sandbox',
    account,
    onStatus: (...values) => states.push(values),
    onHint: (...values) => hints.push(values),
    createDispatcher: async (url, options) => {
      assert.equal(url, 'wss://ws-feed-public.sandbox.exchange.coinbase.com');
      assert.equal(options.maxPayloadSize, 65536);
      return { destroy: async () => destroyed++ };
    },
    socketFactory: (url) => {
      const socket = new Socket(url);
      sockets.push(socket);
      return socket;
    },
    onPolicyChange: (callback) => {
      policyChanged = callback;
      return () => {
        unsubscribed = true;
      };
    },
    retryDelay: () => 5,
  });
  t.after(() => feed.dispose());
  feed.setProducts([product, 'UNMANAGED-USD']);
  const first = await until(() => sockets[0]);
  first.dispatchEvent(new Event('open'));
  const subscription = first.sent[0];
  assert.deepEqual(subscription.channels, acknowledged.channels);
  assert.equal(subscription.type, 'subscribe');
  assert.equal(subscription.key, account.key);
  assert.equal(subscription.passphrase, account.passphrase);
  assert.equal(
    subscription.signature,
    createHmac('sha256', Buffer.from(account.secret, 'base64'))
      .update(subscription.timestamp + 'GET/users/self/verify')
      .digest('base64'),
  );
  const received = {
    type: 'received',
    profile_id: profileId,
    product_id: product,
    order_id: venueId,
    client_oid: clientId,
  };
  first.receive(received);
  assert.equal(hints.length, 0);
  first.receive(acknowledged);
  first.receive({ ...received, profile_id: 'different-profile' });
  first.receive({ ...received, product_id: 'BTC-USD' });
  first.receive({ type: 'ticker', product_id: product, order_id: venueId });
  first.receive(received);
  first.receive({
    type: 'match',
    product_id: product,
    maker_order_id: venueId,
    taker_order_id: null,
  });
  assert.deepEqual(hints, [
    [product, [venueId], clientId],
    [product, [venueId], null],
  ]);
  assert.deepEqual(states.at(-1), ['live']);
  policyChanged();
  const second = await until(() => sockets[1]);
  assert.equal(destroyed, 1);
  first.receive(received);
  assert.equal(hints.length, 2);
  second.url = 'wss://redirect.invalid';
  second.dispatchEvent(new Event('open'));
  assert.deepEqual(second.sent, [], 'Redirected socket must never receive credentials');
  assert.deepEqual(states.at(-1), ['fallback', 'EXCHANGE_WATCH_NETWORK']);
  const third = await until(() => sockets[2]);
  third.dispatchEvent(new Event('open'));
  third.receive({
    type: 'subscriptions',
    channels: [{ name: 'heartbeat', product_ids: [product] }],
  });
  assert.deepEqual(states.at(-1), ['fallback', 'EXCHANGE_WATCH_SUBSCRIPTION']);
  feed.dispose();
  assert.equal(unsubscribed, true);
});

test('watching uses REST for amounts, catches stale reads, and restores only the selected account', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-order-watch-'));
  const stored = new Map([
    ['sandbox', account],
    ['live', { ...account, profileId: '22222222-2222-3333-4444-555555555555' }],
  ]);
  const notifications = [],
    feeds = [],
    calls = [];
  const workspaceId = 'project';
  const row = {
    clientId,
    workspaceId,
    product,
    env: 'sandbox',
    profileId,
    price: '2000',
    size: '0.1',
    side: 'buy',
    postOnly: true,
    status: 'submit-unknown',
    operationId: 'fixture-order',
    createdAt: Date.now(),
  };
  let response = {
    id: venueId,
    client_oid: clientId,
    profile_id: profileId,
    product_id: product,
    side: 'buy',
    type: 'limit',
    price: row.price,
    size: row.size,
    post_only: true,
    status: 'open',
    filled_size: '0',
    executed_value: '0',
    fill_fees: '0',
    settled: false,
  };
  let staleGate;
  let exchange;
  const make = () =>
    new ExchangeOrders(
      {
        directory,
        workspace: () => ({ id: workspaceId, market: { product, venue: 'coinbase' } }),
        publish: (event) => notifications.push(event),
      },
      (file, data) => fs.writeFileSync(file, JSON.stringify(data)),
      {
        vault: (env) => ({
          load: async () => stored.get(env),
          save: async (value) => stored.set(env, value),
        }),
        api: {
          lookup: async (env, auth, order) => {
            calls.push([env, auth.profileId, order.clientId]);
            const value = { ...response };
            const held = staleGate;
            staleGate = null;
            if (held) {
              held.entered.resolve();
              await held.release.promise;
            }
            return value;
          },
        },
        watch: {
          minimumMs: 10,
          pollMs: 5000,
          fallbackMs: 120,
          feedFactory: (options) => {
            const feed = {
              ...options,
              setProducts: (selected) => {
                feed.products = selected;
              },
              dispose: () => {
                feed.disposed = true;
              },
            };
            feeds.push(feed);
            return feed;
          },
        },
      },
    );
  const invoke = (action, extra = {}, context) =>
    exchange.request(action, { id: workspaceId, env: 'sandbox', ...extra }, context);
  const saved = () => exchange.orders.find((entry) => entry.clientId === clientId);
  t.after(() => {
    exchange?.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  exchange = make();
  exchange.record(row);
  exchange.record({
    ...row,
    env: 'live',
    clientId: '30000000-2222-3333-4444-555555555555',
    profileId: stored.get('live').profileId,
  });
  await assert.rejects(
    invoke('watch', { enabled: true }, { agentContext: { workspaceId } }),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  assert.equal((await invoke('list')).watch.enabled, false);
  assert.equal((await invoke('watch', { enabled: true })).enabled, true);
  const feed = feeds[0];
  feed.onStatus('live');
  await until(() => exchange.watch.status('sandbox').lastVerifiedAt);
  assert.deepEqual(feed.products, [product]);
  assert.equal(saved().venueId, venueId);
  assert.equal(saved().status, 'open');
  assert.equal(calls.length, 1);
  response = { ...response, filled_size: '0.025', executed_value: '50', fill_fees: '0.2' };
  for (let i = 0; i < 8; i++) feed.onHint(product, [venueId], null);
  await until(() => saved().status === 'partially-filled');
  assert.equal(calls.length, 2);
  assert.equal(saved().filledSize, '0.025');
  assert.equal(saved().fillFees, '0.2');

  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  staleGate = { entered, release };
  feed.onHint(product, [venueId], null);
  await Promise.race([entered.promise, delay(1500).then(() => assert.fail('No background read'))]);
  response = { ...response, filled_size: '0.05', executed_value: '100', fill_fees: '0.4' };
  await invoke('reconcile', { orderId: clientId });
  release.resolve();
  await until(() => !exchange.watch.monitors.get('sandbox').reading);
  assert.equal(
    saved().filledSize,
    '0.05',
    'An older background read cannot overwrite manual state',
  );
  exchange.dispose();
  assert.equal(feed.disposed, true);

  exchange = make();
  const resumed = await until(() => feeds[1]);
  resumed.onStatus('fallback', 'EXCHANGE_WATCH_NETWORK');
  await until(() => exchange.watch.status('sandbox').lastVerifiedAt);
  response = {
    ...response,
    filled_size: '0.1',
    executed_value: '200',
    fill_fees: '0.8',
    status: 'done',
    done_reason: 'filled',
    settled: true,
  };
  await until(() => saved().status === 'filled');
  assert.equal(saved().settled, true);
  assert.ok(
    calls.every(
      ([env, scope, client]) => env === 'sandbox' && scope === profileId && client === clientId,
    ),
  );
  assert.deepEqual(resumed.products, []);
  assert.ok(notifications.every((event) => Object.keys(event).sort().join(',') === 'env,type'));
  await exchange.saveAccount('sandbox', {
    ...account,
    credentialId: '66666666-2222-3333-4444-555555555555',
  });
  assert.equal(resumed.disposed, true);
  assert.equal((await invoke('list')).watch.enabled, false);
  assert.equal(feeds.length, 2);
});
