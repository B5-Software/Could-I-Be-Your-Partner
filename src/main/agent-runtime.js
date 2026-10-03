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

const {
  loadAgentCore,
  loadPreloadApi,
  createRuntimeHost,
  createTodoStore,
} = require('../agent/index.js');
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
  // Todos belong to the App, including TUI/WebUI. A single store preserves
  // revisions across sessions and forwards edits made by any frontend.
  const todos = createTodoStore(api, () => emit({ type: 'todo', items: todos.todoItems }));

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
      model: session.agent?.getActiveModelId() || '',
      workspacePath: session.agent ? session.agent.workspacePath : null,
      hostWorkspacePath: session.hostWorkspacePath || null,
      conversationId: session.agent ? session.agent.conversationId : null,
      affection: session.agent ? session.agent.babeAffection : null,
      pendingInteraction: session.pendingInteraction ? session.pendingInteraction.kind : null,
      createdAt: session.createdAt,
    };
  }

  /** 会话成本：按 settings.budget.models 定价（未配置返回 null → 前端不显示 $） */
  function computeSessionCost(agent, settings) {
    const models = (settings && settings.budget && settings.budget.models) || {};
    const pricingTable = (() => {
      try {
        return require('../shared/generated/pricing.cjs');
      } catch {
        return null;
      }
    })();
    if (!pricingTable || typeof pricingTable.calculateTokenCost !== 'function') return null;
    const priceFor = (model) => {
      const p = models[model];
      if (!p) return null;
      const hasNew =
        p.inputPerM != null ||
        p.outputPerM != null ||
        p.cacheReadPerM != null ||
        p.cacheWritePerM != null;
      const hasOld = p.promptPerK != null || p.completionPerK != null;
      if (!hasNew && !hasOld) return null;
      return Object.assign({}, p, {
        hasCacheWrite: p.hasCacheWrite != null ? !!p.hasCacheWrite : /claude/i.test(String(model)),
      });
    };
    const peak = (settings && settings.budget && settings.budget.peakHours) || {};
    const timezone = settings && settings.budget && settings.budget.timezone;
    let total = 0;
    let priced = false;
    const byModel = agent.sessionUsageByModel || {};
    const buckets = Object.keys(byModel).length > 0 ? byModel : null;
    if (buckets) {
      for (const [model, usage] of Object.entries(buckets)) {
        const pricing = priceFor(model);
        if (!pricing) continue;
        priced = true;
        total += pricingTable.calculateTokenCost(
          usage || {},
          pricing,
          peak,
          Date.now(),
          timezone,
        ).totalCost;
      }
    } else {
      const pricing = priceFor(settings && settings.llm && settings.llm.model);
      if (pricing) {
        priced = true;
        total += pricingTable.calculateTokenCost(
          agent.sessionUsage || {},
          pricing,
          peak,
          Date.now(),
          timezone,
        ).totalCost;
      }
    }
    return priced ? total : null;
  }

  function getStats(key) {
    const session = sessions.get(key);
    if (!session || !session.agent) return null;
    const agent = session.agent;
    const settings = agent.settings || {};
    const limits = typeof agent.getTokenLimits === 'function' ? agent.getTokenLimits() : null;
    // 上下文口径与 GUI 一致：getUsageBreakdown() 含输出预留的占比
    const breakdown =
      agent.contextManager && typeof agent.contextManager.getUsageBreakdown === 'function'
        ? agent.contextManager.getUsageBreakdown()
        : null;
    const max = breakdown && breakdown.max ? breakdown.max : limits ? limits.contextTokens : 0;
    const used =
      breakdown && typeof breakdown.used === 'number'
        ? breakdown.used
        : agent.contextManager && typeof agent.contextManager.getRawTotalTokens === 'function'
          ? agent.contextManager.getRawTotalTokens()
          : 0;
    const reserve = breakdown && typeof breakdown.reserve === 'number' ? breakdown.reserve : 0;
    return {
      usage: Object.assign({}, agent.sessionUsage || {}),
      usageByModel: Object.assign({}, agent.sessionUsageByModel || {}),
      context: {
        used,
        max,
        reserve,
        // 与 GUI 圆环一致：占比含输出预留
        pct: max ? Math.min(100, ((used + reserve) / max) * 100) : 0,
        inputPct: max ? Math.min(100, (used / max) * 100) : 0,
        exact: breakdown ? breakdown.exact !== false : true,
      },
      costUSD: computeSessionCost(agent, settings),
      affection: typeof agent.babeAffection === 'number' ? agent.babeAffection : null,
      workingMs: agent.workingMs || 0,
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
      // The Agent core calls active work "working"; frontends use "running".
      // Normalize here so the first tarot draw cannot clear the TUI spinner.
      session.status = status === 'working' ? 'running' : status;
      emit({ type: 'status', key: sessionKey, status: session.status });
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
        todos,
        events: eventBus,
        onInteractive: (kind, payload) =>
          requestInteraction(session, kind === 'askQuestions' ? 'questions' : kind, payload),
      }),
    });
    agent.host.onNotify((notificationType, payload) =>
      emit({ type: 'notification', key: session.key, notificationType, payload }),
    );
    agent.sessionKey = session.key;
    agent.mode = session.mode;
    agent.minimalMode = minimalMode;
    agent._fromWeb = true; // 无界面环境：窗口类工具（游戏邀请等）直接拒绝
    return agent;
  }

  async function ensureInitialized(session) {
    if (session.initialized) return;
    await api.startupRuntime();
    await todos.load();
    if (session.mode === 'code') {
      const workspace = await validateWorkspace(session.agent.codeWorkspacePath);
      if (!workspace.ok) throw new Error(workspace.error);
      session.agent.workspacePath = workspace.path;
      session.agent.codeWorkspacePath = workspace.path;
      session.hostWorkspacePath = session.hostWorkspacePath || workspace.hostPath;
    }
    // 语言要在系统提示生成之前确定（系统提示/工具描述跟随 settings.language）
    try {
      const settings = await api.getSettings();
      if (settings && settings.language) {
        const i18n = core.i18n;
        if (i18n && typeof i18n.i18nSetLanguage === 'function')
          i18n.i18nSetLanguage(settings.language);
      }
    } catch {
      /* 语言读取失败沿用当前语言 */
    }
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

  async function validateWorkspace(directory, options) {
    await api.startupRuntime();
    const target = await api.workspaceResolve(directory, options);
    if (!target?.ok) return target || { ok: false, error: 'Workspace cannot be prepared' };
    const result = await api.workspaceGetFileTree(target.path);
    return result?.ok
      ? { ...target, tree: result.tree }
      : { ok: false, error: result?.error || 'Workspace cannot be read' };
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
        out.push({
          role: message.role,
          content: message.content || '',
          reasoning: message.reasoning || message.reasoning_content || '',
        });
      } else if (message.role === 'tool') {
        out.push({ role: 'tool', name: message.name || 'tool', content: message.content || '' });
      } else if (message.role === 'system') {
        out.push({ role: 'system', content: message.content || '' });
      }
    }
    return out;
  }

  let settingsRevision = 0;
  function applyRuntimeSettings(settings) {
    if (settings?.language) core.i18n.i18nSetLanguage(settings.language);
    for (const session of sessions.values())
      session.agent.applySettings({ ...settings, tools: { ...settings.tools, codeIDE: false } });
    emit({ type: 'settingsChanged' });
  }
  api.onSettingsChanged?.(async () => {
    const revision = ++settingsRevision;
    try {
      const settings = await api.getSettings();
      if (revision === settingsRevision) applyRuntimeSettings(settings);
    } catch (error) {
      log.warn?.('[agent-runtime] Settings refresh failed: ' + error.message);
    }
  });
  api.onThemeChanged?.(() => emit({ type: 'settingsChanged' }));
  api.onSkillsChanged?.(() => {
    for (const session of sessions.values())
      session.agent
        .refreshSkillsCatalog()
        .then(() => session.agent.contextManager?.setSystemPrompt(session.agent.getSystemPrompt()))
        .catch((error) => log.warn?.('[agent-runtime] ' + error.message));
  });

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

    getSystemTheme() {
      return api.getTheme();
    },

    async saveSettings(patch) {
      const result = await api.setSettings(patch);
      settingsRevision++;
      applyRuntimeSettings(result);
      return result;
    },
    async openCurrentDirectory(key) {
      const session = sessions.get(key);
      return api.workspaceOpenCurrent(session?.agent.workspacePath);
    },

    async getTodos() {
      await todos.load();
      return todos.todoItems;
    },

    toggleTodo(id) {
      return todos.handleTodo({ action: 'toggle', id });
    },

    /** 界面/系统提示语言（沿用 GUI 的 settings.language；中文为源文） */
    setLanguage(language) {
      const i18n = core.i18n;
      if (i18n && typeof i18n.i18nSetLanguage === 'function') {
        i18n.i18nSetLanguage(language || 'zh-CN');
        return {
          ok: true,
          language: typeof i18n.i18nGetLanguage === 'function' ? i18n.i18nGetLanguage() : language,
        };
      }
      return { ok: false, language: 'zh-CN' };
    },

    getLanguage() {
      const i18n = core.i18n;
      return i18n && typeof i18n.i18nGetLanguage === 'function' ? i18n.i18nGetLanguage() : 'zh-CN';
    },

    listSessions() {
      return [...sessions.values()].map(sessionSnapshot);
    },

    getSession(key) {
      const session = sessions.get(key);
      return session ? sessionSnapshot(session) : null;
    },

    getSessionDetails(key) {
      const session = sessions.get(key);
      if (!session) return null;
      return {
        messages: flattenMessages({ messages: session.agent.contextManager?.messages || [] }),
        pendingInteraction: session.pendingInteraction
          ? { kind: session.pendingInteraction.kind, payload: session.pendingInteraction.payload }
          : null,
      };
    },

    createSession,

    /**
     * 发送用户消息并跑完整个 Agent 循环（阻塞到本轮结束）。
     * 会话忙时自动降级为热消息注入（工作中追加指令）。
     */
    async sendMessage(key, message, attachments = []) {
      const session = createSession({ key, mode: 'chat' });
      if (session.rewinding) return { ok: false, error: 'Conversation is being rewound' };
      if (session.loadingHistory) return { ok: false, error: 'Conversation is still loading' };
      if (session.busy) {
        session.agent.injectHotMessage(message, attachments || []);
        emit({ type: 'message', key: session.key, role: 'user', content: message, injected: true });
        return { ok: true, injected: true };
      }
      session.busy = true;
      session.unadmittedInput = {
        text: message,
        start: session.agent.contextManager.getHistoryMessages().length,
      };
      session.finished = new Promise((resolve) => {
        session.finish = resolve;
      });
      session.stopRequested = false;
      session.status = 'running';
      emit({ type: 'message', key: session.key, role: 'user', content: message });
      emit({ type: 'status', key: session.key, status: 'running' });
      try {
        await ensureInitialized(session);
        if (session.stopRequested) return { ok: true, stopped: true };
        await session.agent.sendMessage(message, attachments || []);
        if (
          session.mode === 'code' &&
          session.hostWorkspacePath &&
          session.agent.settings.runtime?.workspaceMode !== 'isolated'
        ) {
          // Exports use the sync queue, without keeping the conversation busy
          // after the Agent has stopped accepting hot messages.
          const reportSyncError = (error) =>
            emit({
              type: 'message',
              key,
              role: 'system',
              content: 'Workspace synchronization failed: ' + error,
            });
          api
            .workspaceSync(session.agent.workspacePath, session.hostWorkspacePath)
            .then((sync) => {
              if (sync?.ok === false) reportSyncError(sync.error);
            })
            .catch((error) => reportSyncError(error.message));
        }
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
        if (
          session.unadmittedInput &&
          session.agent.contextManager
            .getHistoryMessages()
            .slice(session.unadmittedInput.start)
            .some((m) => m.role === 'user' && m.metadata?.kind !== 'context-update')
        )
          session.unadmittedInput = null;
        session.busy = false;
        session.finish?.();
        session.status = 'idle';
        // 每轮结束推送用量/成本/上下文统计 → 前端状态栏
        try {
          this.emitUsageStats(session.key);
        } catch {
          /* 统计推送失败不影响主流程 */
        }
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
      session.stopRequested = true;
      session.agent.stop();
      respondInteraction(session, false);
      return { ok: true };
    },

    async undo(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: 'Unknown session' };
      if (session.loadingHistory) return { ok: false, error: 'Conversation is still loading' };
      if (session.rewinding) return { ok: false, error: 'Conversation is being rewound' };
      session.rewinding = true;
      try {
        const pending = session.agent.hotMessages.slice();
        this.stop(key);
        if (session.busy) await session.finished;
        const context = session.agent.contextManager;
        if (!pending.length && session.unadmittedInput) {
          const text = session.unadmittedInput.text;
          session.unadmittedInput = null;
          return { ok: true, text };
        }
        if (pending.length) {
          for (const message of pending.slice(0, -1)) context.addUserMessage(message);
          await session.agent.saveToHistory();
          this.emitUsageStats(key);
          return { ok: true, text: pending.at(-1) };
        }
        const history = context.getHistoryMessages();
        const index = history.findLastIndex(
          (message) => message.role === 'user' && message.metadata?.kind !== 'context-update',
        );
        if (index < 0) return { ok: false, error: 'No user message to undo' };
        const content = history[index].content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n')
              : '';
        context.loadFromHistory(history.slice(0, index));
        await session.agent.saveToHistory();
        this.emitUsageStats(key);
        return { ok: true, text };
      } finally {
        session.rewinding = false;
      }
    },

    /** 关闭会话（保留历史） */
    close(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      session.stopRequested = true;
      session.agent.stop();
      respondInteraction(session, false);
      sessions.delete(key);
      emit({ type: 'session-closed', key });
      return { ok: true };
    },

    /** Open a desktop window; its renderer prepares the existing VM graphics. */
    async openVmDesktop() {
      if (!api.vm || typeof api.vm.openDesktop !== 'function') {
        return { ok: false, error: 'vm API unavailable' };
      }
      return api.vm.openDesktop();
    },

    /** 推送一次用量/成本统计（用量事件 → TUI 状态栏） */
    emitUsageStats(key) {
      const session = sessions.get(key);
      if (!session) return;
      const stats = getStats(key);
      if (!stats) return;
      emit({
        type: 'usage',
        key: session.key,
        usage: stats.usage,
        context: stats.context,
        costUSD: stats.costUSD,
      });
    },
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
    listLocalWorkspaceDirectories: (directory) => api.workspaceListLocalDirectories(directory),

    async syncWorkspace(key) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: 'Unknown session' };
      return api.workspaceSync(session.agent.workspacePath, session.hostWorkspacePath);
    },

    async prepareWorkspace(key, workspacePath, options = {}) {
      return this.setWorkspace(key, workspacePath, { ...options, create: !workspacePath });
    },

    async setWorkspace(key, workspacePath, options = {}) {
      const session = sessions.get(key);
      if (!session) return { ok: false, error: `unknown session: ${key}` };
      if (session.busy)
        return { ok: false, error: 'Stop the running task before changing workspace' };
      if (!workspacePath && !options.create)
        return { ok: false, error: 'Workspace path is required' };
      const workspace = await validateWorkspace(workspacePath, options);
      if (!workspace.ok) return workspace;
      if (session.busy) return { ok: false, error: 'Task started while selecting workspace' };
      session.agent.workspacePath = workspace.path;
      session.agent.codeWorkspacePath = workspace.path;
      session.agent.cachedWorkspaceTree = workspace.tree;
      session.hostWorkspacePath = workspace.hostPath;
      api.webControlSetWorkDir(workspace.path);
      if (session.mode === 'code') await api.codeSetLastWorkspace(workspace.path);
      return { ok: true, workspacePath: workspace.path, hostPath: workspace.hostPath };
    },

    getStats,
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
      if (session.busy)
        return { ok: false, error: 'Stop the running task before replacing its conversation' };
      session.busy = true;
      session.loadingHistory = true;
      session.stopRequested = false;
      try {
        const conv = await historyGet(session.mode, id, session.agent.workspacePath);
        if (!conv || conv.ok === false)
          return { ok: false, error: (conv && conv.error) || '历史会话不存在' };
        await ensureInitialized(session);
        if (session.stopRequested) return { ok: false, error: 'Conversation loading cancelled' };
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
      } finally {
        session.loadingHistory = false;
        session.busy = false;
      }
    },
  };
}

module.exports = { createAgentRuntime, INTERACTION_POLICY, MODES };
