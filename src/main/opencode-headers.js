/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * OpenCode v2 compatibility, verified against upstream e89206d (2026-10-16).
 * Native UA: opencode/latest/<version>/cli. Session IDs use the descending
 * timestamp/counter format from packages/schema/src/identifier.ts, not hash-shaped IDs.
 * Keep the session and affinity headers consistent; persist per-conversation IDs
 * to retain cache affinity across GUI, TUI, WebUI and backend restarts.
 * Free models alone receive the v2 core tool profile in llm-providers.js.
 *
 * 同时提供"自定义请求头"通用能力：所有 AI API（文本/VLM/生图等）可配置任意请求头。
 */

'use strict';

const crypto = require('crypto');

// Current official v2 package; opencode-ai is the separate legacy v1 release line.
// 启动时会尝试从 npm registry 拉取最新版本并缓存（refreshOpenCodeVersion）。
const OPENCODE_DEFAULT_VERSION = '2.0.30';
const VERSION_TTL_MS = 24 * 60 * 60 * 1000;
const validVersion = value => typeof value === 'string' && /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) && Number(value.split('.')[0]) >= 2;
const sessionIds = new Map();
let sessionFile = null;
const MAX_SESSION_IDS = 2000;
let lastTimestamp = 0, idCounter = 0;

// This cache contains only hashed local keys and public routing IDs, never credentials.
function setOpenCodeSessionStore(file) {
  if (sessionFile === file) return;
  sessionFile = file || null;
  sessionIds.clear();
  if (!sessionFile) return;
  try {
    const entries = JSON.parse(require('node:fs').readFileSync(sessionFile, 'utf8'));
    if (Array.isArray(entries)) for (const [key, value] of entries.slice(-MAX_SESSION_IDS)) {
      if (/^[a-f0-9]{64}$/.test(key) && OPENCODE_SESSION_RE.test(value)) sessionIds.set(key, value);
    }
  } catch { /* First run or invalid cache: generate fresh IDs. */ }
}
function persistSessionIds() {
  if (!sessionFile) return;
  try {
    const fs = require('node:fs');
    fs.mkdirSync(require('node:path').dirname(sessionFile), { recursive: true, mode: 0o700 });
    const temporary = sessionFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify([...sessionIds]), { mode: 0o600 });
    fs.renameSync(temporary, sessionFile);
  } catch { /* A read-only profile must not prevent requests. */ }
}
function timestampId(descending) {
  const now = Date.now();
  if (now !== lastTimestamp) { lastTimestamp = now; idCounter = 0; }
  const current = BigInt(now) * 0x1000n + BigInt(++idCounter);
  const value = descending ? ~current : current;
  return (value & 0xffffffffffffn).toString(16).padStart(12, '0') + randomBase62(14);
}

// 版本缓存（由 main.js 注入 settings 读写器，避免本模块反向依赖主进程状态）
const _versionState = {
  version: null,          // 当前生效版本（缓存值或默认值）
  fetchedAt: 0,
  refreshing: null,       // 进行中的刷新 Promise（防并发）
  loadFn: null,           // async () => ({ version, fetchedAt })
  saveFn: null            // async (version, fetchedAt) => void
};

/**
 * 注入版本缓存读写器（main.js 启动时调用一次）。
 * @param {{ loadFn?: Function, saveFn?: Function }} hooks
 */
function setOpenCodeVersionStore(hooks) {
  if (hooks && typeof hooks.loadFn === 'function') _versionState.loadFn = hooks.loadFn;
  if (hooks && typeof hooks.saveFn === 'function') _versionState.saveFn = hooks.saveFn;
}

/**
 * 当前生效的 UA 版本号（缓存值 → 默认值）。
 */
function getOpenCodeVersion() {
  return _versionState.version || OPENCODE_DEFAULT_VERSION;
}

/**
 * User-Agent: opencode/latest/<version>/cli
 */
function getOpenCodeUserAgent() {
  return `opencode/latest/${getOpenCodeVersion()}/cli`;
}

/**
 * 启动时异步刷新 OpenCode 版本（非阻塞，失败静默）。
 * 数据源：https://registry.npmjs.org/@opencode%2fcli/latest → .version
 * @param {Function} fetchImpl - 用于请求的 fetch（默认 global fetch，可注入便于测试）
 * @returns {Promise<string|null>} 新版本号或 null（失败/无需更新）
 */
