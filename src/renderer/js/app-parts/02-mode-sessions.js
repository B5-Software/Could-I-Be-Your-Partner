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
      if (typeof showSessionTabsForMode === 'function') showSessionTabsForMode(mode);
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
        if (typeof renderSessionTabs === 'function') renderSessionTabs('chat');
        if (sessionManager) {
          const target = resolveModeTarget('chat');
          if (target) activateSession('chat', target.key);
        }
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
        if (typeof renderSessionTabs === 'function') renderSessionTabs('code');
        if (sessionManager) {
          const target = resolveModeTarget('code');
          if (target) activateSession('code', target.key);
        }
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
        if (typeof renderSessionTabs === 'function') renderSessionTabs('babe');
        if (sessionManager) {
          const target = resolveModeTarget('babe');
          if (target) activateSession('babe', target.key);
        }
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
          if (!isActive()) {
            const session = sessionManager?.getByAgent(ag);
            if (sessionManager && session) sessionManager.bufferUiEvent(session, { type: 'tarot', data });
            break;
          }
          if (!tarotVisible || !agentTarot) break;
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
        if (!isActive()) {
          const session = sessionManager?.getByAgent(ag);
          if (sessionManager && session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          // 系统通知：文件呈递（后台会话也要提醒）
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
        }
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

  ag.onToolCall = (name, args, status, result, callId) => {
    if (!isActive()) {
      const session = sessionManager?.getByAgent(ag);
      if (sessionManager && session && status === 'done' && name === 'getTarot' && result?.ok && result?.result?.spread) {
        sessionManager.bufferUiEvent(session, { type: 'tarot-spread', result: result.result });
      }
      return;
    }
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
    const displayName = toolDef?.desc || name;

    if (status === 'calling') {
      addToolCallToChat(displayName, name, args, callId);
    } else if (status === 'done') {
      updateToolCallResult(name, result, false, callId);
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
      updateToolCallResult(name, { ok: false, error: '用户拒绝了操作' }, true, callId);
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
    maxConcurrent: Math.max(1, Number(agent.settings?.sessions?.maxConcurrent) || 10),
    // 关键：必须复用全局 AppBus，否则 SessionManager 内部默认会新建一个私有总线，
    // 导致 session-status/session-title/session-created/session-closed 等监听全部失效，
    // 表现为会话标签栏不刷新、排队消息不推进、历史页不自动刷新。
    bus: AppBus
  });
  window.__sessionManager = sessionManager;
  const primaryChatSession = sessionManager.registerAgent('chat', agent, {
    title: agent.conversationTitle || '未命名对话'
  });
  sessionManager.activate('chat', primaryChatSession.key);

  // ---- DeepSeek 插件服务翻译层：会话同步 / agent 消息 / 授权 ----
  let dsApprovalCurrent = null;
  function showDsApprovalModal(req) {
    dsApprovalCurrent = req;
    const toolEl = document.getElementById('ds-approval-tool');
    const reasonEl = document.getElementById('ds-approval-reason');
    if (toolEl) toolEl.textContent = `工具：${req.toolName || 'plugin'}`;
    if (reasonEl) reasonEl.textContent = req.reason || '';
    document.getElementById('ds-approval-modal')?.classList.remove('hidden');
  }
  function answerDsApproval(outcome) {
    const req = dsApprovalCurrent;
    if (!req) return;
    document.getElementById('ds-approval-modal')?.classList.add('hidden');
    dsApprovalCurrent = null;
    if (typeof window.api.dsApprovalRespond === 'function') {
      window.api.dsApprovalRespond(req.id, outcome).catch(() => {});
    }
  }
  document.getElementById('btn-allow-ds-approval')?.addEventListener('click', () => answerDsApproval('allowed-once'));
  document.getElementById('btn-deny-ds-approval')?.addEventListener('click', () => answerDsApproval('denied'));
  document.getElementById('btn-close-ds-approval')?.addEventListener('click', () => answerDsApproval('cancelled'));

  const pushDsAgentSync = () => {
    if (typeof window.api.dsAgentSync !== 'function' || !sessionManager) return;
    try {
      const entries = sessionManager.list().map(s => ({
        key: s.key,
        id: s.id,
        mode: s.mode,
        title: s.title,
        status: s.status,
        cwd: (s.agent && (s.agent.workspacePath || s.agent.codeWorkspacePath)) || null
      }));
      window.api.dsAgentSync(entries).catch(() => {});
    } catch { /* ignore */ }
  };
  pushDsAgentSync();
  AppBus.on('session-created', () => pushDsAgentSync());
  AppBus.on('session-status', () => pushDsAgentSync());
  AppBus.on('session-closed', () => pushDsAgentSync());

  if (typeof window.api.onDsAgentMessage === 'function') {
    window.api.onDsAgentMessage((msg) => {
      if (!msg || !msg.sessionKey || !sessionManager) return;
      const session = sessionManager.get(msg.sessionKey);
      if (!session || !session.agent) return;
      const text = String(msg.text || '');
      if (msg.kind === 'inject') {
        try { session.agent.injectHotMessage(text, []); } catch { /* ignore */ }
      } else if (msg.kind === 'followup') {
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
    const sessions = sessionManager.ordered(mode);
    // 标签栏常驻：即使没有会话也只显示“新建会话”按钮；
    // 可见性统一由 showSessionTabsForMode 控制（宿主在 page section 之外）。
    tabsEl.innerHTML = '';
    const active = sessionManager.getActive(mode);
    for (const session of sessions) {
      const attentionMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(session.attention) : null;
      const dotClass = attentionMeta
        ? `attention ${attentionMeta.cls}`
        : escapeHtml(session.status);
      const dotTitle = attentionMeta ? attentionMeta.label : '';
      const attentionBadge = attentionMeta
        ? `<span class="session-attention-badge ${attentionMeta.cls}"><i class="fa-solid ${attentionMeta.icon}"></i>${escapeHtml(attentionMeta.label.replace('等待', ''))}</span>`
        : '';
      const tab = document.createElement('div');
      tab.className = 'session-tab' + (active?.key === session.key ? ' active' : '');
      tab.dataset.sessionKey = session.key;
      tab.draggable = true;
      tab.title = session.title || '未命名会话';
      tab.innerHTML = `
        <span class="session-status-dot ${dotClass}" ${dotTitle ? `title="${escapeHtml(dotTitle)}"` : ''}></span>
        <span class="session-tab-title">${escapeHtml(session.title || '未命名会话')}</span>
        ${attentionBadge}
        <span class="session-tab-close" title="关闭会话"><i class="fa-solid fa-xmark"></i></span>
      `;
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.session-tab-close')) return;
        activateSession(mode, session.key);
      });
      tab.addEventListener('mouseenter', () => {
        if (tab.classList.contains('dragging')) return;
        showSessionTabPopover(session, tab);
      });
      tab.addEventListener('mouseleave', () => {
        hideSessionTabPopover();
      });
      tab.addEventListener('contextmenu', (e) => {
        hideSessionTabPopover();
        showSessionTabContextMenu(e, mode, session);
      });
      // ---- 拖动排序 ----
      tab.addEventListener('dragstart', (e) => {
        hideSessionTabPopover();
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', session.key); } catch { /* ignore */ }
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        clearSessionDragIndicators(tabsEl);
      });
      const closeBtn = tab.querySelector('.session-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSessionBatch(session.mode, new Set([session.key]));
      });
      tabsEl.appendChild(tab);
    }
    // ---- 栏级拖放目标 ----
    tabsEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      clearSessionDragIndicators(tabsEl);
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        targetTab.classList.add(e.clientX > rect.left + rect.width / 2 ? 'drop-target-after' : 'drop-target-before');
      }
    });
    tabsEl.addEventListener('dragleave', (e) => {
      if (!tabsEl.contains(e.relatedTarget)) clearSessionDragIndicators(tabsEl);
    });
    tabsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const key = e.dataTransfer ? (e.dataTransfer.getData('text/plain') || '') : '';
      clearSessionDragIndicators(tabsEl);
      if (!key || !sessionManager.get(key)) return;
      const tabEls = Array.from(tabsEl.querySelectorAll('.session-tab'));
      let index = tabEls.length;
      const targetTab = e.target && e.target.closest ? e.target.closest('.session-tab') : null;
      if (targetTab) {
        const rect = targetTab.getBoundingClientRect();
        index = tabEls.indexOf(targetTab) + (e.clientX > rect.left + rect.width / 2 ? 1 : 0);
      }
      try { sessionManager.reorder(mode, key, index); } catch { /* ignore */ }
      renderAllSessionTabs();
    });
    const add = document.createElement('button');
    add.className = 'session-tab-add';
    add.title = '新建会话';
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.addEventListener('click', () => createNewSession(mode));
    tabsEl.appendChild(add);
    // 多会话镜像：标签栏内容变更增量推送到 WebUI，保持远端标签栏实时一致
    if (!isRemoteMode) {
      try {
        WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#' + tabsEl.id, html: tabsEl.innerHTML });
      } catch { /* ignore */ }
    }
  }

  function renderAllSessionTabs() {
    renderSessionTabs('chat');
    renderSessionTabs('code');
    renderSessionTabs('babe');
  }

  function clearSessionDragIndicators(tabsEl) {
    if (!tabsEl) return;
    tabsEl.querySelectorAll('.drop-target-before, .drop-target-after, .dragging').forEach(el => {
      el.classList.remove('drop-target-before', 'drop-target-after');
    });
  }

  // ---- 会话标签悬停预览 ----
  let _stpSessionKey = null;
  let _stpTimer = null;

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function workspaceInfo(session) {
    const ws = (session && session.agent && (session.agent.codeWorkspacePath || session.agent.workspacePath)) || '';
    if (!ws) return { name: '未选择', full: '' };
    const parts = String(ws).split(/[\\/]/).filter(Boolean);
    return { name: parts[parts.length - 1] || ws, full: ws };
  }

  function computeContextStats(ag) {
    const cm = ag && ag.contextManager;
    if (!cm) return null;
    const stats = (typeof cm.getStats === 'function') ? cm.getStats() : null;
    const estimateMsg = (m) => (typeof cm.estimateMessageTokens === 'function' ? cm.estimateMessageTokens(m) : 0);
    const estimateText = (t) => (typeof cm.estimateTokens === 'function' ? cm.estimateTokens(t) : 0);
    const sys = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
    let tools = 0;
    try {
      const schemas = (typeof ag.getRuntimeToolSchemas === 'function') ? ag.getRuntimeToolSchemas() : [];
      tools = Math.ceil(JSON.stringify(schemas).length / 4);
    } catch { /* ignore */ }
    let chat = 0;
    let tool = 0;
    (cm.messages || []).forEach((m) => {
      if (!m) return;
      if (m.role === 'tool') tool += estimateMsg(m);
      else if (m.role === 'user' || m.role === 'assistant') chat += estimateMsg(m);
    });
    const summaries = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
    const used = sys + tools + chat + tool + summaries;
    const max = (stats && stats.maxTokens) || (ag.settings && ag.settings.llm && ag.settings.llm.maxContextLength) || 0;
    const reserve = (ag.settings && ag.settings.llm && ag.settings.llm.maxResponseTokens) || 8192;
    const totalOcc = used + reserve;
    const pct = max ? Math.min(100, (totalOcc / max) * 100) : 0;
    return { sys, tools, chat, tool, summaries, used, max, reserve, totalOcc, pct, usage: { ...(ag.sessionUsage || {}) } };
  }

  function renderPopoverContext(stats) {
    if (!stats) return '该会话上下文尚未初始化';
    const fmt = (n) => (typeof fmtTokenCount === 'function' ? fmtTokenCount(n) : String(n));
    const level = stats.pct >= 85 ? 'danger' : stats.pct >= 65 ? 'warn' : '';
    const rows = [
      ['系统指导 + 工具定义', fmt(stats.sys + stats.tools)],
      ['对话消息', fmt(stats.chat)],
      ['工具结果', fmt(stats.tool)],
      ['摘要', fmt(stats.summaries)],
      ['输入占用', fmt(stats.used)],
      ['输出预留', fmt(stats.reserve)],
      ['本会话累计 Token', fmt(stats.usage.total || 0)]
    ];
    return rows.map(([label, value]) => `<div class="stp-ctx-row"><span>${escapeHtml(label)}</span><b>${value}</b></div>`).join('')
      + `<div class="stp-ctx-bar"><div class="stp-ctx-bar-fill ${level}" style="width:${Math.max(0, Math.min(100, stats.pct)).toFixed(1)}%"></div></div>`
      + `<div class="stp-ctx-total"><span>${escapeHtml('合计 / 窗口')}</span><span>${fmt(stats.totalOcc)} / ${fmt(stats.max)} (${Math.round(stats.pct)}%)</span></div>`;
  }

  function showSessionTabPopover(session, tab) {
    const pop = document.getElementById('session-tab-popover');
    if (!pop || !session || !tab) return;
    _stpSessionKey = session.key;
    const stpTitle = document.getElementById('stp-title');
    const stpStatus = document.getElementById('stp-status');
    const stpElapsed = document.getElementById('stp-elapsed');
    const stpWorkspace = document.getElementById('stp-workspace');
    const stpContext = document.getElementById('stp-context');
    if (!stpTitle || !stpStatus || !stpElapsed || !stpWorkspace || !stpContext) return;

    const update = () => {
      if (_stpSessionKey !== session.key) return;
      const cur = sessionManager.get(session.key);
      if (!cur) { hideSessionTabPopover(); return; }
      stpTitle.textContent = cur.title || '未命名会话';
      const attMeta = (typeof sessionAttentionMeta === 'function') ? sessionAttentionMeta(cur.attention) : null;
      stpStatus.textContent = attMeta ? attMeta.label : (typeof sessionStatusLabel === 'function' ? sessionStatusLabel(cur.status) : String(cur.status || '空闲'));
      const running = cur.status === 'running' || cur.status === 'queued' || cur.status === 'waiting_approval' || cur.status === 'waiting_tool_auth' || (cur.agent && cur.agent.running);
      stpElapsed.textContent = cur.startedAt ? fmtDuration(Date.now() - cur.startedAt) : (running ? '进行中' : '未开始');
      const ws = workspaceInfo(cur);
      stpWorkspace.textContent = ws.name;
      stpWorkspace.title = ws.full || '';
      stpContext.innerHTML = renderPopoverContext(computeContextStats(cur.agent));
    };
    update();

    const rect = tab.getBoundingClientRect();
    pop.classList.remove('hidden');
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
    let top = rect.bottom + 6;
    if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - popH - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    if (_stpTimer) clearInterval(_stpTimer);
    _stpTimer = setInterval(update, 1000);
  }

  function hideSessionTabPopover() {
    _stpSessionKey = null;
    if (_stpTimer) { clearInterval(_stpTimer); _stpTimer = null; }
    const pop = document.getElementById('session-tab-popover');
    if (pop) pop.classList.add('hidden');
  }

  // 切换模式时优先恢复该模式最后访问的会话；不存在/已关闭时回退到第一个标签
  function resolveModeTarget(mode) {
    try {
      const active = sessionManager.getActive(mode);
      if (active) return active;
      const lastKey = sessionManager.getLastActive(mode);
      if (lastKey) {
        const last = sessionManager.get(lastKey);
        if (last) return last;
      }
      return sessionManager.ordered(mode)[0] || null;
    } catch {
      return (sessionManager && sessionManager.ordered(mode)[0]) || null;
    }
  }

  // 只显示当前模式对应的标签栏（宿主常驻，其余模式隐藏）
  function showSessionTabsForMode(mode) {
    const host = document.getElementById('session-tabs-host');
    if (host) host.classList.remove('hidden');
    for (const m of ['chat', 'code', 'babe']) {
      const el = document.getElementById(`${m}-session-tabs`);
      if (!el) continue;
      el.classList.remove('hidden');
      const want = m === mode ? 'flex' : 'none';
      if (el.style.getPropertyValue('display') !== want) {
        el.style.setProperty('display', want, 'important');
        if (!isRemoteMode) {
          try {
            WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, attr: 'style', value: el.style.cssText });
          } catch { /* ignore */ }
        }
      }
    }
  }

  // ---- 会话交互卡片（问卷/游戏邀请等）跨切换保留 ----
  function sessionContainerEl(session) {
    if (!session) return null;
    if (session.mode === 'code') return document.getElementById('code-chat-messages');
    if (session.mode === 'babe') return document.getElementById('babe-chat-messages');
    return chatMessages;
  }

  // 会话激活后：把挂在离屏根节点上的交互卡片移回可见容器
  function flushSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    while (session.uiRoot.firstChild) {
      container.appendChild(session.uiRoot.firstChild);
    }
    requestAnimationFrame(() => {
      const last = container.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
    });
  }

  // 会话切走前：把属于该会话的交互卡片从可见容器收回离屏根节点
  function retractSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    const nodes = container.querySelectorAll(`[data-session-key="${cssEscape(session.key)}"]`);
    for (const node of nodes) session.uiRoot.appendChild(node);
  }

  // 创建交互卡片时使用：卡片挂到所属会话的离屏根节点，
  // 会话激活时立即冲入可见容器，保证后台会话的卡片不丢、不串到别的会话。
  function appendSessionCard(session, node) {
    if (!session || !node) return;
    node.dataset.sessionKey = session.key;
    session.uiRoot.appendChild(node);
    if (session.active) flushSessionUiRoot(session);
  }

  // 切回会话时重放后台期间缓冲的瞬时 UI 事件（文件呈递/命运牌/牌阵）
  function applyBufferedUiEvents(session) {
    if (!session || !Array.isArray(session.uiEvents) || !session.uiEvents.length) return;
    for (const ev of session.uiEvents) {
      try {
        if (ev.type === 'present-file' && typeof addFilePresentCard === 'function') {
          addFilePresentCard(ev.data);
        } else if (ev.type === 'tarot-spread' && typeof addTarotSpreadToChat === 'function') {
          addTarotSpreadToChat(ev.result);
        } else if (ev.type === 'tarot' && ev.data && agentTarot) {
          // 后台期间命运牌文本未写入聊天记录，这里以 UI-only 方式补渲染
          const data = ev.data;
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
          const entropyNote = isTRNG ? (_isZh ? ' [TRNG 硬件真随机]' : ' [TRNG Hardware Random]') : '';
          addSystemMessage(`${_isZh ? '抽取了命运之牌：' : 'Drew Tarot: '}${_cardName}(${position})${_isZh ? '（' : ' ('}${data.nameEn}${_isZh ? '）' : ')'}${entropyNote}\n${meaning || ''}`, { persist: false });
        }
      } catch { /* ignore */ }
    }
  }

  // 切回会话时同步发送/停止按钮与状态显示
  function syncSessionControls(mode, session) {
    const ag = session?.agent;
    if (mode === 'chat') {
      if (ag && ag.running) {
        if (typeof setSendButtons === 'function') setSendButtons(true);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中...';
          agentStatus.className = 'agent-status working';
        }
        if (typeof addThinkingIndicator === 'function' && !document.getElementById('thinking-indicator')) {
          addThinkingIndicator();
        }
      } else {
        if (typeof setSendButtons === 'function') setSendButtons(false);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
          agentStatus.className = 'agent-status';
        }
      }
      const att = session?.attention;
      if (att && agentStatus) {
        agentStatus.innerHTML = `<i class="fa-solid fa-circle"></i> ${escapeHtml(att.label || '等待处理')}`;
        agentStatus.className = 'agent-status working';
      }
      // 多会话镜像：同步状态栏与发送/停止按钮到 WebUI
      if (!isRemoteMode) {
        try {
          WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#agent-status', html: agentStatus.outerHTML });
          if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
          if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-send', attr: 'class', value: btnSend.className });
        } catch { /* ignore */ }
      }
    } else if (mode === 'code') {
      if (typeof refreshCodeStopButton === 'function') refreshCodeStopButton();
    } else if (mode === 'babe') {
      if (typeof refreshBabeStopButton === 'function') refreshBabeStopButton();
    }
  }

  /**
   * 批量关闭指定模式的会话。
   * - 若关闭后该模式没有剩余会话，立即新建一个（标签栏常驻，绝不出现空栏）；
   * - 若关闭的是当前激活会话，则自动激活剩余的第一个会话。
   */
  function closeSessionBatch(mode, keys) {
    if (!sessionManager || !keys || !keys.size) return;
    const targets = sessionManager.list(mode).filter(s => keys.has(s.key));
    if (!targets.length) return;
    const activeKey = sessionManager.getActive(mode)?.key || null;
    const runningCount = targets.filter(s => s.status === SessionStatus.RUNNING
      || s.status === SessionStatus.WAITING_APPROVAL
      || s.status === SessionStatus.WAITING_TOOL_AUTH).length;
    const noun = targets.length === 1
      ? `会话“${targets[0].title || '未命名'}”`
      : `${targets.length} 个会话`;
    if (runningCount > 0 && !window.confirm(`${noun}仍在运行，确定停止并关闭吗？`)) return;
    for (const session of targets) {
      sessionManager.stop(session);
      sessionManager.close(session);
    }
    renderAllSessionTabs();
    const remaining = sessionManager.ordered(mode);
    if (!remaining.length) {
      // 关闭最后一个标签页 → 打开一个新会话标签页
      createNewSession(mode).catch(e => console.error('[sessions] 新建会话失败:', e));
      return;
    }
    if (activeKey && keys.has(activeKey)) {
      activateSession(mode, remaining[0].key);
    }
  }

  function closeSession(session) {
    if (!session) return;
    closeSessionBatch(session.mode, new Set([session.key]));
  }

  // 标签页右键菜单：打开工作目录 / 批量关闭
  function showSessionTabContextMenu(e, mode, session) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.session-tab-menu').forEach(m => m.remove());
    const sessions = sessionManager.ordered(mode);
    const idx = sessions.findIndex(s => s.key === session.key);
    const workspacePath = session.agent?.codeWorkspacePath || session.agent?.workspacePath || '';
    const menu = document.createElement('div');
    menu.className = 'session-tab-menu';
    menu.style.cssText = [
      'position:fixed',
      `left:${e.clientX}px`,
      `top:${e.clientY}px`,
      'background:var(--bg-primary)',
      'border:1px solid var(--border)',
      'border-radius:8px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)',
      'padding:4px 0',
      'z-index:10001',
      'min-width:200px'
    ].join(';');

    const items = [
      {
        icon: 'fa-folder-open',
        label: '打开工作目录',
        disabled: !workspacePath,
        action: () => { if (workspacePath) window.api.openFileExplorer(workspacePath); }
      },
      {
        icon: 'fa-xmark',
        label: '关闭此标签页',
        action: () => closeSessionBatch(mode, new Set([session.key]))
      },
      {
        icon: 'fa-angles-left',
        label: '关闭左侧所有标签页',
        disabled: idx <= 0,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(0, idx).map(s => s.key)))
      },
      {
        icon: 'fa-angles-right',
        label: '关闭右侧所有标签页',
        disabled: idx >= sessions.length - 1,
        action: () => closeSessionBatch(mode, new Set(sessions.slice(idx + 1).map(s => s.key)))
      },
      {
        icon: 'fa-minus',
        label: '关闭其他标签页',
        disabled: sessions.length <= 1,
        action: () => closeSessionBatch(mode, new Set(sessions.filter(s => s.key !== session.key).map(s => s.key)))
      },
      {
        icon: 'fa-ban',
        label: '关闭所有标签页',
        danger: true,
        action: () => closeSessionBatch(mode, new Set(sessions.map(s => s.key)))
      }
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.style.cssText = [
        'padding:7px 14px',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'font-size:13px',
        'white-space:nowrap',
        'cursor:' + (item.disabled ? 'not-allowed' : 'pointer'),
        'color:' + (item.disabled ? 'var(--text-tertiary)' : (item.danger ? 'var(--danger)' : 'var(--text-primary)')),
        'opacity:' + (item.disabled ? '0.55' : '1'),
        'transition:background 0.15s'
      ].join(';');
      row.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px;font-size:12px"></i><span>${escapeHtml(item.label)}</span>`;
      if (!item.disabled) {
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', () => {
          menu.remove();
          item.action();
        });
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
        document.removeEventListener('contextmenu', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
      document.addEventListener('contextmenu', closeMenu);
    }, 0);
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
    // 切换会话标签页：中断语音播报及其队列（不残留上一个会话的声音；
    // 点击当前已激活的标签页不触发）
    const activeBefore = sessionManager.getActive(mode);
    if ((!activeBefore || activeBefore.key !== key) && typeof stopVoicePlayback === 'function') {
      stopVoicePlayback();
    }
    if (currentMode !== mode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
      if (modeBtn) modeBtn.click();
      // 等待模式切换完成后再激活目标会话
      setTimeout(() => activateSession(mode, key), 0);
      return;
    }
    sessionManager.activate(mode, key);
    try {
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
      // WebUI 上传目录跟随当前激活会话的工作目录，避免多会话时落到错误工作区
      const activeWs = session.agent && (session.agent.codeWorkspacePath || session.agent.workspacePath);
      if (activeWs && !isRemoteMode) {
        try { window.api.webControlSetWorkDir(activeWs); } catch { /* ignore */ }
      }
      // 恢复本会话的输入草稿
      const draftInput = mode === 'code'
        ? document.getElementById('code-chat-input')
        : mode === 'babe'
          ? document.getElementById('babe-chat-input')
          : chatInput;
      if (draftInput) {
        draftInput.value = session.draft || '';
        draftInput.style.height = 'auto';
      }
      // 重放后台期间缓冲的瞬时卡片（文件呈递/命运牌/牌阵）
      applyBufferedUiEvents(session);
      // 把问卷/游戏邀请等交互卡片移回可见容器
      flushSessionUiRoot(session);
      // 同步发送/停止按钮与状态显示
      syncSessionControls(mode, session);
      updateContextProgress();
    } catch (e) {
      // 会话内容回放失败不应阻断激活流程，保证标签栏与页面状态仍能刷新
      console.error('[sessions] activateSession replay error:', e);
    } finally {
      // 无论回放是否成功都刷新标签栏，避免切换会话时栏状态不更新/消失
      renderAllSessionTabs();
    }
  }

  await normalizeToolSettings();
  setTitlebarTitle(agent.conversationTitle || '未命名对话');
  updateReoptimizeButtonVisibility();
  updateContextProgress();
  // 初始化完成后渲染一次标签栏：单个会话也保持可见，避免启动后栏状态与后续行为不一致
  renderAllSessionTabs();
  showSessionTabsForMode(currentMode);

  // ---- 标签栏常驻兜底 ----
  // 无论是什么原因把标签栏隐藏/清空（远端镜像替换、页面切换竞态等），
  // 都自动恢复为可见并渲染当前会话。Remote 模式跳过（DOM 由远端驱动）。
  let _sessionTabsRepairPending = false;
  function repairSessionTabs() {
    if (_sessionTabsRepairPending) return;
    _sessionTabsRepairPending = true;
    requestAnimationFrame(() => {
      _sessionTabsRepairPending = false;
      if (typeof isRemoteMode !== 'undefined' && isRemoteMode) return;
      let host = document.getElementById('session-tabs-host');
      if (!host) {
        // 极端情况：宿主节点被整块移除 → 原地重建（含三根栏）
        const mc = document.getElementById('main-content');
        if (mc) {
          host = document.createElement('div');
          host.id = 'session-tabs-host';
          for (const m of ['chat', 'code', 'babe']) {
            const el = document.createElement('div');
            el.className = 'session-tabs';
            el.id = `${m}-session-tabs`;
            el.dataset.mode = m;
            host.appendChild(el);
          }
          mc.insertBefore(host, mc.firstChild);
        }
      }
      if (!host) return;
      showSessionTabsForMode(currentMode);
      if (host.classList.contains('hidden')) host.classList.remove('hidden');
      for (const mode of ['chat', 'code', 'babe']) {
        const el = document.getElementById(`${mode}-session-tabs`);
        if (!el) continue;
        const want = sessionManager ? sessionManager.list(mode).length : 0;
        const have = el.querySelectorAll('.session-tab').length;
        const hasAdd = !!el.querySelector('.session-tab-add');
        if (want !== have || !hasAdd) {
          try { renderSessionTabs(mode); } catch { /* ignore */ }
        }
      }
    });
  }
  if (typeof MutationObserver === 'function') {
    const _sessionTabsObserver = new MutationObserver(repairSessionTabs);
    _sessionTabsObserver.observe(document.getElementById('main-content') || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
  // 周期看门狗：无论什么原因（异常清空、替换、竞态）都每 1.5s 自愈一次
  setInterval(() => {
    try { repairSessionTabs(); } catch { /* ignore */ }
  }, 1500);
