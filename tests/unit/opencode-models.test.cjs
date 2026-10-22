const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichOpenCodeModels } = require('../../src/main/opencode-models');
const headers = require('../../src/main/opencode-headers');
const providers = require('../../src/main/llm-providers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHeaders() {
  const file = require.resolve('../../src/main/opencode-headers');
  delete require.cache[file];
  return require(file);
}

test('native IDs use descending session time and ascending request time, with consistent affinity headers', () => {
  const module = freshHeaders();
  const now = Date.now;
  Date.now = () => 1792103023000;
  try {
    const session = module.canonicalizeSessionId('private-local-conversation');
    const expected = (~(1792103023000n * 0x1000n + 1n) & 0xffffffffffffn).toString(16);
    assert.equal(session.slice(4, 16), expected);
    assert.equal(module.canonicalizeSessionId('private-local-conversation'), session);
    const request = module.makeRequestId();
    assert.equal(
      request.slice(4, 16),
      ((1792103023000n * 0x1000n + 2n) & 0xffffffffffffn).toString(16),
    );
    const out = module.buildOpenCodeHeaders({ sessionKey: 'private-local-conversation' });
    for (const field of [
      'x-opencode-session',
      'x-opencode-session-id',
      'x-session-affinity',
      'X-Session-Id',
    ])
      assert.equal(out[field], session);
  } finally {
    Date.now = now;
  }
});

test('routing IDs survive backend restart without persisting local conversation names', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-oc-sessions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  let module = freshHeaders();
  module.setOpenCodeSessionStore(file);
  const id = module.canonicalizeSessionId('private-conversation-title');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private-conversation-title'));
  module = freshHeaders();
  module.setOpenCodeSessionStore(file);
  assert.equal(module.canonicalizeSessionId('private-conversation-title'), id);
});

test('v1 version caches migrate to the v2 registry and force refresh still works after a warm-cache lookup', async () => {
  const module = freshHeaders(),
    urls = [],
    saved = [];
  module.setOpenCodeVersionStore({
    loadFn: async () => ({ version: '1.19.1', fetchedAt: Date.now() }),
    saveFn: async (version) => saved.push(version),
  });
  const fetch = async (url) => {
    urls.push(url);
    return Response.json({ version: urls.length === 1 ? '2.0.30' : '2.0.31' });
  };
  assert.equal(await module.refreshOpenCodeVersion(fetch), '2.0.30');
  assert.equal(await module.refreshOpenCodeVersion(fetch), null);
  assert.equal(await module.refreshOpenCodeVersion(fetch, { force: true }), '2.0.31');
  assert.deepEqual(saved, ['2.0.30', '2.0.31']);
  assert.ok(urls.every((url) => url.includes('@opencode%2fcli/latest')));
  assert.equal(module.getOpenCodeUserAgent(), 'opencode/latest/2.0.31/cli');
});

