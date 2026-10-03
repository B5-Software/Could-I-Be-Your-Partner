const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const register = require('../../src/main/mcp-service');

test('MCP connection progress, CRLF SSE, concurrent connects, cancellation, timeouts and cyclic pagination settle without stale connections', async () => {
  const handlers = new Map(),
    stages = [],
    counts = {};
  let closedStreams = 0;
  const settings = { mcp: { servers: [] } };
  const init = {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: '中文', version: '1' },
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    const route = req.url;
    counts[route + ':' + message.method] = (counts[route + ':' + message.method] || 0) + 1;
    if (route === '/hang' && message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\r\n\r\n');
      return;
    }
    if (message.id === undefined) {
      await new Promise((r) => setTimeout(r, 20));
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? init
        : { tools: [], ...(route === '/cycle' ? { nextCursor: 'same' } : {}) };
    if (['/sse', '/open-sse', '/invalid-sse'].includes(route)) {
      await new Promise((r) => setTimeout(r, 30));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = Buffer.from(
        'data: ' +
          JSON.stringify({
            jsonrpc: route === '/invalid-sse' ? '1.0' : '2.0',
            id: message.id,
            result,
          }) +
          '\r\n\r\n',
      );
      if (route === '/open-sse') res.on('close', () => closedStreams++);
      res.write(body.subarray(0, 40));
      if (route === '/open-sse') res.write(body.subarray(40));
      else res.end(body.subarray(40));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const service = register({
    ipcMain: { handle: (c, h) => handlers.set(c, h) },
    getSettings: () => settings,
    persist() {},
    appVersion: 'test',
    notifyRenderer() {
      if (handlers.has('mcp:listServers'))
        stages.push(
          handlers
            .get('mcp:listServers')()
            .map((s) => s.stage),
        );
    },
  });
  const call = (name, ...args) => handlers.get('mcp:' + name)({}, ...args);
  const add = (name, route, extra = {}) =>
    call('addServer', {
      name,
      type: 'http',
      url: `http://127.0.0.1:${server.address().port}/${route}`,
      ...extra,
    });
  const until = async (predicate) => {
    const end = Date.now() + 2000;
    while (!(await predicate())) {
      assert.ok(Date.now() < end, 'condition timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    await add('sse', 'sse');
    const [one, two] = await Promise.all([call('connect', 'sse'), call('connect', 'sse')]);
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.equal(counts['/sse:initialize'], 1);
    assert.ok(
      ['starting', 'initialize', 'initialized', 'tools', 'connected'].every((stage) =>
        stages.flat().includes(stage),
      ),
    );
    await add('open-sse', 'open-sse');
    assert.equal((await call('connect', 'open-sse')).ok, true);
    await until(() => closedStreams === 2);
    await add('invalid-sse', 'invalid-sse');
    assert.equal((await call('connect', 'invalid-sse')).ok, false);
    assert.match(
      (await call('listServers')).find((s) => s.name === 'invalid-sse').error,
      /Invalid.*JSON-RPC/,
    );
    await add('cancel', 'hang');
    const pending = call('connect', 'cancel');
    await until(() => counts['/hang:initialize'] === 1);
    await call('disconnect', 'cancel');
    assert.equal((await pending).ok, false);
    assert.equal(
      (await call('listServers')).find((s) => s.name === 'cancel').status,
      'disconnected',
    );
    await add('timeout', 'hang', { connectTimeoutMs: 1000 });
    assert.equal((await call('connect', 'timeout')).ok, false);
    const failure = (await call('listServers')).find((s) => s.name === 'timeout');
    assert.equal(failure.status, 'error');
    assert.match(failure.error, /timed out/);
    await add('cycle', 'cycle');
    assert.equal((await call('connect', 'cycle')).ok, false);
    assert.match((await call('listServers')).find((s) => s.name === 'cycle').error, /pagination/);
    await call('addServer', {
      name: 'missing-executable',
      command: 'cibyp-mcp-test-command-does-not-exist',
    });
    assert.equal((await call('connect', 'missing-executable')).ok, false);
    assert.match(
      (await call('listServers')).find((s) => s.name === 'missing-executable').error,
      /ENOENT/,
    );
  } finally {
    await service.stopAllMcpServers();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('MCP edits validate, preserve configuration and reconnect live HTTP tools with the new name, endpoint and headers', async () => {
  const requests = [],
    handlers = new Map(),
    changes = [];
  let persisted = 0;
  let deletionGate, deletionStarted, releaseDeletion;
  const settings = { mcp: { servers: [] } };
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, token: req.headers.authorization });
    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'DELETE') {
      deletionStarted?.();
      if (deletionGate) await deletionGate;
      res.writeHead(200).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (!message.id) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: req.url, version: '1' },
          }
        : { tools: [{ name: req.url.slice(1), inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const service = register({
    ipcMain: { handle: (c, h) => handlers.set(c, h) },
    getSettings: () => settings,
    persist: () => persisted++,
    notifyRenderer: (e) => changes.push(e),
    appVersion: 'test',
  });
  const call = (channel, ...args) => handlers.get('mcp:' + channel)({}, ...args);
  const url = (route) => `http://127.0.0.1:${server.address().port}/${route}`;
  try {
    assert.equal(
      (
        await call('addServer', {
          name: 'old',
          type: 'http',
          url: url('old'),
          headers: { Authorization: 'old-token' },
          custom: 'preserve',
        })
      ).ok,
      true,
    );
    assert.equal((await call('connect', 'old')).ok, true);
    assert.equal((await call('addServer', { name: 'duplicate', command: 'node' })).ok, true);
    for (const patch of [
      { name: 'duplicate' },
      { args: {} },
      { headers: { Authorization: 12 } },
      { type: 'http', url: 'file:///bad' },
    ]) {
      assert.equal((await call('updateServer', 'old', patch)).ok, false);
      assert.equal((await call('listServers')).find((s) => s.name === 'old').status, 'connected');
    }
    const saved = await call('updateServer', 'old', {
      name: 'new',
      url: url('new'),
      headers: { Authorization: 'new-token' },
      autoConnect: true,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.connected, true);
    assert.equal(settings.mcp.servers[0].custom, 'preserve');
    assert.equal(settings.mcp.servers[0].autoConnect, true);
    assert.equal(
      (await call('listServers')).some((s) => s.name === 'old'),
      false,
    );
    assert.deepEqual(
      (await call('listTools')).tools.map((t) => [t.name, t.serverName]),
      [['new', 'new']],
    );
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.url === '/old'));
    assert.ok(requests.some((r) => r.url === '/new' && r.token === 'new-token'));
    assert.equal(
      (await call('updateServer', 'duplicate', { command: 'other', env: { TEST: 'yes' } }))
        .reconnected,
      false,
    );
    assert.equal(
      (await call('listServers')).find((s) => s.name === 'duplicate').status,
      'disconnected',
    );
    assert.equal(persisted, 4);
    assert.ok(changes.length >= 4);
    const started = new Promise((resolve) => {
      deletionStarted = resolve;
    });
    deletionGate = new Promise((resolve) => {
      releaseDeletion = resolve;
    });
    const editing = call('updateServer', 'new', { name: 'should-not-reappear' });
    await started;
    const removing = call('removeServer', 'new');
    assert.equal(
      settings.mcp.servers.some((s) => s.name === 'new'),
      false,
    );
    releaseDeletion();
    assert.equal((await removing).ok, true);
    assert.equal((await editing).ok, false);
    assert.deepEqual(
      settings.mcp.servers.map((s) => s.name),
      ['duplicate'],
    );
  } finally {
    releaseDeletion?.();
    await service.stopAllMcpServers();
    await new Promise((resolve) => server.close(resolve));
  }
});
