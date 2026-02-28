/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Spreadsheet Engine for Could I Be Your Partner
 * In-memory spreadsheet with formula support, formatting, and XLSX export
 */

class SpreadsheetEngine {
  constructor() {
    this.data = {};       // { 'A1': { raw: '=SUM(A2:A5)', value: 10, format: {} } }
    this.colCount = 26;   // A-Z
    this.rowCount = 100;
    this.title = '数据表格';
    this.onChange = null;  // callback when data changes
  }

  // ---- Cell Address Helpers ----
  static colToIndex(col) {
    col = col.toUpperCase();
    let n = 0;
    for (let i = 0; i < col.length; i++) n = n * 26 + col.charCodeAt(i) - 64;
    return n; // 1-based
  }

  static indexToCol(n) {
    let s = '';
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  }

  static parseAddr(addr) {
    const m = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    return { col: m[1], row: parseInt(m[2]), colIndex: SpreadsheetEngine.colToIndex(m[1]) };
  }

  static rangeToAddrs(range) {
    const upper = range.toUpperCase();
    // Single-cell address (no colon) — return just that one cell
    if (!upper.includes(':')) {
      const s = SpreadsheetEngine.parseAddr(upper);
      return s ? [upper] : [];
    }
    const [start, end] = upper.split(':');
    const s = SpreadsheetEngine.parseAddr(start);
    const e = SpreadsheetEngine.parseAddr(end);
    if (!s || !e) return [];
    const addrs = [];
    for (let c = s.colIndex; c <= e.colIndex; c++) {
      for (let r = s.row; r <= e.row; r++) {
        addrs.push(SpreadsheetEngine.indexToCol(c) + r);
      }
    }
    return addrs;
  }

  // ---- Core Operations ----
  setCell(addr, rawValue) {
    addr = addr.toUpperCase();
    if (!this.data[addr]) this.data[addr] = { raw: '', value: '', format: {} };
    this.data[addr].raw = rawValue != null ? String(rawValue) : '';
    this._recalc();
    this._notify();
    return this.getCell(addr);
  }

  getCell(addr) {
    addr = addr.toUpperCase();
    const cell = this.data[addr];
    if (!cell) return { addr, raw: '', value: '', format: {} };
    return { addr, raw: cell.raw, value: cell.value, format: { ...cell.format } };
  }

  setCells(entries) {
    // entries: [{addr, value}, ...]
    for (const e of entries) {
      const addr = e.addr.toUpperCase();
      if (!this.data[addr]) this.data[addr] = { raw: '', value: '', format: {} };
      this.data[addr].raw = e.value != null ? String(e.value) : '';
    }
    this._recalc();
    this._notify();
    return { ok: true, count: entries.length };
  }

  getCells(range) {
    const addrs = SpreadsheetEngine.rangeToAddrs(range);
    return addrs.map(a => this.getCell(a));
  }

  clearCells(range) {
    if (range) {
      const addrs = SpreadsheetEngine.rangeToAddrs(range);
      for (const a of addrs) delete this.data[a];
    } else {
      this.data = {};
    }
    this._recalc();
    this._notify();
    return { ok: true };
  }

  // ---- Formatting ----
  setCellFormat(addr, format) {
    addr = addr.toUpperCase();
    if (!this.data[addr]) this.data[addr] = { raw: '', value: '', format: {} };
    Object.assign(this.data[addr].format, format);
    this._notify();
    return this.getCell(addr);
  }

  setRangeFormat(range, format) {
    const addrs = SpreadsheetEngine.rangeToAddrs(range);
    for (const a of addrs) {
      if (!this.data[a]) this.data[a] = { raw: '', value: '', format: {} };
      Object.assign(this.data[a].format, format);
    }
    this._notify();
    return { ok: true, count: addrs.length };
  }

  // ---- Row & Column Ops ----
  insertRow(rowNum, count = 1) {
    const newData = {};
    for (const [addr, cell] of Object.entries(this.data)) {
      const p = SpreadsheetEngine.parseAddr(addr);
      if (!p) continue;
      if (p.row >= rowNum) {
        newData[p.col + (p.row + count)] = cell;
      } else {
        newData[addr] = cell;
      }
    }
    this.data = newData;
    this._recalc();
    this._notify();
    return { ok: true };
  }

