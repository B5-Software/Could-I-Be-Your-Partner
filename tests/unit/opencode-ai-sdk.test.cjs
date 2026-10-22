/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchOpenCode } = require('../../src/main/services/opencode-ai-transport');
const { consumeSSEStream } = require('../../src/main/llm-retry');
const providers = require('../../src/main/llm-providers');

test('SDK selection preserves CIBYP tools and identity without injecting compatibility tools', () => {
  const tools = [
    {
      type: 'function',
      function: { name: 'fixtureRead', parameters: { type: 'object', properties: {} } },
    },
  ];
  const request = providers.buildLLMRequest(
    { provider: 'opencode-zen', model: 'big-pickle', opencodeTransport: 'sdk' },
    { messages: [{ role: 'user', content: 'hello' }], tools, stream: true },
  );
  assert.equal(request.opencodeSdk.protocol, 'openai');
  assert.deepEqual(request.body.tools, tools);
  assert.match(request.headers['User-Agent'], /^cibyp\//);
  assert.equal(request.zenAutoHeaders, undefined);
  assert.equal(request.headers['x-opencode-session'], undefined);
});

test('real OpenCode AI SDK streams text, reasoning, calls and usage without executing tools', async (t) => {
  let received;
  const server = require('node:http').createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.setHeader('Content-Type', 'text/event-stream');
    for (const value of [
      {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'Readable thought', content: 'Hello' },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call1',
                  type: 'function',
                  function: { name: 'fixtureRead', arguments: '{"path":"a.txt"}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
    ])
      response.write('data: ' + JSON.stringify(value) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await fetchOpenCode(
    {
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      headers: { 'User-Agent': 'cibyp/fixture' },
      opencodeSdk: { protocol: 'openai', body: {} },
      body: {
        model: 'fixture',
        messages: [
          { role: 'system', content: 'Keep this system instruction' },
          { role: 'user', content: 'read' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'fixtureRead',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        stream: true,
      },
    },
    { timeoutMs: 5000 },
  );
  assert.equal(result.ok, true, result.error);
  try {
    const stream = await consumeSSEStream(result.response.body, null, 'sdk-fixture');
    assert.equal(stream.error, undefined);
    assert.equal(stream.content, 'Hello');
    assert.equal(stream.reasoning, 'Readable thought');
    assert.equal(stream.finishReason, 'tool_calls');
    assert.equal(stream.toolCalls[0].function.name, 'fixtureRead');
    assert.equal(stream.toolCalls[0].function.arguments, '{"path":"a.txt"}');
    assert.equal(stream.usage.total_tokens, 20);
    assert.equal(stream.usage.prompt_tokens_details.cached_tokens, 3);
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers['user-agent'], 'cibyp/fixture');
    assert.equal(received.body.tools.length, 1);
    assert.ok(JSON.stringify(received.body.messages).includes('Keep this system instruction'));
  } finally {
    result.releaseController?.();
  }
});

test('SDK keeps provider refusals terminal and remains cancellable', async (t) => {
  const server = require('node:http').createServer((request, response) => {
    response.statusCode = 403;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        error: {
          type: 'FreeTierError',
          message: "OpenCode's free tier can only be used from within OpenCode.",
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const request = {
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    headers: {},
    opencodeSdk: { protocol: 'openai', body: {} },
    body: { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] },
  };
  const result = await fetchOpenCode(request, { timeoutMs: 5000 });
  try {
    const failure = await consumeSSEStream(result.response.body, null, 'sdk-refusal');
    assert.equal(failure.kind, 'provider-policy');
    assert.equal(failure.retryable, false);
  } finally {
    result.releaseController?.();
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal((await fetchOpenCode(request, { signal: controller.signal })).kind, 'aborted');
});

test('native Responses and Anthropic transports display summaries while retaining opaque reasoning separately', async (t) => {
  const reasoning = {
    id: 'rs1',
    type: 'reasoning',
    encrypted_content: 'OPAQUE-FIXTURE',
    summary: [{ type: 'summary_text', text: 'A summary' }],
  };
  const message = {
    id: 'msg1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
  };
  const server = require('node:http').createServer((request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    const events = request.url.endsWith('responses')
      ? [
          {
            type: 'response.created',
            response: { id: 'resp1', status: 'in_progress', model: 'fixture', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'rs1', type: 'reasoning', summary: [] },
          },
          {
            type: 'response.reasoning_summary_part.added',
            item_id: 'rs1',
            output_index: 0,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs1',
            output_index: 0,
            summary_index: 0,
            delta: 'A summary',
          },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { ...message, status: 'in_progress', content: [] },
          },
          {
            type: 'response.content_part.added',
            item_id: 'msg1',
            output_index: 1,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg1',
            output_index: 1,
            content_index: 0,
            delta: 'Hello',
          },
          { type: 'response.output_item.done', output_index: 1, item: message },
          {
            type: 'response.completed',
            response: {
              id: 'resp1',
              status: 'completed',
              model: 'fixture',
              output: [reasoning, message],
              usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            },
          },
        ]
      : [
          {
            type: 'message_start',
            message: {
              id: 'msg1',
              type: 'message',
              role: 'assistant',
              model: 'fixture',
              content: [],
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'A summary' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'OPAQUE-FIXTURE' },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ];
    for (const event of events)
      response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  for (const protocol of ['responses', 'anthropic']) {
    const result = await fetchOpenCode(
      {
        url: `http://127.0.0.1:${server.address().port}/v1/${protocol === 'responses' ? 'responses' : 'messages'}`,
        headers: {},
        opencodeSdk: {
          protocol,
          body:
            protocol === 'responses'
              ? { reasoning: { summary: 'auto' } }
              : { thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' } },
        },
        body: { model: 'fixture', messages: [{ role: 'user', content: 'hello' }] },
      },
      { timeoutMs: 5000 },
    );
    try {
      const stream = await consumeSSEStream(result.response.body, null, 'sdk-' + protocol);
      assert.equal(stream.error, undefined, protocol);
      assert.equal(stream.content, 'Hello', protocol);
      assert.equal(stream.reasoning, 'A summary', protocol);
      assert.equal(stream.reasoningKind, 'summary', protocol);
      assert.ok(JSON.stringify(stream.providerReasoning).includes('OPAQUE-FIXTURE'), protocol);
      assert.equal(stream.usage.total_tokens, 15, protocol);
    } finally {
      result.releaseController?.();
    }
  }
});
