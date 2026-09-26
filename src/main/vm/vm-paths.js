/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 路径判定与映射工具（宿主 ↔ 虚拟机）。
 *
 * 背景：早期实现用"以 / 开头 = VM 路径"做判断，这在 Windows 上勉强成立，
 * 但在 macOS/Linux 上宿主路径本身就以 / 开头，会把所有宿主绝对路径原样发给 guest
 * （SFTP/find/grep 全失败）。这里提供唯一权威判定，供 vm-fs / vm-service / vm-tools / main.js 共用。
 *
 * 判定顺序（保证 POSIX 宿主路径不被误判）：
 *   1. 命中 VM 工作区挂载点（默认 /workspace）或任一外部挂载的 vmRoot → VM 路径
 *   2. 命中 guest 系统目录白名单（/tmp、/home/cibyp、/root…）→ VM 路径
 *   3. POSIX 绝对路径且宿主文件系统存在该路径 → 宿主路径
 *   4. 其它绝对路径 → 默认 VM 路径（保持旧行为，例如 guest 内还不存在的输出文件）
 *   5. 相对路径 → 不是 VM 路径
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** guest 内常见系统目录（这些路径即使宿主也存在，也按 VM 路径处理） */
const VM_SYSTEM_PREFIXES = [
  '/tmp', '/var/tmp', '/var/folders', '/home/cibyp', '/root', '/opt', '/srv',
  '/usr', '/etc', '/run', '/dev', '/proc', '/sys', '/bin', '/sbin', '/lib',
];

/** 归一化挂载点（去掉尾部斜杠，保证至少有值） */
function normMount(mount) {
  const m = String(mount == null ? '' : mount).trim();
  if (!m) return '/workspace';
  const trimmed = m.replace(/\/+$/, '');
  return trimmed || '/workspace';
}

/** 判断 p 是否落在 root 内（带分隔符边界，避免 /workspaceXYZ 命中 /workspace） */
function isUnder(root, p, { caseInsensitive = process.platform === 'win32' } = {}) {
  if (!root) return false;
  let r;
  let t;
  try {
    r = path.resolve(String(root));
    t = path.resolve(String(p));
  } catch {
    return false;
  }
  if (caseInsensitive) { r = r.toLowerCase(); t = t.toLowerCase(); }
  if (r === t) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** root 内相对路径（统一 / 分隔）；不在 root 内返回 null */
function relUnder(root, p) {
  if (!isUnder(root, p)) return null;
  try {
    const rel = path.relative(path.resolve(String(root)), path.resolve(String(p)));
    return rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

/**
 * 是否按"VM 内路径"处理。
 * @param {string} p
 * @param {object} opts { mount?: string, vmRoots?: string[] }
 */
function isVmPath(p, opts = {}) {
  const s = String(p == null ? '' : p);
  if (!s.startsWith('/')) return false;
  const mount = normMount(opts.mount);
  if (s === mount || s.startsWith(mount + '/')) return true;
  for (const vr of Array.isArray(opts.vmRoots) ? opts.vmRoots : []) {
    const v = String(vr || '').replace(/\/+$/, '');
    if (v && (s === v || s.startsWith(v + '/'))) return true;
  }
  for (const pre of VM_SYSTEM_PREFIXES) {
    if (s === pre || s.startsWith(pre + '/')) return true;
  }
  try {
    if (fs.existsSync(s)) return false; // 宿主真实存在的绝对路径 → 宿主路径
  } catch { /* ignore */ }
  return true;
}

/** POSIX 单引号转义（guest 内 bash 用；与 vm-pty.js 的 shellQuote 等价） */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { isVmPath, isUnder, relUnder, normMount, shellQuote, VM_SYSTEM_PREFIXES };
