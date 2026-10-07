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
const path = require('node:path');
const os = require('node:os');

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
  handlers.set('workspace:resolve', async (_event, directory) => ({
    ok: true,
    path: directory || 'C:/tmp/cibyp-code-default',
    hostPath: directory || 'C:/tmp/cibyp-code-default',
  }));
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

test('uploaded attachment reaches the selected workspace, survives history and never replaces the display caption with a path', async () => {
  const chat = llmScript([{ role: 'assistant', content: 'Reviewed' }]);
  const handlers = baseHandlers({ llmChat: chat });
  let uploadedBytes;
  handlers.set('fs:saveUploadedFile', (_event, name, data) => {
    uploadedBytes = Buffer.from(data.split(',')[1], 'base64').toString();
    return { ok: true, path: '/uploads/' + name, isImage: false };
  });
  handlers.set('fs:copyFile', (_event, source, target) => {
    assert.equal(source, '/uploads/notes.md');
    assert.match(target, /cibyp-test-ws\/[^/]+_notes\.md$/);
    return { ok: true };
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  try {
    runtime.createSession({ key: 'attachment' });
    await assert.rejects(
      runtime.uploadAttachment('attachment', { name: 'bad', data: '*' }),
      /base64/,
    );
    const file = await runtime.uploadAttachment('attachment', {
      name: '../notes.md',
      type: 'text/markdown',
      data: Buffer.from('Hello').toString('base64'),
    });
    assert.equal(uploadedBytes, 'Hello');
    await runtime.sendMessage('attachment', 'Please review', [file]);
    const message = runtime.getSessionDetails('attachment').messages.find((m) => m.role === 'user');
    assert.equal(message.content, 'Please review');
    assert.equal(message.attachments[0].name, 'notes.md');
    assert.ok(
      chat.calls.some((call) => call.messages.some((m) => String(m.content).includes(file.path))),
    );
    assert.equal(
      runtime.getView('attachment').messages.find((m) => m.role === 'user').metadata.attachments[0]
        .path,
      file.path,
    );
  } finally {
    runtime.dispose();
  }
});

test('subscription usage is requested on demand, coalesced per session and discarded after close', async () => {
  const handlers = baseHandlers();
  let requests = 0,
    finish;
  handlers.set('subscription:usage', (_event, options) => {
    requests++;
    assert.equal(options.force, true);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  runtime.createSession({ key: 'quota' });
  for (let i = 0; i < 20; i++) runtime.getStats('quota');
  assert.equal(requests, 0);
  const first = runtime.getSubscriptionUsage('quota', { force: true });
  const second = runtime.getSubscriptionUsage('quota', { force: true });
  await Promise.resolve();
  assert.equal(requests, 1);
  finish({ subscription: true, windows: [{ usedPercent: 30 }] });
  assert.deepEqual(await first, await second);
  assert.equal(runtime.getStats('quota').subscriptionUsage.windows[0].usedPercent, 30);
  const next = runtime.getSubscriptionUsage('quota', { force: true });
  await Promise.resolve();
  runtime.close('quota');
  finish({ subscription: true, windows: [{ usedPercent: 80 }] });
  assert.equal(await next, null);
  assert.equal(runtime.getStats('quota'), null);
});

test('Minimal uses only two tools and a fixed prompt; file edits and shell polling preserve shared routing', async () => {
  const llm = llmScript([{ content: 'done' }]);
  const handlers = baseHandlers({ llmChat: llm });
  handlers.set('settings:get', () => ({
    ...structuredClone(SETTINGS),
    autoOptimizeToolSelection: true,
    decision: { enabled: true },
    llm: {
      ...SETTINGS.llm,
      pool: [
        {
          id: 'p',
          model: 'stub-model',
          provider: 'openai',
          apiUrl: 'http://stub.local',
          priority: 0,
        },
      ],
      routing: { modelStrategy: 'intelligence', effortStrategy: 'jev' },
    },
  }));
  handlers.set('tarot:draw', () => assert.fail('Minimal must not draw tarot'));
  handlers.set('todo:get', () => ({
    ok: true,
    revision: 1,
    items: [{ id: 1, text: 'shared todo', done: false }],
  }));
  handlers.set('decision:choice', () => assert.fail('Minimal must not call a routing model'));
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
  });
  runtime.createSession({ key: 'minimal', minimalMode: true });
  assert.equal((await runtime.sendMessage('minimal', 'hello minimal')).ok, true);
  assert.equal(llm.calls.length, 1, 'No title or tool-selection LLM calls');
  const call = llm.calls[0];
  assert.equal(call.messages[0].content, 'You are a helpful software engineer assistant.');
  assert.deepEqual(
    call.options.tools.map((tool) => tool.function.name),
    ['bash', 'str_replace_editor'],
  );
  const agent = runtime.sessions.get('minimal').agent;
  let contents = 'one\r\ntwo\r\n';
  handlers.set('fs:readFile', (_event, file) => {
    assert.equal(file, agent._resolveWorkspacePath('a.txt'));
    return { ok: true, content: contents, encoding: 'utf-8', eol: 'crlf' };
  });
  handlers.set('fs:writeFile', (_event, _file, content, options) => {
    contents = content;
    assert.equal(options.eol, 'crlf');
    return { ok: true };
  });
  assert.equal(
    (
      await agent.executeTool('str_replace_editor', {
        command: 'view',
        path: 'a.txt',
        view_range: [2, 2],
      })
    ).content,
    '2: two',
  );
  assert.equal(
    (
      await agent.executeTool('str_replace_editor', {
        command: 'str_replace',
        path: 'a.txt',
        old_str: '',
        new_str: 'bad',
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await agent.executeTool('str_replace_editor', {
        command: 'insert',
        path: 'a.txt',
        insert_line: 1,
        new_str: 'middle',
      })
    ).ok,
    true,
  );
  assert.equal(contents, 'one\r\nmiddle\r\ntwo\r\n');
  assert.equal((await agent.executeTool('webSearch', { query: 'not minimal' })).ok, false);
  const shell = [];
  handlers.set('terminal:make', () => ({ ok: true, terminalId: 77 }));
  handlers.set('terminal:await', (_event, id, command) => {
    shell.push([id, command]);
    return { ok: true, running: Boolean(command), output: 'chunk' };
  });
  await agent.executeTool('bash', { command: 'export X=1' });
  await agent.executeTool('bash', { action: 'poll' });
  assert.deepEqual(shell, [
    [77, 'export X=1'],
    [77, null],
  ]);
  const transcript = JSON.stringify(agent.contextManager.getHistoryMessages());
  assert.equal((await runtime.setMinimalMode('minimal', false)).ok, true);
  await agent.observeRuntimeContext();
  assert.ok(JSON.stringify(agent.contextManager.systemPrompt).includes('shared todo'));
  assert.equal((await runtime.setMinimalMode('minimal', true)).ok, true);
  assert.equal(
    agent.contextManager.systemPrompt.content,
    'You are a helpful software engineer assistant.',
  );
  assert.ok(JSON.stringify(agent.contextManager.getHistoryMessages()).includes('hello minimal'));
  assert.ok(transcript.includes('hello minimal'));
  runtime.sessions.get('minimal').busy = true;
  assert.equal((await runtime.setMinimalMode('minimal', false)).ok, false);
});

test('Minimal shell follows workspace changes and history restores its preset without reusing the old shell', async () => {
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'done' }]) });
  const directories = [],
    killed = [];
  let saved;
  handlers.set('terminal:make', (_event, cwd) => {
    directories.push(cwd);
    return { ok: true, terminalId: directories.length };
  });
  handlers.set('terminal:await', () => ({ ok: true, exitCode: 0, output: 'done' }));
  handlers.set('terminal:kill', (_event, id) => {
    killed.push(id);
    return { ok: true };
  });
  handlers.set('code:saveHistory', (_event, _workspace, _id, data) => {
    saved = structuredClone(data);
    return { ok: true };
  });
  handlers.set('code:loadHistory', () => saved);
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
  });
  const first = path.join(os.tmpdir(), 'minimal-shell-first');
  const second = path.join(os.tmpdir(), 'minimal-shell-second');
  runtime.createSession({
    key: 'minimal-shell',
    mode: 'code',
    workspacePath: first,
    minimalMode: true,
  });
  assert.equal((await runtime.sendMessage('minimal-shell', 'remember this message')).ok, true);
  assert.equal(saved.minimal, true);
  const agent = runtime.sessions.get('minimal-shell').agent;
  await agent.executeTool('bash', { command: 'echo first' });
  assert.equal((await runtime.setWorkspace('minimal-shell', second)).ok, true);
  await agent.executeTool('bash', { command: 'echo second' });
  assert.deepEqual(directories, [first, second]);
  assert.deepEqual(killed, [1]);
  const result = await runtime.openHistory('minimal-shell', saved.id);
  assert.equal(result.ok, true);
  assert.equal(result.minimalMode, true);
  assert.ok(JSON.stringify(result.messages).includes('remember this message'));
  assert.deepEqual(killed, [1, 2]);
  await agent.executeTool('bash', { command: 'echo restored' });
  assert.equal(directories[2], first);
});

