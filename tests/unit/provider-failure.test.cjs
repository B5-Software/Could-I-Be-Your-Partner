/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerFailure } = require('../../src/main/services/provider-failure');
const {
  fetchLLMWithRetry,
  consumeSSEStream,
  augmentSSEResponse,
} = require('../../src/main/llm-retry');

const ipMessage =
  "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address.";
const refusals = [
  { error: { type: 'FreeTierError', message: ipMessage }, reason: 'ip_blocked' },
  {
    error: { type: 'FreeTierError', message: 'Use the official client' },
    reason: 'client_restricted',
  },
  {
    error: { type: 'RegionError', message: 'This model is not available in your country' },
    reason: 'region_restricted',
  },
];

test('access restrictions preserve their message and distinguish IP, client and region decisions', () => {
  for (const { error, reason } of refusals) {
    for (const raw of [{ error }, JSON.stringify({ error })]) {
      const result = providerFailure(raw, { status: 403, kind: 'auth' });
      assert.equal(result.error, error.message);
      assert.equal(result.reason, reason);
      assert.equal(result.kind, 'provider-policy');
      assert.equal(result.retryable, false);
      assert.equal(result.status, 403);
    }
  }
  assert.equal(providerFailure(ipMessage).reason, 'ip_blocked');
  assert.deepEqual(providerFailure('', { status: 403, kind: 'auth' }), {
    ok: false,
    error: 'HTTP 403',
    status: 403,
    kind: 'auth',
  });
  const transient = providerFailure(
    { error: { message: 'Too many requests' } },
    { kind: 'rate_limit' },
  );
  assert.equal(transient.kind, 'rate_limit');
  assert.equal(transient.retryable, undefined);
  assert.equal(transient.reason, undefined);
});

test('HTTP gateway refusals stop after one request even when returned as retryable status codes', async (t) => {
  const requests = [];
  const server = require('node:http').createServer((request, response) => {
    requests.push(request.url);
    response.statusCode = Number(request.url.slice(1));
    response.end(response.statusCode === 403 ? ipMessage : JSON.stringify(refusals[0]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  for (const status of [403, 429, 503]) {
    const notices = [];
    const result = await fetchLLMWithRetry({
      apiUrl: `http://127.0.0.1:${server.address().port}/${status}`,
      body: { model: 'free-fixture', messages: [] },
      options: { maxRetries: 3, timeoutMs: 1000 },
      onRetry: (event) => notices.push(event),
    });
    assert.equal(result.error, ipMessage);
    assert.equal(result.status, status);
    assert.equal(result.kind, 'provider-policy');
    assert.equal(result.reason, 'ip_blocked');
    assert.equal(notices.length, 0);
  }
  assert.deepEqual(requests, ['/403', '/429', '/503']);
});

test('restrictions survive JSON, streamed SSE and SSE aggregation for non-streaming callers', async () => {
  for (const { error, reason } of refusals) {
    const event = { type: 'error', error };
    const sse = 'data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n';
    for (const body of [JSON.stringify(event), sse]) {
      const result = await consumeSSEStream(new Response(body).body, null, 'fixture');
      assert.equal(result.error, error.message);
      assert.equal(result.kind, 'provider-policy');
      assert.equal(result.reason, reason);
      assert.equal(result.retryable, false);
    }
    const response = augmentSSEResponse(new Response(sse), 'openai');
    const result = providerFailure(await response.json());
    assert.equal(result.error, error.message);
    assert.equal(result.reason, reason);
    assert.equal(result.retryable, false);
  }
});

test('shared chat, streaming, summary and probe handlers retain terminal refusal metadata', async () => {
  const path = require('node:path');
  const handlers = new Map();
  let released = 0;
  const event = { type: 'error', error: refusals[0].error };
  const sse = 'data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n';
  require('../../src/main/ipc/llm')({
    path,
    dataDir: require('node:os').tmpdir(),
    fs: require('node:fs'),
    loadJSON: () => ({ data: {}, fetchedAt: Date.now() }),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getSettings: () => ({
      llm: {
        provider: 'openai',
        apiUrl: 'https://fixture.invalid/v1/chat/completions',
        model: 'fixture',
      },
      budget: {},
    }),
    LLMProviders: require('../../src/main/llm-providers'),
    logTs: () => '',
    maskLogUrl: (value) => value,
    normalizeMessagesForThinking: (messages) => messages,
    resetDailyUsageIfNeeded() {},
    checkBudgetExceeded: () => ({ exceeded: false }),
    recordTokenUsage() {
      assert.fail('a refusal must not record estimated usage');
    },
    persistSettings() {},
    publishEvent() {},
    consumeSSEStream,
    fetchLLMWithRetry: async () => ({
      ok: true,
      response: augmentSSEResponse(new Response(sse), 'openai'),
      releaseController() {
        released++;
      },
    }),
  });
  for (const name of ['llm:chat', 'llm:chatStream', 'llm:summarize', 'llm:probe']) {
    const result = await handlers.get(name)(
      {},
      name === 'llm:probe'
        ? {
            provider: 'openai',
            apiUrl: 'https://fixture.invalid/v1/chat/completions',
            model: 'fixture',
          }
        : [{ role: 'user', content: 'Keep the message' }],
    );
    assert.equal(result.error, ipMessage, name);
    assert.equal(result.kind, 'provider-policy', name);
    assert.equal(result.reason, 'ip_blocked', name);
    assert.equal(result.retryable, false, name);
  }
  assert.equal(released, 4);
});
