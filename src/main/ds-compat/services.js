/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * DeepSeek Harness 服务 API → CIBYP 功能翻译层。
 *
 * 不照搬 deepseek-harness 的会话/LLM 引擎（避免“夺舍”），只提供与 DSH 插件
 * 生态兼容的服务表面，底层全部对接 CIBYP 已有能力：
 *   - agents   ← 渲染进程 SessionManager 的会话（经 IPC 同步元数据）
 *   - sessions ← 同一注册表（header.cwd 等供插件读取）
 *   - llm      ← main/llm-retry.js 的带重试请求管线
 *   - sandboxPolicy ← CIBYP 设置中的沙箱模式
 *   - approval ← 渲染进程授权/问卷模态框（IPC 往返）
 */

'use strict';

const { Service } = require('@deepseek-ai/cordis');
const llmRetry = require('../llm-retry');
const LLMProviders = require('../llm-providers');

/** DSH 消息可能是字符串或 { content: [...] }，统一取出纯文本。 */
function messageText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** CIBYP SessionStatus → DSH agent status（monitor 等插件用 status === 'idle' 判断）。 */
function mapAgentStatus(cibypStatus) {
  switch (cibypStatus) {
    case 'idle':
    case 'done':
    case 'error':
    case 'interrupted':
      return 'idle';
    default:
      return 'busy';
  }
}

/**
 * Agent 注册表桥：真实 agent 在渲染进程，这里保存由渲染端经
 * `ds:agentsSync` 推送的元数据，并为插件提供 DSH AgentHandle 形状的代理。
 */