test('LLM retries reach headless frontends as structured notifications without entering conversation history', async () => {
  const eventBus = createEventBus(),
    notices = [];
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'ready' }]) });
  const runtime = createAgentRuntime({ ipcMain: createFakeIpcMain(handlers), eventBus });
  runtime.onEvent((event) => {
    if (event.type === 'notification') notices.push(event);
  });
  await runtime.sendMessage('retry-main', 'hello');
  await runtime.sendMessage('retry-other', 'hello');
  const retry = {
    sessionKey: 'retry-main',
    attempt: 3,
    status: 429,
    kind: 'rate_limit',
    delayMs: 9000,
    error: 'Provider rate limit',
  };
  eventBus.publish('llm:retry', retry);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].key, 'retry-main');
  assert.equal(notices[0].notificationType, 'toast');
  assert.equal(notices[0].payload.retry.delayMs, 9000);
  assert.equal(notices[0].payload.retry.error, 'Provider rate limit');
  assert.ok(
    !JSON.stringify(
      runtime.sessions.get('retry-main').agent.contextManager.getHistoryMessages(),
    ).includes('Provider rate limit'),
  );
});

test('Code startup preserves the requested workspace and rejects changes during a task', async () => {
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'done' }]) });
  let created = 0;
  handlers.set('workspace:create', () => {
    created++;
    return { ok: true, path: '/unexpected' };
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  const workspace = path.join(os.tmpdir(), 'requested-code-project');
  runtime.createSession({ key: 'code-workspace', mode: 'code', workspacePath: workspace });
  assert.equal((await runtime.sendMessage('code-workspace', 'hello')).ok, true);
  assert.equal(runtime.getSession('code-workspace').workspacePath, workspace);
  assert.equal(created, 0);
  runtime.sessions.get('code-workspace').busy = true;
  assert.equal((await runtime.setWorkspace('code-workspace', '/new')).ok, false);
  assert.equal((await runtime.openHistory('code-workspace', 'h1')).ok, false);
});