async function refreshOpenCodeVersion(fetchImpl, options = {}) {
  if (_versionState.refreshing) return _versionState.refreshing;
  const pending = (async () => {
    try {
      // 预热缓存
      if (_versionState.version === null && _versionState.loadFn) {
        try {
          const cached = await _versionState.loadFn();
          if (cached && validVersion(cached.version)) {
            _versionState.version = cached.version;
            _versionState.fetchedAt = cached.fetchedAt || 0;
          }
        } catch { /* ignore */ }
      }
      const now = Date.now();
      if (!options.force && _versionState.version && now - _versionState.fetchedAt < VERSION_TTL_MS) {
        return null; // 缓存仍新鲜
      }
      const f = fetchImpl || globalThis.fetch;
      if (typeof f !== 'function') return null;
      const resp = await f('https://registry.npmjs.org/@opencode%2fcli/latest', {
        signal: AbortSignal.timeout(10000)
      });
      if (!resp || !resp.ok) return null;
      const data = await resp.json();
      const version = typeof data?.version === 'string' ? data.version.trim() : '';
      if (!validVersion(version)) return null;
      _versionState.version = version;
      _versionState.fetchedAt = now;
      if (_versionState.saveFn) {
        try { await _versionState.saveFn(version, now); } catch { /* ignore */ }
      }
      return version;
    } catch {
      return null; // 离线/网络失败：静默保留默认或上次缓存
    }
  })();
  _versionState.refreshing = pending;
  try { return await pending; }
  finally { if (_versionState.refreshing === pending) _versionState.refreshing = null; }
}

// ---- URL 识别 ----

/**
 * URL 是否指向 opencode.ai（Zen / Zen Go 网关）。
 */
function isOpenCodeUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && /(^|\.)opencode\.ai$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * URL 是否为 OpenCode Go 端点（/zen/go/）。
 */
function isOpenCodeGoUrl(url) {
  return isOpenCodeUrl(url) && /\/zen\/go(\/|$)/i.test(String(url));
}

// ---- 自定义请求头 ----

/**
 * 规范化自定义头列表：支持 [{name,value,enabled}]（存储格式）。
 * 返回 { headers: {name:value}, errors: string[] }（重复名后者覆盖，空名跳过）。
 * @param {Array<{name:string,value:string,enabled?:boolean}>|object|null} list
 */
function normalizeHeaderList(list) {
  const headers = {};
  const errors = [];
  if (Array.isArray(list)) {
    const seen = new Map(); // lower-case name → 保留首次出现的原始大小写
    for (const item of list) {
      const rawName = String(item?.name || '').trim();
      if (!rawName) continue;
      if (!/^[!-~]+$/.test(rawName)) { errors.push(`非法请求头名称: ${rawName}`); continue; }
      const lower = rawName.toLowerCase();
      if (seen.has(lower)) errors.push(`重复请求头(后者覆盖): ${rawName}`);
      else seen.set(lower, rawName);
      if (item?.enabled === false) continue;
      // HTTP 头大小写不敏感：重复名统一写入首次出现的原始大小写键，后者覆盖
      headers[seen.get(lower) || rawName] = String(item?.value ?? '');
    }
  } else if (list && typeof list === 'object') {
    for (const [name, value] of Object.entries(list)) {
      const n = String(name || '').trim();
      if (!n || !/^[!-~]+$/.test(n)) continue;
      headers[n] = String(value ?? '');
    }
  }
  return { headers, errors };
}

/**
 * 将自定义头合并进基础头（用户配置优先级最高，可覆盖自动头）。
 */
function mergeCustomHeaders(baseHeaders, list) {
  const { headers } = normalizeHeaderList(list);
  const result = { ...baseHeaders };
  for (const [name, value] of Object.entries(headers)) {
    for (const previous of Object.keys(result)) {
      if (previous.toLowerCase() === name.toLowerCase()) delete result[previous];
    }
    result[name] = value;
  }
  return result;
}

// ---- OpenCode 官方头组 ----

// The global project is valid for requests without a specific Git project.
const OPENCODE_PROJECT_ID = 'global';
// 客户端标识：与官方默认一致（request.ts 使用 flags.client，TUI 为 "cli"；
// 免费池身份校验会读取该头）。
const OPENCODE_CLIENT_ID = 'cli';

