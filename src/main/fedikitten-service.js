/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * FediKitten service: Mastodon-compatible social network client.
 * Login via OAuth password grant, then call the REST API with a Bearer token.
 * Token is persisted in settings.fedikitten.active to keep the login state.
 */

const fs = require('fs');
const path = require('path');

const REQUEST_TIMEOUT = 15000;
const MEDIA_TIMEOUT = 60000;
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
const MAX_MEDIA_PER_POST = 4;

function uploadTimeoutFor(bytes) {
  // 按文件大小动态超时：每 MB 30s，下限 60s，上限 5 分钟
  const secs = Math.ceil(bytes / (1024 * 1024)) * 30;
  return Math.max(MEDIA_TIMEOUT, Math.min(secs * 1000, 300000));
}

const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

let fileTypeModule = null;
async function detectMime(filePath) {
  try {
    if (!fileTypeModule) fileTypeModule = await import('file-type');
    const ft = await fileTypeModule.fileTypeFromFile(filePath);
    if (ft && ft.mime) return ft.mime;
  } catch (e) {
    // fall through to extension mapping
  }
  return EXT_MIME[path.extname(filePath).toLowerCase()] || '';
}

let proxyAgentModule = null;
function getProxyAgentClass() {
  if (proxyAgentModule) return proxyAgentModule;
  try {
    proxyAgentModule = require('undici').ProxyAgent;
  } catch (e) {
    proxyAgentModule = null;
  }
  return proxyAgentModule;
}

