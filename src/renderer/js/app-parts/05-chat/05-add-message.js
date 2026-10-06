  function addMessageToChat(role, content, attachments = []) {
    const messageId = typeof content === 'object' && content ? (content.metadata?.messageId || content.id) : '';
    if (content && typeof content === 'object') {
      const display = AttachmentData.presentation({ role, ...content });
      content = display.content; attachments = display.attachments;
    }
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    if (messageId) msg.dataset.messageId = messageId;
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

    renderMessageAttachments(msg.querySelector('.message-body'), attachments);
    // Add right-click context menu for deletion
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, msg, role);
    });
  }

  function renderMessageAttachments(body, attachments) {
    const files = AttachmentData.normalize(attachments);
    if (!body || !files.length) return;
    const container = document.createElement('div');
    container.className = 'message-attachments';
    for (const file of files) {
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'message-attachment-card';
      const extension = file.name.split('.').pop().slice(0, 8).toUpperCase();
      const size = file.size == null ? '' : file.size >= 1048576 ? (file.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(file.size / 1024)) + ' KB';
      card.innerHTML = `<span class="attachment-card-icon"><i class="fa-solid ${file.isImage ? 'fa-image' : 'fa-file-lines'}"></i></span><span class="attachment-card-copy"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml([extension, size].filter(Boolean).join(' · '))}</small></span><i class="fa-solid fa-arrow-down attachment-card-action"></i>`;
      card.disabled = !file.path;
      card.addEventListener('click', async () => {
        card.disabled = true;
        try {
          const result = await window.api.readFileBase64(file.path);
          if (!result?.ok || !result.data) throw new Error(result?.error || t('ui.attachment.unavailable', '附件已移动或无法读取'));
          if (file.isImage) openImageModal(result.data, { path: file.path });
          else { const anchor = document.createElement('a'); anchor.href = result.data; anchor.download = file.name; anchor.click(); }
        } catch (error) { showToast(error.message, 'error'); }
        finally { card.disabled = false; }
      });
      container.appendChild(card);
    }
    body.insertBefore(container, body.querySelector('.message-time, .babe-msg-time'));
  }

  // ---- Streaming message rendering ----
  // Creates a placeholder assistant bubble for a streaming response.
