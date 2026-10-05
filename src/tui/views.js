/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * TUI 视图渲染：应用状态 → 终端帧（带样式的字符串行数组）。
 *
 * 设计语言（对标 Claude Code / OpenCode 的终端界面）：
 *   - 用户消息：底色块 + ❯ 前缀；助手正文：无框纯文本
 *   - 工具调用：单行卡片「● 工具名 (参数摘要)」，状态点变色/闪烁
 *   - 工具结果：缩进 + ⎿ 前缀，超出折叠为「… 还有 N 行」
 *   - 代码块：▎ 引用条；行内 `code` 与 **bold** 轻量高亮
 *   - 输入框：完整圆角边框，顶线右端内嵌提示；前缀 ❯（模式换色）
 *   - 模态：▔ 顶线（交互色）+ 标题 + 选项列表（❯ 指针 / ✓ 选中）
 *   - 状态栏：模型 │ Context │ 用量 │ 好感度，分隔符 dim
 */

'use strict';

const {
  style,
  stripAnsi,
  paint,
  visibleWidth,
  wrapText,
  truncate,
  padWidth,
  sliceByWidth,
  RESET,
  colorCode,
  charWidth,
} = require('./ansi.js');
const { brandLines } = require('../main/core/terminal-brand');
const APP_VERSION = require('../../package.json').version.split('+')[0];
const { selectionRange, highlightLine } = require('./selection');
const { FIGURES, BOX } = require('./theme.js');
const { t } = require('./text.js');
const { highlightSearch } = require('./transcript-search');
const { markdownLines } = require('./markdown');

/** 模式 → 强调色键 */
const MODE_ACCENT = {
  chat: 'suggestion',
  babe: 'bashBorder',
  code: 'planMode',
};

const MODE_LABEL = {
  chat: 'Chat',
  babe: 'Babe',
  code: 'Code',
};

function accentFor(mode) {
  return MODE_ACCENT[mode] || 'suggestion';
}

/** 行内轻量标记：`code` 与 **bold** */
function renderInline(theme, text) {
  const out = [];
  let rest = String(text == null ? '' : text);
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      out.push(style(token.slice(1, -1), { fg: theme.accent }));
    } else {
      out.push(style(token.slice(2, -2), { bold: true }));
    }
    rest = rest.slice(match.index + token.length);
  }
  return out.join('');
}

/** 正文排版：换行 + 行内标记（渲染标记前先按纯文本宽度换行） */
function layoutText(theme, text, width, indent) {
  return markdownLines(theme, text, Math.max(4, width), renderInline).map(
    (line) => (indent || '') + line,
  );
}

/** 工具参数摘要：紧凑单行 */
function summarizeArgs(args, limit) {
  if (args == null) return '';
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    text = String(args);
  }
  return truncate(text.replace(/\s+/g, ' '), limit);
}

/** 工具结果：截断 + 折叠行数 */
function layoutResult(theme, result, width, indent) {
  const raw =
    typeof result === 'string' ? result : JSON.stringify(result == null ? null : result, null, 0);
  const lines = String(raw == null ? '' : raw).split('\n');
  const MAX = 6;
  const shown = lines.slice(0, MAX);
  const hidden = lines.length - shown.length;
  const out = [];
  shown.forEach((line, index) => {
    const prefix = index === 0 ? FIGURES.resultPrefix + ' ' : '  ';
    const body = truncate(line, Math.max(4, width - visibleWidth(indent + prefix)));
    out.push(
      indent +
        paint(theme, 'subtle', prefix, { dim: true }) +
        paint(theme, 'inactive', body, { dim: true }),
    );
  });
  if (hidden > 0) {
    out.push(
      indent +
        paint(
          theme,
          'subtle',
          '  ' +
            FIGURES.ellipsis +
            ' ' +
            t('ui.tui.toolMoreLines', '还有 {count} 行', { count: hidden }),
          { dim: true },
        ),
    );
  }
  return out;
}

