/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac, randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { duplexPair } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FixFramer, encode, timestamp } = require('../../src/main/services/quant/coinbase-fix-wire');
const { CoinbaseFixSession } = require('../../src/main/services/quant/coinbase-fix-session');
const { connectFix } = require('../../src/main/services/quant/coinbase-fix-network');
const { ExchangeOrders } = require('../../src/main/services/quant/exchange-orders');
const { writeAtomic } = require('../../src/main/services/quant');

const account = {
  key: 'isolated-fixture',
  passphrase: 'test-passphrase',
  secret: Buffer.alloc(64, 19).toString('base64'),
  profileId: randomUUID(),
  credentialId: randomUUID(),
};
const order = { clientId: randomUUID(), venueId: randomUUID(), product: 'ETH-USD', side: 'buy' };
const soh = '\x01';

function packet(seq, type, extra = [], replayed = false, ids = {}) {
  return encode(
    { sequence: seq, type, from: 'Coinbase', to: account.key, replayed, ...ids },
    extra,
  );
}

function statusFields(overrides = {}) {
  return Object.entries({
    11: order.clientId,
    37: order.venueId,
    150: 'I',
    39: '1',
    54: '1',
    55: order.product,
    14: '0.020',
    151: '0.080',
    44: '2000.00',
    38: '0.100',
    ...overrides,
  }).map(([tag, value]) => [Number(tag), value]);
}

async function until(fn) {
  for (let i = 0; i < 350; i++) {
    const result = fn();
    if (result !== undefined && result !== false) return result;
    await delay(5);
  }
  assert.fail('FIX fixture did not make progress');
}

function transport(t, expectedEnv = 'sandbox') {
  const venues = [];
  let policy;
  t.after(() => venues.forEach(({ stream }) => stream.destroy()));
  return {
    venues,
    changePolicy: () => policy?.(),
    options: {
      connect: async (env) => {
        assert.equal(env, expectedEnv);
        const [client, stream] = duplexPair();
        const commands = [];
        const reader = new FixFramer();
        stream.on('data', (chunk) => reader.push(chunk, (fields) => commands.push(fields)));
        venues.push({ stream, commands, command: (index) => until(() => commands[index]) });
        return client;
      },
      subscribePolicy: (onChange) => {
        policy = onChange;
        return () => {
          policy = undefined;
        };
      },
      timeout: 2900,
    },
  };
}

test('FIX framing uses wire bytes, accepts fragmented and joined frames and rejects damaged data', () => {
  const payload = packet(1, 'A', [[58, '连接成功']]);
  const prefix = payload.toString('utf8').split(soh);
  assert.equal(Number(prefix[1].slice(2)), Buffer.byteLength(prefix.slice(2, -2).join(soh) + soh));
  const expected = [...payload.subarray(0, -7)].reduce((sum, byte) => (sum + byte) % 256, 0);
  assert.equal(prefix.at(-2), '10=' + String(expected).padStart(3, '0'));
  const fields = [];
  const reader = new FixFramer();
  for (const byte of payload) reader.push(Buffer.from([byte]), (frame) => fields.push(frame));
  reader.push(Buffer.concat([packet(2, '0'), packet(3, '1', [[112, 'ping']])]), (frame) =>
    fields.push(frame),
  );
  assert.equal(fields[0].get(58), '连接成功');
  assert.deepEqual(
    fields.map((frame) => frame.get(35)),
    ['A', '0', '1'],
  );
  const damaged = Buffer.from(payload);
  damaged[damaged.length - 2] = damaged[damaged.length - 2] === 48 ? 49 : 48;
  assert.throws(() => new FixFramer().push(damaged, () => assert.fail()), /EXCHANGE_FIX_FRAME/);
  assert.throws(() => packet(4, '0', [[112, 'inject' + soh + '35=D']]), /EXCHANGE_FIX_FRAME/);
  assert.equal(timestamp(Date.UTC(2026, 9, 3, 9, 12, 54, 11)), '20261003-09:12:54.011');
});

test('FIX authenticates without cancel-on-disconnect and recovers live gaps and paged reconnects', async (t) => {
  const f = transport(t);
  const checkpoints = [];
  const session = new CoinbaseFixSession({
    env: 'sandbox',
    account,
    ...f.options,
    checkpoint: (n) => checkpoints.push(n),
  });
  t.after(() => session.close());
  const query = session.query(order);
  const first = await until(() => f.venues[0]);
  const logon = await first.command(0);
  assert.equal(logon.get(35), 'A');
  assert.equal(logon.get(34), '1');
  assert.equal(logon.get(56), 'Coinbase');
  assert.match(logon.get(52), /^\d{8}-\d\d:\d\d:\d\d\.\d{3}$/);
  assert.equal(logon.get(141), 'Y');
  assert.equal(logon.get(8013), undefined);
  assert.equal(logon.get(1137), '9');
  assert.equal(
    logon.get(96),
    createHmac('sha256', Buffer.from(account.secret, 'base64'))
      .update([logon.get(52), 'A', '1', account.key, 'Coinbase', account.passphrase].join(soh))
      .digest('base64'),
  );
  first.stream.write(packet(1, 'A', [[108, '10']]));
  const ask = await first.command(1);
  assert.equal(ask.get(35), 'H');
  assert.equal(ask.get(11), order.clientId);
  assert.equal(ask.get(55), order.product);
  first.stream.write(packet(4, '8', statusFields()));
  const resend = await first.command(2);
  assert.deepEqual([resend.get(35), resend.get(7), resend.get(16)], ['2', '2', '3']);
  assert.equal(session.status().phase, 'recovering');
  first.stream.write(
    packet(
      2,
      '4',
      [
        [123, 'Y'],
        [36, '4'],
      ],
      true,
    ),
  );
  const result = await query;
  assert.equal(result.remainingSize, '0.080');
  assert.equal(result.filledSize, '0.020');
  assert.equal(session.status().phase, 'ready');
  assert.ok(checkpoints.includes(5));

  f.changePolicy();
  assert.equal(session.status().error, 'EXCHANGE_FIX_POLICY');
  const after = session.query(order);
  const second = await until(() => f.venues[1]);
  const resumed = await second.command(0);
  assert.equal(resumed.get(34), '1');
  assert.equal(resumed.get(141), 'N');
  second.stream.write(
    Buffer.concat([
      packet(1, 'A'),
      packet(2, '4', [
        [123, 'Y'],
        [36, '2105'],
      ]),
    ]),
  );
  const pages = [
    [5, 1004],
    [1005, 2004],
    [2005, 2104],
  ];
  for (const [index, [begin, end]] of pages.entries()) {
    const resend = await second.command(index + 1);
    assert.deepEqual(
      [resend.get(35), resend.get(7), resend.get(16)],
      ['2', String(begin), String(end)],
    );
    const last = index === pages.length - 1;
    second.stream.write(
      Buffer.concat([
        packet(
          begin,
          '4',
          [
            [123, 'Y'],
            [36, String(last ? end : end + 1)],
          ],
          true,
        ),
        ...(last ? [packet(end, '8', statusFields({ 39: '4' }), true)] : []),
      ]),
    );
  }
  assert.equal((await second.command(4)).get(35), 'H');
  second.stream.write(packet(2105, '8', statusFields({ 39: '2', 14: '0.100', 151: '0' })));
  assert.equal((await after).status, 'filled');
  assert.equal(checkpoints.at(-1), 2106);
});