test('Code file exports cannot trap later user messages in a completed Agent turn', async () => {
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'done' }]) });
  const events = [];
  let finishExport;
  handlers.set(
    'workspace:sync',
    () =>
      new Promise((resolve) => {
        finishExport = resolve;
      }),
  );
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  runtime.onEvent((event) => events.push(event));
  runtime.createSession({ key: 'code-export', mode: 'code' });
  const result = await Promise.race([
    runtime.sendMessage('code-export', 'create files'),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Export blocked the Agent turn')), 2000);
      timer.unref();
    }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(runtime.getSession('code-export').busy, false);
  finishExport({ ok: false, error: 'export failure' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.content?.includes('export failure')));
});

test('stopping during initialization prevents the first LLM request', async () => {
  let requests = 0;
  let release;
  const handlers = baseHandlers({
    llmChat: () => {
      requests++;
      return { ok: true };
    },
  });
  handlers.set(
    'app:startup-runtime',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  const pending = runtime.sendMessage('stop-init', 'do not send');
  runtime.stop('stop-init');
  release({ ok: true });
  assert.equal((await pending).stopped, true);
  assert.equal(requests, 0);
  assert.equal(runtime.getSession('stop-init').busy, false);
});

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

test('/undo immediately after submission restores a message before Agent initialization admitted it', async () => {
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(baseHandlers()),
    eventBus: createEventBus(),
  });
  const submitted = runtime.sendMessage('early-undo', 'restore this draft');
  const undone = runtime.undo('early-undo');
  await submitted;
  assert.equal((await undone).text, 'restore this draft');
  assert.ok(
    !runtime.sessions
      .get('early-undo')
      .agent.contextManager.getHistoryMessages()
      .some((m) => m.content === 'restore this draft'),
  );
});

