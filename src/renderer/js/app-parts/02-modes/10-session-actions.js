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
