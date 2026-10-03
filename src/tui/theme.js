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
  planMode: 'rgb(72,150,140)', // teal：Code / 计划模式
  bashBorder: 'rgb(253,93,177)', // 亮粉：Babe 模式
  fastMode: 'rgb(255,120,20)',
  merged: 'rgb(175,135,255)',
  // 文本
  text: 'rgb(255,255,255)',
  inverseText: 'rgb(0,0,0)',
  subtle: 'rgb(172,172,172)',
  inactive: 'rgb(204,204,204)',
  promptBorder: 'rgb(166,166,166)',
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
  subtle: 'rgb(104,104,104)',
  inactive: 'rgb(80,80,80)',
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
  subtle: 'ansi:white',
  inactive: 'ansi:white',
  promptBorder: 'ansi:white',
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
  thinking: '∴',
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

/** '#4f8cff' → 'rgb(79,140,255)'；非法输入返回 null */
function parseHexColor(value) {
  const match = String(value || '')
    .trim()
    .match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgb(${r},${g},${b})`;
}

/**
 * 沿用 GUI 设置里的强调色（settings.theme.accentColor）：
 * 应用到交互强调（suggestion/permission）与品牌强调（accent）。
 *
 * 对比度护栏：强调色是为 GUI 的背景（settings.theme.backgroundColor）设计的，
 * 直接搬到相反明暗的终端上会不可读（例如浅色主题的黑色强调用在深色终端）。
 * 因此只在与终端主题足够对比时沿用，否则保持主题默认色。
 */
function applyAccent(theme, accentColor) {
  const rgb = parseHexColor(accentColor);
  if (!rgb) return theme;
  const luminance = relativeLuminance(rgb);
  const dark = theme.name !== 'light';
  const readable = dark ? luminance >= 0.2 : luminance <= 0.85;
  if (!readable) return theme;
  return Object.assign({}, theme, { suggestion: rgb, permission: rgb, accent: rgb });
}

/** 'rgb(r,g,b)' → 相对亮度（0..1，WCAG 近似） */
function relativeLuminance(rgb) {
  const parts = String(rgb)
    .slice(4, -1)
    .split(',')
    .map((n) => Number(n) / 255);
  const [r, g, b] = parts.map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 终端深浅判定（settings.theme.mode = system 时用）：
 * 读 COLORFGBG（前景;背景 的 ANSI 索引），背景索引偏亮 → 浅色终端。
 * 未知时默认深色（现代终端最常见）。
 */
function detectTerminalDark(env = process.env) {
  const value = String(env.COLORFGBG || '');
  const parts = value.split(';').map((n) => Number(n));
  if (parts.length >= 2 && Number.isFinite(parts[parts.length - 1])) {
    return parts[parts.length - 1] <= 8;
  }
  return true;
}

/**
 * 按 GUI 设置挑主题（settings.theme.mode = system|dark|light）。
 * 环境变量 CIBYP_TUI_THEME 优先；system → 按终端深浅判定。
 */
function themeFromSettings(settings, env = process.env) {
  if (env && env.CIBYP_TUI_THEME) return resolveTheme(env.CIBYP_TUI_THEME);
  const mode = settings && settings.theme && settings.theme.mode;
  if (mode === 'light') return LIGHT;
  if (mode === 'dark') return DARK;
  return detectTerminalDark(env) ? DARK : LIGHT;
}

/** 根据环境变量/终端能力挑主题：CIBYP_TUI_THEME 优先，其次 NO_COLOR/真彩能力 */
function themeFromEnv(env = process.env) {
  if (env.CIBYP_TUI_THEME) return resolveTheme(env.CIBYP_TUI_THEME);
  if (env.NO_COLOR) return ANSI;
  return DARK;
}

module.exports = {
  DARK,
  LIGHT,
  ANSI,
  THEMES,
  FIGURES,
  BOX,
  resolveTheme,
  parseHexColor,
  applyAccent,
  relativeLuminance,
  detectTerminalDark,
  themeFromSettings,
  themeFromEnv,
};
