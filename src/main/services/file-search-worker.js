/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iconv = require('iconv-lite');
const chardet = require('chardet');
const { normalizeEncodingName } = require('../file-encoding');

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.cibyp-code-history',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

const BINARY_EXTS = new Set([
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
  'swf',
  'pak',
  'dat',
  'npy',
  'npz',
  'pickle',
  'pkl',
  'qcow2',
  'img',
  'raw',
  'asar',
  'vmdk',
  'vdi',
  'vhdx',
]);

function normalizePathKey(p) {
  const resolved = path.resolve(String(p || ''));
  const stripped = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

function isBroadScanPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const trimmed = targetPath.trim();
  if (!trimmed) return false;
  if (trimmed === '/' || trimmed === '\\' || /^[a-zA-Z]:[\\/]?$/.test(trimmed)) return true;

  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true;

  const key = normalizePathKey(resolved);
  const home = normalizePathKey(os.homedir());
  if (key === home) return true;

  if (process.platform === 'win32') {
    const winRoot = normalizePathKey(parsed.root);
    const broadWin = new Set([
      `${winRoot}\\users`,
      `${winRoot}\\windows`,
      `${winRoot}\\program files`,
      `${winRoot}\\program files (x86)`,
      `${winRoot}\\programdata`,
    ]);
    if (broadWin.has(key)) return true;
  } else {
    const broadPosix = new Set([
      '/users',
      '/home',
      '/root',
      '/usr',
      '/etc',
      '/var',
      '/opt',
      '/system',
      '/library',
      '/applications',
      '/proc',
      '/sys',
      '/dev',
    ]);
    if (
      broadPosix.has(key.toLowerCase()) ||
      ['/mnt', '/media', '/volumes'].includes(key.toLowerCase())
    )
      return true;
  }
  return false;
}

function isBroadScanTarget(directory) {
  if (isBroadScanPath(directory)) return true;
  try {
    return isBroadScanPath(fs.realpathSync.native(directory));
  } catch {
    return false;
  }
}

function globToRegex(glob, ignoreCase = true) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', ignoreCase ? 'i' : '');
}

function isBinaryBuffer(buf) {
  const limit = Math.min(buf.length, 4096);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function decodeBuffer(buf, explicitEncoding) {
  if (explicitEncoding) {
    const enc = normalizeEncodingName(explicitEncoding);
    if (iconv.encodingExists(enc)) return iconv.decode(buf, enc);
    return buf.toString('utf-8');
  }
  // BOM checks first
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf-8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.subarray(2), 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.subarray(2), 'utf-16be');
  }
  // Fast UTF-8 validity check on head slice before calling chardet
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  let allAscii = true;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] >= 0x80) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) return buf.toString('utf-8');

  try {
    const detected = chardet.analyse(sample);
    const best = detected && detected[0];
    if (best && best.name && best.confidence >= 60) {
      const enc = normalizeEncodingName(best.name);
      if (iconv.encodingExists(enc)) return iconv.decode(buf, enc);
    }
  } catch {
    /* fallback to utf-8 */
  }
  return buf.toString('utf-8');
}

function clipLine(line, max = 500) {
  return line.length > max ? line.slice(0, max) + '…' : line;
}

const RESTRICT_SCAN_ERROR =
  '已开启「禁止全盘扫描」：不允许直接对磁盘根目录、用户主目录或系统目录执行递归搜索。请先用 listDirectory 查看目录结构，定位到具体项目或小范围子目录后再搜索。';

