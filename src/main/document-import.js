/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 知识库导入大小上限（字节）
const MAX_IMPORT_SIZE = 50 * 1024 * 1024;
// 单文档最多提取的媒体文件数量，防止恶意/异常文档撑爆磁盘
const MAX_MEDIA_FILES = 200;

// 明确按文本导入的扩展名（带编码检测），其余一律走专用解析或拒绝
const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.tsv', '.md', '.markdown', '.json', '.jsonl', '.xml',
  '.html', '.htm', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.log',
  '.sh', '.bat', '.ps1', '.py', '.js', '.mjs', '.cjs', '.ts', '.jsx',
  '.tsx', '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.toml', '.properties', '.gitignore', '.env', '.rst', '.tex',
  '.srt', '.vtt', '.graphql', '.proto', '.dockerfile'
]);

// 图片：知识库支持按“图片文件”走图片卡片/附件流程，但绝不能当文本读
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.tif', '.tiff', '.avif', '.heic'
]);

// 常见的二进制/压缩/媒体扩展名：明确拒绝，避免乱码文本污染知识库
const BINARY_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.exe', '.dll',
  '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.mp3',
  '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mkv', '.avi', '.mov', '.webm',
  '.pdf' // pdf 走专用解析，防止 fallback
]);

// 旧版二进制 Office 格式：无法可靠解析，给出另存建议而不是读 Buffer
const LEGACY_OFFICE = { '.doc': '.docx', '.ppt': '.pptx', '.xls': '.xlsx' };

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function requireAdmZip() {
  try { return require('adm-zip'); } catch { return null; }
}

/**
 * 提取 OOXML 容器中的媒体文件（docx/pptx 的 word/media、ppt/media）。
 * 这里只搬运二进制媒体，不做任何 XML 文本解析。
 */
function extractOfficeMedia(filePath, mediaPrefix, targetDir, stamp) {
  const AdmZip = requireAdmZip();
  if (!AdmZip) return [];
  const images = [];
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const mediaExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.emf', '.wmf', '.tif', '.tiff']);
    let count = 0;
    for (const entry of entries) {
      if (count >= MAX_MEDIA_FILES) break;
      if (entry.isDirectory || !entry.entryName.startsWith(mediaPrefix)) continue;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (!mediaExts.has(ext)) continue;
      const safeName = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, '_');
      const outPath = path.join(targetDir, `import_${stamp}_${count}_${safeName}`);
      fs.writeFileSync(outPath, entry.getData());
      images.push(outPath);
      count++;
    }
  } catch { /* 媒体提取失败不影响文本结果 */ }
  return images;
}

/**
 * DOCX → 纯文本。使用 mammoth（专门读取 .docx 的成熟库），不再手剥 XML。
 */
