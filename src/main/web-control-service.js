/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * Web Control Service: Express + WebSocket server for remote control
 * Provides: chat, approval, conversation history, status monitoring
 */

const express = require('express');
const expressWs = require('express-ws');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');

class WebControlService {
  constructor() {
    this.app = null;
    this.server = null;
    this.wsClients = new Set();
    this.config = null;
    this.running = false;
    this.port = 0;

    // Callbacks set by main process
    this.onNewChat = null;        // () => conversationId
    this.onSendMessage = null;    // (message) => void
    this.onGetHistory = null;     // () => [{id, title, date}]
    this.onGetConversation = null; // (id) => {messages}
    this.onDeleteConversation = null; // (id) => void
    this.onApprovalResponse = null;   // (approved) => void
    this.onGetStatus = null;      // () => {status, running, ...}
    this.onGetSettings = null;    // () => settings
    this.onStopAgent = null;      // () => void
    this.onLoadConversation = null; // (id) => void  — triggers host to load this conversation
    // DOM Mirror callbacks
    this.onMirrorInit = null;  // () => void — WS client connected, request renderer to push mirror snapshot
    this.onUiEvent = null;     // (data) => void — WebUI UI event forwarded to renderer

    // Upload directory — set by main.js to workspace base dir
    this.workDir = null;

    // State pushed from Electron
    this._pendingApproval = null;
    this._agentStatus = 'idle';
    this._currentMessages = [];
    this._currentConversationId = null;
    this._currentTheme = null;   // { accent, accentLight, ... }
    this._currentTarot = null;   // tarot card object
    this._currentTitle = '';     // conversation title
    this._currentAvatars = null;  // { ai, user } base64 data URLs
  }

  configure(webSettings) {
    this.config = {
      port: parseInt(webSettings.port) || 3456,
      password: webSettings.password || '',
      passwordHash: webSettings.passwordHash || '',
      enable2FA: !!webSettings.enable2FA,
      totpSecret: webSettings.totpSecret || '',
    };
  }

  async hashPassword(plain) {
    return bcrypt.hash(plain, 10);
  }

  async generateTOTPSecret() {
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: 'CIBYP-WebControl',
      label: 'WebControl',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    const uri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(uri);
    return { secret: secret.base32, uri, qrDataUrl };
  }

  verifyTOTP(code) {
    if (!this.config?.totpSecret) return false;
    const totp = new TOTP({
      issuer: 'CIBYP-WebControl',
      label: 'WebControl',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(this.config.totpSecret),
    });
    const delta = totp.validate({ token: code.trim(), window: 2 });
    return delta !== null;
  }

