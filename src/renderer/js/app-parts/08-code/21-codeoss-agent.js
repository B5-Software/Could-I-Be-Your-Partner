  function publishCodeOSSAgentEvent(ag, type, data) {
    if (!window.api.codeOSSAgentEvent) return;
    window.api.codeOSSAgentEvent({ type, data, sessionKey: ag.sessionKey || sessionManager?.getByAgent(ag)?.key }).catch(error => console.warn('[Code-OSS agent event]', error));
  }

  async function codeOSSAgentRequest({ id, method, params = {} }) {
    try {
      let result = { ok: true };
      if (method === 'app.settings') { navigatePage('settings'); }
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
        if (codeAgent?.running) throw new Error('当前 Agent 正在处理任务，请等待完成或停止后重试。');
        const workspace = params.context?.workspace?.[0] || params.workspace?.[0];
        if (workspace?.path) codeWorkspacePath = workspace.path;
        if (!codeWorkspacePath) throw new Error('请先打开工作区文件夹');
        if (!codeAgent && !await initCodeAgent()) throw new Error('Agent 初始化失败');
        codeAgent.workspacePath = codeWorkspacePath;
        codeAgent.codeWorkspacePath = codeWorkspacePath;
        const session = sessionManager?.getByAgent(codeAgent);
        if (session && !sessionManager.requestStart(session)) throw new Error('当前并发会话已达上限，请稍后重试。');
        addCodeMessage('user', params.text);
        const attachments = [...codeCurrentAttachments];
        if (params.context?.content) {
          const context = params.context;
          attachments.push({ name: `IDE 上下文 · ${context.path || '当前文件'}`, extractedText: JSON.stringify(context, null, 2), path: '' });
        }
        for (const file of params.attachments || []) {
          await addFileToCodeContext({ path: file.path, name: file.name, type: 'file' });
        }
        attachments.push(...codeCurrentAttachments.filter(item => !attachments.includes(item)));
        await codeAgent.sendMessage(String(params.text || ''), attachments.map(item => ({ name: item.name, path: item.path || '', isImage: item.isImage, extractedText: item.extractedText || item.content || '' })));
        clearCodeAttachments();
        await saveCodeHistory();
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
  for (const [id, command] of Object.entries({ 'btn-code-ide-terminal': 'workbench.action.terminal.toggleTerminal', 'btn-code-extensions': 'workbench.view.extensions', 'btn-code-git': 'workbench.view.scm', 'btn-code-agent': 'cibyp.agent.focus' })) {
    document.getElementById(id)?.addEventListener('click', () => codeWorkbench.command(command).catch(error => showToast(error.message, 'error')));
  }