  deleteRow(rowNum, count = 1) {
    const newData = {};
    for (const [addr, cell] of Object.entries(this.data)) {
      const p = SpreadsheetEngine.parseAddr(addr);
      if (!p) continue;
      if (p.row >= rowNum && p.row < rowNum + count) continue;
      if (p.row >= rowNum + count) {
        newData[p.col + (p.row - count)] = cell;
      } else {
        newData[addr] = cell;
      }
    }
    this.data = newData;
    this._recalc();
    this._notify();
    return { ok: true };
  }

  insertCol(colLetter, count = 1) {
    const colIdx = SpreadsheetEngine.colToIndex(colLetter.toUpperCase());
    const newData = {};
    for (const [addr, cell] of Object.entries(this.data)) {
      const p = SpreadsheetEngine.parseAddr(addr);
      if (!p) continue;
      if (p.colIndex >= colIdx) {
        newData[SpreadsheetEngine.indexToCol(p.colIndex + count) + p.row] = cell;
      } else {
        newData[addr] = cell;
      }
    }
    this.data = newData;
    this._recalc();
    this._notify();
    return { ok: true };
  }

  deleteCol(colLetter, count = 1) {
    const colIdx = SpreadsheetEngine.colToIndex(colLetter.toUpperCase());
    const newData = {};
    for (const [addr, cell] of Object.entries(this.data)) {
      const p = SpreadsheetEngine.parseAddr(addr);
      if (!p) continue;
      if (p.colIndex >= colIdx && p.colIndex < colIdx + count) continue;
      if (p.colIndex >= colIdx + count) {
        newData[SpreadsheetEngine.indexToCol(p.colIndex - count) + p.row] = cell;
      } else {
        newData[addr] = cell;
      }
    }
    this.data = newData;
    this._recalc();
    this._notify();
    return { ok: true };
  }

