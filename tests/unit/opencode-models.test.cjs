const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichOpenCodeModels } = require('../../src/main/opencode-models');
const headers = require('../../src/main/opencode-headers');
const providers = require('../../src/main/llm-providers');
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
    assert.equal(free.body.tools.length, 6);
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
  assert.match(a['User-Agent'], /^opencode\/\d/);
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
