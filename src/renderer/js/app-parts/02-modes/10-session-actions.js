  const _activationTokens = { chat: 0, code: 0, babe: 0 };

  async function createNewSession(mode) {
    if (!sessionManager) return;
    if (mode === 'chat') {
      const ag = new Agent();
      ag.mode = 'chat';
      await ag.init();
      wireChatAgent(ag);
      const session = sessionManager.registerAgent('chat', ag, { title: ag.conversationTitle || '未命名会话' });
      await activateSession('chat', session.key, { force: true });
    } else if (mode === 'code') {
      await createCodeSession();
    } else if (mode === 'babe') {
      await createBabeSession();
    }
  }

  async function activateSession(mode, key, opts = {}) {
    if (!sessionManager) return;
    const session = sessionManager.get(key);
    if (!session || session.mode !== mode) return;
    const activeBefore = sessionManager.getActive(mode);
    const sameAlreadyActive =
      !opts.force &&
      currentMode === mode &&
      activeBefore &&
      activeBefore.key === key &&
      !session._replaying &&
      session._renderedOnce;
    if (sameAlreadyActive) {
      if (opts.navigate !== false && document.documentElement.dataset.frontend === 'v2') {
        navigatePage(mode);
      }
      syncSessionControls(mode, session);
      updateContextProgress();
      renderAllSessionTabs();
      return;
    }
    // 切换会话标签页：中断语音播报及其队列（不残留上一个会话的声音；
    // 点击当前已激活的标签页不触发）
    if ((!activeBefore || activeBefore.key !== key) && typeof stopVoicePlayback === 'function') {
      stopVoicePlayback();
    }
    if (currentMode !== mode) {
      window.__pendingModeTargetKey = { mode, key };
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
      if (modeBtn) modeBtn.click();
      return;
    }

    const token = ++_activationTokens[mode];
    const isStale = () => _activationTokens[mode] !== token;

    // 清理旧激活会话的流式/定时器引用
    if (mode === 'chat') {
      if (typeof clearChatStreamingBubbles === 'function') clearChatStreamingBubbles();
      if (typeof clearChatWorkTimer === 'function') clearChatWorkTimer();
      if (typeof clearSubAgentCards === 'function') clearSubAgentCards();
    } else if (mode === 'code') {
      if (typeof clearCodeStreamBubble === 'function') clearCodeStreamBubble();
    } else if (mode === 'babe') {
      if (typeof clearBabeStreamBubble === 'function') clearBabeStreamBubble();
    }

    // 开启回放栅栏：同步快照与 DOM 回放期间到达的实时事件先入队，不直接污染 DOM
    session._replaying = true;
    session._replayQueue = [];
    sessionManager.activate(mode, key);

    try {
      let view = null;
      let snapshotSeq = session.agent?._viewSeq || 0;
      if (window.CibypBackendViews && session.agent?.backendKey) {
        try {
          view = await window.CibypBackendViews.refreshView(session.agent);
          if (typeof view?.viewSeq === 'number') snapshotSeq = view.viewSeq;
        } catch (err) {
          console.warn('[sessions] refreshView failed, using local cache:', err?.message || err);
        }
        if (isStale()) return;
      }

      if (view?.session) {
        const backendStatus = view.session.status;
        if (view.session.busy) {
          session.status = SessionStatus.RUNNING;
          if (view.startedAt) session.startedAt = view.startedAt;
        } else if (backendStatus === 'error') {
          session.status = SessionStatus.ERROR;
          if (view.session.lastError) session.lastError = view.session.lastError;
        } else if (backendStatus === 'interrupted') {
          session.status = SessionStatus.INTERRUPTED;
        }
        if (view.pendingInteraction) {
          if (view.pendingInteraction.kind === 'approval') {
            session.status = SessionStatus.WAITING_APPROVAL;
            session.pendingApproval = view.pendingInteraction.payload;
          } else if (view.pendingInteraction.kind === 'tool-auth') {
            session.status = SessionStatus.WAITING_TOOL_AUTH;
            session.pendingToolAuth = view.pendingInteraction.payload;
          }
        }
      }

      let finished = true;
      if (mode === 'chat') {
        agent = session.agent;
        const conv = {
          id: agent.conversationId,
          title: agent.conversationTitle || session.title,
          messages: agent.contextManager?.getHistoryMessages() || [],
          subAgents: agent.subAgents || [],
          workspacePath: agent.workspacePath,
          usage: agent.sessionUsage,
          activeStream: agent._activeStream || null,
          unadmittedInput: agent._unadmittedInput || null,
        };
        finished = await rebuildChatUIFromHistory(conv, {
          cancelCheck: isStale,
          running: Boolean(agent.running),
          navigate: opts.navigate !== false,
        });
      } else if (mode === 'code') {
        codeAgent = session.agent;
        codeWorkspacePath = codeAgent.codeWorkspacePath || codeAgent.workspacePath || codeWorkspacePath;
        codeMessages = codeAgent.contextManager?.getHistoryMessages().slice() || [];
        finished = await replayCodeSession(session, { cancelCheck: isStale });
      } else if (mode === 'babe') {
        babeAgent = session.agent;
        babeMessages = babeAgent.contextManager?.getHistoryMessages().slice() || [];
        finished = await replayBabeSession(session, { cancelCheck: isStale });
      }
      if (!finished || isStale()) return;

      session._renderedOnce = true;

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

      // 解除栅栏并按序冲刷回放期间到达的增量事件（严格跳过已包含在快照内的旧 seq）
      const queued = session._replayQueue || [];
      session._replaying = false;
      session._replayQueue = [];
      if (queued.length && window.CibypBackendViews?.dispatchEvent) {
        for (const ev of queued) {
          if (isStale()) break;
          if (typeof ev.seq === 'number' && ev.seq <= snapshotSeq) continue;
          window.CibypBackendViews.dispatchEvent(session.agent, ev, { fromReplay: true });
        }
      }
      if (isStale()) return;

      // 同步发送/停止按钮与状态显示（在流式气泡与增量事件恢复之后执行，避免多余思考指示器）
      syncSessionControls(mode, session);
      updateContextProgress();
    } catch (e) {
      // 会话内容回放失败不应阻断激活流程，保证标签栏与页面状态仍能刷新
      console.error('[sessions] activateSession replay error:', e);
    } finally {
      session._replaying = false;
      session._replayQueue = [];
      // 无论回放是否成功都刷新标签栏，避免切换会话时栏状态不更新/消失
      renderAllSessionTabs();
    }
  }
