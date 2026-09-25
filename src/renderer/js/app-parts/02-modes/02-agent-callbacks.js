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
        // 工具组弹窗若打开，同步刷新高亮（当前优化集合变化）
        if (typeof currentToolModalCategory !== 'undefined' && currentToolModalCategory
            && document.getElementById('tools-group-modal')?.classList.contains('open')) {
          renderToolGroupModal(currentToolModalCategory);
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
        addImageMessage(result.url, { path: result.path });
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
