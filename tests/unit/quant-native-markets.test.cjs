/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { NativeMarkets } = require('../../src/main/services/quant/native-markets');
const { SubscriptionPacer } = require('../../src/main/services/quant/subscription-pacer');
test('products share a subscription budget and cancelled callbacks do not transmit', async () => {
  let now = 0;
  const sent = [],
    pacer = new SubscriptionPacer({
      now: () => now,
      wait: async (delay) => {
        now += delay;
      },
    });
  await Promise.all(
    Array.from({ length: 9 }, () =>
      pacer.run(() => {
        sent.push(now);
        return true;
      }),
    ),
  );
  assert.deepEqual(
    sent,
    Array.from({ length: 9 }, (_, i) => i * 250),
  );
  const last = pacer.last;
  await pacer.run(() => false);
  assert.equal(pacer.last, last);
  assert.equal(pacer.pending, 0);
});
const metadata = {
  product_id: 'ETH-USD',
  product_type: 'SPOT',
  base_currency_id: 'ETH',
  quote_currency_id: 'USD',
  price_increment: '0.01',
  base_increment: '0.00000001',
  base_min_size: '0.00000001',
  quote_min_size: '1',
};
function fixture(t, publicProduct = async () => metadata) {
  const calls = [];
  const engine = {
    state: 'connected',
    call: async (method, params) => {
      calls.push({ method, params });
      return { feed: { version: 1, boundedDepth: true, sourceClock: true } };
    },
    feed: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
  };
  class Socket extends EventTarget {
    send() {}
    close() {
      this.dispatchEvent(new Event('close'));
    }
  }
  const manager = new NativeMarkets({
    engine,
    market: { publicProduct },
    sourceOptions: {
      calibrate: undefined,
      createDispatcher: async () => ({ async destroy() {} }),
      socketFactory: () => new Socket(),
      onPolicyChange: () => () => {},
    },
  });
  t.after(() => manager.stopAll());
  return { manager, engine, calls };
}
test('all callers share one source per product; metadata and assumed fee are explicit and do not create accounts or start trading', async (t) => {
  let requests = 0;
  const { manager, calls } = fixture(t, async () => {
    requests++;
    return metadata;
  });
  const [a, b] = await Promise.all([
    manager.start({ product: 'ETH-USD' }),
    manager.start({ product: 'ETH-USD' }),
  ]);
  assert.equal(requests, 1);
  assert.equal(a.instrument, b.instrument);
  assert.equal(manager.inspect().sources.length, 1);
  assert.equal(a.assumptions.feeKind, 'assumed-maker');
  assert.equal(a.assumptions.feeBps, 10);
  assert.equal(a.assumptions.baseAmm, false);
  assert.ok(
    calls.every((c) => ['status', 'instrument.register', 'market.invalidate'].includes(c.method)),
  );
  await assert.rejects(manager.start({ product: 'ETH-USD', feeBps: 20 }), /STOP_BEFORE_FEE_CHANGE/);
});
test('stop during metadata discovery prevents stale startup from creating a source or instrument', async (t) => {
  let resolve;
  const { manager, calls } = fixture(
    t,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = manager.start({ product: 'ETH-USD' });
  await manager.stop('ETH-USD');
  resolve(metadata);
  await pending;
  assert.equal(manager.inspect().sources.length, 0);
  assert.equal(calls.length, 0);
});
test('wrong product metadata fails without registration; a native exit stops every source', async (t) => {
  const bad = fixture(t, async () => ({ ...metadata, product_id: 'BTC-USD' }));
  await assert.rejects(bad.manager.start({ product: 'ETH-USD' }), /SOURCE_PRODUCT_MISMATCH/);
  assert.equal(bad.calls.length, 0);
  const good = fixture(t);
  await good.manager.start({ product: 'ETH-USD' });
  good.engine.state = 'failed';
  good.manager.nativeChanged({ type: 'quant-native-changed', native: { state: 'failed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(good.manager.inspect().sources[0].desired, false);
  assert.equal(good.manager.inspect().sources[0].phase, 'stopped');
  assert.equal((await good.manager.book('ETH-USD')).eligible, false);
  assert.deepEqual((await good.manager.book('ETH-USD')).bids, []);
});
