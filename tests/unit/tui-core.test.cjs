/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 基础层测试：ANSI 排版（CJK 宽度/换行/截断）+ 按键解码 + 行编辑器。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../../src/tui/ansi.js');
const { createKeyDecoder } = require('../../src/tui/keys.js');
const { LineEditor } = require('../../src/tui/editor.js');

const ESC = String.fromCharCode(27);

test('terminal title follows the conversation, defaults to New and restores on exit', () => {
  const { createTerminalScreen } = require('../../src/tui/launch.js');
  const writes = [];
  const screen = createTerminalScreen({ columns: 80, rows: 24, write: (s) => writes.push(s) });
  screen.enter();
  assert.ok(writes.some((s) => s === ESC + ']0;CIBYP | New\x07'));
  screen.render({ title: '作业讨论', lines: ['hello'], cursor: { row: 1, col: 1 } });
  assert.ok(writes.includes(ESC + ']0;CIBYP | 作业讨论\x07'));
  const count = writes.length;
  screen.render({ title: '作业讨论', lines: ['hello'], cursor: { row: 1, col: 1 } });
  assert.equal(writes.length, count, 'Idle frames do not repaint or resend the title');
  screen.setTitle('');
  assert.equal(writes.at(-1), ESC + ']0;CIBYP | New\x07');
  screen.setTitle('标题' + ESC + ']52;c;clipboard\x07' + ESC + '[2J\n续行');
  assert.equal(writes.at(-1), ESC + ']0;CIBYP | 标题 续行\x07');
  screen.exit();
  assert.ok(writes.at(-1).endsWith(ESC + '[23;0t'));
  assert.ok(writes.at(-1).includes(ESC + '[?2004l'));
});

test('screen output permits only styling and clamps both dimensions and cursor', () => {
  const { createTerminalScreen } = require('../../src/tui/launch.js');
  const writes = [];
  const screen = createTerminalScreen({ columns: 10, rows: 2, write: (s) => writes.push(s) });
  screen.render({
    title: '',
    lines: ['中'.repeat(15) + ESC + '[2J', 'ok' + ESC + ']0;evil\x07', 'hidden'],
    cursor: { row: 999, col: 999 },
  });
  assert.ok(!writes.at(-1).includes('[2J'));
  assert.ok(!writes.at(-1).includes('evil'));
  assert.ok(!writes.at(-1).includes('hidden'));
  assert.ok(writes.at(-1).includes(ESC + '[2;10H'));
  assert.equal(ansi.stripAnsi(ESC + 'Psecret' + ESC + '\\safe'), 'safe');
  assert.deepEqual(
    [ansi.style('one', { bold: true }), ansi.style('two', { bold: true })].map(ansi.stripAnsi),
    ['one', 'two'],
  );
  assert.equal(ansi.visibleWidth('e\u0301中文'), 5);
});

test('bracketed paste terminators survive every chunk split and decoder timeout', () => {
  const end = ESC + '[201~';
  for (let split = 1; split < end.length; split++) {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.push(ESC + '[200~多行\n🙂' + end.slice(0, split)), []);
    assert.deepEqual(decoder.flush(), [], 'A partial paste marker is not an Esc key');
    const events = decoder.push(end.slice(split) + 'x');
    assert.equal(events[0].name, 'paste');
    assert.equal(events[0].text, '多行\n🙂');
    assert.equal(events[1].char, 'x');
  }
});

test('decoder keeps full Unicode characters and distinguishes Ctrl+J from Enter', () => {
  const decoder = createKeyDecoder();
  assert.equal(decoder.push('🙂')[0].char, '🙂');
  assert.deepEqual(decoder.push('\ud83d'), []);
  assert.equal(decoder.push('\ude42')[0].char, '🙂');
  const events = decoder.push('\n\r');
  assert.equal(events[0].char, 'j');
  assert.equal(events[0].ctrl, true);
  assert.equal(events[1].name, 'enter');
});

