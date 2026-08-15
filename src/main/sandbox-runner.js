/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 沙箱运行器（借鉴 DeepSeek Harness 的 sandbox seam，自研实现）。
 *
 * 语义与 dsh 对齐：只约束"文件效果"（read-only / workspace-write /
 * danger-full-access），不约束网络/进程。统一契约：
 *
 *   confine(argv, { mode, workspaceRoot, sessionId })
 *     → { argv, enforcement, denialSignatures, runnerFailureRules, backend, confined }
 *
 * 后端：
 *   - macOS : sandbox-exec + 生成的 Seatbelt profile（系统自带）
 *   - Linux : bwrap（若可用）；否则 Landlock 骨架
 *   - Win32 : 受限令牌 ACL 骨架
 *
 * fail-closed：请求受限模式但后端不可用时抛 SANDBOX_UNAVAILABLE，
 * 绝不无沙箱放行（danger-full-access 是显式的透传模式）。
 */

'use strict';

const { spawnSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE';

/**
 * 规范化沙箱策略。
 * mode 缺省/非法时按 danger-full-access 处理（显式透传，不抛错）。
 */
function resolvePolicy(raw = {}) {
  const mode = ['read-only', 'workspace-write', 'danger-full-access'].includes(raw.mode)
    ? raw.mode
    : 'danger-full-access';
  const workspaceRoot = (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.length > 0)
    ? path.resolve(raw.workspaceRoot)
    : null;
  return {
    mode,
    workspaceRoot,
    sessionId: raw.sessionId ?? null
  };
}

/**
 * 探测当前平台可用后端（带缓存，首次探测后不再重复 spawn）。
 * @returns {{backend: string|null, available: boolean, enforcement: string, detail: string}}
 */
let cachedBackend = null;
function detectBackend() {
  if (cachedBackend) return cachedBackend;
  try {
    if (process.platform === 'darwin') {
      const probe = spawnSync('sandbox-exec', ['-p', '(version 1)\n(allow default)\n', '--', '/usr/bin/true'], {
        encoding: 'utf8', timeout: 5000
      });
      const available = probe.error === undefined && probe.status === 0;
      cachedBackend = available
        ? { backend: 'seatbelt', available: true, enforcement: 'full', detail: 'sandbox-exec / Seatbelt' }
        : { backend: 'seatbelt', available: false, enforcement: 'none', detail: 'sandbox-exec 不可用' };
    } else if (process.platform === 'linux') {
      try {
        const p = execFileSync('which', ['bwrap'], { encoding: 'utf8', timeout: 5000 }).trim();
        cachedBackend = p
          ? { backend: 'bwrap', available: true, enforcement: 'full', detail: `bubblewrap: ${p}` }
          : { backend: 'landlock', available: false, enforcement: 'none', detail: 'bwrap 缺失，Landlock 后端未编译' };
      } catch {
        cachedBackend = { backend: 'landlock', available: false, enforcement: 'none', detail: 'bwrap 缺失，Landlock 后端未编译' };
      }
    } else if (process.platform === 'win32') {
      // Windows：cibyp-sandbox.exe（受限令牌 + 低完整性 ACL）。
      // 通过 --self-test 真实校验后端可用（自检含受限子进程读写验证）。
      const wrapper = resolveWrapperPath();
      if (!wrapper) {
        cachedBackend = { backend: 'acl', available: false, enforcement: 'none', detail: 'cibyp-sandbox.exe 未找到（assets/sandbox/win 或 resourcesPath/sandbox）' };
      } else {
        const probe = spawnSync(wrapper, ['--self-test'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        const available = probe.error === undefined && probe.status === 0;
        cachedBackend = available
          ? { backend: 'acl', available: true, enforcement: 'full', detail: 'cibyp-sandbox（受限令牌 + 低完整性 ACL）' }
          : { backend: 'acl', available: false, enforcement: 'none', detail: `cibyp-sandbox 自检失败（code=${probe.status}）` };
      }
    } else {
      cachedBackend = { backend: null, available: false, enforcement: 'none', detail: '未知平台' };
    }
  } catch (e) {
    cachedBackend = { backend: null, available: false, enforcement: 'none', detail: e.message || String(e) };
  }
  return cachedBackend;
}

/** 重置后端探测缓存（测试用） */
function resetBackendCache() {
  cachedBackend = null;
}

/**
 * 定位 Windows 包装器 cibyp-sandbox.exe。
 * dev：仓库 assets/sandbox/win/；
 * packaged（仅 Windows）：electron-builder win.extraResources 带出到
 * process.resourcesPath/sandbox/（macOS/Linux 包不包含该文件）。
 * @returns {string|null}
 */
let cachedWrapperPath = null;
function resolveWrapperPath() {
  if (cachedWrapperPath) return cachedWrapperPath;
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'sandbox', 'cibyp-sandbox.exe'));
  }
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'sandbox', 'win', 'cibyp-sandbox.exe'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        cachedWrapperPath = c;
        return c;
      }
    } catch { /* ignore */ }
  }
  cachedWrapperPath = null;
  return null;
}

