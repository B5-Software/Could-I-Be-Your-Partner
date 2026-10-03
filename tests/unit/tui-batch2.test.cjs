/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 覆盖：
 *   - 状态栏右置用量/成本（676.1K (64%) · $1.89，无价格不显示 $）
 *   - 推理块折叠/展开 + /thinking 全局切换
 *   - 滚轮滚动聊天记录（不触发历史调阅）
 *   - 日志隔离（console.* 与 stdout/stderr 写入进文件，不撕裂界面）
 *   - /vmdesk 命令（VM 未运行时给提示；有 runtime.openVmDesktop 时调用）
 *   - pricing 可用性缺失时的成本回退（costUSD = null）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const views = require(path.join(root, 'src/tui/views.js'));
const { stripAnsi, visibleWidth } = require(path.join(root, 'src/tui/ansi.js'));
const { themeFromEnv } = require(path.join(root, 'src/tui/theme.js'));
const { TuiApp } = require(path.join(root, 'src/tui/app.js'));

const theme = themeFromEnv({});

// ---------------- 状态栏用量/成本 ----------------

test('状态栏：右置 676.1K (64%) · $1.89，格式与 GUI 一致', () => {
  const line = stripAnsi(
    views.renderStatusLine(
      theme,
      {
        mode: 'chat',
        model: 'm',
        usage: { total: 700000 },
        context: { used: 676100, max: 1000000, reserve: 0, pct: 67.61, exact: true },
        costUSD: 1.89,
      },
      100,
    ),
  );
  assert.ok(line.includes('676.1K (68%)'), `用量数字错误: ${line}`);
  assert.ok(line.includes('$1.89'), `成本错误: ${line}`);
});

test('状态栏：M 单位两位小数；未配价格不显示 $', () => {
  assert.equal(views.fmtTokenCount(1200000), '1.20M');
  assert.equal(views.fmtTokenCount(999), '999');
  assert.equal(views.fmtCost(null), '');
  assert.equal(views.fmtCost(0), '');
  assert.equal(views.fmtCost(1.5), '$1.50');
  assert.equal(views.fmtCost(0.004), '$0.0040', '小于 1 美分保留更多小数');

  const line = stripAnsi(
    views.renderStatusLine(
      theme,
      {
        mode: 'chat',
        model: 'm',
        context: { used: 500, max: 1000, reserve: 0, pct: 50, exact: true },
        costUSD: 0,
      },
      100,
    ),
  );
  assert.ok(!line.includes('$'), `未配价不应显示 $: ${line}`);
});

test('状态栏：用量在最右侧（右对齐），窄屏降级不超宽', () => {
  const state = {
    theme,
    width: 60,
    height: 20,
    mode: 'chat',
    model: 'averylongmodelname-that-takes-space',
    messages: [],
    running: false,
    blink: true,
    spinnerFrame: 0,
    scrollOffset: 0,
    usage: { total: 1000 },
    context: { used: 800, max: 1000, reserve: 0, pct: 80, exact: true },
    costUSD: 0.5,
    editorText: '',
    editorCursor: 0,
  };
  const frame = views.composeFrame(state, { hints: [], inputHint: '' });
  const status = stripAnsi(frame.lines[frame.lines.length - 1]);
  assert.ok(visibleWidth(status) <= 60, `状态栏超宽: ${status}`);
  assert.ok(status.includes('80%'), `应显示占比: ${status}`);
});

// ---------------- 推理块 ----------------

test('推理块：折叠一行摘要（∴ 思考中 (320 字)），展开全文', () => {
  const reasoning = '第一步分析问题\n第二步制定方案\n' + 'x'.repeat(400);
  const collapsed = views
    .renderEntry(theme, { kind: 'assistant', text: '最终答案', reasoning }, 80, {
      thinkingExpanded: false,
    })
    .map(stripAnsi);
  assert.equal(collapsed.length, 2, `折叠应为 2 行（摘要+正文）: ${JSON.stringify(collapsed)}`);
  assert.ok(collapsed[0].includes('∴'), `应有思考标记: ${collapsed[0]}`);
  assert.ok(collapsed[0].includes('思考中'), `应有折叠提示: ${collapsed[0]}`);

  const expanded = views
    .renderEntry(theme, { kind: 'assistant', text: '最终答案', reasoning }, 80, {
      thinkingExpanded: true,
    })
    .map(stripAnsi);
  assert.ok(expanded.length > 4, `展开应有多行: ${expanded.length}`);
  assert.ok(
    expanded.some((l) => l.includes('第二步')),
    '展开应含全文',
  );
  assert.ok(expanded[expanded.length - 1].includes('最终答案'), '正文在最后');
});

