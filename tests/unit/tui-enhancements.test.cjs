const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { fields, parseValue, patchFor, valueLabel } = require('../../src/tui/config');
const { findMatches } = require('../../src/tui/transcript-search');
const { DARK } = require('../../src/tui/theme');
const { stripAnsi, visibleWidth, colorCode } = require('../../src/tui/ansi');
const views = require('../../src/tui/views');
const text = require('../../src/tui/text');

test('terminal tables preserve CJK text, align cells and fall back without losing content on narrow screens', () => {
  const table =
    '| 名称 | 值 |\n| :--- | ---: |\n| 中国 | `123` |\n| very long content here | 最后 |';
  for (const width of [14, 26, 70]) {
    const rows = views.layoutText(DARK, table, width, '').map(stripAnsi);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.ok(rows.join('\n').includes('中国'));
    assert.ok(rows.join('\n').includes('最后'));
  }
  assert.ok(views.layoutText(DARK, table, 70, '').some((row) => row.includes('┌')));
  const fenced = '```\n| a | b |\n| -- | -- |\n| x | y |\n```';
  assert.ok(!views.layoutText(DARK, fenced, 70, '').join('').includes('┌'));
});

test('settings browser exposes scalar, empty and JSON settings, masks keys and validates value types', async () => {
  const settings = {
    language: 'en',
    tarotVisible: true,
    theme: { mode: 'dark' },
    webResearch: { engine: 'fusion', providers: { exa: { apiKey: 'secret' } } },
    models: [],
    plugin: {},
  };
  const all = fields(settings);
  assert.equal(all.find((field) => field.path.endsWith('apiKey')).secret, true);
  assert.equal(all.find((field) => field.path === 'models').type, 'json');
  assert.throws(() => patchFor('__proto__.evil', true));
  assert.throws(() => parseValue({ type: 'number' }, 'NaN'));
  assert.throws(() => parseValue({ path: 'language', type: 'string' }, 'invalid'));
  const pool = { path: 'models', type: 'json', value: [{ name: 'model', apiKey: 'private-key' }] };
  assert.ok(!valueLabel(pool).includes('private-key'));
  assert.deepEqual(parseValue(pool, valueLabel(pool)), pool.value);
  const mcp = {
    path: 'mcp.servers',
    type: 'json',
    value: [{ name: 'remote', headers: { Authorization: 'Bearer private-token' } }],
  };
  assert.ok(!valueLabel(mcp).includes('private-token'));
  assert.deepEqual(parseValue(mcp, valueLabel(mcp)), mcp.value);
  let patch;
  const app = new TuiApp({
    runtime: {
      getSettings: async () => settings,
      saveSettings: async (value) => {
        patch = value;
      },
      setLanguage() {},
    },
    env: {},
  });
  app.activeKey = 'test';
  await app.configBrowser.open('tarot');
  assert.equal(app.state.modal.options.length, 1);
  await app._dispatchKey({ name: 'enter' });
  assert.deepEqual(patch, { tarotVisible: false });
  await app.configBrowser.open('apiKey');
  assert.ok(!app.state.modal.options[0].label.includes('secret'));
  await app._dispatchKey({ name: 'enter' });
  await app._dispatchKey({ name: 'char', char: 'new-secret' });
  assert.ok(!app.frame().lines.join('').includes('new-secret'));
  text.setLanguage('zh-CN');
});

test('Ctrl+F navigates every occurrence, preserves draft input and leaves readable search highlights', async () => {
  const app = new TuiApp({ runtime: {}, theme: DARK });
  app.activeKey = 'test';
  app.state.width = 80;
  app.state.height = 15;
  app.state.messages = Array.from({ length: 30 }, (_, i) => ({
    kind: 'assistant',
    text: 'line ' + i + (i % 5 === 0 ? ' needle needle' : ''),
  }));
  app.editor.setValue('draft');
  await app._dispatchKey({ name: 'char', char: 'f', ctrl: true });
  await app._dispatchKey({ name: 'char', char: 'needle' });
  let frame = app.frame();
  assert.equal(app.state.search.matches.length, 12);
  assert.ok(frame.lines.map(stripAnsi).join('\n').includes('needle'));
  await app._dispatchKey({ name: 'enter' });
  app.frame();
  assert.equal(app.state.search.selected, 1);
  await app._dispatchKey({ name: 'escape' });
  assert.equal(app.editor.value, 'draft');
  await app._dispatchKey({ name: 'f3', shift: true });
  app.frame();
  assert.equal(app.state.search.selected, 0);
  assert.deepEqual(findMatches(['中文匹配'], '匹配'), [{ line: 0, column: 4, end: 8 }]);
});

test('brand, tarot and spinner follow mode color; tarot obeys the shared setting', () => {
  for (const mode of ['chat', 'code', 'babe']) {
    const opts = { mode, tarotVisible: true };
    const color = colorCode(DARK[views.accentFor(mode)]);
    for (const output of [
      views.renderEntry(DARK, { kind: 'brand' }, 80, opts).join(''),
      views.renderEntry(DARK, { kind: 'tarot', card: { name: 'card' } }, 80, opts).join(''),
      views.renderSpinnerLine(DARK, { mode }, 80),
    ])
      assert.ok(output.includes(color));
  }
  assert.deepEqual(views.renderEntry(DARK, { kind: 'tarot' }, 80, { tarotVisible: false }), []);
});