  // ---- Sort ----
  sortRange(range, colLetter, ascending = true) {
    const [start, end] = range.toUpperCase().split(':');
    const s = SpreadsheetEngine.parseAddr(start);
    const e = SpreadsheetEngine.parseAddr(end);
    if (!s || !e) return { ok: false, error: '无效范围' };

    const sortCol = colLetter.toUpperCase();
    const rows = [];
    for (let r = s.row; r <= e.row; r++) {
      const row = {};
      for (let c = s.colIndex; c <= e.colIndex; c++) {
        const addr = SpreadsheetEngine.indexToCol(c) + r;
        row[SpreadsheetEngine.indexToCol(c)] = this.data[addr] ? { ...this.data[addr] } : null;
      }
      row._sortVal = this.data[sortCol + r]?.value ?? '';
      rows.push(row);
    }

    rows.sort((a, b) => {
      let va = a._sortVal, vb = b._sortVal;
      if (typeof va === 'number' && typeof vb === 'number') return ascending ? va - vb : vb - va;
      va = String(va); vb = String(vb);
      return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    for (let i = 0; i < rows.length; i++) {
      const r = s.row + i;
      for (let c = s.colIndex; c <= e.colIndex; c++) {
        const col = SpreadsheetEngine.indexToCol(c);
        const addr = col + r;
        if (rows[i][col]) {
          this.data[addr] = rows[i][col];
        } else {
          delete this.data[addr];
        }
      }
    }
    this._recalc();
    this._notify();
    return { ok: true };
  }

  // ---- Data Summary ----
  getUsedRange() {
    const keys = Object.keys(this.data).filter(k => this.data[k].raw !== '');
    if (keys.length === 0) return null;
    let minCol = Infinity, maxCol = 0, minRow = Infinity, maxRow = 0;
    for (const k of keys) {
      const p = SpreadsheetEngine.parseAddr(k);
      if (!p) continue;
      minCol = Math.min(minCol, p.colIndex);
      maxCol = Math.max(maxCol, p.colIndex);
      minRow = Math.min(minRow, p.row);
      maxRow = Math.max(maxRow, p.row);
    }
    return {
      start: SpreadsheetEngine.indexToCol(minCol) + minRow,
      end: SpreadsheetEngine.indexToCol(maxCol) + maxRow,
      cols: maxCol - minCol + 1,
      rows: maxRow - minRow + 1,
      cellCount: keys.length
    };
  }

  getData() {
    const range = this.getUsedRange();
    if (!range) return { title: this.title, range: null, cells: [] };
    const cells = [];
    const s = SpreadsheetEngine.parseAddr(range.start);
    const e = SpreadsheetEngine.parseAddr(range.end);
    for (let r = s.row; r <= e.row; r++) {
      for (let c = s.colIndex; c <= e.colIndex; c++) {
        const addr = SpreadsheetEngine.indexToCol(c) + r;
        const cell = this.data[addr];
        if (cell && cell.raw !== '') {
          cells.push({ addr, raw: cell.raw, value: cell.value, format: cell.format });
        }
      }
    }
    return { title: this.title, range, cells };
  }

  // ---- Export as CSV ----
  exportCSV() {
    const range = this.getUsedRange();
    if (!range) return '';
    const s = SpreadsheetEngine.parseAddr(range.start);
    const e = SpreadsheetEngine.parseAddr(range.end);
    const rows = [];
    for (let r = s.row; r <= e.row; r++) {
      const cols = [];
      for (let c = s.colIndex; c <= e.colIndex; c++) {
        const addr = SpreadsheetEngine.indexToCol(c) + r;
        const cell = this.data[addr];
        let v = cell ? String(cell.value ?? '') : '';
        if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"';
        cols.push(v);
      }
      rows.push(cols.join(','));
    }
    return rows.join('\n');
  }

  // ---- Import from CSV ----
  importCSV(csv, startAddr = 'A1') {
    const s = SpreadsheetEngine.parseAddr(startAddr);
    if (!s) return { ok: false, error: '无效起始地址' };
    const lines = csv.split(/\r?\n/);
    let rowOffset = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = this._parseCSVLine(line);
      for (let i = 0; i < cols.length; i++) {
        const addr = SpreadsheetEngine.indexToCol(s.colIndex + i) + (s.row + rowOffset);
        if (!this.data[addr]) this.data[addr] = { raw: '', value: '', format: {} };
        this.data[addr].raw = cols[i];
      }
      rowOffset++;
    }
    this._recalc();
    this._notify();
    return { ok: true, rows: rowOffset };
  }

  _parseCSVLine(line) {
    const result = [];
    let inQuotes = false, current = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { result.push(current); current = ''; }
        else current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // ---- Formula Engine ----
  _recalc() {
    // Topological sort for dependency order
    const deps = {};
    const order = [];
    const visiting = new Set();
    const visited = new Set();

    for (const addr of Object.keys(this.data)) {
      if (this.data[addr].raw.startsWith('=')) {
        deps[addr] = this._extractRefs(this.data[addr].raw);
      }
    }

    const visit = (addr) => {
      if (visited.has(addr)) return;
      if (visiting.has(addr)) { /* circular */ visited.add(addr); return; }
      visiting.add(addr);
      for (const dep of (deps[addr] || [])) visit(dep);
      visiting.delete(addr);
      visited.add(addr);
      order.push(addr);
    };

    for (const addr of Object.keys(this.data)) visit(addr);

    for (const addr of order) {
      const cell = this.data[addr];
      if (!cell) continue;
      if (cell.raw.startsWith('=')) {
        try {
          cell.value = this._evalFormula(cell.raw.substring(1));
        } catch (e) {
          cell.value = '#ERROR: ' + e.message;
        }
      } else {
        const num = Number(cell.raw);
        cell.value = cell.raw === '' ? '' : isNaN(num) ? cell.raw : num;
      }
    }
  }

  _extractRefs(formula) {
    const refs = new Set();
    // Match range refs like A1:B5
    const rangeRegex = /([A-Z]+\d+):([A-Z]+\d+)/gi;
    let m;
    while ((m = rangeRegex.exec(formula))) {
      const addrs = SpreadsheetEngine.rangeToAddrs(m[0]);
      for (const a of addrs) refs.add(a);
    }
    // Match single cell refs like A1
    const cellRegex = /(?<![A-Z])([A-Z]+)(\d+)(?![A-Z0-9:])/gi;
    while ((m = cellRegex.exec(formula))) {
      refs.add(m[1].toUpperCase() + m[2]);
    }
    return [...refs];
  }

  _getCellValue(addr) {
    const cell = this.data[addr.toUpperCase()];
    if (!cell) return 0;
    return cell.value ?? 0;
  }

  _getRangeValues(range) {
    return SpreadsheetEngine.rangeToAddrs(range).map(a => this._getCellValue(a));
  }

  _evalFormula(expr) {
    // Replace function calls
    let processed = expr;

    // Built-in functions
    const funcs = {
      SUM: (vals) => vals.reduce((s, v) => s + (Number(v) || 0), 0),
      AVERAGE: (vals) => { const nums = vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number); return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : 0; },
      AVG: (vals) => funcs.AVERAGE(vals),
      COUNT: (vals) => vals.filter(v => v !== '' && v !== null && v !== undefined).length,
      COUNTA: (vals) => vals.filter(v => v !== '' && v !== null && v !== undefined).length,
      COUNTBLANK: (vals) => vals.filter(v => v === '' || v === null || v === undefined).length,
      MAX: (vals) => Math.max(...vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number)),
      MIN: (vals) => Math.min(...vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number)),
      ABS: (vals) => Math.abs(Number(vals[0]) || 0),
      ROUND: (vals) => { const n = Number(vals[0]) || 0; const d = Number(vals[1]) || 0; const f = Math.pow(10, d); return Math.round(n * f) / f; },
      FLOOR: (vals) => Math.floor(Number(vals[0]) || 0),
      CEIL: (vals) => Math.ceil(Number(vals[0]) || 0),
      CEILING: (vals) => Math.ceil(Number(vals[0]) || 0),
      SQRT: (vals) => Math.sqrt(Number(vals[0]) || 0),
      POWER: (vals) => Math.pow(Number(vals[0]) || 0, Number(vals[1]) || 0),
      POW: (vals) => Math.pow(Number(vals[0]) || 0, Number(vals[1]) || 0),
      MOD: (vals) => (Number(vals[0]) || 0) % (Number(vals[1]) || 1),
      INT: (vals) => Math.trunc(Number(vals[0]) || 0),
      LN: (vals) => Math.log(Number(vals[0]) || 1),
      LOG: (vals) => { const v = Number(vals[0]) || 1; const b = Number(vals[1]) || 10; return Math.log(v) / Math.log(b); },
      LOG10: (vals) => Math.log10(Number(vals[0]) || 1),
      EXP: (vals) => Math.exp(Number(vals[0]) || 0),
      PI: () => Math.PI,
      SIN: (vals) => Math.sin(Number(vals[0]) || 0),
      COS: (vals) => Math.cos(Number(vals[0]) || 0),
      TAN: (vals) => Math.tan(Number(vals[0]) || 0),
      ASIN: (vals) => Math.asin(Number(vals[0]) || 0),
      ACOS: (vals) => Math.acos(Number(vals[0]) || 0),
      ATAN: (vals) => Math.atan(Number(vals[0]) || 0),
      RAND: () => Math.random(),
      RANDBETWEEN: (vals) => { const lo = Number(vals[0]) || 0; const hi = Number(vals[1]) || 1; return Math.floor(Math.random() * (hi - lo + 1)) + lo; },
      // Text
      LEN: (vals) => String(vals[0] ?? '').length,
      UPPER: (vals) => String(vals[0] ?? '').toUpperCase(),
      LOWER: (vals) => String(vals[0] ?? '').toLowerCase(),
      TRIM: (vals) => String(vals[0] ?? '').trim(),
      LEFT: (vals) => String(vals[0] ?? '').substring(0, Number(vals[1]) || 1),
      RIGHT: (vals) => { const s = String(vals[0] ?? ''); const n = Number(vals[1]) || 1; return s.substring(s.length - n); },
      MID: (vals) => String(vals[0] ?? '').substring(Number(vals[1]) - 1 || 0, (Number(vals[1]) - 1 || 0) + (Number(vals[2]) || 1)),
      CONCATENATE: (vals) => vals.map(v => String(v ?? '')).join(''),
      CONCAT: (vals) => vals.map(v => String(v ?? '')).join(''),
      SUBSTITUTE: (vals) => String(vals[0] ?? '').split(String(vals[1] ?? '')).join(String(vals[2] ?? '')),
      REPT: (vals) => String(vals[0] ?? '').repeat(Number(vals[1]) || 1),
      TEXT: (vals) => String(vals[0] ?? ''),
      VALUE: (vals) => Number(vals[0]) || 0,
      // Logic
      IF: (vals) => vals[0] ? vals[1] : (vals[2] ?? ''),
      AND: (vals) => vals.every(v => !!v),
      OR: (vals) => vals.some(v => !!v),
      NOT: (vals) => !vals[0],
      IFERROR: (vals) => (typeof vals[0] === 'string' && vals[0].startsWith('#ERROR')) ? vals[1] : vals[0],
      ISBLANK: (vals) => vals[0] === '' || vals[0] === null || vals[0] === undefined,
      ISNUMBER: (vals) => typeof vals[0] === 'number',
      // Lookup
      VLOOKUP: (vals) => {
        const lookupVal = vals[0];
        const range = vals[1]; // will be a special range token
        const colIdx = Number(vals[2]) || 1;
        // Simplified: vals[1] should already be resolved as range values
        return '#N/A';
      },
      // Date
      NOW: () => new Date().toLocaleString('zh-CN'),
      TODAY: () => new Date().toLocaleDateString('zh-CN'),
      YEAR: (vals) => new Date(vals[0]).getFullYear(),
      MONTH: (vals) => new Date(vals[0]).getMonth() + 1,
      DAY: (vals) => new Date(vals[0]).getDate(),
      // Aggregate
      SUMIF: (vals) => '#N/A', // Placeholder
      COUNTIF: (vals) => '#N/A',
      MEDIAN: (vals) => {
        const nums = vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number).sort((a, b) => a - b);
        if (!nums.length) return 0;
        const mid = Math.floor(nums.length / 2);
        return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
      },
      STDEV: (vals) => {
        const nums = vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number);
        if (nums.length < 2) return 0;
        const avg = nums.reduce((s, v) => s + v, 0) / nums.length;
        return Math.sqrt(nums.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (nums.length - 1));
      },
      PRODUCT: (vals) => vals.filter(v => typeof v === 'number' || !isNaN(Number(v))).map(Number).reduce((p, v) => p * v, 1),
    };

    // Process function calls recursively
    const evalExpr = (expr) => {
      // Replace range function calls like SUM(A1:B5)
      const funcRegex = /([A-Z_]+)\(([^()]*)\)/gi;
      let maxIter = 50;
      while (funcRegex.test(expr) && maxIter-- > 0) {
        funcRegex.lastIndex = 0;
        expr = expr.replace(funcRegex, (match, funcName, argsStr) => {
          const fn = funcs[funcName.toUpperCase()];
          if (!fn) return '#NAME?';

          // Parse arguments
          const args = this._splitArgs(argsStr);
          const resolvedArgs = [];
          for (const arg of args) {
            const trimmed = arg.trim();
            // Range reference
            if (/^[A-Z]+\d+:[A-Z]+\d+$/i.test(trimmed)) {
              resolvedArgs.push(...this._getRangeValues(trimmed));
            }
            // Cell reference
            else if (/^[A-Z]+\d+$/i.test(trimmed)) {
              resolvedArgs.push(this._getCellValue(trimmed));
            }
            // String literal
            else if (/^".*"$/.test(trimmed)) {
              resolvedArgs.push(trimmed.slice(1, -1));
            }
            // Number or expression
            else {
              const num = Number(trimmed);
              resolvedArgs.push(isNaN(num) ? trimmed : num);
            }
          }

          const result = fn(resolvedArgs);
          return typeof result === 'string' ? `"${result}"` : String(result);
        });
      }

      // Replace remaining cell references
      expr = expr.replace(/([A-Z]+)(\d+)/gi, (match, col, row) => {
        const val = this._getCellValue(col.toUpperCase() + row);
        return typeof val === 'string' ? `"${val}"` : String(val ?? 0);
      });

      // Remove string quotes for final eval
      expr = expr.replace(/"([^"]*)"/g, (_, s) => {
        // If the whole expression is just a string, return as-is
        return `"${s}"`;
      });

      // Evaluate arithmetic
      try {
        // Safe eval with only math
        const sanitized = expr.replace(/[^0-9+\-*/().,%<>=!&|" ]/g, '');
        if (/^"[^"]*"$/.test(expr.trim())) return expr.trim().slice(1, -1);
        const result = Function('"use strict"; return (' + sanitized + ')')();
        return result;
      } catch {
        // Try returning as string
        if (/^".*"$/.test(expr.trim())) return expr.trim().slice(1, -1);
        return expr;
      }
    };

    return evalExpr(processed);
  }

  _splitArgs(argsStr) {
    const args = [];
    let depth = 0, current = '';
    for (const ch of argsStr) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        args.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) args.push(current);
    return args;
  }

  _notify() {
    if (this.onChange) this.onChange(this.getData());
  }
}

