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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('native strategies run without chat, pause on an idle stale feed, isolate projects, pin versions and recover without resuming', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-strategy-process-')),
    events = [];
  let service = new QuantService({
    directory: folder,
    nativeOptions: { binaryPath: binary },
    publish: (event) => events.push(event),
  });
  const call = (action, input = {}) => service.request(action, input);
  const until = async (check) => {
    const end = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() > end) throw Error('Strategy condition timed out');
      await sleep(20);
    }
  };
  const stop = async () => {
    await service.native.stop();
    await until(() => !service.native.child);
    service.dispose();
  };
  const instrument = {
    id: 'coinbase:ETH-USD:fixture',
    base: 'ETH',
    quote: 'USD',
    tick: '1',
    lot: '0.1',
    min_notional: '1',
    fee_bps: 10,
  };
  let epoch = 0;
  const snapshot = () =>
    service.native.feed('market.snapshot', {
      instrument: instrument.id,
      epoch: 'epoch-' + ++epoch,
      sequence: '1',
      bids: [['99', '1']],
      asks: [['101', '1']],
    });
  const source = () => {
    service.nativeMarkets.inspect = () => ({
      sources: [{ product: 'ETH-USD', phase: 'ready', instrument: instrument.id }],
    });
  };
  try {
    const a = await call('workspace.create', { name: 'A', venue: 'coinbase' }),
      b = await call('workspace.create', { name: 'B', venue: 'coinbase' });
    await call('native.start');
    await service.native.call('instrument.register', instrument);
    await snapshot();
    source();
    await call('native.paper.create', {
      id: a.id,
      operationId: 'account',
      name: 'Paper',
      assets: { USD: '10000', ETH: '3' },
      maxOrderNotional: { USD: '1000' },
      maxAssetPosition: { ETH: '10' },
    });
    await call('native.paper.enable', { id: a.id });
    const input = {
      id: a.id,
      operationId: 'maker',
      name: 'Bounded maker',
      product: 'ETH-USD',
      config: { quantity: '0.5', refreshMs: 100, ttlMs: 1000, maxNotional: '1000', maxFees: '5' },
    };
    const definition = (await call('native.strategy.define', input)).definition;
    const start = {
      id: a.id,
      strategyId: definition.id,
      operationId: 'first',
      revision: 1,
      mode: 'paper',
    };
    const first = await call('native.strategy.start', start);
    await until(async () => (await call('native.paper.orders', { id: a.id })).total === 2);
    assert.equal((await call('native.strategy.start', start)).run.id, first.run.id);
    await call('native.strategy.define', {
      ...input,
      strategyId: definition.id,
      revision: 2,
      config: { ...input.config, quantity: '0.2' },
    });
    assert.equal(
      (await call('native.strategy.runs', { id: a.id, runId: first.run.id })).items[0].run.revision,
      1,
    );
    assert.equal((await call('native.strategy.list', { id: a.id })).total, 1);
    assert.equal(
      (await call('native.strategy.versions', { id: a.id, strategyId: definition.id })).total,
      2,
    );
    await assert.rejects(
      call('native.strategy.get', { id: b.id, strategyId: definition.id }),
      /STRATEGY_SCOPE_MISMATCH/,
    );
    await sleep(1200); // No frames or queries: the native timer must enforce staleness.
    const paused = (await call('native.strategy.runs', { id: a.id, runId: first.run.id })).items[0];
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.reason, 'FRESH_BOOK_REQUIRED');
    assert.equal(
      (await call('native.paper.orders', { id: a.id })).items.filter((o) => o.execution.held)
        .length,
      2,
    );
    assert.ok(events.some((e) => e.type === 'quant-native-strategies-changed'));
    await snapshot();
    await assert.rejects(
      call('native.strategy.start', { ...start, operationId: 'second', revision: 2 }),
      /STRATEGY_HAS_OPEN_ORDERS/,
    );
    await call('native.strategy.stop', { id: a.id, runId: first.run.id });
    await call('native.paper.pause', { id: a.id });
    const shadow = await call('native.strategy.start', {
      ...start,
      operationId: 'shadow',
      revision: 2,
      mode: 'shadow',
    });
    await until(
      async () =>
        (await call('native.strategy.decisions', { id: a.id, runId: shadow.run.id })).total > 0,
    );
    assert.equal((await call('native.paper.orders', { id: a.id })).total, 2);
    assert.equal(
      (await call('native.strategy.runs', { id: a.id, runId: shadow.run.id })).items[0].stats
        .orders,
      0,
    );
    await assert.rejects(
      call('native.strategy.decisions', { id: b.id, runId: shadow.run.id }),
      /STRATEGY_SCOPE_MISMATCH/,
    );
    await stop();
    service = new QuantService({ directory: folder, nativeOptions: { binaryPath: binary } });
    await call('native.start');
    const recovered = (await call('native.strategy.runs', { id: a.id, runId: shadow.run.id }))
      .items[0];
    assert.equal(recovered.phase, 'paused');
    assert.equal(recovered.run.revision, 2);
    assert.ok(
      (await call('native.strategy.decisions', { id: a.id, runId: shadow.run.id })).total > 0,
    );
    const duplicate = await call('native.strategy.start', {
      ...start,
      operationId: 'shadow',
      revision: 2,
      mode: 'shadow',
    });
    assert.equal(duplicate.phase, 'paused');
    assert.equal(duplicate.duplicate, true);
  } finally {
    await stop();
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('cibyp-strategy-process-'));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
