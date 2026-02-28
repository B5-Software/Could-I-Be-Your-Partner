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

    // Serve FontAwesome from local assets
    const faDir = path.join(__dirname, '../../assets/fonts');
    app.use('/static/fa', express.static(faDir));

    // Auth middleware
    const requireAuth = (req, res, next) => {
      if (req.session?.authenticated) return next();
      if (req.path === '/api/login' || req.path === '/login' || req.path === '/' || req.path.startsWith('/static')) return next();
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
        if (!name || !data) return res.json({ ok: false, error: '缺少文件信息' });

        const base64Data = data.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        const safeName = name.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, 100);
        // Save to workspace base dir (instead of system temp)
        const saveDir = this.workDir || os.tmpdir();
        if (this.workDir && !fs.existsSync(this.workDir)) {
          fs.mkdirSync(this.workDir, { recursive: true });
        }
        const savePath = path.join(saveDir, safeName);
        fs.writeFileSync(savePath, buf);
        console.log('[WebControl] File uploaded to workspace:', savePath, 'size:', buf.length);
        res.json({ ok: true, path: savePath, name, type });
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
    app.ws('/ws', (ws, req) => {
      if (!req.session?.authenticated) {
        ws.close(4001, '未登录');
        return;
      }
      this.wsClients.add(ws);
      console.log('[WebControl] WS client connected, total:', this.wsClients.size);

      // Send initial state
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

      ws.on('close', () => {
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

  _handleWsMessage(ws, msg) {
    switch (msg.type) {
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
    }
  }

  // ---- Inline HTML for Web UI ----
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
:root{
  --accent:#2a9d8f;--accent-light:#4db8ab;--accent-dark:#1d7068;
  --accent-bg:rgba(42,157,143,.08);--accent-bg-hover:rgba(42,157,143,.14);
  --bg-primary:#f5f7fa;--bg-secondary:#ebebeb;--bg-tertiary:#e5e5e5;--bg-hover:#f0f0f0;
  --text:#1a1a2a;--text2:#666;--border:#d8d8d8;
  --danger:#e74c3c;--success:#27ae60;--radius:8px;
}
[data-theme="dark"]{
  --text:#e0e0e0;--text2:#888;--border:#333;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg-primary);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;transition:background .2s,color .2s}
a{color:var(--accent);text-decoration:none}

/* Login */
.login-overlay{position:fixed;inset:0;background:var(--bg-primary);display:flex;align-items:center;justify-content:center;z-index:9999}
.login-box{background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:32px;width:360px;max-width:90vw}
.login-box h2{text-align:center;margin-bottom:20px;color:var(--accent);font-size:20px}
.login-box input{width:100%;padding:10px 12px;margin-bottom:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-tertiary);color:var(--text);font-size:14px;outline:none;transition:border-color .15s}
.login-box input:focus{border-color:var(--accent)}
.login-box button{width:100%;padding:10px;border:none;border-radius:var(--radius);background:var(--accent);color:#fff;font-size:14px;cursor:pointer;font-weight:600;transition:opacity .15s}
.login-box button:hover{opacity:.88}
.login-box .error{color:var(--danger);font-size:13px;margin-bottom:8px;text-align:center;min-height:18px}
.login-box .totp-row{display:none}

/* Header */
header{background:var(--bg-secondary);border-bottom:1px solid var(--border);padding:0 20px;display:flex;align-items:center;gap:12px;flex-shrink:0;height:52px}
.header-brand{font-size:16px;font-weight:700;color:var(--accent);white-space:nowrap}
.header-title{font-size:14px;font-weight:600;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-tarot{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);background:var(--accent-bg);border:1px solid var(--border);border-radius:20px;padding:4px 10px;white-space:nowrap;flex-shrink:0}
.header-tarot.hidden{display:none}
.header-tarot .tarot-icon{color:var(--accent)}
.tarot-trng{display:inline-flex;align-items:center;gap:3px;background:rgba(255,165,0,.15);border:1px solid rgba(255,165,0,.3);color:#e67e22;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:4px}
.header-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);flex-shrink:0}
.header-status .dot{width:8px;height:8px;border-radius:50%;background:var(--text2)}
.header-status .dot.idle{background:var(--success)}
.header-status .dot.working{background:var(--accent);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.btn-icon-sm{padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-tertiary);color:var(--text2);font-size:12px;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn-icon-sm:hover{border-color:var(--accent);color:var(--accent)}

/* Layout */
.main-layout{display:flex;flex:1;overflow:hidden}

/* Sidebar */
.sidebar{width:240px;border-right:1px solid var(--border);background:var(--bg-secondary);display:flex;flex-direction:column;flex-shrink:0;transition:background .2s}
.sidebar-header{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.sidebar-header h3{font-size:13px;font-weight:600;color:var(--text2)}
.btn-new{padding:4px 10px;border:1px solid var(--accent);border-radius:var(--radius);background:transparent;color:var(--accent);font-size:12px;cursor:pointer;transition:background .15s}
.btn-new:hover{background:var(--accent-bg)}
.history-list{flex:1;overflow-y:auto;padding:6px}
.history-item{padding:9px 10px;border-radius:var(--radius);cursor:pointer;font-size:13px;color:var(--text2);margin-bottom:2px;display:flex;justify-content:space-between;align-items:center;transition:background .15s}
.history-item:hover{background:var(--bg-hover);color:var(--text)}
.history-item.active{background:var(--accent-bg);color:var(--accent)}
.history-item .h-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.history-item .h-del{opacity:0;color:var(--danger);cursor:pointer;font-size:11px;padding:2px 5px;flex-shrink:0}
.history-item:hover .h-del{opacity:.7}
.history-item .h-del:hover{opacity:1}

/* Chat */
.chat-area{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}

/* Message bubbles */
.msg-row{display:flex;gap:8px;align-items:flex-start}
.msg-row.user{justify-content:flex-end}
.msg-row.assistant{justify-content:flex-start}
.msg-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;letter-spacing:-.5px;user-select:none}
.msg-row.assistant .msg-avatar{background:var(--accent-bg);color:var(--accent)}
.msg-row.user .msg-avatar{background:var(--accent);color:#fff}
.msg-bubble{max-width:100%;width:fit-content;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;overflow-wrap:break-word;word-break:break-word;white-space:pre-wrap}
.msg-row.user .msg-bubble{background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.msg-row.assistant .msg-bubble{background:var(--bg-secondary);border:1px solid var(--border);border-bottom-left-radius:4px;color:var(--text)}
.msg-system{align-self:center;color:var(--text2);font-size:12px;background:var(--bg-secondary);border:1px solid var(--border);padding:5px 12px;border-radius:16px;text-align:center;max-width:80%}
.msg-time{font-size:10px;opacity:.5;margin-top:4px;text-align:right}
.msg-row.user .msg-time{text-align:right}
.msg-row.assistant .msg-time{text-align:left}
.msg-col{display:flex;flex-direction:column;max-width:min(80%,calc(100vw - 90px));min-width:0}
.msg-del-btn{display:none;font-size:11px;background:none;border:none;cursor:pointer;padding:0 2px;color:var(--danger,#e74c3c);opacity:.6;align-self:flex-end;line-height:1.4;margin-top:1px}
.msg-row:hover .msg-del-btn{display:block}
.msg-del-btn:hover{opacity:1}
/* Floating sidebar toggle button */
.btn-sidebar-float{position:fixed;left:8px;top:50%;transform:translateY(-50%);z-index:200;background:var(--accent);color:#fff;border:none;border-radius:50%;width:34px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .15s,transform .15s}
.btn-sidebar-float:hover{opacity:.88}
.sidebar-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:150;display:none}

/* Tool calls */
.tool-call{background:var(--bg-secondary);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);overflow:hidden;font-size:13px;max-width:90%}
.tool-call-header{padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;transition:background .15s}
.tool-call-header:hover{background:var(--bg-hover)}
.tool-call-header .tc-icon{color:var(--accent);font-size:14px;width:18px;text-align:center}
.tool-call-header .tc-name{font-weight:600;color:var(--text);flex:1}
.tool-call-header .tc-status{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.tc-status.calling{background:rgba(42,157,143,.15);color:var(--accent)}
.tc-status.done{background:rgba(39,174,96,.15);color:var(--success)}
.tc-status.denied,.tc-status.error{background:rgba(231,76,60,.15);color:var(--danger)}
.tool-call-header .tc-chevron{color:var(--text2);font-size:11px;transition:transform .2s}
.tool-call.open .tc-chevron{transform:rotate(180deg)}
.tool-call-body{display:none;border-top:1px solid var(--border)}
.tool-call.open .tool-call-body{display:block}
.tool-call-args{padding:8px 12px;font-family:monospace;font-size:12px;color:var(--text2);white-space:pre-wrap;background:var(--bg-tertiary);border-bottom:1px solid var(--border);max-height:150px;overflow-y:auto}
.tool-call-result{padding:8px 12px;font-family:monospace;font-size:12px;color:var(--text);white-space:pre-wrap;max-height:200px;overflow-y:auto}
.tool-call-result.error{color:var(--danger)}
.trng-badge{display:inline-flex;align-items:center;gap:3px;background:rgba(255,165,0,.15);border:1px solid rgba(255,165,0,.3);color:#e67e22;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:4px}

/* Input */
.input-area{padding:12px 16px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;flex-direction:column;gap:8px;transition:background .2s}
.input-attachments{display:flex;gap:6px;flex-wrap:wrap}
.attachment-chip{display:flex;align-items:center;gap:4px;padding:3px 8px;background:var(--accent-bg);border:1px solid var(--border);border-radius:12px;font-size:12px;color:var(--text)}
.attachment-chip .rm{cursor:pointer;color:var(--danger);opacity:.7}
.attachment-chip .rm:hover{opacity:1}
.input-row{display:flex;gap:8px;align-items:flex-end}
.input-row textarea{flex:1;resize:none;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-tertiary);color:var(--text);font-size:14px;font-family:inherit;outline:none;min-height:40px;max-height:120px;transition:border-color .15s}
.input-row textarea:focus{border-color:var(--accent)}
.btn-send{padding:9px 16px;border:none;border-radius:var(--radius);background:var(--accent);color:#fff;font-size:14px;cursor:pointer;font-weight:600;flex-shrink:0;transition:opacity .15s}
.btn-send:hover{opacity:.88}
.btn-send:disabled{opacity:.45;cursor:not-allowed}
.btn-stop{background:var(--danger)}
.btn-attach{padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--text2);font-size:14px;cursor:pointer;flex-shrink:0;transition:all .15s}
.btn-attach:hover{border-color:var(--accent);color:var(--accent)}

/* Approval Banner */
.approval-banner{padding:12px 16px;background:rgba(231,111,81,.12);border-bottom:1px solid rgba(231,111,81,.25);display:none;align-items:center;gap:10px;flex-shrink:0}
.approval-banner.visible{display:flex}
.approval-banner .info{flex:1;font-size:13px;color:var(--text)}
.approval-banner .info b{color:#e76f51}
.approval-banner .ap-args{font-size:11px;color:var(--text2);margin-top:3px;font-family:monospace;word-break:break-all}
.btn-approve{padding:6px 14px;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:600;background:var(--success);color:#fff}
.btn-reject{padding:6px 14px;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:600;background:var(--danger);color:#fff}

/* Sub-agent messages */
.msg-subagent{align-self:flex-start;background:var(--accent-bg);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius);padding:8px 12px;font-size:12px;color:var(--text2);max-width:85%}
.msg-subagent b{color:var(--accent);font-size:13px}

/* Scrollbar */
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text2)}

/* Responsive */
@media(max-width:720px){
  .sidebar{display:none}
  .sidebar.sidebar-open{display:flex;position:fixed;top:0;left:0;height:100%;z-index:160}
  .sidebar-overlay.active{display:block}
  .msg-col{max-width:min(88%,calc(100vw - 70px))}
  .header-tarot{display:none}
}
</style>
</head>
<body>

<!-- Login Overlay -->
<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h2><i class="fa-solid fa-satellite-dish"></i> CIBYP Web Control</h2>
    <div class="error" id="loginError"></div>
    <input type="password" id="loginPassword" placeholder="访问密码" autofocus>
    <div class="totp-row" id="totpRow">
      <input type="text" id="loginTotp" placeholder="2FA 验证码 (6位)" maxlength="6" inputmode="numeric">
    </div>
    <button onclick="doLogin()"><i class="fa-solid fa-right-to-bracket"></i> 登录</button>
  </div>
</div>

<!-- Main UI -->
<div id="mainUI" style="display:none;flex-direction:column;height:100vh">
  <header>
    <span class="header-brand"><i class="fa-solid fa-satellite-dish"></i> CIBYP</span>
    <span class="header-title" id="headerTitle">未命名对话</span>
    <div class="header-tarot hidden" id="headerTarot" title="">
      <i class="fa-solid fa-star tarot-icon" id="tarotIcon"></i>
      <span id="tarotText">命运之牌</span>
    </div>
    <div class="header-status">
      <span class="dot idle" id="statusDot"></span>
      <span id="statusText">空闲</span>
    </div>
    <button class="btn-icon-sm" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i> 退出</button>
  </header>

  <div class="approval-banner" id="approvalBanner">
    <div class="info">
      <div><b><i class="fa-solid fa-triangle-exclamation"></i> 审批请求</b>: 工具 <code id="approvalTool"></code></div>
      <div class="ap-args" id="approvalArgs"></div>
    </div>
    <button class="btn-approve" onclick="respondApproval(true)"><i class="fa-solid fa-check"></i> 批准</button>
    <button class="btn-reject" onclick="respondApproval(false)"><i class="fa-solid fa-xmark"></i> 拒绝</button>
  </div>

  <!-- Sidebar overlay (mobile) -->
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>
  <!-- Floating sidebar toggle button -->
  <button class="btn-sidebar-float" id="btnSidebarFloat" onclick="toggleSidebar()" title="对话历史">
    <i class="fa-solid fa-clock-rotate-left"></i>
  </button>

  <div class="main-layout">
    <div class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <h3><i class="fa-solid fa-clock-rotate-left"></i> 对话历史</h3>
        <button class="btn-new" onclick="newChat()"><i class="fa-solid fa-plus"></i> 新建</button>
      </div>
      <div class="history-list" id="historyList"></div>
    </div>
    <div class="chat-area">
      <div class="messages" id="messages"></div>
      <div class="input-area">
        <div class="input-attachments" id="inputAttachments"></div>
        <div class="input-row">
          <input type="file" id="fileInput" style="display:none" multiple onchange="handleFiles(this.files)">
          <button class="btn-attach" onclick="document.getElementById('fileInput').click()" title="附件"><i class="fa-solid fa-paperclip"></i></button>
          <textarea id="msgInput" placeholder="输入消息 (Enter发送, Shift+Enter换行)..." rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
          <button class="btn-send" id="btnSend" onclick="sendMsg()"><i class="fa-solid fa-paper-plane"></i></button>
          <button class="btn-send btn-stop" id="btnStop" onclick="stopAgent()" style="display:none"><i class="fa-solid fa-stop"></i></button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let ws = null;
let agentStatus = 'idle';
let pendingAttachments = []; // {name, path, type}

// ----- Theme Application -----
let _aiAvatar = '';
let _userAvatar = '';
function applyAvatars(av) {
  if (av && av.ai !== undefined) _aiAvatar = av.ai;
  if (av && av.user !== undefined) _userAvatar = av.user;
}

async function loadAndApplyTheme() {
  try {
    const r = await fetch('/api/theme');
    const d = await r.json();
    if (d.ok && d.theme) applyTheme(d.theme);
  } catch {}
  try {
    const r = await fetch('/api/avatars');
    const d = await r.json();
    if (d.ok && d.avatars) applyAvatars(d.avatars);
  } catch {}
}

function applyTheme(t) {
  if (!t) return;
  const root = document.documentElement;
  if (t.accent) root.style.setProperty('--accent', t.accent);
  if (t.accentLight) root.style.setProperty('--accent-light', t.accentLight);
  if (t.accentDark) root.style.setProperty('--accent-dark', t.accentDark);
  if (t.accentBg) {
    root.style.setProperty('--accent-bg', t.accentBg);
    root.style.setProperty('--accent-bg-hover', t.accentBg.replace('0.08', '0.14'));
  }
  if (t.bgPrimary) root.style.setProperty('--bg-primary', t.bgPrimary);
  if (t.bgSecondary) root.style.setProperty('--bg-secondary', t.bgSecondary);
  if (t.bgTertiary) root.style.setProperty('--bg-tertiary', t.bgTertiary);
  if (t.bgHover) root.style.setProperty('--bg-hover', t.bgHover);
  if (typeof t.isDark === 'boolean') {
    root.setAttribute('data-theme', t.isDark ? 'dark' : 'light');
  }
}

// ----- Auth -----
async function checkAuth() {
  try {
    const r = await fetch('/api/auth-check');
    const d = await r.json();
    if (d.authenticated) {
      showMain();
    } else {
      document.getElementById('loginOverlay').style.display = 'flex';
      if (d.need2FA) document.getElementById('totpRow').style.display = 'block';
    }
  } catch { document.getElementById('loginOverlay').style.display = 'flex'; }
}

async function doLogin() {
  const pw = document.getElementById('loginPassword').value;
  const totp = document.getElementById('loginTotp').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ password: pw, totpCode: totp }),
    });
    const d = await r.json();
    if (d.ok) {
      showMain();
    } else {
      if (d.need2FA) document.getElementById('totpRow').style.display = 'block';
      errEl.textContent = d.error || '登录失败';
    }
  } catch (e) { errEl.textContent = '网络错误'; }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

function showMain() {
  document.getElementById('loginOverlay').style.display = 'none';
  const mainUI = document.getElementById('mainUI');
  mainUI.style.display = 'flex';
  loadAndApplyTheme();
  connectWS();
  loadHistory();
}

// ----- WebSocket -----
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onmessage = (e) => {
    try { handleWsMessage(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => { setTimeout(connectWS, 3000); };
  ws.onerror = () => {};
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'init':
      updateStatus(data.agentStatus);
      if (data.messages) renderMessages(data.messages);
      if (data.pendingApproval) showApproval(data.pendingApproval.toolName, data.pendingApproval.args);
      if (data.theme) applyTheme(data.theme);
      if (data.tarot) showTarot(data.tarot);
      if (data.title) setTitle(data.title);
      if (data.avatars) applyAvatars(data.avatars);
      break;
    case 'message':
      appendMessage(data.message);
      break;
    case 'status':
      updateStatus(data.agentStatus);
      break;
    case 'approval':
      showApproval(data.toolName, data.args);
      break;
    case 'approvalCleared':
      hideApproval();
      break;
    case 'toolCall':
      handleToolCall(data);
      break;
    case 'conversationSwitch':
      document.getElementById('messages').innerHTML = '';
      loadHistory();
      break;
    case 'messagesSync':
      renderMessages(data.messages);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'tarot':
      showTarot(data.card);
      break;
    case 'title':
      setTitle(data.title);
      break;
    case 'avatars':
      applyAvatars(data.avatars);
      break;
  }
}

// ----- Status -----
function updateStatus(s) {
  agentStatus = s;
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const btnSend = document.getElementById('btnSend');
  const btnStop = document.getElementById('btnStop');
  const working = s !== 'idle';
  dot.className = 'dot ' + (working ? 'working' : 'idle');
  txt.textContent = working ? '工作中' : '空闲';
  btnSend.style.display = working ? 'none' : '';
  btnStop.style.display = working ? '' : 'none';
}

// ----- Tarot -----
function showTarot(card) {
  if (!card) return;
  const el = document.getElementById('headerTarot');
  const icon = document.getElementById('tarotIcon');
  const text = document.getElementById('tarotText');
  el.classList.remove('hidden');
  if (card.icon) icon.className = 'fa-solid ' + card.icon + ' tarot-icon';
  const pos = card.isReversed ? '逆位' : '正位';
  const meaning = card.isReversed ? card.meaningOfReversed : card.meaningOfUpright;
  const isTRNG = (card.entropySource || '').startsWith('TRNG');
  text.textContent = card.name + '(' + pos + ')';
  el.title = card.name + '(' + pos + ') - ' + (meaning || '') + ' [' + (card.entropySource || 'CSPRNG') + ']';
  if (isTRNG && !el.querySelector('.tarot-trng')) {
    el.insertAdjacentHTML('beforeend', '<span class="tarot-trng"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>');
  }
}

// ----- Title -----
function setTitle(title) {
  document.getElementById('headerTitle').textContent = title || '未命名对话';
}

// ----- Messages -----
function renderMessages(messages) {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  for (const m of messages) appendMessage(m, false);
  el.scrollTop = el.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ----- Sidebar Toggle -----
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sb) return;
  const isOpen = sb.classList.toggle('sidebar-open');
  if (overlay) overlay.classList.toggle('active', isOpen);
}

// ----- Delete Turn -----
async function deleteTurn(timestamp) {
  if (!confirm('确定要删除这轮对话吗？')) return;
  try {
    const r = await fetch('/api/chat/delete-turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp }),
    });
    const d = await r.json();
    if (!d.ok) alert('删除失败: ' + (d.error || '未知错误'));
  } catch (e) { alert('删除失败: ' + e.message); }
}

function appendMessage(msg, scroll = true) {
  const el = document.getElementById('messages');
  if (msg.role === 'user') {
    const div = document.createElement('div');
    div.className = 'msg-row user';
    const delBtn = '<button class="msg-del-btn" onclick="deleteTurn(' + (msg.timestamp || 0) + ')" title="删除这轮对话">✕ 删除</button>';
    const userAvatarHtml = _userAvatar ? '<img src="' + _userAvatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : '你';
    div.innerHTML = '<div class="msg-col"><div class="msg-bubble">' + escHtml(msg.content || '') + '</div><div class="msg-time">' + formatTime(msg.timestamp) + '</div>' + delBtn + '</div><div class="msg-avatar">' + userAvatarHtml + '</div>';
    el.appendChild(div);
  } else if (msg.role === 'assistant') {
    const div = document.createElement('div');
    div.className = 'msg-row assistant';
    let colInner = '';
    // Text content
    if (msg.content) colInner += '<div class="msg-bubble">' + escHtml(msg.content) + '</div>';
    // Tool calls (from history)
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        const tname = (tc.function && tc.function.name) || 'tool';
        let argsStr = '';
        try { argsStr = JSON.stringify(JSON.parse((tc.function && tc.function.arguments) || '{}'), null, 2); } catch(e) { argsStr = (tc.function && tc.function.arguments) || ''; }
        const tcid = tc.id || '';
        colInner += '<div class="tool-call" data-tcid="' + escHtml(tcid) + '">' +
          '<div class="tool-call-header" onclick="toggleTc(this.parentElement)">' +
          '<span class="tc-icon">⚙</span>' +
          '<span class="tc-name">' + escHtml(tname) + '</span>' +
          '<span class="tc-status done">完成</span>' +
          '<span class="tc-chevron">▾</span>' +
          '</div>' +
          '<div class="tool-call-body">' +
          (argsStr ? '<div class="tool-call-args">' + escHtml(argsStr) + '</div>' : '') +
          '<div class="tool-call-result"></div>' +
          '</div></div>';
      }
    }
    if (msg.content || (msg.tool_calls && msg.tool_calls.length)) {
      const delTs = msg.timestamp || 0;
      colInner += '<div class="msg-time">' + formatTime(msg.timestamp) + '</div>';
      colInner += '<button class="msg-del-btn" onclick="deleteTurn(' + delTs + ')" title="删除这轮对话">✕ 删除</button>';
    }
    if (colInner) {
      const aiAvatarHtml = _aiAvatar ? '<img src="' + _aiAvatar + '" style="width:100%;height:100%;border-radius:50%;object-fit:cover">' : 'AI';
      div.innerHTML = '<div class="msg-avatar">' + aiAvatarHtml + '</div><div class="msg-col">' + colInner + '</div>';
      el.appendChild(div);
    }
  } else if (msg.role === 'tool') {
    // Fill result into matching tool-call block already rendered
    const tcid = msg.tool_call_id || '';
    const resultEl = tcid ? el.querySelector('[data-tcid="' + tcid + '"] .tool-call-result') : null;
    if (resultEl) {
      const text = (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')).substring(0, 800);
      resultEl.textContent = text;
      resultEl.closest('.tool-call').classList.add('open');
    } else {
      // Fallback: show as system
      const d = document.createElement('div');
      d.className = 'msg-system';
      d.textContent = '[' + (msg.name || 'tool') + '] ' + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')).substring(0, 300);
      el.appendChild(d);
    }
  } else {
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.textContent = msg.content || '';
    el.appendChild(div);
  }
  if (scroll) el.scrollTop = el.scrollHeight;
}

// ----- Tool Calls -----
const toolCallMap = {}; // display storage for active calls

function handleToolCall(data) {
  const el = document.getElementById('messages');
  const id = 'tc-' + data.toolName.replace(/[^a-z0-9]/gi, '') + '-' + Date.now();

  if (data.status === 'calling') {
    const div = document.createElement('div');
    div.className = 'tool-call';
    div.id = id;
    div.dataset.tool = data.toolName;
    const argsStr = typeof data.args === 'object' ? JSON.stringify(data.args, null, 2) : String(data.args || '');
    div.innerHTML =
      '<div class="tool-call-header" onclick="toggleTc(this.parentElement)">' +
        '<i class="fa-solid fa-gear fa-spin tc-icon" id="' + id + '-icon"></i>' +
        '<span class="tc-name">' + escHtml(data.toolName) + '</span>' +
        '<span class="tc-status calling">调用中</span>' +
        '<i class="fa-solid fa-chevron-down tc-chevron"></i>' +
      '</div>' +
      '<div class="tool-call-body">' +
        (argsStr ? '<div class="tool-call-args">' + escHtml(argsStr) + '</div>' : '') +
        '<div class="tool-call-result" id="' + id + '-result"></div>' +
      '</div>';
    el.appendChild(div);
    toolCallMap[data.toolName] = id;
    el.scrollTop = el.scrollHeight;
  } else if (data.status === 'done' || data.status === 'denied' || data.status === 'error') {
    const tcId = toolCallMap[data.toolName];
    const div = tcId ? document.getElementById(tcId) : null;
    if (div) {
      const icon = div.querySelector('.tc-icon');
      const badge = div.querySelector('.tc-status');
      const resultEl = div.querySelector('.tool-call-result');
      const isOk = data.status === 'done';
      if (icon) icon.className = 'fa-solid ' + (isOk ? 'fa-check' : 'fa-xmark') + ' tc-icon';
      if (badge) {
        badge.className = 'tc-status ' + (isOk ? 'done' : 'denied');
        badge.textContent = isOk ? '完成' : data.status === 'denied' ? '已拒绝' : '错误';
      }
      if (resultEl) {
        const text = data.result ? data.result.substring(0, 800) : '';
        if (text) {
          resultEl.textContent = text;
          if (!isOk) resultEl.classList.add('error');
          // Auto-open on result
          div.classList.add('open');
        }
      }
    }
  }
}

function toggleTc(el) {
  el.classList.toggle('open');
}

// ----- Approval -----
function showApproval(toolName, args) {
  document.getElementById('approvalTool').textContent = toolName;
  const argsStr = typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args || '');
  document.getElementById('approvalArgs').textContent = argsStr.substring(0, 300);
  document.getElementById('approvalBanner').classList.add('visible');
}
function hideApproval() {
  document.getElementById('approvalBanner').classList.remove('visible');
}
function respondApproval(approved) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'approvalResponse', approved }));
  hideApproval();
}

