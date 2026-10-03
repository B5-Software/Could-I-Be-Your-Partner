/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 应用状态机测试：键事件 + Agent 运行时事件 → 视图/命令/应答。
 * 用假 runtime 驱动，覆盖 Chat/Babe/Code 三种模式的关键交互。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TuiApp } = require('../../src/tui/app.js');
const { createKeyDecoder } = require('../../src/tui/keys.js');
const { stripAnsi, visibleWidth } = require('../../src/tui/ansi.js');
const { themeFromEnv } = require('../../src/tui/theme.js');

function makeFakeRuntime() {
  const listeners = new Set();
  const sessions = new Map();
  const calls = [];
  return {
    calls,
    sessions,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    createSession(opts) {
      sessions.set(opts.key, Object.assign({ title: '', busy: false, status: 'idle' }, opts));
      return sessions.get(opts.key);
    },
    getSession(key) {
      return sessions.get(key) || null;
    },
    listSessions() {
      calls.push(['listSessions']);
      return [...sessions.values()];
    },
    async sendMessage(key, text, attachments) {
      calls.push(['sendMessage', key, text, attachments]);
      return { ok: true };
    },
    async inject(key, text, attachments) {
      calls.push(['inject', key, text, attachments]);
      return { ok: true };
    },
    respond(key, response) {
      calls.push(['respond', key, response]);
      return { ok: true };
    },
    stop(key) {
      calls.push(['stop', key]);
      return { ok: true };
    },
    close(key) {
      calls.push(['close', key]);
      return { ok: true };
    },
    async setTitle(key, title) {
      calls.push(['setTitle', key, title]);
      return { ok: true };
    },
    setWorkspace(key, workspacePath) {
      calls.push(['setWorkspace', key, workspacePath]);
      return { ok: true };
    },
    async getSettings() {
      return {
        llm: {
          model: 'stub-model',
          provider: 'stub',
          pool: [{ model: 'stub-mini', enabled: true }],
        },
        babe: { initialAffection: 42 },
      };
    },
    async listHistory(mode) {
      calls.push(['listHistory', mode]);
      return [{ id: 'h1', title: '历史一', date: '2026-01-01' }];
    },
    async deleteHistory(mode, id) {
      calls.push(['deleteHistory', mode, id]);
      return { ok: true };
    },
    async renameHistory(mode, id, title) {
      calls.push(['renameHistory', mode, id, title]);
      return { ok: true };
    },
    async openHistory(key, id) {
      calls.push(['openHistory', key, id]);
      return {
        ok: true,
        id,
        title: '历史一',
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好呀' },
        ],
      };
    },
    getStats() {
      return {
        usage: { prompt: 120, completion: 60, total: 180 },
        context: { used: 1500, max: 32000 },
        affection: 30,
      };
    },
  };
}

async function makeApp(options = {}) {
  const runtime = makeFakeRuntime();
  const quits = [];
  const app = new TuiApp({
    runtime,
    theme: themeFromEnv(),
    width: 100,
    height: 30,
    onQuit: () => quits.push(true),
  });
  await app.start({ mode: options.mode || 'chat', workspacePath: options.workspacePath });
  return { app, runtime, quits };
}

function frameText(app) {
  return stripAnsi(app.frame().lines.join('\n'));
}

function typeText(app, text) {
  for (const char of text) app.editor.insert(char);
}

// ---------------- 启动与渲染 ----------------

test('tui：启动创建会话并渲染欢迎语与状态栏', async () => {
  const { app, runtime } = await makeApp();
  assert.ok(app.activeKey, '应有活动会话');
  assert.equal(runtime.sessions.get(app.activeKey).mode, 'chat');
  const text = frameText(app);
  assert.ok(text.includes('Chat'), '状态栏应显示模式');
  assert.ok(text.includes('终端模式'), '应有欢迎提示');
  assert.ok(text.includes('❯'), '输入框应有指针前缀');
});

test('tui：发送消息 → 调用 runtime 并渲染用户气泡', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '帮我看看这个文件');
  await app.handleKey({ name: 'enter' });
  const sent = runtime.calls.find((c) => c[0] === 'sendMessage');
  assert.ok(sent, '应调用 sendMessage');
  assert.equal(sent[2], '帮我看看这个文件');
  runtime.emit({ type: 'message', key: app.activeKey, role: 'user', content: '帮我看看这个文件' });
  await app.settled();
  const text = frameText(app);
  assert.ok(text.includes('帮我看看这个文件'), '用户消息应渲染');
});

