  // Attach view objects to every backend session. Refreshing a frontend never
  // creates a second executor or loses work started by another frontend.
  async function synchronizeBackendSessions(replay = false) {
    if (!window.CibypBackendViews) return;
    const sessions = await window.api.backendRequest('listSessions');
    for (const record of sessions) {
      if (record.profile && record.profile !== 'default') continue;
      let local = sessionManager.get(record.key);
      if (!local) {
        if ([...window.CibypBackendViews.views].some(view => view.backendKey === record.key)) continue;
        const view = new Agent(); view.mode = record.mode; view.backendKey = record.key;
        await view._ensureBackend();
        if (record.mode === 'code') wireCodeAgent(view);
        else if (record.mode === 'babe') wireBabeAgent(view);
        else wireChatAgent(view);
        local = sessionManager.registerAgent(record.mode, view, { key: record.key, title: record.title, createdAt: record.createdAt });
      } else window.CibypBackendViews.hydrate(local.agent, await window.api.backendRequest('getView', record.key));
      local.status = record.status; local.title = record.title || local.title;
    }
    if (replay) {
      const active = sessionManager.getActive(currentMode) || sessionManager.list(currentMode).at(-1);
      if (active) await activateSession(currentMode, active.key);
    }
    renderAllSessionTabs();
  }
  if (window.CibypBackendViews) {
    await synchronizeBackendSessions(true);
    window.api.onBackendReconnected(() => synchronizeBackendSessions(true).catch(console.error));
    window.api.onBackendEvent(event => {
      if (event.type === 'session-created' && event.session?.profile !== 'settings-assistant') synchronizeBackendSessions().catch(console.error);
      if (event.type === 'session-closed') {
        const local = sessionManager.get(event.key);
        if (local) sessionManager.close(local);
      }
    });
  }
