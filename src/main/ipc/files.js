/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerFilesIpc({
  ipcMain,
  fs,
  normalizeEncodingName,
  detectEolFromBuffer,
  detectFileEncoding,
  writeTextFileWithEncoding,
  path,
  readTextWithEncoding,
}) {
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
    return new Promise((resolve) => {
      const results = [];
      const {
        ignoreCase = true,
        maxResults = 200,
        fileOnly = false,
        dirOnly = false,
        regex = false,
        depth = -1, // -1 means unlimited
      } = options;

      let searchRegex;
      if (regex) {
        try {
          searchRegex = new RegExp(pattern, ignoreCase ? 'i' : '');
        } catch (e) {
          resolve({
            ok: false,
            error: `Invalid regex pattern: ${e.message}`,
          });
          return;
        }
      } else {
        // Convert glob pattern (*.img, *.*, test?.txt) to regex
        // Escape regex special chars except * and ?
        const globToRegex = (glob) =>
          glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        try {
          searchRegex = new RegExp('^' + globToRegex(pattern) + '$', ignoreCase ? 'i' : '');
        } catch (e) {
          resolve({ ok: false, error: `Invalid pattern: ${e.message}` });
          return;
        }
      }

      function matches(name) {
        return searchRegex.test(name);
      }

      function walk(dir, currentDepth = 0) {
        if (results.length >= maxResults) return;
        if (depth >= 0 && currentDepth > depth) return;

        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (results.length >= maxResults) break;

            const full = path.join(dir, e.name);
            const isDir = e.isDirectory();

            // Apply file/dir filters
            if (fileOnly && isDir) continue;
            if (dirOnly && !isDir) continue;

            // Check if matches pattern
            if (matches(e.name)) {
              results.push(full);
            }

            // Recurse into directories
            if (isDir) {
              walk(full, currentDepth + 1);
            }
          }
        } catch {
          /* skip inaccessible */
        }
      }

      // Run search asynchronously
      setImmediate(() => {
        try {
          walk(dirPath);
          resolve({ ok: true, results, count: results.length });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
  });

  // ---- IPC: searchInFiles (grep-style content search) ----
  // Searches file CONTENTS (not filenames). Supports multi-file/dir input,
  // filename glob filters, regex/text search, encoding specification,
  // and returns structured results with line/column/context info.
  ipcMain.handle('fs:searchInFiles', async (_, paths, pattern, options = {}) => {
    return new Promise((resolve) => {
      try {
        if (!Array.isArray(paths) || paths.length === 0) {
          resolve({ ok: false, error: 'paths 参数必须是非空数组' });
          return;
        }
        if (!pattern || typeof pattern !== 'string') {
          resolve({ ok: false, error: 'pattern 参数必须是非空字符串' });
          return;
        }

        const {
          isRegex = false,
          ignoreCase = true,
          include = '',
          exclude = '',
          encoding = '',
          maxResults = 500,
          contextLines = 0,
          multiline = false,
        } = options;

        // Build regex
        let regex;
        try {
          const flags = (ignoreCase ? 'i' : '') + (multiline ? 'gm' : 'g');
          const patternStr = isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          regex = new RegExp(patternStr, flags);
        } catch (e) {
          resolve({
            ok: false,
            error: `Invalid regex pattern: ${e.message}`,
          });
          return;
        }

        // Parse include/exclude globs
        const includeGlobs = include
          ? include
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const excludeGlobs = exclude
          ? exclude
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        // Helper: convert glob to regex (* -> .*, ? -> .)
        function globToRegex(glob) {
          const s = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp('^' + s + '$', 'i');
        }
        function matchGlob(name, globs) {
          if (globs.length === 0) return false;
          return globs.some((g) => globToRegex(g).test(name));
        }

        // Read file content with encoding (auto-detect via chardet, or specified)
        function readFileContent(filePath) {
          try {
            if (encoding) {
              const iconv = require('iconv-lite');
              const buf = fs.readFileSync(filePath);
              const encName = normalizeEncodingName(encoding);
              if (iconv.encodingExists(encName)) return iconv.decode(buf, encName);
              return buf.toString('utf-8');
            }
            return readTextWithEncoding(filePath);
          } catch {
            return null;
          }
        }

        // Binary file extensions to skip
        const binaryExts = new Set([
          'png',
          'jpg',
          'jpeg',
          'gif',
          'bmp',
          'ico',
          'webp',
          'tiff',
          'tif',
          'heic',
          'avif',
          'pdf',
          'zip',
          'gz',
          'tar',
          'bz2',
          '7z',
          'rar',
          'xz',
          'cab',
          'iso',
          'dmg',
          'pkg',
          'exe',
          'dll',
          'so',
          'dylib',
          'bin',
          'obj',
          'lib',
          'class',
          'jar',
          'war',
          'ear',
          'o',
          'a',
          'mp3',
          'mp4',
          'avi',
          'mov',
          'mkv',
          'flv',
          'wav',
          'flac',
          'ogg',
          'aac',
          'webm',
          'm4a',
          'm4v',
          'docx',
          'xlsx',
          'pptx',
          'doc',
          'xls',
          'ppt',
          'odt',
          'ods',
          'odp',
          'db',
          'sqlite',
          'sqlite3',
          'mdb',
          'accdb',
          'ttf',
          'otf',
          'woff',
          'woff2',
          'eot',
          'pfb',
          'psd',
          'ai',
          'eps',
          'indd',
          'sketch',
          'fig',
          'node',
          'wasm',
          'pyc',
          'pyo',
          'class',
          'swf',
          'pak',
          'dat',
          'npy',
          'npz',
          'pickle',
          'pkl',
        ]);

        const results = [];
        let totalMatches = 0;
        let filesScanned = 0;
        let filesWithMatches = 0;
        let truncated = false;

        function searchInFile(filePath) {
          if (truncated) return;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          if (binaryExts.has(ext)) return;

          const baseName = path.basename(filePath);
          if (includeGlobs.length > 0 && !matchGlob(baseName, includeGlobs)) return;
          if (excludeGlobs.length > 0 && matchGlob(baseName, excludeGlobs)) return;

          filesScanned++;
          const rawContent = readFileContent(filePath);
          if (rawContent === null || rawContent === undefined) return;

          // 自动识别换行模式并统一为 \n（CRLF / 旧 Mac CR / LF），
          // 避免行尾残留 \r 导致行号偏移或正则（$、^、跨行）匹配失败；
          // 同时剥离 UTF-8/UTF-16 BOM，防止 \uFEFF 干扰锚点匹配。
          let content = rawContent;
          if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
          content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          if (content.length === 0) return;

          const lines = content.split('\n');
          const fileMatches = [];

          if (multiline) {
            regex.lastIndex = 0;
            let m;
            while ((m = regex.exec(content)) !== null) {
              if (totalMatches >= maxResults) {
                truncated = true;
                break;
              }
              const before = content.slice(0, m.index);
              const lineNum = before.split('\n').length;
              const lineStart = before.lastIndexOf('\n') + 1;
              const lineEndIdx = content.indexOf('\n', m.index + m[0].length);
              const lineText = content.slice(
                lineStart,
                lineEndIdx === -1 ? content.length : lineEndIdx,
              );
              fileMatches.push({
                line: lineNum,
                column: m.index - lineStart + 1,
                text: lineText.length > 500 ? lineText.slice(0, 500) + '…' : lineText,
                matchStart: m.index - lineStart,
                matchEnd: m.index - lineStart + m[0].length,
                contextBefore:
                  contextLines > 0
                    ? lines.slice(Math.max(0, lineNum - 1 - contextLines), lineNum - 1)
                    : [],
                contextAfter: contextLines > 0 ? lines.slice(lineNum, lineNum + contextLines) : [],
              });
              totalMatches++;
              if (m.index === regex.lastIndex) regex.lastIndex++;
            }
          } else {
            for (let i = 0; i < lines.length; i++) {
              if (totalMatches >= maxResults) {
                truncated = true;
                break;
              }
              const line = lines[i];
              regex.lastIndex = 0;
              const m = regex.exec(line);
              if (m) {
                fileMatches.push({
                  line: i + 1,
                  column: m.index + 1,
                  text: line.length > 500 ? line.slice(0, 500) + '…' : line,
                  matchStart: m.index,
                  matchEnd: m.index + m[0].length,
                  contextBefore:
                    contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : [],
                  contextAfter: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines) : [],
                });
                totalMatches++;
              }
            }
          }

          if (fileMatches.length > 0) {
            filesWithMatches++;
            results.push({ file: filePath, matches: fileMatches });
          }
        }

        function walk(dir) {
          if (truncated) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (truncated) break;
              if (excludeGlobs.length > 0 && matchGlob(e.name, excludeGlobs)) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) walk(full);
              else if (e.isFile()) searchInFile(full);
            }
          } catch {
            /* skip */
          }
        }

        setImmediate(() => {
          try {
            for (const p of paths) {
              if (truncated) break;
              if (!p || typeof p !== 'string') continue;
              try {
                const stat = fs.statSync(p);
                if (stat.isDirectory()) walk(p);
                else if (stat.isFile()) searchInFile(p);
              } catch {
                /* skip invalid path */
              }
            }
            resolve({
              ok: true,
              matches: results,
              totalMatches,
              filesScanned,
              filesWithMatches,
              truncated,
              message: `找到 ${totalMatches} 处匹配（${filesWithMatches} 个文件，扫描 ${filesScanned} 个文件）${truncated ? '（已截断）' : ''}`,
            });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
};