function runLocalSearch(dirPath, pattern, options = {}) {
  const {
    ignoreCase = true,
    maxResults = 200,
    fileOnly = false,
    dirOnly = false,
    regex = false,
    depth = -1,
    includeIgnored = false,
    restrictDiskScan = true,
    timeoutMs = 15000,
    maxEntries = 50000,
  } = options;

  if (!dirPath || typeof dirPath !== 'string') {
    return { ok: false, error: 'directory 参数必须是非空字符串' };
  }
  if (restrictDiskScan && isBroadScanTarget(dirPath)) {
    return { ok: false, blocked: true, error: RESTRICT_SCAN_ERROR };
  }

  let searchRegex;
  try {
    searchRegex = regex
      ? new RegExp(pattern, ignoreCase ? 'i' : '')
      : globToRegex(pattern, ignoreCase);
  } catch (e) {
    return { ok: false, error: `Invalid ${regex ? 'regex' : 'glob'} pattern: ${e.message}` };
  }

  const results = [];
  const cap = Math.max(1, Math.min(2000, Number(maxResults) || 200));
  const deadline = Date.now() + Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));
  let entriesVisited = 0;
  let truncated = false;
  let stopReason = '';

  function walk(dir, currentDepth) {
    if (truncated) return;
    if (depth >= 0 && currentDepth > depth) return;
    if (Date.now() > deadline) {
      truncated = true;
      stopReason = 'timeout';
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (results.length >= cap) {
        truncated = true;
        stopReason = 'maxResults';
        return;
      }
      entriesVisited++;
      if (entriesVisited > maxEntries) {
        truncated = true;
        stopReason = 'maxEntries';
        return;
      }
      if ((entriesVisited & 255) === 0 && Date.now() > deadline) {
        truncated = true;
        stopReason = 'timeout';
        return;
      }

      const isDir = e.isDirectory();
      if (isDir && !includeIgnored && DEFAULT_IGNORED_DIRS.has(e.name)) continue;

      const full = path.join(dir, e.name);
      const typeAllowed = (!fileOnly || !isDir) && (!dirOnly || isDir);
      if (typeAllowed && searchRegex.test(e.name)) {
        results.push(full);
      }

      // Always recurse into subdirectories (fixing previous bug where fileOnly skipped recursion)
      if (isDir) {
        walk(full, currentDepth + 1);
      }
    }
  }

  try {
    walk(dirPath, 0);
    return {
      ok: true,
      results,
      count: results.length,
      entriesVisited,
      truncated,
      ...(stopReason ? { stopReason } : {}),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function runSearchInFiles(paths, pattern, options = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'paths 参数必须是非空数组' };
  }
  if (!pattern || typeof pattern !== 'string') {
    return { ok: false, error: 'pattern 参数必须是非空字符串' };
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
    includeIgnored = false,
    restrictDiskScan = true,
    maxFileBytes = 2 * 1024 * 1024,
    maxFilesScanned = 5000,
    timeoutMs = 25000,
  } = options;

  if (restrictDiskScan) {
    for (const p of paths) {
      if (typeof p === 'string' && isBroadScanTarget(p)) {
        return { ok: false, blocked: true, error: RESTRICT_SCAN_ERROR };
      }
    }
  }

  let regex;
  try {
    const flags = (ignoreCase ? 'i' : '') + (multiline ? 'gm' : 'g');
    const patternStr = isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(patternStr, flags);
  } catch (e) {
    return { ok: false, error: `Invalid regex pattern: ${e.message}` };
  }

  const includeRegexes = include
    ? String(include)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((g) => globToRegex(g, true))
    : [];
  const excludeRegexes = exclude
    ? String(exclude)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((g) => globToRegex(g, true))
    : [];

  const matchesAny = (name, regexList) => regexList.some((re) => re.test(name));

  const results = [];
  const cap = Math.max(1, Math.min(2000, Number(maxResults) || 500));
  const ctxLines = Math.max(0, Math.min(10, Number(contextLines) || 0));
  const deadline = Date.now() + Math.max(1000, Math.min(60000, Number(timeoutMs) || 25000));
  let totalMatches = 0;
  let filesScanned = 0;
  let filesSkippedLarge = 0;
  let filesWithMatches = 0;
  let truncated = false;
  let stopReason = '';

  function searchFile(filePath) {
    if (truncated) return;
    if (filesScanned >= maxFilesScanned) {
      truncated = true;
      stopReason = 'maxFilesScanned';
      return;
    }
    if ((filesScanned & 31) === 0 && Date.now() > deadline) {
      truncated = true;
      stopReason = 'timeout';
      return;
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (BINARY_EXTS.has(ext)) return;

    const baseName = path.basename(filePath);
    if (includeRegexes.length > 0 && !matchesAny(baseName, includeRegexes)) return;
    if (excludeRegexes.length > 0 && matchesAny(baseName, excludeRegexes)) return;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size === 0) return;
    if (stat.size > maxFileBytes) {
      filesSkippedLarge++;
      return;
    }

    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return;
    }
    if (isBinaryBuffer(buf)) return;

    filesScanned++;
    let content = decodeBuffer(buf, encoding);
    if (!content) return;
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (content.length === 0) return;

    const lines = content.split('\n');
    const fileMatches = [];

    if (multiline) {
      // Precompute line start offsets once for O(log N) line lookup instead of O(N^2) split
      const lineStarts = [0];
      for (let idx = 0; idx < content.length; idx++) {
        if (content.charCodeAt(idx) === 10) lineStarts.push(idx + 1);
      }
      const lineOfIndex = (offset) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid] <= offset) lo = mid;
          else hi = mid - 1;
        }
        return lo; // 0-based line index
      };
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(content)) !== null) {
        if (totalMatches >= cap) {
          truncated = true;
          stopReason = 'maxResults';
          break;
        }
        const lineIdx = lineOfIndex(m.index);
        const lineStart = lineStarts[lineIdx];
        const lineText = lines[lineIdx] || '';
        fileMatches.push({
          line: lineIdx + 1,
          column: m.index - lineStart + 1,
          text: clipLine(lineText),
          matchStart: m.index - lineStart,
          matchEnd: m.index - lineStart + m[0].length,
          contextBefore:
            ctxLines > 0
              ? lines.slice(Math.max(0, lineIdx - ctxLines), lineIdx).map((l) => clipLine(l, 300))
              : [],
          contextAfter:
            ctxLines > 0
              ? lines.slice(lineIdx + 1, lineIdx + 1 + ctxLines).map((l) => clipLine(l, 300))
              : [],
        });
        totalMatches++;
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= cap) {
          truncated = true;
          stopReason = 'maxResults';
          break;
        }
        const line = lines[i];
        regex.lastIndex = 0;
        const m = regex.exec(line);
        if (m) {
          fileMatches.push({
            line: i + 1,
            column: m.index + 1,
            text: clipLine(line),
            matchStart: m.index,
            matchEnd: m.index + m[0].length,
            contextBefore:
              ctxLines > 0
                ? lines.slice(Math.max(0, i - ctxLines), i).map((l) => clipLine(l, 300))
                : [],
            contextAfter:
              ctxLines > 0 ? lines.slice(i + 1, i + 1 + ctxLines).map((l) => clipLine(l, 300)) : [],
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
    if (Date.now() > deadline) {
      truncated = true;
      stopReason = 'timeout';
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) break;
      const isDir = e.isDirectory();
      if (isDir && !includeIgnored && DEFAULT_IGNORED_DIRS.has(e.name)) continue;
      if (excludeRegexes.length > 0 && matchesAny(e.name, excludeRegexes)) continue;
      const full = path.join(dir, e.name);
      if (isDir) walk(full);
      else if (e.isFile()) searchFile(full);
    }
  }

  for (const p of paths) {
    if (truncated) break;
    if (!p || typeof p !== 'string') continue;
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile()) searchFile(p);
    } catch {
      /* skip invalid path */
    }
  }

  const skippedNote = filesSkippedLarge > 0 ? `，跳过 ${filesSkippedLarge} 个超大文件` : '';
  const truncNote = truncated
    ? stopReason === 'timeout'
      ? '（已超时截断，请缩小搜索目录）'
      : '（已截断）'
    : '';
  return {
    ok: true,
    matches: results,
    totalMatches,
    filesScanned,
    filesWithMatches,
    truncated,
    ...(stopReason ? { stopReason } : {}),
    message: `找到 ${totalMatches} 处匹配（${filesWithMatches} 个文件，扫描 ${filesScanned} 个文件${skippedNote}）${truncNote}`,
  };
}

function startWorker() {
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { id, action, args } = msg;
    let result;
    try {
      if (action === 'localSearch') {
        result = runLocalSearch(args.dirPath, args.pattern, args.options);
      } else if (action === 'searchInFiles') {
        result = runSearchInFiles(args.paths, args.pattern, args.options);
      } else {
        result = { ok: false, error: `Unknown search action: ${action}` };
      }
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    }
    try {
      if (process.connected) process.send({ id, result });
    } catch {
      /* parent disconnected */
    }
  });
  process.once('disconnect', () => process.exit(0));
}

if (require.main === module) startWorker();

module.exports = {
  startWorker,
  isBroadScanPath,
  runLocalSearch,
  runSearchInFiles,
  DEFAULT_IGNORED_DIRS,
  RESTRICT_SCAN_ERROR,
};