/** Reasoning is a separate block. Only /thinking deliberately folds it. */
function renderReasoning(theme, reasoning, width, expanded) {
  const raw = String(reasoning || '').trim();
  if (!raw) return [];
  const head = '  ' + FIGURES.thinking + ' ' + t('ui.tui.thinking', '思考') + '：';
  if (!expanded) {
    return [
      paint(
        theme,
        'subtle',
        truncate(head + ' ' + t('ui.tui.reasoningFolded', '（已折叠，/thinking 展开）'), width, ''),
      ),
    ];
  }
  const lines = wrapText(raw, Math.max(8, width - 4));
  return [
    paint(theme, 'subtle', head, { bold: true }),
    ...lines.map((line) => paint(theme, 'subtle', '    ' + line)),
  ];
}

/** 消息条目 → 样式行 */
function renderEntry(theme, entry, width, opts) {
  const state = opts || {};
  switch (entry.kind) {
    case 'brand':
      return renderBrand(theme, width, false, state.mode);
    case 'user': {
      const indent = '  ';
      const lines = layoutText(theme, entry.text, width - 4, indent);
      const mark = paint(theme, 'subtle', FIGURES.pointer + ' ');
      return lines.map((line, index) => {
        const content = index === 0 ? mark + line : '  ' + line;
        // Inline colors/bold reset SGR; reapply the row background after each
        // reset so every user message remains a complete rectangle.
        return style(
          padWidth(content, width)
            .split(RESET)
            .join(RESET + colorCode(theme.userMessageBackground, true)),
          { bg: theme.userMessageBackground },
        );
      });
    }
    case 'assistant': {
      const out = [];
      // 推理内容（thinking/reasoning）：折叠一行摘要，展开全文（/thinking 全局切换）
      if (entry.reasoning) {
        out.push(...renderReasoning(theme, entry.reasoning, width, state.thinkingExpanded));
      }
      if (entry.text && String(entry.text).trim() !== '') {
        if (entry.reasoning) out.push('');
        out.push(...layoutText(theme, entry.text, width - 2, '  '));
      }
      if (entry.streaming && state.running) {
        // 流式中的光标块：落在最后一条可见行上
        if (out.length === 0) {
          out.push('  ' + paint(theme, 'inactive', FIGURES.pending, { dim: true }));
        } else {
          out[out.length - 1] += style(' ', { bg: theme.suggestion });
        }
      }
      return out;
    }
    case 'system':
      return layoutText(theme, entry.text, width - 2, '  ').map((line) =>
        paint(theme, 'subtle', line, { dim: true }),
      );
    case 'notice':
      return [
        paint(theme, 'subtle', '  ' + truncate(entry.text, width - 2), { dim: true, italic: true }),
      ];
    case 'tool': {
      const accent =
        entry.status === 'error' || entry.status === 'denied' ? theme.error : theme.success;
      const running = entry.status === 'running';
      const dotColor = running ? (state.blink ? theme.inactive : theme.subtle) : accent;
      const dot = style(FIGURES.bullet, { fg: dotColor, bold: !running });
      const name = style(entry.name, { bold: true });
      const args = entry.args
        ? paint(
            theme,
            'subtle',
            ' (' + summarizeArgs(entry.args, Math.max(20, width - entry.name.length - 10)) + ')',
            { dim: true },
          )
        : '';
      const head = '  ' + dot + ' ' + name + args;
      const out = [head];
      if (running) {
        out.push(
          '  ' +
            paint(
              theme,
              'subtle',
              '  ' + FIGURES.ellipsis + ' ' + (entry.hint || t('ui.tui.toolRunning', '执行中')),
              {
                dim: true,
                italic: true,
              },
            ),
        );
      } else if (entry.status === 'denied') {
        out.push(
          '  ' +
            paint(theme, 'error', '  ' + FIGURES.cross + ' ' + t('ui.tui.toolDenied', '用户拒绝'), {
              dim: true,
            }),
        );
      } else if (entry.result != null && entry.result !== '') {
        out.push(...layoutResult(theme, entry.result, width, '  '));
      }
      return out;
    }
    case 'subagent': {
      const icon = entry.status === 'done' ? FIGURES.diamond : FIGURES.diamondOpen;
      const color = entry.status === 'done' ? theme.success : theme.inactive;
      return [
        '  ' +
          style(icon, { fg: color }) +
          ' ' +
          style('子代理', { bold: true }) +
          ' ' +
          truncate(entry.task || '', width - 12),
      ];
    }
    case 'file': {
      const title = entry.title || entry.filename || entry.path || '';
      return [
        '  ' +
          paint(theme, 'info', FIGURES.diamond, { bold: true }) +
          ' ' +
          style(truncate(title, width - 8), { bold: true }),
        '    ' + paint(theme, 'subtle', truncate(entry.path || '', width - 6), { dim: true }),
      ];
    }
    case 'tarot': {
      if (state.tarotVisible === false) return [];
      const name =
        (entry.card && (entry.card.name || entry.card.title)) || t('ui.tui.tarotCard', '命运之牌');
      const meaning = (entry.card && (entry.card.meaning || entry.card.desc)) || '';
      return [
        '  ' +
          paint(theme, accentFor(state.mode), FIGURES.diamond, { bold: true }) +
          ' ' +
          style(t('ui.tui.tarot', '命运之牌') + ' · ' + name, { bold: true }) +
          (meaning
            ? ' ' + paint(theme, 'subtle', truncate(meaning, width - 14), { dim: true })
            : ''),
      ];
    }
    default:
      return [];
  }
}

