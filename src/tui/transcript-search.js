/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { LineEditor } = require('./editor');
const { stripAnsi, visibleWidth, style } = require('./ansi');
const { t } = require('./text');
function findMatches(lines, query) {
  if (!query) return [];
  const matches = [],
    needle = query.toLowerCase();
  lines.forEach((line, row) => {
    const plain = stripAnsi(line),
      text = plain.toLowerCase();
    for (
      let index = text.indexOf(needle);
      index >= 0;
      index = text.indexOf(needle, index + Math.max(1, needle.length))
    ) {
      matches.push({
        line: row,
        column: visibleWidth(plain.slice(0, index)),
        end: visibleWidth(plain.slice(0, index + query.length)),
      });
    }
  });
  return matches;
}
function highlightSearch(theme, line, query) {
  if (!query || !stripAnsi(line).toLowerCase().includes(query.toLowerCase())) return line;
  const plain = stripAnsi(line),
    lower = plain.toLowerCase(),
    needle = query.toLowerCase();
  let start = 0;
  const ranges = [];
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, start)) {
    ranges.push([index, index + query.length]);
    start = index + query.length;
  }
  const emphasis = style('', { fg: theme.inverseText, bg: theme.suggestion, bold: true }).replace(
    /\u001b\[0m$/,
    '',
  );
  let out = '',
    position = 0,
    selected = false,
    styles = [];
  for (const token of line.match(/\u001b\[[\d;:]*m|[^\u001b]/gu) || []) {
    if (token.startsWith('\u001b')) {
      styles = /^\u001b\[(?:0)?m$/.test(token) ? [] : [...styles, token];
      out += token + (selected ? emphasis : '');
      continue;
    }
    const highlight = ranges.some(([begin, end]) => position >= begin && position < end);
    if (highlight !== selected) out += highlight ? emphasis : '\u001b[0m' + styles.join('');
    selected = highlight;
    out += token;
    position += token.length;
  }
  if (selected) out += '\u001b[0m' + styles.join('');
  return out;
}
class TranscriptSearch {
  constructor(app) {
    this.app = app;
  }
  open() {
    const editor = new LineEditor();
    editor.setValue(this.app.state.search?.query || '');
    this.app.state.search = {
      editor,
      query: editor.value,
      active: true,
      selected: 0,
      matches: [],
      locate: true,
    };
  }
  handle(key) {
    const search = this.app.state.search;
    if (!search) return false;
    if (key.name === 'f3' || (search.active && key.name === 'enter')) {
      search.selected += key.shift ? -1 : 1;
      search.locate = true;
      return true;
    }
    if (!search.active) return false;
    if (key.name === 'escape' || (key.ctrl && key.char === 'c')) {
      search.active = false;
      return true;
    }
    search.editor.handleKey(key);
    search.query = search.editor.value;
    search.selected = 0;
    search.locate = true;
    return true;
  }
  update(lines, height) {
    const search = this.app.state.search;
    if (!search) return;
    search.matches = findMatches(lines, search.query);
    search.selected = search.matches.length
      ? ((search.selected % search.matches.length) + search.matches.length) % search.matches.length
      : 0;
    if (search.locate && search.matches.length) {
      this.app.state.scrollOffset = Math.max(
        0,
        lines.length - search.matches[search.selected].line - Math.floor(height / 2),
      );
      this.app.state.scrollLineCount = lines.length;
    }
    search.locate = false;
    search.hint = t(
      'ui.tui.searchHint',
      '搜索 {index}/{count} · Enter/F3 下一处 · Shift+Enter/F3 上一处 · Esc 返回',
      { index: search.matches.length ? search.selected + 1 : 0, count: search.matches.length },
    );
  }
}
module.exports = { TranscriptSearch, findMatches, highlightSearch };
