  // ---- Mode Switcher (Chat / Code / Babe) ----
  let currentMode = 'chat';
  let sessionManager = null;
  window.getCurrentMode = () => currentMode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      // Remote 模式：仅切换远端模式，不在本地导航/启动 Agent，也不回推到本地 WebUI
      if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentMode = mode;
        remoteWs.send(JSON.stringify({ type: 'switchMode', mode }));
        return;
      }
      // 切换 Chat/Code/Babe 会话：只停止语音播放，不再掐掉上一个模式的推理。
      // 上一个模式继续在后台运行，sessionManager 负责状态和历史刷新。
      stopVoicePlayback();
      if (sessionManager) {
        const prevSession = sessionManager.getActive(currentMode);
        if (prevSession) sessionManager.deactivate(prevSession);
      }

      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = mode;
      if (mode === 'chat') {
        // Show chat sidebar items, hide code/babe ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');
        // Switch to chat page
        document.querySelector('.nav-item[data-page="chat"]')?.click();
      } else if (mode === 'code') {
        // Code mode: show code sidebar items, hide chat/babe ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');
        // Switch to code page
        document.querySelector('.nav-item[data-page="code"]')?.click();
      } else if (mode === 'babe') {
        // Babe mode: show babe sidebar items, hide chat/code ones
        document.querySelector('.nav-item[data-page="chat"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
        document.querySelector('.nav-item[data-page="babe"]')?.classList.remove('hidden');
        document.querySelector('.nav-item[data-page="babe-history"]')?.classList.remove('hidden');
        // Switch to babe page
        document.querySelector('.nav-item[data-page="babe"]')?.click();
        // 启动 Babe Agent（如果尚未启动）
        initBabeAgent();
      }
      // 切换模式后同步标题栏为目标模式当前对话标题（无则显示"未命名对话"）
      let modeTitle = '';
      if (mode === 'chat') modeTitle = agent?.conversationTitle || '';
      else if (mode === 'code') modeTitle = codeAgent?.conversationTitle || '';
      else if (mode === 'babe') modeTitle = babeAgent?.conversationTitle || '';
      setTitlebarTitle(modeTitle);
      // 同步模式切换到 WebUI（增量更新：modeSwitch 消息包含模式信息，WebUI 端 applyModeSwitch 处理 nav-item 显隐）
      try { window.api.webControlPushModeSwitch(mode); } catch (_) {}
      // 不再推送全量 body：nav-item 显隐由 WebUI 端 applyModeSwitch 处理
      // 各模式的消息变更已有 pushDomEvent 增量推送
    });
  });
  // WebUI → 渲染器：模式切换
  window.api?.onWebControlSwitchMode?.((mode) => {
    if (mode === currentMode) return;
    const btn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
    if (btn) btn.click();
  });
  // WebUI → 渲染器：重新优化工具
  window.api?.onWebControlReoptimizeTools?.(() => {
    if (btnReoptimizeTools && !btnReoptimizeTools.classList.contains('hidden')) {
      btnReoptimizeTools.click();
    }
  });
  // Initialize: hide code/babe-mode nav items
  document.querySelector('.nav-item[data-page="code"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="code-history"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="babe"]')?.classList.add('hidden');
  document.querySelector('.nav-item[data-page="babe-history"]')?.classList.add('hidden');

  // ---- Agent Callbacks ----
  function wireChatAgent(ag) {
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onMessage = (type, data) => {
    switch (type) {
      case 'tarot':
        if (data) {
          // 后端逻辑：始终推送 tarot 到 WebUI（保持子代理/对话上下文一致）
          window.api.webControlPushTarot(data);
          // UI 可见性：关闭时跳过所有前端渲染（agent-tarot 已被 hidden 隐藏）
          if (!isActive() || !tarotVisible || !agentTarot) break;
          const iconHtml = data.icon ? `<i class="fa-solid ${data.icon}"></i>` : '<i class="fa-solid fa-star"></i>';
          const _lang = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
          const _isZh = (_lang === 'zh-CN');
          const position = data.isReversed ? (_isZh ? '逆位' : 'Reversed') : (_isZh ? '正位' : 'Upright');
          const _cardName = _isZh ? data.name : (data.nameEn || data.name);
          const meaning = data.isReversed ? data.meaningOfReversed : data.meaningOfUpright;
          const eSource = data.entropySource || 'CSPRNG';
          const isTRNG = eSource.startsWith('TRNG');
          const trngBadge = isTRNG ? '<span class="trng-badge" style="margin-left:6px;font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';
          agentTarot.innerHTML = `${iconHtml}<span>${_isZh ? '命运之牌：' : 'Tarot: '}${_cardName}(${position})</span>${trngBadge}`;
          agentTarot.title = `${_cardName}(${position}) - ${meaning || ''} [${eSource}]`;
          // Add system message for tarot card
          const entropyNote = isTRNG ? (_isZh ? ' [TRNG 硬件真随机]' : ' [TRNG Hardware Random]') : '';
          addSystemMessage(`${_isZh ? '抽取了命运之牌：' : 'Drew Tarot: '}${_cardName}(${position})${_isZh ? '（' : ' ('}${data.nameEn}${_isZh ? '）' : ')'}${entropyNote}\n${meaning || ''}`);
        }
        break;
      case 'assistant':
        if (!isActive()) break;
        addMessageToChat('assistant', data);
        window.api.webControlPushMessage('assistant', data);
        break;
      case 'stream-start':
        if (!isActive()) break;
        // Create a placeholder bubble for streaming tokens
        startStreamingMessage(data?.requestId);
        break;
      case 'stream-chunk':
        if (!isActive()) break;
        appendStreamChunk(data?.requestId, data);
        break;
      case 'stream-end':
        if (!isActive()) break;
        finalizeStreamMessage(data?.requestId, data);
        break;
      case 'error':
        if (!isActive()) break;
        // 错误消息已被 agent.js 持久化到 contextManager，这里只负责 UI 显示
        addSystemMessage(`[错误] ${data}`, { persist: false });
        window.api.webControlPushMessage('system', `[错误] ${data}`);
        break;
      case 'optimize-tools-start':
        if (!isActive()) break;
        addThinkingIndicatorWithText('正在优化工具选择...');
        break;
      case 'optimize-tools-end':
        if (!isActive()) break;
        if (ag.running) {
          addThinkingIndicator();
        } else {
          removeThinkingIndicator();
        }
        updateReoptimizeButtonVisibility();
        if (document.getElementById('page-tools')?.classList.contains('active')) {
          loadToolsPage();
        }
        break;
      case 'approval':
        if (!isActive()) break;
        showApprovalPanel(data.toolName, data.args);
        window.api.webControlPushApproval(data.toolName, data.args);
        break;
      case 'tool-auth-required':
        if (!isActive()) break;
        showToolAuthModal(data.toolName, data.category, ag);
        break;
      case 'sub-agent-start': {
        if (!isActive()) break;
        const tarotPart = tarotVisible && data.tarot
          ? ` - 命运之牌: ${data.tarot.name}${data.tarot.isReversed ? '(逆位)' : '(正位)'}${data.tarot?.entropySource?.startsWith('TRNG') ? ' [TRNG]' : ''}`
          : '';
        addSubAgentCard({
          id: data.id,
          title: `子代理启动${tarotPart}`,
          task: data.task,
          startTime: data.startTime,
          status: 'running'
        });
        break;
      }
      case 'sub-agent-done':
        if (!isActive()) break;
        updateSubAgentCard(data.id, {
          status: 'done',
          result: data.result,
          duration: data.duration,
          usage: data.usage,
          toolUseCount: data.toolUseCount,
          iterations: data.iterations
        });
        break;
      case 'sub-agent-message':
        if (!isActive()) break;
        // 子代理中间消息：不显示在聊天页面，而是保存在子代理记录中
        // 用户可点击子代理卡片查看完整对话记录（参考 claude-code-ref 的隔离设计）
        // 消息已通过 agent.subAgents[].messages 自动累积，模态框打开时从 agent.getSubAgent(id) 读取
        // 如果详情模态框正打开且就是该子代理，触发立即刷新
        if (_openSubAgentModalId === data.id && typeof _subAgentModalRender === 'function') {
          requestAnimationFrame(() => {
            if (_openSubAgentModalId === data.id) _subAgentModalRender();
          });
        }
        break;
      case 'sub-agent-batch-start':
        // 不在主聊天显示批次横幅，也不写入主上下文（子代理有独立卡片，避免污染主聊天历史）
        break;
      case 'sub-agent-batch-done':
        break;
      case 'present-file':
        if (!isActive()) break;
        addFilePresentCard(data);
        // 系统通知：文件呈递
        sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        break;
    }
    if (isActive()) updateContextProgress();
  };

  ag.onTitleChange = (title) => {
    if (isActive()) setTitlebarTitle(title);
    if (isActive()) window.api.webControlPushTitle(title);
  };

  ag.onStatusChange = (status) => {
    if (!isActive()) {
      // 后台会话状态由 SessionManager 负责；只刷新全局会话 tab。
      if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
      return;
    }
    if (status === 'working') {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中... <span id="work-duration" style="margin-left:6px;font-variant-numeric:tabular-nums">00:00</span>';
      agentStatus.className = 'agent-status working';
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：工作时发送按钮保持可见
      // 启动工作时长计时器
      if (window._workTimer) { clearInterval(window._workTimer); }
      window._workStartTime = Date.now();
      const durEl = document.getElementById('work-duration');
      const updateDur = () => {
        const el = document.getElementById('work-duration');
        if (!el || !window._workStartTime) return;
        const sec = Math.floor((Date.now() - window._workStartTime) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        el.textContent = `${mm}:${ss}`;
      };
      updateDur();
      window._workTimer = setInterval(updateDur, 1000);
    } else {
      agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
      agentStatus.className = 'agent-status';
      // 仅当 Agent 完成 且 语音播报也完成时才隐藏停止按钮
      refreshChatStopButton();
      btnSend.classList.remove('hidden');
      removeThinkingIndicator(); // 防御：确保待命时思考提示已清除
      // 停止计时器
      const wasWorking = window._workStartTime !== null;
      if (window._workTimer) { clearInterval(window._workTimer); window._workTimer = null; window._workStartTime = null; }
      // Agent 工作完成：隐藏 Playwright 横幅（不关闭浏览器，仅隐藏屏幕右上角提示）
      if (wasWorking && window.api?.pwHideBanner) {
        try { window.api.pwHideBanner(); } catch {}
      }
    }
    // 推送状态变化到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#agent-status', html: agentStatus.outerHTML });
    if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
    if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-send', attr: 'class', value: btnSend.className });
    window.api.webControlPushStatus(status);
  };

  ag.onToolCall = (name, args, status, result) => {
    if (!isActive()) return;
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
    const displayName = toolDef?.desc || name;

    if (status === 'calling') {
      addToolCallToChat(displayName, name, args);
    } else if (status === 'done') {
      updateToolCallResult(name, result);
      updateContextProgress();
      // If generateImage returned a URL/base64, display image directly
      if (name === 'generateImage' && result?.ok && result?.url) {
        addImageMessage(result.url);
      }
      // If getTarot returned a multi-card spread, display visual cards
      if (name === 'getTarot' && result?.ok && result?.result?.spread) {
        addTarotSpreadToChat(result.result);
      }
    } else if (status === 'denied') {
      updateToolCallResult(name, { ok: false, error: '用户拒绝了操作' }, true);
      updateContextProgress();
    }
    window.api.webControlPushToolCall(name, args, status, typeof result === 'string' ? result : JSON.stringify(result || ''));
  };

  ag.onTodoUpdate = (items) => {
    if (!isActive()) return;
    renderTodoList(items);
  };
  }

  wireChatAgent(agent);

  await agent.init();
  sessionManager = new SessionManager({
    maxConcurrent: Math.max(1, Number(agent.settings?.sessions?.maxConcurrent) || 10)
  });
  window.__sessionManager = sessionManager;
  const primaryChatSession = sessionManager.registerAgent('chat', agent, {
    title: agent.conversationTitle || '未命名对话'
  });
  sessionManager.activate('chat', primaryChatSession.key);
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
  AppBus.on('session-closed', () => {
    if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
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
      const activeTab = document.querySelector('.settings-tab-btn.active');
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

  function renderSessionTabs(mode) {
    if (!sessionManager) return;
    const tabsEl = document.getElementById(`${mode}-session-tabs`);
    if (!tabsEl) return;
    const sessions = sessionManager.list(mode).sort((a, b) => a.createdAt - b.createdAt);
    if (sessions.length <= 1) {
      tabsEl.classList.add('hidden');
      tabsEl.innerHTML = '';
      return;
    }
    tabsEl.classList.remove('hidden');
    tabsEl.innerHTML = '';
    const active = sessionManager.getActive(mode);
    for (const session of sessions) {
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (active?.key === session.key ? ' active' : '');
      tab.dataset.sessionKey = session.key;
      tab.title = session.title || '未命名会话';
      tab.innerHTML = `
        <span class="session-status-dot ${escapeHtml(session.status)}"></span>
        <span class="session-tab-title">${escapeHtml(session.title || '未命名会话')}</span>
        <span class="session-tab-close" title="关闭会话"><i class="fa-solid fa-xmark"></i></span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.session-tab-close')) return;
        activateSession(mode, session.key);
      });
      const closeBtn = tab.querySelector('.session-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSession(session);
      });
      tabsEl.appendChild(tab);
    }
    const add = document.createElement('button');
    add.className = 'session-tab-add';
    add.title = '新建会话';
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.addEventListener('click', () => createNewSession(mode));
    tabsEl.appendChild(add);
  }

  function renderAllSessionTabs() {
    renderSessionTabs('chat');
    renderSessionTabs('code');
    renderSessionTabs('babe');
  }

  function closeSession(session) {
    if (!session || !sessionManager) return;
    const isActive = sessionManager.getActive(session.mode)?.key === session.key;
    const nextSessions = sessionManager.list(session.mode).filter(s => s.key !== session.key);
    const nextSession = nextSessions.length ? nextSessions[0] : null;
    const running = session.status === SessionStatus.RUNNING
      || session.status === SessionStatus.WAITING_APPROVAL
      || session.status === SessionStatus.WAITING_TOOL_AUTH;
    if (running && !window.confirm(`会话“${session.title || '未命名'}”仍在运行，确定停止并关闭吗？`)) return;
    if (session.mode === 'chat' && session.agent === agent) {
      const others = sessionManager.list('chat').filter(s => s.key !== session.key);
      if (others.length) {
        agent = others[0].agent;
      } else {
        agent = new Agent();
      }
    } else if (session.mode === 'code' && session.agent === codeAgent) {
      const others = sessionManager.list('code').filter(s => s.key !== session.key);
      codeAgent = others.length ? others[0].agent : null;
    } else if (session.mode === 'babe' && session.agent === babeAgent) {
      const others = sessionManager.list('babe').filter(s => s.key !== session.key);
      babeAgent = others.length ? others[0].agent : null;
    }
    sessionManager.close(session);
    if (isActive && nextSession) activateSession(session.mode, nextSession.key);
    renderAllSessionTabs();
  }

  async function createNewSession(mode) {
    if (!sessionManager) return;
    if (mode === 'chat') {
      const ag = new Agent();
      ag.mode = 'chat';
      await ag.init();
      wireChatAgent(ag);
      const session = sessionManager.registerAgent('chat', ag, { title: ag.conversationTitle || '未命名会话' });
      activateSession('chat', session.key);
    } else if (mode === 'code') {
      await createCodeSession();
    } else if (mode === 'babe') {
      await createBabeSession();
    }
  }

  async function activateSession(mode, key) {
    if (!sessionManager) return;
    const session = sessionManager.get(key);
    if (!session || session.mode !== mode) return;
    if (currentMode !== mode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
      if (modeBtn) modeBtn.click();
      // 等待模式切换完成后再激活目标会话
      setTimeout(() => activateSession(mode, key), 0);
      return;
    }
    sessionManager.activate(mode, key);
    if (mode === 'chat') {
      agent = session.agent;
      const conv = {
        id: agent.conversationId,
        title: agent.conversationTitle || session.title,
        messages: agent.contextManager?.getHistoryMessages() || [],
        subAgents: agent.subAgents || [],
        workspacePath: agent.workspacePath,
        usage: agent.sessionUsage
      };
      rebuildChatUIFromHistory(conv);
    } else if (mode === 'code') {
      codeAgent = session.agent;
      codeWorkspacePath = codeAgent.codeWorkspacePath || codeAgent.workspacePath || codeWorkspacePath;
      codeMessages = codeAgent.contextManager?.getHistoryMessages().slice() || [];
      await replayCodeSession(session);
    } else if (mode === 'babe') {
      babeAgent = session.agent;
      babeMessages = babeAgent.contextManager?.getHistoryMessages().slice() || [];
      await replayBabeSession(session);
    }
    if (session.status === SessionStatus.WAITING_APPROVAL && session.pendingApproval) {
      const approval = session.pendingApproval;
      if (mode === 'code') showCodeApprovalPanel(approval.toolName, approval.args);
      else if (mode === 'chat') showApprovalPanel(approval.toolName, approval.args);
    }
    if (session.status === SessionStatus.WAITING_TOOL_AUTH && session.pendingToolAuth) {
      showToolAuthModal(session.pendingToolAuth.toolName, session.pendingToolAuth.category, session.agent);
    }
    updateContextProgress();
    renderAllSessionTabs();
  }

  await normalizeToolSettings();
  setTitlebarTitle(agent.conversationTitle || '未命名对话');
  updateReoptimizeButtonVisibility();
  updateContextProgress();