  async start() {
    if (this.running) return { ok: true, message: '已在运行' };
    if (!this.config?.passwordHash && !this.config?.password) {
      throw new Error('必须设置访问密码');
    }

    // Hash password if only plain is provided
    if (this.config.password && !this.config.passwordHash) {
      this.config.passwordHash = await this.hashPassword(this.config.password);
    }

    const app = express();
    const sessionSecret = crypto.randomBytes(32).toString('hex');

    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use(session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24h
    }));

    // Enable WebSocket
    const wsInstance = expressWs(app);

    // CORS: allow the Electron renderer (cross-origin) to call HTTP endpoints.
    // We do NOT use cookies for cross-origin auth — WS uses an auth message —
    // so 'Access-Control-Allow-Origin: *' without credentials is sufficient.
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });

    // Serve FontAwesome from local assets
    // CSS 内部 url(../webfonts/...) 在 /static/fa/ 下解析为 /static/webfonts/...
    // 所以必须同时挂载 webfonts 目录，否则字体文件 404。
    const faDir = path.join(__dirname, '../../assets/fonts');
    const webfontsDir = path.join(__dirname, '../../assets/webfonts');
    app.use('/static/fa', express.static(faDir));
    app.use('/static/webfonts', express.static(webfontsDir));
    // 镜像模式：渲染器 CSS / 资源 / KaTeX 通过相对路径请求，需静态挂载
    const rendererCssDir = path.join(__dirname, '..', 'renderer', 'css');
    const assetsDir = path.join(__dirname, '..', '..', 'assets');
    const katexDir = path.join(__dirname, '..', '..', 'node_modules', 'katex', 'dist');
    app.use('/css', express.static(rendererCssDir));
    app.use('/assets', express.static(assetsDir));
    app.use('/node_modules/katex/dist', express.static(katexDir));

    // Auth middleware
    const requireAuth = (req, res, next) => {
      if (req.session?.authenticated) return next();
      // express-ws 将 WS 升级请求路径改写为 /ws/.websocket，需放行 /ws 及其子路径
      if (req.path === '/api/login' || req.path === '/login' || req.path === '/' ||
          req.path.startsWith('/ws') ||
          req.path.startsWith('/static') || req.path.startsWith('/css') ||
          req.path.startsWith('/assets') || req.path.startsWith('/node_modules/katex/dist')) return next();
      res.status(401).json({ ok: false, error: '未登录' });
    };

    app.use(requireAuth);

    // ---- Auth Routes ----
    app.post('/api/login', async (req, res) => {
      const { password, totpCode } = req.body;
      if (!password) return res.json({ ok: false, error: '请输入密码' });

      const valid = await bcrypt.compare(password, this.config.passwordHash);
      if (!valid) return res.json({ ok: false, error: '密码错误' });

      if (this.config.enable2FA) {
        if (!totpCode) return res.json({ ok: false, error: '请输入2FA验证码', need2FA: true });
        if (!this.verifyTOTP(totpCode)) return res.json({ ok: false, error: '2FA验证码错误', need2FA: true });
      }

      req.session.authenticated = true;
      console.log('[WebControl] User authenticated from', req.ip);
      res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      req.session.destroy();
      res.json({ ok: true });
    });

    app.get('/api/auth-check', (req, res) => {
      res.json({ ok: true, authenticated: !!req.session?.authenticated, need2FA: !!this.config.enable2FA });
    });

    // ---- Theme ----
    app.get('/api/theme', (req, res) => {
      res.json({ ok: true, theme: this._currentTheme });
    });

    // ---- Avatars ----
    app.get('/api/avatars', (req, res) => {
      res.json({ ok: true, avatars: this._currentAvatars });
    });

    // ---- Status ----
    app.get('/api/status', (req, res) => {
      res.json({
        ok: true,
        agentStatus: this._agentStatus,
        conversationId: this._currentConversationId,
        title: this._currentTitle,
        tarot: this._currentTarot,
        pendingApproval: this._pendingApproval ? {
          toolName: this._pendingApproval.toolName,
          args: this._pendingApproval.args,
        } : null,
      });
    });

    // ---- Conversations ----
    app.get('/api/history', async (req, res) => {
      try {
        const history = this.onGetHistory ? await this.onGetHistory() : [];
        res.json({ ok: true, history });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.get('/api/conversation/:id', async (req, res) => {
      try {
        const conv = this.onGetConversation ? await this.onGetConversation(req.params.id) : null;
        res.json({ ok: true, conversation: conv });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.delete('/api/conversation/:id', async (req, res) => {
      try {
        if (this.onDeleteConversation) await this.onDeleteConversation(req.params.id);
        res.json({ ok: true });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    // ---- Chat ----
    app.post('/api/chat/new', async (req, res) => {
      try {
        const id = this.onNewChat ? await this.onNewChat() : null;
        res.json({ ok: true, conversationId: id });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.post('/api/chat/send', async (req, res) => {
      try {
        const { message } = req.body;
        if (!message) return res.json({ ok: false, error: '消息不能为空' });
        if (this.onSendMessage) await this.onSendMessage(message);
        res.json({ ok: true });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    app.post('/api/chat/stop', async (req, res) => {
      try {
        if (this.onStopAgent) await this.onStopAgent();
        res.json({ ok: true });
      } catch (e) {
        res.json({ ok: false, error: e.message });
      }
    });

    // ---- File Upload ----
    app.post('/api/upload-attachment', async (req, res) => {
      try {
        const { name, type, data } = req.body;
        const result = this._saveUpload(name, type, data);
        if (result.ok) res.json(result);
        else res.json({ ok: false, error: result.error });
      } catch (e) {
        console.error('[WebControl] Upload error:', e.message);
        res.json({ ok: false, error: e.message });
      }
    });

    // ---- Approval ----
    app.post('/api/approval/respond', (req, res) => {
      const { approved } = req.body;
      if (this.onApprovalResponse) {
        this.onApprovalResponse(!!approved);
        this._pendingApproval = null;
      }
      res.json({ ok: true });
    });

    // ---- Messages (current conversation) ----
    app.get('/api/messages', (req, res) => {
      res.json({ ok: true, messages: this._currentMessages });
    });

    // ---- Delete a turn (user + matching assistant) ----
    app.post('/api/chat/delete-turn', (req, res) => {
      const { timestamp } = req.body;
      if (!timestamp) return res.json({ ok: false, error: 'Missing timestamp' });
      const msgs = this._currentMessages;
      const idx = msgs.findIndex(m => m.timestamp === timestamp);
      if (idx === -1) return res.json({ ok: false, error: 'Message not found' });
      const msg = msgs[idx];
      let startIdx = idx, endIdx = idx;
      if (msg.role === 'user') {
        // Extend forward to cover matching assistant (skip system messages in between)
        for (let i = idx + 1; i < msgs.length; i++) {
          if (msgs[i].role === 'assistant') { endIdx = i; break; }
          if (msgs[i].role === 'user') break;
        }
      } else if (msg.role === 'assistant') {
        // Extend backward to cover matching user (skip system messages in between)
        for (let i = idx - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') { startIdx = i; break; }
          if (msgs[i].role === 'assistant') break;
        }
      }
      this._currentMessages.splice(startIdx, endIdx - startIdx + 1);
      this.broadcast({ type: 'messagesSync', messages: this._currentMessages });
      res.json({ ok: true });
    });

    // ---- WebSocket for real-time updates ----
    // 同源 WebUI 通过 session cookie 认证；跨源客户端（Electron Remote 模式）
    // 无法携带 cookie，因此允许先建立连接，再通过首条 'auth' 消息完成认证。
    app.ws('/ws', (ws, req) => {
      ws._authenticated = !!req.session?.authenticated;
      if (ws._authenticated) {
        this._attachWsClient(ws);
      } else {
        // 未认证：等待 auth 消息，10 秒超时自动关闭
        ws._authTimer = setTimeout(() => {
          if (!ws._authenticated) { try { ws.close(4001, '认证超时'); } catch {} }
        }, 10000);
      }

      ws.on('close', () => {
        if (ws._authTimer) { clearTimeout(ws._authTimer); ws._authTimer = null; }
        this.wsClients.delete(ws);
        console.log('[WebControl] WS client disconnected, total:', this.wsClients.size);
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          this._handleWsMessage(ws, msg);
        } catch (e) {
          console.error('[WebControl] WS message error:', e.message);
        }
      });
    });

    // ---- Serve Web UI ----
    app.get('/', (req, res) => {
      res.send(this._getHtml());
    });

    // Start server
    return new Promise((resolve, reject) => {
      try {
        this.server = app.listen(this.config.port, () => {
          this.running = true;
          this.port = this.config.port;
          this.app = app;
          console.log(`[WebControl] Server started on port ${this.config.port}`);
          resolve({ ok: true, port: this.config.port, message: `Web控制已启动: http://localhost:${this.config.port}` });
        });
        this.server.on('error', (e) => {
          console.error('[WebControl] Server error:', e.message);
          reject(e);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async stop() {
    if (!this.running) return { ok: true };
    return new Promise((resolve) => {
      for (const ws of this.wsClients) {
        try { ws.close(); } catch {}
      }
      this.wsClients.clear();
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          this.server = null;
          this.app = null;
          console.log('[WebControl] Server stopped');
          resolve({ ok: true });
        });
      } else {
        this.running = false;
        resolve({ ok: true });
      }
    });
  }

  // ---- Push updates to all WebSocket clients ----

  broadcast(data) {
    const json = JSON.stringify(data);
    for (const ws of this.wsClients) {
      try {
        if (ws.readyState === 1) ws.send(json);
      } catch {}
    }
  }

  pushMessage(role, content, extra = {}) {
    const msg = { role, content, timestamp: Date.now(), ...extra };
    this._currentMessages.push(msg);
    this.broadcast({ type: 'message', message: msg });
  }

  pushStatus(status) {
    this._agentStatus = status;
    this.broadcast({ type: 'status', agentStatus: status });
  }

  pushApproval(toolName, args) {
    this._pendingApproval = { toolName, args };
    this.broadcast({ type: 'approval', toolName, args });
  }

  clearApproval() {
    this._pendingApproval = null;
    this.broadcast({ type: 'approvalCleared' });
  }

  pushToolCall(toolName, args, status, result) {
    this.broadcast({ type: 'toolCall', toolName, args, status, result: typeof result === 'string' ? result : JSON.stringify(result) });
  }

  pushConversationSwitch(conversationId) {
    this._currentConversationId = conversationId;
    this._currentMessages = [];
    this.broadcast({ type: 'conversationSwitch', conversationId });
  }

  pushHistoryMessages(messages) {
    this._currentMessages = messages || [];
    this.broadcast({ type: 'messagesSync', messages: this._currentMessages });
  }

  pushTheme(vars) {
    this._currentTheme = vars;
    this.broadcast({ type: 'theme', theme: vars });
  }

  pushTarot(card) {
    this._currentTarot = card;
    this.broadcast({ type: 'tarot', card });
  }

  pushTitle(title) {
    this._currentTitle = title || '';
    this.broadcast({ type: 'title', title: this._currentTitle });
  }

  pushAvatars(avatars) {
    this._currentAvatars = avatars;
    this.broadcast({ type: 'avatars', avatars });
  }

  // 模式切换同步：渲染器 → 主进程 → WS 广播 → WebUI
  pushModeSwitch(mode) {
    this._currentMode = mode;
    this.broadcast({ type: 'modeSwitch', mode });
  }

  // 上下文进度更新（圆扇形指示器）：{used, max, percentage, details}
  pushContextProgress(data) {
    this._currentContextProgress = data;
    this.broadcast({ type: 'contextProgress', data });
  }

  // 重新优化按钮可见性同步
  pushReoptimizeState(visible) {
    this._reoptimizeVisible = !!visible;
    this.broadcast({ type: 'reoptimizeState', visible: !!visible });
  }

  // DOM 镜像更新：渲染器 → WS 广播（mirror_head / mirror_body）
  pushMirrorUpdate(data) {
    this.broadcast(data);
  }

  // 将已认证的 ws 加入客户端集合并发送 init 快照
  _attachWsClient(ws) {
    this.wsClients.add(ws);
    console.log('[WebControl] WS client connected, total:', this.wsClients.size);
    try {
      ws.send(JSON.stringify({
        type: 'init',
        agentStatus: this._agentStatus,
        conversationId: this._currentConversationId,
        messages: this._currentMessages,
        pendingApproval: this._pendingApproval,
        theme: this._currentTheme,
        tarot: this._currentTarot,
        title: this._currentTitle,
        avatars: this._currentAvatars,
      }));
    } catch {}
    // 通知渲染器推送 DOM 镜像快照（mirror_head + mirror_body）
    try { if (this.onMirrorInit) this.onMirrorInit(); } catch {}
  }

  // 保存上传文件到工作目录（HTTP 与 WS 上传共用）
  _saveUpload(name, type, data) {
    if (!name || !data) return { ok: false, error: '缺少文件信息' };
    const base64Data = data.replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(base64Data, 'base64');
    const safeName = name.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, 100);
    const saveDir = this.workDir || os.tmpdir();
    if (this.workDir && !fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }
    const savePath = path.join(saveDir, safeName);
    fs.writeFileSync(savePath, buf);
    console.log('[WebControl] File uploaded to workspace:', savePath, 'size:', buf.length);
    return { ok: true, path: savePath, name, type };
  }

  _handleWsMessage(ws, msg) {
    // 未认证连接只允许 auth 消息
    if (!ws._authenticated && msg.type !== 'auth') return;
    switch (msg.type) {
      // 跨源认证：用密码 + 可选 TOTP 完成握手
      case 'auth': {
        if (ws._authenticated) return;
        const { password, totpCode } = msg;
        // 认证失败：先发 auth_fail 让客户端清旧凭据/显示错误，再关闭连接
        const fail = (err) => { try { ws.send(JSON.stringify({ type: 'auth_fail', error: err })); } catch {} try { ws.close(4003, err); } catch {} };
        if (!password) { fail('缺少密码'); return; }
        bcrypt.compare(password, this.config.passwordHash).then((ok) => {
          if (!ok) { fail('密码错误'); return; }
          if (this.config.enable2FA) {
            if (!totpCode || !this.verifyTOTP(totpCode)) {
              fail('2FA验证码错误'); return;
            }
          }
          ws._authenticated = true;
          if (ws._authTimer) { clearTimeout(ws._authTimer); ws._authTimer = null; }
          this._attachWsClient(ws);
        }).catch(() => { fail('认证失败'); });
        return;
      }
      case 'sendMessage':
        if (msg.message && this.onSendMessage) this.onSendMessage(msg.message);
        break;
      case 'newChat':
        if (this.onNewChat) this.onNewChat();
        break;
      case 'approvalResponse':
        if (this.onApprovalResponse) {
          this.onApprovalResponse(!!msg.approved);
          this._pendingApproval = null;
        }
        break;
      case 'stopAgent':
        if (this.onStopAgent) this.onStopAgent();
        break;
      case 'loadConversation':
        if (msg.id && this.onLoadConversation) this.onLoadConversation(msg.id);
        break;
      // 切换模式：WebUI → 主进程 → IPC → 渲染器
      case 'switchMode':
        if (msg.mode && this.onSwitchMode) this.onSwitchMode(msg.mode);
        break;
      // 重新优化工具选择
      case 'reoptimizeTools':
        if (this.onReoptimizeTools) this.onReoptimizeTools();
        break;
      // DOM 镜像：WebUI UI 事件转发到渲染器
      case 'ui_event':
        if (this.onUiEvent) this.onUiEvent(msg);
        break;
      // WebUI 请求当前状态快照（模式、上下文进度、重新优化按钮可见性）
      case 'requestState':
        try {
          ws.send(JSON.stringify({
            type: 'stateSnapshot',
            mode: this._currentMode || 'chat',
            contextProgress: this._currentContextProgress || null,
            reoptimizeVisible: !!this._reoptimizeVisible,
          }));
        } catch {}
        break;
      // 远程客户端请求历史对话列表
      case 'getHistory':
        Promise.resolve(this.onGetHistory ? this.onGetHistory() : [])
          .then((history) => { try { ws.send(JSON.stringify({ type: 'history', history: history || [] })); } catch {} })
          .catch((e) => { try { ws.send(JSON.stringify({ type: 'history', history: [], error: e.message })); } catch {} });
        break;
      // 远程客户端删除对话
      case 'deleteConversation':
        if (msg.id) {
          Promise.resolve(this.onDeleteConversation ? this.onDeleteConversation(msg.id) : null)
            .then(() => { try { ws.send(JSON.stringify({ type: 'conversationDeleted', id: msg.id, ok: true })); } catch {} })
            .catch((e) => { try { ws.send(JSON.stringify({ type: 'conversationDeleted', id: msg.id, ok: false, error: e.message })); } catch {} });
        }
        break;
      // 远程客户端上传附件（跨源无法用 HTTP + cookie，故走 WS）
      case 'uploadAttachment':
        try {
          const r = this._saveUpload(msg.name, msg.type, msg.data);
          ws.send(JSON.stringify({ type: 'uploadResult', ...r }));
        } catch (e) {
          try { ws.send(JSON.stringify({ type: 'uploadResult', ok: false, error: e.message })); } catch {}
        }
        break;
    }
  }

  // ---- Inline HTML for Web UI (DOM Mirror) ----
  // 最小化壳页面：CSS/HTML 由渲染器通过 mirror_head / mirror_body 消息推送
  // 事件委托捕获 click/input/change/submit，生成 CSS path 转发到渲染器执行
  _getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CIBYP Web Control</title>
<link rel="stylesheet" href="/static/fa/fontawesome.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#app{height:100vh;display:flex}
#mirror-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg-primary,#f5f7fa);color:var(--text-secondary,#666);font-size:14px;z-index:99999;flex-direction:column;gap:12px}
#mirror-loading.hidden{display:none}
#mirror-loading .spinner{width:32px;height:32px;border:3px solid var(--border,#ddd);border-top-color:var(--accent,#4f8cff);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#login-overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);z-index:99998}
#login-overlay.show{display:flex}
#login-box{background:var(--bg-primary,#fff);padding:24px 32px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);width:320px}
#login-box h2{font-size:16px;margin-bottom:16px;color:var(--text-primary,#333);text-align:center}
#login-box input{width:100%;padding:10px 12px;border:1px solid var(--border,#ddd);border-radius:6px;font-size:14px;margin-bottom:10px;outline:none;background:var(--bg-secondary,#fff);color:var(--text-primary,#333)}
#login-box input:focus{border-color:var(--accent,#4f8cff)}
#login-box button{width:100%;padding:10px;border:none;border-radius:6px;background:var(--accent,#4f8cff);color:#fff;font-size:14px;cursor:pointer}
#login-box button:hover{opacity:.9}
#login-box .err{color:#e74c3c;font-size:12px;margin-bottom:8px;display:none}
</style>
</head>
<body>
<div id="mirror-loading"><div class="spinner"></div><div>正在同步界面...</div></div>
<div id="login-overlay"><div id="login-box"><h2>WebUI 登录</h2><div class="err" id="login-err"></div><input type="password" id="login-pw" placeholder="访问密码"><input type="text" id="login-totp" placeholder="2FA 验证码（可选）"><button id="login-btn">登录</button></div></div>
<div id="app"></div>
<script>
(function(){
  var ws=null,authenticated=false,applyingRemote=false,reconnectTimer=null;
  var loginOverlay=document.getElementById('login-overlay');
  var loginErr=document.getElementById('login-err');
  var loadingEl=document.getElementById('mirror-loading');

  function getStoredCreds(){
    try{var s=sessionStorage.getItem('cibyp_creds');if(s)return JSON.parse(s);}catch(e){}
    return null;
  }
  function storeCreds(c){try{sessionStorage.setItem('cibyp_creds',JSON.stringify(c));}catch(e){}}

  function connect(){
    var proto=location.protocol==='https:'?'wss:':'ws:';
    var sock=new WebSocket(proto+'//'+location.host+'/ws');
    ws=sock;
    sock.onopen=function(){
      var c=getStoredCreds();
      if(c&&c.password){
        sock.send(JSON.stringify({type:'auth',password:c.password,totpCode:c.totpCode||''}));
      }else{
        showLogin();
      }
    };
    sock.onmessage=function(ev){
      var msg;try{msg=JSON.parse(ev.data);}catch(e){return;}
      handle(msg);
    };
    sock.onclose=function(){
      if(ws!==sock)return; // 旧连接关闭，不覆盖新连接
      ws=null;
      if(!authenticated){
        // 清除旧凭据，防止 onopen 用错误凭据自动重连形成死循环
        sessionStorage.removeItem('cibyp_creds');
        showLogin();
      }
      if(reconnectTimer)clearTimeout(reconnectTimer);
      reconnectTimer=setTimeout(connect,2000);
    };
    sock.onerror=function(){};
  }

  function showLogin(){
    loadingEl.classList.add('hidden');
    loginOverlay.classList.add('show');
    loginErr.style.display='none';
  }

  document.getElementById('login-btn').onclick=function(){
    var pw=document.getElementById('login-pw').value;
    var totp=document.getElementById('login-totp').value;
    if(!pw){loginErr.textContent='请输入密码';loginErr.style.display='block';return;}
    loginErr.style.display='none';
    // 清除旧凭据，防止 onopen 用错误凭据自动重连与手动登录竞态
    sessionStorage.removeItem('cibyp_creds');
    if(!ws||ws.readyState!==1)connect();
    function tryAuth(){
      if(ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:'auth',password:pw,totpCode:totp||''}));
        storeCreds({password:pw,totpCode:totp||''});
      }else{setTimeout(tryAuth,200);}
    }
    setTimeout(tryAuth,300);
  };
  document.getElementById('login-pw').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('login-btn').click();});
  document.getElementById('login-totp').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('login-btn').click();});

  function handle(msg){
    switch(msg.type){
      case 'init':
        authenticated=true;
        loginOverlay.classList.remove('show');
        if(msg.theme)applyThemeVars(msg.theme);
        break;
      case 'mirror_head':
        applyHead(msg);
        loadingEl.classList.add('hidden');
        break;
      case 'mirror_body':
        applyBody(msg.html);
        break;
      case 'theme':
        applyThemeVars(msg.theme);
        break;
      case 'auth_fail':
        authenticated=false;
        loginErr.textContent=msg.error||'认证失败';
        loginErr.style.display='block';
        loginOverlay.classList.add('show');
        loadingEl.classList.add('hidden');
        sessionStorage.removeItem('cibyp_creds');
        break;
      // 其他消息类型（status/message/toolCall/approval 等）由镜像 DOM 自动体现
    }
  }

  function applyThemeVars(t){
    if(!t)return;
    var root=document.documentElement;
    var map={
      accent:'--accent',accentLight:'--accent-light',accentDark:'--accent-dark',
      accentBg:'--accent-bg',accentBgHover:'--accent-bg-hover',
      bgPrimary:'--bg-primary',bgSecondary:'--bg-secondary',bgTertiary:'--bg-tertiary',bgHover:'--bg-hover'
    };
    for(var k in map){if(t[k])root.style.setProperty(map[k],t[k]);}
  }

  function applyHead(msg){
    var html=msg.html||'';
    // 去除 <script> 标签
    html=html.replace(/<script[\\s\\S]*?<\\/script>/gi,'');
    // 同步 data-theme
    if(msg.theme_mode)document.documentElement.setAttribute('data-theme',msg.theme_mode);
    var head=document.head;
    // 移除已有的渲染器 CSS（保留 FA 链接和壳样式）
    var toRemove=head.querySelectorAll('link:not([href*="fontawesome"]),style:not([data-shell])');
    for(var i=0;i<toRemove.length;i++)toRemove[i].remove();
    // 插入渲染器 head 内容
    var tmp=document.createElement('div');
    tmp.innerHTML=html;
    var nodes=tmp.querySelectorAll('link,style');
    for(var j=0;j<nodes.length;j++)head.appendChild(nodes[j].cloneNode(true));
    loadingEl.classList.add('hidden');
  }

  function applyBody(bodyHtml){
    applyingRemote=true;
    var app=document.getElementById('app');
    // 捕获滚动位置
    var scrolls=[];
    if(app){
      var all=app.querySelectorAll('*');
      for(var i=0;i<all.length;i++){
        var el=all[i];
        if(el.scrollTop>0||el.scrollLeft>0){
          var p=cssPath(el);
          if(p)scrolls.push({path:p,top:el.scrollTop,left:el.scrollLeft});
        }
      }
    }
    app.innerHTML=bodyHtml;
    // 恢复滚动位置
    for(var k=0;k<scrolls.length;k++){
      var s=scrolls[k];
      var el=document.querySelector(s.path);
      if(el){el.scrollTop=s.top;el.scrollLeft=s.left;}
    }
    // canvas 替换为占位符
    var canvases=app.querySelectorAll('canvas');
    for(var c=0;c<canvases.length;c++){
      var cv=canvases[c];
      var div=document.createElement('div');
      div.style.cssText='width:'+(cv.style.width||'100%')+';height:'+(cv.style.height||'200px')+';min-height:100px;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary,#ebebeb);color:var(--text-tertiary,#999);font-size:12px;border-radius:4px;';
      div.textContent='[Canvas 内容不可镜像]';
      if(cv.parentNode)cv.parentNode.replaceChild(div,cv);
    }
    setTimeout(function(){applyingRemote=false;},50);
  }

  // CSS path 生成
  function cssPath(el){
    if(!el||el.nodeType!==1)return'';
    if(el.id)return'#'+el.id;
    var parts=[];
    var cur=el;
    while(cur&&cur.nodeType===1&&cur!==document.documentElement){
      var selector=cur.nodeName.toLowerCase();
      if(cur.id){parts.unshift('#'+cur.id);break;}
      var parent=cur.parentNode;
      if(parent&&parent.children){
        var typeIdx=1;
        var sib=cur.previousElementSibling;
        while(sib){
          if(sib.nodeName.toLowerCase()===selector)typeIdx++;
          sib=sib.previousElementSibling;
        }
        var sameType=0;
        for(var si=0;si<parent.children.length;si++){
          if(parent.children[si].nodeName.toLowerCase()===selector)sameType++;
        }
        if(sameType>1)selector+=':nth-of-type('+typeIdx+')';
      }
      if(cur.className&&typeof cur.className==='string'){
        var cls=cur.className.trim().split(/\\s+/).slice(0,2).join('.');
        if(cls)selector+='.'+cls;
      }
      parts.unshift(selector);
      cur=cur.parentNode;
    }
    return parts.join(' > ');
  }

  // 事件委托：捕获 click/input/change/submit
  function sendEvent(evtType,target,extra){
    if(applyingRemote||!ws||ws.readyState!==1)return;
    if(target.closest('#mirror-loading')||target.closest('#login-overlay'))return;
    var path=cssPath(target);
    if(!path)return;
    var data={type:'ui_event',event:evtType,target:path};
    if(extra)for(var k in extra)data[k]=extra[k];
    ws.send(JSON.stringify(data));
  }

  document.addEventListener('click',function(e){
    if(applyingRemote)return;
    if(e.target.closest('a'))e.preventDefault();
    sendEvent('click',e.target);
  },true);

  document.addEventListener('input',function(e){
    if(applyingRemote)return;
    sendEvent('input',e.target,{value:e.target.value});
  },true);

  document.addEventListener('change',function(e){
    if(applyingRemote)return;
    sendEvent('change',e.target,{value:e.target.value,checked:e.target.checked});
  },true);

  document.addEventListener('submit',function(e){
    if(applyingRemote)return;
    e.preventDefault();
    sendEvent('submit',e.target);
  },true);

  connect();
})();
</script>
</body>
</html>`;
  }
}

module.exports = { WebControlService };