// ---- Spreadsheet UI ----
class SpreadsheetUI {
  constructor(engine, containerId) {
    this.engine = engine;
    this.container = document.getElementById(containerId);
    this.selectedCell = null;
    this.editingCell = null;
    this.visibleCols = 10;
    this.visibleRows = 20;
    this.scrollCol = 1; // 1-based
    this.scrollRow = 1;
    this.render();

    engine.onChange = () => this.render();
  }

  render() {
    if (!this.container) return;
    const table = this.container.querySelector('.ss-table') || document.createElement('div');
    table.className = 'ss-table';
    table.innerHTML = '';

    // Header row (column letters)
    const headerRow = document.createElement('div');
    headerRow.className = 'ss-row ss-header-row';
    const corner = document.createElement('div');
    corner.className = 'ss-cell ss-corner';
    corner.textContent = '';
    headerRow.appendChild(corner);

    for (let c = 0; c < this.visibleCols; c++) {
      const colIdx = this.scrollCol + c;
      const colLetter = SpreadsheetEngine.indexToCol(colIdx);
      const hdr = document.createElement('div');
      hdr.className = 'ss-cell ss-col-header';
      hdr.textContent = colLetter;
      headerRow.appendChild(hdr);
    }
    table.appendChild(headerRow);

    // Data rows
    for (let r = 0; r < this.visibleRows; r++) {
      const rowNum = this.scrollRow + r;
      const row = document.createElement('div');
      row.className = 'ss-row';

      const rowHdr = document.createElement('div');
      rowHdr.className = 'ss-cell ss-row-header';
      rowHdr.textContent = rowNum;
      row.appendChild(rowHdr);

      for (let c = 0; c < this.visibleCols; c++) {
        const colIdx = this.scrollCol + c;
        const addr = SpreadsheetEngine.indexToCol(colIdx) + rowNum;
        const cellData = this.engine.getCell(addr);

        const cell = document.createElement('div');
        cell.className = 'ss-cell ss-data-cell';
        if (this.selectedCell === addr) cell.classList.add('ss-selected');
        cell.dataset.addr = addr;

        // Apply formatting
        if (cellData.format) {
          if (cellData.format.bold) cell.style.fontWeight = 'bold';
          if (cellData.format.italic) cell.style.fontStyle = 'italic';
          if (cellData.format.color) cell.style.color = cellData.format.color;
          if (cellData.format.bg) cell.style.backgroundColor = cellData.format.bg;
          if (cellData.format.align) cell.style.textAlign = cellData.format.align;
          if (cellData.format.fontSize) cell.style.fontSize = cellData.format.fontSize + 'px';
        }

        // Display value (not raw formula)
        cell.textContent = cellData.value !== '' && cellData.value != null ? String(cellData.value) : '';

        cell.addEventListener('click', () => this._selectCell(addr));
        cell.addEventListener('dblclick', () => this._startEdit(addr, cell));
        row.appendChild(cell);
      }
      table.appendChild(row);
    }

    if (!this.container.contains(table)) {
      this.container.appendChild(table);
    }

    // Update formula bar
    this._updateFormulaBar();
  }