// 官方 ID 形状（packages/opencode/src/id/id.ts）：<prefix>_<12 hex><14 base62>，共 26 字符。
// v2 also validates the native session timestamp bytes.
// A valid shape alone is insufficient: session time bytes must use the native descending order.
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * 生成 n 位 base62 随机串（官方 randomBase62 同款字符集）。
 */
function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

/**
 * 把任意会话标识规范化为官方会话 ID 形状：ses_<12 hex><14 base62>。
 * 同一 sessionKey 使用持久化的时间戳 ID（跨请求及重启稳定 → 缓存亲和）；
 * 已是官方形状的原样保留。
 * @param {string} [sessionKey]
 * @returns {string}
 */
function canonicalizeSessionId(sessionKey) {
  const raw = String(sessionKey || '').trim();
  if (OPENCODE_SESSION_RE.test(raw)) return raw;
  const key = crypto.createHash('sha256').update(raw || 'default').digest('hex');
  if (sessionIds.has(key)) return sessionIds.get(key);
  const id = 'ses_' + timestampId(true);
  sessionIds.set(key, id);
  while (sessionIds.size > MAX_SESSION_IDS) sessionIds.delete(sessionIds.keys().next().value);
  persistSessionIds();
  return id;
}

/**
 * 生成官方形状的 x-opencode-request：msg_<12 hex 时间戳><14 base62>（每次调用唯一）。
 */
function makeRequestId() {
  return 'msg_' + timestampId(false);
}

/**
 * 构建 OpenCode 官方头组（仅补齐缺失项，不覆盖已有值）。
 * 自动提供 User-Agent；自定义请求头优先。
 * @param {object} opts - { sessionKey?, requestId? }
 * @returns {object} 需要附加的头
 */
function buildOpenCodeHeaders(opts = {}) {
  const requestId = String(opts.requestId || '').trim();
  const sessionId = canonicalizeSessionId(opts.sessionKey);
  return {
    'User-Agent': getOpenCodeUserAgent(),
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-request': OPENCODE_REQUEST_RE.test(requestId) ? requestId : makeRequestId(),
    'x-opencode-client': OPENCODE_CLIENT_ID,
    'x-opencode-project': OPENCODE_PROJECT_ID
  };
}

/**
 * 统一的请求头应用入口（所有 LLM/VLM builder 与生图共用）：
 *   1. 自动头：URL 命中 opencode.ai 且 llm.autoOpencodeHeaders !== false 时，
 *      补齐 SessionID、UA 等头（Authorization 缺失时回退 "public"）；
 *   2. 自定义头：用户配置最后合并（含用户主动添加的免费模型 UA），优先级最高。
 * @param {object} p - { url, headers, llm, sessionKey, requestId }
 * @returns {object} 最终 headers
 */
function applyProviderHeaders({ url, headers, llm, sessionKey, requestId }) {
  let out = { ...(headers || {}) };
  const llmCfg = llm || {};
  if (isOpenCodeUrl(url) && llmCfg.autoOpencodeHeaders !== false) {
    const auto = buildOpenCodeHeaders({ sessionKey, requestId });
    for (const [k, v] of Object.entries(auto)) {
      const existing = Object.keys(out).find((name) => name.toLowerCase() === k.toLowerCase());
      if (!existing || out[existing] == null || out[existing] === '') out[existing || k] = v;
    }
    // Authorization 兜底：官方未登录时使用字面量 "public"（provider.ts）。
    // New inference treats anonymous requests as keyless; never send a fake public API key there.
    const hasAuth = Object.keys(out).some(k => k.toLowerCase() === 'authorization');
    if (!hasAuth && !new URL(url).pathname.startsWith('/inference/')) out['Authorization'] = 'Bearer public';
  }
  return mergeCustomHeaders(out, llmCfg.customHeaders);
}

module.exports = {
  OPENCODE_DEFAULT_VERSION,
  OPENCODE_PROJECT_ID,
  OPENCODE_CLIENT_ID,
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  setOpenCodeVersionStore,
  setOpenCodeSessionStore,
  getOpenCodeVersion,
  getOpenCodeUserAgent,
  refreshOpenCodeVersion,
  isOpenCodeUrl,
  isOpenCodeGoUrl,
  normalizeHeaderList,
  mergeCustomHeaders,
  randomBase62,
  canonicalizeSessionId,
  makeRequestId,
  buildOpenCodeHeaders,
  applyProviderHeaders
};