/** 进度条（1/8 块细分） */
function renderProgress(theme, ratio, width) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const cells = Math.max(1, width);
  const filled = clamped * cells;
  const full = Math.floor(filled);
  const partial = Math.round((filled - full) * 8);
  let out = style(FIGURES.progress[8].repeat(full), { fg: theme.rateFill });
  if (full < cells && partial > 0) {
    out += style(FIGURES.progress[partial], { fg: theme.rateFill });
  }
  const used = full + (partial > 0 ? 1 : 0);
  out += style(FIGURES.progress[8].repeat(Math.max(0, cells - used)), { fg: theme.rateEmpty });
  return out;
}

/** Token 计数格式化（与 GUI 的 fmtTokenCount 一致：676.1K / 1.2M） */
function fmtTokenCount(num) {
  const value = Number(num) || 0;
  if (value >= 1e15) return (value / 1e15).toFixed(2) + 'P';
  if (value >= 1e12) return (value / 1e12).toFixed(2) + 'T';
  if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return String(Math.round(value));
}

/** 成本显示：$1.89（小于 1 美分用更多小数位）；未配置价格返回 '' */
function fmtCost(costUSD) {
  if (typeof costUSD !== 'number' || !(costUSD > 0)) return '';
  return '$' + (costUSD >= 0.01 ? costUSD.toFixed(2) : costUSD.toFixed(4));
}

/**
 * 右侧用量摘要：`676.1K (64%) · $1.89`
 *   - 676.1K = 上下文占用（含输出预留，与 GUI 圆环口径一致）
 *   - 64%   = 占比（含预留）
 *   - $1.89 = 会话成本；仅在配置了模型价格时显示
 */
function renderUsageSummary(theme, state) {
  const context = state.context;
  if (!context || !context.max) return '';
  const occupied = (context.used || 0) + (context.reserve || 0);
  const pct = typeof context.pct === 'number' ? context.pct : (occupied / context.max) * 100;
  const prefix = context.exact === false ? '~' : '';
  const parts = [prefix + fmtTokenCount(occupied) + ' (' + Math.round(pct) + '%)'];
  return parts.join(' · ');
}

/** 状态栏：左＝模式/模型/好感度/工作区，右＝用量(占比)[· 成本] */
function renderStatusLine(theme, state, width) {
  const parts = [];
  const accent = accentFor(state.mode);
  parts.push(
    paint(
      theme,
      accent,
      (MODE_LABEL[state.mode] || state.mode) + (state.minimalMode ? ' · Minimal' : ''),
      { bold: true },
    ),
  );
  if (state.model) parts.push(truncate(state.model, 28));
  if (state.mode === 'babe' && state.affection != null) {
    parts.push(
      paint(theme, accentFor('babe'), FIGURES.heart + ' ' + state.affection, { bold: true }),
    );
  }
  if (state.workspace && state.mode === 'code') {
    parts.push(truncate(state.workspace, 24));
  }
  const sep = paint(theme, 'subtle', ' │ ', { dim: true });
  const left = parts.join(sep);
  const brand = 'Could I Be Your Partner ' + APP_VERSION;
  const usage = renderUsageSummary(theme, state);
  const right = usage ? usage + ' │ ' + brand : brand;
  // Reserve the right edge first, including when the model/workspace is long.
  const rightText =
    visibleWidth(right) <= width
      ? right
      : visibleWidth(brand) <= width
        ? brand
        : truncate('CIBYP ' + APP_VERSION, width, '');
  const leftText = truncate(left, Math.max(0, width - visibleWidth(rightText) - 2), '');
  return (
    leftText +
    ' '.repeat(Math.max(0, width - visibleWidth(leftText) - visibleWidth(rightText))) +
    paint(theme, 'inactive', rightText, { dim: true })
  );
}

