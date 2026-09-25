  if (typeof window.api.onDsAgentMessage === 'function') {
    window.api.onDsAgentMessage((msg) => {
      if (!msg || !msg.sessionKey || !sessionManager) return;
      const session = sessionManager.get(msg.sessionKey);
      if (!session || !session.agent) return;
      const text = String(msg.text || '');
      if (msg.kind === 'inject') {
        try { session.agent.injectHotMessage(text, []); } catch { /* ignore */ }
      } else if (msg.kind === 'stop') {
        try { sessionManager.stop(session); } catch { /* ignore */ }
      } else if (msg.kind === 'followup' || msg.kind === 'steer') {
        if (session.agent.running || !sessionManager.requestStart(session)) {
          sessionManager.queue(session, { text, attachments: [] });
        } else {
          session.agent.sendMessage(text, []).catch((err) => {
            if (session.agent.onMessage) session.agent.onMessage('error', err?.message || String(err));
          });
        }
      }
    });
  }

  // agents.create：新建一个 Chat 会话（可带初始指令）并回传句柄元数据
  if (typeof window.api.onDsAgentCreateRequest === 'function') {
    window.api.onDsAgentCreateRequest(async (req) => {
      if (typeof createNewSession !== 'function') throw new Error('会话模块未就绪');
      await createNewSession('chat');
      await new Promise(r => setTimeout(r, 60));
      const sm = window.__sessionManager;
      const session = sm ? sm.getActive('chat') : null;
      const ag = (session && session.agent) || agent;
      if (!ag) throw new Error('无法创建 Chat Agent');
      const instructions = req && typeof req.instructions === 'string' ? req.instructions.trim() : '';
      if (instructions && typeof addMessageToChat === 'function') addMessageToChat('user', instructions);
      if (instructions) await ag.sendMessage(instructions, []);
      return {
        sessionKey: ag.sessionKey || (session && session.key) || null,
        id: session ? session.id : null,
        title: session ? session.title : '新会话',
        cwd: ag.workspacePath || null
      };
    });
  }

  // agents.resume：按会话 id 恢复句柄（切到该会话）
  if (typeof window.api.onDsAgentResumeRequest === 'function') {
    window.api.onDsAgentResumeRequest(async (req) => {
      const sm = window.__sessionManager;
      if (!sm) throw new Error('会话管理器未就绪');
      const all = sm.list();
      const session = all.find(s => s.key === req.sessionId || String(s.id) === String(req.sessionId));
      if (!session) throw new Error('会话不存在');
      if (typeof activateSession === 'function') {
        await activateSession(session.mode, session.key);
        await new Promise(r => setTimeout(r, 60));
      }
      return {
        sessionKey: session.key,
        id: session.id,
        title: session.title,
        status: session.status,
        cwd: (session.agent && (session.agent.workspacePath || session.agent.codeWorkspacePath)) || null
      };
    });
  }

  if (typeof window.api.onDsApprovalRequest === 'function') {
    window.api.onDsApprovalRequest((req) => {
      if (req && req.id) showDsApprovalModal(req);
    });
  }

  AppBus.on('session-status', (event) => {
    const { session, status, previous } = event.detail || {};
    if (!session) return;
    if (status === SessionStatus.DONE && previous === SessionStatus.RUNNING) {
      const title = session.title || '当前会话';
      sendAppNotification('sessionDone', '会话已完成', `${session.modeLabel || title} - 工作已完成`, !session.active, { sessionKey: session.key, mode: session.mode });
    } else if (status === SessionStatus.ERROR && previous === SessionStatus.RUNNING) {
      sendAppNotification('sessionError', '会话执行失败', `${session.title || '会话'} - ${session.lastError || '未知错误'}`, !session.active, { sessionKey: session.key, mode: session.mode });
    } else if (status === SessionStatus.WAITING_APPROVAL) {
      sendAppNotification('approval', '会话等待审批', `${session.title || '会话'} - 需要您的批准`, !session.active, { sessionKey: session.key, mode: session.mode });
    }
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
    if (status === SessionStatus.DONE || status === SessionStatus.ERROR || status === SessionStatus.IDLE) {
      sessionManager.processQueue();
    }
  });
  AppBus.on('session-dequeued', (event) => {
    const { session, message } = event.detail || {};
    if (!session || !message) return;
    const ag = session.agent;
    if (!ag) return;
    if (session.mode === 'chat') {
      ag.sendMessage(message.text, message.attachments || []).catch(err => {
        if (ag.onMessage) ag.onMessage('error', err?.message || String(err));
      });
    } else if (session.mode === 'code') {
      ag.sendMessage(message.text, message.attachments || []).catch(() => {});
    } else if (session.mode === 'babe') {
      ag.sendMessage(message.text, message.attachments || []).catch(() => {});
    }
  });
  AppBus.on('session-title', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-created', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-deactivated', (event) => {
    const { session } = event.detail || {};
    if (session) {
      try { retractSessionUiRoot(session); } catch { /* ignore */ }
      // 保存当前输入框草稿到被切走的会话
      const input = session.mode === 'code'
        ? document.getElementById('code-chat-input')
        : session.mode === 'babe'
          ? document.getElementById('babe-chat-input')
          : chatInput;
      if (input) session.draft = input.value || '';
    }
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-closed', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
  });
  AppBus.on('session-attention', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
    refreshActiveHistoryPage();
  });
  let historyRefreshTimer = null;
  const refreshActiveHistoryPage = () => {
    if (historyRefreshTimer) return;
    historyRefreshTimer = setTimeout(() => {
      historyRefreshTimer = null;
      const active = document.querySelector('.page.active');
      if (!active) return;
      if (active.id === 'page-history') loadHistoryPage();
      else if (active.id === 'page-code-history') loadCodeHistoryPage();
      else if (active.id === 'page-babe-history') loadBabeHistoryPage();
    }, 400);
  };
  ['session-status', 'session-title', 'session-usage', 'session-created', 'session-closed'].forEach(eventName => {
    AppBus.on(eventName, refreshActiveHistoryPage);
  });
  if (typeof window.api.onUsageChanged === 'function') {
    window.api.onUsageChanged((data) => {
      if (!data) return;
      const usageEl = document.getElementById('setting-llm-usage');
      if (usageEl) usageEl.textContent = fmtTokenCount(data.dailyTokensUsed || 0);
      try { refreshBudgetMiniBars(); } catch { /* ignore */ }
      try { refreshSessionCostMini(); } catch { /* ignore */ }
      const activeTab = document.querySelector('.settings-tab.active');
      if (activeTab && activeTab.dataset.tab === 'usage') {
        try { loadUsageStats(document.querySelector('.usage-period-btn.active')?.dataset.period || 'daily'); } catch { /* ignore */ }
      }
    });
  }
  if (typeof window.api.onNotificationClick === 'function') {
    window.api.onNotificationClick((data) => {
      if (!data || !data.sessionKey || !sessionManager) return;
      const session = sessionManager.get(data.sessionKey);
      if (!session) return;
      if (data.mode && data.mode !== currentMode) {
        const modeBtn = document.querySelector(`.mode-btn[data-mode="${data.mode}"]`);
        if (modeBtn) modeBtn.click();
      }
      activateSession(session.mode, session.key);
    });
  }
