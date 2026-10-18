  const frontendShell = new FrontendShell({
    mode: () => currentMode,
    context: () => {
      const active = sessionManager?.getActive(currentMode)?.agent;
      return {
        sessionKey: sessionManager?.getActive(currentMode)?.key,
        workspace: active?.codeWorkspacePath || active?.workspacePath || (currentMode === 'code' ? codeWorkspacePath : ''),
        model: active?.getActiveModelId() || agent.getActiveModelId() || '',
        modelLabel: active?.settings?.llm?.pool?.find(row => row.id === (active.llmOverride?.poolEntryId || active.settings?.llm?.activeEntryId) && row.model === active.getActiveModelId())?.label || active?.llmOverride?.label || '',
        effort: active?.getActiveReasoningEffort() || '',
        workspaceName: active?.workspaceName || '',
        runtime: t(active?.settings?.runtime?.location === 'vm' ? 'ui.frontend.vm' : 'ui.frontend.host', active?.settings?.runtime?.location === 'vm' ? '虚拟机' : '本机'),
      };
    },
    translate: (key, fallback) => t(key, fallback),
    create: mode => createNewSession(mode),
    history: async mode => {
      if (mode === 'chat') return await window.api.historyList() || [];
      if (mode === 'babe') return await window.api.babeHistoryList() || [];
      if (!codeWorkspacePath) return [];
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (!result.ok) throw new Error(result.error || 'History unavailable');
      return result.history || [];
    },
    resume: async (mode, item) => {
      const live = sessionManager?.list(mode).find(session => String(session.id) === String(item.id));
      if (live) { await activateSession(mode, live.key); navigatePage(mode); return; }
      if (mode === 'chat') await handleHistoryAction('continue', item);
      else if (mode === 'code') await handleCodeHistoryAction('continue', item);
      else await handleBabeHistoryAction('continue', item);
      navigatePage(mode);
    },
    navigate: page => navigatePage(page),
    settings: () => { navigatePage('settings'); window.activateSettingsTab('llm'); },
    models: async () => {
      const active = sessionManager?.getActive(currentMode)?.agent || agent;
      await active._ensureBackend();
      return window.CibypBackendViews.request('getSessionModels', active.backendKey);
    },
    selectModel: async id => {
      const active = sessionManager?.getActive(currentMode)?.agent || agent;
      await active._ensureBackend();
      const result = await window.CibypBackendViews.request('selectSessionModel', active.backendKey, id);
      if (!result.ok) throw new Error(result.error);
      window.CibypBackendViews.hydrate(active, result.view);
      frontendShell.refresh(); updateContextProgress();
      return result;
    },
    openWorkspace: async () => {
      const active = sessionManager?.getActive(currentMode)?.agent || agent;
      const directory = active.codeWorkspacePath || active.workspacePath || (currentMode === 'code' ? codeWorkspacePath : '');
      const result = await window.api.workspaceOpenInExplorer(directory);
      if (result?.ok === false) throw new Error(result.error);
      return result;
    },
    setEffort: async value => {
      const active = sessionManager?.getActive(currentMode)?.agent || agent;
      await active._ensureBackend();
      const result = await window.CibypBackendViews.request('setSessionReasoning', active.backendKey, value);
      if (!result.ok) throw new Error(result.error);
      window.CibypBackendViews.hydrate(active, result.view); frontendShell.refresh();
      return result;
    },
    reportError: error => { console.error('[frontend]', error); showToast(error?.message || t('ui.frontend.actionFailed', '操作失败，请重试'), 'error'); },
  });
  window.CibypFrontendShell = frontendShell;
  for (const event of ['session-created', 'session-closed', 'session-title']) {
    AppBus.on(event, () => { frontendShell.invalidateHistory(); frontendShell.refresh(); });
  }
  AppBus.on('session-status', event => {
    if (['done', 'idle', 'error'].includes(event.detail?.status)) frontendShell.invalidateHistory();
  });
  window.api.onSettingsChanged?.(() => { frontendShell.refresh(); });
