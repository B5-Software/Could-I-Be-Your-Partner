/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * MCP（Model Context Protocol）客户端与 IPC 服务。
 *
 * 规范符合性（https://modelcontextprotocol.io/specification/2025-06-18）：
 * - stdio 传输：换行分隔 JSON（NDJSON）双向帧；兼容解析旧式 Content-Length 帧
 * - Streamable HTTP 传输：POST 单端点 + 可选 GET SSE 监听 + Mcp-Session-Id 会话
 *   + MCP-Protocol-Version 头
 * - 生命周期：initialize 版本协商 → notifications/initialized → 运行期 → 关闭
 *   （stdin.end → 等待 → SIGTERM → SIGKILL / HTTP DELETE 会话）
 * - 工具：tools/list 分页（cursor）、tools/call 结果规范化（content/isError/
 *   structuredContent/image/resource_link）
 * - 服务器→客户端请求：ping 必须回应；未实现的方法回 -32601
 * - 取消：请求超时发送 notifications/cancelled
 */

'use strict';

module.exports = function registerMcpIpc({ ipcMain, getSettings, persist, appVersion, notifyRenderer, defaultTimeoutMs, shutdownTermGraceMs, shutdownKillGraceMs }) {
  const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';
  const LEGACY_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
  const DEFAULT_TIMEOUT = Math.max(1000, Number(defaultTimeoutMs) || 30000);
  const SHUTDOWN_TERM_GRACE_MS = Math.max(50, Number(shutdownTermGraceMs) || 3000);
  const SHUTDOWN_KILL_GRACE_MS = Math.max(50, Number(shutdownKillGraceMs) || 2000);

  // serverKey -> entry（key 为净化后的服务器名，用于 mcp__<key>__<tool> 组合名路由）
  const mcpServers = new Map();

  function getMcpSettings() {
    const mcp = getSettings().mcp || {};
    if (!Array.isArray(mcp.servers)) mcp.servers = [];
    return mcp;
  }

  function saveMcpSettings(mcpSettings) {
    getSettings().mcp = mcpSettings;
    persist();
  }

  // ---------- 工具函数 ----------

  // 服务器名 → 组合名安全段：仅保留 [A-Za-z0-9_-]，其余转 '_'，避免破坏 mcp__<key>__<tool> 路由
  function sanitizeServerKey(name) {
    return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'server';
  }

  function findEntryByNameOrKey(nameOrKey) {
    if (mcpServers.has(nameOrKey)) return mcpServers.get(nameOrKey);
    const want = sanitizeServerKey(nameOrKey);
    for (const entry of mcpServers.values()) {
      if (entry.key === want || sanitizeServerKey(entry.name) === want) return entry;
    }
    return null;
  }

  // 最小环境变量白名单（规范建议 stdio 凭据走环境而非全量透传父进程环境）
  const ENV_ALLOWLIST = [
    'PATH', 'HOME', 'TEMP', 'TMP', 'LANG', 'TZ', 'SHELL',
    // Windows 运行时必需
    'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERPROFILE',
    // macOS 常见
    'TMPDIR'
  ];

  function buildEnv(config) {
    const base = {};
    if (config && config.inheritEnv === true) {
      Object.assign(base, process.env);
    } else {
      for (const k of ENV_ALLOWLIST) {
        if (process.env[k] !== undefined) base[k] = process.env[k];
      }
    }
    return { ...base, ...((config && config.env) || {}) };
  }

  // Windows .cmd/.bat 必须经 shell 执行（Node 对这类扩展名无 shell 直接 spawn 会 EINVAL），
  // 此时对参数做 cmd.exe 引号转义；其余平台一律 shell:false，杜绝注入面。
  function windowsQuote(arg) {
    const s = String(arg);
    if (s === '') return '""';
    if (!/[\s"]/.test(s)) return s;
    return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }

  function spawnOptionsFor(config) {
    const isWin = process.platform === 'win32';
    const cmd = String(config.command || '').trim();
    let args = Array.isArray(config.args) ? config.args.map(String) : [];
    let shell = false;
    if (isWin && /\.(cmd|bat)$/i.test(cmd)) {
      shell = true;
      args = args.map(windowsQuote);
    }
    return { command: cmd, args, shell };
  }

  // ---------- JSON-RPC 发送（按传输分派） ----------

  function sendMessage(entry, msg) {
    if (!entry) throw new Error('MCP 连接不存在');
    if (entry.type === 'http') return httpSendMessage(entry, msg);
    return stdioSendMessage(entry, msg);
  }

  function stdioSendMessage(entry, msg) {
    if (!entry.child || entry.child.killed) throw new Error('MCP 进程未运行');
    // 规范：stdio 为换行分隔 JSON，且消息内不得包含裸换行（JSON.stringify 输出天然单行）
    entry.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function httpSendMessage(entry, msg) {
    // 有 id 的消息是请求/响应：POST 后等待应答；通知期望 202
    const hasId = msg.id !== undefined;
    const out = await httpPost(entry, msg);
    if (!hasId) return; // 通知：202 即完成
    if (out.message) {
      handleIncomingMessage(entry, out.message);
      return;
    }
    throw new Error('HTTP 传输：请求未返回响应');
  }

  // ---------- 请求/通知（带超时取消） ----------

  function request(entry, method, params, timeoutMs) {
    const server = entry;
    if (!server || server.status === 'disconnected') {
      return Promise.reject(new Error(`MCP 服务器 "${server ? server.name : ''}" 未连接`));
    }
    const ms = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT);
    return new Promise((resolve, reject) => {
      const id = ++server.requestId;
      const pending = {
        resolve, reject, method,
        timer: setTimeout(() => {
          server.pendingRequests.delete(id);
          // 规范：超时应发送取消通知并停止等待
          try {
            sendMessage(server, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: `timeout after ${ms}ms` } });
          } catch { /* 连接已死则忽略 */ }
          reject(new Error(`Request ${method} timed out after ${ms}ms`));
        }, ms)
      };
      server.pendingRequests.set(id, pending);
      try {
        const sent = sendMessage(server, { jsonrpc: '2.0', id, method, params });
        // HTTP 传输的发送是异步的：发送失败要立刻拒绝，不能等超时
        if (sent && typeof sent.catch === 'function') {
          sent.catch((e) => {
            clearTimeout(pending.timer);
            server.pendingRequests.delete(id);
            reject(e);
          });
        }
      } catch (e) {
        clearTimeout(pending.timer);
        server.pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  function notify(entry, method, params) {
    try {
      const sent = sendMessage(entry, { jsonrpc: '2.0', method, params: params || {} });
      if (sent && typeof sent.catch === 'function') sent.catch(() => { /* 通知失败静默 */ });
    } catch (e) {
      console.error(`[MCP:${entry.name}] notify ${method} error: ${e.message}`);
    }
  }

  // ---------- 入站消息路由（双传输共用） ----------

  function handleIncomingMessage(entry, msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

    // 响应（有 id 且带 result/error、无 method）
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = entry.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        entry.pendingRequests.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error));
          err.code = msg.error.code;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (typeof msg.method !== 'string') return;

    if (msg.id !== undefined) {
      // 服务器→客户端请求：ping 必须回应；未实现的能力回 -32601
      if (msg.method === 'ping') {
        try { sendMessage(entry, { jsonrpc: '2.0', id: msg.id, result: {} }); } catch { /* ignore */ }
      } else {
        try {
          sendMessage(entry, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported by client: ${msg.method}` } });
        } catch { /* ignore */ }
      }
      return;
    }

    // 服务器通知
    if (msg.method === 'notifications/tools/list_changed') {
      refreshTools(entry).then(() => emitChanged()).catch((e) => {
        console.error(`[MCP:${entry.name}] tools/list_changed 刷新失败: ${e.message}`);
      });
    }
    // 其余通知（logging/message 等）暂不处理
  }

  // ---------- stdio 传输 ----------

  function startStdioTransport(entry) {
    return new Promise((resolve, reject) => {
      const { command, args, shell } = spawnOptionsFor(entry.config);
      if (!command) { reject(new Error('命令不能为空')); return; }
      const { spawn } = require('child_process');
      let child;
      try {
        child = spawn(command, args, {
          env: buildEnv(entry.config),
          cwd: entry.config.cwd || process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell,
          windowsHide: true
        });
      } catch (e) {
        reject(e);
        return;
      }
      entry.child = child;
      child.on('error', (err) => {
        console.error(`[MCP:${entry.name}] process error: ${err.message}`);
        entry.status = 'error';
        rejectAllPending(entry, new Error(`进程错误: ${err.message}`));
      });
      child.on('close', (code) => {
        console.log(`[MCP:${entry.name}] process exited with code ${code}`);
        entry.status = 'disconnected';
        rejectAllPending(entry, new Error('连接已关闭'));
        if (mcpServers.get(entry.key) === entry) mcpServers.delete(entry.key);
        emitChanged();
      });
      child.stdout.on('data', (chunk) => feedStdioBytes(entry, chunk));
      child.stderr.on('data', (data) => {
        const text = data.toString();
        // 限制单条日志长度，避免失控服务器刷爆主进程日志
        console.error(`[MCP:${entry.name}] stderr: ${text.length > 2000 ? text.slice(0, 2000) + '…[截断]' : text}`);
      });
      resolve();
    });
  }

  // 入站字节流：优先按规范 NDJSON（\n 分隔）解析；兼容旧实现/特殊服务器的
  // Content-Length（LSP 风格）帧 —— 以 "Content-Length:" 开头时切换到帧解析。
  function feedStdioBytes(entry, chunk) {
    entry.buffer = Buffer.concat([entry.buffer, chunk]);
    while (entry.buffer.length > 0) {
      const head = entry.buffer.subarray(0, Math.min(entry.buffer.length, 15)).toString('latin1');
      if (/^Content-Length:/i.test(head)) {
        const headerEnd = entry.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break; // 头部未到齐
        const header = entry.buffer.subarray(0, headerEnd).toString('latin1');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) { entry.buffer = entry.buffer.subarray(headerEnd + 4); continue; }
        const total = headerEnd + 4 + parseInt(m[1], 10);
        if (entry.buffer.length < total) break; // 体未到齐
        const body = entry.buffer.subarray(headerEnd + 4, total).toString('utf8');
        entry.buffer = entry.buffer.subarray(total);
        ingestJsonText(entry, body);
        continue;
      }
      const nl = entry.buffer.indexOf(0x0a); // '\n'
      if (nl === -1) break; // 行未到齐
      let line = entry.buffer.subarray(0, nl).toString('utf8');
      entry.buffer = entry.buffer.subarray(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      ingestJsonText(entry, line);
    }
  }

  function ingestJsonText(entry, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      console.warn(`[MCP:${entry.name}] 无法解析的入站消息: ${text.slice(0, 120)}`);
      return;
    }
    handleIncomingMessage(entry, msg);
  }

  function rejectAllPending(entry, err) {
    for (const [, pending] of entry.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    entry.pendingRequests.clear();
  }

  // 规范关闭序列：stdin.end → 等待退出 → SIGTERM → SIGKILL
  async function shutdownStdio(entry) {
    const child = entry.child;
    if (!child || child.killed || child.exitCode !== null) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once('close', finish);
      try { child.stdin.end(); } catch { /* ignore */ }
      setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          setTimeout(finish, 300);
        }, SHUTDOWN_KILL_GRACE_MS);
      }, SHUTDOWN_TERM_GRACE_MS);
    });
  }

  // ---------- Streamable HTTP 传输 ----------

  function httpHeaders(entry, extra) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...((entry.config.headers) || {}),
      ...(extra || {})
    };
    if (entry.protocolVersion) headers['MCP-Protocol-Version'] = entry.protocolVersion;
    if (entry.sessionId) headers['Mcp-Session-Id'] = entry.sessionId;
    return headers;
  }

  // 增量 SSE 解析器：把字节流切成完整事件的 data 载荷
  function createSseParser(onData) {
    let buf = '';
    return {
      push(text) {
        buf += text;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = [];
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length) onData(dataLines.join('\n'));
        }
      }
    };
  }

  async function httpPost(entry, msgObj) {
    const timeoutMs = DEFAULT_TIMEOUT;
    const res = await fetch(entry.config.url, {
      method: 'POST',
      headers: httpHeaders(entry),
      body: JSON.stringify(msgObj),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) entry.sessionId = sid;
    if (res.status === 202) return { status: 202 };
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
    if (ct.includes('text/event-stream')) {
      // 响应以 SSE 流返回：扫描事件直到出现与本请求 id 匹配的响应；
      // 途中出现的服务器请求/通知照常路由
      const message = await new Promise((resolve, reject) => {
        const parser = createSseParser((data) => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { return; }
          if (parsed && parsed.id !== undefined && parsed.method === undefined &&
              msgObj && parsed.id === msgObj.id) {
            resolve(parsed);
          } else {
            handleIncomingMessage(entry, parsed);
          }
        });
        consumeBody(res, (chunk) => parser.push(chunk)).then(() => {
          reject(new Error('HTTP 传输：SSE 流在收到响应前结束'));
        }).catch((e) => reject(e));
      });
      return { status: res.status, message };
    }
    const message = await res.json();
    return { status: res.status, message };
  }

  async function consumeBody(res, onChunk) {
    if (!res.body) return;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      onChunk(decoder.decode(chunk, { stream: true }));
    }
    onChunk(decoder.decode());
  }

  // GET SSE 监听：接收服务器主动发起的请求/通知（405 表示服务器不提供，属正常）
  async function openHttpListener(entry) {
    const ctrl = new AbortController();
    entry.httpAbort = ctrl;
    const res = await fetch(entry.config.url, {
      method: 'GET',
      headers: httpHeaders(entry, { Accept: 'text/event-stream' }),
      signal: ctrl.signal
    });
    if (res.status === 405) return; // 服务器不支持服务器→客户端流
    if (!res.ok) return;
    const parser = createSseParser((data) => {
      try { handleIncomingMessage(entry, JSON.parse(data)); } catch { /* ignore */ }
    });
    consumeBody(res, (chunk) => parser.push(chunk)).catch(() => { /* 断流静默 */ });
  }

  async function startHttpTransport(entry) {
    const url = String(entry.config.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('HTTP 传输需要有效的 http(s) URL');
    // initialize 在 startMcpServer 统一发送；这里只做 URL 校验
  }

  async function httpDeleteSession(entry) {
    if (!entry.sessionId) return;
    try {
      await fetch(entry.config.url, {
        method: 'DELETE',
        headers: httpHeaders(entry),
        signal: AbortSignal.timeout(5000)
      });
    } catch { /* 405/网络错误均忽略 */ }
  }

  // ---------- 生命周期 ----------

  async function connectServer(config) {
    const key = sanitizeServerKey(config.name);
    // 同 key 冲突消歧（不同原始名净化后相同的情况）
    let finalKey = key;
    let n = 2;
    while (mcpServers.has(finalKey) && mcpServers.get(finalKey).name !== config.name) {
      finalKey = `${key}-${n++}`;
    }
    if (mcpServers.has(finalKey)) await teardownEntry(mcpServers.get(finalKey));

    const type = config.type === 'http' ? 'http' : 'stdio';
    const entry = {
      key: finalKey,
      name: config.name,
      config,
      type,
      status: 'connecting',
      tools: [],
      protocolVersion: null,
      sessionId: null,
      pendingRequests: new Map(),
      requestId: 0,
      buffer: Buffer.alloc(0),
      instructions: null
    };
    mcpServers.set(finalKey, entry);

    try {
      if (type === 'http') {
        await startHttpTransport(entry);
      } else {
        await startStdioTransport(entry);
      }
      // initialize：版本协商（发最新支持版本；服务器回它支持的版本，记录之）
      const initResult = await request(entry, 'initialize', {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Could-I-Be-Your-Partner', title: 'Could I Be Your Partner', version: appVersion }
      });
      if (initResult && initResult.protocolVersion) {
        entry.protocolVersion = String(initResult.protocolVersion);
        if (entry.protocolVersion !== SUPPORTED_PROTOCOL_VERSION &&
            !LEGACY_PROTOCOL_VERSIONS.includes(entry.protocolVersion)) {
          console.warn(`[MCP:${entry.name}] 服务器协商了未知协议版本 ${entry.protocolVersion}，将继续但可能不兼容`);
        }
      }
      if (initResult && typeof initResult.instructions === 'string') {
        entry.instructions = initResult.instructions;
      }
      notify(entry, 'notifications/initialized', {});
      await refreshTools(entry);
      entry.status = 'connected';
      emitChanged();
      return { ok: true, tools: entry.tools, protocolVersion: entry.protocolVersion, serverInfo: initResult && initResult.serverInfo };
    } catch (e) {
      await teardownEntry(entry);
      return { ok: false, error: e.message };
    }
  }

  async function teardownEntry(entry) {
    entry.status = 'disconnected';
    rejectAllPending(entry, new Error('连接已关闭'));
    if (entry.type === 'http') {
      await httpDeleteSession(entry);
      if (entry.httpAbort) { try { entry.httpAbort.abort(); } catch { /* ignore */ } }
    } else {
      await shutdownStdio(entry);
    }
    if (mcpServers.get(entry.key) === entry) mcpServers.delete(entry.key);
    emitChanged();
  }

  async function stopMcpServer(nameOrKey) {
    const entry = findEntryByNameOrKey(nameOrKey);
    if (!entry) return;
    await teardownEntry(entry);
  }

  async function stopAllMcpServers() {
    for (const entry of [...mcpServers.values()]) {
      await teardownEntry(entry);
    }
  }

  // ---------- 工具 ----------

  // 分页循环：cursor/nextCursor 直到取完（规范 2025-06-18）
  async function refreshTools(entry) {
    const tools = [];
    let cursor;
    do {
      const result = await request(entry, 'tools/list', cursor ? { cursor } : {});
      if (result && Array.isArray(result.tools)) tools.push(...result.tools);
      cursor = result && result.nextCursor;
    } while (cursor);
    entry.tools = tools;
    return tools;
  }

  // tools/call 结果规范化：content 各类型拼接；isError 语义正确传递
  function normalizeToolResult(result) {
    if (result === undefined || result === null) return { isError: false, text: '', images: [] };
    if (typeof result !== 'object') return { isError: false, text: String(result), images: [] };
    const parts = [];
    const images = [];
    if (Array.isArray(result.content)) {
      for (const c of result.content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        else if (c.type === 'image' && typeof c.data === 'string') images.push({ mime: c.mimeType || 'image/png', data: c.data });
        else if (c.type === 'audio' && typeof c.data === 'string') parts.push(`[音频内容: ${c.mimeType || 'audio/*'}，base64 ${c.data.length} 字节]`);
        else if (c.type === 'resource_link' && c.uri) parts.push(`[资源链接] ${(c.name || '') + ' ' + c.uri}`.trim());
        else if (c.type === 'resource' && c.resource) {
          const r = c.resource;
          if (typeof r.text === 'string') parts.push(r.text);
          else if (r.blob) parts.push(`[资源内容] ${r.uri || r.mimeType || '(blob)'}`);
        } else if (typeof c.text === 'string') {
          parts.push(c.text);
        }
      }
    }
    if (result.structuredContent !== undefined) {
      try { parts.push('[structuredContent] ' + JSON.stringify(result.structuredContent)); } catch { /* ignore */ }
    }
    let text = parts.filter(Boolean).join('\n').trim();
    const isError = result.isError === true;
    if (isError && !text) text = 'Tool execution failed (isError)';
    return { isError, text, images };
  }

  // ---------- 变更广播 ----------

  function emitChanged() {
    if (typeof notifyRenderer !== 'function') return;
    try { notifyRenderer({}); } catch { /* ignore */ }
  }

  // ---------- IPC ----------

  ipcMain.handle('mcp:listServers', () => {
    const mcpSettings = getMcpSettings();
    return mcpSettings.servers.map((s) => {
      const key = sanitizeServerKey(s.name);
      let entry = mcpServers.get(key);
      if (!entry || entry.name !== s.name) {
        for (const e of mcpServers.values()) if (e.name === s.name) { entry = e; break; }
      }
      return {
        ...s,
        key,
        status: entry ? entry.status : 'disconnected',
        toolCount: entry ? entry.tools.length : 0,
        protocolVersion: entry ? entry.protocolVersion : null
      };
    });
  });

  ipcMain.handle('mcp:addServer', async (_, serverConfig) => {
    const mcpSettings = getMcpSettings();
    const cfg = serverConfig || {};
    if (!cfg.name || typeof cfg.name !== 'string') return { ok: false, error: '名称不能为空' };
    const type = cfg.type === 'http' ? 'http' : 'stdio';
    if (type === 'http') {
      if (!cfg.url || !/^https?:\/\//i.test(String(cfg.url))) return { ok: false, error: 'HTTP 服务器需要有效的 http(s) URL' };
    } else if (!cfg.command) {
      return { ok: false, error: '名称和命令不能为空' };
    }
    if (mcpSettings.servers.find((s) => s.name === cfg.name)) {
      return { ok: false, error: '同名服务器已存在' };
    }
    mcpSettings.servers.push(cfg);
    saveMcpSettings(mcpSettings);
    return { ok: true };
  });

  ipcMain.handle('mcp:removeServer', async (_, name) => {
    await stopMcpServer(name);
    const mcpSettings = getMcpSettings();
    mcpSettings.servers = mcpSettings.servers.filter((s) => s.name !== name);
    saveMcpSettings(mcpSettings);
    return { ok: true };
  });

  ipcMain.handle('mcp:updateServer', async (_, name, updates) => {
    const mcpSettings = getMcpSettings();
    const idx = mcpSettings.servers.findIndex((s) => s.name === name);
    if (idx === -1) return { ok: false, error: '服务器不存在' };
    mcpSettings.servers[idx] = { ...mcpSettings.servers[idx], ...updates };
    saveMcpSettings(mcpSettings);
    return { ok: true };
  });

  ipcMain.handle('mcp:connect', async (_, name) => {
    const mcpSettings = getMcpSettings();
    const config = mcpSettings.servers.find((s) => s.name === name);
    if (!config) return { ok: false, error: '服务器不存在' };
    return await connectServer(config);
  });

  ipcMain.handle('mcp:disconnect', async (_, name) => {
    await stopMcpServer(name);
    return { ok: true };
  });

  ipcMain.handle('mcp:listTools', async (_, serverName) => {
    if (serverName) {
      const entry = findEntryByNameOrKey(serverName);
      if (!entry) return { ok: false, error: '服务器未连接' };
      return { ok: true, tools: entry.tools.map((t) => ({ ...t, serverName: entry.key })), serverName: entry.key };
    }
    const allTools = [];
    for (const entry of mcpServers.values()) {
      if (entry.status === 'connected') {
        for (const tool of entry.tools) {
          allTools.push({ ...tool, serverName: entry.key });
        }
      }
    }
    return { ok: true, tools: allTools };
  });

  ipcMain.handle('mcp:callTool', async (_, serverName, toolName, args) => {
    const entry = findEntryByNameOrKey(serverName);
    if (!entry || entry.status !== 'connected') {
      return { ok: false, error: `MCP 服务器 "${serverName}" 未连接` };
    }
    try {
      const result = await request(entry, 'tools/call', { name: toolName, arguments: args || {} });
      const norm = normalizeToolResult(result);
      if (norm.isError) return { ok: false, error: norm.text };
      if (norm.images.length) {
        const img = norm.images[0];
        return {
          ok: true,
          text: norm.text,
          _multimodal: true,
          imageUrl: `data:${img.mime};base64,${img.data}`,
          extraImages: norm.images.slice(1).map((im) => `data:${im.mime};base64,${im.data}`)
        };
      }
      return { ok: true, text: norm.text };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('mcp:getStatus', () => {
    const statuses = {};
    for (const [key, entry] of mcpServers) {
      statuses[key] = { status: entry.status, tools: entry.tools.length, name: entry.name, protocolVersion: entry.protocolVersion };
    }
    return statuses;
  });

  return { getMcpSettings, startMcpServer: connectServer, stopMcpServer, stopAllMcpServers };
};
