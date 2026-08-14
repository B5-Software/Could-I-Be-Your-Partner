/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 自动化任务管理器：
 *   - 存储：<dataDir>/automations.json
 *   - 触发源：cron 定时 / 系统通知事件 / 专用 HTTP 信号服务器
 *   - 提示词：DSL（见 dsl.js）渲染后经 transport 分发到渲染进程，
 *     由渲染进程新建一个 Chat 会话并发送。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { runDsl } = require('./dsl');

const TRIGGER_TYPES = ['schedule', 'notification', 'http'];

class AutomationManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.file = path.join(options.dataDir || '.', 'automations.json');
    this.transport = options.transport || null; // { send, request }
    this.getSettings = options.getSettings || (async () => ({}));
    this.tasks = [];
    this.server = null;
    this.serverPort = null;
    this._timer = null;
    this._lastFire = new Map(); // taskId → 'YYYY-MM-DD-HH-MM'
    this._disposed = false;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    } catch { this.tasks = []; }
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ tasks: this.tasks }, null, 2), 'utf8');
    } catch (e) {
      throw new Error(`保存自动化任务失败: ${e.message}`);
    }
  }

  _public(task) {
    return {
      id: task.id,
      name: task.name || '未命名任务',
      enabled: !!task.enabled,
      trigger: task.trigger || { type: 'schedule', config: {} },
      dsl: task.dsl || '',
      runCount: task.runCount || 0,
      lastRunAt: task.lastRunAt || null,
      lastError: task.lastError || null
    };
  }

  list() { return this.tasks.map(t => this._public(t)); }

  normalize(task) {
    if (!task || typeof task !== 'object') throw new Error('任务数据无效');
    const trigger = task.trigger || {};
    if (!TRIGGER_TYPES.includes(trigger.type)) throw new Error(`未知触发类型: ${trigger.type}`);
    return {
      id: String(task.id || `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
      name: String(task.name || '未命名任务').slice(0, 80),
      enabled: !!task.enabled,
      trigger: { type: trigger.type, config: trigger.config || {} },
      dsl: String(task.dsl || ''),
      runCount: Number(task.runCount) || 0,
      lastRunAt: task.lastRunAt || null,
      lastError: task.lastError || null
    };
  }

  upsert(task) {
    const norm = this.normalize(task);
    const idx = this.tasks.findIndex(t => t.id === norm.id);
    if (idx >= 0) this.tasks[idx] = norm;
    else this.tasks.push(norm);
    this.save();
    this._refresh();
    return this._public(norm);
  }

  remove(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(t => t.id !== id);
    if (this.tasks.length !== before) {
      this.save();
      this._refresh();
      return true;
    }
    return false;
  }

  setEnabled(id, enabled) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return null;
    t.enabled = !!enabled;
    this.save();
    this._refresh();
    return this._public(t);
  }

  /** 启动调度循环 + 按需启动 HTTP 信号服务器。 */
  start() {
    this._refresh();
  }

  stop() {
    this._disposed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.serverPort = null;
    }
  }

  _refresh() {
    if (this._disposed) return;
    // cron 调度循环：20s 粒度，分钟级去重
    const hasSchedule = this.tasks.some(t => t.enabled && t.trigger.type === 'schedule');
    if (hasSchedule && !this._timer) {
      this._timer = setInterval(() => this._tickSchedule(), 20000);
    } else if (!hasSchedule && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // HTTP 服务器生命周期
    const needHttp = this.tasks.some(t => t.enabled && t.trigger.type === 'http');
    if (needHttp) {
      if (!this.server) this._startServer();
    } else if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.serverPort = null;
    }
  }

  _tickSchedule() {
    const now = new Date();
    for (const task of this.tasks) {
      if (!task.enabled || task.trigger.type !== 'schedule') continue;
      const expr = String(task.trigger.config.cron || '').trim();
      if (!expr || !matchesCron(expr, now)) continue;
      const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      if (this._lastFire.get(task.id) === key) continue;
      this._lastFire.set(task.id, key);
      this.run(task.id, { kind: 'schedule', time: now.toISOString() }).catch(e => {
        console.error(`[automation] 任务 ${task.name} 执行失败:`, e.message);
      });
    }
  }

  /** 系统通知触发源（由 main 的 sendAppNotification 调用）。 */
  onSystemNotification(notification = {}) {
    const kind = notification.kind || 'other';
    const title = String(notification.title || '');
    const body = String(notification.body || '');
    for (const task of this.tasks) {
      if (!task.enabled || task.trigger.type !== 'notification') continue;
      const cfg = task.trigger.config || {};
      const kindMatch = !cfg.kind || cfg.kind === 'any' || cfg.kind === kind;
      const titleMatch = !cfg.titleRegex || safeRegex(cfg.titleRegex).test(title);
      const bodyMatch = !cfg.bodyRegex || safeRegex(cfg.bodyRegex).test(body);
      if (kindMatch && titleMatch && bodyMatch) {
        this.run(task.id, { kind: 'notification', params: { notification }, time: new Date().toISOString() }).catch(e => {
          console.error(`[automation] 任务 ${task.name} 执行失败:`, e.message);
        });
      }
    }
  }

  async _startServer() {
    const settings = (await this.getSettings()) || {};
    const cfg = settings.automation || {};
    const port = (cfg.serverPort === 0 || cfg.serverPort) ? Number(cfg.serverPort) : 8765;
    const token = String(cfg.serverToken || '');
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://localhost:${port}`);
        if (req.method === 'GET' && url.pathname === '/health') {
          this._json(res, 200, { ok: true, service: 'cibyp-automation', time: Date.now() });
          return;
        }
        const m = url.pathname.match(/^\/trigger\/([A-Za-z0-9._-]+)$/);
        if (req.method !== 'POST' || !m) {
          this._json(res, 404, { ok: false, error: 'not-found' });
          return;
        }
        const auth = req.headers.authorization || '';
        const queryToken = url.searchParams.get('token') || '';
        if (token && auth !== `Bearer ${token}` && queryToken !== token) {
          this._json(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const taskId = m[1];
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || !task.enabled || task.trigger.type !== 'http') {
          this._json(res, 404, { ok: false, error: 'unknown-task' });
          return;
        }
        let body = {};
        try {
          const raw = await readBody(req, 2 * 1024 * 1024);
          if (raw) body = JSON.parse(raw);
        } catch {
          this._json(res, 400, { ok: false, error: 'invalid-json-body' });
          return;
        }
        const result = await this.run(task.id, { kind: 'http', params: body, time: new Date().toISOString() });
        this._json(res, 200, { ok: true, accepted: true, taskId, sessionKey: result.sessionKey || null });
      } catch (e) {
        this._json(res, 500, { ok: false, error: e.message });
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.server = server;
    this.serverPort = server.address() ? server.address().port : port;
    console.log(`[automation] HTTP 信号服务器已启动: http://127.0.0.1:${this.serverPort}/trigger/:taskId`);
  }

  _json(res, code, payload) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  /** 执行一次任务：DSL 渲染提示词 → transport 请求渲染进程开新 Chat 会话发送。 */
  async run(taskId, triggerInfo = {}) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const started = Date.now();
    try {
      const prompt = await runDsl(task.dsl, {
        kind: triggerInfo.kind || 'manual',
        params: triggerInfo.params || {},
        time: triggerInfo.time || new Date().toISOString(),
        taskId: task.id
      }, {
        getEnv: (name) => process.env[name],
        fetch: this._fetch.bind(this)
      });
      if (!this.transport || typeof this.transport.request !== 'function') {
        throw new Error('自动化分发通道未就绪');
      }
      const requestId = `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const result = await this.transport.request('automation:dispatch', {
        requestId,
        taskId: task.id,
        taskName: task.name,
        prompt,
        trigger: { kind: triggerInfo.kind || 'manual', params: triggerInfo.params || {} }
      }, 30000);
      task.runCount = (Number(task.runCount) || 0) + 1;
      task.lastRunAt = Date.now();
      task.lastError = null;
      this.save();
      return { ok: true, requestId, sessionKey: result && result.sessionKey || null, elapsedMs: Date.now() - started };
    } catch (e) {
      task.lastError = e.message;
      task.lastRunAt = Date.now();
      this.save();
      throw e;
    }
  }

  /** DSL 测试渲染（不触发分发），返回提示词。 */
  async test(taskOrId, params = {}) {
    const task = typeof taskOrId === 'string' ? this.tasks.find(t => t.id === taskOrId) : this.normalize(taskOrId);
    if (!task) throw new Error('任务不存在');
    const prompt = await runDsl(task.dsl, {
      kind: 'manual',
      params,
      time: new Date().toISOString(),
      taskId: task.id
    }, {
      getEnv: (name) => process.env[name],
      fetch: this._fetch.bind(this)
    });
    return { prompt };
  }

  async _fetch(url, options = {}) {
    const timeout = Math.max(1000, Math.min(Number(options.timeout) || 15000, 60000));
    const resp = await fetch(String(url), { ...options, signal: AbortSignal.timeout(timeout) });
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      text,
      json: () => JSON.parse(text)
    };
  }

  serverInfo() {
    return this.server
      ? { running: true, port: this.serverPort, url: `http://127.0.0.1:${this.serverPort}` }
      : { running: false, port: null, url: null };
  }
}

function safeRegex(pattern) {
  try { return new RegExp(pattern); } catch { return /(?!)/; }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cronField(field, value, min, max) {
  for (const part of String(field).split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Math.max(1, parseInt(stepStr, 10) || 1) : 1;
    if (range === '*') {
      for (let v = min; v <= max; v += step) if (v === value) return true;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      for (let v = a; v <= b; v += step) if (v === value) return true;
    } else if (Number(range) === value) return true;
  }
  return false;
}

function matchesCron(expr, date) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, mon, dow] = parts;
  return cronField(minute, date.getMinutes(), 0, 59)
    && cronField(hour, date.getHours(), 0, 23)
    && cronField(dom, date.getDate(), 1, 31)
    && cronField(mon, date.getMonth() + 1, 1, 12)
    && cronField(dow.replace(/\b7\b/g, '0'), date.getDay(), 0, 6);
}

module.exports = { AutomationManager, matchesCron };
