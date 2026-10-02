/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 主题令牌（设计语言对标 Claude Code / OpenCode 的终端界面）。
 *
 * - 默认 dark 真彩；支持 light 与纯 16 色 ANSI 降级（CIBYP_TUI_THEME=dark|light|ansi）
 * - 颜色值直接用真彩 RGB：避免用户终端调色板差异导致"设计感"丢失
 * - 语义命名：不绑定具体产品，accent 暖橙为 CIBYP 品牌色
 */

'use strict';

/** dark 主题（默认）：真彩 RGB */
const DARK = {
  name: 'dark',
  truecolor: true,
  // 品牌 / 强调
  accent: 'rgb(215,119,87)', // 暖橙（品牌）
  suggestion: 'rgb(177,185,249)', // 蓝紫：选中 / 交互强调
  permission: 'rgb(177,185,249)',
  planMode: 'rgb(72,150,140)', // teal：Babe/计划等模式色
  bashBorder: 'rgb(253,93,177)', // 亮粉：Code/终端模式边框
  fastMode: 'rgb(255,120,20)',
  merged: 'rgb(175,135,255)',
  // 文本
  text: 'rgb(255,255,255)',
  inverseText: 'rgb(0,0,0)',
  subtle: 'rgb(80,80,80)', // 暗淡
  inactive: 'rgb(153,153,153)',
  promptBorder: 'rgb(136,136,136)',
  // 语义
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  info: 'rgb(122,180,232)',
  // 消息
  userMessageBackground: 'rgb(55,55,55)',
  memoryBackground: 'rgb(55,65,70)',
  selectionBg: 'rgb(38,79,120)',
  // diff（整行背景 / 词级背景）
  diffAdded: 'rgb(34,92,43)',
  diffRemoved: 'rgb(122,41,54)',
  diffAddedWord: 'rgb(56,166,96)',
  diffRemovedWord: 'rgb(179,89,107)',
  // 进度条
  rateFill: 'rgb(177,185,249)',
  rateEmpty: 'rgb(80,83,112)',
  // 多代理调色板（Tailwind 600 系）
  agents: [
    'rgb(220,38,38)',
    'rgb(37,99,235)',
    'rgb(22,163,74)',
    'rgb(202,138,4)',
    'rgb(147,51,234)',
    'rgb(234,88,12)',
    'rgb(219,39,119)',
    'rgb(8,145,178)',
  ],
};

/** light 主题：同一语义键换亮色值 */
const LIGHT = {
  ...DARK,
  name: 'light',
  accent: 'rgb(215,119,87)',
  suggestion: 'rgb(87,105,247)',
  permission: 'rgb(87,105,247)',
  planMode: 'rgb(0,102,102)',
  bashBorder: 'rgb(255,0,135)',
  fastMode: 'rgb(255,106,0)',
  merged: 'rgb(135,0,255)',
  text: 'rgb(0,0,0)',
  inverseText: 'rgb(255,255,255)',
  subtle: 'rgb(175,175,175)',
  inactive: 'rgb(102,102,102)',
  promptBorder: 'rgb(153,153,153)',
  success: 'rgb(44,122,57)',
  error: 'rgb(171,43,63)',
  warning: 'rgb(150,108,30)',
  info: 'rgb(37,99,235)',
  userMessageBackground: 'rgb(240,240,240)',
  memoryBackground: 'rgb(230,245,250)',
  selectionBg: 'rgb(180,213,255)',
  diffAdded: 'rgb(105,219,124)',
  diffRemoved: 'rgb(255,168,180)',
  diffAddedWord: 'rgb(47,157,68)',
  diffRemovedWord: 'rgb(209,69,75)',
  rateFill: 'rgb(87,105,247)',
  rateEmpty: 'rgb(39,47,111)',
};

/** 纯 16 色 ANSI 降级：不依赖真彩终端 */
const ANSI = {
  ...DARK,
  name: 'ansi',
  truecolor: false,
  accent: 'ansi:brightYellow',
  suggestion: 'ansi:brightBlue',
  permission: 'ansi:brightBlue',
  planMode: 'ansi:cyan',
  bashBorder: 'ansi:magenta',
  fastMode: 'ansi:yellow',
  merged: 'ansi:brightMagenta',
  text: 'ansi:white',
  inverseText: 'ansi:black',
  subtle: 'ansi:brightBlack',
  inactive: 'ansi:brightBlack',
  promptBorder: 'ansi:brightBlack',
  success: 'ansi:green',
  error: 'ansi:red',
  warning: 'ansi:yellow',
  info: 'ansi:blue',
  userMessageBackground: 'ansi:brightBlack',
  memoryBackground: 'ansi:brightBlack',
  selectionBg: 'ansi:blue',
  diffAdded: 'ansi:green',
  diffRemoved: 'ansi:red',
  diffAddedWord: 'ansi:brightGreen',
  diffRemovedWord: 'ansi:brightRed',
  rateFill: 'ansi:brightBlue',
  rateEmpty: 'ansi:brightBlack',
  agents: [
    'ansi:red',
    'ansi:blue',
    'ansi:green',
    'ansi:yellow',
    'ansi:magenta',
    'ansi:brightRed',
    'ansi:brightMagenta',
    'ansi:cyan',
  ],
};

const THEMES = { dark: DARK, light: LIGHT, ansi: ANSI };

/** 设计系统字符集（终端 UI 的"图标语言"） */
const FIGURES = Object.freeze({
  pointer: '❯', // 选中/输入前缀
  bullet: '●', // 工具状态点（darwin 可用 ⏺）
  dot: '∙',
  resultPrefix: '⎿', // 工具结果续行前缀
  quote: '▎', // 引用条
  tick: '✓',
  cross: '✗',
  warning: '⚠',
  info: 'ℹ',
  pending: '○',
  ellipsis: '…',
  spinner: ['·', '✢', '✱', '✶', '✻', '✽'], // 主 spinner：正放+倒放 ping-pong
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], // 细粒度 spinner
  progress: [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'], // 1/8 块
  modalTop: '▔', // 模态顶线（上 1/8 块）
  heart: '♥',
  diamond: '◆',
  diamondOpen: '◇',
  effort: ['○', '◐', '●', '⦿', '◉'],
  fast: '↯',
  arrowUp: '↑',
  arrowDown: '↓',
  heavy: '━',
});

/** 边框字符（圆角） */
const BOX = Object.freeze({
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  dashedTop: '╌',
  dashedVertical: '╎',
});

function resolveTheme(name) {
  const key = String(name || '').toLowerCase();
  return THEMES[key] || DARK;
}

/** 根据环境变量/终端能力挑主题：CIBYP_TUI_THEME 优先，其次 NO_COLOR/真彩能力 */
function themeFromEnv(env = process.env) {
  if (env.CIBYP_TUI_THEME) return resolveTheme(env.CIBYP_TUI_THEME);
  if (env.NO_COLOR) return ANSI;
  return DARK;
}

module.exports = { DARK, LIGHT, ANSI, THEMES, FIGURES, BOX, resolveTheme, themeFromEnv };
