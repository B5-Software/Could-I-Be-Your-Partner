  // ---- Open Workspace ----
  if (btnOpenWorkspace) {
    btnOpenWorkspace.addEventListener('click', async () => {
      try {
      let result;
      if (agent.workspacePath) {
        result = await window.api.workspaceOpenInExplorer(agent.workspacePath);
      } else {
        const base = await window.api.workspaceGetBase();
        const directory = typeof base === 'string' ? base : base?.path;
        if (!directory) throw new Error(base?.error || t('ui.workspace.unavailable', '工作目录不可用'));
        result = await window.api.openFileExplorer(directory);
      }
      if (result?.ok === false) throw new Error(result.error);
      } catch (error) { showToast(error.message, 'error'); }
    });
  }

  const chooseChatWorkspace = document.getElementById('btn-choose-chat-workspace');
  async function selectChatWorkspace() {
    if (chooseChatWorkspace?.disabled) return;
    const target = sessionManager?.getActive('chat')?.agent || agent;
    if (chooseChatWorkspace) chooseChatWorkspace.disabled = true;
    try {
      await target._ensureBackend();
      const { request, hydrate } = window.CibypBackendViews;
      const key = target.backendKey;
      const view = await request('getView', key);
      if (view.session.busy) throw new Error(t('ui.workspace.chatBusy', '请先停止当前任务，再更换工作目录'));
      const picked = await window.api.openFileDialog({
        directory: true,
        hostDirectory: true,
        defaultPath: view.session.hostWorkspacePath ||
          (target.settings?.runtime?.location !== 'vm' ? view.session.workspacePath : undefined),
        title: t('ui.workspace.chooseChat', '选择 Chat 工作目录'),
      });
      if (!picked?.ok || !picked.paths?.[0]) {
        if (picked?.error) throw new Error(picked.error);
        return;
      }
      const result = await request('setWorkspace', key, picked.paths[0], { local: true });
      if (!result.ok) throw new Error(result.error);
      const updated = await request('getView', key);
      if (updated?.session && !target._backendClosed) hydrate(target, updated);
      window.CibypFrontendShell?.refresh();
      showToast(t('ui.workspace.chatSelected', '当前 Chat 工作目录已设为 {path}', {
        path: result.hostPath || result.workspacePath,
      }), 'success');
    } finally {
      if (chooseChatWorkspace) chooseChatWorkspace.disabled = false;
    }
  }
  chooseChatWorkspace?.addEventListener('click', () => {
    void selectChatWorkspace().catch(error => showToast(error.message, 'error'));
  });

  // 统一的 Chat 欢迎消息渲染：根据生图模型配置决定是否显示"生成图片"按钮
  function renderChatWelcome() {
    const imgConfigured = !!(agent.settings?.imageGen?.apiUrl && agent.settings?.imageGen?.model);
    const imgBtn = imgConfigured
      ? `<button class="quick-action-btn" data-prompt="帮我生成一张风景图片"><i class="fa-solid fa-image"></i> 生成图片</button>`
      : '';
    chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <h2>你好，我是你的AI伙伴</h2>
        <p>我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索${imgConfigured ? '、图像生成' : ''}等。告诉我你需要什么帮助吧！</p>
        <div class="quick-actions">
          <button class="quick-action-btn" data-prompt="帮我搜索一下最新的科技新闻"><i class="fa-solid fa-magnifying-glass"></i> 搜索新闻</button>
          ${imgBtn}
          <button class="quick-action-btn" data-prompt="帮我创建一个待办事项列表"><i class="fa-solid fa-list-check"></i> 待办事项</button>
          <button class="quick-action-btn" data-prompt="帮我写一段JavaScript代码"><i class="fa-solid fa-code"></i> 编写代码</button>
        </div>
      </div>`;
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => { chatInput.value = btn.dataset.prompt; sendMessage(); });
    });
    // 增量推送：替换聊天容器内容为欢迎页
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#chat-messages', html: chatMessages.innerHTML });
  }

  // New chat
  btnNewChat.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'newChat' }));
      setTitlebarTitle('未命名对话');
      clearChatMessagesUI();
      renderChatWelcome();
      return;
    }
    createNewSession('chat');
  });