test('FIX verifies the order identity and never substitutes earlier or unrelated reports', async (t) => {
  const f = transport(t);
  const session = new CoinbaseFixSession({ env: 'sandbox', account, ...f.options });
  t.after(() => session.close());
  const rejected = session.query(order);
  const first = await until(() => f.venues[0]);
  await first.command(0);
  first.stream.write(packet(1, 'A'));
  await first.command(1);
  first.stream.write(
    Buffer.concat([
      packet(2, '8', statusFields({ 150: 'F' })),
      packet(3, '8', statusFields({ 11: randomUUID() })),
      packet(4, '8', statusFields({ 37: randomUUID() })),
    ]),
  );
  await assert.rejects(rejected, /EXCHANGE_FIX_REPORT/);
  const absent = session.query(order);
  await first.command(2);
  first.stream.write(
    packet(5, '8', [
      [11, order.clientId],
      [150, 'I'],
      [39, '8'],
      [103, '5'],
    ]),
  );
  await assert.rejects(absent, /EXCHANGE_FIX_NOT_FOUND/);
  const confirmed = session.query(order);
  await first.command(3);
  first.stream.write(packet(6, '8', statusFields(), false, { to: 'another-api-key' }));
  await assert.rejects(confirmed, /EXCHANGE_FIX_FRAME/);
  assert.equal(session.status().phase, 'disconnected');
});

test('FIX opens verified TLS through HTTP CONNECT and fails closed while Tor is unavailable', async (t) => {
  const server = http.createServer();
  let connection;
  let connectHeaders;
  server.on('connect', (req, socket) => {
    connection = socket;
    connectHeaders = [req.url, req.headers['proxy-authorization']];
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    connection?.destroy();
    server.close();
  });
  const expectedHost = 'fix-ord.sandbox.exchange.coinbase.com';
  const out = await connectFix('sandbox', AbortSignal.timeout(2500), {
    resolveProxy: async (target) => {
      assert.equal(target, 'https://' + expectedHost + ':6121');
      return `http://name:secret@127.0.0.1:${server.address().port}`;
    },
    tlsConnect: (options) => {
      assert.ok(options.socket);
      assert.equal(options.servername, expectedHost);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.minVersion, 'TLSv1.2');
      const socket = Object.assign(new EventEmitter(), {
        authorized: true,
        setNoDelay() {},
        destroy: () => options.socket.destroy(),
      });
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    },
  });
  assert.deepEqual(connectHeaders, [
    expectedHost + ':6121',
    'Basic ' + Buffer.from('name:secret').toString('base64'),
  ]);
  out.destroy();
  await assert.rejects(
    connectFix('live', AbortSignal.timeout(100), {
      resolveProxy: async () => {
        throw Object.assign(Error(), { code: 'CIBYP_PRIVACY_UNAVAILABLE' });
      },
      tlsConnect: () => assert.fail('Must not fall back to direct'),
    }),
    /EXCHANGE_FIX_PRIVACY/,
  );
});

