const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../../src/main/services/model-pricing');
const policy = require('../../src/shared/token-policy');
const providers = require('../../src/main/llm-providers');
const { consumeSSEStream, aggregateSSEToJSON } = require('../../src/main/llm-retry');
const catalog = {
  openai: {
    api: 'https://api.openai.com/v1',
    models: { model: { cost: { input: 2, output: 8, cache_read: 0.5 } } },
  },
  opencode: { models: { model: { cost: { input: 3, output: 9 } } } },
  deepseek: {
    api: 'https://api.deepseek.com',
    models: { model: { cost: { input: 1, output: 4 } } },
  },
};
test('provider prices merge field overrides, including zero, without borrowing gateway prices', () => {
  pricing.update(catalog, 123);
  const result = pricing.resolve('model', 'chatgpt-codex', {
    inputPerM: 0,
    outputPerM: '',
    cacheReadPerM: 0.1,
  });
  assert.deepEqual(result.price, {
    inputPerM: 0,
    outputPerM: 8,
    cacheReadPerM: 0.1,
    cacheWritePerM: 2,
    hasCacheWrite: false,
  });
  assert.equal(result.billingMode, 'subscription');
  assert.equal(result.apiReference, true);
  assert.equal(result.fetchedAt, 123);
  assert.equal(pricing.resolve('model', 'opencode-zen').price.inputPerM, 3);
  assert.equal(
    pricing.resolve(
      'model',
      'openai-compat',
      {},
      undefined,
      'https://api.deepseek.com/v1/chat/completions',
    ).price.inputPerM,
    1,
  );
  assert.equal(
    pricing.resolve('model', 'openai-compat', {}, undefined, 'https://custom.invalid/v1').source,
    'unknown',
  );
  assert.equal(pricing.resolve('absent', 'openai-compat').source, 'unknown');
  assert.equal(pricing.resolve('model', 'chatgpt-codex', { inputPerM: '' }).source, 'models.dev');
});
test('subscription tokens count toward token limits but not API dollar spending', () => {
  pricing.update(catalog);
  const settings = {
    llm: { provider: 'chatgpt-codex', model: 'model', dailyTokensUsed: 0, usageHistory: {} },
    budget: { models: { model: { inputPerM: 999, outputPerM: 999 } }, timezone: 'UTC' },
  };
  const budget = require('../../src/main/services/budget')({
    getSettings: () => settings,
    calculateTokenCost: require('../../src/shared/generated/pricing.cjs').calculateTokenCost,
  });
  budget.recordTokenUsage(
    {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      billingMode: 'subscription',
    },
    'model',
    'chatgpt-codex',
  );
  assert.equal(settings.llm.dailyTokensUsed, 1200);
  assert.equal(Object.values(settings.llm.usageHistory)[0].costUSD, 0);
});
test('free channel caps prevent applying upstream million-token windows and reserve input capacity', () => {
  const result = policy.resolve({
    llm: {
      provider: 'opencode-zen',
      model: 'deepseek-v4-flash-free',
      maxContextLength: 1000000,
      maxResponseTokens: 50000,
      providerLimits: { free: true, context: 200000, input: 160000, output: 32000 },
    },
  });
  assert.equal(result.contextTokens, 200000);
  assert.equal(result.inputTokens, 160000);
  assert.equal(result.outputTokens, 32000);
  assert.equal(
    policy.resolve({ llm: { provider: 'opencode-go', model: 'model', maxContextLength: 1000000 } })
      .contextTokens,
    1000000,
  );
  assert.equal(
    policy.resolve({
      llm: {
        provider: 'opencode-zen',
        model: 'paid-free',
        maxContextLength: 1000000,
        providerLimits: { free: false },
      },
    }).contextTokens,
    1000000,
  );
});
test('subscription request is fixed to the authorized route and uses namespaced client tools', () => {
  const req = providers.buildLLMRequest(
    {
      provider: 'chatgpt-codex',
      model: 'model',
      apiUrl: 'https://custom.invalid',
      apiKey: 'must-not-leak',
      customHeaders: [{ name: 'Authorization', value: 'wrong' }],
    },
    {
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call', function: { name: 'readFile', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call', content: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'readFile', parameters: { type: 'object', properties: {} } },
        },
      ],
      max_tokens: 100,
      temperature: 0.7,
      tool_choice: 'auto',
    },
  );
  assert.equal(req.url, 'https://api.openai.com/v1/responses');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.store, false);
  assert.equal(req.body.max_output_tokens, undefined);
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.tool_choice, 'auto');
  assert.equal(req.body.tools[0].type, 'namespace');
  assert.equal(req.body.tools[0].tools[0].name, 'readFile');
  assert.equal(
    req.body.input.find((item) => item.type === 'function_call_output').namespace,
    'cibyp',
  );
  assert.doesNotMatch(JSON.stringify(req), /must-not-leak|wrong|custom.invalid/);
});
test('subscription streams require completion and surface errors arriving after text', async () => {
  const sse = (events) => events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  const delta = { type: 'response.output_text.delta', delta: 'partial' };
  for (const events of [
    [delta],
    [delta, { type: 'response.failed', response: { error: { message: 'quota exhausted' } } }],
    [{ type: 'response.completed', response: { status: 'incomplete' } }],
  ]) {
    const data = sse(events);
    assert.ok(aggregateSSEToJSON(data, 'responses', true).error);
    const result = await consumeSSEStream(
      new Response(data).body,
      () => {},
      'fixture',
      'responses',
      1000,
      { requiresCompleted: true },
    );
    assert.ok(result.error);
  }
  const result = await consumeSSEStream(
    new Response(sse([delta, { type: 'response.completed', response: { status: 'completed' } }]))
      .body,
    () => {},
    'fixture',
    'responses',
    1000,
    { requiresCompleted: true },
  );
  assert.equal(result.content, 'partial');
  assert.equal(result.error, undefined);
});
