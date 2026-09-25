  async function initBabeAgent() {
    if (babeAgent) {
      // 已初始化，仅更新显示
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      return true;
    }
    try {
      babeAgent = new Agent();
      babeAgent.mode = 'babe';
      babeAgent.settings = await window.api.getSettings();
      if (!babeAgent.settings.tools || typeof babeAgent.settings.tools !== 'object') {
        babeAgent.settings.tools = {};
      }
      babeAgent.systemInfo = await window.api.getFullSystemInfo();
      const maxCtx = babeAgent.settings.llm?.maxContextLength || 131072;
      babeAgent.contextManager = new ContextManager(maxCtx);
      babeAgent.contextManager.setMaxTokens(maxCtx);
      babeAgent.contextManager.setOutputReserve(babeAgent.settings.llm?.maxResponseTokens || 8192);
      babeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      // 初始好感度
      babeAgent.babeAffection = babeAgent.settings.babe?.initialAffection ?? 30;
      await babeAgent.refreshSkillsCatalog();
      babeAgent.contextManager.setSystemPrompt(babeAgent.getSystemPrompt());
      setupAgentStreamSubscriptions(babeAgent, 'babe');
      wireBabeAgent(babeAgent);
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      // 启动主动消息定时器
      restartBabeProactiveTimer();
      if (sessionManager) {
        const babeSession = sessionManager.registerAgent('babe', babeAgent, {
          title: babeAgent.conversationTitle || '未命名 Babe 会话'
        });
        sessionManager.activate('babe', babeSession.key);
      }
      return true;
    } catch (e) {
      console.error('[Babe] initBabeAgent failed:', e);
      addBabeMessage('system', '初始化 Babe 模式失败: ' + e.message);
      return false;
    }
  }

  async function createBabeSession() {
    const ag = new Agent();
    ag.mode = 'babe';
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    const maxCtx = ag.settings.llm?.maxContextLength || 131072;
    ag.contextManager = new ContextManager(maxCtx);
    ag.contextManager.setMaxTokens(maxCtx);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    ag.babeAffection = ag.settings.babe?.initialAffection ?? 30;
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireBabeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'babe');
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('babe', ag, { title: '未命名 Babe 会话' });
    activateSession('babe', session.key);
    return session;
  }

  async function replayBabeSession(session) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl || !session?.agent) return;
    babeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#babe-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    if (messages.length === 0) {
      msgsEl.innerHTML = `<div class="babe-welcome"><div class="babe-welcome-icon"><i class="fa-solid fa-heart"></i></div><h2>新的开始</h2><p>开始一段新的对话吧~</p></div>`;
      updateBabeAffection(session.agent.babeAffection);
      return;
    }
    const total = messages.length;
    const chunkSize = 30;
    const toolCallMap = {};
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const m = messages[i];
          if (m.role === 'user') {
            addBabeMessage('user', extractTextContent(m.content) || '[多模态内容]');
          } else if (m.role === 'assistant') {
            const textContent = extractTextContent(m.content);
            if (textContent) addBabeMessage('assistant', textContent);
            if (m.tool_calls && m.tool_calls.length > 0) {
              for (const tc of m.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addBabeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (m.role === 'tool') {
            const key = m.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = m.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              const statusEl = entry.card.querySelector('.tool-call-status');
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              const ok = (result && typeof result === 'object') ? result.ok !== false : true;
              if (statusEl) {
                statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败')
                  (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
              }
            } else {
              addBabeMessage('system', `[工具结果] ${m.name || 'tool'}: ${String(result).slice(0, 200)}`);
            }
          } else if (m.role === 'system') {
            addBabeMessage('system', typeof m.content === 'string' ? m.content : String(m.content || ''));
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
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#babe-chat-messages', html: msgsEl.innerHTML });
    });
    updateBabeAffection(session.agent.babeAffection);
  }
