/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * ANSI 样式与终端排版：
 *   - 颜色解析：真彩 'rgb(r,g,b)' 与降级 'ansi:red' 两种写法
 *   - 宽度计算：CJK / 全角字符按 2 格计算（中文对齐是排版的关键）
 *   - 换行 / 截断 / 补齐：全部按显示宽度而非 code unit
 *   - stripAnsi / visibleWidth：测试断言与布局计算用
 *
 * 注：ESC 用 String.fromCharCode(27) 构造、序列解析手写扫描，
 * 避免源码里出现不可见转义字符（对 git diff / 编辑器不友好）。
 */

'use strict';

const CH = String.fromCharCode(27); // ESC
const CSI = CH + '[';

const ANSI_CODES = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

const RESET = CSI + '0m';

/** 颜色值 → SGR 码（前景）；bg=true 时输出背景码 */
function colorCode(value, bg) {
  if (!value) return '';
  const str = String(value);
  const base = bg ? 48 : 38;
  if (str.startsWith('rgb(')) {
    const parts = str
      .slice(4, -1)
      .split(',')
      .map((n) => Math.max(0, Math.min(255, Number(n) || 0)));
    return CSI + base + ';2;' + parts[0] + ';' + parts[1] + ';' + parts[2] + 'm';
  }
  if (str.startsWith('ansi:')) {
    const code = ANSI_CODES[str.slice(5)];
    if (code == null) return '';
    return CSI + (bg ? code + 10 : code) + 'm';
  }
  return '';
}

const ATTR = {
  bold: CSI + '1m',
  dim: CSI + '2m',
  italic: CSI + '3m',
  underline: CSI + '4m',
  inverse: CSI + '7m',
};

/**
 * 给文本加样式。
 * @param {string} text
 * @param {{fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, inverse?: boolean}} spec
 */
function style(text, spec) {
  const value = text == null ? '' : String(text);
  if (!spec || value === '') return value;
  let prefix = '';
  if (spec.bold) prefix += ATTR.bold;
  if (spec.dim) prefix += ATTR.dim;
  if (spec.italic) prefix += ATTR.italic;
  if (spec.underline) prefix += ATTR.underline;
  if (spec.inverse) prefix += ATTR.inverse;
  if (spec.fg) prefix += colorCode(spec.fg, false);
  if (spec.bg) prefix += colorCode(spec.bg, true);
  if (!prefix) return value;
  return prefix + value + RESET;
}

/** 便捷：主题色键 → 样式文本 */
function paint(theme, key, text, extra) {
  // Semantic gray already has a readable contrast. SGR dim would attenuate it
  // again (and several terminals halve RGB values), making labels disappear.
  return style(
    text,
    Object.assign(
      {},
      extra,
      { fg: theme[key] },
      ['subtle', 'inactive'].includes(key) ? { dim: false } : {},
    ),
  );
}

/** 去除 ANSI 控制序列（手写扫描，支持 CSI 与简单 ESC 序列） */
function stripAnsi(str, keepStyles = false) {
  const text = String(str == null ? '' : str);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === CH) {
      if (text[i + 1] === '[') {
        const start = i;
        i += 2;
        // CSI：参数字节 0x30-0x3F、中间字节 0x20-0x2F、终止字节 0x40-0x7E
        while (i < text.length) {
          const code = text.charCodeAt(i);
          i += 1;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        if (keepStyles === true && /^\u001b\[[\d;:]*m$/.test(text.slice(start, i)))
          out += text.slice(start, i);
        continue;
      }
      if (']P^_'.includes(text[i + 1] || ' ')) {
        i += 2;
        while (i < text.length && text[i] !== '\u0007' && !(text[i] === CH && text[i + 1] === '\\'))
          i++;
        i += text[i] === CH ? 2 : 1;
        continue;
      }
      i += 2; // 其它 ESC 序列：ESC + 一个字节
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code >= 32 && !(code >= 127 && code <= 159)) || ch === '\n' || ch === '\t') out += ch;
    i += 1;
  }
  return out;
}

