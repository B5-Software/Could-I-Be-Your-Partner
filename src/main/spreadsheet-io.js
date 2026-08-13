/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Spreadsheet file import/export: XLSX, ODS, CSV
 * Uses adm-zip for ZIP-based formats (xlsx/ods)
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ---- XLSX Helpers ----

/**
 * Parse column letter to 0-based index
 */
function colLetterToIndex(col) {
  col = col.toUpperCase();
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + col.charCodeAt(i) - 64;
  return n - 1; // 0-based
}

function indexToColLetter(idx) {
  let s = '';
  idx++; // 1-based
  while (idx > 0) { idx--; s = String.fromCharCode(65 + (idx % 26)) + s; idx = Math.floor(idx / 26); }
  return s;
}

/**
 * Parse cell address like "A1" to {col: 0, row: 0}
 */
function parseAddr(addr) {
  const m = addr.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { col: colLetterToIndex(m[1]), row: parseInt(m[2]) - 1 };
}

/**
 * Import XLSX file → { cells: [{addr, value}], sheetName }
 */
function importXLSX(filePath) {
  const zip = new AdmZip(filePath);

  // Read shared strings
  const sharedStrings = [];
  const ssEntry = zip.getEntry('xl/sharedStrings.xml');
  if (ssEntry) {
    const ssXml = ssEntry.getData().toString('utf8');
    const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/gi;
    let siMatch;
    while ((siMatch = siRegex.exec(ssXml))) {
      // Extract all <t> text within this <si>
      const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/gi;
      let full = '';
      let tMatch;
      while ((tMatch = tRegex.exec(siMatch[1]))) {
        full += tMatch[1];
      }
      sharedStrings.push(decodeXmlEntities(full));
    }
  }

  // Find the first sheet
  let sheetName = 'Sheet1';
  const wbEntry = zip.getEntry('xl/workbook.xml');
  if (wbEntry) {
    const wbXml = wbEntry.getData().toString('utf8');
    const sheetMatch = wbXml.match(/<sheet\s+name="([^"]+)"/);
    if (sheetMatch) sheetName = decodeXmlEntities(sheetMatch[1]);
  }

  // Read sheet1
  const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
  if (!sheetEntry) return { ok: false, error: '未找到工作表' };

  const sheetXml = sheetEntry.getData().toString('utf8');
  const cells = [];

  const cellRegex = /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/gi;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(sheetXml))) {
    const addr = cellMatch[1];
    const attrs = cellMatch[2];
    const inner = cellMatch[3] || '';

    let value = '';
    const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
    const inlineMatch = inner.match(/<is>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/is>/);

    const typeMatch = attrs.match(/t="([^"]+)"/);
    const type = typeMatch ? typeMatch[1] : '';

    if (type === 's' && vMatch) {
      // Shared string reference
      const idx = parseInt(vMatch[1]);
      value = sharedStrings[idx] || '';
    } else if (type === 'inlineStr' && inlineMatch) {
      value = decodeXmlEntities(inlineMatch[1]);
    } else if (type === 'b' && vMatch) {
      value = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
    } else if (vMatch) {
      value = vMatch[1];
    }

    // Check for formula
    const fMatch = inner.match(/<f>([\s\S]*?)<\/f>/);
    if (fMatch) {
      value = '=' + decodeXmlEntities(fMatch[1]);
    }

    if (value !== '') {
      cells.push({ addr, value });
    }
  }

  return { ok: true, cells, sheetName };
}

/**
 * 将 CSS 颜色（#rgb/#rrggbb/rgb()/rgba()/常见命名色）转为 ARGB 十六进制。
 * 无法解析时返回 null（保持默认颜色）。
 */