// 解析代理配置为 undici ProxyAgent URL；返回 null 表示直连
function resolveProxyUrl(proxy) {
  if (!proxy || proxy.mode === 'none') return null;
  if (proxy.mode === 'manual') {
    const proxyUrl = proxy.https || proxy.http;
    if (!proxyUrl) return null;
    if (/^(https?|socks5?):\/\//i.test(proxyUrl)) return proxyUrl;
    return 'http://' + proxyUrl;
  }
  if (proxy.mode === 'system') {
    // 优先环境变量（ClashX/Surge 等代理软件常设置）
    const envUrl = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy;
    if (envUrl) return envUrl;
  }
  return null;
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('实例地址不能为空');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!u.hostname) throw new Error('invalid');
    return url.replace(/\/+$/, '');
  } catch (e) {
    throw new Error(`实例地址无效: ${raw}`);
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function compactText(html, maxLen) {
  const text = stripHtml(html);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function compactAccount(acct) {
  if (!acct) return null;
  return {
    id: acct.id,
    acct: acct.acct,
    username: acct.username,
    display_name: acct.display_name || acct.username,
    url: acct.url,
    avatar: acct.avatar,
    followers_count: acct.followers_count,
    following_count: acct.following_count,
    statuses_count: acct.statuses_count,
    note: compactText(acct.note, 200),
  };
}

function compactMedia(m) {
  if (!m) return null;
  return {
    id: m.id,
    type: m.type || 'unknown',
    url: m.url || m.remote_url,
    preview_url: m.preview_url || m.url || m.remote_url,
    description: m.description || null,
  };
}

function compactStatus(s) {
  if (!s) return null;
  return {
    id: s.id,
    created_at: s.created_at,
    account: compactAccount(s.account),
    content: compactText(s.content, 500),
    spoiler_text: s.spoiler_text || '',
    visibility: s.visibility,
    sensitive: !!s.sensitive,
    media_count: Array.isArray(s.media_attachments) ? s.media_attachments.length : 0,
    media: Array.isArray(s.media_attachments) ? s.media_attachments.map(compactMedia) : [],
    reblogs_count: s.reblogs_count || 0,
    favourites_count: s.favourites_count || 0,
    replies_count: s.replies_count || 0,
    reblogged: !!s.reblogged,
    favourited: !!s.favourited,
    in_reply_to_id: s.in_reply_to_id || null,
    url: s.url,
  };
}

class FediKittenService {
  constructor() {
    this.active = null; // { url, username, accessToken }
    this.clients = {};  // { [url]: { clientId, clientSecret } }
    this.dispatcher = null; // undici ProxyAgent（代理配置生效时）
  }

  // 应用代理配置：manual/system 解析出代理 URL 并创建 undici ProxyAgent
  _applyProxy(proxy) {
    try {
      if (this.dispatcher && typeof this.dispatcher.close === 'function') {
        this.dispatcher.close();
      }
    } catch (e) { /* ignore */ }
    this.dispatcher = null;
    const proxyUrl = resolveProxyUrl(proxy);
    if (!proxyUrl) return;
    const ProxyAgent = getProxyAgentClass();
    if (!ProxyAgent) return;
    try {
      this.dispatcher = new ProxyAgent(proxyUrl);
    } catch (e) {
      this.dispatcher = null;
    }
  }

  // 异步刷新代理（system 模式可走 Electron session 解析，登录前调用确保生效）
  async refreshProxy(proxy) {
    this._applyProxy(proxy);
    if (proxy && proxy.mode === 'system' && !this.dispatcher) {
      try {
        const { session } = require('electron');
        const url = (this.active && this.active.url) || 'https://example.com';
        const resolved = await session.defaultSession.resolveProxy(url);
        const m = String(resolved || '').match(/(SOCKS5?|PROXY|HTTPS)\s+([^\s;]+)/i);
        if (m) {
          const host = m[2];
          const proto = m[1].toUpperCase() === 'SOCKS5' ? 'socks5://' : (m[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://');
          const ProxyAgent = getProxyAgentClass();
          if (ProxyAgent) {
            try { this.dispatcher = new ProxyAgent(proto + host); } catch (e) { this.dispatcher = null; }
          }
        }
      } catch (e) { /* 解析失败则保持直连 */ }
    }
  }

  _requestOptions(extra = {}) {
    const opts = { ...extra };
    if (this.dispatcher) opts.dispatcher = this.dispatcher;
    return opts;
  }

  configure(fedikittenSettings, proxySettings) {
    this.clients = {};
    this._applyProxy(proxySettings);
    const cfg = fedikittenSettings || {};
    const clients = cfg.clients || {};
    for (const url of Object.keys(clients)) {
      const cl = clients[url] || {};
      if (cl.clientId && cl.clientSecret) {
        this.clients[url] = { clientId: String(cl.clientId), clientSecret: String(cl.clientSecret) };
      }
    }
    const active = cfg.active || {};
    if (active.url && active.accessToken) {
      try {
        this.active = {
          url: normalizeBaseUrl(active.url),
          username: String(active.username || ''),
          accessToken: String(active.accessToken || ''),
        };
        return;
      } catch (e) {
        // ignore invalid stored config
      }
    }
    this.active = null;
  }

  getState() {
    if (!this.active) return { ok: true, loggedIn: false };
    return {
      ok: true,
      loggedIn: true,
      url: this.active.url,
      username: this.active.username,
    };
  }

  // Ensure an OAuth app registration exists for the instance; cache per URL.
  async _ensureClient(baseUrl) {
    const cached = this.clients[baseUrl];
    if (cached) return cached;
    let res;
    try {
      res = await fetch(`${baseUrl}/api/v1/apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'CIBYP AI Partner',
          redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
          scopes: 'read write follow',
          website: '',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        ...this._requestOptions(),
      });
    } catch (e) {
      throw new Error(`无法连接实例 ${baseUrl}: ${e.name === 'TimeoutError' ? '连接超时' : e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.client_id || !data.client_secret) {
      throw new Error(`应用注册失败（${res.status}）: ${data.error_description || data.error || '无法获取 client_id'}`);
    }
    const client = { clientId: String(data.client_id), clientSecret: String(data.client_secret) };
    this.clients[baseUrl] = client;
    return client;
  }

  async login({ url, username, password }) {
    const baseUrl = normalizeBaseUrl(url);
    if (!username || !username.trim()) throw new Error('用户名不能为空');
    if (!password) throw new Error('密码不能为空');

    let client;
    try {
      client = await this._ensureClient(baseUrl);
    } catch (e) {
      if (e.message.includes('连接超时')) throw e;
      // /api/v1/apps might be unavailable; fall back to password grant without client
      client = null;
    }

    const body = new URLSearchParams({
      grant_type: 'password',
      username: username.trim(),
      password,
    });
    if (client) {
      body.set('client_id', client.clientId);
      body.set('client_secret', client.clientSecret);
    }

    let res;
    try {
      res = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        ...this._requestOptions(),
      });
    } catch (e) {
      throw new Error(`无法连接实例 ${baseUrl}: ${e.name === 'TimeoutError' ? '连接超时' : e.message}`);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      // Stale cached client credentials may be rejected; retry once with a fresh registration.
      if (client && (res.status === 400 || res.status === 401) &&
          (String(data.error || '').toLowerCase().includes('client_id') || String(data.error || '').toLowerCase().includes('client_secret'))) {
        delete this.clients[baseUrl];
        client = await this._ensureClient(baseUrl);
        const retry = new URLSearchParams({
          grant_type: 'password',
          username: username.trim(),
          password,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        let res2;
        try {
          res2 = await fetch(`${baseUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: retry.toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
            ...this._requestOptions(),
          });
        } catch (e) {
          throw new Error(`无法连接实例 ${baseUrl}: ${e.name === 'TimeoutError' ? '连接超时' : e.message}`);
        }
        const data2 = await res2.json().catch(() => ({}));
        if (res2.ok && data2.access_token) {
          this.active = { url: baseUrl, username: username.trim(), accessToken: data2.access_token };
          return this._verifiedLogin();
        }
        const msg = data2.error_description || data2.error || `HTTP ${res2.status}`;
        throw new Error(`登录失败: ${msg}`);
      }
      const msg = data.error_description || data.error || `HTTP ${res.status}`;
      throw new Error(`登录失败: ${msg}`);
    }

    this.active = {
      url: baseUrl,
      username: username.trim(),
      accessToken: data.access_token,
    };

    return this._verifiedLogin();
  }

  async _verifiedLogin() {
    try {
      const account = await this.api('/api/v1/accounts/verify_credentials');
      return {
        ok: true,
        account: compactAccount(account),
        state: this.getState(),
      };
    } catch (e) {
      return {
        ok: true,
        account: null,
        error: e.message,
        state: this.getState(),
      };
    }
  }

  async logout() {
    if (!this.active) return { ok: true, loggedIn: false };
    const { url, accessToken } = this.active;
    this.active = null;
    const client = this.clients[url];
    const body = new URLSearchParams({ token: accessToken });
    if (client) {
      body.set('client_id', client.clientId);
      body.set('client_secret', client.clientSecret);
    }
    try {
      await fetch(`${url}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        ...this._requestOptions(),
      });
    } catch (e) {
      // ignore revocation failures; local state is cleared anyway
    }
    return { ok: true, loggedIn: false };
  }

  async api(path, { method = 'GET', body = null, timeout = REQUEST_TIMEOUT } = {}) {
    if (!this.active) throw new Error('尚未登录 FediKitten 实例，请在设置页完成登录');
    const headers = { Authorization: `Bearer ${this.active.accessToken}` };
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${this.active.url}${path}`, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(timeout),
        ...this._requestOptions(),
      });
    } catch (e) {
      throw new Error(`请求失败: ${e.name === 'TimeoutError' ? '连接超时' : e.message}`);
    }
    if (res.status === 401) {
      throw new Error('登录已失效，请重新登录');
    }
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error_description || data.error))
        ? (data.error_description || data.error)
        : `HTTP ${res.status}`;
      throw new Error(`${msg}`);
    }
    return data;
  }

  // ---- Tool implementations ----
  // Every tool returns { ok: true, ...payload } or { ok: false, error }

  async call(toolName, args = {}) {
    if (!toolName || typeof toolName !== 'string') {
      return { ok: false, error: '缺少工具名称' };
    }
    const fn = TOOL_HANDLERS[toolName];
    if (!fn) return { ok: false, error: `未知工具: ${toolName}` };
    try {
      return await fn.call(this, args);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  clampLimit(limit, def = 20, max = 40) {
    const n = parseInt(limit, 10);
    if (Number.isNaN(n) || n < 1) return def;
    return Math.min(n, max);
  }

  async postStatus(args) {
    const status = String(args.status || '').trim();
    if (!status) return { ok: false, error: '帖子内容不能为空' };
    if (status.length > 5000) return { ok: false, error: '帖子内容超过 5000 字符上限' };
    const visibility = ['public', 'unlisted', 'private', 'direct'].includes(args.visibility)
      ? args.visibility : 'public';
    const body = { status, visibility };
    if (args.spoiler_text) body.spoiler_text = String(args.spoiler_text).trim();
    if (args.sensitive) body.sensitive = !!args.sensitive;
    // 便捷发图：media_files 数组自动逐张上传，与 media_ids 二选一
    if (Array.isArray(args.media_files) && args.media_files.length > 0) {
      if (args.media_files.length > MAX_MEDIA_PER_POST) {
        return { ok: false, error: `一次最多附带 ${MAX_MEDIA_PER_POST} 个媒体文件` };
      }
      const mediaIds = [];
      for (const mf of args.media_files) {
        const up = await this._uploadMediaFile(
          String(mf && (mf.path || mf.filePath) || ''),
          mf && (mf.description != null ? String(mf.description) : null)
        );
        if (!up.ok) return up;
        mediaIds.push(up.media.id);
      }
      body.media_ids = mediaIds;
    } else if (Array.isArray(args.media_ids) && args.media_ids.length > 0) {
      body.media_ids = args.media_ids.map(String);
    }
    const s = await this.api('/api/v1/statuses', { method: 'POST', body });
    return { ok: true, status: compactStatus(s) };
  }

  async directMessage(args) {
    let status = String(args.status || '').trim();
    if (!status) return { ok: false, error: '私信内容不能为空' };
    let accountId = String(args.account_id || '');
    let mentionName = '';
    if (!accountId) {
      const acct = String(args.acct || '').trim();
      if (!acct) return { ok: false, error: '请提供 account_id 或 acct（如 @alice@example.com 或 alice）' };
      const lookup = await this.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
      if (!lookup || !lookup.id) return { ok: false, error: `找不到账号: ${acct}` };
      accountId = String(lookup.id);
      mentionName = lookup.acct && String(lookup.acct).includes('@') ? `@${lookup.acct}` : `@${lookup.username || lookup.acct || acct}`;
    }
    // FediKitten 要求 direct 帖子的正文中包含收件人 @提及
    const mentionPattern = new RegExp(`@${mentionName.replace(/^@/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!mentionPattern.test(status)) {
      status = `${mentionName} ${status}`;
    }
    const body = {
      status,
      visibility: 'direct',
    };
    if (args.spoiler_text) body.spoiler_text = String(args.spoiler_text).trim();
    const s = await this.api('/api/v1/statuses', { method: 'POST', body });
    return { ok: true, status: compactStatus(s) };
  }

  async homeTimeline(args) {
    const limit = this.clampLimit(args.limit, 20, 40);
    const data = await this.api(`/api/v1/timelines/home?limit=${limit}`);
    return { ok: true, statuses: (Array.isArray(data) ? data : []).map(compactStatus) };
  }

  async publicTimeline(args) {
    const limit = this.clampLimit(args.limit, 20, 40);
    const local = args.local ? '&local=true' : '';
    const data = await this.api(`/api/v1/timelines/public?limit=${limit}${local}`);
    return { ok: true, statuses: (Array.isArray(data) ? data : []).map(compactStatus) };
  }

  async getStatus(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}`);
    return { ok: true, status: compactStatus(s) };
  }

  async statusContext(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const data = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}/context`);
    return {
      ok: true,
      ancestors: (data && Array.isArray(data.ancestors) ? data.ancestors : []).map(compactStatus),
      descendants: (data && Array.isArray(data.descendants) ? data.descendants : []).map(compactStatus),
    };
  }

  async deleteStatus(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { ok: true, status: compactStatus(s) };
  }

  async favourite(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}/favourite`, { method: 'POST' });
    return { ok: true, status: compactStatus(s) };
  }

  async unfavourite(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}/unfavourite`, { method: 'POST' });
    return { ok: true, status: compactStatus(s) };
  }

  async reblog(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}/reblog`, { method: 'POST' });
    return { ok: true, status: compactStatus(s) };
  }

  async unreblog(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少帖子 id' };
    const s = await this.api(`/api/v1/statuses/${encodeURIComponent(id)}/unreblog`, { method: 'POST' });
    return { ok: true, status: compactStatus(s) };
  }

  async search(args) {
    const q = String(args.q || '').trim();
    if (!q) return { ok: false, error: '搜索关键词不能为空' };
    const type = ['statuses', 'accounts', 'hashtags'].includes(args.type) ? args.type : 'statuses';
    const limit = this.clampLimit(args.limit, 10, 20);
    const data = await this.api(`/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`);
    const result = { ok: true, type };
    if (type === 'statuses') {
      result.statuses = (data && Array.isArray(data.statuses) ? data.statuses : []).map(compactStatus);
    } else if (type === 'accounts') {
      result.accounts = (data && Array.isArray(data.accounts) ? data.accounts : []).map(compactAccount);
    } else {
      result.hashtags = (data && Array.isArray(data.hashtags) ? data.hashtags : []).map(h => ({ name: h.name, url: h.url }));
    }
    return result;
  }

  async lookupAccount(args) {
    const acct = String(args.acct || '').trim();
    if (!acct) return { ok: false, error: '缺少账号名（如 @alice@example.com 或 alice）' };
    const a = await this.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
    return { ok: true, account: compactAccount(a) };
  }

  async follow(args) {
    const id = String(args.account_id || '');
    if (!id) {
      const acct = String(args.acct || '').trim();
      if (!acct) return { ok: false, error: '请提供 account_id 或 acct' };
      const lookup = await this.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
      if (!lookup || !lookup.id) return { ok: false, error: `找不到账号: ${acct}` };
      return this._followResult(await this.api(`/api/v1/accounts/${encodeURIComponent(lookup.id)}/follow`, { method: 'POST' }));
    }
    return this._followResult(await this.api(`/api/v1/accounts/${encodeURIComponent(id)}/follow`, { method: 'POST' }));
  }

  async unfollow(args) {
    const id = String(args.account_id || '');
    if (!id) {
      const acct = String(args.acct || '').trim();
      if (!acct) return { ok: false, error: '请提供 account_id 或 acct' };
      const lookup = await this.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
      if (!lookup || !lookup.id) return { ok: false, error: `找不到账号: ${acct}` };
      return this._followResult(await this.api(`/api/v1/accounts/${encodeURIComponent(lookup.id)}/unfollow`, { method: 'POST' }));
    }
    return this._followResult(await this.api(`/api/v1/accounts/${encodeURIComponent(id)}/unfollow`, { method: 'POST' }));
  }

  _followResult(rel) {
    if (!rel || typeof rel !== 'object') return { ok: true };
    return {
      ok: true,
      account_id: rel.id || null,
      following: !!rel.following,
      followed_by: !!rel.followed_by,
      requested: !!rel.requested,
    };
  }

  async accountStatuses(args) {
    const id = String(args.account_id || '');
    if (!id) {
      const acct = String(args.acct || '').trim();
      if (!acct) return { ok: false, error: '请提供 account_id 或 acct' };
      const lookup = await this.api(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`);
      if (!lookup || !lookup.id) return { ok: false, error: `找不到账号: ${acct}` };
      return this._accountStatuses(String(lookup.id), args.limit);
    }
    return this._accountStatuses(id, args.limit);
  }

  async _accountStatuses(id, limit) {
    const l = this.clampLimit(limit, 20, 40);
    const data = await this.api(`/api/v1/accounts/${encodeURIComponent(id)}/statuses?limit=${l}`);
    return { ok: true, statuses: (Array.isArray(data) ? data : []).map(compactStatus) };
  }

  // 上传单个媒体文件（内部实现，filePath 为本地绝对路径）
  async _uploadMediaFile(filePath, description) {
    if (!filePath) return { ok: false, error: '缺少媒体文件路径 filePath' };
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return { ok: false, error: `媒体文件不存在: ${filePath}` };
    }
    if (!stat.isFile()) return { ok: false, error: `不是文件: ${filePath}` };
    if (stat.size > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `文件超过 90MB 上传上限（${(stat.size / 1048576).toFixed(1)}MB）` };
    }
    const mime = await detectMime(filePath);
    if (!mime) return { ok: false, error: '无法识别媒体类型，仅支持 jpeg/png/gif/webp/avif/mp4/webm/mpeg/ogg/wav' };
    let bytes;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (e) {
      return { ok: false, error: `读取文件失败: ${e.message}` };
    }
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: mime }), path.basename(filePath));
    if (description) fd.append('description', description);
    let res;
    try {
      res = await fetch(`${this.active.url}/api/v1/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.active.accessToken}` },
        body: fd,
        signal: AbortSignal.timeout(uploadTimeoutFor(bytes.length)),
        ...this._requestOptions(),
      });
    } catch (e) {
      return { ok: false, error: `上传失败: ${e.name === 'TimeoutError' ? '连接超时' : e.message}` };
    }
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (res.status === 401) {
      return { ok: false, error: '登录已失效，请重新登录' };
    }
    if (!res.ok || !data || !data.id) {
      const msg = (data && typeof data === 'object' && (data.error_description || data.error))
        ? (data.error_description || data.error)
        : `HTTP ${res.status}`;
      return { ok: false, error: `上传被拒绝（${msg}）` };
    }
    return { ok: true, media: compactMedia(data) };
  }

  async uploadMedia(args) {
    const up = await this._uploadMediaFile(
      String(args.filePath || args.path || ''),
      args.description != null ? String(args.description) : null
    );
    if (!up.ok) return up;
    return {
      ok: true,
      media: up.media,
      message: `媒体上传成功（${up.media.type}），可将 id=${up.media.id} 传入 fedikittenPostStatus 的 media_ids 发帖`,
    };
  }

  async getMedia(args) {
    const id = String(args.id || '');
    if (!id) return { ok: false, error: '缺少媒体 id' };
    const data = await this.api(`/api/v1/media/${encodeURIComponent(id)}`);
    return { ok: true, media: compactMedia(data) };
  }

  // 下载公开媒体到本地。先直连下载（自实例媒体），失败时降级走 aria2（支持用户代理，可下远端实例媒体）。
  async downloadMedia(args) {
    const url = String(args.url || '').trim();
    if (!url) return { ok: false, error: '缺少媒体 url' };
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return { ok: false, error: `媒体 url 无效: ${url}` };
    }
    if (!/^https?:$/.test(parsedUrl.protocol)) return { ok: false, error: '仅支持 http/https 媒体 url' };
    const savePath = String(args.savePath || '').trim();
    if (!savePath) return { ok: false, error: '请提供 savePath（相对工作目录或绝对路径）指定保存位置' };
    const outDir = path.dirname(savePath);
    const outFile = path.basename(savePath) || (path.basename(parsedUrl.pathname) || 'media');

    const tryFetch = async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT), ...this._requestOptions() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ctype = res.headers.get('content-type') || '';
      return { buf: Buffer.from(await res.arrayBuffer()), ctype };
    };

    try {
      const got = await tryFetch();
      const mime = got.ctype.split(';')[0].trim();
      if (!/^(image|video|audio)\//.test(mime)) {
        return { ok: false, error: `目标不是媒体文件（content-type: ${mime || '未知'}）` };
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, outFile), got.buf);
      return {
        ok: true,
        path: path.join(outDir, outFile),
        size: got.buf.length,
        mimeType: mime,
        source: 'direct',
        message: `已下载媒体到 ${path.join(outDir, outFile)}，可用 readImageFile 查看（多模态）或 extractTextFromImage 做 OCR`,
      };
    } catch (e) {
      // 直连失败（超时/网络不通，常见于远端联邦实例媒体）→ 降级 aria2（走用户代理）
      try {
        const { aria2Manager } = require('./aria2-manager');
        await aria2Manager.ensureStarted();
        fs.mkdirSync(outDir, { recursive: true });
        const gid = await aria2Manager.addUri(url, { dir: outDir, out: outFile });
        const deadline = Date.now() + MEDIA_TIMEOUT;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 500));
          const st = await aria2Manager.tellStatus(gid);
          if (st.status === 'complete') {
            const filePath = st.files?.[0]?.path || path.join(outDir, outFile);
            return {
              ok: true,
              path: filePath,
              size: parseInt(st.completedLength || '0', 10),
              mimeType: '',
              source: 'aria2',
              message: `已通过代理下载媒体到 ${filePath}，可用 readImageFile 查看或 extractTextFromImage 做 OCR`,
            };
          }
          if (st.status === 'error' || st.status === 'removed') {
            return { ok: false, error: `下载失败: ${st.errorMessage || st.status}` };
          }
        }
        return { ok: false, error: '下载超时（60 秒）' };
      } catch (e2) {
        return { ok: false, error: `下载失败（直连: ${e.message}；aria2 降级: ${e2.message}）` };
      }
    }
  }

  async conversations(args) {
    const limit = this.clampLimit(args.limit, 20, 40);
    const data = await this.api(`/api/v1/conversations?limit=${limit}`);
    const convs = (Array.isArray(data) ? data : []).map(c => ({
      id: c.id,
      unread: !!c.unread,
      last_status: compactStatus(c.last_status),
      accounts: (Array.isArray(c.accounts) ? c.accounts : []).map(compactAccount),
    }));
    return { ok: true, conversations: convs };
  }

  async notifications(args) {
    const limit = this.clampLimit(args.limit, 20, 40);
    const data = await this.api(`/api/v1/notifications?limit=${limit}`);
    const notes = (Array.isArray(data) ? data : []).map(n => ({
      id: n.id,
      type: n.type,
      created_at: n.created_at,
      account: compactAccount(n.account),
      status: compactStatus(n.status),
    }));
    return { ok: true, notifications: notes };
  }
}

