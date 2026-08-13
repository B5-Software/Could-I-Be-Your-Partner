/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Office-Word 工具实现：读取用 mammoth/officeparser，生成用 docx，
 * 模板填充用 docxtemplater + pizzip，样式与元数据读取用正规解析器。
 * 不做“解包 + 正则拼 XML”的硬解。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveImagePath } = require('./ppt-maker');

function requireAdmZip() {
  try { return require('adm-zip'); } catch { return null; }
}

function requireXMLParser() {
  try { return require('fast-xml-parser').XMLParser; } catch { return null; }
}

function cleanText(v, max = 20000) {
  return String(v ?? '').trim().slice(0, max);
}

function isDocx(filePath) { return path.extname(filePath).toLowerCase() === '.docx'; }
function isOdt(filePath) { return path.extname(filePath).toLowerCase() === '.odt'; }

function sanitizeDocxName(name) {
  let n = String(name || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  if (!n) n = 'document.docx';
  if (!/\.docx$/i.test(n)) n += '.docx';
  return n;
}

function textVal(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text'];
    return String(node['#text'] ?? node ?? '');
  }
  return String(node);
}

/**
 * 提取 Word 文本。
 * - .docx → mammoth（纯文本 / HTML）
 * - .odt → officeparser（纯文本）
 */
async function extractWordText(filePath, format = 'text') {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + (filePath || '') };
  const fmt = String(format || 'text').toLowerCase();
  if (isDocx(filePath)) {
    try {
      const mammoth = require('mammoth');
      const result = fmt === 'html'
        ? await mammoth.convertToHtml({ path: filePath })
        : await mammoth.extractRawText({ path: filePath });
      return {
        ok: true,
        type: 'docx',
        format: fmt,
        content: result.value || '',
        warnings: (result.messages || []).map(m => (m && m.message ? m.message : String(m))).slice(0, 20)
      };
    } catch (e) {
      return { ok: false, error: `读取docx失败：${e.message}` };
    }
  }
  if (isOdt(filePath)) {
    if (fmt !== 'text') return { ok: false, error: '.odt 仅支持 text 格式提取' };
    try {
      const officeParser = require('officeparser');
      const ast = await officeParser.parseOffice(filePath, {
        ignoreNotes: false, newlineDelimiter: '\n', outputErrorToConsole: false, ocr: false
      });
      const content = ast && typeof ast.toText === 'function' ? ast.toText() : '';
      return { ok: true, type: 'odt', format: 'text', content: content || '' };
    } catch (e) {
      return { ok: false, error: `读取odt失败：${e.message}` };
    }
  }
  return { ok: false, error: '仅支持 .docx / .odt 文件' };
}

/**
 * 用 docx 库按结构化 blocks 生成新文档。
 * blocks: heading / paragraph / bullets / numbered / table / image / pageBreak / spacer
 */
