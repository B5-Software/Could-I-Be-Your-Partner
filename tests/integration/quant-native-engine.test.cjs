/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawn } = require('node:child_process');
const { NativeEngine } = require('../../src/main/services/quant/native-engine');
const { CoinbaseStream } = require('../../src/main/services/quant/coinbase-stream');
const binary =
  process.env.CIBYP_QUANT_TEST_BINARY ||
  require('../../src/main/services/quant/native-binary').developmentBinary(
    path.resolve(__dirname, '../..'),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const instrument = {
  id: 'ETH-USD',
  base: 'ETH',
  quote: 'USD',
  tick: '0.5',
  lot: '0.001',
  min_notional: '1',
  fee_bps: 100,
};
const account = {
  id: 'paper',
  risk: {
    max_open_orders: 10,
    max_order_notional: { USD: '1000' },
    max_asset_position: { ETH: '10' },
  },
  assets: { USD: '1000', ETH: '3' },
};
const snapshot = {
  instrument: 'ETH-USD',
  epoch: 'fixture',
  sequence: '1',
  bids: [['99', '10']],
  asks: [['101', '10']],
};
const order = {
  id: 'one',
  account: 'paper',
  strategy: 'project-a',
  instrument: 'ETH-USD',
  side: 'buy',
  price: '100',
  quantity: '2',
  post_only: true,
};
async function fixture(t) {
  assert.ok(fs.existsSync(binary), 'Build the native release binary first');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-process-'));
  const engines = [];
  const create = (options = {}) => {
    const engine = new NativeEngine({ directory, binaryPath: binary, ...options });
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) {
      try {
        await engine.stop();
      } catch {}
      engine.dispose();
    }
    for (let i = 0; i < 100 && engines.some((e) => e.child); i++) await sleep(20);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-native-process-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const engine = create();
  await engine.start();
  return { directory, engine, create, engines };
}
async function setup(engine) {
  await engine.call('instrument.register', instrument);
  await engine.call('account.create', account);
  await engine.feed('market.snapshot', snapshot);
  await engine.call('enable');
}
test('shared native paper controls persist per-project history, partial executions and unresolved submissions across recovery', async (t) => {
  const { directory, engines } = await fixture(t);
  const { QuantService } = require('../../src/main/services/quant');
  let service = new QuantService({
    directory: path.join(directory, 'shared-service'),
    nativeOptions: { binaryPath: binary },
  });
  engines.push(service.native);
  const call = (action, input = {}) => service.request('native.paper.' + action, input);
  try {
    const a = await service.request('workspace.create', { name: 'A', venue: 'coinbase' }),
      b = await service.request('workspace.create', { name: 'B', venue: 'coinbase' });
    await service.request('native.start');
    const market = { ...instrument, id: 'coinbase:ETH-USD:fixture' };
    await service.native.call('instrument.register', market);
    await service.native.feed('market.snapshot', { ...snapshot, instrument: market.id });
    service.nativeMarkets.inspect = () => ({
      sources: [{ product: 'ETH-USD', instrument: market.id, phase: 'ready' }],
    });
    const creation = {
      id: a.id,
      operationId: 'create-a',
      name: '共享仿真',
      assets: { USD: '1000', ETH: '3' },
      maxOrderNotional: { USD: '1000' },
      maxAssetPosition: { ETH: '10' },
    };
    const accountA = await call('create', creation);
    assert.equal(accountA.active, false);
    await call('bind', { id: b.id, accountId: accountA.id });
    await call('enable', { id: a.id });
    const input = {
      id: a.id,
      operationId: 'buy-one',
      product: 'ETH-USD',
      side: 'buy',
      price: '100',
      quantity: '1',
    };
    const first = await call('submit', input),
      other = await call('submit', { ...input, id: b.id });
    assert.equal((await call('orders', { id: a.id })).total, 1);
    await assert.rejects(
      call('cancel', { id: b.id, orderId: first.order.request.id }),
      /ORDER_SCOPE_MISMATCH/,
    );
    await sleep(550);
    await service.native.feed('market.delta', {
      instrument: market.id,
      epoch: 'fixture',
      sequence: '2',
      updates: [],
    });
    for (let i = 1; i <= 2; i++)
      await service.native.feed('market.trade', {
        instrument: market.id,
        epoch: 'fixture',
        sequence: String(i),
        event_id: String(i),
        venue: 'fixture',
        time_ns: (BigInt(Date.now()) * 1000000n).toString(),
        maker_side: 'bid',
        price: '100',
        quantity: '0.25',
      });
    assert.equal((await call('executions', { id: a.id })).total, 2);
    const view = await call('view', { id: a.id, kind: 'executions', limit: 1 });
    assert.equal(view.historyPage.total, 2);
    assert.equal(view.historyPage.items.length, 1);
    assert.equal(view.historyPage.next, 1);
    assert.equal(view.account.assets.ETH.available, '3.5');
    assert.equal(view.accountsPage.items[0].assets, undefined);
    assert.equal((await call('executions', { id: a.id })).items[0].fees, '0.25');
    assert.equal((await call('executions', { id: b.id })).total, 0);
    assert.equal((await call('create', creation)).assets.ETH.total, '3.5');
    assert.equal((await call('submit', input)).duplicate, true);
    await call('pause', { id: a.id });
    assert.equal(
      (await call('order', { id: b.id, orderId: other.order.request.id })).execution.held,
      true,
    );
    await call('create', { ...creation, id: b.id, operationId: 'create-b', name: 'Independent' });
    assert.equal(
      (await call('orders', { id: b.id })).total,
      1,
      'changing accounts preserves previous project orders',
    );
    await call('cancel', { id: b.id, orderId: other.order.request.id });
    await call('enable', { id: a.id });
    const actual = service.native.call.bind(service.native);
    service.native.call = async (method, params) => {
      const result = await actual(method, params);
      if (method === 'order.submit')
        throw Object.assign(Error('NATIVE_OUTCOME_UNKNOWN'), { code: 'NATIVE_OUTCOME_UNKNOWN' });
      return result;
    };
    await assert.rejects(
      call('submit', { ...input, operationId: 'lost-confirmation' }),
      /NATIVE_OUTCOME_UNKNOWN/,
    );
    service.native.call = actual;
    assert.ok((await call('status', { id: a.id })).pendingOrder);
    await assert.rejects(
      call('submit', { ...input, operationId: 'different-retry' }),
      /NATIVE_RECONCILE_REQUIRED/,
    );
    await service.native.stop();
    for (let i = 0; i < 100 && service.native.child; i++) await sleep(20);
    service.dispose();
    service = new QuantService({
      directory: path.join(directory, 'shared-service'),
      nativeOptions: { binaryPath: binary },
    });
    engines.push(service.native);
    await service.native.start();
    assert.equal((await call('status', { id: a.id })).account.active, false);
    assert.equal((await call('executions', { id: a.id })).total, 2);
    assert.equal((await call('reconcile', { id: a.id })).state, 'found');
    assert.equal((await call('status', { id: a.id })).pendingOrder, null);
    assert.equal((await call('orders', { id: a.id })).total, 2);
    assert.equal((await call('submit', input)).duplicate, true);
    const disk = JSON.parse(
      fs.readFileSync(path.join(directory, 'shared-service/state.json'), 'utf8'),
    );
    assert.equal(disk.workspaces.find((w) => w.id === a.id).nativePaper.accountId, accountA.id);
    await call('enable', { id: a.id });
    await service.native.feed('market.snapshot', {
      ...snapshot,
      instrument: market.id,
      epoch: 'after-recovery',
    });
    service.nativeMarkets.inspect = () => ({
      sources: [{ product: 'ETH-USD', instrument: market.id, phase: 'ready' }],
    });
    const restoredCall = service.native.call.bind(service.native);
    service.native.call = (method, params) =>
      method === 'order.submit'
        ? Promise.reject(Error('NATIVE_OUTCOME_UNKNOWN'))
        : restoredCall(method, params);
    await assert.rejects(
      call('submit', { ...input, operationId: 'not-committed' }),
      /NATIVE_OUTCOME_UNKNOWN/,
    );
    service.native.call = restoredCall;
    assert.equal((await call('reconcile', { id: a.id })).state, 'absent');
    assert.equal(
      (await call('orders', { id: a.id })).total,
      2,
      'absence reconciliation never submits an order',
    );
    await assert.rejects(
      call('submit', { ...input, operationId: 'rejected-crossing', price: '101' }),
      /POST_ONLY_WOULD_CROSS/,
    );
    assert.equal(
      (await call('status', { id: a.id })).pendingOrder,
      null,
      'a healthy definitive rejection clears the controller receipt',
    );
  } finally {
    service.dispose();
  }
});
test('bad clock projection invalidates the source and pause cannot turn old intents back into active queues', async (t) => {
  const { engine } = await fixture(t);
  await setup(engine);
  await engine.call('order.submit', order);
  const now = (BigInt(Date.now()) * 1000000n).toString();
  await assert.rejects(
    engine.feed('market.delta', {
      instrument: instrument.id,
      epoch: 'fixture',
      sequence: '2',
      updates: [],
      source_time_ns: now,
      provider_time_ns: (BigInt(now) - 1000000000n).toString(),
      source_clock: { offset_ns: '0', uncertainty_ns: '1', calibrated_at_ns: now },
    }),
    /SOURCE_CLOCK_INVALID/,
  );
  assert.equal((await engine.call('book', { id: instrument.id })).valid, false);
  assert.equal((await engine.call('order.get', { id: order.id })).execution.held, true);
  await engine.feed('market.snapshot', { ...snapshot, epoch: 'resynced' });
  await engine.call('pause');
  await engine.call('enable');
  await engine.feed('market.trade', {
    instrument: instrument.id,
    epoch: 'resynced',
    sequence: '1',
    event_id: '100',
    venue: 'fixture',
    time_ns: (BigInt(Date.now()) * 1000000n).toString(),
    maker_side: 'bid',
    price: '100',
    quantity: '100',
  });
  assert.equal((await engine.call('order.get', { id: order.id })).filled, '0');
  assert.equal((await engine.call('account.get', { id: account.id })).assets.USD.reserved, '202');
});
test('sequenced source frames drive real native partial fills; duplicates, gaps and fresh reconnects cannot manufacture fills', async (t) => {
  const { engine } = await fixture(t);
  await engine.call('instrument.register', instrument);
  await engine.call('account.create', account);
  let socket;
  class Socket extends EventTarget {
    send() {}
    close() {
      this.dispatchEvent(new Event('close'));
    }
    frame(value) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
  }
  const source = new CoinbaseStream({
    engine,
    product: 'ETH-USD',
    instrument: instrument.id,
    createDispatcher: async () => ({ async destroy() {} }),
    socketFactory: () => (socket = new Socket()),
    onPolicyChange: () => () => {},
  });
  t.after(() => source.stop());
  let sequence = 0,
    counter = 0;
  const send = async (channel, events, extra = {}) => {
    const session = source.session;
    socket.frame({
      channel,
      events,
      timestamp: new Date().toISOString(),
      sequence_num: sequence++,
      ...extra,
    });
    await session.chain;
  };
  const heartbeat = () => send('heartbeats', [{ heartbeat_counter: counter++ }]);
  const initialize = async () => {
    await source.start();
    socket.dispatchEvent(new Event('open'));
    sequence = 0;
    await send('l2_data', [
      {
        type: 'snapshot',
        product_id: 'ETH-USD',
        updates: [
          { side: 'bid', price_level: '99', new_quantity: '10' },
          { side: 'offer', price_level: '101', new_quantity: '10' },
        ],
      },
    ]);
    await send('market_trades', [
      {
        type: 'snapshot',
        trades: [
          {
            product_id: 'ETH-USD',
            trade_id: '9',
            side: 'BUY',
            price: '100',
            size: '1000',
            time: new Date(Date.now() - 60000).toISOString(),
          },
        ],
      },
    ]);
    await heartbeat();
    assert.equal(source.phase, 'ready');
  };
  await initialize();
  await engine.call('enable');
  await engine.call('order.submit', order);
  await sleep(550);
  await heartbeat();
  const trade = {
    product_id: 'ETH-USD',
    trade_id: '10',
    side: 'BUY',
    price: '100',
    size: '0.25',
    time: new Date().toISOString(),
  };
  await send('market_trades', [{ type: 'update', trades: [trade] }]);
  let result = await engine.call('order.get', { id: order.id });
  assert.equal(result.filled, '0.25');
  assert.equal(result.execution.attached, true);
  await send('market_trades', [{ type: 'update', trades: [trade] }]);
  assert.equal((await engine.call('order.get', { id: order.id })).filled, '0.25');
  assert.equal(source.metrics.duplicateTrades, 1);
  await send('subscriptions', [{}], { sequence_num: 999 });
  assert.equal(source.lastError, 'SOURCE_SEQUENCE_GAP');
  result = await engine.call('order.get', { id: order.id });
  assert.equal(result.execution.held, true);
  assert.equal(result.filled, '0.25');
  assert.equal((await engine.call('book', { id: instrument.id })).eligible, false);
  await source.stop();
  await initialize();
  await send('market_trades', [
    {
      type: 'update',
      trades: [{ ...trade, trade_id: '11', size: '100', time: new Date().toISOString() }],
    },
  ]);
  result = await engine.call('order.get', { id: order.id });
  assert.equal(result.filled, '0.25');
  assert.equal(result.execution.held, true);
  const balance = await engine.call('account.get', { id: 'paper' });
  assert.equal(balance.assets.USD.reserved, '176.75');
});
test('actual private native process negotiates PAPER-only capability and reserves durable orders', async (t) => {
  const { engine } = await fixture(t);
  await setup(engine);
  const state = engine.inspect();
  assert.equal(state.state, 'connected');
  assert.equal(state.liveExecution, false);
  assert.equal(state.mode, 'paper');
  assert.ok(!JSON.stringify(state).includes('token'));
  const first = await engine.call('order.submit', order);
  assert.equal(first.duplicate, false);
  assert.equal(first.order.status, 'open');
  const before = await engine.call('account.get', { id: 'paper' });
  assert.equal(before.assets.USD.reserved, '202');
  assert.equal((await engine.call('order.submit', order)).duplicate, true);
  await assert.rejects(
    engine.call('order.submit', { ...order, quantity: '3' }),
    /COMMAND_CONFLICT/,
  );
  assert.deepEqual(await engine.call('account.get', { id: 'paper' }), before);
  await assert.rejects(engine.call('market.snapshot', snapshot), /METHOD_UNAVAILABLE/);
  await assert.rejects(engine.call('order.fill', { id: 'fabricated' }), /METHOD_UNAVAILABLE/);
  await engine.call('order.cancel', { id: 'one' });
  assert.equal((await engine.call('account.get', { id: 'paper' })).assets.USD.reserved, '0');
});
test('restart is paused, preserves reservations, and deduplicates before a new market snapshot', async (t) => {
  const { engine, create } = await fixture(t);
  await setup(engine);
  await engine.call('order.submit', order);
  await engine.stop();
  for (let i = 0; i < 100 && engine.child; i++) await sleep(10);
  const restored = create();
  await restored.start();
  assert.equal((await restored.call('status')).ledger.enabled, false);
  assert.equal((await restored.call('status')).books, 0);
  assert.equal((await restored.call('order.submit', order)).duplicate, true);
  assert.equal((await restored.call('account.get', { id: 'paper' })).assets.USD.reserved, '202');
  await restored.call('order.cancel', { id: 'one' });
  assert.equal((await restored.call('orders', {})).total, 1);
});
test('a lost native acknowledgement is reported unknown and never automatically repeated', async (t) => {
  const { engine, create } = await fixture(t);
  await setup(engine);
  let observed;
  const replyObserved = new Promise((resolve) => {
    observed = resolve;
  });
  const receive = engine.receive.bind(engine);
  engine.receive = (child, bytes) => {
    if (
      engine.pending.size &&
      [...engine.pending.values()].some((e) => e.method === 'order.submit')
    ) {
      observed();
      return;
    }
    receive(child, bytes);
  };
  const submitted = engine.call('order.submit', order);
  await replyObserved;
  engine.fail(engine.child, 'NATIVE_CONNECTION_LOST');
  await assert.rejects(submitted, /NATIVE_OUTCOME_UNKNOWN/);
  assert.equal(engine.state, 'failed');
  const recovered = create();
  await recovered.start();
  assert.equal((await recovered.call('orders', {})).total, 1);
  assert.equal((await recovered.call('order.submit', order)).duplicate, true);
  assert.equal((await recovered.call('account.get', { id: 'paper' })).assets.USD.reserved, '202');
});
test('one native writer owns the journal and a gap prevents new orders', async (t) => {
  const { engine, create } = await fixture(t);
  await setup(engine);
  const other = create();
  await assert.rejects(other.start());
  assert.equal(other.state, 'failed');
  await assert.rejects(
    engine.feed('market.delta', {
      instrument: 'ETH-USD',
      epoch: 'fixture',
      sequence: '3',
      updates: [],
    }),
    /BOOK_SEQUENCE_GAP/,
  );
  await assert.rejects(engine.call('order.submit', order), /FRESH_BOOK_REQUIRED/);
  assert.equal((await engine.call('account.get', { id: 'paper' })).assets.USD.reserved, '0');
  await engine.feed('market.snapshot', { ...snapshot, sequence: '3' });
  await engine.call('order.submit', order);
});
test('shared backend owns one native process and exposes only the paper control surface', async (t) => {
  const { directory, engines } = await fixture(t);
  const { QuantService } = require('../../src/main/services/quant');
  const events = [];
  const service = new QuantService({
    directory: path.join(directory, 'service'),
    publish: (e) => events.push(e),
    nativeOptions: { binaryPath: binary },
  });
  engines.push(service.native);
  t.after(async () => {
    await service.request('native.stop');
    service.dispose();
  });
  assert.equal((await service.request('native.status')).state, 'stopped');
  const [first, second] = await Promise.all([
    service.request('native.start'),
    service.request('native.start'),
  ]);
  assert.equal(first.pid, second.pid);
  assert.equal(first.liveExecution, false);
  await service.request('native.control', { method: 'instrument.register', params: instrument });
  await service.request('native.control', { method: 'account.create', params: account });
  assert.equal((await service.request('native.status')).summary.accounts, 1);
  await assert.rejects(
    service.request('native.control', { method: 'market.snapshot', params: snapshot }),
    /METHOD_UNAVAILABLE/,
  );
  assert.ok(
    events.some((e) => e.type === 'quant-native-changed' && e.native.state === 'connected'),
  );
});
test('authentication and protocol mismatch exit without creating a journal or echoing the token', async () => {
  const secret = 'a'.repeat(64);
  for (const params of [
    { protocol: 1, token: 'b'.repeat(64) },
    { protocol: 2, token: secret },
  ]) {
    const directory = path.join(
      os.tmpdir(),
      'cibyp-native-auth-' + require('node:crypto').randomUUID(),
    );
    const child = spawn(binary, ['--data-dir', directory], {
      env: {
        CIBYP_ENGINE_TOKEN: secret,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    child.stdin.on('error', () => {});
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(
      JSON.stringify({
        id: 'bad-auth',
        method: 'hello',
        params,
      }) + '\n',
    );
    assert.equal(await closed, 1);
    assert.ok(!output.includes(secret));
    assert.match(output, /AUTHENTICATION_OR_VERSION_FAILED/);
    assert.equal(fs.existsSync(directory), false);
  }
});