test('new inference is keyless for free models and preserves paid credentials in each API family', () => {
  for (const [model, transport, suffix] of [
    ['big-pickle', 'openai', '/openai/v1/chat/completions'],
    ['muse-spark-1.3-contributor-free', 'responses', '/openai/v1/responses'],
    ['claude-sonnet-4-6', 'anthropic', '/anthropic/v1/messages'],
  ]) {
    const req = providers.buildLLMRequest(
      {
        provider: 'opencode-zen',
        model,
        zenApiKey: model.startsWith('claude') ? 'paid-fixture' : 'public',
      },
      { messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(req.url, 'https://opencode.ai/inference' + suffix);
    assert.equal(req.transport, transport);
    assert.equal(
      req.headers.Authorization,
      model.startsWith('claude') ? 'Bearer paid-fixture' : undefined,
    );
  }
});

test('a free-client rejection refreshes an automatic UA once; regional errors and explicit overrides do not', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-oc-probe-'));
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  global.fetch = async () => Response.json({});
  for (const scenario of ['automatic', 'region', 'override', 'policy']) {
    const handlers = new Map(),
      requests = [];
    let version = headers.getOpenCodeVersion(),
      refreshed = 0;
    require('../../src/main/ipc/llm')({
      path,
      dataDir: directory,
      fs,
      loadJSON: () => null,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getSettings: () => ({
        llm: { provider: 'opencode-zen', model: 'mimo-v2.6-flash-free', zenApiKey: '' },
        budget: {},
      }),
      LLMProviders: providers,
      resetDailyUsageIfNeeded() {},
      checkBudgetExceeded: () => ({ exceeded: false }),
      recordTokenUsage() {},
      persistSettings() {},
      consumeSSEStream: async () => ({ content: 'OK' }),
      ocHeaders: {
        getOpenCodeUserAgent: () => `opencode/latest/${version}/cli`,
        refreshOpenCodeVersion: async () => {
          refreshed++;
          version = '2.0.99';
        },
      },
      fetchLLMWithRetry: async (config) => {
        requests.push({ ...config.headers });
        return requests.length === 1
          ? {
              ok: false,
              status: 403,
              kind: 'auth',
              ...(scenario === 'policy' ? { kind: 'provider-policy', retryable: false } : {}),
              error:
                scenario === 'region'
                  ? 'This model is not available in your country'
                  : "OpenCode's free tier can only be used from within OpenCode.",
            }
          : { ok: true, response: new Response(''), releaseController() {} };
      },
    });
    const result = await handlers.get('llm:probe')(
      {},
      {
        provider: 'opencode-zen',
        model: 'mimo-v2.6-flash-free',
        ...(scenario === 'override'
          ? { customHeaders: [{ name: 'User-Agent', value: 'my-explicit-client' }] }
          : {}),
      },
    );
    assert.equal(refreshed, scenario === 'automatic' ? 1 : 0);
    assert.equal(requests.length, scenario === 'automatic' ? 2 : 1);
    assert.equal(result.ok, scenario === 'automatic');
    if (scenario === 'automatic')
      assert.equal(requests[1]['User-Agent'], 'opencode/latest/2.0.99/cli');
  }
});
test('core tool injection is exclusive to Zen free models, independent of credentials', () => {
  const tools = [
    {
      type: 'function',
      function: { name: 'myTool', parameters: { type: 'object', properties: {} } },
    },
  ];
  const options = { messages: [{ role: 'user', content: 'hi' }], tools, stream: false };
  for (const zenApiKey of ['public', 'real-key']) {
    const free = providers.buildLLMRequest(
      { provider: 'opencode-zen', model: 'big-pickle', zenApiKey },
      options,
    );
    assert.equal(free.zenFree, true);
    assert.equal(free.body.stream, true);
    assert.equal(free.body.tools.length, 7);
  }
  for (const llm of [
    { provider: 'opencode-zen', model: 'deepseek-v4-flash', zenApiKey: 'public' },
    { provider: 'opencode-go', model: 'big-pickle', zenApiKey: 'public' },
    {
      provider: 'openai-compat',
      model: 'big-pickle',
      apiUrl: 'https://example.com/v1/chat/completions',
    },
  ]) {
    const req = providers.buildLLMRequest(llm, options);
    assert.equal(req.zenFree, undefined);
    assert.equal(req.body.stream, false);
    assert.deepEqual(req.body.tools, tools);
  }
  assert.equal(tools.length, 1, 'request adaptation must not mutate caller tools');
});
test('live catalog avoids false free models and enriches capabilities without stale entries', () => {
  const catalog = {
    opencode: {
      models: {
        'mimo-paid': { cost: { input: 1, output: 1 } },
        'big-pickle': { name: 'Pickle', cost: { input: 0, output: 0 }, limit: { context: 200000 } },
        old: { cost: { input: 0, output: 0 } },
      },
    },
  };
  const models = enrichOpenCodeModels(
    [{ id: 'mimo-paid' }, { id: 'big-pickle' }, { id: 'fresh-free' }],
    catalog,
  );
  assert.equal(models.find((model) => model.id === 'mimo-paid').free, false);
  assert.equal(models.find((model) => model.id === 'big-pickle').contextLength, 200000);
  assert.equal(
    models.some((model) => model.id === 'old'),
    false,
  );
  assert.equal(enrichOpenCodeModels([{ id: 'fresh-free' }], catalog, 'go')[0].free, false);
  require('../../src/main/opencode-models').updateOpenCodeCatalog({
    opencode: {
      models: {
        'fake-free': { cost: { input: 1, output: 1 } },
        'zero-cost-model': { cost: { input: 0, output: 0 } },
      },
    },
  });
  const isFree = require('../../src/main/opencode-models').isOpenCodeFreeModel;
  assert.equal(isFree({ provider: 'opencode-zen', model: 'fake-free' }), false);
  assert.equal(isFree({ provider: 'opencode-zen', model: 'zero-cost-model' }), true);
});
test('provider headers auto-configure UA and stable session, preserving case-insensitive overrides', () => {
  const config = {
    url: 'https://opencode.ai/zen/v1/chat/completions',
    sessionKey: 'conversation',
    llm: {},
  };
  const a = headers.applyProviderHeaders(config),
    b = headers.applyProviderHeaders(config);
  assert.match(a['User-Agent'], /^opencode\/latest\/2\.\d+\.\d+\/cli$/);
  assert.equal(a['x-opencode-session'], b['x-opencode-session']);
  assert.notEqual(a['x-opencode-request'], b['x-opencode-request']);
  const custom = headers.applyProviderHeaders({
    ...config,
    headers: { 'User-Agent': 'old' },
    llm: { customHeaders: [{ name: 'user-agent', value: 'custom' }] },
  });
  assert.equal(custom['User-Agent'], undefined);
  assert.equal(custom['user-agent'], 'custom');
  assert.equal(
    headers.applyProviderHeaders({ ...config, url: 'http://opencode.ai' })['User-Agent'],
    undefined,
  );
});
