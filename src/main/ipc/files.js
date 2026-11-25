/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { FileSearchService } = require('../services/file-search-service');

module.exports = function registerFilesIpc({
  ipcMain,
  fs,
  normalizeEncodingName,
  detectEolFromBuffer,
  detectFileEncoding,
  writeTextFileWithEncoding,
  path,
  readTextWithEncoding,
  getSettings = () => ({}),
  searchWorkerEntry,
}) {
  const fileSearchService = new FileSearchService(searchWorkerEntry);
  // ---- IPC: File Operations ----
  ipcMain.handle('fs:readFile', (_, filePath, encoding) => {
    try {
      if (encoding) {
        const iconv = require('iconv-lite');
        const buf = fs.readFileSync(filePath);
        const encName = normalizeEncodingName(encoding);
        if (iconv.encodingExists(encName)) {
          return {
            ok: true,
            content: iconv.decode(buf, encName),
            encoding: encName,
            eol: detectEolFromBuffer(buf),
          };
        }
        return {
          ok: true,
          content: buf.toString('utf-8'),
          encoding: 'utf-8',
          eol: detectEolFromBuffer(buf),
        };
      }
      // 自动检测编码 + 换行模式
      const info = detectFileEncoding(filePath);
      const iconv = require('iconv-lite');
      return {
        ok: true,
        content: iconv.decode(info.buf, info.encoding),
        encoding: info.encoding,
        eol: info.eol,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:writeFile', (_, filePath, content, options = {}) => {
    try {
      const meta = writeTextFileWithEncoding(filePath, content, options);
      return { ok: true, encoding: meta.encoding, eol: meta.eol };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:createFile', (_, filePath, content, options = {}) => {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const meta = writeTextFileWithEncoding(filePath, content || '', options);
      return { ok: true, encoding: meta.encoding, eol: meta.eol };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // 获取文件编码与换行模式
  ipcMain.handle('fs:getFileInfo', (_, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
      const stat = fs.statSync(filePath);
      const info = detectFileEncoding(filePath);
      return {
        ok: true,
        encoding: info.encoding,
        eol: info.eol,
        size: stat.size,
        exists: true,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:presentableFile', async (_, filePath) => {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return { ok: false, error: 'A regular file is required' };
      return { ok: true, size: stat.size, location: 'host' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  // 转换文件编码与换行模式（至少指定 encoding 或 eol 之一）
  ipcMain.handle('fs:convertFileEncoding', (_, filePath, options = {}) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
      const encoding = options && options.encoding ? String(options.encoding) : '';
      const eol = options && options.eol ? String(options.eol).toLowerCase() : '';
      if (!encoding && !eol) return { ok: false, error: '至少需要指定 encoding 或 eol 之一' };
      const info = detectFileEncoding(filePath);
      const iconv = require('iconv-lite');
      const content = iconv.decode(info.buf, info.encoding);
      const meta = writeTextFileWithEncoding(filePath, content, {
        encoding: encoding || info.encoding,
        eol: eol || info.eol,
      });
      return {
        ok: true,
        from: { encoding: info.encoding, eol: info.eol },
        to: { encoding: meta.encoding, eol: meta.eol },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:deleteFile', (_, filePath) => {
    try {
      fs.unlinkSync(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:moveFile', (_, src, dest) => {
    try {
      fs.renameSync(src, dest);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:copyFile', (_, src, dest) => {
    try {
      fs.copyFileSync(src, dest);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:listDirectory', (_, dirPath) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        ok: true,
        entries: entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
        })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:makeDirectory', (_, dirPath) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:deleteDirectory', (_, dirPath) => {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('fs:localSearch', async (_, dirPath, pattern, options = {}) => {
    const restrictDiskScan = getSettings()?.agent?.restrictDiskScan !== false;
    return fileSearchService.localSearch(dirPath, pattern, {
      ...options,
      restrictDiskScan,
    });
  });

  // ---- IPC: searchInFiles (grep-style content search, isolated in child process) ----
  ipcMain.handle('fs:searchInFiles', async (_, paths, pattern, options = {}) => {
    const restrictDiskScan = getSettings()?.agent?.restrictDiskScan !== false;
    return fileSearchService.searchInFiles(paths, pattern, {
      ...options,
      restrictDiskScan,
    });
  });

  return {
    dispose: () => fileSearchService.dispose(),
  };
};
