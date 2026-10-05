/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { createKeyDecoder } = require('../../src/tui/keys');
const { selectedText, pointAt } = require('../../src/tui/selection');
const { stripAnsi, visibleWidth, colorCode } = require('../../src/tui/ansi');
const { themeFromEnv } = require('../../src/tui/theme');
const views = require('../../src/tui/views');
const { brandLines, printStartupBrand } = require('../../src/main/core/terminal-brand');
const theme = themeFromEnv({});

async function makeApp() {
  const copies = [],
    stops = [],
    quits = [];
  const app = new TuiApp({
    runtime: {
      getSettings: async () => ({}),
      onEvent: () => () => {},
      createSession: () => ({}),
      stop: (key) => stops.push(key),
    },
    width: 90,
    height: 24,
    theme,
    onCopy: (text) => copies.push(text),
    onQuit: () => quits.push(true),
  });
  await app.start();
  app.state.messages = [
    {
      kind: 'assistant',
      text: Array.from({ length: 100 }, (_, i) => `Line ${i}: 你好 🙂`).join('\n'),
    },
  ];
  return { app, copies, stops, quits };
}
const mouse = (x, y, extra = {}) => ({
  name: 'mouse',
  button: 'left',
  press: true,
  x,
  y,
  ...extra,
});

test('mouse drag selects earlier messages using repeated edge scrolling, and release stops scrolling', async () => {
  const { app, copies, stops, quits } = await makeApp();
  const bottom = app.frame().transcript.rowLines.length - 1;
  app._scroll(10);
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('↓ 10 行未显示（PgDn 查看）'));
  app.state.scrollOffset = 0;
  await app.handleKey(mouse(15, bottom));
  const anchor = app.state.selection.anchor;
  await app.handleKey(mouse(3, 1, { motion: true }));
  for (let i = 0; i < 80; i++) app.tick();
  assert.equal(app.state.scrollOffset, app.frame().scroll.maxOffset);
  assert.equal(
    app.state.selection.anchor.line,
    anchor.line,
    'Anchor remains attached to the transcript',
  );
  assert.equal(app.state.selection.focus.line, 0);
  const text = selectedText(app.state.selection, app.frame().transcript.lines);
  assert.ok(text.includes('Line 0: 你好 🙂'));
  assert.ok(text.split('\n').length > 70);
  await app.handleKey(mouse(3, 1, { press: false }));
  assert.equal(app.state.selection.dragging, false);
  app.state.running = true;
  await app.handleKey({ name: 'char', ctrl: true, char: 'c' });
  assert.equal(copies[0], text);
  assert.deepEqual(stops, [], 'Copying a selection cannot interrupt the Agent');
  assert.deepEqual(quits, []);
  await app.handleKey({ name: 'escape' });
  assert.equal(app.state.selection, null);
  assert.equal(app.state.running, true, 'First Escape dismisses selection');
});

test('mouse selection scrolls downward at the lower edge and never includes the input/status bars', async () => {
  const { app } = await makeApp();
  app._scroll(10000);
  await app.handleKey(mouse(3, 2));
  await app.handleKey(mouse(20, 24, { motion: true }));
  for (let i = 0; i < 80; i++) app.tick();
  assert.equal(app.state.scrollOffset, 0);
  const text = selectedText(app.state.selection, app.frame().transcript.lines);
  assert.ok(text.includes('Line 99'));
  assert.ok(!text.includes('Could I Be Your Partner'));
  const offset = app.state.scrollOffset;
  await app.handleKey(mouse(20, 24, { press: false }));
  app.tick();
  assert.equal(app.state.scrollOffset, offset);
  app.resize(50, 15);
  assert.equal(app.state.selection, null, 'Reflow invalidates old display columns');
});

test('SGR mouse drag is distinguishable from a new click, including chunked input', () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push('\x1b[<32;5;'), []);
  const [move, release] = decoder.push('3M\x1b[<0;5;3m');
  assert.equal(move.motion, true);
  assert.equal(move.press, true);
  assert.equal(release.press, false);
});

test('wide characters are selected as complete glyphs and selection contains no ANSI controls', () => {
  const lines = ['你好🙂 world'];
  const transcript = { lines, rowLines: [0] };
  assert.deepEqual(pointAt(transcript, 2, 1), { line: 0, column: 0 });
  const text = selectedText(
    { anchor: pointAt(transcript, 1, 1), focus: pointAt(transcript, 5, 1), moved: true },
    lines,
  );
  assert.equal(text, '你好🙂');
});

test('brand art is shared by GUI/TUI, visible on new sessions and VM boot, and fits narrow terminals', async () => {
  let output = '';
  printStartupBrand({
    columns: 80,
    write: (text) => {
      output += text;
    },
  });
  assert.ok(output.includes(brandLines(80).join('\n')));
  const { app } = await makeApp();
  await app.newSession('chat');
  assert.equal(app.state.messages[0].kind, 'brand');
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('____'));
  for (const width of [20, 35, 90])
    for (const height of [8, 15, 24]) {
      app.resize(width, height);
      app.setBootStatus({ progress: 10, detail: 'Preparing VM' });
      const frame = app.frame();
      assert.ok(frame.lines.length <= height);
      assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
      assert.ok(
        stripAnsi(frame.lines.join('\n')).includes(
          width < 35 || height < 15 ? 'C I B Y P' : '____',
        ),
      );
    }
});

test('status keeps clean version on the far right and places context immediately to its left', () => {
  const version = require('../../package.json').version.split('+')[0];
  const row = stripAnsi(
    views.renderStatusLine(
      theme,
      {
        mode: 'code',
        model: 'm'.repeat(60),
        workspace: '/workspace/project',
        context: { used: 24000, max: 100000, reserve: 1000 },
        costUSD: 0.5,
      },
      120,
    ),
  );
  assert.equal(visibleWidth(row), 120);
  assert.ok(row.endsWith('25.0K (25%) │ Could I Be Your Partner ' + version));
  assert.ok(!row.includes('$'), 'Spending is available on demand in /usage');
  assert.ok(!row.includes('+'));
});

test('all user-message cells retain a rectangular background through pointer/markdown resets', () => {
  const rows = views.renderEntry(
    theme,
    { kind: 'user', text: '首行 **粗体** 和 `code`\n第二行\n\n最后一行' },
    70,
  );
  const background = colorCode(theme.userMessageBackground, true);
  for (const row of rows) {
    assert.equal(visibleWidth(row), 70);
    assert.ok(row.startsWith(background));
    const cells = row.split(/(\x1b\[[\d;]*m)/);
    let painted = false;
    for (const part of cells) {
      if (part === background) painted = true;
      else if (part === '\x1b[0m') painted = false;
      else if (part && !part.startsWith('\x1b'))
        assert.ok(painted, 'Every text and padding cell needs the message background');
    }
  }
});