const TOOL_HANDLERS = {
  fedikittenPostStatus: FediKittenService.prototype.postStatus,
  fedikittenDirectMessage: FediKittenService.prototype.directMessage,
  fedikittenHomeTimeline: FediKittenService.prototype.homeTimeline,
  fedikittenPublicTimeline: FediKittenService.prototype.publicTimeline,
  fedikittenGetStatus: FediKittenService.prototype.getStatus,
  fedikittenStatusContext: FediKittenService.prototype.statusContext,
  fedikittenDeleteStatus: FediKittenService.prototype.deleteStatus,
  fedikittenFavourite: FediKittenService.prototype.favourite,
  fedikittenUnfavourite: FediKittenService.prototype.unfavourite,
  fedikittenReblog: FediKittenService.prototype.reblog,
  fedikittenUnreblog: FediKittenService.prototype.unreblog,
  fedikittenSearch: FediKittenService.prototype.search,
  fedikittenLookupAccount: FediKittenService.prototype.lookupAccount,
  fedikittenFollow: FediKittenService.prototype.follow,
  fedikittenUnfollow: FediKittenService.prototype.unfollow,
  fedikittenAccountStatuses: FediKittenService.prototype.accountStatuses,
  fedikittenUploadMedia: FediKittenService.prototype.uploadMedia,
  fedikittenGetMedia: FediKittenService.prototype.getMedia,
  fedikittenDownloadMedia: FediKittenService.prototype.downloadMedia,
  fedikittenConversations: FediKittenService.prototype.conversations,
  fedikittenNotifications: FediKittenService.prototype.notifications,
};

module.exports = { FediKittenService };