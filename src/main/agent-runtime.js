/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 无头 Agent 运行时：在主进程里承载 Agent 内核，供 TUI / WebUI / 自动化 / 测试驱动，
 * 不依赖任何浏览器窗口。
 *
 * 组成：
 *   - api 门面：由 src/agent/preload-api.js 从 preload.js 派生，经 ipc-dispatch
 *     分发回主进程自己的 IPC handler（与渲染进程同一套能力，零重复实现）；
 *   - 会话注册表：sessionKey → Agent 实例（chat / babe / code 均可）；
 *   - 交互请求：审批 / 工具授权 / 向用户提问统一为 pendingInteraction，
 *     任何前端都能应答（TUI 弹窗、WebUI 按钮、自动化策略）；
 *   - 事件流：Agent 的消息/工具/状态事件统一成 session-event，前端各取所需渲染；
 *   - 历史：按模式分流 chat/babe/code 三条历史通道。
 *
 * 注：Code 模式在此为**纯 Agent**（工作区 + 代码工具 + 终端），不接 CodeOSS/IDE；
 * codeIDE 工具在无界面环境下显式禁用，避免模型徒劳调用。
 */

'use strict';

const { loadAgentCore, loadPreloadApi, createRuntimeHost } = require('../agent/index.js');
const { createIpcDispatch } = require('./core/ipc-dispatch.js');

/** 交互决策策略：'prompt' 等待前端应答；'auto-approve' 自动放行（脚本化/测试用）。 */
const INTERACTION_POLICY = Object.freeze({
  PROMPT: 'prompt',
  AUTO_APPROVE: 'auto-approve',
});

const MODES = Object.freeze(['chat', 'babe', 'code']);

/** 各模式的历史通道（与 preload 暴露的方法名一致） */
const HISTORY_API = Object.freeze({
  chat: { list: 'historyList', get: 'historyGet', del: 'historyDelete', rename: 'historyRename' },
  babe: {
    list: 'babeHistoryList',
    get: 'babeHistoryGet',
    del: 'babeHistoryDelete',
    rename: 'babeHistoryRename',
  },
});