async function createWordDocument(spec = {}, workspacePath = '') {
  const docx = require('docx');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, AlignmentType, ImageRun, PageBreak, BorderStyle, ShadingType
  } = docx;

  const blocks = Array.isArray(spec.blocks) ? spec.blocks : [];
  if (!blocks.length) return { ok: false, error: 'blocks 不能为空' };
  const maxChildren = 2000;
  const children = [];

  const alignMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
  const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  try {
    for (let i = 0; i < blocks.length && children.length < maxChildren; i++) {
      const b = blocks[i] || {};
      const type = String(b.type || 'paragraph').toLowerCase();
      if (type === 'heading') {
        const level = Math.max(1, Math.min(6, Number(b.level) || 1));
        children.push(new Paragraph({
          heading: headingLevels[level - 1],
          spacing: { before: 240, after: 160 },
          children: [new TextRun({ text: cleanText(b.text, 5000) })]
        }));
      } else if (type === 'paragraph') {
        children.push(new Paragraph({
          alignment: alignMap[String(b.align).toLowerCase()] || AlignmentType.LEFT,
          spacing: { after: 120 },
          children: [new TextRun({
            text: cleanText(b.text, 5000),
            bold: !!b.bold,
            italics: !!b.italic
          })]
        }));
      } else if (type === 'bullets' || type === 'numbered') {
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200);
        for (const item of items) {
          children.push(new Paragraph({
            bullet: type === 'bullets' ? { level: 0 } : undefined,
            numbering: type === 'numbered' ? { reference: 'default-numbering', level: 0 } : undefined,
            spacing: { after: 80 },
            children: [new TextRun({ text: cleanText(item, 2000) })]
          }));
        }
      } else if (type === 'table') {
        const headers = (Array.isArray(b.headers) ? b.headers : []).slice(0, 12);
        const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 100);
        const tableRows = [];
        if (headers.length) {
          tableRows.push(new TableRow({
            children: headers.map(h => new TableCell({
              shading: { fill: 'E8EEF8', type: ShadingType.CLEAR, color: 'auto' },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new Paragraph({ children: [new TextRun({ text: cleanText(h, 2000), bold: true })] })]
            }))
          }));
        }
        for (const r of rows) {
          tableRows.push(new TableRow({
            children: (Array.isArray(r) ? r : []).slice(0, headers.length || 12).map(c => new TableCell({
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new Paragraph({ children: [new TextRun({ text: cleanText(c, 2000) })] })]
            }))
          }));
        }
        if (tableRows.length) {
          children.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
            borders: { top: { style: BorderStyle.SINGLE, size: 4 }, bottom: { style: BorderStyle.SINGLE, size: 4 }, left: { style: BorderStyle.SINGLE, size: 4 }, right: { style: BorderStyle.SINGLE, size: 4 }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4 }, insideVertical: { style: BorderStyle.SINGLE, size: 4 } }
          }));
        }
      } else if (type === 'image') {
        const imgRes = resolveImagePath(b.path, workspacePath);
        if (!imgRes.ok) return { ok: false, error: `第 ${i + 1} 个内容块图片错误：${imgRes.error}` };
        const imgBuf = fs.readFileSync(imgRes.abs);
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({
            data: imgBuf,
            transformation: {
              width: Number(b.width) > 0 ? Number(b.width) : 420,
              height: Number(b.height) > 0 ? Number(b.height) : 280
            }
          })]
        }));
      } else if (type === 'pagebreak') {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      } else if (type === 'spacer') {
        children.push(new Paragraph({ spacing: { after: Math.max(0, Number(b.lines) || 1) * 120 }, children: [] }));
      } else {
        children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: cleanText(b.text, 5000) })] }));
      }
    }

    const doc = new Document({
      creator: cleanText(spec.author, 200) || 'CIBYP',
      title: cleanText(spec.title, 400),
      description: cleanText(spec.subtitle, 400),
      sections: [{ properties: {}, children }]
    });
    const buffer = await Packer.toBuffer(doc);

    const rawOut = String(spec.outputPath || 'document.docx').trim();
    const outAbs = path.isAbsolute(rawOut)
      ? path.normalize(rawOut)
      : path.resolve(workspacePath || process.cwd(), sanitizeDocxName(rawOut));
    if (!/\.docx$/i.test(outAbs)) return { ok: false, error: '输出文件必须以 .docx 结尾' };
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, buffer);
    return { ok: true, path: outAbs, fileName: path.basename(outAbs), blockCount: children.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 用 docxtemplater + pizzip 按 {{KEY}} 占位符填充模板并另存。
 * 占位符被 Word 拆成多个 run 也能正确合并替换，保留全部格式。
 */
function fillWordTemplate(templatePath, outputPath, data = {}, workspacePath = '') {
  try {
    const PizZip = require('pizzip');
    const Docxtemplater = require('docxtemplater');
    if (!templatePath || !fs.existsSync(templatePath)) return { ok: false, error: '模板不存在: ' + (templatePath || '') };
    if (!isDocx(templatePath)) return { ok: false, error: '模板必须是 .docx 文件' };

    const zip = new PizZip(fs.readFileSync(templatePath));
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      // docxtemplater v3 默认分隔符已改为单花括号，这里显式保持经典的 {{KEY}} 语法
      delimiters: { start: '{{', end: '}}' }
    });
    doc.render(data && typeof data === 'object' ? data : {});

    const rawOut = String(outputPath || 'filled.docx').trim();
    const outAbs = path.isAbsolute(rawOut)
      ? path.normalize(rawOut)
      : path.resolve(workspacePath || path.dirname(templatePath), sanitizeDocxName(rawOut));
    if (!/\.docx$/i.test(outAbs)) return { ok: false, error: '输出文件必须以 .docx 结尾' };
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return { ok: true, path: outAbs, fileName: path.basename(outAbs) };
  } catch (e) {
    return { ok: false, error: `模板填充失败：${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * 读取 Word 元数据。
 * docx → docProps/core.xml + docProps/app.xml；odt → meta.xml。
 * 使用 fast-xml-parser 正规解析（非正则硬解）。
 */
async function getWordMetadata(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + (filePath || '') };
  if (!isDocx(filePath) && !isOdt(filePath)) return { ok: false, error: '仅支持 .docx / .odt 文件' };
  try {
    const AdmZip = requireAdmZip();
    const XMLParser = requireXMLParser();
    if (!AdmZip) return { ok: false, error: '缺少 adm-zip 依赖' };
    if (!XMLParser) return { ok: false, error: '缺少 fast-xml-parser 依赖' };
    const zip = new AdmZip(filePath);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const m = {};

    if (isDocx(filePath)) {
      const core = zip.getEntry('docProps/core.xml');
      const app = zip.getEntry('docProps/app.xml');
      if (core) {
        const p = parser.parse(core.getData().toString('utf8'))['cp:coreProperties'] || {};
        m.title = (p['dc:title'] !== undefined ? p['dc:title'] : p['dcterms:title'] !== undefined ? p['dcterms:title'] : '') || '';
        m.subject = (p['dc:subject'] || '') || '';
        m.creator = (p['dc:creator'] || '') || '';
        m.keywords = (p['cp:keywords'] || '') || '';
        m.description = (p['dc:description'] || '') || '';
        m.lastModifiedBy = (p['cp:lastModifiedBy'] || '') || '';
        m.createdAt = (p['dcterms:created'] || p['dcterms:created'] || '') || '';
        m.modifiedAt = (p['dcterms:modified'] || '') || '';
        m.revision = (p['cp:revision'] || '') || null;
      }
      if (app) {
        const p = parser.parse(app.getData().toString('utf8'))['ep:extended-properties'] || {};
        const props = p['ep:Properties'] || {};
        m.pageCount = Number(props['ep:Pages']) || null;
        m.wordCount = Number(props['ep:Words']) || null;
        m.application = p['ep:Application'] || '';
      }
    } else {
      const meta = zip.getEntry('meta.xml');
      if (meta) {
        const p = parser.parse(meta.getData().toString('utf8'))['office:document-meta'] || {};
        const office = p['office:meta'] || {};
        const titleNode = Array.isArray(office['dc:title']) ? office['dc:title'][0] : office['dc:title'];
        const creatorNode = Array.isArray(office['dc:creator']) ? office['dc:creator'][0] : office['dc:creator'];
        m.title = textVal(titleNode);
        m.creator = textVal(creatorNode);
        m.keywords = '';
        m.description = textVal(office['meta:description']);
        m.createdAt = (office['meta:creation-date'] || '') || '';
        m.modifiedAt = (office['dc:date'] || '') || '';
        const stats = (office['meta:document-statistic'] || {});
        m.pageCount = Number(stats['@_meta:page-count']) || null;
        m.wordCount = Number(stats['@_meta:word-count']) || null;
        m.revision = (office['meta:editing-cycles'] || '') || null;
        m.application = (office['meta:generator'] || '') || '';
      }
    }
    const stat = fs.statSync(filePath);
    return {
      ok: true,
      type: isDocx(filePath) ? 'docx' : 'odt',
      metadata: {
        title: textVal(m.title),
        subject: textVal(m.subject),
        creator: textVal(m.creator),
        keywords: textVal(m.keywords),
        description: textVal(m.description),
        lastModifiedBy: textVal(m.lastModifiedBy),
        createdAt: textVal(m.createdAt),
        modifiedAt: textVal(m.modifiedAt),
        revision: m.revision || null,
        pageCount: m.pageCount || null,
        wordCount: m.wordCount || null,
        application: m.application || ''
      },
      file: { size: stat.size, modifiedAt: stat.mtime.toISOString() }
    };
  } catch (e) {
    return { ok: false, error: `读取元数据失败：${e.message}` };
  }
}

/**
 * 读取 Word 样式列表。用 fast-xml-parser 解析 styles.xml（正规 XML 解析，非正则）。
 */
function listWordStyles(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + (filePath || '') };
    if (!isDocx(filePath) && !isOdt(filePath)) return { ok: false, error: '仅支持 .docx / .odt 文件' };
    const AdmZip = requireAdmZip();
    const XMLParser = requireXMLParser();
    if (!AdmZip) return { ok: false, error: '缺少 adm-zip 依赖' };
    if (!XMLParser) return { ok: false, error: '缺少 fast-xml-parser 依赖' };

    const zip = new AdmZip(filePath);
    const styles = [];
    if (isDocx(filePath)) {
      const entry = zip.getEntry('word/styles.xml');
      if (!entry) return { ok: true, type: 'docx', styles: [], count: 0 };
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'w:style' });
      const parsed = parser.parse(entry.getData().toString('utf8'));
      const root = parsed['w:styles'] || {};
      const list = root['w:style'] || [];
      for (const st of list) {
        const nameNode = st['w:name'] || {};
        styles.push({
          id: st['@_w:styleId'] || '',
          name: nameNode['@_w:val'] || '',
          type: st['@_w:type'] || '',
          basedOn: (st['w:basedOn'] || {})['@_w:val'] || '',
          next: (st['w:next'] || {})['@_w:val'] || ''
        });
      }
      return { ok: true, type: 'docx', styles, count: styles.length };
    }

    // ODT：styles.xml 使用 style: 命名空间
    const entry = zip.getEntry('styles.xml');
    if (!entry) return { ok: true, type: 'odt', styles: [], count: 0 };
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'style:style' });
    const parsed = parser.parse(entry.getData().toString('utf8'));
    const root = parsed['office:document-styles'] || {};
    const list = root['office:styles'] && root['office:styles']['style:style'] ? root['office:styles']['style:style'] : [];
    for (const st of list) {
      styles.push({
        id: st['@_style:name'] || '',
        name: st['@_style:name'] || '',
        type: st['@_style:family'] || '',
        basedOn: st['@_style:parent-style-name'] || '',
        next: ''
      });
    }
    return { ok: true, type: 'odt', styles, count: styles.length };
  } catch (e) {
    return { ok: false, error: `读取样式失败：${e.message}` };
  }
}

module.exports = {
  extractWordText,
  createWordDocument,
  fillWordTemplate,
  getWordMetadata,
  listWordStyles
};
