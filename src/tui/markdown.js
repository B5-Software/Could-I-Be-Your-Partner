/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const MarkdownIt = require('markdown-it');
const { visibleWidth, wrapText, padWidth, style, stripAnsi } = require('./ansi');
const parser = new MarkdownIt({ html: false, linkify: false });
function tableRows(tokens) {
  const rows = [];
  let row, cell;
  for (const token of tokens) {
    if (token.type === 'tr_open') {
      row = [];
      rows.push(row);
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      cell = { text: '', align: token.attrGet('style')?.split(':')[1] || 'left' };
      row.push(cell);
    }
    if (token.type === 'inline' && cell) cell.text = token.content;
  }
  return rows;
}
function renderTable(theme, rows, width, inline) {
  if (!rows.length) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  if (columns * 7 + 1 > width) {
    return rows
      .slice(1)
      .flatMap((row) => [
        ...row.flatMap((cell, i) =>
          wrapText(`${rows[0][i]?.text || i + 1}: ${cell.text}`, width).map((line) =>
            inline(theme, line),
          ),
        ),
        '',
      ]);
  }
  const available = width - columns * 3 - 1;
  const sizes = Array.from({ length: columns }, (_, i) =>
    Math.max(4, ...rows.map((row) => visibleWidth(inline(theme, row[i]?.text || '')))),
  );
  while (sizes.reduce((a, b) => a + b, 0) > available) {
    const largest = sizes.indexOf(Math.max(...sizes));
    if (sizes[largest] <= 4) break;
    sizes[largest]--;
  }
  const rule = (left, middle, right) =>
    style(left + sizes.map((size) => '─'.repeat(size + 2)).join(middle) + right, {
      fg: theme.subtle,
    });
  const result = [rule('┌', '┬', '┐')];
  rows.forEach((row, index) => {
    const cells = sizes.map((size, column) =>
      wrapText(stripAnsi(inline(theme, row[column]?.text || '')), size).map((line) =>
        index === 0 ? style(line, { bold: true, fg: theme.suggestion }) : line,
      ),
    );
    const height = Math.max(...cells.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      result.push(
        '│ ' +
          sizes
            .map((size, column) => {
              const text = cells[column][line] || '';
              const gap = Math.max(0, size - visibleWidth(text));
              const align = row[column]?.align;
              return align === 'right'
                ? ' '.repeat(gap) + text
                : align === 'center'
                  ? ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2))
                  : padWidth(text, size);
            })
            .join(' │ ') +
          ' │',
      );
    }
    if (index === 0 && rows.length > 1) result.push(rule('├', '┼', '┤'));
  });
  result.push(rule('└', '┴', '┘'));
  return result;
}
function markdownLines(theme, text, width, inline) {
  const source = String(text || ''),
    tokens = parser.parse(source, {}),
    lines = source.split('\n');
  const tables = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue;
    const start = i,
      map = tokens[i].map;
    while (i < tokens.length && tokens[i].type !== 'table_close') i++;
    tables.push({ start: map[0], end: map[1], rows: tableRows(tokens.slice(start, i + 1)) });
  }
  const output = [];
  let cursor = 0;
  for (const table of tables) {
    if (cursor < table.start)
      output.push(
        ...wrapText(lines.slice(cursor, table.start).join('\n'), width).map((line) =>
          inline(theme, line),
        ),
      );
    output.push(...renderTable(theme, table.rows, width, inline));
    cursor = table.end;
  }
  if (cursor < lines.length)
    output.push(
      ...wrapText(lines.slice(cursor).join('\n'), width).map((line) => inline(theme, line)),
    );
  return output;
}
module.exports = { markdownLines, renderTable, tableRows };
