const { test } = require('node:test');
const assert = require('node:assert/strict');
const TokenUsage = require('../../src/shared/token-usage');
const Providers = require('../../src/main/llm-providers');
const { consumeSSEStream } = require('../../src/main/llm-retry');
const { calculateTokenCost } = require('../../src/shared/generated/pricing.cjs');

test('Anthropic input totals include uncached input, cache reads and cache writes exactly once', () => {
  const native = {
    input_tokens: 100,
    output_tokens: 30,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 200,
  };
  const response = Providers.parseLLMResponse({ content: [], usage: native }, 'anthropic');
  assert.equal(response.usage.prompt_tokens, 1100);
  assert.equal(response.usage.total_tokens, 1130);
  assert.equal(response.usage.prompt_tokens_details.cached_tokens, 800);
  assert.equal(response.usage._cacheReported, true);
  assert.deepEqual(
    TokenUsage.normalize(response.usage),
    response.usage,
    'normalization is idempotent',
  );
  const cost = calculateTokenCost(
    { prompt: response.usage.prompt_tokens, cached: 800, cacheCreation: 200 },
    { inputPerM: 1, cacheReadPerM: 0.1, hasCacheWrite: true, cacheWritePerM: 1.25 },
  );
  assert.ok(Math.abs(cost.totalCost - 0.00043) < 1e-12);
});

test('OpenAI, Responses and DeepSeek report the same measured cache semantics without inflating input', () => {
  for (const [transport, usage] of [
    [
      'openai',
      { prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } },
    ],
    [
      'responses',
      { input_tokens: 1000, output_tokens: 30, input_tokens_details: { cached_tokens: 800 } },
    ],
    [
      'openai',
      {
        prompt_tokens: 1000,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      },
    ],
  ]) {
    const normalized = TokenUsage.normalize(usage, transport);
    assert.equal(normalized.prompt_tokens, 1000);
    assert.equal(normalized.total_tokens, 1030);
    assert.equal(normalized.prompt_tokens_details.cached_tokens, 800);
    assert.equal(normalized._cacheReported, true);
  }
  assert.equal(TokenUsage.normalize({ prompt_tokens: 1000 })._cacheReported, false);
  assert.equal(
    TokenUsage.normalize({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } })
      ._cacheReported,
    true,
    'zero hit is different from absent usage',
  );
  assert.equal(
    TokenUsage.normalize({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 800 },
      _estimated: true,
    })._cacheReported,
    false,
  );
});

test('Anthropic streaming usage merges start and delta before normalizing the actual input and completion', async () => {
  const events = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events)
        controller.enqueue(Buffer.from('data: ' + JSON.stringify(event) + '\n\n'));
      controller.close();
    },
  });
  const result = await consumeSSEStream(stream, null, 'fixture', 'anthropic');
  assert.equal(result.usage.prompt_tokens, 1100);
  assert.equal(result.usage.completion_tokens, 30);
  assert.equal(result.usage.total_tokens, 1130);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 800);
});