function createAgentRuntime({
  ipcMain,
  eventBus,
  getSettings,
  interactionPolicy = INTERACTION_POLICY.PROMPT,
  log = console,
} = {}) {
  if (!ipcMain) throw new TypeError('createAgentRuntime: ipcMain is required');
  if (!eventBus) throw new TypeError('createAgentRuntime: eventBus is required');

  const dispatch = createIpcDispatch({
    ipcMain,
    publishEvent: (channel, payload) => eventBus.publish(channel, payload),
    subscribe: (channel, fn) => eventBus.subscribe(channel, fn),
  });
  const api = loadPreloadApi(dispatch);
  const core = loadAgentCore();

  const sessions = new Map();
  const listeners = new Set();

  function emit(event) {
    eventBus.publish('agent:session-event', event);
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        log.warn?.(`[agent-runtime] listener failed: ${error.message}`);
      }
    }
  }

  function sessionSnapshot(session) {
    return {
      key: session.key,
      mode: session.mode,
      status: session.status,
      busy: session.busy,
      title: session.title,
      workspacePath: session.agent ? session.agent.workspacePath : null,
      conversationId: session.agent ? session.agent.conversationId : null,
      affection: session.agent ? session.agent.babeAffection : null,
      pendingInteraction: session.pendingInteraction ? session.pendingInteraction.kind : null,
      createdAt: session.createdAt,
    };
  }

  /** 统一的交互请求：审批 / 工具授权 / 向用户提问。 */
  function requestInteraction(session, kind, payload) {
    return new Promise((resolve) => {
      const interaction = { kind, payload, resolve, at: Date.now() };
      session.pendingInteraction = interaction;
      emit({ type: 'interaction', key: session.key, kind, payload });
      if (interactionPolicy === INTERACTION_POLICY.AUTO_APPROVE) {
        respondInteraction(
          session,
          kind === 'questions' ? { answers: [] } : kind === 'tool-auth' ? 'allow-once' : true,
        );
      }
    });
  }

  function respondInteraction(session, response) {
    const interaction = session.pendingInteraction;
    if (!interaction) return false;
    session.pendingInteraction = null;
    // 提问工具的应答形状是 answers 数组（agent.js 的 askQuestions 直接返回数组）
    const value =
      interaction.kind === 'questions'
        ? response && Array.isArray(response.answers)
          ? response.answers
          : []
        : response;
    interaction.resolve(value);
    emit({ type: 'interaction-resolved', key: session.key, kind: interaction.kind });
    return true;
  }

  /** Agent 消息事件 → 会话事件流 */
  function handleAgentMessage(session, type, data) {
    switch (type) {
      case 'approval': {
        requestInteraction(session, 'approval', { toolName: data.toolName, args: data.args }).then(
          (approved) => session.agent.resolveApproval(approved !== false),
        );
        return;
      }
      case 'tool-auth-required': {
        requestInteraction(session, 'tool-auth', {
          toolName: data.toolName,
          category: data.category,
        }).then((decision) => session.agent.resolveToolAuth(decision || 'deny'));
        return;
      }
      case 'tool_call':
      case 'tool-result':
        // 工具状态统一走 onToolCall（带 callId 与 denied 状态），这里不重复发
        return;
      case 'assistant':
      case 'system':
      case 'error':
        emit({
          type: 'message',
          key: session.key,
          role: type === 'error' ? 'system' : type,
          content: data,
        });
        return;
      case 'stream-start':
      case 'stream-chunk':
      case 'stream-end':
        emit({ type, key: session.key, data });
        return;
      default:
        // affection-change / tarot / sub-agent-* / present-file /
        // optimize-tools-* / session-model-locked 等原样透传
        emit({ type, key: session.key, data });
    }
  }

  /** 工具调用状态（含 denied）：GUI 的 onToolCall 回调在这里被翻译成事件 */
  function handleToolCall(session, name, args, status, result, callId) {
    const mapped =
      status === 'calling'
        ? 'running'
        : status === 'denied'
          ? 'denied'
          : status === 'done'
            ? 'done'
            : 'error';
    emit({
      type: 'tool-call',
      key: session.key,
      name,
      args,
      status: mapped,
      result: typeof result === 'string' ? result : result == null ? null : JSON.stringify(result),
      callId: callId || null,
    });
  }

  function createSession({
    key,
    mode = 'chat',
    workspacePath = null,
    codeWorkspacePath = null,
    minimalMode = false,
  } = {}) {
    const sessionMode = MODES.includes(mode) ? mode : 'chat';
    const sessionKey =
      key ||
      `headless:${sessionMode}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const existing = sessions.get(sessionKey);
    if (existing) return existing;

    // 会话对象先于 Agent 建立：交互请求要挂到会话上，
    // 而 Agent 的 host 回调在构造期就要能引用它。
    const session = {
      key: sessionKey,
      mode: sessionMode,
      agent: null,
      status: 'idle',
      busy: false,
      title: '',
      createdAt: Date.now(),
      pendingInteraction: null,
    };
    sessions.set(sessionKey, session);

    session.agent = createRuntimeAgent(session, minimalMode);
    // Code 模式：以工作区为中心的纯 Agent（不接 CodeOSS/IDE）
    if (sessionMode === 'code') {
      session.agent.workspacePath = workspacePath || null;
      session.agent.codeWorkspacePath = codeWorkspacePath || workspacePath || null;
    }
    session.agent.onMessage = (type, data) => handleAgentMessage(session, type, data);
    session.agent.onToolCall = (name, args, status, result, callId) =>
      handleToolCall(session, name, args, status, result, callId);
    session.agent.onTodoUpdate = (items) =>
      emit({ type: 'todo', key: sessionKey, items: Array.isArray(items) ? items : [] });
    session.agent.onStatusChange = (status) => {
      session.status = status;
      emit({ type: 'status', key: sessionKey, status });
    };
    session.agent.onTitleChange = (title) => {
      session.title = title || '';
      emit({ type: 'title', key: sessionKey, title: session.title });
    };
    emit({
      type: 'session-created',
      key: sessionKey,
      mode: sessionMode,
      session: sessionSnapshot(session),
    });
    return session;
  }

  function createRuntimeAgent(session, minimalMode) {
    const agent = new core.Agent({
      host: createRuntimeHost({
        api,
        events: eventBus,
        onInteractive: (kind, payload) =>
          requestInteraction(session, kind === 'askQuestions' ? 'questions' : kind, payload),
      }),
    });
    agent.sessionKey = session.key;
    agent.mode = session.mode;
    agent.minimalMode = minimalMode;
    agent._fromWeb = true; // 无界面环境：窗口类工具（游戏邀请等）直接拒绝
    return agent;
  }

  async function ensureInitialized(session) {
    if (session.initialized) return;
    await session.agent.init();
    // 无界面运行：codeIDE 依赖 CodeOSS 窗口，显式禁用以免模型徒劳调用
    if (session.agent.settings && typeof session.agent.settings === 'object') {
      session.agent.settings.tools = Object.assign({}, session.agent.settings.tools, {
        codeIDE: false,
      });
    }
    // Babe：初始好感度取设置（与 GUI 建会话一致）；载入历史时由 loadFromHistory 覆盖
    if (session.mode === 'babe' && session.agent.babeAffection === 0) {
      const initial =
        session.agent.settings &&
        session.agent.settings.babe &&
        session.agent.settings.babe.initialAffection;
      if (typeof initial === 'number') session.agent.babeAffection = initial;
    }
    session.initialized = true;
  }

  // ------------------------------------------------------------- 历史（按模式）

  /** 各历史通道返回形状不一（数组 / {ok,history} / {ok,list}），统一归一化 */
  function normalizeList(res) {
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object') {
      if (Array.isArray(res.history)) return res.history;
      if (Array.isArray(res.list)) return res.list;
      if (Array.isArray(res.items)) return res.items;
      if (Array.isArray(res.data)) return res.data;
    }
    return [];
  }

  /** 会话详情归一化（{ok,data} / {conversation} / 裸会话对象） */
  function normalizeConversation(res) {
    if (!res) return null;
    if (res.ok === false) return res;
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) return res.data;
    if (res.conversation && typeof res.conversation === 'object') return res.conversation;
    return res;
  }

  async function historyList(mode, workspacePath) {
    if (mode === 'code') {
      const ws = workspacePath || null;
      if (!ws) return [];
      return normalizeList(await api.codeListHistory(ws));
    }
    const names = HISTORY_API[mode] || HISTORY_API.chat;
    return normalizeList(await api[names.list]());
  }

  async function historyGet(mode, id, workspacePath) {
    if (mode === 'code') {
      const ws = workspacePath || null;
      if (!ws) return null;
      return normalizeConversation(await api.codeLoadHistory(ws, id));
    }
    const names = HISTORY_API[mode] || HISTORY_API.chat;
    return normalizeConversation(await api[names.get](id));
  }

  async function historyDelete(mode, id, workspacePath) {
    if (mode === 'code') {
      return api.codeDeleteHistory(workspacePath || null, id);
    }
    const names = HISTORY_API[mode] || HISTORY_API.chat;
    return api[names.del](id);
  }

  async function historyRename(mode, id, title, workspacePath) {
    if (mode === 'code') {
      return { ok: false, error: 'Code 模式历史不支持重命名' };
    }
    const names = HISTORY_API[mode] || HISTORY_API.chat;
    return api[names.rename](id, title);
  }

  /** 历史消息 → 前端可渲染的扁平列表 */
  function flattenMessages(conversation) {
    const out = [];
    for (const message of (conversation && conversation.messages) || []) {
      if (!message || typeof message !== 'object') continue;
      if (message.role === 'user' || message.role === 'assistant') {
        out.push({ role: message.role, content: message.content || '' });
      } else if (message.role === 'tool') {
        out.push({ role: 'tool', name: message.name || 'tool', content: message.content || '' });
      } else if (message.role === 'system') {
        out.push({ role: 'system', content: message.content || '' });
      }
    }
    return out;
  }

  return {
    INTERACTION_POLICY,
    MODES,
    api,
    core,
    sessions,

    /** 事件订阅（会话生命周期 / 消息 / 工具调用 / 交互请求）。返回卸载函数。 */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 设置快照（前端展示模型/人格等） */
    getSettings() {
      return api.getSettings();
    },

    listSessions() {
      return [...sessions.values()].map(sessionSnapshot);
    },

    getSession(key) {
      const session = sessions.get(key);
      return session ? sessionSnapshot(session) : null;
    },

    createSession,

    /**
     * 发送用户消息并跑完整个 Agent 循环（阻塞到本轮结束）。
     * 会话忙时自动降级为热消息注入（工作中追加指令）。
     */
    async sendMessage(key, message, attachments = []) {
      const session = createSession({ key, mode: 'chat' });
      if (session.busy) {
        session.agent.injectHotMessage(message, attachments || []);
        emit({ type: 'message', key: session.key, role: 'user', content: message, injected: true });
        return { ok: true, injected: true };
      }
      session.busy = true;
      session.status = 'running';
      emit({ type: 'message', key: session.key, role: 'user', content: message });
      emit({ type: 'status', key: session.key, status: 'running' });
      try {
        await ensureInitialized(session);
        await session.agent.sendMessage(message, attachments || []);
        return {
          ok: true,
          conversationId: session.agent.conversationId,
          title: session.title,
          workspacePath: session.agent.workspacePath,
        };
      } catch (error) {
        emit({
          type: 'message',
          key: session.key,
          role: 'system',
          content: `[错误] ${error.message}`,
        });
        return { ok: false, error: error.message };
      } finally {
        session.busy = false;
        session.status = 'idle';
        emit({ type: 'status', key: session.key, status: 'idle' });
      }
    },

    /** 热消息注入（工作中追加指令）；会话空闲时等价 sendMessage */
    async inject(key, message, attachments = []) {
      return this.sendMessage(key, message, attachments);
    },

    /** 应答挂起的交互请求（审批 true/false、授权 'allow-always'|'allow-once'|'deny'、提问 {answers}） */
    respond(key, response) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      return { ok: respondInteraction(session, response) };
    },

    /** 提问工具的答复（answers 数组） */
    answerQuestions(key, answers) {
      return this.respond(key, { answers: Array.isArray(answers) ? answers : [] });
    },

    /** 中止当前轮次 */
    stop(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.agent.stop();
      respondInteraction(session, false);
      return { ok: true };
    },

    /** 关闭会话（保留历史） */
    close(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.agent.stop();
      respondInteraction(session, false);
      sessions.delete(key);
      emit({ type: 'session-closed', key });
      return { ok: true };
    },

    /** 设置会话标题并即时持久化 */
    async setTitle(key, title) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.title = String(title || '');
      session.agent.conversationTitle = session.title;
      emit({ type: 'title', key, title: session.title });
      try {
        await session.agent.saveToHistory();
      } catch {
        /* 持久化失败不影响标题生效 */
      }
      return { ok: true };
    },

    /** 设置工作区（Code 模式） */
    setWorkspace(key, workspacePath) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.agent.workspacePath = workspacePath || null;
      session.agent.codeWorkspacePath = workspacePath || null;
      return { ok: true, workspacePath: session.agent.workspacePath };
    },

    /** 运行统计（用量 / 上下文 / 好感度），同步读取 */
    getStats(key) {
      const session = sessions.get(key);
      if (!session || !session.agent) return null;
      const agent = session.agent;
      const limits = typeof agent.getTokenLimits === 'function' ? agent.getTokenLimits() : null;
      return {
        usage: Object.assign({}, agent.sessionUsage || {}),
        context: {
          used:
            agent.contextManager && typeof agent.contextManager.getRawTotalTokens === 'function'
              ? agent.contextManager.getRawTotalTokens()
              : 0,
          max: limits ? limits.contextTokens : 0,
        },
        affection: typeof agent.babeAffection === 'number' ? agent.babeAffection : null,
        workingMs: agent.workingMs || 0,
      };
    },

    // ------------------------------------------------------------- 历史接口

    listHistory: (mode, workspacePath) => historyList(mode || 'chat', workspacePath),
    getHistory: (mode, id, workspacePath) => historyGet(mode || 'chat', id, workspacePath),
    deleteHistory: (mode, id, workspacePath) => historyDelete(mode || 'chat', id, workspacePath),
    renameHistory: (mode, id, title, workspacePath) =>
      historyRename(mode || 'chat', id, title, workspacePath),

    /**
     * 把历史会话载入到某个会话槽（覆盖其上下文）。
     * 返回 { ok, title, messages }，messages 为可渲染的扁平列表。
     */
    async openHistory(key, id) {
      const session = createSession({ key, mode: 'chat' });
      const conv = await historyGet(session.mode, id, session.agent.workspacePath);
      if (!conv || conv.ok === false)
        return { ok: false, error: (conv && conv.error) || '历史会话不存在' };
      await ensureInitialized(session);
      await session.agent.loadFromHistory(conv);
      session.title = conv.title || '';
      emit({ type: 'title', key: session.key, title: session.title });
      return {
        ok: true,
        id: conv.id || id,
        title: conv.title || '',
        affection: typeof conv.affection === 'number' ? conv.affection : null,
        messages: flattenMessages(conv),
      };
    },
  };
}

module.exports = { createAgentRuntime, INTERACTION_POLICY, MODES };