test('/undo removes the last raw turn from both stores while retaining independent summaries', async () => {
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'done' }]) });
  let saved;
  handlers.set('history:save', (_event, value) => {
    saved = value;
    return { ok: true };
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  await runtime.sendMessage('undo', 'first');
  await runtime.sendMessage('undo', 'second');
  const context = runtime.sessions.get('undo').agent.contextManager;
  context.addMessage({
    role: 'user',
    content: 'a live settings update',
    metadata: { kind: 'context-update' },
  });
  context.summaries = ['obsolete'];
  context.pinnedMessages = [1];
  const result = await runtime.undo('undo');
  assert.equal(result.text, 'second');
  assert.equal(context.getHistoryMessages().filter((m) => m.role === 'user').length, 1);
  assert.equal(context.getHistoryMessages().find((m) => m.role === 'user').content, 'first');
  assert.deepEqual(context.summaries, ['obsolete']);
  assert.deepEqual(context.pinnedMessages, [1]);
  assert.equal(context._admittedSources, null);
  assert.ok(!JSON.stringify(saved).includes('second'));
  await runtime.sendMessage('undo', 'replacement');
  assert.ok(context.getHistoryMessages().some((m) => m.content === 'replacement'));
});

test('deleting a turn removes matching raw history and working messages, retains checkpoints and survives reload', async () => {
  const handlers = baseHandlers({ llmChat: llmScript([{ content: 'done' }]) });
  let saved;
  handlers.set('history:save', (_event, value) => {
    saved = value;
    return { ok: true };
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  await runtime.sendMessage('delete-turn', 'first');
  await runtime.sendMessage('delete-turn', 'second');
  const context = runtime.sessions.get('delete-turn').agent.contextManager;
  const first = context.getHistoryMessages().find((m) => m.role === 'user');
  context.messages = [
    {
      role: 'assistant',
      content: 'A preserved checkpoint',
      metadata: { kind: 'checkpoint', compactedIds: [first.metadata.messageId] },
    },
    ...context.messages.slice(2),
  ];
  const checkpoint = context.messages[0];
  const deleted = [];
  runtime.onEvent((event) => {
    if (event.type === 'messages-deleted') deleted.push(event);
  });
  assert.equal((await runtime.deleteTurn('delete-turn', 'unknown')).ok, false);
  const session = runtime.sessions.get('delete-turn');
  session.busy = true;
  assert.equal((await runtime.deleteTurn('delete-turn', first.metadata.messageId)).ok, false);
  session.busy = false;
  const result = await runtime.deleteTurn('delete-turn', first.metadata.messageId);
  assert.equal(result.ok, true);
  assert.equal(result.retainedInSummary, true);
  assert.equal(context.messages[0], checkpoint);
  assert.ok(!context.getHistoryMessages().some((m) => m.content === 'first'));
  assert.ok(context.getHistoryMessages().some((m) => m.content === 'second'));
  assert.equal(deleted.length, 1);
  assert.ok(result.view.displayMessages.every((m) => m.id));
  context.loadFromHistory(saved.messages, saved.workingContext);
  assert.equal(context.messages[0].content, 'A preserved checkpoint');
  assert.ok(!context.getHistoryMessages().some((m) => m.content === 'first'));
  const second = context.getHistoryMessages().find((m) => m.role === 'user');
  const raw = await runtime.deleteTurn('delete-turn', second.metadata.messageId);
  assert.equal(raw.retainedInSummary, false);
  assert.equal(context.messages.length, 1);
  assert.equal(context.getHistoryMessages().length, 0);
});

test('/undo stops an active turn and withdraws an unconsumed hot message without deleting the preceding turn', async () => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const handlers = baseHandlers({
    llmChat: async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true, data: { choices: [{ message: { content: 'late' } }] } };
    },
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(handlers),
    eventBus: createEventBus(),
  });
  const pending = runtime.sendMessage('hot-undo', 'original');
  await ready;
  await runtime.inject('hot-undo', 'keep this addition');
  await runtime.inject('hot-undo', 'withdraw this addition');
  const undo = runtime.undo('hot-undo');
  release();
  await pending;
  assert.equal((await undo).text, 'withdraw this addition');
  const history = runtime.sessions.get('hot-undo').agent.contextManager.getHistoryMessages();
  assert.ok(history.some((m) => m.content === 'original'));
  assert.ok(history.some((m) => m.content === 'keep this addition'));
  assert.ok(!history.some((m) => m.content === 'withdraw this addition'));
  assert.equal(runtime.getSession('hot-undo').busy, false);
});

