/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { QuantService } = require('../../src/main/services/quant');
const binary =
  process.env.CIBYP_QUANT_TEST_BINARY ||
  require('../../src/main/services/quant/native-binary').developmentBinary(
    path.resolve(__dirname, '../..'),
  );
test('account emergency stops shared deployments, preserves another account, survives restart and requires a current human reset', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-safety-')),
    events = [];
  let service;
  const construct = () =>
    new QuantService({
      directory,
      nativeOptions: { binaryPath: binary },
      publish: (e) => events.push(e),
    });
  const stop = async () => {
    if (!service) return;
    await service.native.stop();
    while (service.native.child) await new Promise((r) => setTimeout(r, 10));
    service.dispose();
  };
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-native-safety-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  service = construct();
  const call = (action, input = {}) => service.request(action, input);
  const a = await call('workspace.create', {}),
    b = await call('workspace.create', {}),
    c = await call('workspace.create', {});
  await call('native.start');
  const instrument = 'coinbase:ETH-USD:safety';
  await service.native.call('instrument.register', {
    id: instrument,
    base: 'ETH',
    quote: 'USD',
    tick: '1',
    lot: '0.1',
    min_notional: '1',
    fee_bps: 10,
  });
  const source = () => {
    service.nativeMarkets.inspect = () => ({
      sources: [{ product: 'ETH-USD', instrument, phase: 'ready' }],
    });
  };
  source();
  let epoch = 0;
  const snapshot = () =>
    service.native.feed('market.snapshot', {
      instrument,
      epoch: 'fresh' + ++epoch,
      sequence: '1',
      bids: [['99', '10']],
      asks: [['101', '10']],
    });
  const accountInput = {
    operationId: 'account',
    name: 'Safety fixture',
    assets: { USD: '10000', ETH: '3' },
    maxOrderNotional: { USD: '1000' },
    maxAssetPosition: { ETH: '10' },
  };
  const account = await call('native.paper.create', { ...accountInput, id: a.id });
  await call('native.paper.bind', { id: b.id, accountId: account.id });
  await call('native.paper.create', { ...accountInput, id: c.id });
  for (const id of [a.id, c.id]) await call('native.paper.enable', { id });
  await snapshot();
  const submit = (id, operationId) =>
    call('native.paper.submit', {
      id,
      operationId,
      product: 'ETH-USD',
      side: 'buy',
      price: '100',
      quantity: '0.1',
    });
  const first = await submit(a.id, 'first'),
    shared = await submit(b.id, 'second'),
    other = await submit(c.id, 'other');
  const definitions = [];
  for (const id of [a.id, b.id]) {
    const definition = await call('native.strategy.define', {
      id,
      operationId: 'maker',
      name: 'Bounded maker',
      product: 'ETH-USD',
      config: { quantity: '0.1', refreshMs: 100, ttlMs: 1000, maxNotional: '1000', maxFees: '5' },
    });
    definitions.push({ id, strategyId: definition.definition.id });
  }
  const runs = [];
  for (const [index, d] of definitions.entries())
    runs.push(
      await call('native.strategy.start', {
        ...d,
        operationId: 'run',
        mode: index ? 'shadow' : 'paper',
      }),
    );
  const halted = await call('native.paper.halt', {
    id: a.id,
    accountId: account.id,
    operationId: 'halt-one',
  });
  assert.ok(halted.halt.id);
  assert.equal(halted.openOrders, 0);
  assert.equal(halted.assets.USD.reserved, '0');
  for (const order of [first.order, shared.order])
    assert.equal(
      (await service.native.call('order.get', { id: order.request.id })).status,
      'cancelled',
    );
  assert.equal(
    (await service.native.call('order.get', { id: other.order.request.id })).status,
    'open',
  );
  assert.equal(
    (await service.native.call('order.get', { id: other.order.request.id })).execution.attached,
    true,
  );
  await new Promise((r) => setTimeout(r, 150));
  for (const [i, d] of definitions.entries()) {
    const history = await call('native.strategy.runs', { ...d });
    assert.equal(history.items[0].run.phase, 'stopped');
    assert.equal(history.items[0].run.reason, 'ACCOUNT_HALTED');
    await snapshot();
    await assert.rejects(
      call('native.strategy.start', { ...d, operationId: 'new-run', mode: i ? 'shadow' : 'paper' }),
      /ACCOUNT_HALTED/,
    );
  }
  assert.ok(events.some((e) => e.type === 'quant-native-strategies-changed' && e.id === b.id));
  await assert.rejects(call('native.paper.enable', { id: b.id }), /ACCOUNT_HALTED/);
  await assert.rejects(
    call('native.paper.reset-halt', {
      id: a.id,
      accountId: account.id,
      expectedHalt: halted.halt.id,
    }),
    /HALT_CONFIRMATION_REQUIRED/,
  );
  await stop();
  service = construct();
  await call('native.start');
  source();
  assert.equal((await call('native.paper.status', { id: b.id })).account.halt.id, halted.halt.id);
  const newer = await call('native.paper.halt', { id: b.id, operationId: 'halt-two' });
  await assert.rejects(
    call('native.paper.reset-halt', {
      id: a.id,
      accountId: account.id,
      expectedHalt: halted.halt.id,
      confirmed: true,
    }),
    /HALT_CHANGED/,
  );
  const reset = await call('native.paper.reset-halt', {
    id: b.id,
    accountId: account.id,
    expectedHalt: newer.halt.id,
    confirmed: true,
  });
  assert.equal(reset.halt, null);
  assert.equal(reset.active, false);
  await call('native.paper.enable', { id: a.id });
  await snapshot();
  const after = await submit(a.id, 'after');
  await call('native.paper.halt', { id: a.id, operationId: 'halt-one' });
  const preserved = await service.native.call('order.get', { id: after.order.request.id });
  assert.equal(preserved.status, 'open');
  assert.equal(preserved.execution.attached, true);
  await assert.rejects(
    call('native.paper.reset-halt', {
      id: a.id,
      accountId: 'foreign',
      expectedHalt: newer.halt.id,
      confirmed: true,
    }),
    /ACCOUNT_SCOPE_CHANGED/,
  );
  await snapshot();
  const realCall = service.native.call.bind(service.native);
  let release;
  service.native.call = (method, args) =>
    method === 'order.submit'
      ? new Promise((resolve, reject) => {
          release = () => realCall(method, args).then(resolve, reject);
        })
      : realCall(method, args);
  const waiting = submit(a.id, 'delayed-normal-request').then(
    () => null,
    (error) => error,
  );
  const deadline = Date.now() + 2000;
  while (!release && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(release);
  let timeout;
  try {
    const stopped = await Promise.race([
      call('native.paper.halt', { id: a.id, operationId: 'priority-stop' }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error('Emergency was queued behind normal work')), 1500);
      }),
    ]);
    assert.ok(stopped.halt);
  } finally {
    clearTimeout(timeout);
    release();
    service.native.call = realCall;
  }
  assert.match((await waiting).message, /ACCOUNT_HALTED/);
});