// ----- Chat -----
async function sendMsg() {
  const input = document.getElementById('msgInput');
  const msg = input.value.trim();
  if (!msg && pendingAttachments.length === 0) return;
  input.value = '';
  input.style.height = 'auto';

  // Build message with attachment paths if any
  let fullMsg = msg;
  if (pendingAttachments.length > 0) {
    const paths = pendingAttachments.map(a => '附件: ' + a.path + ' (' + a.name + ')').join('\\n');
    fullMsg = (msg ? msg + '\\n' : '') + paths;
    pendingAttachments = [];
    document.getElementById('inputAttachments').innerHTML = '';
  }

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'sendMessage', message: fullMsg }));
  }
}

function newChat() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'newChat' }));
}

function stopAgent() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stopAgent' }));
}

// ----- File Attachments -----
async function handleFiles(files) {
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const r = await fetch('/api/upload-attachment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, type: file.type, data: e.target.result }),
        });
        const d = await r.json();
        if (d.ok) {
          pendingAttachments.push({ name: d.name, path: d.path, type: d.type });
          renderAttachmentChips();
        } else {
          alert('上传失败: ' + d.error);
        }
      } catch (err) {
        alert('上传出错: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
  }
  document.getElementById('fileInput').value = '';
}

function renderAttachmentChips() {
  const container = document.getElementById('inputAttachments');
  container.innerHTML = pendingAttachments.map((a, i) =>
    '<div class="attachment-chip"><i class="fa-solid fa-paperclip"></i>&nbsp;' + escHtml(a.name) +
    '<span class="rm" onclick="removeAttachment(' + i + ')"><i class="fa-solid fa-xmark"></i></span></div>'
  ).join('');
}

