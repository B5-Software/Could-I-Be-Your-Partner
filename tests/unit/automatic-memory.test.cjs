/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutomaticMemory } = require('../../src/main/services/automatic-memory');
const { ContextManager } = require('../../src/renderer/js/context-manager');
const { loadPreloadApi } = require('../../src/agent/preload-api');
const reply = (upsert = [], forget = []) => ({
  ok: true,
  data: { choices: [{ message: { content: JSON.stringify({ upsert, forget }) } }] },
});
const pref = (content = '用户偏好简洁的中文回答。', key = 'response-style', extra = {}) => ({
  key,
  topic: '回答风格',
  category: 'preference',
  content,
  scope: 'global',
  evidence: '我喜欢简洁的中文回答',
  ...extra,
});
const input = (extra = {}) => ({
  mode: 'chat',
  conversationId: 'one',
  turnId: '1',
  text: '我喜欢简洁的中文回答，以后也请按这个习惯。',
  ...extra,
});
function fixture(t, chat = async () => reply([pref()]), extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-auto-memory-'));
  const settings = { automaticMemory: { enabled: true, capture: true } };
  const args = {
    file: path.join(dir, 'automatic-memory.json'),
    getSettings: () => settings,
    chat,
    ...extra,
  };
  const memory = new AutomaticMemory(args);
  t.after(() => {
    clearTimeout(memory.timer);
    memory.controller?.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { memory, settings, args, dir };
}
async function capture(memory, value = input()) {
  const result = memory.observe(value);
  clearTimeout(memory.timer);
  memory.timer = null;
  await memory.drain();
  return result;
}

test('automatically extracts, persists separately and recalls across sessions with bounded input', async (t) => {
  let request;
  const { memory, args, dir } = fixture(t, async (messages, options) => {
    request = { messages, options };
    return reply([pref()]);
  });
  fs.writeFileSync(path.join(dir, 'memory.json'), '[{"content":"manual unchanged"}]');
  assert.equal(
    (
      await capture(
        memory,
        input({
          llm: {
            provider: 'openai-compat',
            model: 'fixture',
            apiKey: 'fixture-secret',
            tools: [{ unwanted: true }],
          },
        }),
      )
    ).queued,
    true,
  );
  const restored = new AutomaticMemory(args);
  assert.match(
    restored.recall(input({ conversationId: 'two', query: '中文回答' })).content,
    /简洁/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'memory.json')))[0].content,
    'manual unchanged',
  );
  assert.doesNotMatch(fs.readFileSync(args.file, 'utf8'), /fixture-secret/);
  assert.equal(request.options.max_tokens, 1200);
  assert.equal(request.options.maxRetries, 1);
  assert.equal(request.options.tools, undefined);
  assert.equal(request.options.model, 'fixture');
  assert.equal(request.messages.length, 2);
});

test('mode and canonical workspace isolation, with personal preferences shared between Chat and Code', async (t) => {
  const { memory } = fixture(
    t,
    async (messages) => {
      const data = JSON.parse(messages[1].content);
      return reply([
        data.mode === 'code'
          ? pref('此项目使用 SQLite。', 'database', {
              scope: 'workspace',
              category: 'fact',
              evidence: '此项目使用 SQLite',
            })
          : pref(),
      ]);
    },
    { resolveWorkspace: (value) => (value === '/workspace/project' ? 'D:/project' : value) },
  );
  await capture(memory);
  await capture(memory, input({ mode: 'babe', conversationId: 'babe' }));
  await capture(
    memory,
    input({
      mode: 'code',
      workspace: '/workspace/project',
      conversationId: 'code',
      text: '此项目使用 SQLite，这是长期项目约定。',
    }),
  );
  assert.match(
    memory.recall(input({ mode: 'code', workspace: 'D:/project', query: 'SQLite' })).content,
    /SQLite/,
  );
  assert.doesNotMatch(
    memory.recall(input({ mode: 'code', workspace: 'D:/other', query: 'SQLite' })).content,
    /SQLite/,
  );
  assert.doesNotMatch(memory.recall(input({ mode: 'chat', query: 'SQLite' })).content, /SQLite/);
  assert.equal(memory.snapshot().items.filter((i) => i.scope === 'babe').length, 1);
  assert.match(
    memory.recall(input({ mode: 'code', workspace: 'D:/other', query: '回答' })).content,
    /简洁/,
  );
});

