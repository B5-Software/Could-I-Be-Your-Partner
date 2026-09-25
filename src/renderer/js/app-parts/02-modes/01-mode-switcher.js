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
