  async function initCodeAgent() {
    // 先退订旧实例的监听器，避免 ipcRenderer 监听器累积
    unsubscribeAgentStreams(codeAgent);
    if (codeAgent && sessionManager) {
      const oldSession = sessionManager.getByAgent(codeAgent);
      if (oldSession) sessionManager.close(oldSession);
    }
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return false;
    }
    codeAgent = new Agent();
    codeAgent.mode = 'code';
    codeAgent.workspacePath = codeWorkspacePath;
    codeAgent.codeWorkspacePath = codeWorkspacePath; // 用于 saveToHistory 的 code 分支
    codeAgent.settings = await window.api.getSettings();
    if (!codeAgent.settings.tools || typeof codeAgent.settings.tools !== 'object') {
      codeAgent.settings.tools = {};
    }
    codeAgent.systemInfo = await window.api.getFullSystemInfo();
    codeAgent.contextManager = new ContextManager(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setMaxTokens(codeAgent.settings.llm?.maxContextLength || 131072);
    codeAgent.contextManager.setOutputReserve(codeAgent.settings.llm?.maxResponseTokens || 8192);
    codeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await codeAgent.refreshSkillsCatalog();
    codeAgent.contextManager.setSystemPrompt(codeAgent.getSystemPrompt());
    setupAgentStreamSubscriptions(codeAgent, 'code');
    wireCodeAgent(codeAgent);

    if (sessionManager) {
      const codeSession = sessionManager.registerAgent('code', codeAgent, {
        title: codeAgent.conversationTitle || '未命名 Code 会话'
      });
      sessionManager.activate('code', codeSession.key);
    }
    return true;
  }

  async function createCodeSession(forkConv = null) {
    const ag = new Agent();
    ag.mode = 'code';
    ag.workspacePath = codeWorkspacePath || '';
    ag.codeWorkspacePath = codeWorkspacePath || '';
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    ag.contextManager = new ContextManager(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setMaxTokens(ag.settings.llm?.maxContextLength || 131072);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireCodeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'code');
    if (forkConv) await ag.loadFromHistory(forkConv);
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('code', ag, {
      title: (forkConv && forkConv.title) || '未命名 Code 会话'
    });
    // /fork N 语义：分支后把该条用户消息恢复到输入框供编辑重发
    if (forkConv && forkConv._restorePrompt) session.draft = forkConv._restorePrompt;
    activateSession('code', session.key);
    return session;
  }

  /**
   * 对齐 Chat/Babe：首次进入 Code 模式时自动创建第一个会话标签。
   * 不强制要求工作区（工作区缺失只在发送消息时提示），
   * 因此没有工作区也能看到会话标签，交互与其它模式一致。
   */
  async function ensureCodeFirstSession() {
    if (codeAgent) return codeAgent;
    if (sessionManager && sessionManager.list('code').length > 0) return null;
    if (!codeWorkspacePath) {
      try { codeWorkspacePath = await window.api.codeGetLastWorkspace(); } catch { /* ignore */ }
      if (codeWorkspacePath) {
        const wsPathEl = document.getElementById('code-workspace-path');
        if (wsPathEl) wsPathEl.textContent = codeWorkspacePath;
      }
    }
    return createCodeSession();
  }

  async function replayCodeSession(session) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl || !session?.agent) return;
    codeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#code-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    const total = messages.length;
    const chunkSize = 40;
    const toolCallMap = {};
    if (total === 0) {
      msgsEl.innerHTML = `<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>继续编程任务</p></div>`;
      return;
    }
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = messages[i];
          if (msg.role === 'user') {
            addCodeMessage('user', extractTextContent(msg.content), false);
          } else if (msg.role === 'assistant') {
            const textContent = extractTextContent(msg.content);
            if (textContent) addCodeMessage('assistant', textContent, false);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addCodeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (msg.role === 'tool') {
            const key = msg.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              addCodeToolResult({ result, name: entry.name, callId: key });
            } else {
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              addCodeMessage('system', `[工具结果] ${msg.name || 'tool'}: ${resultStr.slice(0, 200)}`, false);
            }
          } else if (msg.role === 'system') {
            addCodeMessage('system', typeof msg.content === 'string' ? msg.content : String(msg.content || ''), false);
          }
        }
        updateHistoryProgress(end, total, end >= total ? '渲染完成，正在收尾…' : `已渲染 ${end}/${total} 条消息`);
        await yieldHistoryUI();
      }
    } finally {
      hideHistoryProgress();
    }
    requestAnimationFrame(() => {
      scrollChatToBottom(msgsEl);
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-chat-messages', html: msgsEl.innerHTML });
    });
  }