test('FIX sends the destination name through SOCKS5 and requires an authorized target certificate', async (t) => {
  let raw;
  const destination = Promise.withResolvers();
  const server = net.createServer((socket) => {
    raw = socket;
    socket.once('data', (greeting) => {
      assert.deepEqual(greeting, Buffer.from([5, 1, 0]));
      socket.once('data', (request) => {
        assert.deepEqual(request.subarray(0, 4), Buffer.from([5, 1, 0, 3]));
        const size = request[4];
        destination.resolve([
          request.toString('ascii', 5, 5 + size),
          request.readUInt16BE(5 + size),
        ]);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
      });
      socket.write(Buffer.from([5, 0]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    raw?.destroy();
    server.close();
  });
  const testConnection = connectFix('live', AbortSignal.timeout(4000), {
    resolveProxy: async () => `socks5://127.0.0.1:${server.address().port}`,
    tlsConnect: (options) => {
      assert.equal(options.servername, 'fix-ord.exchange.coinbase.com');
      assert.equal(options.rejectUnauthorized, true);
      const socket = Object.assign(new EventEmitter(), {
        authorized: false,
        destroy: () => options.socket.destroy(),
      });
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    },
  });
  await assert.rejects(testConnection, /EXCHANGE_FIX_TLS/);
  assert.deepEqual(await destination.promise, ['fix-ord.exchange.coinbase.com', 6121]);
});

test('FIX queries the scoped journal without blocking or replacing the REST record and reloads its cursor', async (t) => {
  const f = transport(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-fix-test-'));
  const events = [];
  const service = {
    directory,
    workspace: (id) => ({ id, market: { venue: 'coinbase', product: order.product } }),
    publish: (event) => events.push(event),
  };
  const create = (options) => new CoinbaseFixSession({ ...options, ...f.options });
  const setup = (saved = account) =>
    new ExchangeOrders(service, writeAtomic, {
      api: {},
      fix: { create },
      vault: () => ({ load: async () => saved }),
    });
  let exchange = setup();
  t.after(() => {
    exchange.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  exchange.record({
    ...order,
    env: 'sandbox',
    workspaceId: 'target',
    status: 'partially-filled',
    profileId: account.profileId,
    filledSize: '0.01',
    createdAt: Date.now(),
  });
  const params = { env: 'sandbox', id: 'target', orderId: order.clientId };
  await assert.rejects(
    exchange.request('fixQuery', { ...params, id: 'elsewhere' }),
    /EXCHANGE_ORDER_ID/,
  );
  await assert.rejects(
    exchange.request('fixConnect', params, { agentContext: { workspaceId: 'target' } }),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  assert.equal(f.venues.length, 0);
  exchange.queue = new Promise(() => {});
  const result = exchange.request('fixQuery', params);
  const first = await until(() => f.venues[0]);
  await first.command(0);
  first.stream.write(packet(1, 'A'));
  await first.command(1);
  first.stream.write(packet(2, '8', statusFields()));
  assert.equal((await result).filledSize, '0.020');
  const listed = await exchange.request('list', params);
  assert.equal(listed.items[0].filledSize, '0.01');
  assert.equal(listed.fix.lastSequence, 2);
  assert.ok(events.some((event) => event.type === 'quant-exchange-changed'));
  const persisted = fs.readFileSync(path.join(directory, 'coinbase-fix-sandbox.json'), 'utf8');
  assert.doesNotMatch(persisted, /test-passphrase|isolated-fixture/);
  assert.equal(JSON.parse(persisted).cursor, 3);
  exchange.dispose();
  exchange = setup();
  const reconnect = exchange.request('fixConnect', params);
  const next = await until(() => f.venues[1]);
  assert.equal((await next.command(0)).get(141), 'N');
  next.stream.write(
    Buffer.concat([
      packet(1, 'A'),
      packet(2, '4', [
        [123, 'Y'],
        [36, '3'],
      ]),
    ]),
  );
  assert.equal((await reconnect).phase, 'ready');
  await exchange.request('fixDisconnect', params);
  assert.equal((await exchange.request('list', params)).fix.phase, 'idle');
  const interrupted = assert.rejects(exchange.request('fixConnect', params), /EXCHANGE_FIX_CLOSED/);
  const third = await until(() => f.venues[2]);
  await third.command(0);
  await exchange.request('fixDisconnect', params);
  await interrupted;
});

async function nativeTrading(t, env = 'sandbox', authority, conditional = {}) {
  const f = transport(t, env);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-fix-trading-'));
  const venueId = randomUUID();
  const cancels = [];
  const state = { remote: null, halted: false };
  const service = {
    directory,
    workspace: (id) => ({ id, market: { venue: 'coinbase', product: 'ETH-USD' } }),
    publish() {},
    getWallet: () => ({
      emergency: {
        generation: 'fixture-generation',
        get halted() {
          return state.halted;
        },
        assert: () => {
          if (state.halted) throw Error('WALLET_EMERGENCY_STOPPED');
          return 'fixture-generation';
        },
      },
    }),
  };
  const api = {
    accounts: async () => [
      { profile_id: account.profileId, currency: 'USD', available: '1000', trading_enabled: true },
    ],
    product: async () => ({
      id: 'ETH-USD',
      status: 'online',
      quote_increment: '0.01',
      base_increment: '0.001',
      base_currency: 'ETH',
      quote_currency: 'USD',
      min_market_funds: '10',
      cancel_only: false,
    }),
    fees: async () => ({ maker_fee_rate: '0.004', taker_fee_rate: '0.006' }),
    submit: () => assert.fail('FIX orders must never fall back to REST submission'),
    lookup: async (_env, _account, lookup) => {
      if (
        state.remote &&
        (lookup.venueId === venueId || lookup.clientId === state.remote.client_oid)
      )
        return structuredClone(state.remote);
      throw Object.assign(Error('fixture lookup not found'), { httpStatus: 404 });
    },
    cancel: async (_env, _account, candidate, beforeSend) => {
      beforeSend();
      assert.equal(candidate.venueId, venueId);
      cancels.push(candidate.clientId);
      state.remote.status = 'done';
      state.remote.done_reason = 'canceled';
      return venueId;
    },
  };
  let owner;
  const restart = () => {
    owner?.dispose();
    owner = new ExchangeOrders(service, writeAtomic, {
      api,
      vault: () => ({ load: async () => account }),
      fix: { create: (options) => new CoinbaseFixSession({ ...options, ...f.options }) },
    });
  };
  restart();
  t.after(() => {
    owner.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (action, input, context) =>
    owner.request(action, { id: 'native', env, ...input }, context);
  const rootContext = {
    agentContext: { workspaceId: 'native', nodes: [{ subject: 'quant:native' }] },
  };
  const authorize = async (overrides = {}) => {
    const review = await request('prepareAuthority', {
      side: 'buy',
      postOnly: true,
      perOrder: '260',
      total: '500',
      maxOrders: 5,
      minutes: 60,
      transport: 'fix',
      allowAmend: true,
      ...overrides,
    });
    return request('confirmAuthority', {
      grantId: review.grantId,
      specHash: review.specHash,
      ack: 'ALLOW EXCHANGE AGENT',
    });
  };
  const params = {
    transport: 'fix',
    operationId: 'native-origin',
    price: '2000',
    size: '0.1',
    side: 'buy',
    postOnly: true,
    ...conditional,
  };
  const grant = authority ? await authorize(authority) : null;
  const submitArgs = grant ? { ...params, grantId: grant.grantId } : null;
  let placing = grant ? request('submitAuthorized', submitArgs, rootContext) : null;
  const connect = grant ? null : request('fixConnect');
  const first = await until(() => f.venues[0]);
  await first.command(0);
  first.stream.write(packet(1, 'A'));
  await connect;
  const draft = grant ? null : await request('preview', params);
  const confirmation = draft
    ? { reviewId: draft.reviewId, specHash: draft.specHash, ack: 'PLACE ORDER' }
    : null;
  placing ||= request('confirm', confirmation);
  const submit = await first.command(1);
  const disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'coinbase-orders.json')));
  assert.deepEqual(
    [35, 11, 18, 38, 44, 54, 55, 59].map((tag) => submit.get(tag)),
    [
      'D',
      disk().orders[0].clientId,
      params.postOnly ? 'A' : undefined,
      '0.1',
      '2000',
      '1',
      'ETH-USD',
      '1',
    ],
  );
  assert.equal(
    submit.get(40),
    conditional.stopLimitPrice ? 'O' : conditional.stopPrice ? '4' : '2',
  );
  assert.equal(submit.get(99), conditional.stopPrice);
  assert.equal(submit.get(3040), conditional.stopLimitPrice);
  assert.equal(
    submit.get(1109),
    conditional.triggerDirection ? (conditional.triggerDirection === 'up' ? 'U' : 'D') : undefined,
  );
  assert.equal(disk().orders[0].status, 'submitting');
  assert.ok(disk().orders[0].fix.connectionId);
  const execution = (next, { type = '0', status = '0', filled = '0', leaves = '0.1' } = {}) => {
    const stopPrice = next.get(99);
    const stopLimitPrice = next.get(3040);
    state.remote = {
      id: venueId,
      client_oid: next.get(11),
      profile_id: account.profileId,
      product_id: 'ETH-USD',
      type: stopPrice && !stopLimitPrice ? 'stop' : 'limit',
      ...(stopPrice && {
        stop_price: stopPrice,
        stop: stopLimitPrice || conditional.triggerDirection === 'up' ? 'entry' : 'loss',
      }),
      ...(stopLimitPrice && { stop_limit_price: stopLimitPrice }),
      time_in_force: 'GTC',
      post_only: params.postOnly,
      side: 'buy',
      price: next.get(44),
      size: next.get(38),
      status: stopPrice && !stopLimitPrice ? 'active' : 'open',
      filled_size: filled,
      executed_value: filled === '0' ? '0' : '50',
      fill_fees: filled === '0' ? '0' : '0.2',
    };
    return [
      [11, next.get(11)],
      [37, venueId],
      [17, randomUUID()],
      [150, type],
      [39, status],
      [54, '1'],
      [55, 'ETH-USD'],
      ...(params.postOnly ? [[18, 'A']] : []),
      [14, filled],
      [151, leaves],
      [44, state.remote.price],
      [38, state.remote.size],
      ...(stopPrice
        ? [
            [40, stopLimitPrice ? 'O' : '4'],
            [99, stopPrice],
            stopLimitPrice
              ? [3040, stopLimitPrice]
              : [1109, conditional.triggerDirection === 'up' ? 'U' : 'D'],
          ]
        : []),
      ...(next.get(41) ? [[41, next.get(41)]] : []),
    ];
  };
  const waitingStop = conditional.stopPrice && !conditional.stopLimitPrice;
  first.stream.write(packet(2, '8', execution(submit, { status: waitingStop ? 'A' : '0' })));
  const order = await placing;
  assert.equal(order.status, waitingStop ? 'pending' : 'open');
  assert.equal(order.venueId, venueId);
  assert.equal(
    (
      await (grant
        ? request('submitAuthorized', submitArgs, rootContext)
        : request('confirm', confirmation))
    ).clientId,
    order.clientId,
  );
  const orderId = order.clientId;
  const preview = (price, size, extra) =>
    request('previewAmend', { orderId, price, size, ...extra });
  const confirm = (quote, extra = {}) =>
    request('confirmAmend', {
      orderId,
      reviewId: quote.reviewId,
      specHash: quote.specHash,
      ack: 'AMEND ORDER',
      ...extra,
    });
  const getOrder = async () =>
    (await request('list')).items.find((row) => row.clientId === orderId);
  const acquire = () => owner;
  return {
    f,
    first,
    order,
    request,
    execution,
    preview,
    confirm,
    getOrder,
    acquire,
    disk,
    state,
    cancels,
    restart,
    authorize,
    grant,
    rootContext,
  };
}

test('FIX stop-limit reviews freeze the stop terms, and triggered orders cannot be amended', async (t) => {
  const f = await nativeTrading(t, 'sandbox', null, {
    stopPrice: '1900',
    triggerDirection: 'down',
  });
  const orderId = f.order.clientId;
  assert.equal(f.order.stopState, 'waiting');
  assert.equal(f.disk().orders[0].stopPrice, '1900');
  assert.equal((await f.getOrder()).replacementAvailable, false);
  const terms = {
    operationId: 'bad-stop',
    side: 'buy',
    postOnly: true,
    size: '0.1',
    price: '2000',
    stopPrice: '1900',
    triggerDirection: 'down',
  };
  await assert.rejects(f.request('preview', terms), /EXCHANGE_STOP_REQUIRES_FIX/);
  await assert.rejects(
    f.request('preview', { ...terms, transport: 'fix', stopPrice: '1900.001' }),
    /EXCHANGE_ORDER_INCREMENT/,
  );
  await assert.rejects(
    f.preview('2000', '0.1', { stopPrice: '1925', triggerDirection: 'up' }),
    /EXCHANGE_STOP_TERMS/,
  );

  const draft = await f.preview('2000', '0.1', { stopPrice: '1925.00' });
  assert.equal(draft.originalStopPrice, '1900');
  assert.equal(draft.stopPrice, '1925');
  assert.equal(draft.keepsTriggerPriority, false);
  await assert.rejects(f.confirm(draft, { specHash: 'wrong' }), /EXCHANGE_REVIEW_CHANGED/);
  const pending = f.confirm(draft);
  const wire = await f.first.command(2);
  assert.deepEqual(
    [35, 40, 99, 1109].map((tag) => wire.get(tag)),
    ['G', '4', '1925', undefined],
  );
  assert.equal(f.disk().orders[0].fix.pending.stopPrice, '1925');
  f.first.stream.write(packet(3, '8', f.execution(wire, { type: '5', status: '5' })));
  assert.equal((await pending).stopPrice, '1925');

  Object.assign(f.state.remote, { type: 'limit', status: 'open', stop_price: '0' });
  const triggered = await f.request('reconcile', { orderId });
  assert.equal(triggered.stopState, 'triggered');
  assert.equal(triggered.stopPrice, '1925');
  assert.equal((await f.getOrder()).amendmentAvailable, false);
  await assert.rejects(
    f.preview('2000', '0.09', { stopPrice: '1925' }),
    /EXCHANGE_FIX_AMEND_UNAVAILABLE/,
  );
  assert.equal(f.first.commands.length, 3);
  f.restart();
  assert.equal((await f.getOrder()).stopState, 'triggered');
  assert.equal((await f.getOrder()).cancelAvailable, true);
});

test('Coinbase TPSL requires its own FIX authority, holds the larger buy limit and records repricing', async (t) => {
  const terms = { stopPrice: '2050', stopLimitPrice: '2200', postOnly: false };
  const legacy = await nativeTrading(
    t,
    'sandbox',
    { allowStopLimit: true, postOnly: false },
    { postOnly: false },
  );
  await assert.rejects(
    legacy.request(
      'submitAuthorized',
      {
        ...terms,
        operationId: 'tpsl-no-consent',
        grantId: legacy.grant.grantId,
        price: '2000',
        size: '0.1',
        side: 'buy',
      },
      legacy.rootContext,
    ),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  assert.equal(legacy.first.commands.length, 2);
  const f = await nativeTrading(t, 'sandbox', { allowTpsl: true, postOnly: false }, terms);
  const { clientId: orderId, venueId } = f.order;
  assert.equal(f.order.notional, '220');
  assert.equal(f.order.authorizedDebit, '221.32');
  assert.equal(f.order.activePrice, '2000');
  assert.equal(f.order.stopState, 'waiting');
  const review = {
    ...terms,
    transport: 'fix',
    operationId: 'invalid-tpsl',
    side: 'sell',
    size: '0.1',
    price: '2000',
  };
  await assert.rejects(f.request('preview', review), /EXCHANGE_TPSL_TERMS/);
  const buy = { ...review, side: 'buy' };
  await assert.rejects(f.request('preview', { ...buy, postOnly: true }), /EXCHANGE_TPSL_TERMS/);
  await assert.rejects(
    f.request('preview', { ...buy, triggerDirection: 'up' }),
    /EXCHANGE_TPSL_TERMS/,
  );
  await assert.rejects(
    f.request('preview', { ...buy, stopLimitPrice: '2200.001' }),
    /EXCHANGE_ORDER_INCREMENT/,
  );
  await assert.rejects(
    f.authorize({ allowTpsl: true, postOnly: true }),
    /EXCHANGE_AUTHORITY_LIMITS/,
  );
  await assert.rejects(
    f.authorize({ allowTpsl: true, postOnly: false, transport: 'rest' }),
    /EXCHANGE_AUTHORITY_LIMITS/,
  );
  await assert.rejects(
    f.request(
      'submitAuthorized',
      { ...buy, grantId: f.grant.grantId, stopLimitPrice: '3000' },
      f.rootContext,
    ),
    /EXCHANGE_AUTHORITY_BUDGET/,
  );

  const input = {
    orderId,
    grantId: f.grant.grantId,
    operationId: 'modify-both',
    price: '2000',
    size: '0.1',
    stopPrice: '2050',
    stopLimitPrice: '2300',
  };
  const change = f.request('amendAuthorized', input, f.rootContext);
  const wire = await f.first.command(2);
  assert.deepEqual(
    [35, 40, 44, 99, 3040].map((tag) => wire.get(tag)),
    ['G', 'O', '2000', '2050', '2300'],
  );
  const literal = f.execution(wire, { type: '5', status: '5' });
  f.first.stream.write(packet(3, '8', literal));
  const amended = await change;
  assert.equal(amended.notional, '230');
  assert.equal(amended.amendment.authorizedDebit, '10.060000000000000002');
  const repriced = [
    [11, wire.get(11)],
    [37, venueId],
    [17, randomUUID()],
    [150, 'D'],
    [378, '3'],
    [39, '0'],
    [40, 'O'],
    [55, 'ETH-USD'],
    [44, '2300'],
    [151, '0.1'],
  ];
  f.first.stream.write(packet(4, '8', repriced));
  await until(() => f.disk().orders[0].activeLeg === 'stop-loss');
  let current = await f.getOrder();
  assert.equal(current.activePrice, '2300');
  assert.equal(current.price, '2000');
  assert.equal(current.stopState, 'triggered');
  assert.equal(current.amendmentAvailable, false);
  await assert.rejects(
    f.request(
      'amendAuthorized',
      { ...input, operationId: 'too-late', stopPrice: '2100' },
      f.rootContext,
    ),
    /EXCHANGE_FIX_AMEND_UNAVAILABLE/,
  );
  f.restart();
  await assert.rejects(f.request('reconcile', { orderId }), /EXCHANGE_RESPONSE/);
  f.state.remote.price = '2300.00';
  current = await f.request('reconcile', { orderId });
  assert.equal(current.activeLeg, 'stop-loss');
  assert.equal(current.activePrice, '2300');
  assert.equal(current.fix.clientId, amended.fix.clientId);
});

test('a TPSL take-profit fill locks the leg and a lost stop-limit revision needs distinct evidence', async (t) => {
  const terms = { stopPrice: '2050', stopLimitPrice: '2200', postOnly: false };
  const f = await nativeTrading(t, 'sandbox', null, terms);
  const orderId = f.order.clientId;
  const draft = await f.preview('2000', '0.1', { stopPrice: '2050', stopLimitPrice: '2250' });
  const pending = f.confirm(draft);
  const wire = await f.first.command(2);
  f.first.stream.destroy();
  assert.equal((await pending).status, 'amend-unknown');
  f.restart();
  assert.equal((await f.request('reconcile', { orderId })).stopLimitPrice, '2200');
  f.execution(wire, { type: '5', status: '5', filled: '0.025', leaves: '0.075' });
  Object.assign(f.state.remote, { status: 'open', client_oid: f.order.clientId });
  const reconciled = await f.request('reconcile', { orderId });
  assert.equal(reconciled.stopLimitPrice, '2250');
  assert.equal(reconciled.activeLeg, 'take-profit');
  assert.equal(reconciled.filledSize, '0.025');
  assert.equal(reconciled.amendmentAvailable, undefined);
  assert.equal((await f.getOrder()).amendmentAvailable, false);
  assert.equal((await f.getOrder()).cancelAvailable, true);
});

test('FIX conditional Agent grants reserve stop orders and reconcile a lost trigger-only amendment', async (t) => {
  const terms = { stopPrice: '2050', triggerDirection: 'up' };
  const ordinary = await nativeTrading(t, 'sandbox', {});
  await assert.rejects(
    ordinary.request(
      'submitAuthorized',
      {
        ...terms,
        operationId: 'unapproved-stop',
        grantId: ordinary.grant.grantId,
        price: '2060',
        size: '0.1',
        side: 'buy',
        postOnly: true,
      },
      ordinary.rootContext,
    ),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );

  const f = await nativeTrading(t, 'sandbox', { allowStopLimit: true }, terms);
  const orderId = f.order.clientId;
  assert.equal(f.grant.allowStopLimit, true);
  assert.equal((await f.request('list', {}, f.rootContext)).grants[0].remaining, '298.8');
  const input = {
    orderId,
    operationId: 'trigger-only',
    grantId: f.grant.grantId,
    price: '2000',
    size: '0.1',
    stopPrice: '2075',
  };
  const task = f.request('amendAuthorized', input, f.rootContext);
  const wire = await f.first.command(2);
  assert.equal(wire.get(99), '2075');
  f.first.stream.destroy();
  assert.equal((await task).amendment.outcome, 'unknown');
  f.restart();
  assert.equal((await f.request('reconcile', { orderId })).status, 'amend-unknown');
  assert.equal((await f.getOrder()).stopPrice, '2050');
  f.execution(wire, { type: '5', status: '5' });
  const next = await f.request('reconcile', { orderId });
  assert.equal(next.stopPrice, '2075');
  assert.equal(next.stopState, 'waiting');
  assert.equal(next.fix.clientId, wire.get(11));
  const replay = await f.request('amendAuthorized', input, f.rootContext);
  assert.equal(replay.amendment.outcome, 'applied');
  assert.equal(replay.amendment.authorizedDebit, '0');
  assert.equal((await f.request('list', {}, f.rootContext)).grants[0].ordersRemaining, 3);
});

test('native FIX trades journal before dispatch, amend on the placement connection and retain queue evidence', async (t) => {
  const f = await nativeTrading(t);
  Object.assign(f.state.remote, { filled_size: '0.025', executed_value: '50', fill_fees: '0.2' });
  assert.equal((await f.getOrder()).amendmentAvailable, true);
  await assert.rejects(f.preview('2000', '0.025'), /EXCHANGE_FIX_AMEND_TERMS/);
  const draft = await f.preview('2000', '0.075');
  assert.equal(draft.keepsPriority, true);
  assert.equal(draft.remainingSize, '0.05');
  assert.equal(draft.notional, '100');
  assert.equal(draft.estimatedFee, '0.6');
  await assert.rejects(f.confirm(draft, { ack: 'PLACE ORDER' }), /EXCHANGE_REVIEW_CHANGED/);
  await assert.rejects(f.confirm(draft, { specHash: 'stale' }), /EXCHANGE_REVIEW_CHANGED/);
  await assert.rejects(
    f.request('previewAmend', {}, { agentContext: { workspaceId: 'native' } }),
    /EXCHANGE_HUMAN_REQUIRED/,
  );
  assert.equal(f.first.commands.length, 2);
  const submitting = f.confirm(draft);
  const amend = await f.first.command(2);
  assert.deepEqual(
    [35, 11, 37, 41, 38, 44, 55].map((tag) => amend.get(tag)),
    ['G', draft.reviewId, f.order.venueId, f.order.clientId, '0.075', '2000', 'ETH-USD'],
  );
  assert.equal(f.disk().orders[0].fix.pending.clientId, draft.reviewId);
  assert.equal(f.disk().orders[0].size, '0.1');
  f.first.stream.write(
    packet(3, '8', f.execution(amend, { type: '5', status: '5', filled: '0.03', leaves: '0.045' })),
  );
  const result = await submitting;
  assert.equal(result.clientId, f.order.clientId);
  assert.equal(result.venueId, f.order.venueId);
  assert.equal(result.fix.clientId, draft.reviewId);
  assert.equal(result.status, 'partially-filled');
  assert.equal(result.filledSize, '0.03');
  assert.equal(result.executedValue, '50');
  assert.equal(result.fix.amendments[0].outcome, 'applied');
  assert.equal((await f.request('list')).items.length, 1);
  assert.equal((await f.confirm(draft)).fix.amendments.length, 1);

  const rejected = await f.preview('2010', '0.08');
  assert.equal(rejected.keepsPriority, false);
  const result2 = f.confirm(rejected);
  const second = await f.first.command(3);
  assert.equal(second.get(41), draft.reviewId);
  f.first.stream.write(
    packet(4, '9', [
      [11, rejected.reviewId],
      [37, f.order.venueId],
      [41, draft.reviewId],
      [434, '2'],
      [39, '8'],
    ]),
  );
  assert.equal((await result2).price, '2000');
  assert.deepEqual(
    (await f.getOrder()).fix.amendments.map((row) => row.outcome),
    ['applied', 'rejected'],
  );
  f.f.changePolicy();
  assert.equal((await f.getOrder()).amendmentAvailable, false);
  await assert.rejects(f.preview('2010', '0.08'), /EXCHANGE_FIX_SAME_CONNECTION/);
  assert.equal(f.f.venues.length, 1);
});

test('lost FIX amendment receipt survives restart and reconciles the same venue order without sending again', async (t) => {
  const f = await nativeTrading(t);
  const draft = await f.preview('2030', '0.15');
  const sending = f.confirm(draft);
  const amend = await f.first.command(2);
  f.f.changePolicy();
  assert.equal((await sending).status, 'amend-unknown');
  assert.equal(f.disk().orders[0].fix.pending.clientId, draft.reviewId);
  f.restart();
  assert.equal((await f.confirm(draft)).status, 'amend-unknown');
  const orderId = f.order.clientId;
  const unresolved = await f.request('reconcile', { orderId });
  assert.equal(unresolved.status, 'amend-unknown');
  f.execution(amend, { type: '5', status: '5', leaves: '0.15' });
  const verified = await f.request('reconcile', { orderId });
  assert.equal(verified.price, '2030');
  assert.equal(verified.venueId, f.order.venueId);
  assert.equal(verified.fix.amendments[0].outcome, 'applied');
  assert.equal(f.f.venues.length, 1);
  assert.equal(f.first.commands.length, 3);
});

test('emergency stop cancels the exact venue ID even when native amendment terms are in flight', async (t) => {
  const f = await nativeTrading(t, 'live');
  const draft = await f.preview('2020', '0.12');
  const confirming = f.confirm(draft);
  await f.first.command(2);
  f.state.halted = true;
  const owner = f.acquire();
  owner.emergencyHalt();
  const uncertain = await confirming;
  assert.equal(uncertain.status, 'amend-unknown');
  assert.equal(uncertain.error, 'WALLET_EMERGENCY_STOPPED');
  await owner.cancelForEmergency(account, uncertain, () => {});
  assert.deepEqual(f.cancels, [f.order.clientId]);
  assert.equal((await f.getOrder()).status, 'canceled');
});

test('FIX Agent grants place and amend on their reviewed transport and charge lifetime exposure and operations', async (t) => {
  const f = await nativeTrading(t, 'sandbox', {});
  assert.equal(f.grant.transport, 'fix');
  assert.equal(f.grant.allowAmend, true);
  assert.equal(f.order.authorizedDebit, '201.2');
  const grantId = f.grant.grantId;
  const amend = (operationId, price, size, context = f.rootContext) =>
    f.request(
      'amendAuthorized',
      { orderId: f.order.clientId, grantId, operationId, price, size },
      context,
    );
  assert.equal((await f.request('list', {}, f.rootContext)).items[0].amendmentAvailable, true);
  const child = {
    agentContext: {
      ...f.rootContext.agentContext,
      nodes: [...f.rootContext.agentContext.nodes, { subject: 'subagent:fixture' }],
    },
  };
  await assert.rejects(amend('child', '1900', '0.12', child), /EXCHANGE_HUMAN_REQUIRED/);
  await assert.rejects(
    f.request('amendAuthorized', {
      orderId: f.order.clientId,
      grantId,
      operationId: 'human',
      price: '1900',
      size: '0.12',
    }),
    /EXCHANGE_AGENT_REQUIRED/,
  );
  const growing = amend('add-more', '1900', '0.12');
  const firstAmend = await f.first.command(2);
  assert.equal(firstAmend.get(35), 'G');
  const charge = f.disk().orders[0].fix.pending;
  assert.equal(
    charge.authorizedDebit,
    '38.228',
    'a price reduction must not subsidize newly added quantity',
  );
  assert.equal(charge.grantId, grantId);
  f.first.stream.write(
    packet(3, '8', f.execution(firstAmend, { type: '5', status: '5', leaves: '0.12' })),
  );
  const increased = await growing;
  assert.equal(increased.amendment.outcome, 'applied');
  assert.equal((await amend('add-more', '1900', '0.12')).amendment.clientId, charge.clientId);
  await assert.rejects(amend('add-more', '1900', '0.125'), /EXCHANGE_REVIEW_CHANGED/);
  const reducing = amend('reduce-size', '1900', '0.1');
  const secondAmend = await f.first.command(3);
  f.first.stream.write(
    packet(4, '8', f.execution(secondAmend, { type: '5', status: '5', leaves: '0.1' })),
  );
  assert.equal((await reducing).amendment.authorizedDebit, '0');
  const capacity = (await f.request('list')).grants[0];
  assert.equal(capacity.remaining, '260.572');
  assert.equal(capacity.ordersRemaining, 2);
  await assert.rejects(amend('attempt-refund', '1900', '0.115'), /EXCHANGE_AUTHORITY_BUDGET/);
  await assert.rejects(
    f.request(
      'submitAuthorized',
      {
        side: 'buy',
        postOnly: true,
        price: '2000',
        size: '0.1',
        grantId,
        operationId: 'reduce-size',
      },
      f.rootContext,
    ),
    /EXCHANGE_REVIEW_CHANGED/,
  );
  assert.equal(f.first.commands.length, 4);

  const human = f.confirm(await f.preview('1900', '0.09'));
  const manual = await f.first.command(4);
  f.first.stream.write(
    packet(5, '8', f.execution(manual, { type: '5', status: '5', leaves: '0.09' })),
  );
  assert.equal((await human).fix.currentGrantId, null);
  await assert.rejects(amend('manual-revision', '1900', '0.1'), /EXCHANGE_AUTHORITY_SCOPE/);
});

test('FIX grant amendments require consent and keep an in-flight charge after revocation and restart', async (t) => {
  const submitOnly = await nativeTrading(t, 'sandbox', { allowAmend: false });
  await assert.rejects(
    submitOnly.request(
      'amendAuthorized',
      {
        orderId: submitOnly.order.clientId,
        grantId: submitOnly.grant.grantId,
        operationId: 'submit-only',
        price: '2000',
        size: '0.11',
      },
      submitOnly.rootContext,
    ),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  assert.equal(submitOnly.first.commands.length, 2);

  const f = await nativeTrading(t, 'live', {});
  const grantId = f.grant.grantId;
  const input = {
    orderId: f.order.clientId,
    grantId,
    operationId: 'in-flight',
    price: '2000',
    size: '0.11',
  };
  const pending = f.request('amendAuthorized', input, f.rootContext);
  const wire = await f.first.command(2);
  assert.equal((await f.request('list')).grants[0].remaining, '278.68');
  await f.request('revokeAuthority', { grantId });
  const stopped = await pending;
  assert.equal(stopped.error, 'EXCHANGE_AUTHORITY_INACTIVE');
  assert.equal(stopped.amendment.outcome, 'unknown');
  f.restart();
  assert.equal(
    (await f.request('amendAuthorized', input, f.rootContext)).amendment.clientId,
    wire.get(11),
  );
  f.execution(wire, { type: '5', status: '5', leaves: '0.11' });
  assert.equal((await f.request('reconcile', { orderId: f.order.clientId })).size, '0.11');
  assert.equal((await f.request('list')).grants[0].status, 'authorityRevoked');
  assert.equal((await f.request('list')).grants[0].remaining, '278.68');
  const newGrant = await f.authorize();
  await assert.rejects(
    f.request(
      'amendAuthorized',
      { ...input, grantId: newGrant.grantId, operationId: 'other-grant', size: '0.12' },
      f.rootContext,
    ),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  assert.equal(f.f.venues.length, 1);
});

test('FIX grant revocation can stop a new submission waiting for reconnection without spending', async (t) => {
  const f = await nativeTrading(t, 'live', {});
  await f.request('fixDisconnect');
  const approval = f.grant.grantId;
  const stopped = assert.rejects(
    f.request(
      'submitAuthorized',
      {
        operationId: 'waits-for-fix',
        grantId: approval,
        side: 'buy',
        postOnly: true,
        price: '2000',
        size: '0.1',
      },
      f.rootContext,
    ),
    /EXCHANGE_AUTHORITY_INACTIVE/,
  );
  const reconnect = await until(() => f.f.venues[1]);
  assert.equal((await reconnect.command(0)).get(35), 'A');
  await f.request('revokeAuthority', { grantId: approval });
  await stopped;
  assert.equal(reconnect.commands.length, 1);
  const page = await f.request('list');
  assert.equal(page.items.length, 1);
  assert.equal(page.grants[0].remaining, '298.8');
  assert.equal(page.grants[0].ordersRemaining, 4);
});

test('authorized native FIX cancellation reserves a separate slot and verifies the exact response', async (t) => {
  const f = await nativeTrading(t, 'sandbox', { maxOrders: 1, maxCancels: 1 });
  const input = {
    orderId: f.order.clientId,
    grantId: f.grant.grantId,
    operationId: 'cancel-native',
  };
  const cancel = (extra = {}) =>
    f.request('cancelAuthorized', { ...input, ...extra }, f.rootContext);
  const page = await f.request('list', {}, f.rootContext);
  assert.equal(page.grants[0].ordersRemaining, 0);
  assert.equal(page.grants[0].cancelsRemaining, 1);
  assert.equal(page.items[0].cancelAvailable, true);
  assert.equal(page.items[0].amendmentAvailable, false);
  await assert.rejects(f.request('cancelAuthorized', input), /EXCHANGE_AGENT_REQUIRED/);
  await assert.rejects(cancel({ operationId: f.order.operationId }), /EXCHANGE_REVIEW_CHANGED/);
  const pending = cancel();
  const wire = await f.first.command(2);
  const persisted = f.disk().orders[0];
  assert.equal(persisted.status, 'canceling');
  assert.deepEqual(
    [35, 11, 37, 41, 55].map((tag) => wire.get(tag)),
    ['F', persisted.cancellations[0].clientId, f.order.venueId, f.order.fix.clientId, 'ETH-USD'],
  );
  assert.equal((await f.request('list')).grants[0].cancelsRemaining, 0);
  const fields = [
    [37, f.order.venueId],
    [17, randomUUID()],
    [150, '4'],
    [39, '4'],
    [55, 'ETH-USD'],
    [14, '0.025'],
    [151, '0'],
  ];
  f.first.stream.write(packet(3, '8', [[11, f.order.fix.clientId], ...fields]));
  assert.equal((await f.getOrder()).status, 'cancel-unknown');
  f.first.stream.write(packet(4, '8', [[11, wire.get(11)], ...fields]));
  const result = await pending;
  assert.equal(result.status, 'canceled');
  assert.equal(result.filledSize, '0.025');
  assert.equal(result.cancellation.outcome, 'canceled');
  assert.equal(result.fix.clientId, f.order.fix.clientId);
  assert.deepEqual(f.cancels, []);
  f.restart();
  assert.deepEqual((await cancel()).cancellation, result.cancellation);
  await assert.rejects(cancel({ operationId: 'second-cancel' }), /EXCHANGE_CANCEL_BUDGET/);
  const grant = (await f.request('list')).grants[0];
  assert.equal(grant.remaining, '298.8');
  assert.equal(grant.status, 'authorityExhausted');
});

test('an interrupted FIX cancellation keeps its slot and awaits a terminal order after restart', async (t) => {
  const f = await nativeTrading(t, 'live', { maxCancels: 2 });
  const input = {
    orderId: f.order.clientId,
    grantId: f.grant.grantId,
    operationId: 'cancel-interrupted',
  };
  const cancel = (extra = {}) =>
    f.request('cancelAuthorized', { ...input, ...extra }, f.rootContext);
  await f.request('fixDisconnect');
  const task = cancel();
  const resumed = await until(() => f.f.venues[1]);
  assert.equal((await resumed.command(0)).get(141), 'N');
  resumed.stream.write(
    Buffer.concat([
      packet(1, 'A'),
      packet(2, '4', [
        [123, 'Y'],
        [36, '3'],
      ]),
    ]),
  );
  const wire = await resumed.command(1);
  assert.equal(wire.get(35), 'F');
  assert.equal(wire.get(37), f.order.venueId);
  await f.request('revokeAuthority', { grantId: input.grantId });
  assert.equal((await task).error, 'EXCHANGE_AUTHORITY_INACTIVE');
  f.restart();
  assert.equal((await cancel()).cancellation.clientId, wire.get(11));
  assert.equal((await cancel()).cancellation.outcome, 'unknown');
  let checked = await f.request('reconcile', { orderId: input.orderId });
  assert.equal(checked.status, 'cancel-unknown');
  assert.equal(checked.error, 'EXCHANGE_CANCEL_PENDING');
  assert.equal((await f.getOrder()).cancelAvailable, true, 'Human recovery remains available');
  const nextGrant = await f.authorize({ maxCancels: 2 });
  await assert.rejects(
    cancel({ grantId: nextGrant.grantId, operationId: 'other-grant' }),
    /EXCHANGE_AUTHORITY_SCOPE/,
  );
  Object.assign(f.state.remote, { status: 'done', done_reason: 'canceled' });
  checked = await f.request('reconcile', { orderId: input.orderId });
  assert.equal(checked.cancellations[0].outcome, 'closed');
  assert.equal((await cancel()).cancellation.outcome, 'closed');
  assert.equal(f.f.venues.length, 2);
});
