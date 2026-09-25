  function showImageContextMenu(e, imageUrl) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.image-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'image-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 120px;
    `;

    const menuItems = [
      {
        icon: 'fa-magnifying-glass-plus',
        label: '预览',
        action: () => openImageModal(imageUrl, { path: localPathFromUrl(imageUrl) })
      },
      {
        icon: 'fa-copy',
        label: '复制图片',
        action: () => copyChatImage(imageUrl)
      },
      {
        icon: 'fa-floppy-disk',
        label: '另存为',
        action: () => saveChatImage(imageUrl)
      },
      {
        icon: 'fa-folder-open',
        label: '打开所在文件夹',
        action: () => openImageInFolder(imageUrl)
      }
    ];

    menuItems.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        transition: background 0.2s;
      `;
      menuItem.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px"></i><span>${item.label}</span>`;

      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = 'var(--bg-hover)';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });
      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  // 提取消息正文纯文本（排除推理过程、工具调用卡片、时间戳等）
  function getMessagePlainText(messageElement) {
    const body = messageElement && messageElement.querySelector('.message-body');
    const root = body || messageElement;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.reasoning-section, .tool-call, .message-time, .message-avatar, .msg-actions, .message-actions').forEach((n) => n.remove());
    let text = clone.innerText || '';
    text = text.replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '').replace(/<thinking[\s\S]*?<\/thinking>/gi, '');
    return text.trim();
  }

  // 右键菜单条目
  function makeMenuEntry(icon, label, color) {
    const item = document.createElement('div');
    item.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
      color: ${color || 'var(--text-primary)'};
    `;
    // 图标固定宽度并居中，保证不同图标下文字始终左对齐
    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${icon}`;
    iconEl.style.cssText = 'width: 20px; flex-shrink: 0; text-align: center; font-size: 13px;';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    item.append(iconEl, labelEl);
    item.addEventListener('mouseenter', () => {
      item.style.backgroundColor = 'var(--bg-hover)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.backgroundColor = 'transparent';
    });
    return item;
  }

  // 显示消息右键菜单
  function showMessageContextMenu(e, messageElement, role) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.message-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 160px;
    `;

    // 朗读：清空当前朗读队列并朗读本条消息
    const speakItem = makeMenuEntry('fa-volume-high', '朗读');
    speakItem.addEventListener('click', async () => {
      menu.remove();
      const text = getMessagePlainText(messageElement);
      if (!text) return;
      if (typeof window.VoiceUI !== 'object' || typeof window.VoiceUI.speakText !== 'function') return;
      const s = await window.api.getSettings();
      if (!s || (s.voice && s.voice.ttsEnabled === false)) {
        if (typeof window.showToast === 'function') window.showToast('TTS 未开启，请到语音设置开启后再朗读', 'error', 4000);
        return;
      }
      window.VoiceUI.speakText(text);
    });

    const menuItem = makeMenuEntry('fa-trash', '删除对话', '#e74c3c');

    menuItem.addEventListener('click', async () => {
      menu.remove();

      // 查找完整的对话轮次：user -> (system/tool-call)* -> assistant
      const allElements = Array.from(chatMessages.children);
      const currentIndex = allElements.indexOf(messageElement);

      if (currentIndex === -1) return;

      let userMsg = null;
      let assistantMsg = null;
      const middleElements = []; // system messages and tool calls

      if (role === 'user') {
        // 从 user 开始，向后找 assistant
        userMsg = messageElement;
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            // 遇到下一个 user，停止
            break;
          }
        }
      } else if (role === 'assistant') {
        // 从 assistant 开始，向前找 user
        assistantMsg = messageElement;
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            // 遇到上一个 assistant，停止
            break;
          }
        }
      } else {
        // 从 system/tool-call 开始，找前后的 user 和 assistant
        // 向前找 user
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            break;
          }
        }
        // 向后找 assistant
        middleElements.push(messageElement); // 当前元素
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            break;
          }
        }
      }

      if (!userMsg && !assistantMsg) return;

      const pending = [];
      if (userMsg) pending.push(userMsg);
      pending.push(...middleElements);
      if (assistantMsg) pending.push(assistantMsg);

      pending.forEach(el => el.classList.add('pending-delete'));

      // Confirm deletion
      const delParts = [];
      if (userMsg) delParts.push('用户消息');
      if (middleElements.length > 0) delParts.push('工具调用');
      if (assistantMsg) delParts.push('AI回复');
      let delDetail = '';
      if (delParts.length === 1) delDetail = '包括' + delParts[0];
      else if (delParts.length > 1) delDetail = '包括' + delParts.slice(0, -1).join('、') + '和' + delParts[delParts.length - 1];
      const confirmed = await window.confirmDialog(
        `确定要删除这轮对话吗？\n${delDetail}`,
        '删除对话'
      );

      if (confirmed) {
        pending.forEach(el => el.remove());
      } else {
        pending.forEach(el => el.classList.remove('pending-delete'));
      }
    });

    menu.append(speakItem, menuItem);
    document.body.appendChild(menu);

    const closeMenu = () => {
      if (menu && menu.parentNode) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  // ---- 图片预览灯箱：缩放 / 拖拽 / 下载 / 复制 / 打开位置 / Esc ----
