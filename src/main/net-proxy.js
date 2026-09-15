/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 主进程网络代理：
 * Electron session.setProxy 只影响渲染进程/Chromium 栈；主进程的 Node fetch
 * （undici）不走 Electron 代理。本模块用 undici ProxyAgent（7.28+，原生支持
 * HTTP/HTTPS/SOCKS5）为所有主进程 fetch 注入 dispatcher，使 settings.proxy
 * 对 AI 请求、web:fetch、net:* 工具、模型列表、生图等真正生效。
 *
 * 同时：
 *  - system 模式通过 session.resolveProxy 解析 OS/PAC 代理并缓存；
 *  - 向子进程（npm/curl/MCP/终端/插件）注入 HTTP_PROXY/HTTPS_PROXY/NO_PROXY；
 *  - 对外暴露 getProxyUrlForUrl/getResolvedSystemProxyUrl 供 aria2/SMTP/Playwright 使用。
 */

'use strict';

const net = require('net');

let undici = null;
try { undici = require('undici'); } catch { /* undici 缺失时退化为直连 */ }

// 当前代理配置 { mode: 'none'|'system'|'manual', http, https, bypass }
let _config = null;
// 系统代理解析缓存: origin -> { value, at }
const _sysCache = new Map();
const SYS_CACHE_TTL = 60 * 1000;
// 最近的系统代理解析结果（代表性 URL），供 aria2/env/SMTP 同步读取
let _resolvedSystemProxyUrl = null;
// 归一化代理 URL -> undici dispatcher 实例缓存
const _agentCache = new Map();
// fetch 是否已包装
let _installed = false;

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i;

// ---- 测试钩子 ----
const _test = { parsePacResult, normalizeProxyUrl, isBypassed, matchBypassEntry, getAgent, resetForTest };

function resetForTest() {
  _config = null;
  _sysCache.clear();
  _resolvedSystemProxyUrl = null;
  _agentCache.clear();
}

// ---- 归一化 ----

/**
 * 归一化用户填写的代理地址：
 *   "127.0.0.1:7890" → "http://127.0.0.1:7890"
 *   "socks5://127.0.0.1:7890" 保持
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeProxyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^socks[45h]?:\/\//i.test(s)) return s;
  if (/^socks/i.test(s)) return 'socks5://' + s.replace(/^socks[45h]?:\/\//i, '');
  return 'http://' + s;
}

/**
 * 解析 session.resolveProxy 返回的 PAC 风格串，取首个可用代理。
 * 形如 "PROXY 127.0.0.1:7890" / "SOCKS5 127.0.0.1:1080;PROXY ..." / "DIRECT"
 * @returns {string|null} http://... 或 socks5://...
 */
function parsePacResult(pac) {
  if (!pac || typeof pac !== 'string') return null;
  for (const entryRaw of pac.split(';')) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const m = /^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+(\S+)$/i.exec(entry);
    if (!m) continue;
    const scheme = m[1].toUpperCase();
    const host = m[2];
    if (/^SOCKS4$/i.test(scheme)) return 'socks4://' + host;
    if (/^SOCKS5?$/i.test(scheme)) return 'socks5://' + host;
    // PROXY / HTTPS → HTTP CONNECT 代理
    if (!/^https?:\/\//i.test(host)) return 'http://' + host;
    return host;
  }
  return null;
}

// ---- bypass ----

/**
 * 单条 bypass 规则是否匹配主机名。
 * 支持：精确域名、"*.example.com"、".example.com" 后缀、IP/CIDR(前缀数字省略)、"<local>"。
 */
function matchBypassEntry(rule, hostname) {
  const r = String(rule || '').trim().toLowerCase();
  if (!r) return false;
  const h = String(hostname || '').toLowerCase();
  if (r === '<local>') {
    return !h.includes('.') || h.endsWith('.local');
  }
  if (r.startsWith('*.')) {
    const suffix = r.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === r.slice(2);
  }
  if (r.startsWith('.')) {
    return h.endsWith(r) || h === r.slice(1);
  }
  // CIDR 简化：仅当规则为 IP/前缀数字形式且主机是 IP 字面量时按 CIDR 匹配
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(r) && net.isIP(h)) {
    const [base, bitsRaw] = r.split('/');
    const bits = bitsRaw === undefined ? 32 : parseInt(bitsRaw, 10);
    return ipInCidr(h, base, bits);
  }
  // 精确匹配或子域匹配（chromium 语义：foobar.com 匹配 foobar.com 及其子域？）
  // Chromium bypass 规则中裸 hostname 匹配该主机及所有子域。
  return h === r || h.endsWith('.' + r);
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) & 0xff), 0) >>> 0;
}

