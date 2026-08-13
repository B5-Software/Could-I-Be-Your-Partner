/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

(function () {
  'use strict';

  class AppEventBus extends EventTarget {
    on(type, handler) {
      this.addEventListener(type, handler);
      return () => this.removeEventListener(type, handler);
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  const SessionStatus = Object.freeze({
    IDLE: 'idle',
    QUEUED: 'queued',
    RUNNING: 'running',
    WAITING_APPROVAL: 'waiting_approval',
    WAITING_TOOL_AUTH: 'waiting_tool_auth',
    DONE: 'done',
    ERROR: 'error',
    INTERRUPTED: 'interrupted'
  });

  class SessionManager {
    constructor(options = {}) {
      this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 10);
      this.sessions = new Map();
      this.activeByMode = new Map();
      this.bus = options.bus || new AppEventBus();
      this._unsubscribers = new Map();
    }

    makeKey(mode, id) {
      return `${mode}:${id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}`;
    }

    registerAgent(mode, agent, meta = {}) {
      if (!agent || !['chat', 'code', 'babe'].includes(mode)) return null;
      const id = agent.conversationId || meta.id || Date.now().toString(36);
      const key = meta.key || this.makeKey(mode, id);
      agent.setSessionKey?.(key);

      const session = {
        key,
        mode,
        id,
        agent,
        title: meta.title || agent.conversationTitle || '未命名对话',
        status: SessionStatus.IDLE,
        previousStatus: null,
        createdAt: meta.createdAt || Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        lastError: null,
        usage: {
          prompt: 0,
          completion: 0,
          total: 0,
          cached: 0,
          cacheCreation: 0,
          estimated: false
        },
        pendingApproval: null,
        pendingToolAuth: null,
        queuedMessage: null,
        // 需要用户操作的即时状态：{ kind: 'approval'|'tool-auth'|'questionnaire'|'game', label }
        // 用于标签页/历史列表显示"等待审批/等待授权/等待问卷/等待游戏回应"等指示器，
        // 而不是一律显示"运行中"。
        attention: null,
        lastWasWorking: false,
        active: false,
        uiGeneration: 0,
        meta: { ...(meta || {}) }
      };

      this.sessions.set(key, session);
      this._bindAgent(session);
      this.bus.emit('session-created', { session });
      return session;
    }

    get(key) {
      return this.sessions.get(key) || null;
    }

    getByAgent(agent) {
      for (const session of this.sessions.values()) {
        if (session.agent === agent) return session;
      }
      return null;
    }

    getActive(mode) {
      const key = this.activeByMode.get(mode);
      return key ? this.sessions.get(key) : null;
    }

    list(mode) {
      const all = [...this.sessions.values()];
      return mode ? all.filter(s => s.mode === mode) : all;
    }

    countRunning() {
      let count = 0;
      for (const s of this.sessions.values()) {
        if (s.status === SessionStatus.RUNNING || s.status === SessionStatus.WAITING_APPROVAL || s.status === SessionStatus.WAITING_TOOL_AUTH) count++;
      }
      return count;
    }

    canStart() {
      return this.countRunning() < this.maxConcurrent;
    }

    activate(mode, key) {
      const session = this.sessions.get(key);
      if (!session || session.mode !== mode) return null;
      const previous = this.getActive(mode);
      if (previous && previous.key !== key) {
        previous.active = false;
        this.bus.emit('session-deactivated', { session: previous });
      }
      session.active = true;
      this.activeByMode.set(mode, key);
      this.bus.emit('session-activated', { session, previous });
      return session;
    }

    deactivate(session) {
      if (!session) return;
      session.active = false;
      if (this.getActive(session.mode)?.key === session.key) {
        this.activeByMode.delete(session.mode);
      }
      this.bus.emit('session-deactivated', { session });
    }

    updateTitle(session, title) {
      if (!session) return;
      session.title = title || session.title || '未命名对话';
      session.updatedAt = Date.now();
      this.bus.emit('session-title', { session });
    }

    /**
     * 设置/清除会话的"需要用户操作"指示状态。
     * attention: null 清除；否则 { kind, label }。
     */
    setAttention(session, attention) {
      if (!session) return;
      const next = attention || null;
      const prev = session.attention || null;
      const prevStr = prev ? prev.kind + ':' + prev.label : '';
      const nextStr = next ? next.kind + ':' + next.label : '';
      if (prevStr === nextStr) return;
      session.attention = next;
      session.updatedAt = Date.now();
      this.bus.emit('session-attention', { session, attention: next, previous: prev });
    }

    retag(session, id) {
      if (!session || !id) return session;
      const oldKey = session.key;
      const unsub = this._unsubscribers.get(oldKey);
      if (unsub) {
        this._unsubscribers.delete(oldKey);
        this._unsubscribers.set(this.makeKey(session.mode, id), unsub);
      }
      this.sessions.delete(oldKey);
      session.id = String(id);
      session.key = this.makeKey(session.mode, session.id);
      session.agent.conversationId = String(id);
      session.agent.setSessionKey?.(session.key);
      this.sessions.set(session.key, session);
      if (this.activeByMode.get(session.mode) === oldKey) {
        this.activeByMode.set(session.mode, session.key);
      }
      this.bus.emit('session-retagged', { session, previousKey: oldKey });
      return session;
    }

    updateUsage(session, usage) {
      if (!session) return;
      if (usage) {
        session.usage = {
          prompt: Number(usage.prompt) || 0,
          completion: Number(usage.completion) || 0,
          total: Number(usage.total) || 0,
          cached: Number(usage.cached) || 0,
          cacheCreation: Number(usage.cacheCreation) || 0,
          estimated: usage.estimated === true
        };
      } else if (session.agent?.sessionUsage) {
        session.usage = { ...session.agent.sessionUsage };
      }
      session.updatedAt = Date.now();
      this.bus.emit('session-usage', { session });
    }

    setStatus(session, status, extra = {}) {
      if (!session) return;
      const previous = session.status;
      session.previousStatus = previous;
      session.status = status;
      session.updatedAt = Date.now();
      if (status === SessionStatus.RUNNING && !session.startedAt) {
        session.startedAt = Date.now();
      }
      if (status === SessionStatus.DONE || status === SessionStatus.ERROR || status === SessionStatus.INTERRUPTED) {
        session.finishedAt = Date.now();
      }
      if (extra.error !== undefined) session.lastError = extra.error;
      if (extra.approval !== undefined) session.pendingApproval = extra.approval;
      if (extra.toolAuth !== undefined) session.pendingToolAuth = extra.toolAuth;
      if (session.agent) {
        session.agent.sessionStatus = status;
        if (extra.error !== undefined) session.agent.sessionLastError = extra.error;
      }

      this.bus.emit('session-status', { session, previous, status });
      if (status === SessionStatus.DONE) this.bus.emit('session-done', { session });
      if (status === SessionStatus.ERROR) this.bus.emit('session-error', { session });
      if (status === SessionStatus.WAITING_APPROVAL) this.bus.emit('session-approval', { session });
      if (status === SessionStatus.WAITING_TOOL_AUTH) this.bus.emit('session-tool-auth', { session });
      return session;
    }

    requestStart(session) {
      if (!session) return false;
      if (this.canStart()) return true;
      this.setStatus(session, SessionStatus.QUEUED);
      return false;
    }

    queue(session, message) {
      if (!session) return;
      session.queuedMessage = message;
      this.setStatus(session, SessionStatus.QUEUED);
    }

    processQueue() {
      const queued = [...this.sessions.values()]
        .filter(s => s.status === SessionStatus.QUEUED)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const session of queued) {
        if (!this.canStart()) break;
        this.setStatus(session, SessionStatus.RUNNING);
        const message = session.queuedMessage;
        session.queuedMessage = null;
        this.bus.emit('session-dequeued', { session, message });
      }
    }

    stop(session) {
      if (!session) return;
      if (session.agent && (session.agent.running || session.status === SessionStatus.WAITING_APPROVAL || session.status === SessionStatus.WAITING_TOOL_AUTH)) {
        try { session.agent.stop(); } catch { /* ignore */ }
      }
      if (session.status === SessionStatus.QUEUED) {
        this.setStatus(session, SessionStatus.IDLE);
      }
    }

    close(session, options = {}) {
      if (!session) return;
      this.stop(session);
      // 退订该会话 Agent 的 LLM IPC 监听器，避免会话关闭后监听器累积
      if (session.agent && typeof session.agent.unsubscribeStreams === 'function') {
        try { session.agent.unsubscribeStreams(); } catch { /* ignore */ }
      }
      const unsub = this._unsubscribers.get(session.key);
      if (typeof unsub === 'function') { try { unsub(); } catch { /* ignore */ } }
      this._unsubscribers.delete(session.key);
      if (this.getActive(session.mode)?.key === session.key) {
        this.activeByMode.delete(session.mode);
      }
      this.sessions.delete(session.key);
      this.bus.emit('session-closed', { session });
    }

    _bindAgent(session) {
      const agent = session.agent;
      const originalStatus = agent.onStatusChange;
      const originalTitle = agent.onTitleChange;
      const originalMessage = agent.onMessage;
      const originalAccumulate = agent._accumulateUsage?.bind(agent);

      if (typeof originalAccumulate === 'function') {
        agent._accumulateUsage = (usage) => {
          const result = originalAccumulate(usage);
          this.updateUsage(session);
          return result;
        };
      }

      agent.onStatusChange = (status) => {
        if (status === 'working') {
          session.lastWasWorking = true;
          if (session.status !== SessionStatus.RUNNING) this.setStatus(session, SessionStatus.RUNNING);
        } else {
          const wasWorking = session.lastWasWorking;
          session.lastWasWorking = false;
          if (session.status !== SessionStatus.ERROR && session.status !== SessionStatus.WAITING_APPROVAL && session.status !== SessionStatus.WAITING_TOOL_AUTH) {
            this.setStatus(session, wasWorking ? SessionStatus.DONE : SessionStatus.IDLE);
          }
        }
        if (typeof originalStatus === 'function') originalStatus(status);
      };

      agent.onTitleChange = (title) => {
        this.updateTitle(session, title);
        if (typeof originalTitle === 'function') originalTitle(title);
      };

      agent.onMessage = (type, data) => {
        if (type === 'error') {
          this.setStatus(session, SessionStatus.ERROR, { error: typeof data === 'string' ? data : data?.error || data?.message || '未知错误' });
        } else if (type === 'approval') {
          this.setStatus(session, SessionStatus.WAITING_APPROVAL, { approval: data });
          this.setAttention(session, { kind: 'approval', label: '等待审批' });
        } else if (type === 'tool-auth-required') {
          this.setStatus(session, SessionStatus.WAITING_TOOL_AUTH, { toolAuth: data });
          this.setAttention(session, { kind: 'tool-auth', label: '等待授权' });
        }
        if (typeof originalMessage === 'function') originalMessage(type, data);
      };

      const unsub = () => {
        agent.onStatusChange = originalStatus;
        agent.onTitleChange = originalTitle;
        agent.onMessage = originalMessage;
        if (typeof originalAccumulate === 'function') agent._accumulateUsage = originalAccumulate;
      };
      this._unsubscribers.set(session.key, unsub);
    }
  }

  const AppBus = new AppEventBus();
  window.AppBus = AppBus;
  window.SessionStatus = SessionStatus;
  window.SessionManager = SessionManager;
})();
