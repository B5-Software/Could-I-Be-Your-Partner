/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 无头 Agent 运行时测试：
 *   1. preload 门面派生（与 window.api 同形，含参数整形）
 *   2. 事件总线的会话级订阅
 *   3. 无头一轮对话（工具执行 + 消息流）
 *   4. 审批挂起/应答闭环（prompt 策略）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadPreloadApi } = require('../../src/agent/preload-api.js');
const { createEventBus } = require('../../src/main/core/event-bus.js');
const { createAgentRuntime, INTERACTION_POLICY } = require('../../src/main/agent-runtime.js');

const SETTINGS = {
  llm: {
    provider: 'openai',
    apiUrl: 'http://stub.local/v1',
    apiKey: 'stub-key',
    model: 'stub-model',
    streamResponses: false,
    maxContextLength: 32768,
    maxResponseTokens: 1024,
  },
  tools: {},
  toolExposure: { mode: 'adaptive', budgetTokens: 4000 },
  autoApproveSensitive: false,
  aiPersona: { name: '测试助手' },
  privacyProtection: { enabled: false },
};

function createFakeIpcMain(handlers) {
  return {
    invokeLocal(channel, event, ...args) {
      const handler = handlers.get(channel);
      if (!handler) return { ok: true, skipped: `no handler: ${channel}` };
      return handler(event, ...args);
    },
    emitLocal(channel, event, ...args) {
      const handler = handlers.get(channel);
      if (!handler) return false;
      handler(event, ...args);
      return true;
    },
  };
}

function baseHandlers({ llmChat } = {}) {
  const handlers = new Map();
  handlers.set('settings:get', async () => SETTINGS);
  handlers.set('settings:set', async () => ({ ok: true }));
  handlers.set('runtime:getLocation', async () => ({ location: 'host', emergencyHost: false }));
  handlers.set('app:startup-runtime', async () => ({ ok: true, runtime: { location: 'host' } }));
  handlers.set('system:fullInfo', async () => ({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: 'test-host',
  }));
  handlers.set('workspace:create', async () => ({ ok: true, path: 'C:/tmp/cibyp-test-ws' }));
  handlers.set('workspace:getFileTree', async () => ({ ok: true, tree: [] }));
  handlers.set('skills:list', async () => []);
  handlers.set('tarot:draw', async () => ({ name: 'The Star', meaning: '希望' }));
  handlers.set('history:save', async () => ({ ok: true }));
  handlers.set('history:babeSave', async () => ({ ok: true }));
  handlers.set('babeHistory:save', async () => ({ ok: true }));
  handlers.set('llm:countTokens', async () => ({ ok: true, tokens: 12 }));
  handlers.set('llm:summarize', async () => ({ ok: true, summary: '摘要' }));
  handlers.set('terminal:run', async () => ({ ok: true, output: 'stub output' }));
  handlers.set('terminal:make', async () => ({ ok: true, id: 't1' }));
  if (llmChat) handlers.set('llm:chat', llmChat);
  return handlers;
}

function llmScript(responses) {
  let call = 0;
  const calls = [];
  const handler = async (_event, messages, options) => {
    calls.push({ messages, options });
    // 会话标题生成也走 llm:chat（temperature 0 / max_tokens 512），不占脚本序号
    if (options && options.temperature === 0 && options.max_tokens === 512) {
      return { ok: true, data: { choices: [{ message: { content: '测试会话' } }] } };
    }
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, data: { choices: [{ message: next }] } };
  };
  handler.calls = calls;
  return handler;
}

// ---- 1. preload 门面派生 ----

test('preload 门面派生：方法同形且参数整形与渲染层一致', () => {
  const recorded = [];
  const api = loadPreloadApi({
    invoke: (channel, ...args) => {
      recorded.push({ channel, args });
      return Promise.resolve({ ok: true });
    },
  });

  assert.equal(typeof api.readFile, 'function');
  assert.equal(typeof api.getSettings, 'function');
  assert.equal(typeof api.runtime.getLocation, 'function');
  assert.equal(typeof api.aria2.addUri, 'function');

  api.readFile('C:/a.txt', 'utf-8');
  assert.deepEqual(recorded[0], { channel: 'fs:readFile', args: ['C:/a.txt', 'utf-8'] });

  // 参数整形：memoryUpdate(id, data) → invoke('memory:update', { id, data })
  // （门面对象诞生于 vm 沙箱，跨 realm 比较先归一化）
  api.memoryUpdate('m1', { note: 'x' });
  assert.deepEqual(JSON.parse(JSON.stringify(recorded[1])), {
    channel: 'memory:update',
    args: [{ id: 'm1', data: { note: 'x' } }],
  });

  api.getSettings();
  assert.equal(recorded[2].channel, 'settings:get');
});

