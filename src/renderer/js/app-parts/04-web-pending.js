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
  window.api.onSavePending(async () => {
    try {
      const runningSessions = sessionManager
        ? sessionManager.list().filter(s => s.status === SessionStatus.RUNNING
            || s.status === SessionStatus.WAITING_APPROVAL
            || s.status === SessionStatus.WAITING_TOOL_AUTH
            || s.status === SessionStatus.QUEUED)
        : [];
      if (runningSessions.length === 0) {
        await window.api.skipPending();
        return;
      }
      const sessions = runningSessions.map(session => {
        const ag = session.agent;
        const lastUserMsg = (ag?.contextManager?.messages || [])
          .filter(m => m.role === 'user')
          .slice(-1)[0];
        const lastUserText = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content.slice(0, 200)
          : '[多模态内容]';
        return {
          conversationId: ag?.conversationId || session.id,
          conversationTitle: session.title || ag?.conversationTitle || '未命名对话',
          mode: session.mode,
          sessionKey: session.key,
          status: session.status,
          workspacePath: ag?.workspacePath || null,
          codeWorkspacePath: ag?.codeWorkspacePath || null,
          babeAffection: ag?.babeAffection ?? 0,
          tarotCard: ag?.tarotCard || null,
          messageCount: ag?.contextManager?.messages?.length || 0,
          lastUserMessage: lastUserText,
          sessionUsage: ag?.sessionUsage || null
        };
      });
      await window.api.savePendingSession({ sessions });
    } catch (e) {
      console.error('[App] savePendingSession failed:', e.message);
      try { await window.api.skipPending(); } catch {}
    }
  });

  // App 启动时检查是否有 pending 会话，有则弹模态框询问是否继续
  async function checkPendingSessionOnStartup() {
    try {
      const pending = await window.api.getPendingSession();
      const sessions = pending?.sessions;
      const hasLegacy = pending && pending.conversationId;
      if (!pending || (!Array.isArray(sessions) && !hasLegacy)) {
        return;
      }
      if (Array.isArray(sessions) && sessions.length === 0) {
        await window.api.clearPendingSession();
        return;
      }
      // 距离上次保存超过 7 天则忽略
      try {
        const savedAt = new Date(pending.savedAt).getTime();
        if (Date.now() - savedAt > 7 * 24 * 3600 * 1000) {
          await window.api.clearPendingSession();
          return;
        }
      } catch {}
      showPendingResumeModal(pending);
    } catch (e) {
      console.warn('[App] checkPendingSessionOnStartup failed:', e.message);
    }
  }
  // 延迟调用以确保 UI 已就绪
  setTimeout(checkPendingSessionOnStartup, 1500);

  async function resumePendingItem(item) {
    if (!item?.conversationId) return;
    if (item.mode && item.mode !== currentMode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${item.mode}"]`);
      if (modeBtn) modeBtn.click();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (item.mode === 'code') {
      if (item.codeWorkspacePath) {
        codeWorkspacePath = item.codeWorkspacePath;
        try { await window.api.codeSetLastWorkspace?.(item.codeWorkspacePath); } catch { /* ignore */ }
        const wsPathEl = document.getElementById('code-workspace-path');
        if (wsPathEl) wsPathEl.textContent = item.codeWorkspacePath;
        await loadCodeFileTree(item.codeWorkspacePath);
        await loadCodeHistoryPage();
        await new Promise(resolve => setTimeout(resolve, 250));
        const continueBtn = document.querySelector(`#code-history-list .history-continue[data-id="${item.conversationId}"]`);
        if (continueBtn) continueBtn.click();
      }
      return;
    }
    if (item.mode === 'babe') {
      await loadBabeConversation(item.conversationId);
      return;
    }
    const conv = await window.api.historyGet(item.conversationId);
    if (!conv) return;
    const existing = sessionManager?.list('chat').find(s => String(s.id) === String(conv.id));
    if (existing) {
      agent = existing.agent;
      activateSession('chat', existing.key);
    } else {
      const ag = new Agent();
      ag.mode = 'chat';
      await ag.init();
      await ag.loadFromHistory(conv);
      wireChatAgent(ag);
      const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
      agent = ag;
      activateSession('chat', target.key);
    }
  }

  // 显示"上次会话中断"模态框，提供继续/忽略/查看历史等选项
  function showPendingResumeModal(pending) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,0.5);';
    const modeNames = { chat: 'Chat', code: 'Code', babe: 'Babe' };
    const sessions = Array.isArray(pending.sessions) && pending.sessions.length > 0 ? pending.sessions : [pending];
    const primary = sessions[0] || pending;
    const modeLabel = modeNames[primary.mode] || primary.mode || 'Chat';
    const savedAtStr = (() => {
      try { return new Date(pending.savedAt).toLocaleString('zh-CN'); } catch { return ''; }
    })();
    overlay.innerHTML = `
      <div class="modal pending-resume-modal" style="max-width:480px;width:92vw;background:var(--bg-primary);border-radius:16px;box-shadow:var(--shadow-lg);overflow:hidden;border:1px solid var(--border);">
        <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--warning),#d97706);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;">
            <i class="fa-solid fa-clock-rotate-left"></i>
          </div>
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text-primary);">上次会话未结束</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">中断于 ${savedAtStr}${sessions.length > 1 ? ` · ${sessions.length} 个会话` : ''}</div>
          </div>
        </div>
        <div style="padding:20px 24px;">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">检测到上次 App 异常关闭时正在执行的会话尚未保存。是否继续该会话？</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-secondary);">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">模式</span>
              <span style="font-weight:600;color:var(--text-primary);">${modeLabel}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">会话标题</span>
              <span style="font-weight:600;color:var(--text-primary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(primary.conversationTitle || '').replace(/"/g, '&quot;')}">${primary.conversationTitle || '未命名对话'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">消息数</span>
              <span style="font-weight:600;color:var(--text-primary);">${primary.messageCount || 0}</span>
            </div>
            ${primary.lastUserMessage ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);"><div style="color:var(--text-tertiary);margin-bottom:4px;">最后用户消息：</div><div style="color:var(--text-primary);white-space:pre-wrap;word-break:break-word;max-height:80px;overflow:auto;">${(primary.lastUserMessage || '').replace(/</g, '&lt;')}</div></div>` : ''}
          </div>
        </div>
        <div style="padding:14px 24px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" id="pending-ignore-btn" style="padding:8px 16px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-secondary);border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">忽略并清除</button>
          <button type="button" id="pending-continue-btn" style="padding:8px 16px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 8px var(--accent-bg);">
            <i class="fa-solid fa-play" style="margin-right:6px;"></i>继续会话
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeOverlay = () => fadeOutRemove(overlay);

    overlay.querySelector('#pending-continue-btn').addEventListener('click', async () => {
      try {
        for (const item of sessions) {
          try {
            await resumePendingItem(item);
          } catch (e) {
            console.error('[App] resume pending session failed:', e.message);
          }
        }
        await window.api.clearPendingSession();
      } catch (e) {
        console.error('[App] pending continue failed:', e.message);
      }
      closeOverlay();
    });

    overlay.querySelector('#pending-ignore-btn').addEventListener('click', async () => {
      await window.api.clearPendingSession().catch(() => {});
      closeOverlay();
    });
  }
