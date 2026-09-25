  function addMessageToChat(role, content) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Avatar handling（Remote 模式优先使用远端头像）
    let avatarHTML = '';
    if (role === 'user') {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.user || '') : agent.settings?.userProfile?.avatar, false);
    } else {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.ai || '') : agent.settings?.aiPersona?.avatar, true);
    }

    const bodyClass = role === 'assistant' ? 'message-content markdown-body' : 'message-content';
    // 虚拟滚动优化：assistant 消息延迟渲染 markdown
    // - 批量加载模式（历史回放）：先占位，可见时再渲染
    // - 实时模式（新消息）：立即渲染（保持流式体验）
    if (role === 'assistant' && typeof VirtualScroller !== 'undefined' && VirtualScroller.observeMessage) {
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}"></div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
      // 注册到虚拟滚动器，原始内容存在 dataset 中，可见时才渲染
      VirtualScroller.observeMessage(msg, content);
    } else {
      // user 消息或无虚拟滚动器：直接渲染
      const rendered = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content);
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}">${rendered}</div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
    }

    // Add right-click context menu for deletion
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, msg, role);
    });
  }

  // ---- Streaming message rendering ----
  // Creates a placeholder assistant bubble for a streaming response.
