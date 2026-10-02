/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 无头 Agent 运行时：在主进程里承载 Agent 内核，供 WebUI / 自动化 / 测试驱动，
 * 不依赖任何浏览器窗口。
 *
 * 组成：
 *   - api 门面：由 src/agent/preload-api.js 从 preload.js 派生，经 ipc-dispatch
 *     分发回主进程自己的 IPC handler（与渲染进程同一套能力，零重复实现）；
 *   - 会话注册表：sessionKey → Agent 实例（chat/code/babe 均可）；
 *   - 交互请求：审批 / 工具授权 / 向用户提问统一为 pendingInteraction，
 *     任何前端（WebUI、自动化策略）都能应答；
 *   - 事件流：Agent 的 onMessage 事件统一成 session-event，前端各取所需渲染。
 */

'use strict';

const { loadAgentCore, loadPreloadApi, createRuntimeHost } = require('../agent/index.js');
const { createIpcDispatch } = require('./core/ipc-dispatch.js');

/** 交互决策策略：'prompt' 等待前端应答；'auto-approve' 自动放行（脚本化/测试用）。 */
const INTERACTION_POLICY = Object.freeze({
  PROMPT: 'prompt',
  AUTO_APPROVE: 'auto-approve',
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
        // 自动放行：审批通过、授权仅本次、提问返回空答复
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

  /** Agent 事件 → 会话事件流（前端据此渲染；WebUI 驱动器另见 webui-agent-driver.js）。 */
  function handleAgentMessage(session, type, data) {
    switch (type) {
      case 'approval': {
        // 工具执行前的用户审批：挂起等待 respond()
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
        emit({
          type: 'tool-call',
          key: session.key,
          name: data.name,
          args: data.args,
          status: 'running',
          callId: data.callId,
        });
        return;
      case 'tool-result':
        emit({
          type: 'tool-call',
          key: session.key,
          name: data.name,
          result:
            typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? null),
          status: 'done',
        });
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
      case 'present-file':
        emit({
          type: 'message',
          key: session.key,
          role: 'assistant',
          content: data && data.summary ? data.summary : JSON.stringify(data),
        });
        return;
      default:
        emit({ type, key: session.key, data });
    }
  }

  function createSession({ key, mode = 'chat', minimalMode = false } = {}) {
    const sessionKey =
      key || `headless:${mode}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const existing = sessions.get(sessionKey);
    if (existing) return existing;

    // 会话对象先于 Agent 建立：交互请求（审批/授权/提问）要挂到会话上，
    // 而 Agent 的 host 回调在构造期就要能引用它。
    const session = {
      key: sessionKey,
      mode,
      agent: null,
      status: 'idle',
      busy: false,
      title: '',
      createdAt: Date.now(),
      pendingInteraction: null,
    };
    sessions.set(sessionKey, session);

    session.agent = createRuntimeAgent(session, minimalMode);
    session.agent.onMessage = (type, data) => handleAgentMessage(session, type, data);
    session.agent.onStatusChange = (status) => {
      session.status = status;
      emit({ type: 'status', key: sessionKey, status });
    };
    session.agent.onTitleChange = (title) => {
      session.title = title || '';
      emit({ type: 'title', key: sessionKey, title: session.title });
    };
    emit({ type: 'session-created', key: sessionKey, mode, session: sessionSnapshot(session) });
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
    session.initialized = true;
  }

  return {
    INTERACTION_POLICY,
    api,
    core,
    sessions,

    /** 事件订阅（会话生命周期 / 消息 / 工具调用 / 交互请求）。返回卸载函数。 */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
     * 返回 { ok, error?, conversationId?, title? }
     */
    async sendMessage(key, message, attachments = []) {
      const session = createSession({ key });
      if (session.busy) return { ok: false, error: 'session busy: 上一轮尚未结束' };
      session.busy = true;
      session.status = 'running';
      emit({ type: 'message', key: session.key, role: 'user', content: message });
      emit({ type: 'status', key: session.key, status: 'running' });
      try {
        await ensureInitialized(session);
        await session.agent.sendMessage(message, attachments);
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

    /** 应答挂起的交互请求（审批 / 授权 / 提问）。 */
    respond(key, response) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      return { ok: respondInteraction(session, response) };
    },

    /** 提问工具的答复（answers 数组）。 */
    answerQuestions(key, answers) {
      return this.respond(key, { answers: Array.isArray(answers) ? answers : [] });
    },

    /** 中止当前轮次。 */
    stop(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.agent.stop();
      respondInteraction(session, false);
      return { ok: true };
    },

    /** 关闭会话（保留历史）。 */
    close(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.agent.stop();
      respondInteraction(session, false);
      sessions.delete(key);
      emit({ type: 'session-closed', key });
      return { ok: true };
    },
  };
}

module.exports = { createAgentRuntime, INTERACTION_POLICY };
