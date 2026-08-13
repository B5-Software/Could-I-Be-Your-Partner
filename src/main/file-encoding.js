/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 文件编码 / 换行模式检测与写入工具，以及 zip 依赖懒加载。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function requireAdmZip() {
  try { return require('adm-zip'); } catch { return null; }
}

function readTextWithEncoding(filePath) {
  try {
    const iconv = require('iconv-lite');
    const buf = fs.readFileSync(filePath);
    const encoding = detectEncodingName(buf);
    if (iconv.encodingExists(encoding)) {
      return iconv.decode(buf, encoding);
    }
    return buf.toString('utf-8');
  } catch {
    return fs.readFileSync(filePath, 'utf-8');
  }
}

// ---- 编码 / 换行模式检测与写入基础设施 ----
// 目标：所有文件读写工具默认自动识别编码与换行模式，允许 Agent 显式指定。

/**
 * 规范化 chardet 输出的编码名为 iconv-lite 支持的名称。
 */
function normalizeEncodingName(name) {
  if (!name || typeof name !== 'string') return 'utf-8';
  const n = name.toLowerCase().replace(/_/g, '-').trim();
  const iconv = require('iconv-lite');
  if (iconv.encodingExists(n)) return n;
  const aliasMap = {
    'shift-jis': 'shift_jis',
    'windows-1252': 'win1252',
    'windows-1251': 'win1251',
    'windows-1250': 'win1250',
    'windows-1254': 'win1254',
    'iso-8859-1': 'latin1',
    'iso-8859-2': 'latin2',
    'iso-8859-15': 'latin9',
    'mac-cyrillic': 'mac-cyrillic',
    'x-mac-cyrillic': 'mac-cyrillic',
    'mac-roman': 'macintosh',
    'ascii': 'ascii',
    'utf8': 'utf-8',
    'utf-16': 'utf-16',
    'ucs-2': 'utf16le',
    'ucs2': 'utf16le',
    'gb-2312': 'gb2312',
    'big-5': 'big5',
    'koi8-r': 'koi8-r',
    'euc-kr': 'euckr',
    'euc-jp': 'eucjp'
  };
  const mapped = aliasMap[n] || n;
  return iconv.encodingExists(mapped) ? mapped : 'utf-8';
}

/**
 * 从文件 Buffer 检测换行模式：优先 CRLF，其次单独 CR（旧 Mac），否则 LF。
 * 基于字节扫描（0x0D/0x0A），避免多字节编码中字节值误判。
 * @returns {'crlf'|'cr'|'lf'}
 */
function detectEolFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return 'lf';
  const len = Math.min(buf.length, 131072);
  let crlf = false;
  let loneCr = false;
  let loneLf = false;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b === 0x0D) {
      if (i + 1 < len && buf[i + 1] === 0x0A) { crlf = true; i++; }
      else loneCr = true;
    } else if (b === 0x0A) {
      loneLf = true;
    }
  }
  if (crlf) return 'crlf';
  if (loneCr && !loneLf) return 'cr';
  return 'lf';
}

/**
 * 从 Buffer 检测编码（chardet analyse 候选 + 中文编码优先启发式）。
 * chardet 对短 GBK 中文文本常误判为 Shift_JIS/Big5（各候选置信度相同），
 * 此时若存在 GB18030/GBK 候选且置信度不低于首位太多，优先选择中文编码；
 * 对长文本各编码置信度差异明显，不会误判日文/繁体等真实文件。
 * @returns {string} 规范化的 iconv-lite 编码名
 */
function detectEncodingName(buf) {
  try {
    const chardet = require('chardet');
    const candidates = chardet.analyse(buf) || [];
    if (candidates.length === 0) return 'utf-8';
    // 纯 ASCII：UTF-8 是其超集，直接返回最稳妥
    if (candidates.length === 1 && candidates[0].name === 'ASCII') return 'utf-8';
    const top = candidates[0];
    const gb = candidates.find(c => /^GB(18030|2312|K)/i.test(c.name));
    if (gb && (gb.confidence >= top.confidence || (top.confidence - gb.confidence) <= 15)) {
      return normalizeEncodingName(gb.name);
    }
    return normalizeEncodingName(top.name);
  } catch {
    return 'utf-8';
  }
}

/**
 * 检测文件编码（chardet），返回规范化编码名；同时检测换行模式。
 * @returns {{ encoding: string, eol: string, buf: Buffer }}
 */
function detectFileEncoding(filePath) {
  const buf = fs.readFileSync(filePath);
  return { encoding: detectEncodingName(buf), eol: detectEolFromBuffer(buf), buf };
}

/**
 * 新建文件时推断编码：Windows 传统批处理/注册表脚本按系统 ANSI 代码页（GBK）
 * 兼容性更好，其余文件类型一律 UTF-8。
 */
function inferEncodingForNewFile(filePath) {
  const ext = (path.extname(filePath) || '').toLowerCase();
  if (process.platform === 'win32' && ['.bat', '.cmd', '.reg'].includes(ext)) {
    return 'gbk';
  }
  return 'utf-8';
}

/**
 * 新建文件时推断换行模式：跟随当前系统环境（Windows → CRLF，其他 → LF）。
 * @returns {'crlf'|'lf'}
 */
function inferEolForNewFile() {
  return process.platform === 'win32' ? 'crlf' : 'lf';
}

/**
 * 按指定（或自动检测/推断的）编码与换行模式写入文件。
 * - 未指定 encoding/eol 且文件已存在：沿用原文件的编码与换行（编辑不改变）
 * - 未指定 encoding/eol 且文件不存在：按文件类型 + 系统环境推断（创建）
 * @returns {{ encoding: string, eol: string }}
 */
function writeTextFileWithEncoding(filePath, content, options = {}) {
  let encoding = options && options.encoding ? String(options.encoding).toLowerCase() : '';
  let eol = options && options.eol ? String(options.eol).toLowerCase() : '';
  const fileExists = fs.existsSync(filePath);
  let existing = null;
  if (fileExists && (!encoding || !eol)) {
    try { existing = detectFileEncoding(filePath); } catch { /* ignore */ }
  }
  if (!encoding) {
    encoding = existing ? existing.encoding : inferEncodingForNewFile(filePath);
  } else {
    encoding = normalizeEncodingName(encoding);
  }
  if (!eol) {
    eol = existing ? existing.eol : inferEolForNewFile();
  }
  if (eol !== 'crlf' && eol !== 'cr' && eol !== 'lf') eol = 'lf';
  // 统一换行后再按目标模式写回
  let text = String(content);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (eol === 'crlf') text = normalized.replace(/\n/g, '\r\n');
  else if (eol === 'cr') text = normalized.replace(/\n/g, '\r');
  else text = normalized;
  const iconv = require('iconv-lite');
  const encName = iconv.encodingExists(encoding) ? encoding : 'utf-8';
  const buf = iconv.encode(text, encName);
  fs.writeFileSync(filePath, buf);
  return { encoding: encName, eol };
}


module.exports = {
  requireAdmZip,
  readTextWithEncoding,
  normalizeEncodingName,
  detectEolFromBuffer,
  detectEncodingName,
  detectFileEncoding,
  inferEncodingForNewFile,
  inferEolForNewFile,
  writeTextFileWithEncoding
};
