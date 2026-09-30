/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerDocumentsIpc({
  decodeXmlEntities,
  encodeXmlEntities,
  ipcMain,
  extractWordText,
  createWordDocument,
  fillWordTemplate,
  getWordMetadata,
  listWordStyles,
  fs,
  createPresentation,
  getSettings,
  nativeTheme,
  importSpreadsheetFile,
  exportSpreadsheetFile,
}) {
  function resolveWordDocTarget(pathOrDir) {
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const AdmZip = require('adm-zip');
    const input = String(pathOrDir || '').trim();
    if (!input) throw new Error('缺少pathOrDir参数');
    if (!fsLocal.existsSync(input)) throw new Error('路径不存在: ' + input);

    const stat = fsLocal.statSync(input);
    let dir = input;
    let type = '';
    let sourcePath = input;

    if (stat.isFile()) {
      const ext = pathLocal.extname(input).toLowerCase();
      if (!['.docx', '.odt'].includes(ext)) throw new Error('仅支持 .docx/.odt');
      const parsed = pathLocal.parse(input);
      dir = pathLocal.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(input);
      zip.extractAllTo(dir, true);
      fsLocal.writeFileSync(pathLocal.join(dir, '.__office_ext__'), ext);
      sourcePath = input;
    } else {
      sourcePath = dir;
    }

    if (fsLocal.existsSync(pathLocal.join(dir, 'word', 'document.xml'))) type = 'docx';
    else if (fsLocal.existsSync(pathLocal.join(dir, 'content.xml'))) type = 'odt';
    else throw new Error('不是可识别的Word文档目录（缺少word/document.xml或content.xml）');

    const mainFile =
      type === 'docx'
        ? pathLocal.join(dir, 'word', 'document.xml')
        : pathLocal.join(dir, 'content.xml');
    const stylesFile =
      type === 'docx'
        ? pathLocal.join(dir, 'word', 'styles.xml')
        : pathLocal.join(dir, 'styles.xml');

    return { dir, type, mainFile, stylesFile, sourcePath };
  }

  function extractDocxRuns(content, includeEmpty) {
    const paragraphs = content.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    const items = [];
    let index = 0;
    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const pXml = paragraphs[pIndex];
      const pStyle = (pXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) || [])[1] || '';
      const runs = pXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) || [];
      for (let rIndex = 0; rIndex < runs.length; rIndex++) {
        const rXml = runs[rIndex];
        const tMatches = [...rXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
        if (!tMatches.length) continue;
        const rawText = tMatches.map((m) => m[1]).join('');
        const text = decodeXmlEntities(rawText);
        if (!includeEmpty && !text.trim()) {
          index++;
          continue;
        }
        const color = (rXml.match(/<w:color\b[^>]*w:val="([^"]+)"/) || [])[1] || '';
        const sizeHalfPoint = (rXml.match(/<w:sz\b[^>]*w:val="([^"]+)"/) || [])[1] || '';
        items.push({
          index,
          paragraphIndex: pIndex,
          runIndex: rIndex,
          text,
          style: {
            paragraphStyle: pStyle,
            bold: /<w:b(?:\s[^>]*)?\/>|<w:b(?:\s[^>]*)?><\/w:b>/.test(rXml),
            italic: /<w:i(?:\s[^>]*)?\/>|<w:i(?:\s[^>]*)?><\/w:i>/.test(rXml),
            underline: /<w:u\b/.test(rXml),
            color,
            fontSizePt: sizeHalfPoint ? Number(sizeHalfPoint) / 2 : null,
          },
        });
        index++;
      }
    }
    return items;
  }

  function applyDocxRunUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (m, attrs) => {
      const replaceTo = updatesMap.get(index);
      const currentIndex = index;
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `<w:t${attrs || ''}>${encodeXmlEntities(String(replaceTo))}</w:t>`;
    });
    return { content: next, updated };
  }

  function extractOdtTextNodes(content, includeEmpty) {
    const items = [];
    let index = 0;
    let pIndex = 0;
    content.replace(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g, (pMatch, pInner) => {
      pInner.replace(/>([^<>]*)</g, (m, text) => {
        const value = decodeXmlEntities(text || '');
        if (!includeEmpty && !value.trim()) {
          index++;
          return m;
        }
        items.push({
          index,
          paragraphIndex: pIndex,
          runIndex: null,
          text: value,
          style: {},
        });
        index++;
        return m;
      });
      pIndex++;
      return pMatch;
    });
    return items;
  }

  function applyOdtTextUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/>([^<>]*)</g, (m, text) => {
      const replaceTo = updatesMap.get(index);
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `>${encodeXmlEntities(String(replaceTo))}<`;
    });
    return { content: next, updated };
  }

  function parseDocxStyles(stylesXml) {
    const styles = [];
    const blocks = stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) || [];
    for (const block of blocks) {
      const id = (block.match(/w:styleId="([^"]+)"/) || [])[1] || '';
      const type = (block.match(/w:type="([^"]+)"/) || [])[1] || '';
      const name = (block.match(/<w:name\b[^>]*w:val="([^"]+)"/) || [])[1] || id;
      styles.push({ id, name, type });
    }
    return styles;
  }

  function parseOdtStyles(stylesXml) {
    const styles = [];
    const matches = stylesXml.match(/<style:style\b[^>]*>/g) || [];
    for (const tag of matches) {
      const id = (tag.match(/style:name="([^"]+)"/) || [])[1] || '';
      const family = (tag.match(/style:family="([^"]+)"/) || [])[1] || '';
      styles.push({ id, name: id, type: family });
    }
    return styles;
  }

  function replaceWordPlaceholders(content, replacements) {
    let updated = 0;
    let next = content;
    const entries = Object.entries(replacements || {});
    for (const [key, value] of entries) {
      const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const val = encodeXmlEntities(String(value ?? ''));
      const patterns = [
        new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g'),
        new RegExp(`\\$\\{\\s*${safeKey}\\s*\\}`, 'g'),
        new RegExp(`<<\\s*${safeKey}\\s*>>`, 'g'),
      ];
      for (const re of patterns) {
        const count = (next.match(re) || []).length;
        if (count > 0) {
          next = next.replace(re, val);
          updated += count;
        }
      }
    }
    return { content: next, updated };
  }

  // ---- Office ZIP Tools ----
  ipcMain.handle('office:unpack', async (_, filePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const parsed = path.parse(filePath);
      const outDir = path.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(filePath);
      zip.extractAllTo(outDir, true);
      // Save original extension for repack
      fs.writeFileSync(path.join(outDir, '.__office_ext__'), parsed.ext);
      return { ok: true, dir: outDir, message: `已解压到 ${outDir}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:listContents', async (_, dir) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const result = [];
      function walk(d, rel) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const rp = rel ? rel + '/' + f : f;
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) {
            result.push({ path: rp + '/', size: 0 });
            walk(fp, rp);
          } else result.push({ path: rp, size: stat.size });
        }
      }
      walk(dir, '');
      return { ok: true, files: result, count: result.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:repack', async (_, dir, outputPath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir };
      let ext = '.docx';
      const extFile = path.join(dir, '.__office_ext__');
      if (fs.existsSync(extFile)) ext = fs.readFileSync(extFile, 'utf8').trim();
      const out = outputPath || dir.replace(/_unpacked$/, '') + ext;
      const zip = new AdmZip();
      function addDir(d, zipPath) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const zp = zipPath ? zipPath + '/' + f : f;
          if (fs.statSync(fp).isDirectory()) {
            addDir(fp, zp);
          } else {
            zip.addFile(zp, fs.readFileSync(fp));
          }
        }
      }
      addDir(dir, '');
      zip.writeZip(out);
      return { ok: true, path: out, message: `已打包为 ${out}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Office Text Helpers (for translation workflow) ----
  ipcMain.handle('office:getSlideTexts', async (_, dir, slideFile) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const content = fs.readFileSync(filePath, 'utf8');
      const texts = [];
      let index = 0;
      content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        if (text.trim()) texts.push({ index, text });
        index++;
        return match;
      });
      return { ok: true, slideFile, count: texts.length, texts };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:setSlideTexts', async (_, dir, slideFile, translations) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      let content = fs.readFileSync(filePath, 'utf8');
      const map = {};
      for (const t of translations || []) map[t.index] = t.text;
      let index = 0;
      let count = 0;
      content = content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        const idx = index++;
        if (idx in map) {
          count++;
          return `<a:t>${map[idx]}</a:t>`;
        }
        return match;
      });
      fs.writeFileSync(filePath, content, 'utf8');
      return {
        ok: true,
        slideFile,
        updated: count,
        message: `已更新 ${count} 处文字`,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordExtract', async (_, pathOrDir, options = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const includeEmpty = !!options.includeEmpty;
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const items =
        target.type === 'docx'
          ? extractDocxRuns(xml, includeEmpty)
          : extractOdtTextNodes(xml, includeEmpty);
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        count: items.length,
        items,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordApplyTexts', async (_, pathOrDir, updates = []) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const updatesMap = new Map();
      for (const item of updates || []) {
        const idx = Number(item?.index);
        if (!Number.isInteger(idx) || idx < 0) continue;
        updatesMap.set(idx, String(item?.text ?? ''));
      }
      if (updatesMap.size === 0) return { ok: false, error: '缺少有效updates' };

      const applied =
        target.type === 'docx'
          ? applyDocxRunUpdates(xml, updatesMap)
          : applyOdtTextUpdates(xml, updatesMap);
      fsLocal.writeFileSync(target.mainFile, applied.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        updated: applied.updated,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordGetStyles', async (_, pathOrDir) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      if (!fsLocal.existsSync(target.stylesFile)) {
        return { ok: true, type: target.type, styles: [], count: 0 };
      }
      const stylesXml = fsLocal.readFileSync(target.stylesFile, 'utf8');
      const styles =
        target.type === 'docx' ? parseDocxStyles(stylesXml) : parseOdtStyles(stylesXml);
      return {
        ok: true,
        type: target.type,
        styles,
        count: styles.length,
        stylesFile: target.stylesFile,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordFillTemplate', async (_, pathOrDir, replacements = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const replaced = replaceWordPlaceholders(xml, replacements || {});
      fsLocal.writeFileSync(target.mainFile, replaced.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        replaced: replaced.updated,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Office-Word 工具（正规库驱动）----
  ipcMain.handle('word:extractText', async (_, filePath, format) => {
    try {
      return await extractWordText(filePath, format);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('word:create', async (_, spec, workspacePath) => {
    try {
      return await createWordDocument(spec || {}, workspacePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('word:fillTemplate', async (_, templatePath, outputPath, data, workspacePath) => {
    try {
      return fillWordTemplate(templatePath, outputPath, data || {}, workspacePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('word:getMetadata', async (_, filePath) => {
    try {
      return await getWordMetadata(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('word:listStyles', async (_, filePath) => {
    try {
      return listWordStyles(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- PPT Maker ----
  // 生成视觉化 .pptx（封面/目录/章节/内容/图文/表格/图表/KPI/引用/对比/时间线/结束页），
  // 配色与深浅模式跟随主窗口主题。
  ipcMain.handle('ppt:create', async (_, spec, workspacePath) => {
    try {
      if (!spec || typeof spec !== 'object') return { ok: false, error: '缺少演示文稿定义' };
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        return { ok: false, error: '工作区不存在，无法保存演示文稿' };
      }
      return await createPresentation(spec, {
        workspacePath,
        appTheme: getSettings().theme || {},
        nativeDark: nativeTheme.shouldUseDarkColors,
      });
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // ---- Spreadsheet File I/O ----
  ipcMain.handle('spreadsheet:importFile', async (_, filePath) => {
    try {
      return importSpreadsheetFile(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('spreadsheet:exportFile', async (_, filePath, cells, sheetName) => {
    try {
      return exportSpreadsheetFile(filePath, cells, sheetName);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Email Service IPC ----
};