class CibypAgentsService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'agents');
    this.transport = config.transport || null;
    this.store = new Map(); // key → entry
    this.byId = new Map();  // conversationId → key
  }

  sync(entries) {
    this.store = new Map();
    this.byId = new Map();
    for (const e of entries || []) {
      if (!e || !e.key) continue;
      this.store.set(e.key, { ...e });
      if (e.id) this.byId.set(String(e.id), e.key);
    }
  }

  _resolve(idOrKey) {
    if (this.store.has(idOrKey)) return this.store.get(idOrKey);
    const key = this.byId.get(String(idOrKey));
    return key ? this.store.get(key) : undefined;
  }

  get(idOrKey) {
    const entry = this._resolve(idOrKey);
    return entry ? this._handle(entry) : undefined;
  }

  has(idOrKey) {
    return this._resolve(idOrKey) !== undefined;
  }

  list() {
    return [...this.store.keys()];
  }

  /** DSH AgentRegistry.create：经渲染进程新建一个 Chat 会话并返回代理句柄。 */
  async create(options = {}) {
    if (!this.transport || typeof this.transport.request !== 'function') {
      throw new Error('agents.create: 传输通道未就绪');
    }
    const requestId = `agent-create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await this.transport.request('ds:agentCreate', {
      requestId,
      cwd: options.cwd || null,
      instructions: options.instructions || null,
      sessionId: options.sessionId || null,
      model: options.model || null
    }, 30000);
    if (res && res.error) throw new Error(res.error);
    if (res && res.sessionKey) {
      const entry = {
        key: res.sessionKey,
        id: res.id || res.sessionKey,
        mode: 'chat',
        title: res.title || '新会话',
        cwd: res.cwd || null,
        status: 'idle'
      };
      this.store.set(entry.key, entry);
      if (entry.id) this.byId.set(String(entry.id), entry.key);
      // DSH AgentHandle 契约：create/resume 返回 { agent, dispose, ... }，
      // 其中 agent 才是调用方实际使用的句柄（dsh-cc-tui 走 created.agent）
      const handle = this._handle(entry);
      return Object.assign(handle, { agent: handle });
    }
    return undefined;
  }

  /** DSH AgentRegistry.resume：按会话 id 恢复已有会话的代理句柄。 */
  async resume(options = {}) {
    const idOrKey = options.sessionId || options.id;
    if (idOrKey === undefined || idOrKey === null) throw new Error('agents.resume 需要 sessionId');
    if (!this.transport || typeof this.transport.request !== 'function') {
      throw new Error('agents.resume: 传输通道未就绪');
    }
    const requestId = `agent-resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await this.transport.request('ds:agentResume', {
      requestId,
      sessionId: String(idOrKey)
    }, 30000);
    if (res && res.error) throw new Error(res.error);
    if (res && res.sessionKey) {
      const entry = {
        key: res.sessionKey,
        id: res.id || res.sessionKey,
        mode: 'chat',
        title: res.title || '',
        cwd: res.cwd || null,
        status: res.status || 'idle'
      };
      this.store.set(entry.key, entry);
      if (entry.id) this.byId.set(String(entry.id), entry.key);
      const handle = this._handle(entry);
      return Object.assign(handle, { agent: handle });
    }
    return undefined;
  }

  /** 注册外部构造的 agent（需带 session.header），返回注销 disposer。 */
  register(agent) {
    const header = agent && agent.session && agent.session.header;
    if (!header || !header.id) throw new Error('agents.register 需要带 session.header.id 的 agent');
    const entry = {
      key: header.id,
      id: header.id,
      mode: header.mode || 'chat',
      title: header.title || '',
      cwd: header.cwd || null,
      status: agent.status || 'idle'
    };
    this.store.set(entry.key, entry);
    this.byId.set(String(entry.id), entry.key);
    return () => {
      if (this.store.get(entry.key) === entry) this.store.delete(entry.key);
    };
  }

  /** 供插件读取宿主服务的 agent.ctx 代理（按需从宿主根上下文解析）。 */
  hostCtxProxy() {
    if (!this._proxy) {
      const root = this.ctx.root;
      this._proxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'get') return (name) => { try { return root.get(name); } catch { return undefined; } };
          if (prop === 'root') return root;
          try { return root.get(String(prop)); } catch { return undefined; }
        }
      });
    }
    return this._proxy;
  }

  _handle(entry) {
    const service = this;
    const transport = this.transport;
    const send = (payload) => {
      if (!transport || typeof transport.send !== 'function') return;
      try { transport.send('ds:pluginAgentMessage', payload); } catch { /* ignore */ }
    };
    const events = [];
    let seq = 0;
    const sessionObj = {
      header: {
        id: entry.key,
        cwd: entry.cwd || null,
        title: entry.title || '',
        mode: entry.mode || 'chat'
      },
      events,
      get seq() { return seq; },
      append(type, data) {
        seq += 1;
        events.push({ type, data, seq, timestamp: Date.now() });
      }
    };
    const inbox = {
      events: [],
      push(message) { inbox.events.push(message); },
      remove() { return false; } // CIBYP 无 inbox 撤回语义：返回 false（拒绝撤回）
    };
    return {
      get id() { return service._resolve(entry.key)?.key || entry.key; },
      get status() {
        const cur = service._resolve(entry.key);
        return cur ? mapAgentStatus(cur.status) : 'idle';
      },
      get mode() { return entry.mode || 'chat'; },
      get title() { return entry.title || ''; },
      get session() { return sessionObj; },
      inbox,
      followup(message) {
        send({ sessionKey: entry.key, kind: 'followup', text: messageText(message), source: (message && message.source) || null });
      },
      inject(message) {
        send({ sessionKey: entry.key, kind: 'inject', text: messageText(message), source: (message && message.source) || null });
      },
      steer(message) {
        send({ sessionKey: entry.key, kind: 'steer', text: messageText(message) });
      },
      cancel() {
        send({ sessionKey: entry.key, kind: 'stop', text: '' });
      },
      stop() {
        send({ sessionKey: entry.key, kind: 'stop', text: '' });
      },
      get whenIdle() {
        return whenIdle(service, entry.key);
      },
      get ctx() {
        return service.hostCtxProxy();
      },
      dispose() { /* 生命周期由渲染进程会话管理，这里无本地资源 */ }
    };
  }
}

