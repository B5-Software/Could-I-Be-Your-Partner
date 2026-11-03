/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CoinbaseStream,
  ENDPOINT,
  parseFrame,
  timeNs,
  amount,
  decimal,
  calibrateClock,
} = require('../../src/main/services/quant/coinbase-stream');
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Socket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }
  open() {
    this.dispatchEvent(new Event('open'));
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  message(frame) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: typeof frame === 'string' ? frame : JSON.stringify(frame),
      }),
    );
  }
  close() {
    this.dispatchEvent(new Event('close'));
  }
}
async function fixture(t, options = {}) {
  const calls = [],
    sockets = [],
    dispatchers = [];
  let policy,
    now = Date.now();
  const engine = {
    state: 'connected',
    call: async (method) => {
      assert.equal(method, 'status');
      return {
        feed: { version: 1, boundedDepth: true, sourceClock: true, clockNormalization: true },
      };
    },
    feed: async (method, params) => {
      calls.push({ method, params });
      return method === 'market.snapshot' ? { valid: true } : { filled_orders: 0 };
    },
  };
  const source = new CoinbaseStream({
    engine,
    product: 'ETH-USD',
    instrument: 'cb:ETH-USD',
    depth: 2,
    now: () => now,
    monotonic: () => now,
    createDispatcher: async (url, config) => {
      assert.equal(url, ENDPOINT);
      assert.equal(config.maxPayloadSize, 16 * 1024 * 1024);
      const d = {
        destroyed: false,
        async destroy() {
          this.destroyed = true;
        },
      };
      dispatchers.push(d);
      return d;
    },
    socketFactory: (url, { dispatcher }) => {
      assert.equal(url, ENDPOINT);
      assert.equal(dispatcher, dispatchers.at(-1));
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    onPolicyChange: (listener) => {
      policy = listener;
      return () => {
        policy = null;
      };
    },
    ...options,
  });
  t.after(() => source.stop());
  await source.start();
  sockets[0]?.open();
  let sequence = 0;
  const frame = (channel, events, extra = {}) => ({
    channel,
    timestamp: new Date(now).toISOString(),
    sequence_num: sequence++,
    events,
    ...extra,
  });
  const send = async (value) => {
    const session = source.session;
    sockets.at(-1).message(value);
    await session?.chain;
    await tick();
  };
  const level = (side, price, size = '1') => ({ side, price_level: price, new_quantity: size });
  const snapshot = () =>
    frame('l2_data', [
      {
        type: 'snapshot',
        product_id: 'ETH-USD',
        updates: [
          level('bid', '98'),
          level('bid', '100'),
          level('bid', '99'),
          level('offer', '103'),
          level('offer', '101'),
          level('offer', '102'),
        ],
      },
    ]);
  const heartbeat = () => frame('heartbeats', [{ heartbeat_counter: sequence + 10 }]);
  const history = () =>
    frame('market_trades', [
      {
        type: 'snapshot',
        trades: [
          {
            product_id: 'ETH-USD',
            trade_id: '1',
            side: 'SELL',
            price: '101',
            size: '1000',
            time: new Date(now - 60000).toISOString(),
          },
        ],
      },
    ]);
  const ready = async () => {
    await send(snapshot());
    await send(history());
    await send(heartbeat());
  };
  return {
    source,
    engine,
    calls,
    sockets,
    dispatchers,
    frame,
    send,
    level,
    snapshot,
    heartbeat,
    history,
    ready,
    policy: () => policy?.(),
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}
test('source waits for complete initialization, bounds depth explicitly, ignores historical fills and preserves absolute quantities', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    f.sockets[0].sent.map((m) => m.channel),
    ['level2', 'market_trades', 'heartbeats'],
  );
  assert.ok(f.sockets[0].sent.every((m) => !m.jwt));
  await f.send(f.snapshot());
  await f.send(f.history());
  assert.equal(f.calls.filter((c) => c.method === 'market.snapshot').length, 0);
  await f.send(f.heartbeat());
  assert.equal(f.source.phase, 'ready');
  const snapshot = f.calls.find((c) => c.method === 'market.snapshot').params;
  assert.deepEqual(snapshot.bids, [
    ['100', '1'],
    ['99', '1'],
  ]);
  assert.deepEqual(snapshot.asks, [
    ['101', '1'],
    ['102', '1'],
  ]);
  assert.deepEqual(snapshot.coverage, { bid_floor: '99', ask_ceiling: '102' });
  assert.equal(f.source.inspect().ignoredHistoricalTrades, 1);
  assert.equal(
    f.calls.some((c) => c.method === 'market.trade'),
    false,
  );
  await f.send(f.frame('subscriptions', [{ subscriptions: {} }]));
  await f.send(
    f.frame('l2_data', [
      {
        type: 'update',
        product_id: 'ETH-USD',
        updates: [
          f.level('bid', '98', '999'),
          f.level('bid', '99', '2'),
          f.level('bid', '99', '1.5'),
          f.level('bid', '100', '0'),
        ],
      },
    ]),
  );
  const update = f.calls.filter((c) => c.method === 'market.delta').at(-1).params;
  assert.equal(update.sequence, '2');
  assert.deepEqual(update.updates, [
    { side: 'bid', price: '99', quantity: '1.5' },
    { side: 'bid', price: '100', quantity: '0' },
  ]);
});
test('interleaved global sequence is independent of native streams; trades use maker side and nanosecond order', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.send(f.frame('subscriptions', [{}]));
  await f.send(f.heartbeat());
  const ns = timeNs(new Date(f.now()).toISOString());
  const trade = (id, side, time) => ({
    product_id: 'ETH-USD',
    trade_id: id,
    side,
    price: side === 'BUY' ? '100' : '101',
    size: '0.00000001',
    time,
  });
  const first = new Date(f.now()).toISOString().slice(0, 19) + '.123456001Z';
  const second = first.replace('001Z', '002Z');
  // Use the same second and precise fractions with a bounded future skew.
  const start = (ns / 1000000000n) * 1000000000n + 123456001n;
  f.advance(Number(start / 1000000n) - f.now());
  await f.send(
    f.frame('market_trades', [
      { type: 'update', trades: [trade('3', 'SELL', second), trade('2', 'BUY', first)] },
    ]),
  );
  const trades = f.calls.filter((c) => c.method === 'market.trade').map((c) => c.params);
  assert.deepEqual(
    trades.map((t) => [t.event_id, t.maker_side, t.sequence]),
    [
      ['2', 'bid', '1'],
      ['3', 'ask', '2'],
    ],
  );
  assert.equal(trades[0].time_ns, start.toString());
  assert.equal(BigInt(trades[1].time_ns) - BigInt(trades[0].time_ns), 1n);
});
test('sequence gaps invalidate rather than losing data silently; stale sessions cannot publish after resync', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const old = f.source.session;
  await f.send(f.frame('subscriptions', [{}], { sequence_num: 100 }));
  assert.equal(f.source.phase, 'reconnecting');
  assert.equal(f.source.lastError, 'SOURCE_SEQUENCE_GAP');
  assert.equal(f.calls.at(-1).method, 'market.invalidate');
  const count = f.calls.length;
  f.source.enqueue(old, JSON.stringify(f.heartbeat()));
  await old.chain;
  assert.equal(f.calls.length, count);
  assert.ok(f.dispatchers[0].destroyed);
});
test('identical frames do not refresh or replay; conflicting duplicates and excessively old timestamps fail closed', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const frame = f.heartbeat();
  await f.send(frame);
  const count = f.calls.length;
  await f.send(frame);
  assert.equal(f.calls.length, count);
  assert.equal(f.source.metrics.duplicateFrames, 1);
  await f.send({ ...frame, channel: 'subscriptions' });
  assert.equal(f.source.lastError, 'SOURCE_SEQUENCE_CONFLICT');
  const other = await fixture(t);
  await other.ready();
  await other.send(
    other.frame('subscriptions', [{}], { timestamp: new Date(other.now() - 40000).toISOString() }),
  );
  assert.equal(other.source.lastError, 'SOURCE_TIME_STALE');
});
test('large bootstrap lag catches up without restart; latency suspends matching until a fresh sequenced book can be published', async (t) => {
  const f = await fixture(t);
  const old = new Date(f.now() - 2500).toISOString();
  await f.send({ ...f.snapshot(), timestamp: old });
  await f.send({ ...f.history(), timestamp: old });
  await f.send({ ...f.heartbeat(), timestamp: old });
  assert.equal(f.source.phase, 'delayed');
  assert.equal(
    f.calls.some((c) => c.method === 'market.snapshot'),
    false,
  );
  await f.send(f.heartbeat());
  assert.equal(f.source.phase, 'ready');
  assert.equal(f.sockets.length, 1);
  const oldEpoch = f.source.session.epoch;
  await f.send(f.frame('subscriptions', [{}], { timestamp: old }));
  assert.equal(f.source.phase, 'delayed');
  assert.equal(f.calls.at(-1).method, 'market.invalidate');
  await f.send(f.heartbeat());
  assert.equal(f.source.phase, 'ready');
  assert.equal(f.source.session.epoch, oldEpoch);
  const snapshots = f.calls.filter((c) => c.method === 'market.snapshot');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].params.sequence, '2');
});
test('privacy blocks connection until policy changes, and native shutdown never causes an automatic native restart', async (t) => {
  let blocked = true;
  const f = await fixture(t, {
    createDispatcher: async () => {
      if (blocked) throw Object.assign(Error('blocked'), { code: 'CIBYP_PRIVACY_UNAVAILABLE' });
      return { async destroy() {} };
    },
    socketFactory: () => new Socket(),
  });
  assert.equal(f.source.phase, 'blocked');
  assert.equal(f.source.session, null);
  blocked = false;
  f.policy();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(f.source.session);
  const socket = f.source.session.socket;
  f.engine.state = 'stopped';
  socket.close();
  await tick();
  assert.equal(f.source.phase, 'stopped');
  assert.equal(f.source.desired, false);
});
test('exact parser never rounds transport IDs or money and preserves nanosecond timestamps', () => {
  assert.equal(parseFrame('{"sequence_num":9007199254740993}').sequence_num, '9007199254740993');
  assert.equal(decimal(amount('0.000000000000000001')), '0.000000000000000001');
  assert.equal(
    timeNs('2026-10-25T12:00:00.123456789Z') - timeNs('2026-10-25T12:00:00Z'),
    123456789n,
  );
  assert.equal(
    timeNs('2026-10-25T14:00:00.123456789+02:00'),
    timeNs('2026-10-25T12:00:00.123456789Z'),
  );
  for (const bad of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z'])
    assert.throws(() => timeNs(bad));
  assert.throws(() => amount('1e-8'));
  assert.throws(() => parseFrame('{"sequence_num":-1}'));
});
test('server clock sampling uses a conservative bound and detects local clock steps', async () => {
  let wall = 10000,
    mono = 0;
  const clock = await calibrateClock(
    async () => {
      wall += 100;
      mono += 100;
      return { epochMillis: '8550' };
    },
    () => wall,
    () => mono,
  );
  assert.equal(clock.offset_ns, '-1425000000');
  assert.equal(clock.uncertainty_ns, '150000000');
  await assert.rejects(
    calibrateClock(
      async () => {
        wall += 500;
        mono += 100;
        return { epochMillis: String(wall) };
      },
      () => wall,
      () => mono,
    ),
    /SOURCE_LOCAL_CLOCK_CHANGED/,
  );
});
test('clock projection preserves original exchange nanoseconds instead of silently replacing their provenance', async (t) => {
  const host = Date.now(),
    clock = {
      offset_ns: '-1500000000',
      uncertainty_ns: '50000000',
      calibrated_at_ns: (BigInt(host) * 1000000n).toString(),
    };
  const f = await fixture(t, { calibrate: async () => clock });
  const send = (frame) => f.send({ ...frame, timestamp: new Date(f.now() - 1500).toISOString() });
  await send(f.snapshot());
  await send(f.history());
  await send(f.heartbeat());
  assert.equal(f.source.phase, 'ready');
  const snapshot = f.calls.find((c) => c.method === 'market.snapshot').params;
  assert.equal(BigInt(snapshot.source_time_ns) - BigInt(snapshot.provider_time_ns), 1500000000n);
  assert.deepEqual(snapshot.source_clock, clock);
  const raw = new Date(f.now() - 1500).toISOString();
  await send(
    f.frame('market_trades', [
      {
        type: 'update',
        trades: [
          { product_id: 'ETH-USD', trade_id: '2', side: 'BUY', price: '100', size: '1', time: raw },
        ],
      },
    ]),
  );
  const trade = f.calls.find((c) => c.method === 'market.trade').params;
  assert.equal(trade.provider_time_ns, timeNs(raw).toString());
  assert.equal(BigInt(trade.time_ns) - BigInt(trade.provider_time_ns), 1500000000n);
});
