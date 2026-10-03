/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { TuiApp } = require('../../src/tui/app');
const { createKeyDecoder } = require('../../src/tui/keys');
const { themeFromSettings, contrastRatio } = require('../../src/tui/theme');
const { stripAnsi, visibleWidth, RESET, colorCode } = require('../../src/tui/ansi');
const { createTerminalScreen } = require('../../src/tui/launch');
const { loadSettings, mergeSettings } = require('../../src/main/settings/merge');
const { openDirectory } = require('../../src/main/services/open-directory');

function fixture(initial = {}) {
  let settings = { tui: { followGuiTheme: true, thinkingExpanded: true }, ...initial };
  let todos = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    text: 'Task ' + (i + 1),
    done: false,
  }));
  const sessions = new Map(),
    listeners = new Set();
  const runtime = {
    getSettings: async () => settings,
    getSystemTheme: async () => ({ shouldUseDarkColors: true }),
    saveSettings: async (patch) => {
      settings = mergeSettings(settings, patch);
      return settings;
    },
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    createSession: (session) => {
      sessions.set(session.key, session);
      return session;
    },
    getSession: (key) => sessions.get(key),
    stop: () => {},
    getTodos: async () => structuredClone(todos),
    toggleTodo: async (id) => {
      todos = todos.map((item) => (item.id === id ? { ...item, done: !item.done } : item));
      runtime.emit({ type: 'todo', items: structuredClone(todos) });
      return { ok: true };
    },
  };
  return runtime;
}
async function send(app, bytes) {
  for (const key of createKeyDecoder().push(bytes)) await app.handleKey(key);
}

test('GUI and TUI edit one persisted preference group across sessions and restart', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-tui-shared-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'settings.json');
  const runtime = fixture({
    theme: { mode: 'light', backgroundColor: '#f5f7fa', accentColor: '#778899' },
  });
  const save = runtime.saveSettings;
  runtime.saveSettings = async (patch) => {
    const value = await save(patch);
    await fs.writeFile(file, JSON.stringify(value));
    return value;
  };
  const app = new TuiApp({ runtime, env: {}, width: 90, height: 30 });
  await app.start();
  await send(app, '/theme off\r');
  await send(app, '/thinking\r');
  assert.equal(app.theme.name, 'terminal');
  assert.equal(app.state.thinkingExpanded, false);
  await app.newSession('code');
  assert.equal(app.state.thinkingExpanded, false);
  const saved = JSON.parse(await fs.readFile(file));
  assert.deepEqual(saved.tui, { followGuiTheme: false, thinkingExpanded: false });
  assert.deepEqual(saved.theme, {
    mode: 'light',
    backgroundColor: '#f5f7fa',
    accentColor: '#778899',
  });
  const next = new TuiApp({ runtime: fixture(saved), env: {}, width: 90, height: 30 });
  await next.start();
  assert.equal(next.theme.name, 'terminal');
  assert.equal(next.state.thinkingExpanded, false);
  await runtime.saveSettings({ tui: { followGuiTheme: true, thinkingExpanded: true } });
  runtime.emit({ type: 'settingsChanged' });
  await app.settled();
  assert.equal(app.theme.background, 'rgb(245,247,250)');
  assert.equal(app.state.thinkingExpanded, true);
  await send(app, '/theme nonsense\r');
  assert.equal((await runtime.getSettings()).tui.followGuiTheme, true);
  app.dispose();
  next.dispose();
});

test('legacy reasoning preference migrates without overriding explicit GUI preferences', () => {
  const defaults = { tui: { followGuiTheme: true, thinkingExpanded: true } };
  assert.equal(loadSettings(defaults, {}, { thinkingExpanded: false }).tui.thinkingExpanded, false);
  assert.deepEqual(
    loadSettings(
      defaults,
      { tui: { thinkingExpanded: true, followGuiTheme: false } },
      { thinkingExpanded: false },
    ).tui,
    { thinkingExpanded: true, followGuiTheme: false },
  );
});

test('mode colors and gray text stay readable on light, dark and custom backgrounds', () => {
  for (const backgroundColor of [
    '#10131a',
    '#ffffff',
    '#f5f7fa',
    '#787878',
    '#ab55bb',
    '#073c34',
  ]) {
    for (const mode of ['dark', 'light', 'system']) {
      const theme = themeFromSettings(
        { theme: { mode, backgroundColor, accentColor: backgroundColor } },
        {},
      );
      for (const key of [
        'text',
        'subtle',
        'inactive',
        'accent',
        'suggestion',
        'planMode',
        'bashBorder',
      ])
        assert.ok(contrastRatio(theme[key], theme.background) >= 4.5, `${backgroundColor}: ${key}`);
      for (const key of ['selectionBg', 'userMessageBackground', 'memoryBackground'])
        assert.ok(contrastRatio(theme.text, theme[key]) >= 4.5, `${backgroundColor}: ${key} fill`);
    }
  }
  assert.equal(
    themeFromSettings({ tui: { followGuiTheme: false }, theme: { backgroundColor: '#ffffff' } }, {})
      .background,
    null,
  );
});