/** 底部提示（dim，' · ' 连接） */
function renderFooter(theme, hints, width) {
  const usable = hints.filter(Boolean);
  const sep = paint(theme, 'subtle', ' · ', { dim: true });
  return truncate(usable.join(sep), width, '');
}

/** Rounded input box with borders on every row and a reserved cursor cell. */
function renderInput(theme, state, width, opts) {
  const accent = accentFor(state.mode);
  const borderColor = state.running ? theme.inactive : theme[accent] || theme.promptBorder;
  const hint = opts && opts.hint ? ' ' + opts.hint + ' ' : '';
  const topWidth = Math.max(8, width);
  const lineH = BOX.horizontal;
  let top =
    BOX.topLeft +
    lineH.repeat(Math.max(1, topWidth - 2 - visibleWidth(hint))) +
    hint +
    BOX.topRight;
  if (visibleWidth(top) > topWidth) top = truncate(top, topWidth, '');
  top = style(top, { fg: borderColor });
  const bottom = style(BOX.bottomLeft + lineH.repeat(Math.max(1, topWidth - 2)) + BOX.bottomRight, {
    fg: borderColor,
  });

  const prompt =
    style(FIGURES.pointer, { fg: theme[accent] || theme.suggestion, bold: true }) + ' ';
  const promptWidth = visibleWidth(prompt);
  const innerWidth = Math.max(1, topWidth - 2 - promptWidth - 1);

  // Track the cursor and pointer hits using displayed cell widths, not string length.
  const cursorIndex = Number.isInteger(state.editorCursor)
    ? Math.max(0, Math.min(state.editorCursor, Array.from(state.editorText || '').length))
    : 0;
  const chars = Array.from(state.editorText || '');
  // Keep source offsets while wrapping. Displayed spaces, wide glyphs and
  // masked fields must map to the same editor positions as keyboard input.
  const rows = [{ text: '', points: [{ column: 4, index: 0 }], width: 0 }];
  let caretRowIndex = 0;
  let caretCol = 0;
  for (let index = 0; index <= chars.length; index++) {
    let row = rows.at(-1);
    const ch = chars[index];
    const cells = ch == null || ch === '\n' ? 0 : charWidth(ch.codePointAt(0));
    if (ch !== '\n' && (row.width >= innerWidth || row.width + cells > innerWidth)) {
      row = { text: '', points: [{ column: 4, index }], width: 0 };
      rows.push(row);
    }
    if (index === cursorIndex) {
      caretRowIndex = rows.length - 1;
      caretCol = row.width;
    }
    if (ch == null) break;
    if (ch === '\n') {
      rows.push({ text: '', points: [{ column: 4, index: index + 1 }], width: 0 });
    } else {
      row.text += ch;
      row.width += cells;
      row.points.push({ column: 4 + row.width, index: index + 1 });
    }
  }

  const body = rows.map((row, index) => {
    const clean = row.text;
    const prefix = index === 0 ? prompt : '  ';
    const side = style(BOX.vertical, { fg: borderColor });
    return side + padWidth(prefix + clean, topWidth - 2) + side;
  });
  const maxRows = Math.max(1, opts?.maxRows || 6);
  const startRow = Math.max(0, Math.min(rows.length - maxRows, caretRowIndex - maxRows + 1));

  // row 为输入块内的 1-based 行号：1=顶线，2..=正文行；col 为 1-based 显示列
  return {
    lines: [top, ...body.slice(startRow, startRow + maxRows), bottom],
    points: rows.slice(startRow, startRow + maxRows).map((row) => row.points),
    cursor: {
      row: 2 + caretRowIndex - startRow,
      col: Math.min(width - 1, (caretRowIndex === 0 ? promptWidth : 2) + caretCol + 2),
    },
  };
}

