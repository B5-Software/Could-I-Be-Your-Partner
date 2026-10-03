/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 渲染测试：光标落位（回归：光标跑到输入框上方/中文横向漂移）与排版。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const views = require('../../src/tui/views.js');
const { stripAnsi, visibleWidth } = require('../../src/tui/ansi.js');
const {
  themeFromEnv,
  themeFromSettings,
  applyAccent,
  parseHexColor,
  resolveTheme,
  detectTerminalDark,
} = require('../../src/tui/theme.js');

const theme = themeFromEnv({});

function inputState(extra = {}) {
  return Object.assign(
    {
      theme,
      width: 60,
      height: 20,
      mode: 'chat',
      messages: [],
      running: false,
      blink: true,
      spinnerFrame: 0,
      scrollOffset: 0,
      editorText: '',
      editorCursor: 0,
    },
    extra,
  );
}

function compose(state) {
  return views.composeFrame(state, { hints: [], inputHint: '' });
}

/** 输入框内顶线/正文/底线的行号（1-based） */
function locateInput(lines) {
  const top = lines.findIndex((line) => stripAnsi(line).includes(BOX_TOP));
  const bottom = lines.findIndex((line, i) => i > top && stripAnsi(line).includes(BOX_BOTTOM));
  return { top, bottom };
}

const { BOX } = require('../../src/tui/theme.js');
const BOX_TOP = BOX.topLeft;
const BOX_BOTTOM = BOX.bottomLeft;

test('光标落在输入正文行（而不是顶线/上方）', () => {
  const frame = compose(inputState());
  const { top, bottom } = locateInput(frame.lines);
  assert.ok(top >= 0, '应有输入框顶线');
  assert.ok(bottom > top, '应有输入框底线');
  // 光标行（1-based）必须落在顶线与底线之间，且正好是第一条正文行
  assert.equal(frame.cursor.row, top + 2, '光标行应是顶线下一行');
  assert.ok(frame.cursor.row < bottom + 1, '光标不能越过底线');
});

test('光标列按显示宽度计算（中文 2 格）', () => {
  // 空输入：光标在前缀之后（❯ = 1 格 + 1 空格 → 第 3 列）
  let frame = compose(inputState({ editorText: '', editorCursor: 0 }));
  assert.equal(frame.cursor.col, 3, '空输入时应在 ❯ 之后');

  // 英文 2 字符 → 第 5 列
  frame = compose(inputState({ editorText: 'ab', editorCursor: 2 }));
  assert.equal(frame.cursor.col, 5);

  // 中文 2 字 = 4 显示格 → 第 7 列（回归：按字符数会算成 5）
  frame = compose(inputState({ editorText: '你好', editorCursor: 2 }));
  assert.equal(frame.cursor.col, 7, '中文应按 2 格/字计算光标列');

  // 光标在中文中间
  frame = compose(inputState({ editorText: '你好', editorCursor: 1 }));
  assert.equal(frame.cursor.col, 5);
});

test('多行缓冲与软换行时光标落位正确', () => {
  // 两行：光标在第二行行首
  const frame = compose(inputState({ editorText: '第一行\n第二行', editorCursor: 4 }));
  const { top } = locateInput(frame.lines);
  assert.equal(frame.cursor.row, top + 3, '第二行正文应在顶线下两行');
  assert.equal(frame.cursor.col, 3);

  // 软换行：超长英文把正文挤成两行，光标在末尾应落到第二条渲染行
  const long = 'a'.repeat(70);
  const wrapped = compose(inputState({ editorText: long, editorCursor: long.length, width: 60 }));
  const wrapTop = locateInput(wrapped.lines).top;
  assert.equal(wrapped.cursor.row, wrapTop + 3, '软换行后光标应在第二条正文行');
});

test('补全面板打开时光标行号随之偏移', () => {
  const state = inputState({
    editorText: '/he',
    editorCursor: 3,
    completion: {
      kind: 'command',
      selected: 0,
      items: [{ label: '/help', value: '/help', description: 'x' }],
    },
  });
  const frame = compose(state);
  const { top } = locateInput(frame.lines);
  assert.equal(frame.cursor.row, top + 2, '补全面板在输入框上方，光标仍应落在输入正文行');
});

test('帧内所有行不超过终端宽度', () => {
  const frame = compose(
    inputState({
      width: 48,
      messages: [
        {
          kind: 'assistant',
          text: '这是一段比较长的中文回复内容用于验证排版换行是否正确。'.repeat(3),
        },
      ],
    }),
  );
  for (const line of frame.lines) {
    assert.ok(visibleWidth(line) <= 48, `超宽: ${visibleWidth(line)}（${stripAnsi(line)}）`);
  }
});

test('主题：跟随设置的深浅色与强调色', () => {
  assert.equal(themeFromSettings({ theme: { mode: 'light' } }, {}).name, 'light');
  assert.equal(themeFromSettings({ theme: { mode: 'dark' } }, {}).name, 'dark');
  // system → 按终端深浅判定
  assert.equal(themeFromSettings({ theme: { mode: 'system' } }, {}).name, 'dark');
  assert.equal(
    themeFromSettings({ theme: { mode: 'system' } }, { COLORFGBG: '0;15' }).name,
    'light',
  );
  // 环境变量优先于设置
  assert.equal(
    themeFromSettings({ theme: { mode: 'light' } }, { CIBYP_TUI_THEME: 'ansi' }).name,
    'ansi',
  );

  assert.equal(parseHexColor('#4f8cff'), 'rgb(79,140,255)');
  assert.equal(parseHexColor('bad'), null);
  const themed = applyAccent(theme, '#4f8cff');
  assert.equal(themed.suggestion, 'rgb(79,140,255)');
  assert.equal(theme.suggestion !== themed.suggestion, true, '不应就地修改主题对象');
});

test('强调色对比度护栏：与终端明暗不符时回落默认色', () => {
  const dark = resolveTheme('dark');
  const light = resolveTheme('light');
  // 浅色 GUI 的黑色强调（用户常见配置）在深色终端上不可读 → 保持默认
  assert.equal(applyAccent(dark, '#000000').suggestion, dark.suggestion);
  // 浅色终端：白色强调被拒，黑色强调可用
  assert.equal(applyAccent(light, '#ffffff').suggestion, light.suggestion);
  assert.equal(applyAccent(light, '#000000').suggestion, 'rgb(0,0,0)');
  // 非法值不改变主题
  assert.equal(applyAccent(dark, 'not-a-color').suggestion, dark.suggestion);
});

test('终端深浅判定（COLORFGBG）', () => {
  assert.equal(detectTerminalDark({ COLORFGBG: '15;0' }), true, '白字黑底 → 深色');
  assert.equal(detectTerminalDark({ COLORFGBG: '0;15' }), false, '黑字白底 → 浅色');
  assert.equal(detectTerminalDark({}), true, '未知默认深色');
});