test('screen paints the whole background, restores base colors after nested resets and resets on exit', () => {
  let output = '';
  const screen = createTerminalScreen({ columns: 50, rows: 8, write: (text) => (output += text) });
  const palette = { foreground: 'rgb(20,21,22)', background: 'rgb(240,241,242)' };
  screen.render({ lines: ['hello' + RESET + 'after', ''], palette });
  const base = colorCode(palette.foreground) + colorCode(palette.background, true);
  assert.ok(output.includes(RESET + base + '\x1b[2Khello'));
  assert.ok(output.includes('hello' + RESET + base + 'after'));
  assert.ok(output.includes(RESET + base + '\x1b[J'));
  output = '';
  screen.render({ lines: ['native'], palette: { foreground: null, background: null } });
  assert.ok(!output.includes('38;2') && !output.includes('48;2'));
  output = '';
  screen.exit();
  assert.ok(output.startsWith(RESET));
});

test('retry notification is top-right, timed, session scoped and independent from transcript scrolling', async () => {
  const runtime = fixture();
  let now = 100000;
  const app = new TuiApp({ runtime, env: {}, clock: () => now, width: 100, height: 30 });
  await app.start();
  app.state.messages = Array.from({ length: 45 }, (_, i) => ({
    kind: 'assistant',
    text: 'Line ' + i,
  }));
  app.state.scrollOffset = 15;
  const before = app.frame();
  runtime.emit({
    type: 'notification',
    key: app.activeKey,
    notificationType: 'toast',
    payload: {
      type: 'warn',
      duration: 6000,
      retry: { attempt: 2, status: 429, delayMs: 10000, error: 'Provider rate limit' },
    },
  });
  await app.settled();
  await send(app, 'draft');
  const frame = app.frame();
  const text = stripAnsi(frame.lines.join('\n'));
  assert.ok(
    text.includes('LLM 重试 #2') &&
      text.includes('HTTP 429') &&
      text.includes('Provider rate limit'),
  );
  assert.ok(text.includes('10s 后重试'));
  assert.equal(frame.toastBounds.left, 38);
  assert.deepEqual(frame.transcript, before.transcript);
  assert.deepEqual(frame.scroll, before.scroll);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 100));
  await app.newSession('babe');
  assert.equal(app.state.toast, null);
  const first = [...app._sessionViews.keys()][0];
  await app._switchSession(first);
  assert.ok(app.state.toast.retry);
  now += 5000;
  app.tick();
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('5s 后重试'));
  runtime.emit({ type: 'stream-chunk', key: first, data: { content: 'recovered' } });
  await app.settled();
  assert.equal(app.state.toast, null);
  runtime.emit({
    type: 'notification',
    key: first,
    notificationType: 'toast',
    payload: { message: 'Timeout', duration: 1000 },
  });
  await app.settled();
  now += 1001;
  app.tick();
  assert.equal(app.state.toast, null);
  app.dispose();
});

test('small terminal notifications fit above input, without moving its cursor', async () => {
  for (const height of [8, 9, 10, 12]) {
    const app = new TuiApp({ runtime: fixture(), env: {}, width: 20, height });
    await app.start();
    const before = app.frame();
    app.handleRuntimeEvent({
      type: 'notification',
      notificationType: 'toast',
      payload: { retry: { attempt: 1, delayMs: 1000 } },
    });
    const frame = app.frame();
    assert.equal(frame.lines.length, height);
    assert.deepEqual(frame.cursor, before.cursor);
    assert.ok(
      !frame.toastBounds || frame.toastBounds.top + frame.toastBounds.height < frame.cursor.row - 1,
    );
    assert.ok(frame.lines.every((line) => visibleWidth(line) <= 20));
    app.dispose();
  }
});

test('todo arrows select real items and Space/Enter persist status without closing or losing selection', async () => {
  const runtime = fixture(),
    app = new TuiApp({ runtime, env: {}, width: 70, height: 20 });
  await app.start();
  await send(app, '/todo\r\x1b[B\x1b[B ');
  await app.settled();
  assert.equal(app.state.modal.selected, 2);
  assert.equal((await runtime.getTodos())[2].done, true);
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('[x] 3. Task 3'));
  await send(app, '\r');
  await app.settled();
  assert.equal(app.state.todos[2].done, false);
  for (let i = 0; i < 23; i++) await send(app, '\x1b[B');
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('Task 26'));
  runtime.emit({ type: 'todo', items: await runtime.getTodos() });
  await app.settled();
  assert.equal(app.state.modal.options[app.state.modal.selected].value, 26);
  runtime.toggleTodo = async () => ({ ok: false, error: 'Disk unavailable' });
  await send(app, ' ');
  assert.equal(app.state.modal.selected, 25);
  assert.equal(app.state.modal.busy, false);
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('Disk unavailable'));
  await app.newSession('chat');
  await send(app, '/todo\r');
  assert.equal(app.state.todos[2].done, false);
  app.dispose();
});

test('Windows cwd opens a visible Explorer and returns on spawn, without awaiting its lifetime', async () => {
  const child = Object.assign(new EventEmitter(), {
    unref: () => {
      child.unreferenced = true;
    },
  });
  let call;
  const result = await openDirectory(process.cwd(), {
    desktop: () => true,
    platform: 'win32',
    spawnProcess: (...args) => {
      call = args;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(call.slice(0, 2), ['explorer.exe', [process.cwd()]]);
  assert.equal(call[2].windowsHide, false);
  assert.equal(child.unreferenced, true);
  assert.equal(child.listenerCount('exit'), 0);
  await assert.rejects(
    openDirectory(process.cwd(), {
      desktop: () => true,
      platform: 'win32',
      spawnProcess: () => {
        const missing = new EventEmitter();
        queueMicrotask(() => missing.emit('error', new Error('ENOENT')));
        return missing;
      },
    }),
    /ENOENT/,
  );
});
