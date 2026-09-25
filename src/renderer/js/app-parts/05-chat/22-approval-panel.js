  // ---- Approval Panel ----
  function showApprovalPanel(toolName, args) {
    approvalPanel.classList.remove('hidden');
    approvalPanel.dataset.toolName = toolName || 'unknown';
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    approvalContent.textContent = `操作: ${toolDef?.desc || toolName}\n\n参数:\n${JSON.stringify(args, null, 2)}`;
    // 增量推送：显示审批面板并更新内容
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#approval-content', text: approvalContent.textContent });
    // 系统通知：敏感操作需要审批时
    const dispName = toolDef?.desc || toolName || '未知操作';
    sendAppNotification('approval', '需要您的批准', `Agent 请求执行: ${dispName}`);
  }

  document.getElementById('btn-approve').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户批准执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: true }));
      return;
    }
    agent.resolveApproval(true);
  });

  document.getElementById('btn-deny').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户拒绝执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: false }));
      return;
    }
    agent.resolveApproval(false);
  });
