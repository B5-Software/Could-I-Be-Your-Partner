/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 持久化日志 + 崩溃记录：GUI 启动时 stdout 会丢失，所有运行日志同步落盘，
 * 上次异常退出时供崩溃报告窗口读取。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEEP_LOG_FILES = 14;
const MAX_CRASH_RECORDS = 20;

let logDir = '';
let crashDir = '';
let currentLogFile = '';
let currentBytes = 0;
let installed = false;
let originals = null;

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function dateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const item of files.slice(KEEP_LOG_FILES)) {
      try { fs.unlinkSync(path.join(logDir, item.f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function openLogFile(reason) {
  currentLogFile = path.join(logDir, `main-${dateStamp()}.log`);
  try {
    currentBytes = fs.existsSync(currentLogFile) ? fs.statSync(currentLogFile).size : 0;
  } catch { currentBytes = 0; }
  if (reason) {
    writeLine('INFO', [`[app-log] log opened (${reason})`]);
  }
}

function rotateIfNeeded() {
  if (!currentLogFile) { openLogFile('reopen'); return; }
  if (currentBytes >= MAX_LOG_BYTES) openLogFile('rotate');
}

function formatArg(a) {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'object') {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  let msg = '';
  try { msg = args.map(formatArg).join(' '); } catch { msg = '[unformattable]'; }
  return `[${ts}] [${level}] ${msg}\n`;
}

function writeLine(level, args) {
  if (!logDir) return;
  try {
    rotateIfNeeded();
    const line = formatLine(level, args);
    fs.appendFileSync(currentLogFile, line, 'utf8');
    currentBytes += Buffer.byteLength(line);
  } catch { /* never break logging callers */ }
}

function install() {
  if (installed) return;
  installed = true;
  originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  console.log = (...a) => { originals.log(...a); writeLine('INFO', a); };
  console.info = (...a) => { originals.info(...a); writeLine('INFO', a); };
  console.warn = (...a) => { originals.warn(...a); writeLine('WARN', a); };
  console.error = (...a) => { originals.error(...a); writeLine('ERROR', a); };
  console.debug = (...a) => { originals.debug(...a); writeLine('DEBUG', a); };
}

function initLogging(options = {}) {
  const baseDir = options.logDir || (options.app ? path.join(options.app.getPath('userData'), 'logs') : '');
  if (!baseDir) return;
  logDir = baseDir;
  crashDir = options.crashDir || path.join(path.dirname(baseDir), 'data', 'crash');
  ensureDir(logDir);
  ensureDir(crashDir);
  cleanupOldLogs();
  install();
  openLogFile('boot');
  writeLine('INFO', ['[app-log] logging initialized', `pid=${process.pid}`, `platform=${process.platform}`, `electron=${process.versions.electron || '-'}`]);
}

function currentLogPath() {
  return currentLogFile;
}

function tailLines(count = 400) {
  const n = Math.max(1, Math.min(5000, Number(count) || 400));
  const out = [];
  try {
    const files = fs.readdirSync(logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const item of files.slice(-3)) {
      let text = '';
      try { text = fs.readFileSync(path.join(logDir, item.f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (line) out.push(line);
      }
    }
  } catch { /* ignore */ }
  return out.slice(-n).join('\n');
}

function writeCrashRecord(record = {}) {
  const entry = {
    ts: Date.now(),
    source: record.source || 'unknown',
    message: record.message || '',
    stack: record.stack || '',
    extra: record.extra || null,
  };
  try {
    ensureDir(crashDir);
    const file = path.join(crashDir, 'crashes.json');
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push(entry);
    if (list.length > MAX_CRASH_RECORDS) list = list.slice(-MAX_CRASH_RECORDS);
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
    fs.writeFileSync(path.join(crashDir, 'last-crash.json'), JSON.stringify(entry, null, 2), 'utf8');
  } catch { /* ignore */ }
  writeLine('ERROR', [`[crash] ${entry.source}: ${entry.message}`]);
  return entry;
}

function readCrashRecords(sinceMs = 0) {
  try {
    const file = path.join(crashDir, 'crashes.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r && typeof r.ts === 'number' && r.ts > sinceMs);
  } catch {
    return [];
  }
}

function clearCrashRecords() {
  try {
    fs.writeFileSync(path.join(crashDir, 'crashes.json'), '[]', 'utf8');
    try { fs.unlinkSync(path.join(crashDir, 'last-crash.json')); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function listDumpFiles(dumpDir) {
  const out = [];
  const dirs = [];
  for (const dir of [dumpDir, crashDir]) {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.(dmp|dump|heapsnapshot)$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function getLogDir() { return logDir; }
function getCrashDir() { return crashDir; }

function flush() {
  /* appendFileSync 已即时落盘，无需 flush */
}

module.exports = {
  initLogging,
  currentLogPath,
  tailLines,
  writeCrashRecord,
  readCrashRecords,
  clearCrashRecords,
  listDumpFiles,
  getLogDir,
  getCrashDir,
  flush,
};
