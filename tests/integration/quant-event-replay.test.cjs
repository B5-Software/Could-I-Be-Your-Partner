/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { QuantService } = require('../../src/main/services/quant');
const { write, digest } = require('../../src/main/services/quant/event-files');
const { createHash } = require('node:crypto');
const binary =
  process.env.CIBYP_QUANT_TEST_BINARY ||
  require('../../src/main/services/quant/native-binary').developmentBinary(
    path.resolve(__dirname, '../..'),
  );
const instrument = {
  id: 'coinbase:ETH-USD:replay',
  base: 'ETH',
  quote: 'USD',
  tick: '1',
  lot: '0.1',
  min_notional: '1',
  fee_bps: 10,
};
const base = 1700000000000000000n;
const snapshot = {
  instrument: instrument.id,
  epoch: 'fixed',
  sequence: '1',
  bids: [['99', '1']],
  asks: [['101', '1']],
  source_time_ns: base.toString(),
};
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-event-replay-'));
  let host, service;
  if (process.argv.includes('--bundled')) {
    host = await require('../../dist/node-core/core.cjs').createNodeRuntime({
      dataDir: directory,
      workspaceRoot: path.join(directory, 'workspaces'),
      settings: {
        features: { quant: true },
        onboardingCompleted: true,
        language: 'en',
        runtime: { location: 'host' },
        automaticMemory: { enabled: false },
        decision: { enabled: false },
      },
    });
    await host.dispatch({ method: 'quant:request', args: ['capabilities'] });
    service = host.runtime.quantService;
  } else service = new QuantService({ directory, nativeOptions: { binaryPath: binary } });
  t.after(async () => {
    service.dispose();
    await Promise.all([...service.replays.jobs.values()].map((j) => j.done));
    const end = Date.now() + 6000;
    while (service.native.child && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    if (host) await host.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-event-replay-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const a = await service.request('workspace.create', {}),
    b = await service.request('workspace.create', {});
  await service.request('native.start');
  await service.native.call('instrument.register', instrument);
  service.nativeMarkets.inspect = () => ({
    sources: [{ product: 'ETH-USD', instrument: instrument.id, phase: 'ready' }],
  });
  await service.request('native.paper.create', {
    id: a.id,
    operationId: 'account',
    name: 'Live-isolated paper',
    assets: { USD: '10000', ETH: '3' },
    maxOrderNotional: { USD: '1000' },
    maxAssetPosition: { ETH: '10' },
  });
  const version = await service.request('native.strategy.define', {
    id: a.id,
    operationId: 'maker',
    name: 'Pinned maker',
    product: 'ETH-USD',
    config: { quantity: '0.5', refreshMs: 100, ttlMs: 15000 },
  });
  const second = await service.request('native.strategy.define', {
    id: a.id,
    strategyId: version.definition.id,
    revision: 2,
    name: 'Pinned maker',
    product: 'ETH-USD',
    config: { quantity: '0.5', refreshMs: 100, ttlMs: 15000 },
  });
  return { service, id: a.id, other: b.id, version: second };
}
function tape(service, id, validation = false) {
  const rangeEvents = [[0, 'market.snapshot', snapshot]];
  if (validation) {
    let bookSequence = 1,
      tradeSequence = 0;
    for (const time of [100, 550, 600, 750, 900, 1250, 1400, 1500, 1600, 2000, 2100, 2190, 2200]) {
      if ([600, 1400, 1500, 2100, 2200].includes(time)) {
        rangeEvents.push([
          time,
          'market.trade',
          {
            instrument: instrument.id,
            epoch: 'fixed',
            sequence: String(++tradeSequence),
            event_id: 'trade-' + time,
            venue: 'fixture',
            maker_side: 'bid',
            price: '99',
            quantity: '2',
          },
        ]);
      } else
        rangeEvents.push([
          time,
          'market.delta',
          {
            instrument: instrument.id,
            epoch: 'fixed',
            sequence: String(++bookSequence),
            updates: [],
          },
        ]);
    }
  }
  const events = (
    validation
      ? rangeEvents
      : [
          [0, 'market.snapshot', snapshot],
          [
            100,
            'market.delta',
            { instrument: instrument.id, epoch: 'fixed', sequence: '2', updates: [] },
          ],
          [
            400,
            'market.trade',
            {
              instrument: instrument.id,
              epoch: 'fixed',
              sequence: '1',
              event_id: 'early',
              venue: 'fixture',
              maker_side: 'bid',
              price: '99',
              quantity: '2',
            },
          ],
          [
            550,
            'market.delta',
            { instrument: instrument.id, epoch: 'fixed', sequence: '3', updates: [] },
          ],
          [
            600,
            'market.trade',
            {
              instrument: instrument.id,
              epoch: 'fixed',
              sequence: '2',
              event_id: 'fill',
              venue: 'fixture',
              maker_side: 'bid',
              price: '99',
              quantity: '1.2',
            },
          ],
          [
            700,
            'market.delta',
            { instrument: instrument.id, epoch: 'fixed', sequence: '4', updates: [] },
          ],
          [
            1800,
            'market.delta',
            { instrument: instrument.id, epoch: 'fixed', sequence: '5', updates: [] },
          ],
        ]
  ).map(([ms, method, params], sequence) => ({
    sequence,
    wall_ns: (base + BigInt(ms) * 1000000n).toString(),
    mono_ns: (BigInt(ms) * 1000000n).toString(),
    method,
    params: {
      ...params,
      ...(method === 'market.trade'
        ? { time_ns: (base + BigInt(ms) * 1000000n).toString() }
        : { source_time_ns: (base + BigInt(ms) * 1000000n).toString() }),
    },
  }));
  const recordingId = digest(['fixture', id, validation]),
    folder = service.recordings.folder(recordingId);
  fs.mkdirSync(folder, { recursive: true });
  const bytes = Buffer.from(events.map((r) => JSON.stringify(r) + '\n').join(''));
  fs.writeFileSync(path.join(folder, 'events.jsonl'), bytes);
  const manifest = {
    version: 1,
    recordingId,
    owner: id,
    name: 'Historical fixture',
    product: 'ETH-USD',
    instrument,
    status: 'complete',
    events: events.length,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: 0,
    ...(validation && { endedMonoNs: '2300000000', endedWallNs: (base + 2300000000n).toString() }),
  };
  manifest.manifestHash = digest(manifest);
  service.recordings.persist(manifest);
  return recordingId;
}
async function completed(service, input) {
  const value = await service.request('replay.start', input);
  const result = await service.request('replay.get', {
    id: input.id,
    replayId: value.replayId,
    waitMs: 30000,
  });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  return result;
}
test('historical event replay uses virtual time, the actual native ledger, pinned revision lineage and identical journals across independent runs', async (t) => {
  const { service, id, other, version } = await fixture(t);
  const recordingId = tape(service, id);
  const before = await service.request('native.paper.status', { id });
  const input = {
    id,
    recordingId,
    strategyId: version.definition.id,
    revision: 2,
    assets: { USD: '10000', ETH: '3' },
  };
  const first = await completed(service, { ...input, operationId: 'one' });
  assert.equal(first.result.run.run.revision, 2);
  assert.equal(first.result.run.phase, 'paused');
  assert.equal(first.result.run.reason, 'FRESH_BOOK_REQUIRED');
  assert.equal(first.result.counts.orders, 2);
  assert.equal(first.result.counts.executions, 1);
  assert.equal(first.result.run.stats.fees, '0.0198');
  assert.equal(first.result.tradeContribution, '0.1802');
  assert.equal(first.result.finalAccount.assets.ETH.total, '3.2');
  assert.equal(first.eventErrors, 0);
  const second = await completed(service, { ...input, operationId: 'two' });
  assert.equal(second.result.journalSha256, first.result.journalSha256);
  assert.deepEqual(second.result.finalAccount, first.result.finalAccount);
  assert.equal(
    (await service.request('replay.start', { ...input, operationId: 'one' })).replayId,
    first.replayId,
  );
  assert.deepEqual((await service.request('native.paper.status', { id })).account, before.account);
  assert.equal((await service.request('native.paper.orders', { id })).total, 0);
  await assert.rejects(
    service.request('replay.get', { id: other, replayId: first.replayId }),
    /SCOPE/,
  );
  const history = await service.request('replay.history', {
    id,
    replayId: first.replayId,
    kind: 'executions',
    limit: 1,
  });
  assert.equal(history.items.length, 1);
  fs.appendFileSync(path.join(service.replays.folder(first.replayId), 'executions.jsonl'), '{}\n');
  await assert.rejects(
    service.request('replay.history', { id, replayId: first.replayId, kind: 'executions' }),
    /HASH_MISMATCH/,
  );
  await assert.rejects(
    service.native.replayStep({ wall_ns: '0', mono_ns: '0' }),
    /REPLAY_CLOCK_REQUIRED/,
  );
  await assert.rejects(
    service.request('replay.start', { ...input, operationId: 'one', revision: 1 }),
    /CONFLICT/,
  );
  fs.appendFileSync(path.join(service.recordings.folder(recordingId), 'events.jsonl'), '{}\n');
  await assert.rejects(service.request('replay.start', { ...input, operationId: 'tampered' }));
});
test('rolling native validation selects on earlier events and verifies per-window order evidence', async (t) => {
  const { service, id, other, version } = await fixture(t);
  await service.request('native.strategy.define', {
    id,
    strategyId: version.definition.id,
    revision: 3,
    name: 'Smaller maker',
    product: 'ETH-USD',
    config: { quantity: '0.1', refreshMs: 100, ttlMs: 15000 },
  });
  const input = {
    id,
    operationId: 'validation',
    recordingId: tape(service, id, true),
    strategyId: version.definition.id,
    revisions: [3, 1],
    trainMs: 800,
    testMs: 700,
    folds: 2,
    assets: { USD: '10000', ETH: '3' },
  };
  const before = await service.request('native.paper.status', { id });
  await assert.rejects(service.request('replay.validate', { ...input, folds: 3 }), /COVERAGE/);
  const started = await service.request('replay.validate', input);
  const ref = { id, replayId: started.replayId };
  const result = await service.request('replay.get', { ...ref, waitMs: 30000 });
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.validationProgress.completed, 6);
  assert.equal(result.validationProgress.total, 6);
  assert.equal(result.configuration.engineSha256.length, 64);
  const [one, two] = result.validation.folds;
  assert.deepEqual(one.test, { startMs: 800, endMs: 1500 });
  assert.deepEqual(two.training, { startMs: 700, endMs: 1500 });
  assert.deepEqual(two.test, { startMs: 1500, endMs: 2200 });
  for (const fold of [one, two]) {
    assert.equal(fold.result.revision, 1);
    assert.equal(fold.result.finalAssets.ETH, '3.5');
    assert.deepEqual(
      fold.ranking.map((candidate) => candidate.revision),
      [1, 3],
    );
    assert.ok(
      Number(fold.ranking[0].tradeContribution) > Number(fold.ranking[1].tradeContribution),
    );
    assert.equal(fold.result.counts.executions, 1);
  }
  for (const [fold, trainingRevision, time] of [
    [1, 1, 600],
    [1, undefined, 1400],
    [2, 1, 1400],
    [2, undefined, 2100],
  ]) {
    const page = await service.request('replay.history', {
      ...ref,
      kind: 'executions',
      fold,
      trainingRevision,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].fill.source.event_id, 'trade-' + time);
  }
  await assert.rejects(service.request('replay.get', { ...ref, id: other }), /SCOPE/);
  assert.equal(
    (await service.request('replay.validate', { ...input, revisions: [1, 3] })).replayId,
    started.replayId,
  );
  await assert.rejects(service.request('replay.validate', { ...input, testMs: 600 }), /CONFLICT/);
  assert.deepEqual((await service.request('native.paper.status', { id })).account, before.account);
  const manifestFile = path.join(service.replays.folder(started.replayId), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.validationHash, digest(manifest.validation));
  manifest.validation.folds[0].result.tradeContribution = '99';
  write(manifestFile, manifest);
  await assert.rejects(service.request('replay.get', ref), /VALIDATION_HASH_MISMATCH/);
});
test('recording captures a coherent seed and emitted public events, flushes and verifies a complete immutable tape', async (t) => {
  const { service, id } = await fixture(t);
  const seed = { ...snapshot, source_time_ns: (BigInt(Date.now()) * 1000000n).toString() };
  service.nativeMarkets.sources.set('ETH-USD', {
    instrument,
    source: {
      desired: true,
      captureSnapshot: (fn) => Promise.resolve(fn(seed)),
      stop: async () => {},
    },
  });
  const started = await service.request('recording.start', {
    id,
    operationId: 'capture',
    product: 'ETH-USD',
    name: 'Public only',
  });
  await service.native.feed('market.snapshot', seed);
  await service.native.feed('market.invalidate', { id: instrument.id });
  const finished = await service.request('recording.stop', {
    id,
    recordingId: started.recordingId,
  });
  assert.equal(finished.status, 'complete');
  assert.equal(finished.events, 3);
  assert.equal((await service.recordings.verify(finished.recordingId, id)).sha256, finished.sha256);
  const again = await service.request('recording.start', {
    id,
    operationId: 'capture',
    product: 'ETH-USD',
  });
  assert.equal(again.status, 'complete');
  assert.equal(service.recordings.active.size, 0);
  assert.equal((await service.request('native.paper.orders', { id })).total, 0);
});
test('cancelling replay closes only its isolated process and interrupted recordings do not resume', async (t) => {
  const { service, id, version } = await fixture(t);
  const recordingId = tape(service, id),
    input = {
      id,
      recordingId,
      strategyId: version.definition.id,
      revision: 2,
      operationId: 'cancel',
    };
  const job = await service.request('replay.start', input),
    handle = service.replays.jobs.get(job.replayId);
  const controller = new AbortController();
  controller.abort();
  const waiting = await service.request('replay.get', {
    id,
    replayId: job.replayId,
    waitMs: 30000,
    signal: controller.signal,
  });
  assert.equal(waiting.status, 'running');
  assert.equal(
    handle.cancelled,
    false,
    'aborting a model wait does not cancel an independent experiment',
  );
  await service.request('replay.cancel', { id, replayId: job.replayId });
  await handle.done;
  assert.equal(
    (await service.request('replay.get', { id, replayId: job.replayId })).status,
    'cancelled',
  );
  assert.equal(handle.engine?.child ?? null, null);
  assert.equal(service.native.state, 'connected');
  assert.equal((await service.request('native.paper.orders', { id })).total, 0);
  await assert.rejects(
    service.native.request('replay.step', { wall_ns: '0', mono_ns: '0' }),
    /REPLAY_CLOCK_REQUIRED/,
  );
  const { EventRecordings } = require('../../src/main/services/quant/event-recordings');
  const broken = {
    ...service.recordings.get(recordingId, id),
    recordingId: digest('interrupted'),
    status: 'recording',
  };
  service.recordings.persist(broken);
  const recovered = new EventRecordings(service);
  assert.equal(recovered.get(broken.recordingId, id).status, 'interrupted');
  await assert.rejects(recovered.verify(broken.recordingId, id), /NOT_COMPLETE/);
});
test('recording reports an actual file collision and metadata corruption without submitting orders', async (t) => {
  const { service, id } = await fixture(t);
  const { identity } = require('../../src/main/services/quant/event-files');
  service.nativeMarkets.sources.set('ETH-USD', {
    instrument,
    source: {
      desired: true,
      captureSnapshot: (fn) => Promise.resolve(fn(snapshot)),
      stop: async () => {},
    },
  });
  const target = service.recordings.folder(identity(id, 'collision'));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'events.jsonl'), 'existing');
  const started = await service.request('recording.start', {
    id,
    operationId: 'collision',
    product: 'ETH-USD',
  });
  const end = Date.now() + 1000;
  while (service.recordings.get(started.recordingId, id).status === 'recording' && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.recordings.get(started.recordingId, id).status, 'failed');
  const recordingId = tape(service, id),
    metadata = service.recordings.get(recordingId, id);
  service.recordings.persist({ ...metadata, instrument: { ...instrument, fee_bps: 999 } });
  await assert.rejects(service.recordings.verify(recordingId, id), /MANIFEST_HASH/);
  assert.equal((await service.request('native.paper.orders', { id })).total, 0);
});