test('preload 门面派生：事件订阅经 bridge.on 注册并可卸载', () => {
  const subscriptions = new Map();
  const api = loadPreloadApi({
    invoke: async () => ({ ok: true }),
    on: (channel, listener) => {
      if (!subscriptions.has(channel)) subscriptions.set(channel, new Set());
      subscriptions.get(channel).add(listener);
    },
    off: (channel, listener) => subscriptions.get(channel)?.delete(listener),
  });
  let received = null;
  const off = api.onStreamChunk((chunk) => {
    received = chunk;
  });
  assert.equal(subscriptions.get('llm:stream-chunk').size, 1);
  for (const listener of subscriptions.get('llm:stream-chunk'))
    listener({}, { requestId: 'r1', content: 'hi' });
  assert.equal(received.content, 'hi');
  off();
  assert.equal(subscriptions.get('llm:stream-chunk').size, 0);
});

// ---- 2. 事件总线 ----

test('事件总线：会话级订阅过滤 + 通配订阅', () => {
  const bus = createEventBus();
  const seenA = [];
  const seenAll = [];
  bus.subscribe('llm:stream-chunk', (p) => seenA.push(p), { sessionKey: 'a' });
  bus.subscribeAll((payload) => seenAll.push(payload));

  bus.publish('llm:stream-chunk', { sessionKey: 'a', content: '1' });
  bus.publish('llm:stream-chunk', { sessionKey: 'b', content: '2' });
  bus.publish('llm:stream-chunk', { content: 'global' });

  assert.deepEqual(
    seenA.map((p) => p.content),
    ['1', 'global'],
  ); // 无归属事件不过滤
  assert.equal(seenAll.length, 3);
});

// ---- 3. 无头一轮对话 ----

test('无头运行时：一轮对话完成，消息/工具事件成流', async () => {
  const llm = llmScript([
    {
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'runTerminalCommand',
            arguments: JSON.stringify({ id: 't1', command: 'echo hi' }),
          },
        },
      ],
    },
    { content: '已完成：stub output' },
  ]);
  const handlers = baseHandlers({ llmChat: llm });
  const eventBus = createEventBus();
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus,
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
    getSettings: () => SETTINGS,
    log: { warn() {} },
  });

  const events = [];
  runtime.onEvent((e) => events.push(e));

  const result = await runtime.sendMessage('s1', '跑一下 echo hi');
  assert.equal(result.ok, true, JSON.stringify(result));

  const kinds = events.map((e) => e.type);
  assert.ok(kinds.includes('message'), '应有消息事件');
  assert.ok(kinds.includes('tool-call'), '应有工具调用事件');
  assert.ok(kinds.includes('title'), '应有标题事件');

  const assistant = events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.ok(assistant.some((e) => e.content === '已完成：stub output'));

  const toolCalls = events.filter((e) => e.type === 'tool-call');
  assert.equal(toolCalls[0].name, 'runTerminalCommand');
  assert.equal(toolCalls[0].status, 'running');
  assert.equal(toolCalls[1].status, 'done');
  assert.ok(String(toolCalls[1].result).includes('stub output'));

  // 会话快照可用
  const snap = runtime.getSession('s1');
  assert.equal(snap.key, 's1');
  assert.equal(snap.busy, false);
  assert.ok(runtime.listSessions().length === 1);
});

// ---- 4. 审批闭环 ----