test('multiline arrows edit the draft before recalling history; large paste cannot overflow the call stack', () => {
  const editor = new LineEditor({ history: ['old message'] });
  editor.setValue('abc\nx\nxyz');
  editor.handleKey({ name: 'up' });
  assert.equal(editor.value, 'abc\nx\nxyz');
  assert.equal(editor.cursor, 5);
  editor.handleKey({ name: 'up' });
  assert.equal(editor.cursor, 1);
  editor.handleKey({ name: 'down' });
  assert.equal(editor.cursor, 5);
  editor.clear();
  editor.insert('中'.repeat(150000));
  assert.equal(editor.chars.length, 150000);
});

// ---------------- ANSI 排版 ----------------

test('ansi：CJK 与全角按 2 格计算宽度', () => {
  assert.equal(ansi.visibleWidth('中文'), 4);
  assert.equal(ansi.visibleWidth('中文abc'), 7);
  assert.equal(ansi.visibleWidth('ａｂ'), 4);
  assert.equal(ansi.visibleWidth(''), 0);
});

test('ansi：样式可被 stripAnsi 还原为原文', () => {
  const styled = ansi.style('你好', { fg: 'rgb(1,2,3)', bold: true, bg: 'rgb(9,9,9)' });
  assert.notEqual(styled, '你好');
  assert.equal(ansi.stripAnsi(styled), '你好');
  assert.ok(styled.startsWith(ESC + '['), '应以 SGR 开头');
});

test('ansi：16 色降级映射到基础 SGR 码', () => {
  assert.equal(ansi.colorCode('ansi:red'), ESC + '[31m');
  assert.equal(ansi.colorCode('ansi:red', true), ESC + '[41m');
  assert.equal(ansi.colorCode('ansi:brightBlue'), ESC + '[94m');
  assert.equal(ansi.colorCode(''), '');
});

test('ansi：换行按显示宽度，中文逐字断、拉丁按词断', () => {
  const lines = ansi.wrapText('中文测试内容换行排版', 6);
  for (const line of lines) assert.ok(ansi.visibleWidth(line) <= 6, `超宽: ${line}`);
  assert.equal(lines.join(''), '中文测试内容换行排版');

  const latin = ansi.wrapText('a bb ccc dddd eeeee', 8);
  assert.deepEqual(latin, ['a bb ccc', 'dddd', 'eeeee']);

  const mixed = ansi.wrapText('hello world 中文测试内容换行', 10);
  assert.equal(mixed.join('').replace(/ /g, ''), 'helloworld中文测试内容换行');
});

test('ansi：换行保留空行与段落', () => {
  assert.deepEqual(ansi.wrapText('多行\n\n文本', 6), ['多行', '', '文本']);
});

test('ansi：截断带省略号且不超宽', () => {
  const out = ansi.truncate('这是一段很长的中文文本', 8);
  assert.ok(ansi.visibleWidth(out) <= 8);
  assert.ok(out.endsWith('…'));
  assert.equal(ansi.truncate('短', 8), '短');
});

test('ansi：补齐支持左右对齐', () => {
  assert.equal(ansi.visibleWidth(ansi.padWidth('中', 6)), 6);
  assert.equal(ansi.visibleWidth(ansi.padWidth('中', 6, { end: true })), 6);
  assert.ok(ansi.padWidth('中', 6, { end: true }).startsWith(' '));
});

// ---------------- 按键解码 ----------------

function decodeAll(chunks) {
  const decoder = createKeyDecoder();
  const events = [];
  for (const chunk of chunks) events.push(...decoder.push(chunk));
  events.push(...decoder.flush());
  return events;
}

test('keys：普通字符与 CJK', () => {
  const events = decodeAll(['a', '中']);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.name),
    ['char', 'char'],
  );
  assert.equal(events[1].char, '中');
});

test('keys：方向键 / 编辑键 / 翻页', () => {
  const events = decodeAll([
    ESC + '[A',
    ESC + '[B',
    ESC + '[C',
    ESC + '[D',
    ESC + '[3~',
    ESC + '[5~',
    ESC + '[6~',
    '\x7f',
    '\r',
  ]);
  assert.deepEqual(
    events.map((e) => e.name),
    ['up', 'down', 'right', 'left', 'delete', 'pageup', 'pagedown', 'backspace', 'enter'],
  );
});