test('tui：流式回复累积并渲染', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({ type: 'stream-start', key: app.activeKey, data: {} });
  runtime.emit({ type: 'stream-chunk', key: app.activeKey, data: { content: '你好，' } });
  runtime.emit({ type: 'stream-chunk', key: app.activeKey, data: { content: '我是助手。' } });
  await app.settled();
  assert.ok(frameText(app).includes('你好，我是助手。'));
  runtime.emit({ type: 'stream-end', key: app.activeKey, data: { content: '你好，我是助手。' } });
  await app.settled();
  assert.ok(frameText(app).includes('我是助手。'));
});

test('tui：工具调用卡片（运行中 ● → 完成 ⎿ 结果）', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({
    type: 'tool-call',
    key: app.activeKey,
    name: 'readFile',
    args: { path: '/tmp/a.txt' },
    status: 'running',
    callId: 'c1',
  });
  await app.settled();
  let text = frameText(app);
  assert.ok(text.includes('readFile'), '应显示工具名');
  assert.ok(text.includes('/tmp/a.txt'), '应显示参数摘要');
  assert.ok(text.includes('执行中'), '运行中应有占位');

  runtime.emit({
    type: 'tool-call',
    key: app.activeKey,
    name: 'readFile',
    status: 'done',
    result: '{"ok":true,"content":"hi"}',
    callId: 'c1',
  });
  await app.settled();
  text = frameText(app);
  assert.ok(text.includes('⎿'), '完成应有结果前缀');
  assert.ok(text.includes('"ok":true'), '应显示结果');
});

// ---------------- 交互：审批 / 授权 / 提问 ----------------

test('tui：危险操作弹审批框，y 允许 / n 拒绝 / Esc 取消', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'approval',
    payload: { toolName: 'runTerminalCommand', args: { command: 'rm -rf /tmp/x' } },
  });
  await app.settled();
  assert.equal(app.state.modal.kind, 'approval');
  assert.ok(frameText(app).includes('工具执行确认'));

  await app.handleKey({ name: 'char', char: 'y' });
  assert.equal(app.state.modal, null);
  assert.deepEqual(runtime.calls.at(-1), ['respond', app.activeKey, true]);

  // 拒绝路径
  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'approval',
    payload: { toolName: 'deleteFile', args: {} },
  });
  await app.settled();
  await app.handleKey({ name: 'char', char: 'n' });
  assert.deepEqual(runtime.calls.at(-1), ['respond', app.activeKey, false]);

  // Esc 取消 = 拒绝
  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'approval',
    payload: { toolName: 'deleteFile', args: {} },
  });
  await app.settled();
  await app.handleKey({ name: 'escape' });
  assert.deepEqual(runtime.calls.at(-1), ['respond', app.activeKey, false]);
});

test('tui：工具授权三态（a 总是允许 / Esc 拒绝）', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'tool-auth',
    payload: { toolName: 'openBrowser', category: 'playwright' },
  });
  await app.settled();
  assert.equal(app.state.modal.kind, 'toolAuth');
  await app.handleKey({ name: 'char', char: 'a' });
  assert.deepEqual(runtime.calls.at(-1), ['respond', app.activeKey, 'allow-always']);

  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'tool-auth',
    payload: { toolName: 'takeScreenshot', category: 'computerUse' },
  });
  await app.settled();
  await app.handleKey({ name: 'escape' });
  assert.deepEqual(runtime.calls.at(-1), ['respond', app.activeKey, 'deny']);
});

test('tui：提问（选项式与自由文本）返回 answers 数组', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({
    type: 'interaction',
    key: app.activeKey,
    kind: 'questions',
    payload: {
      questions: [{ question: '选哪个？', options: ['甲', '乙'] }, { question: '补充说明' }],
    },
  });
  await app.settled();
  assert.equal(app.state.modal.kind, 'ask');
  // 选择第 2 项
  await app.handleKey({ name: 'down' });
  await app.handleKey({ name: 'enter' });
  // 第二题自由文本
  assert.equal(app.state.modal.kind, 'ask');
  assert.equal(app.state.modal.inputMode, true);
  for (const char of '没问题') app.state.modal.editor.insert(char);
  await app.handleKey({ name: 'enter' });
  assert.equal(app.state.modal, null);
  const answered = runtime.calls.at(-1);
  assert.equal(answered[0], 'respond');
  assert.deepEqual(answered[2], { answers: ['乙', '没问题'] });
});

