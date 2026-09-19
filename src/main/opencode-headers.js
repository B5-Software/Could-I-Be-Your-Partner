/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * OpenCode 官方请求头组（借鉴 opencode 开源实现 packages/opencode/src/session/llm/request.ts）：
 * 对 providerID 以 "opencode" 开头的模型，官方客户端总是发送：
 *   x-opencode-session: <会话 ID>          （Go 网关强制要求；自 2026-09 起校验官方 ID 形状）
 *   x-opencode-request: <请求 ID>          （同上，官方形状 msg_<12 hex><14 base62>）
 *   x-opencode-client: <客户端标识>        （官方 TUI 为 "cli"）
 *   x-opencode-project: <项目 ID>
 *   User-Agent: opencode/<version>         （免费模型门控需要 —— 本应用不自动注入，
 *                                           由用户在设置中主动添加，并已告知官方方案与风险）
 * 免费模型的上游（Console 推理池）当前校验客户端身份（2026-09-17 起收紧，实测）：
 *   1. User-Agent 必须形如 opencode/<正式发布版本>（>=1.17.0），版本串不能带 git 后缀；
 *   2. x-opencode-session / x-opencode-request 必须符合官方 ID 形状
 *      （<prefix>_<12 hex><14 base62>，共 26 字符；UUID/任意串会直接 403 FreeTierError）；
 *   3. 匿名 Authorization: Bearer public 目前仍被免费池拒绝，需要已登录的 Zen key。
 * 官方未登录时 Authorization 使用字面量 "public"（provider.ts: options: { apiKey: "public" }）。
 *
 * 同时提供"自定义请求头"通用能力：所有 AI API（文本/VLM/生图等）可配置任意请求头。
 */

'use strict';

const crypto = require('crypto');

// npm 包 opencode-ai 的近期版本；网关只校验 opencode/ 前缀，不校验具体版本。
// 启动时会尝试从 npm registry 拉取最新版本并缓存（refreshOpenCodeVersion）。
const OPENCODE_DEFAULT_VERSION = '1.18.31';
const VERSION_TTL_MS = 24 * 60 * 60 * 1000;

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
 * User-Agent: opencode/<version>
 */
function getOpenCodeUserAgent() {
  return `opencode/${getOpenCodeVersion()}`;
}

/**
 * 启动时异步刷新 OpenCode 版本（非阻塞，失败静默）。
 * 数据源：https://registry.npmjs.org/opencode-ai/latest → .version
 * @param {Function} fetchImpl - 用于请求的 fetch（默认 global fetch，可注入便于测试）
 * @returns {Promise<string|null>} 新版本号或 null（失败/无需更新）
 */
async function refreshOpenCodeVersion(fetchImpl) {
  if (_versionState.refreshing) return _versionState.refreshing;
  _versionState.refreshing = (async () => {
    try {
      // 预热缓存
      if (_versionState.version === null && _versionState.loadFn) {
        try {
          const cached = await _versionState.loadFn();
          if (cached && cached.version) {
            _versionState.version = cached.version;
            _versionState.fetchedAt = cached.fetchedAt || 0;
          }
        } catch { /* ignore */ }
      }
      const now = Date.now();
      if (_versionState.version && now - _versionState.fetchedAt < VERSION_TTL_MS) {
        return null; // 缓存仍新鲜
      }
      const f = fetchImpl || globalThis.fetch;
      if (typeof f !== 'function') return null;
      const resp = await f('https://registry.npmjs.org/opencode-ai/latest', {
        signal: AbortSignal.timeout(10000)
      });
      if (!resp || !resp.ok) return null;
      const data = await resp.json();
      const version = typeof data?.version === 'string' ? data.version.trim() : '';
      if (!version || !/^[\w.\-+]+$/.test(version)) return null;
      _versionState.version = version;
      _versionState.fetchedAt = now;
      if (_versionState.saveFn) {
        try { await _versionState.saveFn(version, now); } catch { /* ignore */ }
      }
      return version;
    } catch {
      return null; // 离线/网络失败：静默保留默认或上次缓存
    } finally {
      _versionState.refreshing = null;
    }
  })();
  return _versionState.refreshing;
}

// ---- URL 识别 ----

/**
 * URL 是否指向 opencode.ai（Zen / Zen Go 网关）。
 */