test('/thinking 全局切换折叠/展开', async () => {
  const runtime = makeFakeRuntime();
  const app = new TuiApp({ runtime, theme, width: 100, height: 30, onQuit: () => {} });
  await app.start({ mode: 'chat' });
  assert.equal(app.state.thinkingExpanded, false);
  for (const ch of '/thinking') app.editor.insert(ch);
  await app.handleKey({ name: 'enter' });
  assert.equal(app.state.thinkingExpanded, true);
  // 推理事件挂到最近的助手消息
  await app.handleRuntimeEvent({
    type: 'assistant-reasoning',
    key: app.activeKey,
    data: { text: '我在思考这个问题' },
  });
  await app.settled();
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(text.includes('我在思考这个问题'), '推理内容应渲染');
  app.dispose();
});

function makeFakeRuntime() {
  const listeners = new Set();
  const sessions = new Map();
  const calls = [];
  return {
    calls,
    sessions,
    emit: (e) => [...listeners].forEach((l) => l(e)),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    createSession: (o) => (
      sessions.set(o.key, Object.assign({ title: '', busy: false, status: 'idle' }, o)),
      sessions.get(o.key)
    ),
    getSession: (k) => sessions.get(k) || null,
    listSessions: () => [...sessions.values()],
    sendMessage: async (k, t) => (calls.push(['sendMessage', k, t]), { ok: true }),
    respond: (k, r) => (calls.push(['respond', k, r]), { ok: true }),
    stop: (k) => (calls.push(['stop', k]), { ok: true }),
    getSettings: async () => ({ llm: { model: 'm' } }),
    listHistory: async () => [],
    getStats: () => null,
  };
}

// ---------------- 滚轮 ----------------

test('滚轮滚动聊天记录，不触发输入历史调阅', async () => {
  const { createKeyDecoder } = require(path.join(root, 'src/tui/keys.js'));
  const decoder = createKeyDecoder();
  const ESC = String.fromCharCode(27);
  const up = decoder.push(ESC + '[<64;10;5M');
  assert.equal(up.length, 1);
  assert.equal(up[0].name, 'wheel');
  assert.equal(up[0].direction, 'up');
  const down = decoder.push(ESC + '[<65;10;5M');
  assert.equal(down[0].direction, 'down');

  const runtime = makeFakeRuntime();
  const app = new TuiApp({ runtime, theme, width: 100, height: 30, onQuit: () => {} });
  await app.start({ mode: 'chat' });
  // 先堆够消息，让消息区可滚动
  for (let i = 0; i < 30; i += 1) {
    runtime.emit({ type: 'message', key: app.activeKey, role: 'assistant', content: '消息 ' + i });
  }
  await app.settled();
  for (const ch of '草稿') app.editor.insert(ch);
  await app.handleKey({ name: 'wheel', direction: 'up' });
  assert.ok(app.state.scrollOffset > 0, '滚轮上应滚动记录');
  assert.equal(app.editor.value, '草稿', '滚动不应改动输入框');
  await app.handleKey({ name: 'wheel', direction: 'down' });
  assert.equal(app.state.scrollOffset, 0);
  // 输入历史调阅只走 ↑↓/Ctrl+P/N
  await app.handleKey({ name: 'up' });
  app.dispose();
});

// ---------------- /vmdesk ----------------

