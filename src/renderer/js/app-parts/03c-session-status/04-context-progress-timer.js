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
        const bd = (typeof cm.getUsageBreakdown === 'function') ? cm.getUsageBreakdown() : null;
        // Remote 模式下不向本地 WebUI 服务器推送（避免远端/本地循环推送导致上下文进度抽搐）
        if (bd && !isRemoteMode) {
          window.api.webControlPushContextProgress({
            mode: currentMode,
            used: bd.totalUsed,
            max: bd.max,
            percentage: bd.pct,
            exact: bd.exact === true,
            details: {
              systemGuidanceTokens: bd.detail.system,
              toolDefsTokens: bd.detail.tools,
              chatTokens: bd.detail.chat,
              toolResultTokens: bd.detail.tool,
              otherTokens: bd.detail.summaries,
            }
          });
        }
      }
    } catch (_) {}
  }

  // 定时更新进度条
  setInterval(updateContextProgress, 1000);

  // 刷新上下文指示器右侧的实时预算进度条（今日花费/上限）
  // 在 LLM 响应结束、token 用量更新后调用
