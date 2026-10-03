/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { stripAnsi, visibleWidth, sliceByWidth, charWidth, style, colorCode } = require('./ansi');

function pointAt(transcript, x, y, nearest = false) {
  if (!transcript?.rowLines.length) return null;
  const row = Math.max(0, Math.min(transcript.rowLines.length - 1, y - 1));
  let line = transcript.rowLines[row];
  if (line == null && nearest) {
    const populated = transcript.rowLines
      .map((value, index) => ({ value, index }))
      .filter((item) => item.value != null);
    line = populated.sort((a, b) => Math.abs(a.index - row) - Math.abs(b.index - row))[0]?.value;
  }
  if (line == null || line >= transcript.lines.length) return null;
  const text = stripAnsi(transcript.lines[line]);
  let column = Math.max(0, Math.min(visibleWidth(text), x - 1)),
    seen = 0;
  for (const char of text) {
    const width = charWidth(char.codePointAt(0));
    if (seen < column && seen + width > column) {
      column = seen;
      break;
    }
    seen += width;
  }
  return { line, column };
}

function selectionRange(selection, lines) {
  if (!selection?.anchor || !selection?.focus || !selection.moved) return null;
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
  const [start, end] = before(selection.anchor, selection.focus)
    ? [selection.anchor, selection.focus]
    : [selection.focus, selection.anchor];
  if (start.line >= lines.length || end.line >= lines.length) return null;
  const char = Array.from(sliceByWidth(lines[end.line], end.column, 2))[0];
  return {
    start,
    end: { line: end.line, column: end.column + (char ? charWidth(char.codePointAt(0)) : 0) },
  };
}

function selectedText(selection, lines) {
  const range = selectionRange(selection, lines);
  if (!range) return '';
  const result = [];
  for (let line = range.start.line; line <= range.end.line; line++) {
    const start = line === range.start.line ? range.start.column : 0;
    const end = line === range.end.line ? range.end.column : visibleWidth(lines[line]);
    result.push(sliceByWidth(lines[line], start, Math.max(0, end - start)).trimEnd());
  }
  return result.join('\n');
}

function highlightLine(theme, text, line, range) {
  if (!range || line < range.start.line || line > range.end.line) return text;
  const plain = stripAnsi(text),
    width = visibleWidth(plain);
  const start = line === range.start.line ? range.start.column : 0;
  const end = Math.min(width, line === range.end.line ? range.end.column : width);
  const background = text.includes(colorCode(theme.userMessageBackground, true))
    ? theme.userMessageBackground
    : undefined;
  return (
    style(sliceByWidth(plain, 0, start), { fg: theme.text, bg: background }) +
    style(sliceByWidth(plain, start, Math.max(0, end - start)), {
      fg: theme.text,
      bg: theme.selectionBg,
    }) +
    style(sliceByWidth(plain, end, width - end), { fg: theme.text, bg: background })
  );
}

module.exports = { pointAt, selectedText, selectionRange, highlightLine };