function removeAttachment(i) {
  pendingAttachments.splice(i, 1);
  renderAttachmentChips();
}

// ----- History -----
async function loadHistory() {
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    if (!d.ok) return;
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    if (!d.history || d.history.length === 0) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text2);font-size:12px"><i class="fa-solid fa-inbox"></i><br>暂无历史</div>';
      return;
    }
    for (const h of d.history) {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.dataset.id = h.id;
      div.innerHTML =
        '<span class="h-title">' + escHtml(h.title || '未命名') + '</span>' +
        '<span class="h-del" onclick="event.stopPropagation();deleteConv(\\''+h.id+'\\')" title="删除"><i class="fa-solid fa-trash-can"></i></span>';
      div.onclick = () => hostLoadConversation(h.id);
      list.appendChild(div);
    }
  } catch {}
}

function hostLoadConversation(id) {
  // Send to server which forwards to Electron host to switch conversation
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'loadConversation', id }));
    // Highlight active item
    document.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  }
}

async function deleteConv(id) {
  if (!confirm('确认删除此对话？')) return;
  await fetch('/api/conversation/' + id, { method: 'DELETE' });
  loadHistory();
}

// Auto-resize textarea
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('msgInput');
  if (ta) {
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    });
  }
});

checkAuth();
</script>
</body>
</html>`;
  }
}

module.exports = { WebControlService };