function isOpenCodeUrl(url) {
  try {
    const u = new URL(String(url));
    return /(^|\.)opencode\.ai$/i.test(u.hostname);
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
  return { ...baseHeaders, ...headers };
}

// ---- OpenCode 官方头组 ----

// 稳定项目 ID（官方使用 instance context 的 project.id；对非 opencode CLI 客户端
// 使用 kode-ai 兼容实现的默认值 "global"，网关不解析该值）。
const OPENCODE_PROJECT_ID = 'global';
// 客户端标识：与官方默认一致（request.ts 使用 flags.client，TUI 为 "cli"；
// 免费池身份校验会读取该头）。
const OPENCODE_CLIENT_ID = 'cli';

// 官方 ID 形状（packages/opencode/src/id/id.ts）：<prefix>_<12 hex><14 base62>，共 26 字符。
// 免费池网关自 2026-09 起按此形状校验 x-opencode-session / x-opencode-request，
// 形状不符（UUID / 任意串）会直接 403 FreeTierError。
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
 * 同一 sessionKey 恒定映射同一值（跨请求稳定 → 提示词缓存/路由亲和）；
 * 已是官方形状的原样保留。
 * @param {string} [sessionKey]
 * @returns {string}
 */
function canonicalizeSessionId(sessionKey) {
  const raw = String(sessionKey || '').trim();
  if (OPENCODE_SESSION_RE.test(raw)) return raw;
  // sha256 确定性派生：前 12 位 hex + 后 14 位 base62，无需持久化
  const digest = crypto.createHash('sha256')
    .update(`opencode\0cibyp\0${raw || 'default'}`)
    .digest();
  let tail = digest.subarray(0, 6).toString('hex');
  for (let i = 6; i < 20; i++) tail += BASE62_CHARS[digest[i] % 62];
  return `ses_${tail}`;
}

/**
 * 生成官方形状的 x-opencode-request：msg_<12 hex 时间戳><14 base62>（每次调用唯一）。
 */
function makeRequestId() {
  const now = BigInt(Date.now()) * 0x1000n + BigInt(Math.floor(Math.random() * 0x1000));
  const tb = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) tb[i] = Number((now >> BigInt(40 - 8 * i)) & 0xffn);
  return `msg_${tb.toString('hex')}${randomBase62(14)}`;
}

/**
 * 构建 OpenCode 官方头组（仅补齐缺失项，不覆盖已有值）。
 * 注意：不含 User-Agent —— 免费模型的 UA 门控头由用户在设置中主动添加
 * （UI 会告知官方方案与风险，用户自行决定），本应用不代填。
 * @param {object} opts - { sessionKey?, requestId? }
 * @returns {object} 需要附加的头
 */
function buildOpenCodeHeaders(opts = {}) {
  const requestId = String(opts.requestId || '').trim();
  return {
    'x-opencode-session': canonicalizeSessionId(opts.sessionKey),
    'x-opencode-request': OPENCODE_REQUEST_RE.test(requestId) ? requestId : makeRequestId(),
    'x-opencode-client': OPENCODE_CLIENT_ID,
    'x-opencode-project': OPENCODE_PROJECT_ID
  };
}

/**
 * 统一的请求头应用入口（所有 LLM/VLM builder 与生图共用）：
 *   1. 自动头：URL 命中 opencode.ai 且 llm.autoOpencodeHeaders !== false 时，
 *      补齐官方头组（不含 User-Agent；Authorization 缺失时回退 "public"）；
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
      if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
    }
    // Authorization 兜底：官方未登录时使用字面量 "public"（provider.ts）。
    // 注意：public 目前仅能拉模型列表（GET /zen/v1/models 返回 200），
    // 推理请求会被免费池拒绝（403 FreeTierError），需已登录的 Zen key。
    const hasAuth = Object.keys(out).some(k => k.toLowerCase() === 'authorization');
    if (!hasAuth) out['Authorization'] = 'Bearer public';
  }
  const custom = normalizeHeaderList(llmCfg.customHeaders);
  return { ...out, ...custom.headers };
}

module.exports = {
  OPENCODE_DEFAULT_VERSION,
  OPENCODE_PROJECT_ID,
  OPENCODE_CLIENT_ID,
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  setOpenCodeVersionStore,
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
