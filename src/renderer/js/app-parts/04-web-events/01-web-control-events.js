  // ---- Web Control Incoming Events ----
  window.api.onWebControlNewChat(() => {
    stopVoicePlayback(); // 清空语音播放队列
    createNewSession('chat');
    window.api.webControlPushConversationSwitch(null);
  });

window.api.onWebControlSendMessage(async (message) => {
    if (agent.running && !agent.stopped) {
      // Use hot message queue if agent is working
      agent.hotMessages.push(message);
      addMessageToChat('user', message);
      window.api.webControlPushMessage('user', message);
      return;
    }
    addMessageToChat('user', message);
    window.api.webControlPushMessage('user', message, { source: 'web' });
    addThinkingIndicator();
    agent._fromWeb = true;
    await agent.sendMessage(message);
    agent._fromWeb = false;
  });

  // 语音条识别文本 → 填入当前模式当前会话的输入框（autoSend 时自动发送）
  if (typeof window.api?.onVoiceBarFill === 'function') {
    window.api.onVoiceBarFill(async (d) => {
      if (!d || !d.text) return;
      // 问卷等待填写 → 语音答案填入当前题并自动下一题/提交（不走聊天发送）
      const activeQ = window.__activeQuestion;
      if (activeQ && typeof activeQ.submitAnswer === 'function') {
        activeQ.submitAnswer(d.text);
        return;
      }
      const mode = typeof window.getCurrentMode === 'function' ? window.getCurrentMode() : 'chat';
      const inputId = mode === 'code' ? 'code-chat-input' : (mode === 'babe' ? 'babe-chat-input' : 'chat-input');
      const input = document.getElementById(inputId);
      if (input) {
        input.value = d.text.trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
      if (!d.autoSend) return;
      // 延后一拍等输入框就绪，复用对应模式的发送逻辑
      setTimeout(() => {
        if (mode === 'code') { try { sendCodeMessage(); } catch (e) { console.warn('[voice] sendCodeMessage:', e); } }
        else if (mode === 'babe') { try { sendBabeMessage(); } catch (e) { console.warn('[voice] sendBabeMessage:', e); } }
        else { try { sendMessage(); } catch (e) { console.warn('[voice] sendMessage:', e); } }
      }, 60);
    });
  }

  window.api.onWebControlStopAgent(() => {
    stopVoicePlayback();
    agent.stop();
    removeThinkingIndicator();
  });

  window.api.onWebControlApprovalResponse((approved) => {
    agent.resolveApproval(approved);
    window.api.webControlClearApproval();
  });

  window.api.onWebControlLoadConversation(async (id) => {
    try {
      stopVoicePlayback(); // 清空语音播放队列
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      // 先查找已存在的会话；没有则创建新会话并加载历史。
      const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
      let targetSession = existing;
      if (targetSession) {
        agent = targetSession.agent;
        activateSession('chat', targetSession.key);
      } else {
        const ag = new Agent();
        ag.mode = 'chat';
        await ag.init();
        await ag.loadFromHistory(conv);
        wireChatAgent(ag);
        targetSession = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
        agent = ag;
        activateSession('chat', targetSession.key);
      }
      setTitlebarTitle(agent.conversationTitle || '未命名对话');
      updateContextProgress();
      // Switch to chat page
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-chat')?.classList.add('active');
      // 推送 nav-item 和 page 切换状态到 WebUI/Remote
      document.querySelectorAll('.nav-item[data-page]').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: `.nav-item[data-page="${b.dataset.page}"]`, attr: 'class', value: b.className });
      });
      document.querySelectorAll('.page').forEach(p => {
        if (p.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + p.id, attr: 'class', value: p.className });
      });
      // Replay messages in local UI
      clearChatMessagesUI();
      const toolCallMap = {};
      for (const msg of (conv.messages || [])) {
        if (msg.role === 'user') {
          addMessageToChat('user', extractTextContent(msg.content));
        } else if (msg.role === 'assistant') {
          if (msg.content) addMessageToChat('assistant', extractTextContent(msg.content));
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              const toolName = tc.function?.name || 'tool';
              let args = {};
              try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
              const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
              addToolCallToChat(toolDef?.desc || toolName, toolName, args);
              if (tc.id) toolCallMap[tc.id] = toolName;
            }
          }
        } else if (msg.role === 'tool') {
          const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
          // 兼容旧版多模态 tool 消息 content 为数组的情况：提取文本，避免显示 [object Object]
          let result = msg.content;
          if (Array.isArray(result)) result = extractTextContent(result);
          try { result = JSON.parse(result); } catch {}
          updateToolCallResult(toolName, result);
          // 恢复 AI 生图气泡（WebUI 载入会话时同样可见）
          if (toolName === 'generateImage' && result && typeof result === 'object' && result.ok && result.url) {
            addImageMessage(result.url, { path: result.path });
          }
        } else if (msg.role === 'system') {
          // 回放历史时显示系统消息（不重复持久化）
          addSystemMessage(msg.content, { persist: false });
        }
      }
      // Sync to web control — include tool_calls and tool results so they render properly
      const webMsgs = [];
      for (const m of (conv.messages || [])) {
        if (m.role === 'user') {
          webMsgs.push({ role: 'user', content: m.content || '', timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'assistant') {
          webMsgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls || null, timestamp: m.timestamp || Date.now() });
        } else if (m.role === 'tool') {
          webMsgs.push({ role: 'tool', content: m.content || '', name: m.name || '', tool_call_id: m.tool_call_id || '', timestamp: m.timestamp || Date.now() });
        }
      }
      window.api.webControlPushConversationSwitch(id);
      window.api.webControlPushHistoryMessages(webMsgs);
      window.api.webControlPushTitle(agent.conversationTitle || '未命名对话');
    } catch (e) {
      console.error('[App] onWebControlLoadConversation error:', e.message);
    }
  });

  window.api.onGameFinished((data) => {
    if (!data) return;
    const gameNames = { flyingflower: '飞花令', sanguosha: '三国杀', undercover: '谁是卧底' };
    const gameName = gameNames[data.game] || data.game;
    const resultText = `《${gameName}》游戏结束: ${data.result}`;
    addSystemMessage(resultText);
    window.api.webControlPushMessage('system', resultText);
  });

  // ---- Pending Session: 关闭 App 时保存正在工作的会话 ----
  // 主进程 before-quit 会发送 agent:save-pending 事件，这里响应：
  //   - 如果 agent.running 则保存当前会话信息到 pending 文件
  //   - 否则调用 skipPending 标记无需保存
