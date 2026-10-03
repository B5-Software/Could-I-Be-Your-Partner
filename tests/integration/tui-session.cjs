/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 集成测试：真实 Agent 运行时（Electron 主进程，全套 IPC handler）
 * + TuiApp（脚本化按键驱动），验证 Chat / Babe / Code 三种模式的完整链路：
 *
 *   Chat  ：对话一轮 → 流式/工具事件 → 历史落盘
 *   审批  ：危险命令 → TUI 审批弹窗 → y 允许 → 工具执行 → 继续对话
 *   Babe  ：好感度标记解析 → 好感度变化 → babe 历史落盘
 *   Code  ：工作区设置 → 代码工具 → 工作区代码历史落盘
 *
 * LLM 通过 undici fetch stub 伪造（net-proxy 会包装 global.fetch）。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const WEB_STUB_HOST = 'stub.local';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-tui-session-'));
fs.mkdirSync(path.join(profile, 'data'), { recursive: true });
fs.mkdirSync(path.join(profile, 'documents'));
app.setPath('userData', profile);
app.setPath('documents', path.join(profile, 'documents'));

const CODE_WORKSPACE = path.join(profile, 'documents', 'tui-code-ws');
fs.mkdirSync(CODE_WORKSPACE, { recursive: true });
fs.writeFileSync(
  path.join(profile, 'data/todos.json'),
  JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    counter: 1,
    items: [{ id: 1, text: 'Already saved todo', done: false }],
  }),
);

fs.writeFileSync(
  path.join(profile, 'data/settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    notifications: { enabled: false },
    runtime: { location: 'host' },
    closeToTray: 'never',
    trayEnabled: false,
    updates: { autoCheckEnabled: false },
    voice: { wakeEnabled: false },
    llm: {
      provider: 'openai',
      apiUrl: 'http://' + WEB_STUB_HOST + '/v1',
      apiKey: 'stub-key',
      model: 'stub-model',
      streamResponses: false,
      maxContextLength: 32768,
      maxResponseTokens: 1024,
    },
    babe: {
      name: '小助',
      initialAffection: 40,
      proactiveInterval: 0,
    },
    autoApproveSensitive: false,
  }),
);

process.argv.push('--headless');

// ---- LLM stub（打在 undici 上：net-proxy.install 会包装 global.fetch）----
const FAKE_TITLE = '测试会话';
const llmCalls = [];
const llmQueue = [];
let titleGate = null;
function pushReply(content, toolCalls, reasoning) {
  llmQueue.push({
    content: content || '',
    tool_calls: toolCalls || undefined,
    reasoning_content: reasoning,
  });
}
const realFetch = globalThis.fetch;
const fakeFetch = async (url, opts) => {
  const target = String(url && typeof url === 'object' && url.url ? url.url : url);
  if (target.includes(WEB_STUB_HOST) || target.includes('/chat/completions')) {
    let body = null;
    try {
      body = opts && opts.body ? JSON.parse(opts.body) : null;
    } catch {
      body = null;
    }
    llmCalls.push({ url: target, body });
    // 标题生成（temperature 0 / max_tokens 512）固定回标题
    const isTitle =
      opts &&
      opts.body &&
      JSON.parse(opts.body).temperature === 0 &&
      JSON.parse(opts.body).max_tokens === 512;
    if (isTitle && titleGate) await titleGate;
    const next = isTitle
      ? { content: FAKE_TITLE }
      : llmQueue.length > 0
        ? llmQueue.shift()
        : { content: '（无脚本回复）' };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        id: 'stub-1',
        model: 'stub-model',
        choices: [
          {
            index: 0,
            message: Object.assign({ role: 'assistant' }, next),
            finish_reason: next.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
      text: async () => '',
    };
  }
  if (target.startsWith('http://127.0.0.1:') || target.startsWith('http://localhost:')) {
    return realFetch(url, opts);
  }
  throw new Error('Network disabled in tui check: ' + target);
};
global.fetch = fakeFetch;
try {
  require('undici').fetch = fakeFetch;
} catch {
  /* 无 undici 时用 global.fetch */
}

// ---- 运行时 / TUI ----
const main = require('../../src/main/main.js');
const { TuiApp } = require('../../src/tui/app.js');
const { themeFromEnv } = require('../../src/tui/theme.js');
const { stripAnsi, visibleWidth } = require('../../src/tui/ansi.js');

let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) {
    console.error('[tui-session] FAILED:', error);
    app.exit(1);
    return;
  }
  console.log('[tui-session] OK');
  app.exit(0);
}

