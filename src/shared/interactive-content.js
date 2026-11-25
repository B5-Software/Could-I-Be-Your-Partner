/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  const MAX_ROWS = 120;
  const MAX_COLUMNS = 8;
  const MAX_CELL = 180;
  const text = (value, max) =>
    typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  function validate(value) {
    if (
      !value || typeof value !== 'object' ||
      Object.keys(value).some((key) => !['title', 'columns', 'rows', 'chartColumn'].includes(key)) ||
      !text(value.title, 120) || !value.title.trim() ||
      !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > MAX_COLUMNS ||
      !value.columns.every((column) => text(column, 60) && column.trim()) ||
      !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > MAX_ROWS ||
      value.rows.some((row) => !Array.isArray(row) || row.length !== value.columns.length ||
        row.some((cell) => !(cell === null || Number.isFinite(cell) || text(cell, MAX_CELL))))
    ) throw new Error('Invalid interactive content. Use bounded table data.');
    if (value.chartColumn !== undefined && (
      !Number.isInteger(value.chartColumn) || value.chartColumn < 0 ||
      value.chartColumn >= value.columns.length ||
      !value.rows.every((row) => row[value.chartColumn] === null || Number.isFinite(row[value.chartColumn]))
    )) throw new Error('The chart column must contain numbers or null.');
    return {
      title: value.title.trim(),
      columns: [...value.columns],
      rows: value.rows.map((row) => [...row]),
      ...(value.chartColumn !== undefined && { chartColumn: value.chartColumn }),
    };
  }
  const api = { validate, MAX_ROWS, MAX_COLUMNS, MAX_CELL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InteractiveContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
