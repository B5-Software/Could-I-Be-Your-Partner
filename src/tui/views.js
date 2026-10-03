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
 *   - 输入框：仅上下两条圆角线，顶线右端内嵌提示；前缀 ❯（模式换色）
 *   - 模态：▔ 顶线（交互色）+ 标题 + 选项列表（❯ 指针 / ✓ 选中）
 *   - 状态栏：模型 │ Context │ 用量 │ 好感度，分隔符 dim
 */

'use strict';

const {
  style,
  paint,
  visibleWidth,
  wrapText,
  truncate,
  padWidth,
  sliceByWidth,
} = require('./ansi.js');
const { FIGURES, BOX } = require('./theme.js');
const { t } = require('./text.js');

/** 模式 → 强调色键 */
const MODE_ACCENT = {
  chat: 'suggestion',
  babe: 'planMode',
  code: 'bashBorder',
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
  const lines = wrapText(String(text == null ? '' : text), Math.max(4, width));
  return lines.map((line) =>
    indent ? indent + renderInline(theme, line) : renderInline(theme, line),
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

/** 推理块：折叠时一行摘要（∴ 思考中 (320 字)），展开时缩进全文 */
function renderReasoning(theme, reasoning, width, expanded) {
  const raw = String(reasoning || '').trim();
  if (!raw) return [];
  const chars = raw.length;
  const head = '  ' + paint(theme, 'subtle', FIGURES.thinking + ' ', { dim: true });
  if (!expanded) {
    const preview = raw.split('\n')[0];
    const summary = truncate(
      preview,
      Math.max(8, width - visibleWidth(head) - String(chars).length - 8),
    );
    return [
      head +
        style(t('ui.tui.thinking', '思考中'), { dim: true, italic: true }) +
        ' ' +
        paint(theme, 'subtle', t('ui.tui.thinkingChars', '({count} 字)', { count: chars }), {
          dim: true,
        }) +
        (summary ? '  ' + paint(theme, 'inactive', summary, { dim: true }) : ''),
    ];
  }
  const lines = wrapText(raw, Math.max(8, width - 4));
  return [
    head + style(t('ui.tui.thinking', '思考中'), { dim: true, bold: true }),
    ...lines.map((line) => paint(theme, 'subtle', '    ' + line, { dim: true })),
  ];
}

/** 消息条目 → 样式行 */
function renderEntry(theme, entry, width, opts) {
  const state = opts || {};
  switch (entry.kind) {
    case 'user': {
      const indent = '  ';
      const lines = layoutText(theme, entry.text, width - 4, indent);
      const mark = paint(theme, 'subtle', FIGURES.pointer + ' ');
      return lines.map((line, index) => {
        const content = index === 0 ? mark + line : '  ' + line;
        return style(padWidth(content, width), { bg: theme.userMessageBackground });
      });
    }
    case 'assistant': {
      const out = [];
      // 推理内容（thinking/reasoning）：折叠一行摘要，展开全文（/thinking 全局切换）
      if (entry.reasoning) {
        out.push(...renderReasoning(theme, entry.reasoning, width, state.thinkingExpanded));
      }
      if (entry.text && String(entry.text).trim() !== '') {
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
      const name =
        (entry.card && (entry.card.name || entry.card.title)) || t('ui.tui.tarotCard', '命运之牌');
      const meaning = (entry.card && (entry.card.meaning || entry.card.desc)) || '';
      return [
        '  ' +
          paint(theme, 'accent', FIGURES.diamond, { bold: true }) +
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
  const cost = fmtCost(state.costUSD);
  if (cost) parts.push(cost);
  return parts.join(' · ');
}

/** 状态栏：左＝模式/模型/好感度/工作区，右＝用量(占比)[· 成本] */
function renderStatusLine(theme, state, width) {
  const parts = [];
  const accent = accentFor(state.mode);
  parts.push(paint(theme, accent, MODE_LABEL[state.mode] || state.mode, { bold: true }));
  if (state.model) parts.push(truncate(state.model, 28));
  if (state.mode === 'babe' && state.affection != null) {
    parts.push(paint(theme, 'planMode', FIGURES.heart + ' ' + state.affection, { bold: true }));
  }
  if (state.workspace && state.mode === 'code') {
    parts.push(truncate(state.workspace, 24));
  }
  const sep = paint(theme, 'subtle', ' │ ', { dim: true });
  const left = parts.join(sep);
  const right = renderUsageSummary(theme, state);
  if (!right) return truncate(left, width);
  const gap = width - visibleWidth(left) - visibleWidth(right) - 3;
  if (gap < 1) return truncate(left + sep + right, width, '');
  return left + ' '.repeat(gap) + paint(theme, 'inactive', right, { dim: true });
}

/** 底部提示（dim，' · ' 连接） */
function renderFooter(theme, hints, width) {
  const usable = hints.filter(Boolean);
  const sep = paint(theme, 'subtle', ' · ', { dim: true });
  return truncate(usable.join(sep), width, '');
}

/** 输入框：上下双线 + ❯ 前缀（顶线右端内嵌提示） */
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
  const textLines = String(state.editorText || '').split('\n');
  const innerWidth = Math.max(4, topWidth - 2);

  // 光标定位：把零宽占位符插到光标处再排版，然后在渲染行里找回它。
  // 这样软换行、CJK/全角（按 2 格）、多行缓冲的落位都天然正确 ——
  // 而不是按"字符数"估算（那会在中文输入时横向漂移）。
  const CARET = String.fromCharCode(0x200b); // 零宽空格，宽度按 0 计
  const cursorIndex = Number.isInteger(state.editorCursor)
    ? Math.max(0, Math.min(state.editorCursor, Array.from(state.editorText || '').length))
    : 0;
  const chars = Array.from(state.editorText || '');
  const markedText =
    chars.slice(0, cursorIndex).join('') + CARET + chars.slice(cursorIndex).join('');

  const rows = [];
  for (const line of markedText.split('\n')) {
    const wrapped = wrapText(line, innerWidth);
    if (wrapped.length === 0) rows.push('');
    else rows.push(...wrapped);
  }
  if (rows.length === 0) rows.push('');

  // 找回占位符所在的渲染行与显示列
  let caretRowIndex = rows.findIndex((row) => row.includes(CARET));
  if (caretRowIndex === -1) caretRowIndex = rows.length - 1;
  const caretRowText = rows[caretRowIndex];
  const caretMarkerAt = caretRowText.indexOf(CARET);
  const caretCol =
    caretMarkerAt === -1
      ? visibleWidth(caretRowText)
      : visibleWidth(caretRowText.slice(0, caretMarkerAt));

  const body = rows.map((row, index) => {
    const clean = row.split(CARET).join('');
    const prefix = index === 0 ? prompt : '  ';
    return prefix + clean;
  });

  // row 为输入块内的 1-based 行号：1=顶线，2..=正文行；col 为 1-based 显示列
  return {
    lines: [top, ...body, bottom],
    cursor: { row: 2 + caretRowIndex, col: (caretRowIndex === 0 ? promptWidth : 2) + caretCol + 1 },
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
function renderModal(theme, modal, width) {
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
  if (Array.isArray(modal.options)) {
    modal.options.forEach((option, index) => {
      const selected = index === (modal.selected || 0);
      const pointer = selected ? paint(theme, 'suggestion', FIGURES.pointer + ' ') : '  ';
      const label = selected
        ? style(option.label, { bold: true, fg: theme.suggestion })
        : paint(theme, 'inactive', option.label);
      const tag = option.hint ? paint(theme, 'subtle', '  ' + option.hint, { dim: true }) : '';
      lines.push(pad + pointer + label + tag);
    });
    lines.push(
      pad +
        paint(theme, 'subtle', t('ui.tui.modalNav', '↑↓ 选择 · Enter 确认 · Esc 取消'), {
          dim: true,
        }),
    );
  }
  if (modal.footer) {
    lines.push(pad + paint(theme, 'subtle', modal.footer, { dim: true, italic: true }));
  }
  return lines;
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

  const statusLine = renderStatusLine(theme, state, width);
  const footerLine = renderFooter(theme, options.hints || [], width);
  const inputView = renderInput(theme, state, width, { hint: options.inputHint });

  const modalLines = state.modal ? renderModal(theme, state.modal, width) : [];
  const completionLines = state.completion ? renderCompletion(theme, state.completion, width) : [];
  const fixedBottom = inputView.lines.length + 1 + modalLines.length + completionLines.length; // + footer
  const messageAreaHeight = Math.max(3, height - fixedBottom - 1);

  // 消息区：从底部往上取（scrollOffset = 距底部的行数）
  const allLines = [];
  for (const entry of state.messages || []) {
    allLines.push(
      ...renderEntry(theme, entry, width, { running: state.running, blink: state.blink }),
    );
    allLines.push(''); // 条目间距
  }
  if (state.running) {
    allLines.push(renderSpinnerLine(theme, state, width));
    allLines.push('');
  }
  if (state.toast) {
    allLines.push(
      '  ' +
        style(truncate(state.toast.text, width - 4), {
          fg: theme.inverseText,
          bg: theme.suggestion,
          bold: true,
        }),
    );
    allLines.push('');
  }

  const offset = Math.max(
    0,
    Math.min(state.scrollOffset || 0, Math.max(0, allLines.length - messageAreaHeight)),
  );
  const indicatorHeight = offset > 0 ? 1 : 0;
  const end = allLines.length - offset;
  const start = Math.max(0, end - (messageAreaHeight - indicatorHeight));
  const visible = allLines.slice(start, end);
  while (visible.length < messageAreaHeight - indicatorHeight) visible.unshift('');
  if (indicatorHeight > 0) {
    visible.push(
      paint(
        theme,
        'subtle',
        '  ↑ ' + t('ui.tui.scrolledHint', '{count} 行未显示（PgUp 查看）', { count: offset }),
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

  return {
    lines,
    cursor: {
      // 消息区 + 模态 + 补全面板占掉前若干行，输入块内的行号接在其后
      row: visible.length + modalLines.length + completionLines.length + inputView.cursor.row,
      col: inputView.cursor.col,
    },
  };
}

/** 运行中的 spinner 行：闪烁字形 + 文案 + (esc to interrupt · 0:12) */
function renderSpinnerLine(theme, state, width) {
  const frames = FIGURES.spinner;
  const glyph = frames[(state.spinnerFrame || 0) % frames.length];
  const spin = style(glyph, { fg: theme.accent, bold: true });
  const label = state.spinnerLabel || t('ui.tui.spinnerThinking', '思考中');
  const elapsed = state.elapsedMs ? ' · ' + formatDuration(state.elapsedMs) : '';
  return (
    '  ' +
    spin +
    ' ' +
    style(label, { dim: true }) +
    paint(theme, 'subtle', ' (esc to interrupt' + elapsed + ')', { dim: true })
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
  fmtTokenCount,
  fmtCost,
  renderSpinnerLine,
  composeFrame,
  formatDuration,
};