/** 补全面板：命令 / 参数建议（输入框上方，无边框列表 + 指针） */
function renderCompletion(theme, completion, width) {
  if (!completion || !Array.isArray(completion.items) || completion.items.length === 0) return [];
  const rows = [];
  completion.items.forEach((item, index) => {
    const selected = index === (completion.selected || 0);
    const pointer = selected ? paint(theme, 'suggestion', FIGURES.pointer + ' ') : '  ';
    const label = selected
      ? style(truncate(item.label, 24), { bold: true, fg: theme.suggestion })
      : paint(theme, 'inactive', truncate(item.label, 24));
    const rest = Math.max(8, width - 30);
    const description = item.description
      ? paint(theme, 'subtle', '  ' + truncate(item.description, rest), { dim: true })
      : '';
    const hint = item.hint
      ? paint(theme, 'subtle', '  ' + truncate(String(item.hint), 12), { dim: true })
      : '';
    rows.push('  ' + pointer + label + description + hint);
  });
  rows.push(
    paint(theme, 'subtle', '  ' + t('ui.tui.completionNav', 'tab 补全 · ↑↓ 选择 · Enter 执行'), {
      dim: true,
    }),
  );
  return rows;
}

/** 模态：▔ 顶线 + 标题 + 选项 */
function renderModal(theme, modal, width, maxHeight, hitRows = []) {
  const color = theme[modal.colorKey || 'permission'] || theme.permission;
  const lines = [style(FIGURES.modalTop.repeat(Math.max(8, width)), { fg: color })];
  const pad = '  ';
  if (modal.title) {
    lines.push(pad + style(modal.title, { bold: true, fg: color }));
  }
  if (modal.subtitle) {
    lines.push(pad + paint(theme, 'subtle', truncate(modal.subtitle, width - 4), { dim: true }));
  }
  if (modal.body) {
    for (const line of wrapText(String(modal.body), width - 4)) {
      lines.push(pad + paint(theme, 'inactive', line, { dim: true }));
    }
  }
  for (const row of modal.usageRows || []) {
    lines.push(pad + paint(theme, 'text', truncate(row.label, width - 4)));
    if (Number.isFinite(row.pct))
      lines.push(
        pad +
          renderProgress(theme, row.pct / 100, Math.max(4, Math.min(40, width - 15))) +
          ' ' +
          Math.round(row.pct) +
          '%',
      );
    if (row.detail) lines.push(pad + paint(theme, 'subtle', truncate(row.detail, width - 4)));
  }
  const optionRows = new Map();
  let selectedRow = 0;
  if (Array.isArray(modal.options)) {
    modal.options.forEach((option, index) => {
      const selected = index === (modal.selected || 0);
      if (selected) selectedRow = lines.length;
      optionRows.set(lines.length, index);
      const pointer = selected ? paint(theme, 'suggestion', FIGURES.pointer + ' ') : '  ';
      const label = selected
        ? style(truncate(option.label, width - 6), { bold: true, fg: theme.suggestion })
        : paint(theme, 'inactive', truncate(option.label, width - 6));
      const tag = option.hint ? paint(theme, 'subtle', '  ' + option.hint, { dim: true }) : '';
      lines.push(pad + pointer + label + tag);
    });
    lines.push(
      pad +
        paint(
          theme,
          'subtle',
          modal.kind === 'todo' && modal.footer
            ? modal.footer
            : t('ui.tui.modalNav', '↑↓ 选择 · Enter 确认 · Esc 取消'),
          {
            dim: true,
          },
        ),
    );
  }
  if (modal.footer && modal.kind !== 'todo') {
    lines.push(pad + paint(theme, 'subtle', modal.footer, { dim: true, italic: true }));
  }
  const finish = (indices) => {
    indices.forEach((source, row) => {
      if (optionRows.has(source)) hitRows.push({ row: row + 1, index: optionRows.get(source) });
    });
    return indices.map((index) => lines[index] || '');
  };
  if (lines.length <= maxHeight) return finish(lines.map((_line, i) => i));
  if (maxHeight < 4)
    return finish([1, selectedRow, lines.length - 1].slice(0, Math.max(0, maxHeight)));
  const available = Math.max(1, maxHeight - 3);
  const content = lines.slice(2, -1);
  const maxOffset = Math.max(0, content.length - available);
  let offset = Math.max(0, Math.min(maxOffset, modal.scrollOffset || 0));
  if (modal.options?.length > 1) {
    const selected = selectedRow - 2;
    if (selected < offset) offset = Math.max(0, selected);
    else if (selected >= offset + available) offset = Math.min(maxOffset, selected - available + 1);
  }
  modal.scrollOffset = offset;
  return finish([
    0,
    1,
    ...content.slice(offset, offset + available).map((_line, i) => offset + i + 2),
    lines.length - 1,
  ]);
}

