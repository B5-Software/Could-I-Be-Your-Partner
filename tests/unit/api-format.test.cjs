const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApiFormatDetector, candidates } = require('../../src/main/services/api-format');
const providers = require('../../src/main/llm-providers');
test('format detection sends the matching body and headers, caches success and never retries auth failures', async () => {
  const requests = [];
  const detector = new ApiFormatDetector({
    providers,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return url.endsWith('/messages')
        ? new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'OK' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          )
        : new Response('{}', { status: 404 });
    },
  });
  const result = await detector.detect({
    apiUrl: 'https://example.test/v1',
    model: 'test',
    apiKey: 'test-key',
  });
  assert.equal(result.provider, 'anthropic-compat');
  assert.equal(requests.at(-1).headers['x-api-key'], 'test-key');
  assert.ok(requests.at(-1).body.messages);
  await detector.detect({ apiUrl: 'https://example.test/v1', model: 'test', apiKey: 'test-key' });
  assert.equal(requests.length, 3);
  let count = 0;
  const unauthorized = new ApiFormatDetector({
    providers,
    fetchImpl: async () => {
      count++;
      return new Response('{}', { status: 401 });
    },
  });
  assert.equal(
    (await unauthorized.detect({ apiUrl: 'https://example.test', model: 'test' })).status,
    401,
  );
  assert.equal(count, 1);
  assert.equal(candidates('https://example.test/v1/responses')[0].provider, 'openai-responses');
});