  _selectCell(addr) {
    this.selectedCell = addr;
    this.render();
  }

  _startEdit(addr, cellEl) {
    this.editingCell = addr;
    const cellData = this.engine.getCell(addr);
    cellEl.textContent = '';
    const input = document.createElement('input');
    input.className = 'ss-cell-input';
    input.type = 'text';
    input.value = cellData.raw;
    input.addEventListener('blur', () => {
      this.engine.setCell(addr, input.value);
      this.editingCell = null;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.engine.setCell(addr, input.value);
        this.editingCell = null;
        // Move down
        const p = SpreadsheetEngine.parseAddr(addr);
        if (p) this._selectCell(p.col + (p.row + 1));
      } else if (e.key === 'Escape') {
        this.editingCell = null;
        this.render();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.engine.setCell(addr, input.value);
        this.editingCell = null;
        const p = SpreadsheetEngine.parseAddr(addr);
        if (p) this._selectCell(SpreadsheetEngine.indexToCol(p.colIndex + 1) + p.row);
      }
    });
    cellEl.appendChild(input);
    input.focus();
    input.select();
  }

  _updateFormulaBar() {
    const bar = this.container.parentElement?.querySelector('.ss-formula-bar');
    if (!bar) return;
    const addrEl = bar.querySelector('.ss-addr');
    const fxEl = bar.querySelector('.ss-fx');
    if (this.selectedCell) {
      if (addrEl) addrEl.textContent = this.selectedCell;
      const cellData = this.engine.getCell(this.selectedCell);
      if (fxEl) fxEl.value = cellData.raw;
    } else {
      if (addrEl) addrEl.textContent = '';
      if (fxEl) fxEl.value = '';
    }
  }
}