function whenIdle(service, key, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const cur = service._resolve(key);
      if (!cur || (cur.status !== 'running' && cur.status !== 'queued')) return resolve();
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** sessions seam：与 agents 共用注册表，读取 header（cwd/title/mode）。 */
class CibypSessionsService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'sessions');
    this.agents = config.agents || null;
  }

  get(idOrKey) {
    if (!this.agents) return undefined;
    const handle = this.agents.get(idOrKey);
    return handle ? handle.session : undefined;
  }

  /** DSH sessions.fork：共享事件日志的浅分支（CIBYP 无分叉语义）。 */
  fork(session) {
    if (!session) return undefined;
    return {
      header: session.header || {},
      events: Array.isArray(session.events) ? session.events : []
    };
  }
}

/** llm seam：CIBYP 的 fetchLLMWithRetry 管线，返回 DSH 形状的 chat 结果。 */
class CibypLlmService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'llm');
    this.getSettings = typeof config.getSettings === 'function'
      ? config.getSettings
      : async () => ({});
  }

  async chat(request = {}, signal) {
    const settings = await this.getSettings();
    const llm = (settings && settings.llm) || {};
    if (!llm.apiUrl) throw new Error('CIBYP: 尚未配置 LLM API（设置 → LLM）');
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const body = {
      model: request.model || llm.model || undefined,
      messages,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(typeof request.maxTokens === 'number' && request.maxTokens > 0 ? { max_tokens: request.maxTokens } : {})
    };
    const result = await llmRetry.fetchLLMWithRetry({
      apiUrl: llm.apiUrl,
      apiKey: llm.apiKey || llm.zenApiKey || '',
      body,
      options: { sessionKey: request.sessionKey || null }
    });
    if (!result.ok) throw new Error(result.error || 'LLM 请求失败');
    let raw = null;
    try {
      raw = await result.response.json();
    } finally {
      if (typeof result.releaseController === 'function') result.releaseController();
    }
    const parsed = LLMProviders.parseLLMResponse(raw || {}, 'openai');
    return {
      content: parsed.content || '',
      reasoning: parsed.reasoning || null,
      usage: parsed.usage || null,
      model: parsed.model || body.model || null
    };
  }
}

/** sandboxPolicy seam：把 CIBYP 设置中的沙箱模式暴露为 policy 对象。 */
class CibypSandboxPolicyService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'sandboxPolicy');
    this.getSettings = typeof config.getSettings === 'function'
      ? config.getSettings
      : async () => ({});
  }

  async resolve(scope = {}) {
    const settings = await this.getSettings();
    const sandbox = (settings && settings.sandbox) || {};
    const mode = (scope && scope.mode)
      || (scope && scope.session && scope.session.mode === 'code' ? sandbox.codeMode : null)
      || (scope && scope.session && scope.session.mode === 'babe' ? sandbox.babeMode : null)
      || (scope && scope.session && scope.session.mode === 'chat' ? sandbox.chatMode : null)
      || sandbox.defaultMode
      || 'danger-full-access';
    return { kind: 'cibyp', mode };
  }
}

/** approval seam：经 transport 向渲染进程弹授权/问卷模态框，等待用户裁决。 */
class CibypApprovalService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'approval');
    this.transport = config.transport || null;
  }

  async request(req = {}) {
    if (!this.transport || typeof this.transport.request !== 'function') {
      throw new Error('CIBYP: approval 传输通道未就绪');
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      id,
      toolName: req.toolName || 'plugin',
      reason: req.reason || '',
      callId: req.callId || null,
      sessionKey: (req.agent && (req.agent.id || (req.agent.session && req.agent.session.header && req.agent.session.header.id))) || (req.session && req.session.header && req.session.header.id) || null
    };
    return await this.transport.request('ds:approvalRequest', payload, 300000, req.signal);
  }
}

module.exports = {
  CibypAgentsService,
  CibypSessionsService,
  CibypLlmService,
  CibypSandboxPolicyService,
  CibypApprovalService,
  messageText,
  mapAgentStatus
};