/**
 * ACL 后端低标签临时目录路径（wrapper 负责创建/打标签/清理）。
 * 每次调用独立目录，避免并发共享；含随机串防碰撞。
 */
function aclScratchPath(sessionId) {
  const suffix = sessionId ? String(sessionId) : String(process.pid);
  const rnd = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `cibyp-acl-tmp-${suffix}-${rnd}`);
}

/**
 * 生成 macOS Seatbelt profile。
 * 采用 (allow default) + 对写入的 deny 白名单，只约束文件写入（与 dsh 词汇一致）。
 * @param {string} mode 'read-only' | 'workspace-write'
 * @param {string|null} workspaceRoot
 */
function buildSeatbeltProfile(mode, workspaceRoot) {
  const writable = [];
  // 标准输出/终端设备：保持可写（stdout/stderr/tty/ptmx）
  for (const dev of ['/dev/null', '/dev/tty', '/dev/stdout', '/dev/stderr', '/dev/ptmx']) {
    writable.push(`(literal "${dev}")`);
  }
  writable.push('(subpath "/dev/ttys")');
  if (mode === 'workspace-write') {
    if (workspaceRoot) {
      // Seatbelt 按符号链接解析后的真实路径匹配；追加规范化路径及其 /private 前缀变体
      let resolved = workspaceRoot;
      try { resolved = fs.realpathSync(workspaceRoot); } catch { /* 不存在则用原路径 */ }
      const variants = new Set([workspaceRoot, resolved]);
      if (resolved.startsWith('/private/') && !workspaceRoot.startsWith('/private/')) {
        variants.add(resolved.slice('/private'.length));
      } else if (!resolved.startsWith('/private/')) {
        variants.add('/private' + resolved);
      }
      for (const v of variants) writable.push(`(subpath "${v.replace(/"/g, '\\"')}")`);
    }
    let tmp = path.resolve(os.tmpdir());
    try { tmp = fs.realpathSync(tmp); } catch { /* ignore */ }
    writable.push(`(subpath "${tmp.replace(/"/g, '\\"')}")`);
    writable.push(`(subpath "${('/private' + tmp).replace(/"/g, '\\"')}")`);
    writable.push('(subpath "/private/tmp")');
    // macOS 用户级临时目录常位于 /var/folders
    if (tmp.startsWith('/var/folders/')) {
      const base = tmp.split('/').slice(0, 4).join('/');
      if (base) {
        writable.push(`(subpath "${base}")`);
        writable.push(`(subpath "${('/private' + base)}")`);
      }
    }
  }
  const anyRoots = writable.join(' ');
  return [
    '(version 1)',
    '(allow default)',
    // 只拒绝"文件写入"效果：写路径不在白名单内则拒绝。
    // 网络、进程、读取等保持 (allow default)，与 dsh 的"文件效果"词汇一致。
    `(deny file-write* (require-not (require-any ${anyRoots})))`
  ].join('\n');
}

/**
 * 生成 bwrap 包装 argv（Linux）。
 * 只读：根只读绑定 + 空 tmpfs 挂到 /tmp 之外的所有位置不动；
 * 工作区可写：工作区目录与 tmp 可写。
 */
function buildBwrapArgv(argv, policy) {
  const prefix = ['bwrap', '--die-with-parent', '--new-session'];
  prefix.push('--ro-bind', '/', '/');
  if (policy.mode === 'workspace-write') {
    if (policy.workspaceRoot) {
      prefix.push('--bind', policy.workspaceRoot, policy.workspaceRoot);
      prefix.push('--chdir', policy.workspaceRoot);
    }
    prefix.push('--bind', '/tmp', '/tmp');
  }
  // 屏蔽 setuid 提权
  prefix.push('--unshare-all');
  prefix.push('--');
  return [...prefix, ...argv];
}