/**
 * 组装整帧。
 * @returns {{lines: string[], cursor: {row: number, col: number}}}
 */
function composeFrame(state, opts) {
  const theme = state.theme;
  const width = Math.max(20, state.width || 80);
  const height = Math.max(8, state.height || 24);
  const options = opts || {};

  // 启动屏：VM 未就绪时整帧只画进度（不画输入框），避免两帧交替闪烁
  if (state.boot && !state.boot.ready && !state.boot.failed) {
    return composeBootFrame(theme, state, width, height);
  }

  if ((state.width && state.width < 20) || (state.height && state.height < 8)) {
    return {
      lines: [truncate('CIBYP', state.width || 20, '')],
      cursor: { row: 1, col: 1 },
      hideCursor: true,
    };
  }

  const statusLine = renderStatusLine(theme, state, width);
  const footerLine = renderFooter(theme, options.hints || [], width);
  const inputState = state.search?.active
    ? { ...state, editorText: state.search.editor.value, editorCursor: state.search.editor.cursor }
    : state.modal?.inputMode
      ? {
          ...state,
          editorText: state.modal.masked
            ? '•'.repeat(Array.from(state.modal.editor.value).length)
            : state.modal.editor.value,
          editorCursor: state.modal.editor.cursor,
        }
      : state;
  const inputView = renderInput(theme, inputState, width, {
    hint: state.search?.active ? state.search.hint : options.inputHint,
    maxRows: Math.min(6, Math.max(1, height - 10)),
  });

  const bottomBudget = Math.max(0, height - inputView.lines.length - 2);
  const modalHits = [];
  const modalLines = state.modal
    ? renderModal(theme, state.modal, width, bottomBudget, modalHits)
    : [];
  let completionStart = 0;
  let completionLines =
    !state.modal && state.completion ? renderCompletion(theme, state.completion, width) : [];
  if (completionLines.length > bottomBudget) {
    const count = Math.max(0, bottomBudget - 1);
    const start = Math.max(0, (state.completion.selected || 0) - count + 1);
    completionStart = start;
    completionLines = [
      ...completionLines.slice(start, start + count),
      completionLines.at(-1),
    ].slice(0, bottomBudget);
  }
  const fixedBottom = inputView.lines.length + 1 + modalLines.length + completionLines.length; // + footer
  const messageAreaHeight = Math.max(0, height - fixedBottom - 1);

  // 消息区：从底部往上取（scrollOffset = 距底部的行数）
  const allLines = [];
  for (const entry of state.messages || []) {
    if (entry.kind === 'tarot' && state.tarotVisible === false) continue;
    allLines.push(
      ...renderEntry(theme, entry, width, {
        running: state.running,
        mode: state.mode,
        tarotVisible: state.tarotVisible,
        blink: state.blink,
        thinkingExpanded: state.thinkingExpanded,
      }),
    );
    allLines.push(''); // 条目间距
  }
  const transcriptLines = allLines.slice();
  if (state.running) {
    allLines.push(renderSpinnerLine(theme, state, width));
    allLines.push('');
  }

  // Scrolling reserves one row for the indicator. Include it in the upper
  // bound so the first message line is reachable, without accumulating offset
  // once the viewport has reached the top.
  const maxOffset =
    messageAreaHeight > 1 && allLines.length > messageAreaHeight
      ? allLines.length - messageAreaHeight + 1
      : 0;
  const requestedOffset =
    (state.scrollOffset || 0) +
    (state.scrollOffset > 0 && Number.isInteger(state.scrollLineCount)
      ? allLines.length - state.scrollLineCount
      : 0);
  const offset = Math.max(0, Math.min(requestedOffset, maxOffset));
  const indicatorHeight = offset > 0 ? 1 : 0;
  const end = allLines.length - offset;
  const start = Math.max(0, end - (messageAreaHeight - indicatorHeight));
  const range = selectionRange(state.selection, transcriptLines);
  const visible =
    messageAreaHeight > 0
      ? allLines
          .slice(start, end)
          .map((line, index) =>
            highlightLine(
              theme,
              highlightSearch(theme, line, state.search?.query),
              start + index,
              range,
            ),
          )
      : [];
  const rowLines = visible.map((_line, index) =>
    start + index < transcriptLines.length ? start + index : null,
  );
  while (visible.length < messageAreaHeight - indicatorHeight) {
    visible.unshift('');
    rowLines.unshift(null);
  }
  if (indicatorHeight > 0) {
    visible.push(
      paint(
        theme,
        'subtle',
        '  ↓ ' + t('ui.tui.scrolledHint', '{count} 行未显示（PgDn 查看）', { count: offset }),
        { dim: true },
      ),
    );
  }

  const lines = [...visible];
  lines.push(...modalLines);
  lines.push(...completionLines);
  lines.push(...inputView.lines);
  lines.push(footerLine);
  lines.push(statusLine);
  const toastBounds = overlayToast(theme, state.toast, lines, width, bottomBudget, state.now);

  return {
    lines,
    toastBounds,
    hits: {
      modal: modalHits.map((hit) => ({ ...hit, row: visible.length + hit.row })),
      modalBounds: { top: visible.length + 1, height: modalLines.length },
      completion: completionLines.slice(0, -1).map((_line, index) => ({
        row: visible.length + modalLines.length + index + 1,
        index: completionStart + index,
      })),
      input: inputView.points.map((points, index) => ({
        row: visible.length + modalLines.length + completionLines.length + index + 2,
        points,
      })),
    },
    transcript: { lines: transcriptLines, rowLines },
    scroll: { offset, maxOffset, totalLines: allLines.length },
    cursor: {
      // 消息区 + 模态 + 补全面板占掉前若干行，输入块内的行号接在其后
      row: visible.length + modalLines.length + completionLines.length + inputView.cursor.row,
      col: inputView.cursor.col,
    },
  };
}

