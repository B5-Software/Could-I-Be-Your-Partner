/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TuiApp } = require('../../src/tui/app');
const views = require('../../src/tui/views');
const { themeFromEnv } = require('../../src/tui/theme');
const { stripAnsi, visibleWidth, paint } = require('../../src/tui/ansi');
const { createPreferencesStore } = require('../../src/tui/preferences');
const theme = themeFromEnv({});
function runtime() {
  const sessions = new Map();
  return {
    getSettings: async () => ({}),
    onEvent: () => () => {},
    stop: () => {},
    createSession: (value) => sessions.set(value.key, value),
    getSession: (key) => sessions.get(key),
  };
}

test('/thinking survives restarts and session switches using only the TUI preference file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-tui-preferences-'));
  const file = path.join(directory, 'data/tui-preferences.json');
  const store = createPreferencesStore(file);
  const first = new TuiApp({
    runtime: runtime(),
    preferences: store,
    theme,
    width: 100,
    height: 30,
  });
  await first.start();
  assert.equal(first.state.thinkingExpanded, true);
  const oldKey = first.activeKey;
  await first._runCommand('thinking', '');
  assert.equal(first.state.thinkingExpanded, false);
  await first.newSession('babe');
  assert.equal(first.state.thinkingExpanded, false);
  await first._runCommand('thinking', '');
  await first._switchSession(oldKey);
  assert.equal(first.state.thinkingExpanded, true);
  first.dispose();
  const next = new TuiApp({
    runtime: runtime(),
    preferences: createPreferencesStore(file),
    theme,
    width: 100,
    height: 30,
  });
  await next.start();
  assert.equal(next.state.thinkingExpanded, true);
  await next._runCommand('thinking', '');
  next.dispose();
  assert.equal((await createPreferencesStore(file).load()).thinkingExpanded, false);
  assert.deepEqual(
    await fs.readdir(path.dirname(file)),
    ['tui-preferences.json'],
    'No GUI settings were written',
  );
});

test('non-streaming reasoning is paired with the next response and does not overwrite an earlier reply', async () => {
  const app = new TuiApp({ runtime: runtime(), theme, width: 100, height: 30 });
  await app.start();
  app.handleRuntimeEvent({ type: 'assistant-reasoning', data: '第一轮思考' });
  app.handleRuntimeEvent({ type: 'message', role: 'assistant', content: '第一轮答案' });
  app.handleRuntimeEvent({ type: 'assistant-reasoning', data: '第二轮思考\n末尾完整保留' });
  app.handleRuntimeEvent({ type: 'message', role: 'assistant', content: '第二轮答案' });
  const entries = app.state.messages.filter((entry) => entry.kind === 'assistant');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].reasoning, '第一轮思考');
  assert.equal(entries[1].reasoning, '第二轮思考\n末尾完整保留');
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(
    text.includes('末尾完整保留\n\n  第二轮答案'),
    'Reasoning and answer are separated by a blank row',
  );
  assert.ok(!text.includes('思考中'));
});

test('expanded reasoning retains every line and terminal layout does not discard the final text', () => {
  const raw = Array.from({ length: 130 }, (_, index) => '完整推理第' + index + '行').join('\n');
  const rows = views
    .renderEntry(theme, { kind: 'assistant', reasoning: raw, text: '正文' }, 50, {
      thinkingExpanded: true,
    })
    .map(stripAnsi);
  assert.ok(rows.includes('    完整推理第129行'));
  assert.equal(rows.at(-2), '');
  assert.equal(rows.at(-1), '  正文');
  assert.ok(rows[0].endsWith('思考：'));
  assert.ok(!rows[0].includes('字'));
  assert.ok(rows.every((row) => visibleWidth(row) <= 50));
});

test('all input rows have both borders, with a cursor cell inside the box after CJK/soft wrapping', () => {
  for (const text of ['第一行\n第二行', '中'.repeat(30), '\n\n\n', 'a'.repeat(35)]) {
    const input = views.renderInput(
      theme,
      { mode: 'chat', editorText: text, editorCursor: Array.from(text).length },
      40,
      { maxRows: 6 },
    );
    for (const row of input.lines.slice(1, -1).map(stripAnsi)) {
      assert.ok(row.startsWith('│') && row.endsWith('│'));
      assert.equal(visibleWidth(row), 40);
    }
    assert.ok(input.cursor.col >= 4 && input.cursor.col <= 39);
    assert.ok(input.cursor.row > 1 && input.cursor.row < input.lines.length);
  }
});

test('dark gray labels and reasoning remain readable without terminal dim attenuation', () => {
  assert.equal(theme.subtle, 'rgb(172,172,172)');
  assert.ok(!paint(theme, 'subtle', 'label', { dim: true }).includes('\x1b[2m'));
  const reasoning = views.renderReasoning(theme, '完整内容', 80, true).join('\n');
  assert.ok(reasoning.includes('38;2;172;172;172'));
  assert.ok(!reasoning.includes('\x1b[2m'));
});
