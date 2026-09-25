  // ---- DeepSeek 插件服务翻译层：会话同步 / agent 消息 / 授权 ----
  let dsApprovalCurrent = null;
  function showDsApprovalModal(req) {
    dsApprovalCurrent = req;
    const toolEl = document.getElementById('ds-approval-tool');
    const reasonEl = document.getElementById('ds-approval-reason');
    if (toolEl) toolEl.textContent = `工具：${req.toolName || 'plugin'}`;
    if (reasonEl) reasonEl.textContent = req.reason || '';
    document.getElementById('ds-approval-modal')?.classList.remove('hidden');
  }
  function answerDsApproval(outcome) {
    const req = dsApprovalCurrent;
    if (!req) return;
    fadeOutHide(document.getElementById('ds-approval-modal'));
    dsApprovalCurrent = null;
    if (typeof window.api.dsApprovalRespond === 'function') {
      window.api.dsApprovalRespond(req.id, outcome).catch(() => {});
    }
  }
  document.getElementById('btn-allow-ds-approval')?.addEventListener('click', () => answerDsApproval('allowed-once'));
  document.getElementById('btn-deny-ds-approval')?.addEventListener('click', () => answerDsApproval('denied'));
  document.getElementById('btn-close-ds-approval')?.addEventListener('click', () => answerDsApproval('cancelled'));

  const pushDsAgentSync = () => {
    if (typeof window.api.dsAgentSync !== 'function' || !sessionManager) return;
    try {
      const entries = sessionManager.list().map(s => ({
        key: s.key,
        id: s.id,
        mode: s.mode,
        title: s.title,
        status: s.status,
        cwd: (s.agent && (s.agent.workspacePath || s.agent.codeWorkspacePath)) || null
      }));
      window.api.dsAgentSync(entries).catch(() => {});
    } catch { /* ignore */ }
  };
  pushDsAgentSync();
  AppBus.on('session-created', () => pushDsAgentSync());
  AppBus.on('session-status', () => pushDsAgentSync());
  AppBus.on('session-closed', () => pushDsAgentSync());
