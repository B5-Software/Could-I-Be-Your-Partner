/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildLLMRequest } = require('../../src/main/llm-providers');
const { consumeSSEStream } = require('../../src/main/llm-retry');

test('saving image history leaves live messages intact and rehydrates the original data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-live-vision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const historyDir = path.join(root, 'chat');
  fs.mkdirSync(historyDir);
  const handlers = new Map();
  require('../../src/main/services/history')({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fs,
    path,
    historyDir,
    babeHistoryDir: path.join(root, 'babe'),
    imagesDir: path.join(root, 'images'),
    dataDir: root,
    getSettings: () => ({}),
    loadJSON: (file, fallback) =>
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback,
  });
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const message = { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] };
  const conversation = {
    id: 'fixture',
    messages: [message],
    workingContext: { entries: [{ message }] },
  };
  handlers.get('history:save')(null, conversation, { immediate: true });
  assert.equal(message.content[0].image_url.url, image);
  const stored = JSON.parse(fs.readFileSync(path.join(historyDir, 'fixture.json')));
  assert.match(stored.messages[0].content[0].image_url.url, /^file:/);
  assert.equal(fs.readdirSync(path.join(root, 'images', 'history', 'fixture')).length, 1);
  assert.equal(
    handlers.get('history:get')(null, 'fixture').messages[0].content[0].image_url.url,
    image,
  );
});

test('Responses request drops an unnamed call and its output, keeping usable images and tools', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const user = {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: image } },
      { type: 'image_url', image_url: { url: 'file:///unreadable-local.png' } },
    ],
  };
  const tool = (id, name) => ({ id, function: { name, arguments: '{}' } });
  const request = buildLLMRequest(
    { provider: 'openai-responses', apiUrl: 'http://fixture.invalid/v1', model: 'test' },
    {
      messages: [
        user,
        {
          role: 'assistant',
          tool_calls: [tool('call_missing', ''), tool('call_read', 'readFile')],
        },
        { role: 'tool', tool_call_id: 'call_missing', content: 'unknown' },
        { role: 'tool', tool_call_id: 'call_read', content: 'read' },
      ],
    },
  ).body;
  assert.equal(request.input[0].content[0].image_url, image);
  assert.equal(request.input[0].content[1].type, 'input_text');
  assert.deepEqual(
    request.input.slice(1).map((item) => item.call_id),
    ['call_read', 'call_read'],
  );
  assert.equal(user.content[1].image_url.url, 'file:///unreadable-local.png');
});

test('Responses streaming waits for the tool name and call ID after early argument completion', async () => {
  const events = [
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"action":"add"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc1' },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc1', name: 'todo', call_id: 'call_1' },
    },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ];
  const stream = new Response(
    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  ).body;
  const result = await consumeSSEStream(stream, null, 'fixture', 'responses');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'todo', arguments: '{"action":"add"}' },
    },
  ]);
});

test('Responses reports an incomplete tool-only turn without forwarding an unnamed tool', async () => {
  const item = { type: 'function_call', id: 'fc1', call_id: 'call_1', arguments: '{}' };
  const events = [
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ];
  const stream = new Response(
    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  ).body;
  const result = await consumeSSEStream(stream, null, 'fixture', 'responses');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls, undefined);
});