/** 单字符显示宽度：CJK / 全角 / emoji 按 2 格 */
function charWidth(codePoint) {
  if (/\p{Mark}/u.test(String.fromCodePoint(codePoint)) || codePoint === 0x200d) return 0;
  if (codePoint === 0x200b || codePoint === 0xfeff) return 0; // 零宽
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // 谚文字母
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK 部首/标点
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名/注音/兼容
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 统一
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // 全角形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // emoji
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

/** 文本显示宽度（忽略 ANSI） */
function visibleWidth(str) {
  const plain = stripAnsi(str);
  let width = 0;
  for (const ch of plain) width += charWidth(ch.codePointAt(0));
  return width;
}

/** 按显示宽度截取子串（纯文本语义） */
function sliceByWidth(str, start, width) {
  const plain = stripAnsi(str);
  let seen = 0;
  let out = '';
  let taken = 0;
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0));
    if (seen + w > start) {
      if (taken + w > width) break;
      out += ch;
      taken += w;
    }
    seen += w;
  }
  return out;
}

/** 补齐到指定显示宽度（end=true 右对齐） */
function padWidth(str, width, opts) {
  const end = Boolean(opts && opts.end);
  const fill = (opts && opts.fill) || ' ';
  const cur = visibleWidth(str);
  if (cur >= width) return str;
  const pad = fill.repeat(width - cur);
  return end ? pad + str : str + pad;
}

/** 截断到指定宽度（默认省略号） */
function truncate(str, width, ellipsis) {
  const mark = ellipsis == null ? '…' : String(ellipsis);
  if (visibleWidth(str) <= width) return str;
  const markWidth = visibleWidth(mark);
  return sliceByWidth(str, 0, Math.max(0, width - markWidth)) + mark;
}

/**
 * 按显示宽度换行（尊重已有换行符；CJK 逐字断行，拉丁优先按空格断行）。
 * @returns {string[]}
 */
function wrapText(str, width) {
  const limit = Math.max(1, width);
  const lines = [];
  for (const paragraph of String(str == null ? '' : str).split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    let lastSpaceIndex = -1;
    for (const ch of paragraph) {
      const w = charWidth(ch.codePointAt(0));
      if (ch === ' ' && lineWidth + w > limit) {
        // 行尾放不下的空格直接丢弃（等价于在该处断行）
        lines.push(line);
        line = '';
        lineWidth = 0;
        lastSpaceIndex = -1;
        continue;
      }
      if (lineWidth + w > limit) {
        if (lastSpaceIndex > 0 && line.length - lastSpaceIndex <= limit / 2) {
          lines.push(line.slice(0, lastSpaceIndex));
          line = line.slice(lastSpaceIndex + 1);
          lineWidth = visibleWidth(line);
          lastSpaceIndex = line.indexOf(' ');
          if (lastSpaceIndex === 0) lastSpaceIndex = -1;
        } else {
          lines.push(line);
          line = '';
          lineWidth = 0;
          lastSpaceIndex = -1;
        }
        if (lastSpaceIndex < 0) lastSpaceIndex = line.indexOf(' ');
      }
      line += ch;
      lineWidth += w;
      if (ch === ' ') lastSpaceIndex = line.length - 1; // 空格自身的下标
    }
    lines.push(line);
  }
  return lines;
}

/** 给已排版的行加前缀缩进 */
function indentLines(lines, indent) {
  return lines.map((line) => (line === '' ? line : indent + line));
}

module.exports = {
  CH,
  CSI,
  RESET,
  ATTR,
  ANSI_CODES,
  style,
  paint,
  stripAnsi,
  charWidth,
  visibleWidth,
  sliceByWidth,
  padWidth,
  truncate,
  wrapText,
  indentLines,
  colorCode,
};
