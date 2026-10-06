/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Reasoning = require('../../src/shared/reasoning');
const Providers = require('../../src/main/llm-providers');
const { consumeSSEStream, aggregateSSEToJSON } = require('../../src/main/llm-retry');
const config = {
  provider: 'openai-responses',
  apiUrl: 'https://api.openai.com/v1/responses',
  model: 'gpt-5.4',
  apiKey: 'test-only',
};
const responseItem = {
  type: 'reasoning',
  id: 'rs_1',
  encrypted_content: 'ENCRYPTED-TEST-ONLY',
  summary: [{ type: 'summary_text', text: 'Checked the constraints.' }],
};
const events = (data) => data.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
async function stream(data, transport, chunks = []) {
  return consumeSSEStream(
    new Response(events(data)).body,
    (c) => chunks.push(c),
    'test',
    transport,
  );
}
test('Responses summary is readable; ciphertext is separate and replays before tool calls', () => {
  const message = Providers.parseLLMResponse({ output: [responseItem] }, 'responses', config)
    .choices[0].message;
  assert.equal(message.reasoningKind, 'summary');
  assert.equal(message.reasoning, 'Checked the constraints.');
  message.tool_calls = [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }];
  const request = Providers.buildLLMRequest(config, { messages: [message] });
  assert.deepEqual(request.body.input[0], responseItem);
  assert.equal(request.body.input[1].type, 'function_call');
  assert.equal(request.body.reasoning.summary, 'auto');
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.equal(
    Providers.buildLLMRequest({ ...config, requestReasoningSummary: false }, { messages: [] }).body
      .reasoning?.summary,
    undefined,
  );
});
test('opaque state never crosses a provider, model, or credential change', () => {
  const message = Providers.parseLLMResponse({ output: [responseItem] }, 'responses', config)
    .choices[0].message;
  for (const change of [
    { model: 'gpt-5.5' },
    { apiKey: 'different' },
    { apiUrl: 'https://another.example/v1/responses' },
  ]) {
    const request = Providers.buildLLMRequest({ ...config, ...change }, { messages: [message] });
    assert.equal(JSON.stringify(request.body).includes('ENCRYPTED-TEST-ONLY'), false);
  }
});
test('Responses completed-only and output_item.done recover summaries and encrypted state', async () => {
  for (const data of [
    [{ type: 'response.completed', response: { status: 'completed', output: [responseItem] } }],
    [{ type: 'response.output_item.done', item: responseItem }],
  ]) {
    const result = await stream(data, 'responses');
    assert.equal(result.reasoning, 'Checked the constraints.');
    assert.equal(result.reasoningKind, 'summary');
    assert.equal(result.providerReasoning.items[0].encrypted_content, 'ENCRYPTED-TEST-ONLY');
  }
});
test('Responses summary stream does not duplicate the final summary or show encrypted-only reasoning', async () => {
  const chunks = [];
  const result = await stream(
    [
      { type: 'response.reasoning_summary_text.delta', delta: 'Checked the constraints.' },
      { type: 'response.output_item.done', item: responseItem },
    ],
    'responses',
    chunks,
  );
  assert.equal(result.reasoning, 'Checked the constraints.');
  assert.equal(chunks[0].reasoningKind, 'summary');
  const encrypted = await stream(
    [{ type: 'response.output_item.done', item: { ...responseItem, summary: [] } }],
    'responses',
  );
  assert.equal(encrypted.reasoning, '');
});
const anthropicEvents = [
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Readable summary.' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'OPAQUE-' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'SIGNATURE' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'redacted_thinking', data: 'REDACTED-OPAQUE' },
  },
];
test('Claude signature deltas and redacted blocks survive streaming without leaking into text', async () => {
  const chunks = [];
  const result = await stream(anthropicEvents, 'anthropic', chunks);
  assert.equal(result.reasoning, 'Readable summary.');
  assert.equal(result.providerReasoning.items[0].signature, 'OPAQUE-SIGNATURE');
  assert.equal(result.providerReasoning.items[1].data, 'REDACTED-OPAQUE');
  assert.equal(
    chunks
      .filter((c) => c.reasoning)
      .map((c) => c.reasoning)
      .join(''),
    'Readable summary.',
  );
  const raw = aggregateSSEToJSON(events(anthropicEvents), 'anthropic');
  assert.deepEqual(
    Reasoning.anthropic(raw.content).providerReasoning.items,
    result.providerReasoning.items,
  );
});
test('Claude replay uses untouched signed blocks and never fabricates unsigned thinking', () => {
  const llm = {
    provider: 'anthropic-compat',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6',
    apiKey: 'fixture',
  };
  const content = [
    { type: 'thinking', thinking: 'Summary', signature: 'SIGNATURE' },
    { type: 'redacted_thinking', data: 'OPAQUE' },
  ];
  const message = Providers.parseLLMResponse({ content }, 'anthropic', llm).choices[0].message;
  message.tool_calls = [{ id: 't', function: { name: 'read', arguments: '{}' } }];
  assert.equal(message.reasoningKind, 'summary');
  const request = Providers.buildLLMRequest(llm, { messages: [message], reasoningEffort: 'low' });
  assert.deepEqual(request.body.messages[0].content.slice(0, 2), content);
  assert.equal(request.body.thinking.display, 'summarized');
  assert.equal(request.body.output_config.effort, 'low');
  const omitted = Providers.buildLLMRequest(
    { ...llm, requestReasoningSummary: false },
    { messages: [], reasoningEffort: 'low' },
  );
  assert.equal(omitted.body.thinking.display, 'omitted');
  const legacy = Providers.buildLLMRequest(llm, {
    messages: [{ role: 'assistant', content: 'Done', reasoning: 'No signature' }],
  });
  assert.equal(JSON.stringify(legacy.body.messages).includes('No signature'), false);
});
test('legacy Claude resumes a stripped tool turn without fabricating signed thinking', () => {
  const llm = {
    provider: 'anthropic-compat',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-5',
  };
  const request = Providers.buildLLMRequest(llm, {
    reasoningEffort: 'high',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc', content: 'Result' },
    ],
  });
  assert.equal(request.body.thinking, undefined);
  assert.equal(request.body.messages[0].content[0].type, 'tool_use');
});
test('OpenAI-compatible structured reasoning exposes summary/text and keeps encrypted details opaque', async () => {
  const details = [
    { type: 'reasoning.summary', summary: 'Summary.' },
    { type: 'reasoning.encrypted', data: 'SECRET' },
  ];
  const readable = Reasoning.openai({ reasoning_details: details });
  assert.equal(readable.reasoning, 'Summary.');
  assert.equal(readable.reasoningKind, 'summary');
  const chunks = [];
  const result = await stream(
    [{ choices: [{ delta: { reasoning_details: details } }] }],
    'openai',
    chunks,
  );
  assert.equal(result.reasoning, 'Summary.');
  assert.equal(result.reasoningKind, 'summary');
  assert.equal(chunks[0].reasoning.includes('SECRET'), false);
  assert.equal(result.providerReasoning.items[1].data, 'SECRET');
  assert.equal(Reasoning.openai({ reasoning: { encrypted_content: 'SECRET' } }).reasoning, '');
});
test('retention applies to transcript, compacted working context, subagents and exports without mutating live state', () => {
  const message = { role: 'assistant', ...Reasoning.responses([responseItem]) };
  const conversation = {
    messages: [message],
    workingContext: { entries: [{ message }] },
    subAgents: [{ messages: [message] }],
  };
  const off = Reasoning.retention(conversation, false);
  assert.equal(JSON.stringify(off).includes('ENCRYPTED-TEST-ONLY'), false);
  assert.equal(off.messages[0].reasoning, message.reasoning);
  assert.equal(Reasoning.markdown(off.messages[0]).includes('ENCRYPTED-TEST-ONLY'), false);
  const on = Reasoning.retention(conversation, true);
  assert.deepEqual(on, conversation);
  assert.match(Reasoning.markdown(on.messages[0]), /Encrypted reasoning/);
  assert.match(Reasoning.markdown(on.messages[0]), /ENCRYPTED-TEST-ONLY/);
  assert.equal(message.providerReasoning.items[0].encrypted_content, 'ENCRYPTED-TEST-ONLY');
  assert.equal(
    JSON.stringify(Reasoning.presentation(message)).includes('ENCRYPTED-TEST-ONLY'),
    false,
  );
});
test('forced SSE aggregation retains structured summaries, opaque state and tool calls', () => {
  const responseEvents = [
    { type: 'response.output_item.done', item: responseItem },
    { type: 'response.output_text.delta', delta: 'Done.' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc', call_id: 'tc', name: 'read', arguments: '{}' },
    },
  ];
  const message = Providers.parseLLMResponse(
    aggregateSSEToJSON(events(responseEvents), 'responses'),
    'responses',
    config,
  ).choices[0].message;
  assert.equal(message.content, 'Done.');
  assert.equal(message.reasoning, 'Checked the constraints.');
  assert.equal(message.providerReasoning.items[0].encrypted_content, 'ENCRYPTED-TEST-ONLY');
  assert.equal(message.tool_calls[0].id, 'tc');
  const deltas = [
    {
      choices: [
        {
          delta: {
            reasoning_details: [
              { index: 0, type: 'reasoning.summary', summary: 'Read' },
              { index: 1, type: 'reasoning.encrypted', data: 'OP' },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            reasoning_details: [
              { index: 0, type: 'reasoning.summary', summary: 'able.' },
              { index: 1, type: 'reasoning.encrypted', data: 'AQUE' },
            ],
          },
        },
      ],
    },
  ];
  const aggregated = Providers.parseLLMResponse(aggregateSSEToJSON(events(deltas)), 'openai')
    .choices[0].message;
  assert.equal(aggregated.reasoning, 'Readable.');
  assert.equal(aggregated.providerReasoning.items[1].data, 'OPAQUE');
});
test('completed-only Responses replies recover final text and tool calls; sparse completion retains prior opaque state', async () => {
  const result = await stream(
    [
      { type: 'response.output_item.done', item: responseItem },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
            { type: 'function_call', id: 'fc', call_id: 'tc', name: 'read', arguments: '{}' },
          ],
        },
      },
    ],
    'responses',
  );
  assert.equal(result.content, 'Done.');
  assert.equal(result.toolCalls[0].id, 'tc');
  assert.equal(result.reasoning, 'Checked the constraints.');
});
test('OpenAI requests discard legacy opaque fields but preserve DeepSeek readable reasoning required for tool continuation', () => {
  const llm = { ...config, provider: 'openai-compat', model: 'deepseek-reasoner' };
  const request = Providers.buildLLMRequest(llm, {
    messages: [
      {
        role: 'assistant',
        content: 'Done',
        reasoning: 'Working',
        reasoningKind: 'full',
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'OTHER-SOURCE' }],
      },
    ],
  });
  assert.equal(request.body.messages[0].reasoning_content, 'Working');
  assert.equal(JSON.stringify(request.body).includes('OTHER-SOURCE'), false);
});
