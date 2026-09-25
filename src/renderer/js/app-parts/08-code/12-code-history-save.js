  async function saveCodeHistory() {
    if (!codeWorkspacePath || codeMessages.length === 0) return;
    // 同步 codeCurrentHistoryId 与 codeAgent.conversationId，避免双重保存产生重复历史条目。
    // 真正的历史持久化由 codeAgent.saveToHistory()（agent.js）负责，它保存完整的 contextManager.messages。
    if (codeAgent && codeAgent.conversationId) {
      codeCurrentHistoryId = codeAgent.conversationId;
      return;
    }
    // Agent 未初始化时的兜底：直接保存 codeMessages
    if (!codeCurrentHistoryId) {
      codeCurrentHistoryId = Date.now().toString(36);
    }
    const title = codeMessages.find(m => m.role === 'user')?.content?.slice(0, 30) || '未命名';
    await window.api.codeSaveHistory(codeWorkspacePath, codeCurrentHistoryId, {
      title,
      ts: Date.now(),
      schemaVersion: 2, // 与 agent.saveToHistory 保持统一的历史格式版本
      messages: codeMessages,
      workspace: codeWorkspacePath
    });
  }
