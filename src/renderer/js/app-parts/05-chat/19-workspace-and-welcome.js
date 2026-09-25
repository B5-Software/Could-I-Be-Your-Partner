  // ---- Open Workspace ----
  if (btnOpenWorkspace) {
    btnOpenWorkspace.addEventListener('click', async () => {
      if (agent.workspacePath) {
        await window.api.workspaceOpenInExplorer(agent.workspacePath);
      } else {
        const base = await window.api.workspaceGetBase();
        if (base.ok) await window.api.openFileExplorer(base.path);
      }
    });
  }

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