test('disabled capture keeps recall, master and individual mode switches stop both, ephemeral sessions never participate', async (t) => {
  let calls = 0;
  const { memory, settings } = fixture(t, async () => {
    calls++;
    return reply([pref()]);
  });
  await capture(memory);
  settings.automaticMemory.capture = false;
  assert.equal((await capture(memory, input({ turnId: '2' }))).skipped, true);
  assert.match(memory.recall(input()).content, /简洁/);
  settings.automaticMemory.enabled = false;
  assert.equal(memory.recall(input()).content, '');
  settings.automaticMemory = { enabled: true, capture: true, chat: false };
  assert.equal(memory.recall(input()).content, '');
  assert.equal((await capture(memory, input({ turnId: '3' }))).skipped, true);
  settings.automaticMemory.chat = true;
  assert.equal(memory.recall(input({ ephemeral: true })).content, '');
  assert.equal((await capture(memory, input({ ephemeral: true }))).skipped, true);
  assert.equal(calls, 1);
});

test('manual changes win against in-flight extraction and future automatic overwrites', async (t) => {
  let release;
  let deferred = false;
  const { memory } = fixture(t, async () =>
    deferred
      ? await new Promise((resolve) => {
          release = resolve;
        })
      : reply([pref()]),
  );
  await capture(memory);
  const item = memory.snapshot().items[0];
  deferred = true;
  memory.observe(input({ turnId: '2' }));
  const running = memory.drain();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    memory.edit({ id: item.id, revision: memory.snapshot().revision, content: '请用英文回答。' })
      .ok,
    true,
  );
  release(reply([pref('outdated')]));
  await running;
  assert.equal(memory.snapshot().items[0].content, '请用英文回答。');
  deferred = false;
  await capture(memory, input({ turnId: '3' }));
  assert.equal(memory.snapshot().items[0].content, '请用英文回答。');
  assert.equal(memory.edit({ id: item.id, revision: 0, content: 'lost update' }).conflict, true);
});

test('delete/clear and off-on transitions invalidate pending extraction; forgotten facts do not resurrect', async (t) => {
  let release;
  let defer = false;
  const { memory, settings } = fixture(t, async () =>
    defer
      ? new Promise((resolve) => {
          release = resolve;
        })
      : reply([pref()]),
  );
  await capture(memory);
  defer = true;
  memory.observe(input({ turnId: '2' }));
  const running = memory.drain();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  memory.remove({ all: true, revision: memory.snapshot().revision });
  release(reply([pref()]));
  await running;
  assert.equal(memory.snapshot().items.length, 0);
  defer = false;
  await capture(memory, input({ turnId: '3' }));
  assert.equal(memory.snapshot().items.length, 0);
  await capture(memory, input({ turnId: '4', text: '记住我喜欢简洁的中文回答。' }));
  assert.equal(memory.snapshot().items.length, 1);
  defer = true;
  release = null;
  memory.observe(input({ turnId: '5' }));
  const paused = memory.drain();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  settings.automaticMemory.enabled = false;
  memory.settingsChanged();
  settings.automaticMemory.enabled = true;
  memory.settingsChanged();
  release(reply([pref('must not overwrite')]));
  await paused;
  assert.match(memory.snapshot().items[0].content, /简洁/);
});

test('explicit forget targets known memories only, and general chatter cannot delete them', async (t) => {
  let result = reply([pref()]);
  const { memory } = fixture(t, async () => result);
  await capture(memory);
  const id = memory.snapshot().items[0].id;
  result = reply([], [id, 'unknown']);
  await capture(memory, input({ turnId: '2' }));
  assert.equal(memory.snapshot().items.length, 1);
  await capture(memory, input({ turnId: '3', text: '忘记我的回答风格偏好' }));
  assert.equal(memory.snapshot().items.length, 0);
});

test('private data is filtered before extraction and rejected when returned; duplicate events, unrelated facts, malformed responses fail safely', async (t) => {
  let calls = 0;
  let body;
  const { memory } = fixture(t, async (messages) => {
    calls++;
    body = messages[1].content;
    return reply([pref('password: my-private-value')]);
  });
  await capture(
    memory,
    input({ text: '我的 API_KEY=sk-123456789012345678901234567890；请用中文回答。' }),
  );
  assert.doesNotMatch(body, /sk-1234567890/);
  assert.equal(memory.snapshot().items.length, 0);
  await capture(
    memory,
    input({ text: '我的 API_KEY=sk-123456789012345678901234567890；请用中文回答。' }),
  );
  assert.equal(calls, 1);
  memory.chat = async () => ({
    ok: true,
    data: { choices: [{ message: { content: 'broken JSON' } }] },
  });
  await capture(memory, input({ turnId: '3' }));
  assert.equal(memory.snapshot().error, 'extraction');
  assert.equal(memory.recall(input()).content, '');
});