function ipInCidr(ip, base, bits) {
  if (bits <= 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
}

/**
 * 目标 URL 是否应绕过代理（始终绕过 loopback + 用户 bypass 列表）。
 */
function isBypassed(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return false; }
  const proto = (u.protocol || '').toLowerCase();
  // 非 http(s) 目标（file:/ws 由各栈自行处理）
  if (proto && proto !== 'http:' && proto !== 'https:' && proto !== 'ws:' && proto !== 'wss:') return true;
  const host = u.hostname || '';
  if (LOOPBACK_RE.test(host)) return true;
  const list = String(_config?.bypass || '');
  if (!list.trim()) return false;
  for (const entry of list.split(/[,;\s]+/)) {
    if (entry && matchBypassEntry(entry, host)) return true;
  }
  return false;
}

// ---- dispatcher ----

/**
 * 归一化代理 URL →（缓存的）undici dispatcher。
 */
function getAgent(proxyUrl) {
  const key = String(proxyUrl || '').trim();
  if (!key) return undefined;
  if (_agentCache.has(key)) return _agentCache.get(key);
  let agent;
  try {
    agent = new undici.ProxyAgent(key);
  } catch (e) {
    console.warn('[Proxy] 创建代理 dispatcher 失败:', key, e.message);
    agent = undefined;
  }
  if (agent) _agentCache.set(key, agent);
  return agent;
}

/**
 * 手动模式：按目标协议选择代理（https 目标优先 https 字段）。
 */
function manualProxyFor(urlStr) {
  let isHttps = false;
  try { isHttps = new URL(urlStr).protocol === 'https:'; } catch { /* ignore */ }
  const primary = isHttps ? (_config.https || _config.http) : (_config.http || _config.https);
  return normalizeProxyUrl(primary);
}

/**
 * system 模式：解析目标 URL 的代理（session.resolveProxy，按 origin 缓存）。
 */
async function systemProxyFor(urlStr) {
  let origin;
  try { origin = new URL(urlStr).origin; } catch { return null; }
  const hit = _sysCache.get(origin);
  if (hit && Date.now() - hit.at < SYS_CACHE_TTL) return hit.value;
  let pac = null;
  try {
    const { session } = require('electron');
    if (session?.defaultSession?.resolveProxy) {
      pac = await session.defaultSession.resolveProxy(urlStr);
    }
  } catch { /* electron 不可用（测试环境） */ }
  const value = parsePacResult(pac);
  _sysCache.set(origin, { value, at: Date.now() });
  if (value) {
    _resolvedSystemProxyUrl = value;
  }
  return value;
}

/**
 * 为目标 URL 解析 dispatcher（bypass/none → undefined 直连）。
 */
async function getDispatcher(urlStr) {
  if (!_config || _config.mode === 'none') return undefined;
  if (isBypassed(urlStr)) return undefined;
  let proxyUrl = null;
  if (_config.mode === 'manual') {
    proxyUrl = manualProxyFor(urlStr);
  } else if (_config.mode === 'system') {
    proxyUrl = await systemProxyFor(urlStr);
  }
  if (!proxyUrl) return undefined;
  return getAgent(proxyUrl);
}

/**
 * 同步获取当前已解析的系统代理（可能为 null）。
 */
function getResolvedSystemProxyUrl() {
  return _resolvedSystemProxyUrl;
}

/**
 * 异步获取目标 URL 应使用的代理 URL（供 aria2/SMTP/Playwright 复用）。
 * @returns {Promise<string|null>}
 */
async function getProxyUrlForUrl(urlStr) {
  if (!_config || _config.mode === 'none') return null;
  if (isBypassed(urlStr)) return null;
  if (_config.mode === 'manual') return manualProxyFor(urlStr);
  if (_config.mode === 'system') return await systemProxyFor(urlStr);
  return null;
}

