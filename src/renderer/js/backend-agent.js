/* SPDX-License-Identifier: GPL-3.0-or-later */
// Display adapter shared by GUI and WebUI. Never loaded by the Node Agent core.
(() => {
  if (!window.api?.backendRequest) return;
  const views = new Set();
  const request = (method, ...args) => window.api.backendRequest(method, ...args);
  const proto = Agent.prototype;
  const applySettings = proto.applySettings;
  proto.applySettings = function(settings) {
    return applySettings.call(this, this._runtimeOverride ? { ...settings, runtime: { ...settings.runtime, location: this._runtimeOverride } } : settings);
  };
  let first = true;
  function hydrate(a, view) {
    if (!view || a._backendClosed) return;
    const s = view.session;
    a._runtimeOverride = view.runtimeOverride;
    if (a._runtimeOverride && a.settings) a.applySettings(a.settings);
    a.backendKey = s.key; a.sessionKey = s.key; a.mode = s.mode;
    a.conversationId = s.conversationId; a.conversationTitle = s.title;
    a.workspacePath = s.workspacePath; a.codeWorkspacePath = s.mode === 'code' ? s.workspacePath : null;
    a.workspaceName = s.workspaceName || '';
    a.minimalMode = s.minimalMode; a.babeAffection = s.affection;
    a.running = s.busy; a.sessionStatus = s.status === 'running' ? 'working' : s.status;
    a.contextManager.loadFromHistory(view.messages || []);
    if (view.workingMessages) a.contextManager.messages = view.workingMessages;
    if (view.systemPrompt) a.contextManager.setSystemPrompt(view.systemPrompt);
    for (const property of ['tarotCard', 'sessionUsage', 'sessionUsageByModel', 'skills', 'skillsCatalog', 'optimizedToolNames', 'optimizedToolReason', 'subAgents', 'cachedWorkspaceTree']) if (view[property] !== undefined) a[property] = view[property];
    a._backendToolSchemas = view.runtimeToolSchemas;
    if ((view.modelRevision || 0) >= (a._backendModelRevision || 0)) {
      a.llmOverride = view.llmOverride || a.llmOverride;
      a._backendModelRevision = view.modelRevision || 0;
    }
    a._backendStats = view.stats;
    a.babeRelationship = view.stats?.relationship || null;
    a._compactionState = view.stats?.compaction || null;
  }
  proto._ensureBackend = async function (attachLatest = false) {
    if (this._backendClosed) throw new Error('This conversation has been closed');
    views.add(this);
    if (this._backendReady) return this._backendReady;
    this._backendReady = (async () => {
      if (attachLatest && !this.ephemeral && !this.backendKey) {
        const sessions = await request('listSessions');
        this.backendKey = sessions.filter(s => s.mode === this.mode && (!s.profile || s.profile === 'default')).at(-1)?.key;
      }
      const options = { key: this.backendKey || this.sessionKey || 'session:' + this.mode + ':' + crypto.randomUUID(), mode: this.mode, workspacePath: this.codeWorkspacePath || this.workspacePath, minimalMode: this.minimalMode, profile: this.ephemeral ? 'settings-assistant' : 'default' };
      this.backendKey = options.key;
      const [settings, view] = await Promise.all([window.api.getSettings(), request('initialize', options)]);
      this.settings = settings; this.syncTokenLimits(); hydrate(this, view);
      return view;
    })().catch(error => { this._backendReady = null; throw error; });
    return this._backendReady;
  };
  proto.init = async function () { const attach = first; first = false; await this._ensureBackend(attach); };
  proto.setSessionKey = function (key) { this.sessionKey = this.backendKey || key; };
  proto.sendMessage = async function (text, attachments = []) {
    await this._ensureBackend();
    const values = { llmOverride: this.llmOverride, modelRevision: this._backendModelRevision || 0, workspacePath: this.codeWorkspacePath, editorContext: this.contextManager._contextSources?.get('当前编辑器') || '' };
    hydrate(this, await request('configureSession', this.backendKey, values));
    this.running = true; this.stopped = false; this._sending = true;
    try { const result = await request('sendMessage', this.backendKey, text, attachments); if (!result.ok) throw new Error(result.error); return result; }
    finally { this._sending = false; if (!this._backendClosed) hydrate(this, await request('getView', this.backendKey)); }
  };
  proto.injectHotMessage = async function (text, attachments = []) {
    await this._ensureBackend(); this._sending = true;
    try { return await request('inject', this.backendKey, text, attachments); }
    finally { this._sending = false; }
  };
  proto.stop = function () { this.stopped = true; if (this._backendClosed) return Promise.resolve({ ok: true }); return this._ensureBackend().then(() => this._backendClosed ? { ok: true } : request('stop', this.backendKey)); };
  proto.resolveApproval = function (response) { return request('respond', this.backendKey, response); };
  proto.resolveToolAuth = function (response) { return request('respond', this.backendKey, response); };
  proto.setMinimalMode = async function (enabled) { await this._ensureBackend(); const result = await request('setMinimalMode', this.backendKey, enabled); hydrate(this, await request('getView', this.backendKey)); return result; };
  for (const method of ['saveToHistory', 'loadFromHistory', 'optimizeToolsForConversation', 'resetOptimizedTools', 'refreshSkillsCatalog', 'proactiveSend', 'executeTool', 'compactNow']) {
    proto[method] = async function (...args) {
      if (this._backendClosed && ['saveToHistory', 'resetOptimizedTools', 'refreshSkillsCatalog'].includes(method)) return null;
      await this._ensureBackend();
      const value = await request('agentAction', this.backendKey, method, args);
      if (value?.view) { hydrate(this, value.view); return value.result; }
      return value;
    };
  }
  proto.unsubscribeStreams = function () {
    views.delete(this);
    if (this.ephemeral && this.backendKey) request('close', this.backendKey).catch(console.error);
  };
  proto.agentLoop = function () { throw new Error('Agent execution is owned by the backend'); };
  const localSchemas = proto.getRuntimeToolSchemas;
  proto.getRuntimeToolSchemas = function () { return this._backendToolSchemas || localSchemas.call(this); };
  window.api.onBackendEvent(event => {
    for (const a of views) {
      if (event.key !== a.backendKey) continue;
      if (event.type === 'session-closed') { a._backendClosed = true; a.running = false; views.delete(a); continue; }
      if (event.type === 'agent-message') {
        if (event.messageType === 'message-stored') { window.CibypMessages?.admitted(a, event.data); continue; }
        if (event.messageType === 'context-compaction') {
          a._compactionState = event.data;
          window.CibypCompactionUI?.refresh();
        }
        a.onMessage?.(event.messageType, event.data);
        const session = window.__sessionManager?.getByAgent(a);
        if (window.VoiceUI && (!session || session.active)) {
          if (event.messageType === 'stream-chunk' && event.data?.content) window.VoiceUI.feedStreamChunk(event.data.content);
          if (event.messageType === 'stream-end') window.VoiceUI.feedStreamEnd(event.data?.content || null);
        }
      }
      else if (event.type === 'message' && event.role === 'user' && !a._sending) a.onMessage?.('user', { content: event.content, attachments: event.attachments });
      else if (event.type === 'tool-call') {
        let result = event.result; try { result = JSON.parse(result); } catch { /* Plain text result. */ }
        a.onToolCall?.(event.name, event.args, event.status === 'running' ? 'calling' : event.status, result, event.callId);
      } else if (event.type === 'title') { a.conversationTitle = event.title; a.onTitleChange?.(event.title); }
      else if (event.type === 'status') { a.running = event.status === 'running'; a.onStatusChange?.(a.running ? 'working' : event.status); }
      else if (event.type === 'notification' && event.notificationType === 'toast') window.showToast?.(event.payload?.message, event.payload?.type, event.payload?.duration);
      if (['status', 'usage', 'view-changed', 'stream-end', 'context-compaction', 'messages-deleted'].includes(event.type)) request('getView', a.backendKey).then(view => {
        hydrate(a, view); window.CibypCompactionUI?.refresh();
        if (event.type === 'messages-deleted') a.onMessage?.('conversation-replaced', view);
      }).catch(console.error);
    }
  });
  window.CibypBackendViews = { hydrate, request, views };
})();