/**
 * 核心契约：把 argv 包装成受限执行（或透传）。
 *
 * @param {string[]} argv 原始 argv（可执行文件 + 参数）
 * @param {object} raw { mode, workspaceRoot, sessionId }
 * @returns {{argv, enforcement, denialSignatures, runnerFailureRules, backend, confined}}
 * @throws {{code: 'SANDBOX_UNAVAILABLE', message}} 受限模式但后端不可用
 */
function confine(argv, raw) {
  const policy = resolvePolicy(raw);
  if (policy.mode === 'danger-full-access') {
    return {
      argv,
      enforcement: 'none',
      denialSignatures: [],
      runnerFailureRules: [],
      backend: null,
      confined: false
    };
  }
  const backend = detectBackend();
  if (!backend.available) {
    const err = new Error(
      `sandbox mode "${policy.mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined (${backend.detail}).`
    );
    err.code = SANDBOX_UNAVAILABLE;
    throw err;
  }
  if (backend.backend === 'seatbelt') {
    const profile = buildSeatbeltProfile(policy.mode, policy.workspaceRoot);
    return {
      argv: ['sandbox-exec', '-p', profile, '--', ...argv],
      enforcement: backend.enforcement,
      denialSignatures: ['operation not permitted', 'sandbox denied', 'deny file-write'],
      runnerFailureRules: [
        { fatalSignatures: ['sandbox-exec: ', 'sandbox_compile', 'profile syntax error'], informationalLines: [] }
      ],
      backend: backend.backend,
      confined: true
    };
  }
  if (backend.backend === 'bwrap') {
    return {
      argv: buildBwrapArgv(argv, policy),
      enforcement: backend.enforcement,
      denialSignatures: ['read-only file system', 'permission denied'],
      runnerFailureRules: [
        { fatalSignatures: ['bwrap: ', 'No permissions to creating new namespace'], informationalLines: [] }
      ],
      backend: backend.backend,
      confined: true
    };
  }
  if (backend.backend === 'acl') {
    const wrapper = resolveWrapperPath();
    if (!wrapper) {
      const err = new Error('cibyp-sandbox.exe 未找到，无法执行受限模式');
      err.code = SANDBOX_UNAVAILABLE;
      throw err;
    }
    const args = [wrapper, '--mode', policy.mode];
    if (policy.mode === 'workspace-write') {
      if (policy.workspaceRoot) args.push('--workspace', policy.workspaceRoot);
      // 低标签临时目录：子进程 TMP/TEMP 指到可写位置（工作区外仍被 MIC 拒绝）
      args.push('--temp', aclScratchPath(policy.sessionId));
    }
    args.push('--', ...argv);
    return {
      argv: args,
      enforcement: backend.enforcement,
      denialSignatures: ['access is denied', 'permission denied', 'is denied', '拒绝访问'],
      runnerFailureRules: [
        { fatalSignatures: ['cibyp-sandbox: '], informationalLines: [] }
      ],
      backend: backend.backend,
      confined: true
    };
  }
  // landlock：骨架存在但未编译 —— fail-closed（理论不可达，detectBackend 已判定 unavailable）
  const err = new Error(`sandbox backend "${backend.backend}" is not implemented on this host`);
  err.code = SANDBOX_UNAVAILABLE;
  throw err;
}

/**
 * 从 settings 解析某次调用的沙箱策略。
 * @param {object} settings 主进程 settings
 * @param {string} modeName chat|code|babe
 * @param {string|null} workspacePath
 */
function policyForCall(settings = {}, modeName, workspacePath) {
  const sb = settings.sandbox || {};
  const mode = sb.modeOverrides?.[modeName] || sb.defaultMode || 'danger-full-access';
  return { mode, workspaceRoot: workspacePath || null };
}

/** 识别一次失败执行是否是"沙箱拒绝"（供升级审批流使用） */
function isSandboxDenial(confined, stderr = '') {
  if (!confined || typeof stderr !== 'string') return false;
  const text = stderr.toLowerCase();
  return /operation not permitted|read-only file system|sandbox denied|deny file-write|permission denied|access is denied|is denied|拒绝访问/.test(text);
}

module.exports = {
  SANDBOX_UNAVAILABLE,
  resolvePolicy,
  detectBackend,
  resetBackendCache,
  resolveWrapperPath,
  aclScratchPath,
  buildSeatbeltProfile,
  buildBwrapArgv,
  confine,
  policyForCall,
  isSandboxDenial
};