// ---------------- 模式：Chat / Babe / Code ----------------

test('tui：/mode babe 切换 Babe 会话并显示好感度', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '/mode babe');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.equal(app.state.mode, 'babe');
  assert.equal(runtime.sessions.get(app.activeKey).mode, 'babe');
  assert.equal(app.state.affection, 42, '初始好感度取 settings.babe.initialAffection');
  assert.ok(frameText(app).includes('♥ 42'), '状态栏应显示好感度');

  runtime.emit({ type: 'affection-change', key: app.activeKey, data: { delta: 5, value: 47 } });
  await app.settled();
  assert.equal(app.state.affection, 47);
  assert.ok(frameText(app).includes('好感度 +5'), '好感度变化应有提示');
});

test('tui：/mode code 切换 Code 会话并支持工作区', async () => {
  const { app, runtime } = await makeApp({ mode: 'code', workspacePath: 'C:/proj' });
  assert.equal(app.state.mode, 'code');
  assert.equal(runtime.sessions.get(app.activeKey).workspacePath, 'C:/proj');
  assert.ok(frameText(app).includes('C:/proj'), '状态栏应显示工作区');

  typeText(app, '/workspace D:/other');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.deepEqual(runtime.calls.at(-1), ['setWorkspace', app.activeKey, 'D:/other']);
  assert.equal(app.state.workspace, 'D:/other');
});

test('tui：Shift+Tab 循环切换模式', async () => {
  const { app } = await makeApp();
  await app.handleKey({ name: 'tab', shift: true });
  await app.settled();
  assert.equal(app.state.mode, 'babe');
  await app.handleKey({ name: 'tab', shift: true });
  await app.settled();
  assert.equal(app.state.mode, 'code');
  await app.handleKey({ name: 'tab', shift: true });
  await app.settled();
  assert.equal(app.state.mode, 'chat');
});

// ---------------- 命令 ----------------

test('tui：/help 打开命令表，Esc 关闭', async () => {
  const { app } = await makeApp();
  typeText(app, '/help');
  await app.handleKey({ name: 'enter' });
  assert.equal(app.state.modal.kind, 'help');
  const text = frameText(app);
  assert.ok(text.includes('命令表'));
  assert.ok(text.includes('/sessions'));
  await app.handleKey({ name: 'escape' });
  assert.equal(app.state.modal, null);
});

test('tui：/sessions 与 /history 打开选择器并可载入', async () => {
  const { app, runtime } = await makeApp();
  // /history → 选择第一条 → openHistory
  typeText(app, '/history');
  await app.handleKey({ name: 'enter' });
  assert.equal(app.state.modal.kind, 'history');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(runtime.calls.some((c) => c[0] === 'openHistory' && c[2] === 'h1'));
  const text = frameText(app);
  assert.ok(text.includes('历史一'));
  assert.ok(text.includes('你好呀'), '历史消息应渲染');

  // /sessions → 选择当前会话
  typeText(app, '/sessions');
  await app.handleKey({ name: 'enter' });
  assert.equal(app.state.modal.kind, 'sessions');
  await app.handleKey({ name: 'escape' });
  assert.equal(app.state.modal, null);
});

test('tui：/rename /delete /attach /usage /model /compact', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '/rename 新标题');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.deepEqual(runtime.calls.at(-1), ['setTitle', app.activeKey, '新标题']);
  assert.equal(app.state.title, '新标题');

  typeText(app, '/delete h2');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.deepEqual(runtime.calls.at(-1), ['deleteHistory', 'chat', 'h2']);

  typeText(app, '/attach /tmp/report.pdf');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.equal(app.attachments.length, 1);

  typeText(app, '/usage');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(frameText(app).includes('prompt 120'), '应展示用量');

  typeText(app, '/model');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(frameText(app).includes('stub-model'), '应展示模型');

  typeText(app, '/compact');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  const last = runtime.calls.at(-1);
  assert.equal(last[0], 'sendMessage');
  assert.ok(last[2].includes('压缩上下文'));
});

