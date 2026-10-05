/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { createKeyDecoder } = require('../../src/tui/keys');
const { createTerminalScreen } = require('../../src/tui/launch');
const { stripAnsi } = require('../../src/tui/ansi');
const { setLanguage } = require('../../src/tui/text');

async function setup(extra = {}) {
  const settings = { language: 'zh-CN', tui: { mouse: true }, llm: {} };
  const app = new TuiApp({
    width: 90,
    height: 26,
    env: {},
    runtime: {
      getSettings: async () => settings,
      createSession: () => ({}),
      onEvent: () => () => {},
      stop() {},
      saveSettings: async (patch) => {
        Object.assign(settings.tui, patch.tui);
        return settings;
      },
      ...extra,
    },
  });
  await app.start();
  return app;
}
async function click(app, x, y) {
  const decoder = createKeyDecoder();
  for (const key of decoder.push(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`)) await app.handleKey(key);
}
async function command(app, text) {
  app.editor.setValue(text);
  await app.handleKey({ name: 'enter' });
}

test('mouse clicks activate the visible item in a scrolled selector on release, never on drag', async () => {
  const app = await setup();
  app.state.modal = {
    kind: 'mode',
    title: 'Mode',
    selected: 0,
    options: [
      { label: 'Chat', value: 'chat' },
      { label: 'Babe', value: 'babe' },
    ],
  };
  const row = app.frame().hits.modal.find((hit) => hit.index === 1).row;
  await click(app, 8, row);
  assert.equal(app.state.mode, 'babe');
  assert.equal(app.state.modal, null);
  app.state.modal = {
    kind: 'mode',
    title: 'Mode',
    selected: 32,
    options: Array.from({ length: 40 }, (_, i) => ({ label: `Option ${i}`, value: i })),
  };
  const hit = app.frame().hits.modal.find((hit) => hit.index === 32);
  assert.ok(stripAnsi(app.frame().lines[hit.row - 1]).includes('Option 32'));
  let chosen;
  app._chooseModalOption = async (index) => {
    chosen = index;
  };
  await app.handleKey({ name: 'mouse', button: 'left', press: true, x: 8, y: hit.row });
  assert.equal(chosen, undefined);
  await app.handleKey({ name: 'mouse', button: 'left', press: false, x: 8, y: hit.row - 1 });
  assert.equal(chosen, undefined, 'Release on a different item does not execute it');
  await click(app, 8, hit.row);
  assert.equal(chosen, 32);
  app.state.modal.selected = 0;
  await app.handleKey({ name: 'wheel', direction: 'up', x: 8, y: hit.row });
  assert.equal(app.state.modal.selected, 0, 'Wheel stops at the first item');
});

test('clicks toggle todos and edit safe configuration fields using the existing handlers', async () => {
  let todos = [{ id: 1, text: 'Finish task', done: false }];
  const app = await setup({
    getTodos: async () => todos,
    toggleTodo: async (id) => {
      assert.equal(id, 1);
      todos[0].done = !todos[0].done;
      return { ok: true };
    },
  });
  await command(app, '/todo');
  let row = app
    .frame()
    .hits.modal.find((hit) => app.state.modal.options[hit.index].value === 1).row;
  await click(app, 7, row);
  assert.equal(todos[0].done, true);
  assert.equal(app.state.modal.kind, 'todo');
  await app.handleKey({ name: 'escape' });
  await command(app, '/config tui.mouse');
  row = app.frame().hits.modal[0].row;
  await click(app, 7, row);
  assert.equal(app.state.settings.tui.mouse, false);
});

test('input clicks follow Unicode widths, explicit newlines and wrapped spaces without losing characters', async () => {
  const app = await setup();
  app.editor.setValue('你好🙂\nsecond line');
  let row = app.frame().hits.input[0].row;
  await click(app, 8, row);
  app.editor.insert('X');
  assert.equal(app.editor.value, '你好X🙂\nsecond line');
  row = app.frame().hits.input[1].row;
  await click(app, 4, row);
  app.editor.insert('Y');
  assert.equal(app.editor.value, '你好X🙂\nYsecond line');
  app.resize(20, 26);
  app.editor.setValue('123456789012345     tail');
  row = app.frame().hits.input[1].row;
  await click(app, 4, row);
  app.editor.insert('Z');
  assert.equal(app.editor.value, '123456789012345Z     tail');
  const offset = app.state.scrollOffset;
  await app.handleKey({ name: 'wheel', direction: 'up', x: 5, y: row });
  assert.equal(
    app.state.scrollOffset,
    offset,
    'Wheel over the input does not scroll the conversation',
  );
  app.resize(12, 5);
  const entries = app.state.messages.length;
  await app.handleKey({ name: 'wheel', direction: 'up', x: 2, y: 2 });
  assert.equal(app.state.messages.length, entries, 'A tiny terminal ignores pointer scrolling');
});

test('clicking a command completes it without executing, and disabled capture restores native mouse modes', async () => {
  const app = await setup();
  app.editor.setValue('/us');
  app.frame();
  const row = app
    .frame()
    .hits.completion.find((hit) => app.state.completion.items[hit.index].label === '/usage').row;
  await click(app, 7, row);
  assert.equal(app.editor.value.trim(), '/usage');
  assert.equal(app.state.modal, null);
  await command(app, '/mouse off');
  assert.equal(app.frame().mouseEnabled, false);
  const writes = [];
  const screen = createTerminalScreen({
    write: (text) => writes.push(text),
    columns: 90,
    rows: 26,
  });
  screen.enter();
  screen.render(app.frame());
  assert.ok(writes.some((text) => text.includes('\x1b[?1006l') && text.includes('\x1b[?1002l')));
  await command(app, '/mouse on');
  screen.render(app.frame());
  assert.ok(writes.some((text) => text.includes('\x1b[?1006h')));
  screen.exit();
  assert.ok(writes.at(-1).includes('\x1b[?1000l'));
});

test('/usage opens on demand, shows all available limits and reset times, and respects dismissal', async () => {
  let requests = 0,
    resolve;
  const app = await setup({
    getStats: () => ({ usage: { prompt: 50, completion: 20 }, context: { used: 100, max: 1000 } }),
    getSubscriptionUsage: async (_key, opts) => {
      requests++;
      assert.equal(opts.force, true);
      assert.equal(opts.includeWindows, true);
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  for (let i = 0; i < 100; i++) app.tick();
  assert.equal(requests, 0, 'Idle rendering never polls quota APIs');
  const opening = command(app, '/usage');
  await Promise.resolve();
  assert.equal(app.state.modal.kind, 'usage');
  resolve({
    subscription: true,
    mode: 'urgent',
    windows: [
      { label: 'Codex', period: '5hour', usedPercent: 25, resetsAt: Date.now() + 50000 },
      { label: 'Codex', period: 'weekly', usedPercent: 80 },
    ],
    selected: { period: 'weekly', usedPercent: 80 },
    equivalent: { costUSD: 1.5, pricedRequests: 1 },
  });
  await opening;
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.match(text, /5 小时限额/);
  assert.match(text, /周限额/);
  assert.match(text, /重置时间/);
  assert.match(text, /25%/);
  assert.match(text, /80%/);
  assert.match(text, /API 等效/);
  assert.ok(
    !app.state.messages.some((entry) => entry.text?.includes('prompt 50')),
    'Usage is not appended to chat history',
  );
  await app.handleKey({ name: 'escape' });
  assert.ok(!stripAnsi(app.frame().lines.at(-1)).includes('额度'));
  const next = command(app, '/usage');
  await Promise.resolve();
  await app.handleKey({ name: 'escape' });
  resolve({ subscription: true, mode: 'urgent', windows: [], error: 'unavailable' });
  await next;
  assert.equal(app.state.modal, null, 'A late response cannot reopen the panel');
});

test('new command and quota labels are localized in English and German', async () => {
  const { t } = require('../../src/tui/text');
  for (const language of ['en', 'de']) {
    setLanguage(language);
    assert.ok(!/[\u4e00-\u9fff]/.test(t('ui.tui.cmd.mouse', '鼠标')));
    assert.ok(!/[\u4e00-\u9fff]/.test(t('ui.tui.usageTitle', '用量与额度')));
  }
  setLanguage('zh-CN');
});
