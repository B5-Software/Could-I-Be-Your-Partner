/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const proxy = require('../../src/main/net-proxy');

test('privacy fails closed, ignores ordinary bypass rules and preserves local backend access', async (t) => {
  t.after(() => proxy._test.resetForTest());
  await proxy.setConfig({ mode: 'none', bypass: '*.example.com' });
  proxy.setPrivacy({ enabled: true });
  await assert.rejects(proxy.getDispatcher('https://api.example.com/v1'), {
    code: 'CIBYP_PRIVACY_UNAVAILABLE',
  });
  assert.equal(await proxy.getDispatcher('http://127.0.0.1:1234'), undefined);
  assert.equal(await proxy.getDispatcher('http://[::1]:1234'), undefined);
  proxy.setPrivacy({ enabled: true, phase: 'ready', socksUrl: 'http://127.0.0.1:1234' });
  await assert.rejects(proxy.getDispatcher('https://api.example.com'), {
    code: 'CIBYP_PRIVACY_UNAVAILABLE',
  });
  proxy.setPrivacy({ enabled: false });
  assert.equal(await proxy.getDispatcher('https://api.example.com'), undefined);
  await assert.rejects(
    proxy.fetchTorRuntime('https://untrusted.invalid/runtime.tar.gz'),
    /Unexpected Tor/,
  );
});

test('host fetch and the real OpenCode SDK use SOCKS remote DNS and cannot override privacy routing', async (t) => {
  const destinations = [],
    sockets = new Set();
  const http = require('node:http');
  const local = http.createServer((req, res) => {
    if (req.url === '/away') {
      res.writeHead(302, { Location: 'http://redirect-privacy-fixture.invalid/file' });
      res.end();
    } else res.end('local-backend');
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localUrl = 'http://127.0.0.1:' + local.address().port;
  t.after(() => {
    local.closeAllConnections();
    local.close();
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0),
      phase = 'hello';
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 'hello') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5);
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        phase = 'connect';
      }
      if (phase === 'connect') {
        if (buffer.length < 5) return;
        assert.equal(buffer[3], 3, 'SOCKS must receive the hostname, without local DNS resolution');
        const length = buffer[4];
        if (buffer.length < 7 + length) return;
        destinations.push(buffer.subarray(5, 5 + length).toString());
        buffer = buffer.subarray(7 + length);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        phase = 'http';
      }
      if (phase === 'http' && buffer.includes(Buffer.from('\r\n\r\n'))) {
        const head = buffer.toString();
        if (head.startsWith('GET /return-local ')) {
          socket.end(
            'HTTP/1.1 302 Found\r\nLocation: ' +
              localUrl +
              '/local\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
          );
          phase = 'done';
          return;
        }
        const body = head.startsWith('POST')
          ? 'data: {"choices":[{"index":0,"delta":{"content":"Private SDK"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
          : 'through-tor';
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: ' +
            (head.startsWith('POST') ? 'text/event-stream' : 'text/plain') +
            '\r\nContent-Length: ' +
            Buffer.byteLength(body) +
            '\r\nConnection: close\r\n\r\n' +
            body,
        );
        phase = 'done';
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    proxy._test.resetForTest();
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  await proxy.setConfig({ mode: 'none', bypass: '*.invalid' });
  proxy.setPrivacy({
    enabled: true,
    phase: 'ready',
    socksUrl: `socks5://127.0.0.1:${server.address().port}`,
  });
  proxy.install();
  const direct = new (require('undici').Agent)();
  t.after(() => direct.close());
  const response = await fetch('http://privacy-fixture.invalid/file', { dispatcher: direct });
  assert.equal(await response.text(), 'through-tor');
  const { fetchOpenCode } = require('../../src/main/services/opencode-ai-transport');
  const result = await fetchOpenCode(
    {
      url: 'http://sdk-privacy-fixture.invalid/v1/chat/completions',
      headers: {},
      opencodeSdk: { protocol: 'openai', body: {} },
      body: { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] },
    },
    { timeoutMs: 5000 },
  );
  try {
    assert.equal((await result.response.json()).choices[0].message.content, 'Private SDK');
  } finally {
    result.releaseController?.();
  }
  assert.deepEqual(destinations, ['privacy-fixture.invalid', 'sdk-privacy-fixture.invalid']);
  assert.equal(await (await fetch(localUrl + '/away')).text(), 'through-tor');
  assert.equal(
    await (await fetch('http://privacy-fixture.invalid/return-local')).text(),
    'local-backend',
  );
  assert.deepEqual(destinations.slice(2), [
    'redirect-privacy-fixture.invalid',
    'privacy-fixture.invalid',
  ]);
  proxy.setPrivacy({ enabled: true, phase: 'stopped' });
  await assert.rejects(fetch('http://privacy-fixture.invalid/blocked'), {
    code: 'CIBYP_PRIVACY_UNAVAILABLE',
  });
  await assert.rejects(fetch(localUrl + '/away'), { code: 'CIBYP_PRIVACY_UNAVAILABLE' });
  assert.equal(destinations.length, 4);
  const blocked = await fetchOpenCode(
    {
      url: 'http://sdk-privacy-fixture.invalid/v1/chat/completions',
      headers: {},
      opencodeSdk: { protocol: 'openai', body: {} },
      body: { model: 'fixture', messages: [{ role: 'user', content: 'blocked' }] },
    },
    { timeoutMs: 1000 },
  );
  try {
    const failure = await require('../../src/main/llm-retry').consumeSSEStream(
      blocked.response.body,
      null,
      'privacy-blocked',
    );
    assert.equal(failure.kind, 'privacy');
    assert.equal(failure.retryable, false);
    assert.equal(destinations.length, 4);
  } finally {
    blocked.releaseController?.();
  }
});

test('privacy Tor reuses the runtime but starts no WebUI, onion service or control port', async () => {
  const { EventEmitter } = require('node:events');
  const fs = require('node:fs'),
    path = require('node:path'),
    vm = require('node:vm');
  const filename = path.resolve(__dirname, '../../src/main/services/tor-remote.js');
  const nativeRequire = require('node:module').createRequire(filename);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit('exit', null));
  let config = '',
    readHostname = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    process,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'node:fs/promises')
        return {
          stat: async () => null,
          mkdir: async () => {},
          writeFile: async (_file, value) => {
            config = value;
          },
          readFile: async () => {
            readHostname = true;
            return '';
          },
        };
      if (name === 'node:child_process')
        return {
          spawn() {
            queueMicrotask(() => child.stdout.emit('data', 'Bootstrapped 100% (done): Done\n'));
            return child;
          },
        };
      return nativeRequire(name);
    },
  });
  const tor = new module.exports.TorRemote({
    app: { getPath: () => '/fixture' },
    purpose: 'privacy',
    settings: () => ({}),
    publish() {},
    prepare: async () => '/fixture/runtime',
    allocatePort: async () => 32111,
  });
  await tor.start();
  await tor.operation;
  assert.equal(tor.status().phase, 'ready');
  assert.equal(tor.status().socksUrl, 'socks5://127.0.0.1:32111');
  assert.match(config, /SocksPort 127\.0\.0\.1:32111 IsolateSOCKSAuth/);
  assert.doesNotMatch(config, /HiddenService|ControlPort/);
  assert.equal(readHostname, false);
  tor.stop();
  assert.equal(tor.status().socksUrl, '');
});