test('shared settings hot updates reach headless Agents and preserve the web CodeOSS capability', async () => {
  const handlers = baseHandlers(),
    eventBus = createEventBus();
  let settings = structuredClone(SETTINGS);
  handlers.set('settings:get', async () => settings);
  handlers.set('settings:set', (_event, patch) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  const runtime = createAgentRuntime({ ipcMain: createFakeIpcMain(handlers), eventBus });
  const agent = runtime.createSession({ key: 'settings-hot' }).agent;
  await runtime.saveSettings({ tarotVisible: false, tools: { codeIDE: true } });
  assert.equal(agent.settings.tarotVisible, false);
  assert.equal(agent.settings.tools.codeIDE, true);
  settings = { ...settings, tarotVisible: true };
  eventBus.publish('settings:changed', { tarotVisible: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agent.settings.tarotVisible, true);
});
test('shared approval explicitly denies string responses and missing decisions', async () => {
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(baseHandlers()),
    eventBus: createEventBus(),
    getSettings: () => SETTINGS,
  });
  const session = runtime.createSession({ mode: 'chat' });
  for (const decision of ['denied', 'cancelled', null, false]) {
    const pending = runtime.requestPluginApproval({
      sessionKey: session.key,
      toolName: 'test-plugin',
    });
    runtime.respond(session.key, decision);
    assert.equal(await pending, 'denied');
  }
  const pending = runtime.requestPluginApproval({
    sessionKey: session.key,
    toolName: 'test-plugin',
  });
  runtime.respond(session.key, true);
  assert.equal(await pending, 'allowed-once');
  runtime.dispose();
});
test('mobile submissions acknowledge admission before inference, preserve task state and expose errors', async () => {
  let reject;
  const inference = new Promise((_resolve, failed) => {
    reject = failed;
  });
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(baseHandlers({ llmChat: () => inference })),
    eventBus: createEventBus(),
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
  });
  runtime.createSession({ key: 'mobile-admission', minimalMode: true });
  const accepted = await runtime.submitMessage('mobile-admission', 'Run the task');
  assert.equal(accepted.accepted, true);
  assert.equal(runtime.getSessionDetails(accepted.key).session.busy, true);
  reject(new Error('Fixture inference failed'));
  for (
    let attempt = 0;
    runtime.getSessionDetails(accepted.key).session.busy && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const state = runtime.getSessionDetails(accepted.key).session;
  assert.equal(state.busy, false);
  assert.equal(state.status, 'error');
  assert.match(state.lastError, /Fixture inference failed/);
  runtime.dispose();
});

test('reported provider failures remain visible after the Agent returns normally', async () => {
  const runtime = createAgentRuntime({
    ipcMain: createFakeIpcMain(
      baseHandlers({
        llmChat: async () => ({
          ok: false,
          error: 'Fixture unauthorized',
          kind: 'auth',
          status: 401,
        }),
      }),
    ),
    eventBus: createEventBus(),
    interactionPolicy: INTERACTION_POLICY.AUTO_APPROVE,
  });
  const session = runtime.createSession({ key: 'mobile-provider-error', minimalMode: true });
  await runtime.sendMessage(session.key, 'Run the task');
  const state = runtime.getSessionDetails(session.key).session;
  assert.equal(state.busy, false);
  assert.equal(state.status, 'error');
  assert.match(state.lastError, /Fixture unauthorized/);
  runtime.dispose();
});