/** A timed top-right overlay never changes transcript rows or scroll position. */
function overlayToast(theme, toast, lines, width, availableHeight, now = Date.now()) {
  if (!toast || availableHeight < 3 || toast.expiresAt <= now) return null;
  const retry = toast.retry;
  const title = retry
    ? t('ui.tui.retryTitle', 'LLM 重试 #{attempt}', { attempt: retry.attempt || 1 })
    : t('ui.tui.notificationTitle', '通知');
  const detail = retry
    ? [retry.status ? `HTTP ${retry.status}` : retry.kind, retry.reason || retry.error]
        .filter(Boolean)
        .join(' · ')
    : toast.text;
  const countdown =
    retry && availableHeight >= 4
      ? toast.retryAt <= now
        ? t('ui.tui.retryRunning', '正在重试 · Esc 停止')
        : t('ui.tui.retryWait', '{seconds}s 后重试 · Esc 停止', {
            seconds: Math.max(0, Math.ceil((toast.retryAt - now) / 1000)),
          })
      : '';
  const boxWidth = Math.min(60, width - 4);
  const innerWidth = boxWidth - 4;
  const content = wrapText(
    stripAnsi(detail).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' '),
    innerWidth,
  ).slice(0, Math.max(0, Math.min(3, availableHeight - (countdown ? 4 : 3) - 1)));
  const rows = [title, ...content, ...(countdown ? [countdown] : [])];
  const color =
    theme[toast.type === 'error' ? 'error' : retry || toast.type === 'warn' ? 'warning' : 'info'];
  const background = theme.background;
  const border = (text) => style(text, { fg: color, bg: background });
  const box = [
    border('╭' + '─'.repeat(boxWidth - 2) + '╮'),
    ...rows.map(
      (row, i) =>
        border('│ ') +
        style(padWidth(truncate(row, innerWidth, ''), innerWidth), {
          fg: i === 0 ? color : theme.text,
          bg: background,
          bold: i === 0,
        }) +
        border(' │'),
    ),
    border('╰' + '─'.repeat(boxWidth - 2) + '╯'),
  ];
  const top = availableHeight > box.length ? 1 : 0;
  const left = width - boxWidth - 2;
  box.forEach((row, index) => {
    lines[top + index] =
      padWidth(truncate(lines[top + index] || '', left, ''), left) + RESET + row + '  ';
  });
  return { top, left, width: boxWidth, height: box.length };
}