test('tui：未知命令给出提示', async () => {
  const { app } = await makeApp();
  typeText(app, '/nosuchcmd');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(frameText(app).includes('未知命令'));
});

test('tui：/quit 触发退出回调', async () => {
  const { app, quits } = await makeApp();
  typeText(app, '/quit');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.equal(quits.length, 1);
});

// ---------------- 全局键 ----------------

test('tui：Ctrl+C 先停止任务，空闲时两次才退出', async () => {
  const { app, runtime, quits } = await makeApp();
  // 运行中：Ctrl+C = 停止
  runtime.emit({ type: 'status', key: app.activeKey, status: 'running' });
  await app.settled();
  await app.handleKey({ name: 'char', char: 'c', ctrl: true });
  assert.ok(runtime.calls.some((c) => c[0] === 'stop'));

  // 空闲：第一次武装，3 秒内第二次退出
  runtime.emit({ type: 'status', key: app.activeKey, status: 'idle' });
  await app.settled();
  await app.handleKey({ name: 'char', char: 'c', ctrl: true });
  assert.equal(quits.length, 0);
  assert.ok(frameText(app).includes('再按一次'), '应有二次确认提示');
  await app.handleKey({ name: 'char', char: 'c', ctrl: true });
  assert.equal(quits.length, 1);
});

test('tui：Ctrl+T 待办面板 · PgUp/PgDn 滚动', async () => {
  const { app, runtime } = await makeApp();
  runtime.emit({
    type: 'todo',
    key: app.activeKey,
    items: [
      { text: '写测试', done: true },
      { text: '做设计', done: false },
    ],
  });
  await app.settled();
  await app.handleKey({ name: 'char', char: 't', ctrl: true });
  assert.equal(app.state.modal.kind, 'todo');
  const text = frameText(app);
  assert.ok(text.includes('[x] 1. 写测试'));
  assert.ok(text.includes('[ ] 2. 做设计'));
  await app.handleKey({ name: 'escape' });

  await app.handleKey({ name: 'pageup' });
  assert.ok(app.state.scrollOffset > 0);
  await app.handleKey({ name: 'pagedown' });
  assert.equal(app.state.scrollOffset, 0);
});

test('tui：Esc 在运行中请求停止，空闲时清空输入', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '草稿');
  await app.handleKey({ name: 'escape' });
  assert.equal(app.editor.value, '');
  runtime.emit({ type: 'status', key: app.activeKey, status: 'running' });
  await app.settled();
  await app.handleKey({ name: 'escape' });
  assert.ok(runtime.calls.some((c) => c[0] === 'stop'));
});

test('tui：输入 / 时补全面板给出命令建议', async () => {
  const { app } = await makeApp();
  typeText(app, '/hi');
  const frame = app.frame();
  const text = stripAnsi(frame.lines.join('\n'));
  assert.ok(text.includes('/history'), '补全面板应给出 /history 建议');
  assert.ok(app.state.completion && app.state.completion.kind === 'command');
  assert.ok(text.includes('tab 补全'), '应有补全操作提示');
});

test('tui：补全面板 ↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '/st');
  assert.equal(app.frame().lines.length > 0, true);
  assert.equal(app.state.completion.selected, 0);

  await app.handleKey({ name: 'down' });
  assert.equal(app.state.completion.selected, 1, '↓ 应移动选择');

  await app.handleKey({ name: 'tab' });
  assert.ok(app.editor.value.startsWith('/'), 'Tab 应把选中命令写回输入框');
  assert.equal(app.state.completion, null, '接受后面板关闭');

  // Esc 关闭后同一段文本不再弹出
  app.editor.setValue('/hi');
  app.frame();
  assert.ok(app.state.completion, '重新输入应再弹出');
  await app.handleKey({ name: 'escape' });
  assert.equal(app.state.completion, null);
  app.frame();
  assert.equal(app.state.completion, null, 'Esc 后同文本不弹回');

  // Enter：补全并执行选中命令（用未被 Esc 关闭过的新前缀）
  app.editor.setValue('/sess');
  app.frame();
  assert.ok(app.state.completion, '/sess 应弹出补全');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(
    runtime.calls.some((c) => c[0] === 'listSessions'),
    '回车应补全并执行选中的 /sessions',
  );
  assert.equal(app.state.modal && app.state.modal.kind, 'sessions', '应打开会话选择器');
});

