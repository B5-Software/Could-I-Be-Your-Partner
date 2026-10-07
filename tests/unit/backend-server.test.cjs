/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendServer } = require('../../src/main/core/backend-server');
const { BackendClient } = require('../../src/shared/backend-client');
const { createEventBus } = require('../../src/main/core/event-bus');
const WS = require('ws');
const wire = require('../../src/shared/wire-values');

test('speech stop is acknowledged after the last audio frame has been consumed', async (t) => {
  const order = [],
    token = 'd'.repeat(64);
  const server = new BackendServer({
    eventBus: createEventBus(),
    token,
    dispatch: async ({ args }) => {
      if (args[0] === 'voice:audio') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual([...new Int16Array(args[1].samples)], [100, -100]);
        order.push('audio');
      } else {
        order.push(args[0]);
        return { ok: true };
      }
    },
  });
  const address = await server.start();
  t.after(() => server.stop());
  const socket = new WS(address.url.replace('http:', 'ws:') + '/api/events', {
    headers: { Authorization: 'Bearer ' + token },
  });
  t.after(() => socket.close());
  await new Promise((resolve) => socket.once('open', resolve));
  const ack = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Missing speech acknowledgement')), 3000);
    socket.on('message', (bytes) => {
      const message = JSON.parse(String(bytes));
      if (message.type === 'voice-control-result') {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  socket.send(
    JSON.stringify(
      { type: 'voice-audio', sessionId: 'browser-test', samples: Int16Array.of(100, -100).buffer },
      wire.replacer,
    ),
  );
  socket.send(
    JSON.stringify({
      type: 'voice-control',
      id: 'stop-last-frame',
      sessionId: 'browser-test',
      action: 'stop',
    }),
  );
  assert.equal((await ack).result.ok, true);
  assert.deepEqual(order, ['audio', 'voice:stt:stop']);
});

test('binary RPC values survive serialization and cannot reuse an id with different bytes', async (t) => {
  const token = 'b'.repeat(64);
  const server = new BackendServer({
    eventBus: createEventBus(),
    token,
    dispatch: ({ args }) => args[0],
  });
  const address = await server.start();
  t.after(() => server.stop());
  const client = new BackendClient({ ...address, token });
  const body = { id: 'binary-repeat', method: 'test', args: [Uint8Array.of(0, 255, 20).buffer] };
  const result = await client.http('/api/rpc', body);
  assert.deepEqual([...new Uint8Array(result.result)], [0, 255, 20]);
  await assert.rejects(
    client.http('/api/rpc', { ...body, args: [Uint8Array.of(1, 2, 3).buffer] }),
    /reused/,
  );
  assert.throws(
    () => JSON.parse('{"$cibypBinary":"bad=" , "extra":1}', wire.reviver),
    /Invalid binary/,
  );
});

test('workspace downloads require authentication and dispatch through the selected filesystem', async (t) => {
  const token = 'c'.repeat(64),
    received = [];
  const server = new BackendServer({
    eventBus: createEventBus(),
    token,
    dispatch: ({ args }) => {
      received.push(args);
      return args[1] === '/workspace/missing'
        ? { ok: false, error: 'File missing' }
        : { ok: true, name: "note's (1).txt", bytes: Buffer.from('workspace file') };
    },
  });
  const address = await server.start();
  t.after(() => server.stop());
  const url = address.url + '/api/files/download?path=' + encodeURIComponent('/workspace/note.txt');
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'workspace file');
  assert.deepEqual(received, [['filePicker:download', '/workspace/note.txt']]);
  assert.match(response.headers.get('content-disposition'), /note%27s%20%281%29.txt/);
  assert.equal(
    (
      await fetch(address.url + '/api/files/download?path=/workspace/missing', {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).status,
    400,
  );
});

test('one backend accepts independent clients, authenticates, replays and deduplicates commands', async (t) => {
  const bus = createEventBus();
  let calls = 0;
  const server = new BackendServer({
    eventBus: bus,
    token: 'a'.repeat(64),
    dispatch: async ({ method }) => {
      if (method === 'snapshot') return { sessions: [], views: {}, pid: process.pid };
      if (method === 'sendMessage') {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'done';
      }
      throw new Error('Unknown method');
    },
  });
  const address = await server.start();
  t.after(() => server.stop());
  const unauth = await fetch(address.url + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauth.status, 401);
  const clients = [1, 2].map(
    () =>
      new BackendClient({
        ...address,
        token: 'a'.repeat(64),
        socketFactory: (url, token) =>
          new WS(url, { headers: { Authorization: 'Bearer ' + token } }),
      }),
  );
  t.after(() => clients.forEach((client) => client.close()));
  const snapshots = await Promise.all(clients.map((client) => client.connect()));
  assert.deepEqual(
    snapshots.map((s) => s.pid),
    [process.pid, process.pid],
  );
  const delivered = new Promise((resolve) =>
    clients[1].onEvent((event) => {
      if (event.payload?.value === 42) resolve(event);
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  bus.publish('settings:changed', { value: 42 });
  assert.equal((await delivered).channel, 'settings:changed');
  const body = { id: 'repeat', method: 'sendMessage', args: ['chat', 'hello'] };
  const results = await Promise.all([
    clients[0].http('/api/rpc', body),
    clients[1].http('/api/rpc', body),
  ]);
  assert.deepEqual(results, [{ result: 'done' }, { result: 'done' }]);
  assert.equal(calls, 1);
  await assert.rejects(clients[0].http('/api/rpc', { ...body, args: ['different'] }), /reused/);
  const invalid = await fetch(address.url + '/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + 'a'.repeat(64),
      Origin: 'http://attacker.invalid',
      'X-CIBYP-Client': '1',
    },
    body: JSON.stringify(body),
  });
  assert.equal(invalid.status, 403);
});

test('WebUI serves the actual GUI, never backend sources or a DOM mirror', async (t) => {
  const hash = await require('bcryptjs').hash('webui-test', 4);
  const server = new BackendServer({
    dispatch: () => ({}),
    eventBus: createEventBus(),
    ui: true,
    config: { passwordHash: hash },
  });
  const address = await server.start();
  t.after(() => server.stop());
  const login = await fetch(address.url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'webui-test' }),
  });
  const { token } = await login.json();
  assert.ok(token);
  const headers = { Authorization: 'Bearer ' + token };
  const html = await (
    await fetch(address.url + '/src/renderer/pages/index.html', { headers })
  ).text();
  assert.match(html, /backend-agent.js/);
  assert.match(html, /browser-preload.js/);
  assert.match(html, /id="page-settings"/);
  assert.doesNotMatch(html, /mirror_body|mirror_head/);
  assert.equal((await fetch(address.url + '/src/main/main.js', { headers })).status, 404);
  assert.equal(
    (await fetch(address.url + '/src/main/../../package.json', { headers })).status,
    404,
  );
});