function cssColorToArgb(color) {
  const raw = String(color || '').trim().toLowerCase();
  if (!raw) return null;
  let hex = null;
  let m = raw.match(/^#([0-9a-f]{3})$/);
  if (m) hex = m[1].split('').map(c => c + c).join('');
  m = raw.match(/^#([0-9a-f]{6})$/);
  if (m) hex = m[1];
  if (!hex) {
    m = raw.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) {
      hex = [Number(m[1]), Number(m[2]), Number(m[3])]
        .map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
    }
  }
  const NAMED = {
    black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff',
    yellow: 'ffff00', orange: 'ffa500', gray: '808080', grey: '808080', purple: '800080',
    cyan: '00ffff', magenta: 'ff00ff', pink: 'ffc0cb', brown: 'a52a2a', silver: 'c0c0c0',
    gold: 'ffd700', teal: '008080', navy: '000080', lime: '00ff00', maroon: '800000'
  };
  if (!hex && NAMED[raw]) hex = NAMED[raw];
  if (!hex || !/^[0-9a-f]{6}$/.test(hex)) return null;
  return 'FF' + hex.toUpperCase();
}

/**
 * 根据单元格格式生成 styles.xml，并返回 { stylesXml, styleIndexByCell }。
 * 支持的格式字段：bold / italic / color / bg / align(left|center|right) / fontSize(px)。
 */
function buildXlsxStyles(cells) {
  const fonts = [
    // fontId 0：默认
    {}
  ];
  const fills = [
    // fillId 0: none, 1: gray125（OOXML 要求前两个为保留项）
    { patternType: 'none' },
    { patternType: 'gray125' }
  ];
  // xf 0：默认样式
  const xfs = [{
    numFmtId: 0, fontId: 0, fillId: 0, borderId: 0,
    applyFont: 0, applyFill: 0, applyAlignment: 0
  }];
  const styleMap = new Map(); // format JSON key -> xf index
  const styleIndexByCell = new Map(); // cell.addr -> xf index

  for (const cell of cells) {
    const f = cell && cell.format;
    if (!f || typeof f !== 'object' || !Object.keys(f).length) continue;
    const key = JSON.stringify({
      bold: !!f.bold, italic: !!f.italic,
      color: f.color || '', bg: f.bg || '',
      align: f.align || '', fontSize: f.fontSize || 0
    });
    let xfIndex = styleMap.get(key);
    if (xfIndex === undefined) {
      let fontId = 0;
      if (f.bold || f.italic || f.color || f.fontSize) {
        const font = {};
        if (f.bold) font.b = 1;
        if (f.italic) font.i = 1;
        if (f.color) {
          const argb = cssColorToArgb(f.color);
          if (argb) font.color = { rgb: argb };
        }
        if (f.fontSize) font.sz = Math.max(1, Math.round(Number(f.fontSize) * 0.75 * 10) / 10);
        fontId = fonts.length;
        fonts.push(font);
      }
      let fillId = 0;
      if (f.bg) {
        const argb = cssColorToArgb(f.bg);
        if (argb) {
          fillId = fills.length;
          fills.push({ patternType: 'solid', fgColor: { rgb: argb } });
        }
      }
      const xf = {
        numFmtId: 0, fontId, fillId, borderId: 0,
        applyFont: fontId > 0 ? 1 : 0,
        applyFill: fillId > 0 ? 1 : 0,
        applyAlignment: 0
      };
      if (f.align && ['left', 'center', 'right'].includes(f.align)) {
        xf.applyAlignment = 1;
        xf.alignment = { horizontal: f.align };
      }
      xfIndex = xfs.length;
      xfs.push(xf);
      styleMap.set(key, xfIndex);
    }
    styleIndexByCell.set(cell.addr, xfIndex);
  }

  let stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  stylesXml += '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  stylesXml += `<fonts count="${fonts.length}">`;
  for (const f of fonts) {
    stylesXml += '<font>';
    if (f.b) stylesXml += '<b/>';
    if (f.i) stylesXml += '<i/>';
    if (f.color) stylesXml += `<color rgb="${f.color.rgb}"/>`;
    if (f.sz) stylesXml += `<sz val="${f.sz}"/>`;
    stylesXml += '<name val="Calibri"/><family val="2"/></font>';
  }
  stylesXml += '</fonts>';
  stylesXml += `<fills count="${fills.length}">`;
  for (const f of fills) {
    if (f.patternType === 'solid') {
      stylesXml += `<fill><patternFill patternType="solid"><fgColor rgb="${f.fgColor.rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
    } else {
      stylesXml += `<fill><patternFill patternType="${f.patternType}"/></fill>`;
    }
  }
  stylesXml += '</fills>';
  stylesXml += '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>';
  stylesXml += `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`;
  stylesXml += `<cellXfs count="${xfs.length}">`;
  for (const x of xfs) {
    let attr = `numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0"`;
    if (x.applyAlignment) attr += ' applyAlignment="1"';
    if (x.applyFont) attr += ' applyFont="1"';
    if (x.applyFill) attr += ' applyFill="1"';
    if (x.alignment) {
      stylesXml += `<xf ${attr}><alignment horizontal="${x.alignment.horizontal}"/></xf>`;
    } else {
      stylesXml += `<xf ${attr}/>`;
    }
  }
  stylesXml += '</cellXfs>';
  stylesXml += '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
  stylesXml += '<dxfs count="0"/>';
  stylesXml += `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>`;
  stylesXml += '</styleSheet>';

  return { stylesXml, styleIndexByCell };
}

/**
 * Export cells to XLSX file
 * cells: [{addr, value, raw, format}]
 */
function exportXLSX(filePath, cells, sheetName = 'Sheet1') {
  const sharedStrings = [];
  const ssMap = {};

  function getSSIndex(str) {
    if (ssMap[str] !== undefined) return ssMap[str];
    const idx = sharedStrings.length;
    sharedStrings.push(str);
    ssMap[str] = idx;
    return idx;
  }

  // Build rows map
  const rowsMap = {};
  for (const cell of cells) {
    const p = parseAddr(cell.addr);
    if (!p) continue;
    if (!rowsMap[p.row]) rowsMap[p.row] = [];
    rowsMap[p.row].push(cell);
  }

  // Build sheet XML
  const { stylesXml, styleIndexByCell } = buildXlsxStyles(cells);

  let sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  sheetXml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
  sheetXml += '<sheetData>';

  const rowNums = Object.keys(rowsMap).map(Number).sort((a, b) => a - b);
  for (const rowNum of rowNums) {
    const rowCells = rowsMap[rowNum].sort((a, b) => {
      const pa = parseAddr(a.addr), pb = parseAddr(b.addr);
      return pa.col - pb.col;
    });
    sheetXml += `<row r="${rowNum + 1}">`;
    for (const cell of rowCells) {
      const raw = cell.raw !== undefined ? cell.raw : cell.value;
      const rawStr = String(raw);
      const styleIdx = styleIndexByCell.get(cell.addr);
      const styleAttr = styleIdx !== undefined ? ` s="${styleIdx}"` : '';

      if (rawStr.startsWith('=')) {
        // Formula
        const val = cell.value !== undefined ? cell.value : '';
        sheetXml += `<c r="${cell.addr}"${styleAttr}><f>${escapeXml(rawStr.substring(1))}</f><v>${escapeXml(String(val))}</v></c>`;
      } else {
        const num = Number(rawStr);
        if (rawStr !== '' && !isNaN(num)) {
          // Number
          sheetXml += `<c r="${cell.addr}"${styleAttr}><v>${num}</v></c>`;
        } else {
          // String via shared strings
          const idx = getSSIndex(rawStr);
          sheetXml += `<c r="${cell.addr}" t="s"${styleAttr}><v>${idx}</v></c>`;
        }
      }
    }
    sheetXml += '</row>';
  }

  sheetXml += '</sheetData></worksheet>';

  // Build shared strings XML
  let ssXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  ssXml += `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`;
  for (const s of sharedStrings) {
    ssXml += `<si><t>${escapeXml(s)}</t></si>`;
  }
  ssXml += '</sst>';

  // Build workbook XML
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  // Relationships
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(relsXml, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(wbXml, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(wbRelsXml, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml, 'utf8'));
  zip.addFile('xl/sharedStrings.xml', Buffer.from(ssXml, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(stylesXml, 'utf8'));
  zip.writeZip(filePath);

  return { ok: true, path: filePath };
}

// ---- ODS Helpers ----

function importODS(filePath) {
  const zip = new AdmZip(filePath);
  const contentEntry = zip.getEntry('content.xml');
  if (!contentEntry) return { ok: false, error: '未找到content.xml' };

  const xml = contentEntry.getData().toString('utf8');
  const cells = [];
  let sheetName = 'Sheet1';

  // Extract sheet name
  const sheetMatch = xml.match(/<table:table\s+table:name="([^"]+)"/);
  if (sheetMatch) sheetName = decodeXmlEntities(sheetMatch[1]);

  // Parse rows and cells
  const rowRegex = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/gi;
  let rowMatch;
  let rowNum = 0;

  while ((rowMatch = rowRegex.exec(xml))) {
    rowNum++;
    const rowContent = rowMatch[1];
    const cellRegex = /<table:table-cell([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/gi;
    let cellMatch;
    let colNum = 0;

    while ((cellMatch = cellRegex.exec(rowContent))) {
      colNum++;
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || '';

      // Check repeated columns
      const repeatMatch = attrs.match(/table:number-columns-repeated="(\d+)"/);
      const repeat = repeatMatch ? parseInt(repeatMatch[1]) : 1;

      // Get value
      let value = '';
      const formula = attrs.match(/table:formula="of:=([^"]+)"/);
      const textMatch = inner.match(/<text:p>([\s\S]*?)<\/text:p>/);
      const valueAttr = attrs.match(/office:value="([^"]+)"/);
      const stringAttr = attrs.match(/office:string-value="([^"]+)"/);

      if (formula) {
        value = '=' + decodeXmlEntities(formula[1]);
      } else if (valueAttr) {
        value = valueAttr[1];
      } else if (stringAttr) {
        value = decodeXmlEntities(stringAttr[1]);
      } else if (textMatch) {
        value = decodeXmlEntities(textMatch[1]);
      }

      if (value !== '') {
        const addr = indexToColLetter(colNum - 1) + rowNum;
        cells.push({ addr, value });
      }

      if (repeat > 1) colNum += repeat - 1;
    }
  }

  return { ok: true, cells, sheetName };
}

/**
 * 根据单元格格式生成 ODS automatic-styles XML。
 * 返回 { stylesXml, styleNameByCell }，单元格通过 table:style-name 引用。
 */
function buildOdsCellStyles(cells) {
  const styleMap = new Map(); // format JSON key -> style name
  const styleNameByCell = new Map();
  let parts = '';
  let counter = 0;

  for (const cell of cells) {
    const f = cell && cell.format;
    if (!f || typeof f !== 'object' || !Object.keys(f).length) continue;
    const key = JSON.stringify({
      bold: !!f.bold, italic: !!f.italic,
      color: f.color || '', bg: f.bg || '',
      align: f.align || '', fontSize: f.fontSize || 0
    });
    let name = styleMap.get(key);
    if (!name) {
      name = 'ce' + (++counter);
      styleMap.set(key, name);
      const textProps = [];
      if (f.bold) textProps.push('fo:font-weight="bold"');
      if (f.italic) textProps.push('fo:font-style="italic"');
      if (f.color) {
        const argb = cssColorToArgb(f.color);
        if (argb) textProps.push(`fo:color="#${argb.slice(2)}"`);
      }
      if (f.fontSize) {
        const pt = Math.max(1, Math.round(Number(f.fontSize) * 0.75 * 10) / 10);
        textProps.push(`fo:font-size="${pt}pt"`);
      }
      const cellProps = [];
      if (f.bg) {
        const argb = cssColorToArgb(f.bg);
        if (argb) cellProps.push(`fo:background-color="#${argb.slice(2)}"`);
      }
      const paraProps = [];
      if (f.align && ['left', 'center', 'right'].includes(f.align)) {
        const map = { left: 'start', center: 'center', right: 'end' };
        paraProps.push(`fo:text-align="${map[f.align]}"`);
      }
      parts += `<style:style style:name="${name}" style:family="table-cell">`;
      if (textProps.length) parts += `<style:text-properties ${textProps.join(' ')}/>`;
      if (cellProps.length) parts += `<style:table-cell-properties ${cellProps.join(' ')}/>`;
      if (paraProps.length) parts += `<style:paragraph-properties ${paraProps.join(' ')}/>`;
      parts += '</style:style>';
    }
    styleNameByCell.set(cell.addr, name);
  }

  const stylesXml = parts
    ? `<office:automatic-styles>${parts}</office:automatic-styles>`
    : '';
  return { stylesXml, styleNameByCell };
}

function exportODS(filePath, cells, sheetName = 'Sheet1') {
  // Build rows map
  const rowsMap = {};
  let maxCol = 0, maxRow = 0;
  for (const cell of cells) {
    const p = parseAddr(cell.addr);
    if (!p) continue;
    if (!rowsMap[p.row]) rowsMap[p.row] = {};
    rowsMap[p.row][p.col] = cell;
    maxCol = Math.max(maxCol, p.col);
    maxRow = Math.max(maxRow, p.row);
  }

  let tableRows = '';
  const { stylesXml, styleNameByCell } = buildOdsCellStyles(cells);
  for (let r = 0; r <= maxRow; r++) {
    tableRows += '<table:table-row>';
    for (let c = 0; c <= maxCol; c++) {
      const cell = rowsMap[r]?.[c];
      if (!cell) {
        tableRows += '<table:table-cell/>';
        continue;
      }
      const raw = cell.raw !== undefined ? cell.raw : cell.value;
      const rawStr = String(raw);
      const val = cell.value !== undefined ? cell.value : raw;
      const styleName = styleNameByCell.get(cell.addr);
      const styleAttr = styleName ? ` table:style-name="${styleName}"` : '';

      if (rawStr.startsWith('=')) {
        tableRows += `<table:table-cell${styleAttr} table:formula="of:=${escapeXml(rawStr.substring(1))}" office:value-type="float" office:value="${escapeXml(String(val))}"><text:p>${escapeXml(String(val))}</text:p></table:table-cell>`;
      } else {
        const num = Number(rawStr);
        if (rawStr !== '' && !isNaN(num)) {
          tableRows += `<table:table-cell${styleAttr} office:value-type="float" office:value="${num}"><text:p>${num}</text:p></table:table-cell>`;
        } else {
          tableRows += `<table:table-cell${styleAttr} office:value-type="string"><text:p>${escapeXml(rawStr)}</text:p></table:table-cell>`;
        }
      }
    }
    tableRows += '</table:table-row>';
  }

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  office:version="1.2">
<office:body><office:spreadsheet>
${stylesXml}
<table:table table:name="${escapeXml(sheetName)}">
${tableRows}
</table:table>
</office:spreadsheet></office:body>
</office:document-content>`;

  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2">
<office:meta/>
</office:document-meta>`;

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  const mimeType = 'application/vnd.oasis.opendocument.spreadsheet';

  const zip = new AdmZip();
  // mimetype must be first entry and uncompressed
  zip.addFile('mimetype', Buffer.from(mimeType, 'utf8'));
  zip.addFile('content.xml', Buffer.from(contentXml, 'utf8'));
  zip.addFile('meta.xml', Buffer.from(metaXml, 'utf8'));
  zip.addFile('META-INF/manifest.xml', Buffer.from(manifestXml, 'utf8'));
  zip.writeZip(filePath);

  return { ok: true, path: filePath };
}

// ---- CSV Helpers ----

function importCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const cells = [];
  for (let r = 0; r < lines.length; r++) {
    if (!lines[r].trim()) continue;
    const cols = parseCSVLine(lines[r]);
    for (let c = 0; c < cols.length; c++) {
      if (cols[c] !== '') {
        cells.push({ addr: indexToColLetter(c) + (r + 1), value: cols[c] });
      }
    }
  }
  return { ok: true, cells, sheetName: path.basename(filePath, path.extname(filePath)) };
}

function parseCSVLine(line) {
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

function exportCSV(filePath, cells) {
  // Build rows map
  const rowsMap = {};
  let maxCol = 0, maxRow = 0;
  for (const cell of cells) {
    const p = parseAddr(cell.addr);
    if (!p) continue;
    if (!rowsMap[p.row]) rowsMap[p.row] = {};
    rowsMap[p.row][p.col] = cell;
    maxCol = Math.max(maxCol, p.col);
    maxRow = Math.max(maxRow, p.row);
  }

  const lines = [];
  for (let r = 0; r <= maxRow; r++) {
    const cols = [];
    for (let c = 0; c <= maxCol; c++) {
      const cell = rowsMap[r]?.[c];
      let v = cell ? String(cell.value ?? '') : '';
      if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"';
      cols.push(v);
    }
    lines.push(cols.join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { ok: true, path: filePath };
}

// ---- Utilities ----

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeXmlEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Auto-detect format and import
 */
function importSpreadsheetFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.xlsx': return importXLSX(filePath);
    case '.ods': return importODS(filePath);
    case '.csv': return importCSV(filePath);
    default: return { ok: false, error: `不支持的格式: ${ext}，支持 .xlsx/.ods/.csv` };
  }
}

/**
 * Auto-detect format and export
 */
function exportSpreadsheetFile(filePath, cells, sheetName) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.xlsx': return exportXLSX(filePath, cells, sheetName);
    case '.ods': return exportODS(filePath, cells, sheetName);
    case '.csv': return exportCSV(filePath, cells);
    default: return { ok: false, error: `不支持的格式: ${ext}，支持 .xlsx/.ods/.csv` };
  }
}

module.exports = { importSpreadsheetFile, exportSpreadsheetFile };