test('/vmdesk：无 runtime.openVmDesktop 时给明确提示', async () => {
  const runtime = makeFakeRuntime();
  const app = new TuiApp({ runtime, theme, width: 100, height: 30, onQuit: () => {} });
  await app.start({ mode: 'chat' });
  for (const ch of '/vmdesk') app.editor.insert(ch);
  await app.handleKey({ name: 'enter' });
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(text.includes('VM 桌面'), `应有 VM 桌面提示: ${text.slice(-300)}`);
  app.dispose();
});

test('/vmdesk：有 API 时调用 graphics 并展示结果', async () => {
  const runtime = makeFakeRuntime();
  runtime.openVmDesktop = async () => ({ ok: true, url: 'ws://127.0.0.1:6080/?token=x' });
  const app = new TuiApp({ runtime, theme, width: 100, height: 30, onQuit: () => {} });
  await app.start({ mode: 'chat' });
  for (const ch of '/vmdesk') app.editor.insert(ch);
  await app.handleKey({ name: 'enter' });
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(text.includes('6080'), `应展示桌面地址: ${text.slice(-300)}`);
  app.dispose();
});

// ---------------- 启动屏（单渲染路径，防闪烁/防残留） ----------------

test('启动屏：boot 未就绪时整帧只画进度，不画输入框', () => {
  const state = {
    theme,
    width: 80,
    height: 24,
    mode: 'chat',
    messages: [{ kind: 'assistant', text: '不该出现' }],
    running: false,
    blink: true,
    spinnerFrame: 3,
    scrollOffset: 0,
    boot: { progress: 42, detail: '检查运行时资源' },
    editorText: '也不该出现',
    editorCursor: 5,
  };
  const frame = views.composeFrame(state, { hints: [], inputHint: '' });
  const text = stripAnsi(frame.lines.join('\n'));
  assert.ok(text.includes('正在启动虚拟机'), '应显示启动标题');
  assert.ok(text.includes('42%'), '应显示百分比');
  assert.ok(text.includes('检查运行时资源'), '应显示阶段文本');
  assert.ok(!text.includes('不该出现'), '进度屏不应渲染消息区');
  assert.ok(!text.includes('也不该出现'), '进度屏不应渲染输入框');
  for (const line of frame.lines) {
    assert.ok(visibleWidth(line) <= 80, `启动屏超宽: ${line}`);
  }
});

test('启动屏：boot 清掉后恢复主界面（单路径无交替）', async () => {
  const runtime = makeFakeRuntime();
  const app = new TuiApp({ runtime, theme, width: 100, height: 30, onQuit: () => {} });
  app.setBootStatus({ progress: 10, detail: 'x' });
  let text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(text.includes('正在启动虚拟机'));
  app.setBootStatus(null);
  await app.start({ mode: 'chat' });
  text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(!text.includes('正在启动虚拟机'), '清除后不应再画进度屏');
  assert.ok(text.includes('终端模式'), '应回到主界面');
  app.dispose();
});

// ---------------- 日志隔离 ----------------

test('日志隔离：console.* 与 stdout/stderr 写入进文件，不撕裂界面', async () => {
  const { installLogIsolation, createTerminalScreen } = require(
    path.join(root, 'src/tui/launch.js'),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-log-'));
  const logFile = path.join(dir, 'tui.log');
  const writes = [];
  const screen = createTerminalScreen({
    columns: 80,
    rows: 24,
    write: (t) => writes.push(t),
  });

  const guard = installLogIsolation(logFile, screen);
  console.log('网络日志不应该出现在界面');
  console.warn('LLM 日志不应该出现在界面');
  process.stdout.write('stdout garbage');
  process.stderr.write('stderr garbage');
  assert.equal(writes.length, 0, '隔离期间真实终端不应有写入');
  guard.restore();

  // createWriteStream 异步建文件：轮询等落盘
  let logged = '';
  for (let i = 0; i < 50 && logged === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      logged = fs.readFileSync(logFile, 'utf8');
    } catch {
      logged = '';
    }
  }
  assert.ok(logged.includes('网络日志不应该出现在界面'));
  assert.ok(logged.includes('stdout garbage'));
  // 屏幕渲染写入在 guarded 期间放行
  screen.render({ lines: ['hello'], cursor: { row: 1, col: 1 } });
  assert.ok(writes.length > 0, '界面渲染应正常输出');
});