/**
 * 启动屏：VM 启动进度（百分比 + 阶段文本），垂直居中。
 * 与 splash.html 同源（inst.progress/detail）。
 */
function composeBootFrame(theme, state, width, height) {
  const boot = state.boot || {};
  const frames = FIGURES.spinner;
  const frame = frames[(state.spinnerFrame || 0) % frames.length];
  const percent = Math.max(0, Math.min(100, Number(boot.progress) || 0));
  const barWidth = Math.max(20, Math.min(width - 8, 60));

  const body = [
    ...renderBrand(theme, width, height < 15, state.mode),
    '',
    '  ' +
      style(frame, { fg: theme[accentFor(state.mode)], bold: true }) +
      '  ' +
      style(t('ui.tui.vmBooting', '正在启动虚拟机…'), { bold: true }),
    '',
    '  ' +
      renderProgress(theme, percent / 100, barWidth) +
      '  ' +
      paint(theme, 'suggestion', String(percent).padStart(3) + '%', { bold: true }),
    '',
    '  ' + paint(theme, 'subtle', truncate(String(boot.detail || ''), width - 6), { dim: true }),
    '  ' +
      paint(theme, 'subtle', t('ui.tui.vmBootHint', 'VM 就绪后自动进入界面'), {
        dim: true,
        italic: true,
      }),
  ];
  const top = Math.max(0, Math.floor((height - body.length) / 2));
  const lines = [...Array(top).fill(''), ...body].slice(0, height);
  while (lines.length < height - 1) lines.push('');
  return {
    lines: lines.map((line) => truncate(line, width, '')),
    cursor: { row: 1, col: 1 },
    hideCursor: true,
  };
}

function renderBrand(theme, width, compact = false, mode = 'chat') {
  return brandLines(Math.max(0, width - 4), compact).map(
    (line) => '  ' + style(line, { fg: theme[accentFor(mode)], bold: true }),
  );
}

/** 运行中的 spinner 行：闪烁字形 + 文案 + (esc to interrupt · 0:12) */
function renderSpinnerLine(theme, state, width) {
  const frames = FIGURES.spinner;
  const glyph = frames[(state.spinnerFrame || 0) % frames.length];
  const spin = style(glyph, { fg: theme[accentFor(state.mode)], bold: true });
  const label = state.spinnerLabel || t('ui.tui.spinnerThinking', '思考中');
  const elapsed = state.elapsedMs ? ' · ' + formatDuration(state.elapsedMs) : '';
  return (
    '  ' +
    spin +
    ' ' +
    paint(theme, 'subtle', label) +
    paint(theme, 'subtle', ' (' + t('ui.tui.interrupt', 'Esc 停止') + elapsed + ')', { dim: true })
  );
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes + ':' + String(seconds).padStart(2, '0');
}

module.exports = {
  MODE_ACCENT,
  MODE_LABEL,
  accentFor,
  renderInline,
  layoutText,
  summarizeArgs,
  layoutResult,
  renderEntry,
  renderProgress,
  renderStatusLine,
  renderFooter,
  renderInput,
  renderModal,
  renderCompletion,
  renderReasoning,
  renderUsageSummary,
  composeBootFrame,
  fmtTokenCount,
  fmtCost,
  renderSpinnerLine,
  composeFrame,
  formatDuration,
};
