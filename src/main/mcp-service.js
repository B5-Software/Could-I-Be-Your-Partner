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

module.exports = function registerMcpIpc({ ipcMain, getSettings, persist, appVersion, notifyRenderer, defaultTimeoutMs, shutdownTermGraceMs, shutdownKillGraceMs, getVmService }) {
  const SUPPORTED_PROTOCOL_VERSION = '2025-06-18';
  const LEGACY_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
  const DEFAULT_TIMEOUT = Math.max(1000, Number(defaultTimeoutMs) || 30000);
  const SHUTDOWN_TERM_GRACE_MS = Math.max(50, Number(shutdownTermGraceMs) || 3000);
  const SHUTDOWN_KILL_GRACE_MS = Math.max(50, Number(shutdownKillGraceMs) || 2000);

  // serverKey -> entry（key 为净化后的服务器名，用于 mcp__<key>__<tool> 组合名路由）
  const mcpServers = new Map();
  const connecting = new Map();
  const failures = new Map();

  function connectionState(entry, stage, progress) {
    entry.stage = stage;
    entry.progress = progress;
    emitChanged();
  }

  async function abortable(entry, promise) {
    const signal = entry.abort.signal;
    if (signal.aborted) throw new Error('Connection cancelled');
    let cancel;
    const stopped = new Promise((_, reject) => { cancel = () => reject(new Error('Connection cancelled')); signal.addEventListener('abort', cancel, { once: true }); });
    try { return await Promise.race([promise, stopped]); }
    finally { signal.removeEventListener('abort', cancel); }
  }

  function safeError(entry, error) {
    let text = String(error?.message || error || 'Connection failed');
    for (const value of [...Object.values(entry.config.env || {}), ...Object.values(entry.config.headers || {})])
      if (typeof value === 'string' && value.length > 3) text = text.split(value).join('[redacted]');
    return text.replace(/Bearer\s+[^\s,]+/gi, 'Bearer [redacted]').slice(-2000);
  }

  function recordFailure(entry, error) {
    if (entry.intentionalClose) return;
    if (failures.get(entry.name)?.at >= entry.startedAt) return;
    failures.set(entry.name, { error: safeError(entry, error), stage: entry.stage, detail: entry.stderr ? safeError(entry, entry.stderr) : null, at: Date.now() });
    emitChanged();
  }

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
    for (const entry of mcpServers.values()) {
      if (entry.name === nameOrKey) return entry;
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
    const hasId = msg.id !== undefined && typeof msg.method === 'string';
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
          notify(server, 'notifications/cancelled', { requestId: id, reason: `timeout after ${ms}ms` });
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
        try { Promise.resolve(sendMessage(entry, { jsonrpc: '2.0', id: msg.id, result: {} })).catch(() => {}); } catch { /* ignore */ }
      } else {
        try {
          Promise.resolve(sendMessage(entry, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported by client: ${msg.method}` } })).catch(() => {});
        } catch { /* ignore */ }
      }
      return;
    }

    // 服务器通知
    if (msg.method === 'notifications/tools/list_changed') {
      refreshTools(entry).then(() => emitChanged()).catch((e) => {
        console.error(`[MCP:${entry.name}] tools/list_changed refresh failed: ${e.message}`);
      });
    }
    // 其余通知（logging/message 等）暂不处理
  }

  // ---------- stdio 传输 ----------

  async function startStdioTransport(entry) {
      const { command, args, shell } = spawnOptionsFor(entry.config);
      if (!command) throw new Error('命令不能为空');
      const { spawn } = require('child_process');
      let child;
      try {
        const service = getVmService?.();
        const inVm = require('./vm/tool-location').isVmOperation(() => service);
        entry.executionLocation = inVm ? 'vm' : 'host';
        child = inVm ? await require('./vm/vm-process').spawnVmProcess(service, { command: entry.config.command, args: entry.config.args || [], cwd: entry.config.cwd, env: entry.config.env || {} }) : spawn(command, args, {
          env: buildEnv(entry.config),
          cwd: entry.config.cwd || process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell,
          windowsHide: true
        });
      } catch (e) {
        throw e;
      }
      entry.child = child;
      if (entry.abort.signal.aborted) { try { child.kill('SIGTERM'); } catch {} throw new Error('Connection cancelled'); }
      child.on('error', (err) => {
        console.error(`[MCP:${entry.name}] process error: ${err.message}`);
        entry.status = 'error';
        recordFailure(entry, err);
        rejectAllPending(entry, new Error(`进程错误: ${err.message}`));
      });
      child.stdin.on('error', err => { recordFailure(entry, err); rejectAllPending(entry, err); });
      child.on('close', (code) => {
        console.log(`[MCP:${entry.name}] process exited with code ${code}`);
        recordFailure(entry, new Error(`Server process exited with code ${code}`));
        entry.status = 'disconnected';
        rejectAllPending(entry, new Error('连接已关闭'));
        if (mcpServers.get(entry.key) === entry) mcpServers.delete(entry.key);
        emitChanged();
      });
      child.stdout.on('data', (chunk) => feedStdioBytes(entry, chunk));
      child.stderr.on('data', (data) => {
        const text = data.toString();
        entry.stderr = ((entry.stderr || '') + text).slice(-2000);
        // 限制单条日志长度，避免失控服务器刷爆主进程日志
        console.error(`[MCP:${entry.name}] stderr: ${safeError(entry, text)}`);
      });

  }

  // 入站字节流：优先按规范 NDJSON（\n 分隔）解析；兼容旧实现/特殊服务器的
  // Content-Length（LSP 风格）帧 —— 以 "Content-Length:" 开头时切换到帧解析。
  function feedStdioBytes(entry, chunk) {
    entry.buffer = Buffer.concat([entry.buffer, chunk]);
    if (entry.buffer.length > 32 * 1024 * 1024) {
      recordFailure(entry, new Error('MCP response exceeded 32 MiB'));
      teardownEntry(entry).catch(() => {});
      return;
    }
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
      console.warn(`[MCP:${entry.name}] unparseable inbound message: ${text.slice(0, 120)}`);
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
        if (buf.length > 32 * 1024 * 1024) throw new Error('MCP event exceeded 32 MiB');
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buf))) {
          const rawEvent = buf.slice(0, separator.index);
          buf = buf.slice(separator.index + separator[0].length);
          const dataLines = [];
          for (const line of rawEvent.split(/\r?\n/)) {
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
      signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(timeoutMs)])
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) entry.sessionId = sid;
    if (res.status === 202) return { status: 202 };
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      error.code = res.status === 404 && entry.sessionId ? 'MCP_SESSION_EXPIRED' : 'HTTP_' + res.status;
      throw error;
    }
    if (!msgObj.method || msgObj.id === undefined) { await res.body?.cancel(); return { status: res.status }; }
    if (ct.includes('text/event-stream')) {
      // 响应以 SSE 流返回：扫描事件直到出现与本请求 id 匹配的响应；
      // 途中出现的服务器请求/通知照常路由
      let message;
      const parser = createSseParser((data) => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { return; }
          if (parsed && parsed.id !== undefined && parsed.method === undefined &&
              msgObj && parsed.id === msgObj.id) {
            validateRpcResponse(parsed, msgObj);
            message = parsed;
          } else {
            handleIncomingMessage(entry, parsed);
          }
      });
      await consumeBody(res, (chunk) => { parser.push(chunk); return !message; });
      if (!message) throw new Error('HTTP 传输：SSE 流在收到响应前结束');
      return { status: res.status, message };
    }
    const message = await res.json();
    validateRpcResponse(message, msgObj);
    return { status: res.status, message };
  }

  function validateRpcResponse(message, requestMessage) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || message.id !== requestMessage.id || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) throw new Error('Invalid or mismatched JSON-RPC response');
  }

  async function consumeBody(res, onChunk) {
    if (!res.body) return;
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      // Returning from the iterator cancels the response body and releases its
      // connection, even when a server leaves the POST event stream open.
      if (onChunk(decoder.decode(chunk, { stream: true })) === false) return;
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
      signal: AbortSignal.any([ctrl.signal, entry.abort.signal])
    });
    if (res.status === 405) { await res.body?.cancel(); return false; } // Optional listener
    if (!res.ok) throw new Error('Listener HTTP ' + res.status);
    if (!(res.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('Listener did not return an SSE stream');
    const parser = createSseParser((data) => {
      try { handleIncomingMessage(entry, JSON.parse(data)); } catch { /* ignore */ }
    });
    await consumeBody(res, (chunk) => parser.push(chunk));
    return true;
  }

  async function startHttpTransport(entry) {
    const url = String(entry.config.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('HTTP 传输需要有效的 http(s) URL');
    const service = getVmService?.();
    const target = new URL(url);
    entry.localHttp = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    if (require('./vm/tool-location').isVmOperation(() => service) && entry.localHttp) {
      if (!service.instance || service.instance.state !== 'ready') await service.start();
      const forward = await service.forwardPort(Number(target.port) || (target.protocol === 'https:' ? 443 : 80));
      if (entry.abort.signal.aborted) { service.unforwardPort(forward.hostPort); throw new Error('Connection cancelled'); }
      entry.guestForward = forward.hostPort;
      target.hostname = '127.0.0.1';
      target.port = String(forward.hostPort);
      entry.config = { ...entry.config, url: target.href };
      entry.executionLocation = 'vm';
    } else entry.executionLocation = entry.localHttp ? 'host' : 'remote';
    // initialize 在 startMcpServer 统一发送；这里只做 URL 校验
  }

  async function httpDeleteSession(entry) {
    if (!entry.sessionId) return;
    try {
      const response = await fetch(entry.config.url, {
        method: 'DELETE',
        headers: httpHeaders(entry),
        signal: AbortSignal.timeout(5000)
      });
      await response.body?.cancel();
    } catch { /* 405/网络错误均忽略 */ }
  }

  // ---------- 生命周期 ----------

  function connectServer(config) {
    if (connecting.has(config.name)) return connecting.get(config.name);
    const pending = connectSingle(config).finally(() => { if (connecting.get(config.name) === pending) connecting.delete(config.name); });
    connecting.set(config.name, pending);
    return pending;
  }

  async function connectSingle(config) {
    failures.delete(config.name);
    const key = sanitizeServerKey(config.name);
    // 同 key 冲突消歧（不同原始名净化后相同的情况）
    let finalKey = key;
    let n = 2;
    while (mcpServers.has(finalKey) && mcpServers.get(finalKey).name !== config.name) {
      finalKey = `${key}-${n++}`;
    }
    if (mcpServers.has(finalKey)) { const old = mcpServers.get(finalKey); old.intentionalClose = true; await teardownEntry(old); }

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
      ,abort: new AbortController(), startedAt: Date.now(), stage: 'starting', progress: 10
    };
    mcpServers.set(finalKey, entry);
    emitChanged();
    const deadline = setTimeout(() => {
      recordFailure(entry, new Error('Connection timed out'));
      teardownEntry(entry).catch(() => {});
    }, Math.min(120000, Math.max(1000, Number(config.connectTimeoutMs) || 60000)));

    try {
      if (type === 'http') {
        await abortable(entry, startHttpTransport(entry));
      } else {
        await abortable(entry, startStdioTransport(entry));
      }
      if (entry.abort.signal.aborted) throw new Error('Connection cancelled');
      connectionState(entry, 'initialize', 35);
      // initialize：版本协商（发最新支持版本；服务器回它支持的版本，记录之）
      const initResult = await request(entry, 'initialize', {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Could-I-Be-Your-Partner', title: 'Could I Be Your Partner', version: appVersion }
      });
      if (!initResult?.protocolVersion || !initResult.capabilities) throw new Error('Server returned an invalid initialization result');
      if (initResult && initResult.protocolVersion) {
        entry.protocolVersion = String(initResult.protocolVersion);
        if (entry.protocolVersion !== SUPPORTED_PROTOCOL_VERSION &&
            !LEGACY_PROTOCOL_VERSIONS.includes(entry.protocolVersion)) {
          throw new Error(`Unsupported MCP protocol version: ${entry.protocolVersion}`);
        }
      }
      if (initResult && typeof initResult.instructions === 'string') {
        entry.instructions = initResult.instructions;
      }
      connectionState(entry, 'initialized', 55);
      await sendMessage(entry, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      connectionState(entry, 'tools', 65);
      await refreshTools(entry);
      if (entry.abort.signal.aborted) throw new Error('Connection cancelled');
      entry.status = 'connected';
      connectionState(entry, 'connected', 100);
      if (type === 'http') {
        const listen = async attempt => {
          try { if (!await openHttpListener(entry)) return; }
          catch (error) { if (!entry.abort.signal.aborted) { entry.warning = safeError(entry, error); emitChanged(); } }
          if (!entry.abort.signal.aborted && attempt < 3) entry.listenerRetry = setTimeout(() => listen(attempt+1), Math.min(10000, 1000 * 2 ** attempt));
        };
        listen(0).catch(() => {});
      }
      return { ok: true, tools: entry.tools, protocolVersion: entry.protocolVersion, serverInfo: initResult && initResult.serverInfo };
    } catch (e) {
      recordFailure(entry, e);
      await teardownEntry(entry);
      return { ok: false, error: safeError(entry, e) };
    } finally { clearTimeout(deadline); }
  }

  async function teardownEntry(entry) {
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
    entry.status = 'disconnected';
    clearTimeout(entry.listenerRetry);
    entry.abort.abort();
    rejectAllPending(entry, new Error('连接已关闭'));
    if (entry.type === 'http') {
      await httpDeleteSession(entry);
      if (entry.httpAbort) { try { entry.httpAbort.abort(); } catch { /* ignore */ } }
      if (entry.guestForward) getVmService?.()?.unforwardPort(entry.guestForward);
    } else {
      await shutdownStdio(entry);
    }
    if (mcpServers.get(entry.key) === entry) mcpServers.delete(entry.key);
    emitChanged();
    })();
    return entry.closing;
  }

  async function stopMcpServer(nameOrKey) {
    failures.delete(nameOrKey);
    const entry = [...mcpServers.values()].find(e => e.name === nameOrKey) || findEntryByNameOrKey(nameOrKey);
    if (!entry) return;
    entry.intentionalClose = true;
    await teardownEntry(entry);
  }

  async function stopAllMcpServers() {
    for (const entry of [...mcpServers.values()]) {
      entry.intentionalClose = true;
      await teardownEntry(entry);
    }
  }

  // ---------- 工具 ----------

  // 分页循环：cursor/nextCursor 直到取完（规范 2025-06-18）
  async function refreshTools(entry) {
    if (entry.refreshing) return entry.refreshing;
    entry.refreshing = (async () => {
    const tools = [];
    let cursor;
    const seen = new Set();
    do {
      const result = await request(entry, 'tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error('Server returned an invalid tools list');
      tools.push(...result.tools);
      cursor = result && result.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 1000) throw new Error('Server tools pagination did not advance');
        seen.add(cursor);
      }
    } while (cursor);
    entry.tools = tools;
    return tools;
    })().finally(() => { entry.refreshing = null; });
    return entry.refreshing;
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

  function validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'Invalid server configuration';
    if (typeof config.name !== 'string' || !config.name.trim()) return 'Server name is required';
    if (config.type && !['stdio', 'http'].includes(config.type)) return 'Unsupported transport';
    if (config.type === 'http') {
      try { if (!['http:', 'https:'].includes(new URL(config.url).protocol)) return 'HTTP server requires an HTTP(S) URL'; }
      catch { return 'HTTP server requires an HTTP(S) URL'; }
    } else if (typeof config.command !== 'string' || !config.command.trim()) return 'Command is required';
    if (config.args != null && (!Array.isArray(config.args) || config.args.some(v => typeof v !== 'string'))) return 'Arguments must be an array of strings';
    for (const field of ['env', 'headers']) {
      const value = config[field];
      if (value != null && (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string'))) return field + ' must be an object of strings';
    }
    if (config.cwd != null && typeof config.cwd !== 'string') return 'Working directory must be a string';
    for (const field of ['autoConnect', 'inheritEnv']) if (config[field] != null && typeof config[field] !== 'boolean') return field + ' must be a boolean';
    return null;
  }

  ipcMain.handle('mcp:listServers', () => {
    const mcpSettings = getMcpSettings();
    return mcpSettings.servers.map((s) => {
      const key = sanitizeServerKey(s.name);
      let entry = mcpServers.get(key);
      if (!entry || entry.name !== s.name) {
        for (const e of mcpServers.values()) if (e.name === s.name) { entry = e; break; }
      }
      if (entry?.name !== s.name) entry = null;
      const failure = failures.get(s.name);
      return {
        ...s,
        key: entry?.key || key,
        status: entry ? entry.status : failure ? 'error' : 'disconnected',
        stage: entry?.stage || failure?.stage || 'disconnected',
        progress: entry?.progress || 0,
        startedAt: entry?.startedAt || null,
        error: failure?.error || null,
        errorDetail: failure?.detail || null,
        warning: entry?.warning || null,
        toolCount: entry ? entry.tools.length : 0,
        executionLocation: entry?.executionLocation || null,
        protocolVersion: entry ? entry.protocolVersion : null
      };
    });
  });

  ipcMain.handle('mcp:addServer', async (_, serverConfig) => {
    const mcpSettings = getMcpSettings();
    const cfg = { ...serverConfig, name: typeof serverConfig?.name === 'string' ? serverConfig.name.trim() : '' };
    const error = validateConfig(cfg);
    if (error) return { ok: false, error };
    if (mcpSettings.servers.find((s) => s.name === cfg.name)) {
      return { ok: false, error: '同名服务器已存在' };
    }
    mcpSettings.servers.push(cfg);
    saveMcpSettings(mcpSettings);
    emitChanged();
    return { ok: true };
  });

  ipcMain.handle('mcp:removeServer', async (_, name) => {
    const mcpSettings = getMcpSettings();
    mcpSettings.servers = mcpSettings.servers.filter((s) => s.name !== name);
    saveMcpSettings(mcpSettings);
    emitChanged();
    await stopMcpServer(name);
    return { ok: true };
  });

  ipcMain.handle('mcp:updateServer', async (_, name, updates) => {
    const mcpSettings = getMcpSettings();
    const idx = mcpSettings.servers.findIndex((s) => s.name === name);
    if (idx === -1) return { ok: false, error: '服务器不存在' };
    const original = mcpSettings.servers[idx];
    const config = { ...original, ...updates };
    if (typeof config.name === 'string') config.name = config.name.trim();
    const error = validateConfig(config);
    if (error) return { ok: false, error };
    if (mcpSettings.servers.some((s, i) => i !== idx && s.name === config.name)) return { ok: false, error: '同名服务器已存在' };
    const entry = [...mcpServers.values()].find(e => e.name === name);
    const reconnect = entry && ['connected', 'connecting'].includes(entry.status);
    if (entry) { entry.intentionalClose = true; await teardownEntry(entry); }
    if (connecting.has(name)) await connecting.get(name);
    const currentSettings = getMcpSettings();
    const currentIndex = currentSettings.servers.indexOf(original);
    if (currentIndex === -1) return { ok: false, error: 'Server configuration changed or was removed during editing' };
    if (currentSettings.servers.some((s, i) => i !== currentIndex && s.name === config.name)) return { ok: false, error: '同名服务器已存在' };
    failures.delete(name);
    currentSettings.servers[currentIndex] = config;
    saveMcpSettings(currentSettings);
    emitChanged();
    // Keep an active connection active with the new configuration; leave an
    // intentionally disconnected server disconnected. Failed reconnects still
    // retain the saved configuration so the user can fix it and retry.
    if (reconnect) {
      const connected = await connectServer(config);
      return { ok: true, reconnected: true, connected: connected.ok, connectionError: connected.error };
    }
    return { ok: true, reconnected: false };
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
    const existing = findEntryByNameOrKey(serverName);
    const service = getVmService?.();
    if (existing && (existing.type === 'stdio' || existing.localHttp) && existing.executionLocation !== (require('./vm/tool-location').isVmOperation(() => service) ? 'vm':'host')) return { ok: false, error: '此 MCP 连接的运行位置已变化，请重新连接' };

    const entry = findEntryByNameOrKey(serverName);
    if (!entry || entry.status !== 'connected') {
      return { ok: false, error: `MCP 服务器 "${serverName}" 未连接` };
    }
    try {
      if (entry.executionLocation === 'vm') {
        const io = new (require('./vm/vm-fs').VmFs)({vmService:service});
        args = require('./vm/vm-tools').translateDeep(args || {}, value => io.strictPath(value));
      }
      const result = await request(entry, 'tools/call', { name: toolName, arguments: args || {} });
      const norm = normalizeToolResult(result);
      if (norm.isError) return { ok: false, error: norm.text, location: entry.executionLocation };
      if (norm.images.length) {
        const img = norm.images[0];
        return {
          ok: true,
          text: norm.text,
          location: entry.executionLocation,
          _multimodal: true,
          imageUrl: `data:${img.mime};base64,${img.data}`,
          extraImages: norm.images.slice(1).map((im) => `data:${im.mime};base64,${im.data}`)
        };
      }
      return { ok: true, text: norm.text, location: entry.executionLocation };
    } catch (e) {
      if (e.code === 'MCP_SESSION_EXPIRED') {
        const config = getMcpSettings().servers.find(s => s.name === entry.name);
        if (config) await connectServer(config);
      }
      return { ok: false, error: safeError(entry, e), location: entry.executionLocation };
    }
  });

  ipcMain.handle('mcp:getStatus', () => {
    const statuses = {};
    for (const [key, entry] of mcpServers) {
      statuses[key] = { status: entry.status, tools: entry.tools.length, name: entry.name, protocolVersion: entry.protocolVersion, executionLocation: entry.executionLocation };
    }
    return statuses;
  });

  return { getMcpSettings, startMcpServer: connectServer, stopMcpServer, stopAllMcpServers };
};
