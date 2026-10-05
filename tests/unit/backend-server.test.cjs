/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { BackendServer } = require('../../src/main/core/backend-server');
const { BackendClient } = require('../../src/shared/backend-client');
const { createEventBus } = require('../../src/main/core/event-bus');
const WS = require('ws');

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