const timeout = setTimeout(() => finish(new Error('tui session check timed out')), 120000);

function frameText(tuiApp) {
  return stripAnsi(tuiApp.frame().lines.join('\n'));
}

async function waitFor(predicate, label, ms = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timeout waiting for ' + label);
}

function typeText(tuiApp, text) {
  for (const char of text) tuiApp.editor.insert(char);
}

async function waitForRuntime() {
  return waitFor(() => main.getAgentRuntime(), 'agent runtime', 60000);
}

async function run() {
  assert.equal(BrowserWindow.getAllWindows().length, 0, '无头模式不应创建窗口');
  const runtime = await waitForRuntime();

  const tuiApp = new TuiApp({
    runtime,
    theme: themeFromEnv(),
    width: 100,
    height: 30,
    onQuit: () => {},
  });
  await tuiApp.start({ mode: 'chat' });
  assert.equal(
    tuiApp.state.todos[0].text,
    'Already saved todo',
    'TUI loads saved todos before the first message',
  );
  await tuiApp.handleKey({ name: 'char', char: 't', ctrl: true });
  await runtime.api.todoMutate({ action: 'toggle', id: 1 });
  await tuiApp.settled();
  assert.ok(
    frameText(tuiApp).includes('[x] 1. Already saved todo'),
    'An open Todo panel updates live',
  );
  await tuiApp.handleKey({ name: 'escape' });
  await tuiApp.newSession('chat');
  assert.equal(tuiApp.state.todos[0].done, true, 'Todos remain global across sessions');

  // ---- 1. Chat：一轮完整对话 ----
  let releaseTitle;
  titleGate = new Promise((resolve) => {
    releaseTitle = resolve;
  });
  pushReply('你好，这是 TUI 集成测试回复', undefined, '先思考第一轮问题。\n完整保留推理末尾。');
  typeText(tuiApp, '你好，测试一下');
  const firstTurn = tuiApp.handleKey({ name: 'enter' });
  await waitFor(
    () => tuiApp.state.messages.some((entry) => entry.kind === 'tarot'),
    'first Fate Card',
  );
  assert.equal(runtime.getSession(tuiApp.activeKey).status, 'running');
  assert.equal(tuiApp.state.running, true, 'Fate Card cannot hide the active-work indicator');
  assert.ok(
    frameText(tuiApp).includes('思考中'),
    'Spinner stays visible while title/model requests wait',
  );
  releaseTitle();
  titleGate = null;
  await firstTurn;
  await tuiApp.settled();
  assert.equal(tuiApp.state.running, false, 'Spinner stops after the actual Agent turn completes');
  let text = frameText(tuiApp);
  assert.ok(text.includes('你好，测试一下'), '用户消息应渲染');
  assert.ok(text.includes('TUI 集成测试回复'), '助手回复应渲染');
  assert.ok(
    text.includes('完整保留推理末尾。'),
    'Non-streaming string reasoning is displayed completely',
  );
  assert.ok(text.includes('思考：'));
  assert.ok(!text.includes('思考中'), 'Completed reasoning is not labelled as ongoing work');
  assert.ok(text.includes('❯'), '输入框应有指针（设计元素）');
  assert.ok(text.includes('│'), '状态栏应有分隔符（设计元素）');

  const chatHistory = await runtime.listHistory('chat');
  assert.ok(Array.isArray(chatHistory), 'chat 历史可读');

  // ---- 2. 审批：危险命令 → 弹窗 → y 允许 ----
  pushReply('', [
    {
      id: 'c1',
      type: 'function',
      function: {
        name: 'runTerminalCommand',
        arguments: JSON.stringify({ id: 'no-such-term', command: 'rm -rf /tmp/tui-danger' }),
      },
    },
  ]);
  llmQueue[0].reasoning_content = '本轮先检查危险命令的审批要求。';
  pushReply('已按你的要求执行');
  typeText(tuiApp, '删掉那个临时目录');
  const pending = tuiApp.handleKey({ name: 'enter' });
  const modal = await waitFor(
    () =>
      tuiApp.state.modal && tuiApp.state.modal.kind === 'approval' ? tuiApp.state.modal : null,
    'approval modal',
  );
  assert.ok(modal.title.includes('工具执行确认'));
  assert.ok(frameText(tuiApp).includes('rm -rf /tmp/tui-danger'), '弹窗应展示命令内容');
  await tuiApp.handleKey({ name: 'char', char: 'y' });
  await pending;
  await tuiApp.settled();
  text = frameText(tuiApp);
  assert.ok(text.includes('已按你的要求执行'), '批准后应继续对话');
  assert.ok(
    tuiApp.state.messages.some((entry) => entry.reasoning === '本轮先检查危险命令的审批要求。'),
    'Tool-only replies preserve non-streaming reasoning',
  );

  // ---- 3. Babe：好感度 + babe 历史 ----
  typeText(tuiApp, '/mode babe');
  await tuiApp.handleKey({ name: 'enter' });
  await tuiApp.settled();
  assert.equal(tuiApp.state.mode, 'babe');
  assert.equal(tuiApp.state.affection, 40, '初始好感度取 settings.babe.initialAffection');
  assert.ok(frameText(tuiApp).includes('♥ 40'), '状态栏应显示好感度（设计元素）');

  pushReply('今天也要加油哦【好感度+3】');
  typeText(tuiApp, '在吗');
  await tuiApp.handleKey({ name: 'enter' });
  await tuiApp.settled();
  assert.equal(tuiApp.state.affection, 43, '好感度应随标记 +3');
  text = frameText(tuiApp);
  assert.ok(text.includes('今天也要加油哦'), '好感度标记应从正文剥离后渲染');

  const babeHistory = await runtime.listHistory('babe');
  assert.ok(Array.isArray(babeHistory), 'babe 历史可读');

  // ---- 4. Code：工作区 + 代码历史（纯 Agent，不接 CodeOSS）----
  typeText(tuiApp, '/mode code');
  await tuiApp.handleKey({ name: 'enter' });
  await tuiApp.settled();
  assert.ok(tuiApp.state.workspace, 'Code must have a workspace before the first message');
  assert.match(path.basename(tuiApp.state.workspace), /^[a-f0-9]{16}$/);
  assert.ok(fs.statSync(tuiApp.state.workspace).isDirectory());
  typeText(tuiApp, '/workspace ' + CODE_WORKSPACE);
  await tuiApp.handleKey({ name: 'enter' });
  await tuiApp.settled();
  assert.equal(tuiApp.state.workspace, CODE_WORKSPACE);
  assert.ok(frameText(tuiApp).includes(CODE_WORKSPACE), '状态栏应显示工作区');

  pushReply('', [
    {
      id: 'code-create',
      type: 'function',
      function: {
        name: 'createFile',
        arguments: JSON.stringify({ path: 'hello.txt', content: 'TUI workspace verified' }),
      },
    },
  ]);
  pushReply('已在工作区创建文件');
  typeText(tuiApp, '建一个 hello.txt');
  await tuiApp.handleKey({ name: 'enter' });
  await tuiApp.settled();
  assert.ok(frameText(tuiApp).includes('已在工作区创建文件'));
  assert.equal(runtime.getSession(tuiApp.activeKey).workspacePath, CODE_WORKSPACE);
  assert.equal(
    fs.readFileSync(path.join(CODE_WORKSPACE, 'hello.txt'), 'utf8'),
    'TUI workspace verified',
  );

  const codeHistory = await runtime.listHistory('code', CODE_WORKSPACE);
  assert.ok(Array.isArray(codeHistory), 'code 历史可读');
  assert.ok(codeHistory.length > 0, 'code 会话应落盘到工作区历史');

  // ---- 5. 设计元素与排版自检 ----
  const lines = tuiApp.frame().lines.map(stripAnsi);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 100, '帧行不应超宽: ' + line);
  }
  assert.ok(llmCalls.length >= 3, '应发起多轮 LLM 调用');

  clearTimeout(timeout);
  finish();
}

app
  .whenReady()
  .then(() => run())
  .catch((error) => finish(error));

process.on('uncaughtException', (error) => finish(error));
process.on('unhandledRejection', (error) =>
  finish(error instanceof Error ? error : new Error(String(error))),
);