test('short durable preferences are captured; evidence, request and recall budgets are enforced', async (t) => {
  let body, options;
  const { memory } = fixture(t, async (messages, opts) => {
    body = JSON.parse(messages[1].content);
    options = opts;
    return reply([
      pref('用户喜欢猫。', 'pets', { evidence: '我喜欢猫' }),
      pref('invented fact', 'bad', { evidence: 'not in the user input' }),
    ]);
  });
  await capture(memory, input({ text: '我喜欢猫', llm: { contextLength: 4096 } }));
  assert.equal(memory.snapshot().items.length, 1);
  assert.equal(options.max_tokens, 614);
  assert.equal(memory.recall(input({ query: '宠物', budgetChars: 10 })).content, '');
  assert.ok(memory.recall(input({ query: '宠物', budgetChars: 1000 })).content.length <= 1000);
  await capture(
    memory,
    input({ turnId: '2', text: '我喜欢猫' + '消息'.repeat(10000), llm: { contextLength: 4096 } }),
  );
  assert.ok(body.USER_TEXT.length < 650);
  assert.match(body.USER_TEXT, /Middle omitted/);
  const item = memory.snapshot().items[0];
  assert.equal(
    memory.edit({ id: item.id, revision: memory.state.revision, content: 'password: do-not-save' })
      .ok,
    false,
  );
});

test('unreadable storage is preserved until an explicit reset, with a recovery copy', (t) => {
  const { args, dir } = fixture(t);
  fs.writeFileSync(args.file, 'damaged memory data');
  const memory = new AutomaticMemory(args);
  assert.equal(memory.snapshot().error, 'storage');
  assert.equal(memory.recall(input()).content, '');
  assert.equal(memory.observe(input()).skipped, true);
  assert.equal(fs.readFileSync(args.file, 'utf8'), 'damaged memory data');
  assert.equal(memory.remove({ all: true, revision: 0 }).ok, true);
  const backup = fs.readdirSync(dir).find((file) => file.includes('.unreadable-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), 'damaged memory data');
  assert.equal(new AutomaticMemory(args).snapshot().error, null);
});

test('transient recall is budgeted, hot-swappable, absent from transcript, snapshots and compaction requests', () => {
  const context = new ContextManager(8192);
  context.setSystemPrompt('base');
  context.addUserMessage('hello');
  const before = context.getRawTotalTokens();
  context.setTransientContextSource('memory', 'prefers short replies');
  assert.ok(context.getRawTotalTokens() > before);
  assert.match(context.getMessages()[0].content, /short replies/);
  context.setRealBasis(120, 'fixture');
  context.setTransientContextSource('memory', 'prefers detailed answers');
  assert.equal(context.realBasis, null);
  assert.doesNotMatch(JSON.stringify(context.exportWorkingState()), /prefers/);
  assert.doesNotMatch(JSON.stringify(context.getHistoryMessages()), /prefers/);
  assert.doesNotMatch(JSON.stringify(context.getReplayMessages(1, 'summarize')), /prefers/);
  context.setTransientContextSource('memory', '');
  assert.equal(context.getMessages()[0].content, 'base');
  context.setTransientContextSource('memory', 'old session memory');
  context.loadFromHistory([{ role: 'user', content: 'a different conversation' }]);
  assert.doesNotMatch(JSON.stringify(context.getMessages()), /old session memory/);
  context.clear();
  assert.equal(context._transientSources.size, 0);
});

test('shared preload facade exposes the same memory capabilities and events to headless and browser clients', async () => {
  const calls = [];
  const events = [];
  const api = loadPreloadApi({
    invoke: (...args) => calls.push(args),
    on: (channel) => events.push(channel),
  });
  await api.automaticMemoryList('query');
  await api.automaticMemoryRecall(input());
  await api.automaticMemoryObserve(input());
  await api.automaticMemoryEdit({ id: 'x', revision: 1, content: 'fact' });
  await api.automaticMemoryRemove({ all: true, revision: 1 });
  api.onAutomaticMemoryChanged(() => {});
  assert.deepEqual(
    calls.map((row) => row[0]),
    [
      'automatic-memory:list',
      'automatic-memory:recall',
      'automatic-memory:observe',
      'automatic-memory:edit',
      'automatic-memory:remove',
    ],
  );
  assert.ok(events.includes('automatic-memory:changed'));
});