test('tui：/mode 无参数弹出模式选择器并可切换', async () => {
  const { app, runtime } = await makeApp();
  typeText(app, '/mode');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.equal(app.state.modal.kind, 'mode');
  const text = frameText(app);
  assert.ok(text.includes('Babe · 陪伴模式'), '选择器应列出模式');
  // 选中第二项（babe）
  await app.handleKey({ name: 'down' });
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.equal(app.state.mode, 'babe');
  assert.equal(runtime.sessions.get(app.activeKey).mode, 'babe');
});

test('tui：自定义命令（.md 文件）可补全、可执行、支持参数占位', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, runtime } = await makeApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-cmds-'));
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'commands', 'commit.md'),
    '---\ndescription: 整理并提交改动\n---\n请把工作区改动整理成一次提交。$ARGUMENTS\n',
  );
  app.env = { CIBYP_USER_DATA: dir };
  app._reloadCustomCommands();
  assert.ok(app.customCommands.has('commit'), '应加载自定义命令');

  // 补全
  typeText(app, '/com');
  const completion = app.frame().lines.join('\n');
  assert.ok(stripAnsi(completion).includes('/commit'), '补全面板应包含自定义命令');

  // 执行：正文 + 参数替换
  app.editor.setValue('/commit 先跑测试');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  const sent = runtime.calls.filter((c) => c[0] === 'sendMessage').at(-1);
  assert.ok(sent, '自定义命令应发送提示词');
  assert.ok(sent[2].includes('请把工作区改动整理成一次提交'));
  assert.ok(sent[2].includes('先跑测试'), '$ARGUMENTS 应替换为参数');

  // /commands 列出
  typeText(app, '/commands');
  await app.handleKey({ name: 'enter' });
  await app.settled();
  assert.ok(frameText(app).includes('/commit'), '/commands 应列出自定义命令');
});

test('tui：参数补全（/mode 后给模式建议）', async () => {
  const { app } = await makeApp();
  typeText(app, '/mode ch');
  app.frame();
  assert.equal(app.state.completion.kind, 'arg');
  const labels = app.state.completion.items.map((i) => i.label);
  assert.deepEqual(labels, ['chat'], '应按前缀过滤模式');
  await app.handleKey({ name: 'tab' });
  assert.equal(app.editor.value, '/mode chat ', 'Tab 应补全参数');
});

test('tui：窄终端下渲染不超宽', async () => {
  const { app, runtime } = await makeApp();
  app.resize(48, 16);
  runtime.emit({
    type: 'message',
    key: app.activeKey,
    role: 'assistant',
    content: '这是一段需要换行的中文回复，用来验证窄终端排版。',
  });
  await app.settled();
  const lines = app.frame().lines.map(stripAnsi);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 48, `窄终端超宽: ${visibleWidth(line)} > 48（${line}）`);
  }
});

test('tui：原始按键字节 → 解码器 → 应用（契约一致性，回归：Ctrl+ 组合键失效）', async () => {
  const { app, runtime, quits } = await makeApp();
  const decoder = createKeyDecoder();
  const feed = async (bytes) => {
    for (const key of decoder.push(bytes)) {
      await app.handleKey(key);
    }
  };

  // 键入文本 + 回车（原始字节）→ 应触发发送
  await feed('hi');
  await feed(String.fromCharCode(13));
  const sent = runtime.calls.find((c) => c[0] === 'sendMessage');
  assert.ok(sent, '原始回车字节应触发发送');
  assert.equal(sent[2], 'hi');

  // Ctrl+C 两次（原始 0x03）→ 应触发退出（回归点：解码器与应用的键形状必须一致）
  await feed(String.fromCharCode(3));
  assert.equal(quits.length, 0, '第一次 Ctrl+C 只武装退出');
  await feed(String.fromCharCode(3));
  assert.equal(quits.length, 1, '第二次 Ctrl+C 应退出');

  // Ctrl+T 打开待办（同样是组合键契约）
  await feed(String.fromCharCode(20));
  assert.equal(app.state.modal && app.state.modal.kind, 'todo', 'Ctrl+T 应打开待办面板');
});
