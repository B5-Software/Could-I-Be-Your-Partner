  async function codeOSSAgentRequest({ id, method, params = {} }) {
    try {
      let result = { ok: true };
      if (method === 'agent.focus') { await navigatePage('code'); codeAgentPanel.focus(params.draft); }
      else if (method === 'app.settings') { navigatePage('settings'); }
      else if (method === 'agent.cancel') { codeAgent?.stop(); }
      else if (method === 'agent.approve') { codeAgent?.resolveApproval(params.approved === true); }
      else if (method === 'agent.newSession') { await createCodeSession(); }
      else if (method === 'agent.selectSession') {
        const session = sessionManager?.get(params.key);
        if (!session || session.mode !== 'code') throw new Error('Code 会话不存在');
        await activateSession('code', session.key);
      } else if (method === 'agent.sessions') {
        const sessions = sessionManager?.list('code') || [];
        const active = sessionManager?.getActive('code');
        result = { sessions: sessions.map(session => ({ key: session.key, title: session.title })), activeKey: active?.key,
          running: codeAgent?.running === true, approval: codeAgent?.pendingApproval,
          messages: (active?.agent.contextManager?.getHistoryMessages() || []).filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').map(message => ({ role: message.role, content: message.content })) };
      } else if (method === 'agent.send') {
        await navigatePage('code');
        codeAgentPanel.setOpen(true, false);
        for (const file of params.attachments || []) await addFileToCodeContext(file);
        await submitCodeTask(String(params.text || ''), [...codeCurrentAttachments], params.context, false);
      }
      await window.api.codeOSSAgentResponse({ id, result });
    } catch (error) {
      await window.api.codeOSSAgentResponse({ id, error: error.message });
    }
  }
  window.api.onCodeOSSAgentRequest(codeOSSAgentRequest);
  let codeWorkspaceSwitch = Promise.resolve();
  function adoptCodeOSSWorkspace(workspace) {
    const operation = async () => {
      const next = workspace?.path || null;
      if (next === codeWorkspacePath) return;
      if (codeAgent?.running) {
        codeAgent.stop();
      }
      await saveCodeHistory();
      for (const session of sessionManager?.list('code') || []) sessionManager.close(session);
      unsubscribeAgentStreams(codeAgent);
      codeAgent = null;
      codeCurrentHistoryId = null;
      codeMessages = [];
      clearCodeAttachments();
      codeWorkspacePath = next;
      if (next) await createCodeSession();
    };
    const task = codeWorkspaceSwitch.then(operation);
    codeWorkspaceSwitch = task.catch(error => console.warn('[Code-OSS workspace]', error));
    return task;
  }
  window.api.onCodeOSSWorkspace(workspace => {
    const label = document.getElementById('code-workspace-path');
    if (label) label.textContent = workspace?.path || '未选择工作区';
    adoptCodeOSSWorkspace(workspace).catch(error => showToast(error.message, 'error'));
  });
  document.getElementById('btn-codeoss-retry')?.addEventListener('click', () => loadCodePage());
  for (const [id, command] of Object.entries({ 'btn-code-ide-terminal': 'workbench.action.terminal.toggleTerminal', 'btn-code-extensions': 'workbench.view.extensions', 'btn-code-git': 'workbench.view.scm' })) {
    document.getElementById(id)?.addEventListener('click', () => codeWorkbench.command(command).catch(error => showToast(error.message, 'error')));
  }
  AppBus.on('session-deactivated', event => {
    const session = event.detail?.session;
    if (session?.mode !== 'code') return;
    session.codeAttachments = [...codeCurrentAttachments];
    codeCurrentAttachments = [];
    renderCodeAttachments();
  });
  AppBus.on('session-activated', event => {
    const session = event.detail?.session;
    if (session?.mode !== 'code') return;
    if (event.detail?.previous?.key === session.key) return;
    codeCurrentAttachments = [...(session.codeAttachments || [])];
    renderCodeAttachments();
  });
  AppBus.on('session-status', event => {
    const session = event.detail?.session;
    if (session?.mode === 'code' && session.active) syncSessionControls('code', session);
  });