// ---- 全局 fetch 包装 ----

/**
 * 安装全局 fetch 代理包装（幂等）。
 * 之后主进程所有 fetch(url) 自动按 settings.proxy 选择 dispatcher。
 */
function install() {
  if (_installed) return;
  _installed = true;
  if (!undici || typeof undici.fetch !== 'function') {
    console.warn('[Proxy] undici 不可用，主进程 fetch 代理包装未启用');
    return;
  }
  const undiciFetch = undici.fetch.bind(undici);
  const wrapped = async (input, init = {}) => {
    let target = null;
    if (typeof input === 'string') target = input;
    else if (input && typeof input.url === 'string') target = input.url;
    else if (input instanceof URL) target = input.href;
    let dispatcher;
    try {
      dispatcher = target ? await getDispatcher(target) : undefined;
    } catch { dispatcher = undefined; }
    if (dispatcher) {
      return undiciFetch(input, { ...init, dispatcher: init?.dispatcher || dispatcher });
    }
    // 未启用代理：仍统一走 undici fetch（保证行为一致）
    return undiciFetch(input, init);
  };
  // 保持原属性（便于诊断与避免误判）
  try {
    Object.defineProperty(wrapped, 'name', { value: 'proxiedFetch' });
    wrapped.__cibypProxiedFetch = true;
  } catch { /* ignore */ }
  globalThis.fetch = wrapped;
  console.log('[Proxy] 主进程 fetch 代理包装已启用（undici dispatcher）');
}

/**
 * 包装是否已安装。
 */
function isInstalled() {
  return _installed;
}

// ---- 环境变量（子进程继承） ----

/**
 * 按当前代理配置设置/清除子进程可继承的代理环境变量。
 * manual → 用户值；system → 最近一次解析结果（如有）；none → 清除。
 */
function applyEnv() {
  const keys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const clear = () => { for (const k of keys) delete process.env[k]; };
  if (!_config || _config.mode === 'none') { clear(); return; }

  let proxyUrl = null;
  if (_config.mode === 'manual') {
    proxyUrl = normalizeProxyUrl(_config.https || _config.http);
  } else if (_config.mode === 'system') {
    proxyUrl = _resolvedSystemProxyUrl || null;
  }
  if (!proxyUrl) { clear(); return; }
  // undici/aria2 用 socks5://；npm/curl 也接受 socks5://（npm ≥6 支持 socks 代理）
  process.env.HTTP_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.https_proxy = proxyUrl;
  const noProxy = ['localhost', '127.0.0.1', '::1'];
  const bypass = String(_config.bypass || '').split(/[,;\s]+/).filter(Boolean);
  process.env.NO_PROXY = [...noProxy, ...bypass].join(',');
  process.env.no_proxy = process.env.NO_PROXY;
}

// ---- 配置应用 ----

/**
 * 应用代理配置（由 applyProxySettings 调用）。
 * 清空缓存与 agent 池（旧连接由 GC/服务器超时回收）。
 * @param {object} proxy - settings.proxy
 * @param {object} [hooks] - { onSystemResolved?: Function }
 */
async function setConfig(proxy, hooks = {}) {
  _config = {
    mode: proxy?.mode || 'system',
    http: proxy?.http || '',
    https: proxy?.https || '',
    bypass: proxy?.bypass || 'localhost,127.0.0.1'
  };
  _sysCache.clear();
  _agentCache.clear();
  _resolvedSystemProxyUrl = null;
  // 预解析一次代表性 URL，填充 _resolvedSystemProxyUrl（供 env/aria2/SMTP 同步读取）
  if (_config.mode === 'system') {
    try {
      const resolved = await getProxyUrlForUrl('https://opencode.ai/');
      if (hooks.onSystemResolved) hooks.onSystemResolved(resolved);
    } catch { /* ignore */ }
  } else if (_config.mode === 'manual') {
    _resolvedSystemProxyUrl = normalizeProxyUrl(_config.https || _config.http);
  }
  applyEnv();
}

module.exports = {
  install,
  isInstalled,
  setConfig,
  getDispatcher,
  getProxyUrlForUrl,
  getResolvedSystemProxyUrl,
  normalizeProxyUrl,
  applyEnv,
  _test
};