async function extractDocxText(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

/**
 * XLSX → 易读文本。使用 exceljs 正确读取单元格、公式结果、富文本。
 */
async function extractXlsxText(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const parts = [];
  for (const sheet of workbook.worksheets) {
    parts.push(`# Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        let value = cell.value;
        if (value === null || value === undefined) { value = ''; }
        else if (value instanceof Date) { value = value.toISOString(); }
        else if (typeof value === 'object') {
          if (value.richText) value = value.richText.map(t => t.text || '').join('');
          else if (value.result !== undefined) value = value.result;
          else if (value.text !== undefined) value = value.text;
          else if (value.hyperlink && value.text !== undefined) value = value.text;
          else value = JSON.stringify(value);
        }
        cells.push(String(value));
      });
      if (cells.some(c => c !== '')) parts.push(cells.join('\t'));
    });
  }
  return parts.join('\n');
}

/**
 * PDF → 文本。使用 pdf-parse v2（基于 pdf.js 的成熟解析，支持中文）。
 */
async function extractPdfText(filePath) {
  const { PDFParse } = require('pdf-parse');
  const data = await fs.promises.readFile(filePath);
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  const text = result && typeof result === 'object' ? (result.text || '') : String(result || '');
  return text || '(该 PDF 未提取到可选择的文本，扫描件请先 OCR)';
}

/**
 * PPTX / ODT / ODS / ODP / RTF → 文本。使用 officeparser（MIT、活跃维护、
 * 产出结构化 AST），覆盖 XML 命名空间、顺序、表格等细节，不用手写正则。
 */
async function extractViaOfficeParser(filePath) {
  const officeParser = require('officeparser');
  const ast = await officeParser.parseOffice(filePath, {
    ignoreNotes: false,
    putNotesAtLast: false,
    newlineDelimiter: '\n',
    outputErrorToConsole: false,
    extractAttachments: false,
    ocr: false
  });
  if (ast && typeof ast.toText === 'function') return ast.toText();
  if (typeof ast === 'string') return ast;
  if (ast && typeof ast.text === 'string') return ast.text;
  return '';
}

/**
 * 知识库文件导入入口。按扩展名路由到合适的解析器：
 * - 文本类 → 编码检测后读取（readText 由调用方注入）
 * - docx → mammoth；xlsx → exceljs；pdf → pdf-parse
 * - pptx/odt/ods/odp/rtf → officeparser
 * - 旧版二进制 Office → 明确建议另存，不读 Buffer
 * - 其他二进制/未知类型 → 明确拒绝
 *
 * @param {string} filePath
 * @param {{readText?: Function, targetDir?: string}} options
 */
async function importKnowledgeFile(filePath, options = {}) {
  const readText = typeof options.readText === 'function'
    ? options.readText
    : (p) => fs.readFileSync(p, 'utf-8');
  const targetDir = options.targetDir || path.dirname(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const stamp = Date.now();

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return { ok: false, error: '文件不存在或无法访问' };
  }
  if (!stat.isFile()) return { ok: false, error: '目标不是文件' };
  if (stat.size === 0) return { ok: false, error: '文件为空，无法导入' };
  if (stat.size > MAX_IMPORT_SIZE) {
    return { ok: false, error: `文件过大（${formatBytes(stat.size)}），知识库导入上限为 ${formatBytes(MAX_IMPORT_SIZE)}` };
  }

  let textContent = '';
  let images = [];

  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      textContent = readText(filePath);
    } else if (ext === '.docx') {
      textContent = await extractDocxText(filePath);
      images = extractOfficeMedia(filePath, 'word/media/', targetDir, stamp);
    } else if (ext === '.xlsx') {
      textContent = await extractXlsxText(filePath);
    } else if (ext === '.pdf') {
      textContent = await extractPdfText(filePath);
    } else if (['.pptx', '.odt', '.ods', '.odp', '.rtf'].includes(ext)) {
      textContent = await extractViaOfficeParser(filePath);
      if (ext === '.pptx' || ext === '.odp') {
        images = extractOfficeMedia(filePath, ext === '.pptx' ? 'ppt/media/' : 'Pictures/', targetDir, stamp);
      }
    } else if (LEGACY_OFFICE[ext]) {
      return {
        ok: false,
        error: `不支持旧版二进制 ${ext} 文件，请先在 Office/WPS 中另存为 ${LEGACY_OFFICE[ext]} 再导入`
      };
    } else if (IMAGE_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext)) {
      return { ok: false, error: `不支持把二进制文件 ${ext || '(无扩展名)'} 作为文本导入知识库` };
    } else {
      return { ok: false, error: `不支持的文件类型 ${ext || '(无扩展名)'}` };
    }
  } catch (e) {
    return { ok: false, error: `解析失败：${e && e.message ? e.message : String(e)}` };
  }

  // 去掉意外出现的空字节，再统一截断，避免超长内容占满知识库条目
  const cleanContent = String(textContent || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleanContent && images.length === 0) {
    return { ok: false, error: '未能从该文件中提取到任何文本内容' };
  }

  return {
    ok: true,
    content: cleanContent.slice(0, 100000),
    images,
    fileName,
    ext,
    truncated: cleanContent.length > 100000,
    size: stat.size
  };
}

module.exports = {
  importKnowledgeFile,
  extractDocxText,
  extractXlsxText,
  extractPdfText,
  extractViaOfficeParser,
  MAX_IMPORT_SIZE
};
