const test = require('node:test');
const assert = require('node:assert/strict');
const {
  augmentSSEResponse,
  consumeSSEStream,
  aggregateSSEToJSON,
  fetchLLMWithRetry,
} = require('../../src/main/llm-retry');
const providers = require('../../src/main/llm-providers');
const completion = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'Hello',
        reasoning_content: 'Readable reasoning',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};
const completed = {
  type: 'response.completed',
  response: {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
};
const sse = (event) => 'event: ' + event.type + '\r\ndata:' + JSON.stringify(event) + '\r\n\r\n';
function fragmented(text) {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(index, ++index));
    },
  });
}
test('non-streaming callers aggregate subscription SSE even with missing or JSON content-type', async () => {
  for (const type of ['application/json', 'application/octet-stream', 'text/event-stream']) {
    const response = augmentSSEResponse(
      new Response('\ufeff' + sse(completed), { headers: { 'Content-Type': type } }),
      'responses',
      true,
    );
    const [a, b] = await Promise.all([response.json(), response.json()]);
    assert.equal(a, b);
    assert.equal(providers.parseLLMResponse(a, 'responses').choices[0].message.content, 'Hello');
  }
  assert.deepEqual(
    await augmentSSEResponse(new Response(JSON.stringify(completion)), 'openai').json(),
    completion,
  );
});
test('stream parser handles CRLF, no-space data, multi-line data, Unicode and fragmented boundaries', async () => {
  const text =
    ': heartbeat\r\n\r\n' +
    'data:{"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"哈"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"哈"},"finish_reason":"stop"}]}\n\n' +
    'data:[DONE]\r\n\r\n';
  const chunks = [];
  const result = await consumeSSEStream(
    fragmented(text),
    (chunk) => chunks.push(chunk.content || ''),
    'fixture',
  );
  assert.equal(result.error, undefined);
  assert.equal(result.content, '你好哈哈');
  assert.equal(chunks.join(''), result.content);
  assert.equal(aggregateSSEToJSON(text).choices[0].message.content, result.content);
});
test('providers returning JSON to streaming calls preserve text, tools, reasoning and usage', async () => {
  for (const [transport, raw] of [
    ['openai', completion],
    ['responses', completed.response],
    [
      'anthropic',
      {
        type: 'message',
        content: [
          { type: 'thinking', thinking: 'Readable reasoning', signature: 'signature' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    ],
  ]) {
    const chunks = [];
    const result = await consumeSSEStream(
      fragmented(JSON.stringify(raw)),
      (chunk) => chunks.push(chunk),
      'fixture',
      transport,
      1000,
      { requiresCompleted: transport === 'responses' },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.content, 'Hello');
    assert.equal(chunks[0].content, 'Hello');
    assert.equal(result.usage.prompt_tokens, 10);
    if (transport !== 'responses') {
      assert.equal(result.reasoning, 'Readable reasoning');
      assert.equal(result.toolCalls[0].function.name, 'read');
    }
  }
});
test('malformed, empty and unsuccessful streams produce visible errors instead of silent empty answers', async () => {
  for (const body of [
    '',
    '<html>bad gateway</html>',
    'data: not-json\n\n',
    '{"error":{"message":"quota exhausted"}}',
    sse({ type: 'error', message: 'quota exhausted' }),
    sse({ type: 'response.failed', response: { error: { message: 'quota exhausted' } } }),
  ]) {
    const result = await consumeSSEStream(
      new Response(body).body,
      null,
      'fixture',
      'responses',
      1000,
      { requiresCompleted: true },
    );
    assert.ok(result.error);
  }
  assert.ok(
    (
      await consumeSSEStream(
        new Response('{"status":"in_progress"}').body,
        null,
        'fixture',
        'responses',
        1000,
        { requiresCompleted: true },
      )
    ).error,
  );
});
test('actual host fetch retry wrapper delivers mislabeled subscription event streams', async (t) => {
  const server = require('node:http').createServer((request, response) => {
    assert.equal(request.url, '/v1/responses');
    response.setHeader('Content-Type', 'application/json');
    response.end(sse(completed));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await fetchLLMWithRetry({
    apiUrl: `http://127.0.0.1:${server.address().port}/v1/responses`,
    body: { stream: true },
    transport: 'responses',
    strictResponses: true,
    options: { timeoutMs: 1000, maxRetries: 1 },
  });
  try {
    assert.equal(result.ok, true);
    assert.equal((await result.response.json()).status, 'completed');
  } finally {
    result.releaseController?.();
  }
});