test('keys：修饰键组合（Ctrl+方向 / Shift+Tab / Alt+字母）', () => {
  const events = decodeAll([ESC + '[1;5C', ESC + '[Z', ESC + 'x', ESC + '\r']);
  assert.equal(events[0].name, 'right');
  assert.equal(events[0].ctrl, true);
  assert.equal(events[1].name, 'tab');
  assert.equal(events[1].shift, true);
  assert.equal(events[2].name, 'x');
  assert.equal(events[2].alt, true);
  assert.equal(events[3].name, 'enter');
  assert.equal(events[3].alt, true);
});

test('keys：Ctrl+字母与孤立 ESC', () => {
  const events = decodeAll([String.fromCharCode(3), String.fromCharCode(21), ESC]);
  assert.equal(events[0].name, 'char');
  assert.equal(events[0].char, 'c');
  assert.equal(events[0].ctrl, true);
  assert.equal(events[1].name, 'char');
  assert.equal(events[1].char, 'u');
  assert.equal(events[1].ctrl, true);
  assert.equal(events[2].name, 'escape');
});

test('keys：转义序列可跨 chunk 到达', () => {
  const decoder = createKeyDecoder();
  assert.deepEqual(decoder.push(ESC + '['), []);
  const events = decoder.push('B');
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'down');
});

test('keys：括号粘贴聚合为单个 paste 事件', () => {
  const events = decodeAll([ESC + '[200~第一行\n第二行' + ESC + '[201~']);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'paste');
  assert.equal(events[0].text, '第一行\n第二行');
});

// ---------------- 行编辑器 ----------------

test('editor：插入 / 光标 / 删除', () => {
  const editor = new LineEditor();
  editor.insert('abc');
  assert.equal(editor.value, 'abc');
  editor.left();
  editor.insert('X');
  assert.equal(editor.value, 'abXc');
  editor.backspace();
  assert.equal(editor.value, 'abc');
  editor.home();
  editor.deleteForward();
  assert.equal(editor.value, 'bc');
  editor.end();
  editor.insert('!');
  assert.equal(editor.value, 'bc!');
});

test('editor：词移动与删词', () => {
  const editor = new LineEditor();
  editor.insert('hello world 中文');
  editor.killWord();
  assert.equal(editor.value, 'hello world ');
  editor.killWord();
  assert.equal(editor.value, 'hello '); // 与 bash 一致：留下词前的空格
  editor.killWord();
  assert.equal(editor.value, '');
});

test('editor：kill 到行首/行尾', () => {
  const editor = new LineEditor();
  editor.insert('abcdef');
  editor.home();
  editor.right();
  editor.right();
  editor.killToEnd();
  assert.equal(editor.value, 'ab');
  editor.killToStart();
  assert.equal(editor.value, '');
});

test('editor：历史调阅与草稿保留', () => {
  const editor = new LineEditor({ history: ['第一条', '第二条'] });
  editor.insert('草稿');
  editor.historyPrev();
  assert.equal(editor.value, '第二条');
  editor.historyPrev();
  assert.equal(editor.value, '第一条');
  editor.historyNext();
  assert.equal(editor.value, '第二条');
  editor.historyNext();
  assert.equal(editor.value, '草稿');
});

test('editor：提交写入历史并清空', () => {
  const editor = new LineEditor();
  editor.insert('发送内容');
  const value = editor.commit();
  assert.equal(value, '发送内容');
  assert.equal(editor.value, '');
  assert.deepEqual(editor.history, ['发送内容']);
});

test('editor：键事件处理（Enter 提交 / Alt+Enter 换行 / Ctrl+W）', () => {
  const editor = new LineEditor();
  editor.insert('hello');
  assert.equal(editor.handleKey({ name: 'enter' }), 'submit');
  editor.commit(); // submit 由应用层负责提交并清空
  assert.equal(editor.value, '');
  editor.insert('hello world');
  assert.equal(editor.handleKey({ name: 'enter', alt: true }), 'handled');
  assert.equal(editor.value, 'hello world\n');
  assert.equal(editor.handleKey({ name: 'char', char: 'w', ctrl: true }), 'handled');
  assert.equal(editor.value, 'hello ');
  // 空输入的 Enter 不提交
  editor.clear();
  assert.equal(editor.handleKey({ name: 'enter' }), 'ignored');
});
