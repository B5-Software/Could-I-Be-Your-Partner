  function updateContextProgress() {
    updateAgentContextProgress(agent, 'context-progress-fill', 'context-progress-text');
    // Code / Babe 圆扇形：agent 已初始化时用其 contextManager，否则回退到已加载的 settings 值
    const sharedMaxCtx = agent?.settings?.llm?.maxContextLength || 131072;
    try {
      if (codeAgent) {
        updateAgentContextProgress(codeAgent, 'code-context-progress-fill', 'code-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('code-context-indicator'),
          document.getElementById('code-context-progress-fill'),
          document.getElementById('code-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* codeAgent TDZ */ }
    try {
      if (babeAgent) {
        updateAgentContextProgress(babeAgent, 'babe-context-progress-fill', 'babe-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('babe-context-indicator'),
          document.getElementById('babe-context-progress-fill'),
          document.getElementById('babe-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* babeAgent TDZ */ }
    // 同步主对话的上下文进度到 WebUI（按当前模式推送对应 agent 的数据）
    try {
      const targetAgent = (currentMode === 'code' && codeAgent) ? codeAgent
        : (currentMode === 'babe' && babeAgent) ? babeAgent
        : agent;
      if (targetAgent && targetAgent.contextManager) {
        const cm = targetAgent.contextManager;
        const stats = cm.getStats ? cm.getStats() : null;
        const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
        const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
        const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
        const toolDefsTokens = Math.ceil(JSON.stringify(
          (typeof targetAgent.getRuntimeToolSchemas === 'function')
            ? targetAgent.getRuntimeToolSchemas()
            : []
        ).length / 4);
        let chatTokens = 0, toolResultTokens = 0;
        (cm.messages || []).forEach(msg => {
          if (!msg) return;
          if (msg.role === 'tool') toolResultTokens += estimateMsg(msg);
          else if (msg.role === 'user' || msg.role === 'assistant') chatTokens += estimateMsg(msg);
        });
        const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
        const otherTokens = Math.max(0, summaryTokens);
        const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
        const maxTokens = stats?.maxTokens ?? (targetAgent.settings?.llm?.maxContextLength || 0);
        const percentage = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;
        // Remote 模式下不向本地 WebUI 服务器推送（避免远端/本地循环推送导致上下文进度抽搐）
        if (!isRemoteMode) {
          window.api.webControlPushContextProgress({
            mode: currentMode,
            used: tokens,
            max: maxTokens,
            percentage,
            details: { systemGuidanceTokens, toolDefsTokens, chatTokens, toolResultTokens, otherTokens }
          });
        }
      }
    } catch (_) {}
  }

  // 定时更新进度条
  setInterval(updateContextProgress, 1000);

  // 刷新上下文指示器右侧的实时预算进度条（今日花费/上限）
  // 在 LLM 响应结束、token 用量更新后调用