test('无头运行时：危险命令挂起审批，应答后继续执行', async () => {
  const llm = llmScript([
    {
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'runTerminalCommand',
            arguments: JSON.stringify({ id: 't1', command: 'rm -rf /tmp/x' }),
          },
        },
      ],
    },
    { content: '已执行危险命令' },
  ]);
  const handlers = baseHandlers({ llmChat: llm });
  const eventBus = createEventBus();
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus,
    interactionPolicy: INTERACTION_POLICY.PROMPT,
    getSettings: () => SETTINGS,
    log: { warn() {} },
  });

  const events = [];
  runtime.onEvent((e) => events.push(e));

  const pending = runtime.sendMessage('s2', '删除临时目录');
  // 等待审批事件出现
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'interaction' && e.kind === 'approval')) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });

  const approval = events.find((e) => e.type === 'interaction' && e.kind === 'approval');
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.payload.toolName, 'runTerminalCommand');

  const accepted = runtime.respond('s2', true);
  assert.equal(accepted.ok, true);
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));

  const assistant = events.filter((e) => e.type === 'message' && e.role === 'assistant');
  assert.ok(assistant.some((e) => e.content === '已执行危险命令'));
  assert.ok(events.some((e) => e.type === 'interaction-resolved'));
});

test('无头运行时：拒绝审批则工具不执行并回填拒绝原因', async () => {
  const llm = llmScript([
    {
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'runTerminalCommand',
            arguments: JSON.stringify({ id: 't1', command: 'rm -rf /tmp/y' }),
          },
        },
      ],
    },
    { content: '好的，已跳过' },
  ]);
  const handlers = baseHandlers({ llmChat: llm });
  const eventBus = createEventBus();
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus,
    interactionPolicy: INTERACTION_POLICY.PROMPT,
    getSettings: () => SETTINGS,
    log: { warn() {} },
  });

  const events = [];
  runtime.onEvent((e) => events.push(e));
  const pending = runtime.sendMessage('s3', '删除另一个临时目录');
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'interaction' && e.kind === 'approval')) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
  runtime.respond('s3', false);
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));

  // 拒绝后第二轮 LLM 看到的是"用户拒绝了此操作"的工具结果
  const withTool = [...llm.calls].reverse().find((c) => c.messages.some((m) => m.role === 'tool'));
  assert.ok(withTool, '应有一轮包含工具结果的 LLM 调用');
  const toolMessage = withTool.messages.find((m) => m.role === 'tool');
  assert.ok(
    String(toolMessage.content).includes('拒绝'),
    `工具结果应说明拒绝：${toolMessage.content}`,
  );
});

test('无头运行时：中止与关闭会话', async () => {
  const handlers = baseHandlers({
    llmChat: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, data: { choices: [{ message: { content: 'late' } }] } };
    },
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
    getSettings: () => SETTINGS,
    log: { warn() {} },
  });
  const pending = runtime.sendMessage('s4', '慢慢来');
  runtime.stop('s4');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(runtime.close('s4').ok, true);
  assert.equal(runtime.getSession('s4'), null);
});

test('headless todos load at startup, synchronize globally and ignore stale snapshots', async () => {
  const eventBus = createEventBus();
  const handlers = baseHandlers();
  let stored = { revision: 2, counter: 1, items: [{ id: 1, text: 'Saved task', done: false }] };
  handlers.set('todo:get', async () => structuredClone(stored));
  const runtime = createAgentRuntime({ ipcMain: createFakeIpcMain(handlers), eventBus });
  const events = [];
  runtime.onEvent((event) => events.push(event));
  const a = runtime.createSession({ key: 'a' }).agent;
  const b = runtime.createSession({ key: 'b' }).agent;
  assert.deepEqual(await runtime.getTodos(), stored.items);
  assert.deepEqual(a.todoItems, b.todoItems);
  stored = { ...stored, revision: 3, items: [{ ...stored.items[0], done: true }] };
  eventBus.publish('todo:state', stored);
  assert.equal(a.todoItems[0].done, true);
  assert.equal(b.todoItems[0].done, true);
  assert.equal(
    events.at(-1).key,
    undefined,
    'Todo changes reach every frontend, regardless of active session',
  );
  const count = events.length;
  eventBus.publish('todo:state', { ...stored, revision: 1, items: [] });
  assert.equal(events.length, count, 'Stale revisions cannot roll back the list');
  assert.equal(b.todoItems[0].done, true);
});
