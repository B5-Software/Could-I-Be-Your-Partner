  // ---- History Page ----
  async function loadHistoryPage() {
    const list = document.getElementById('history-list');
    if (!list) return;

    // Remote 模式：通过 WS 拉取远端历史，继续/删除均转发到远端
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载远程历史…</p></div>';
      try {
        const resp = await remoteWsRequest({ type: 'getHistory' }, 'history', 8000);
        const histories = resp.history || [];
        if (!histories || histories.length === 0) {
          list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>远端暂无对话历史</p></div>';
          return;
        }
        list.innerHTML = histories.map(h => {
          let timeStr = '未知时间';
          const ts = h.timestamp ? (typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp))
            : (h.createdAt ? (typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt)) : null);
          if (ts && !isNaN(ts)) timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `
          <div class="history-item" data-id="${escapeHtml(h.id)}">
            <div class="history-info">
            <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(h.status || 'idle', null)}</div>
              <div class="history-time">${timeStr}</div>
            </div>
            <div class="history-actions">
              <button class="btn-icon history-continue" data-id="${escapeHtml(h.id)}" title="继续对话"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon history-delete" data-id="${escapeHtml(h.id)}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`;
        }).join('');
        list.querySelectorAll('.history-continue').forEach(btn => {
          btn.addEventListener('click', () => {
            if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return;
            remoteWs.send(JSON.stringify({ type: 'loadConversation', id: btn.dataset.id }));
            // 高亮当前项；远端加载后会推送 messagesSync
            list.querySelectorAll('.history-item').forEach(el => el.classList.toggle('active', el.dataset.id === btn.dataset.id));
            // 切换到对话页
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById('page-chat')?.classList.add('active');
            clearChatMessagesUI();
            addThinkingIndicator();
          });
        });
        list.querySelectorAll('.history-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('确认删除此远端对话？')) return;
            try {
              await remoteWsRequest({ type: 'deleteConversation', id: btn.dataset.id }, 'conversationDeleted', 8000);
            } catch (e) { /* 忽略，仍刷新列表 */ }
            loadHistoryPage();
          });
        });
      } catch (e) {
        list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>加载远程历史失败: ${escapeHtml(e.message || '')}</p></div>`;
      }
      return;
    }

    // 本地模式：优先走虚拟滚动 + 搜索 + 事件委托；下方旧的全量渲染保留为回退
    if (typeof HistoryList !== 'undefined') {
      await loadHistoryPageVirtual();
      return;
    }

    const histories = await window.api.historyList();
    if (!histories || histories.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无对话历史</p></div>';
      return;
    }
    list.innerHTML = histories.map(h => {
      let timeStr = '未知时间';
      if (h.timestamp) {
        const ts = typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      } else if (h.createdAt) {
        const ts = typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt);
        if (!isNaN(ts)) {
          timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
      }
      const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
      return `
      <div class="history-item" data-id="${h.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(live ? live.status : h.status, live ? live.lastError : h.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon history-continue" data-id="${h.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon history-open-workspace" data-id="${h.id}" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon history-export-json" data-id="${h.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon history-export-md" data-id="${h.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon history-delete" data-id="${h.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>
      `;
    }).join('');

    const sanitizeFileName = (name) => (name || '对话记录').replace(/[\\/:*?"<>|]/g, '_');
    const buildMarkdown = (conv) => {
      const title = conv.title || '未命名对话';
      const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
      const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString('zh-CN') : '';
      const lines = [];
      lines.push(`# ${title}`);
      lines.push('');
      if (createdAt) lines.push(`- 创建时间：${createdAt}`);
      if (updatedAt) lines.push(`- 更新时间：${updatedAt}`);
      if (conv.workspacePath) lines.push(`- 工作目录：${conv.workspacePath}`);
      lines.push('');

      (conv.messages || []).forEach(msg => {
        const role = msg.role || 'assistant';
        const roleName = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : role === 'system' ? '系统' : '工具';
        lines.push(`## ${roleName}`);
        if (role === 'tool') {
          let toolContent = msg.content;
          try { toolContent = JSON.stringify(JSON.parse(msg.content), null, 2); } catch {}
          lines.push('```json');
          lines.push(toolContent || '');
          lines.push('```');
        } else {
          lines.push(msg.content || '');
        }
        lines.push('');
      });
      return lines.join('\n');
    };

    list.querySelectorAll('.history-continue').forEach(btn => {
      btn.addEventListener('click', async () => {
        stopVoicePlayback(); // 切换会话前清空语音播放队列
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv) {
          const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
          if (existing) {
            agent = existing.agent;
            activateSession('chat', existing.key);
          } else {
            const ag = new Agent();
            ag.mode = 'chat';
            await ag.init();
            await ag.loadFromHistory(conv);
            wireChatAgent(ag);
            const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
            agent = ag;
            activateSession('chat', target.key);
          }
          setTitlebarTitle(agent.conversationTitle || '未命名对话');
          updateContextProgress();
          // Switch to chat page
          document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
          document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
          document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
          document.getElementById('page-chat')?.classList.add('active');
          // Replay messages（异步分块渲染 + 进度模态框，避免长历史阻塞/卡死）
          chatMessages.innerHTML = '';
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
          WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
          WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
          // 递增 generation：取消任何进行中的历史回放，防止新旧会话消息交错
          const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
          await replayHistoryMessages(conv.messages || [], {
            cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
          });
          // 批量加载结束：触发首屏渲染（仅渲染可视区域内的消息）
          if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
          requestAnimationFrame(() => {
            const last = chatMessages.lastElementChild;
            if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
          });
        }
      });
    });

    list.querySelectorAll('.history-open-workspace').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (conv?.workspacePath) {
          window.api.openFileExplorer(conv.workspacePath);
        } else {
          alert('该对话没有记录工作目录');
        }
      });
    });

    list.querySelectorAll('.history-export-json').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.json`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(JSON)',
          defaultPath: filename,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!result.ok || !result.path) return;
        const content = JSON.stringify(conv, null, 2);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-export-md').forEach(btn => {
      btn.addEventListener('click', async () => {
        const conv = await window.api.historyGet(btn.dataset.id);
        if (!conv) return;
        const filename = `${sanitizeFileName(conv.title || '对话记录')}.md`;
        const result = await window.api.saveFileDialog({
          title: '导出对话记录(Markdown)',
          defaultPath: filename,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        if (!result.ok || !result.path) return;
        const content = buildMarkdown(conv);
        const saveResult = await window.api.writeFile(result.path, content);
        if (saveResult.ok) {
          showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
        } else {
          showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
        }
      });
    });

    list.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        // 对齐 Babe 模式：删除历史记录前二次确认，防止误删
        const conv = await window.api.historyGet(btn.dataset.id).catch(() => null);
        const titleForConfirm = conv?.title || '此对话';
        const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
        if (!confirmed) return;
        await window.api.historyDelete(btn.dataset.id);
        if (agent.conversationId === btn.dataset.id) {
          agent.newConversation();
          clearChatMessagesUI();
          setTitlebarTitle('未命名对话');
        }
        loadHistoryPage();
      });
    });
    // 增量推送：替换历史列表内容
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#history-list', html: list.innerHTML });
  }

  // ============ 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let historyRawItems = [];
  let historySearch = null;

  function formatHistoryTime(h) {
    let timeStr = '未知时间';
    const ts = h.timestamp ? (typeof h.timestamp === 'number' ? h.timestamp : Date.parse(h.timestamp))
      : (h.updatedAt ? (typeof h.updatedAt === 'number' ? h.updatedAt : Date.parse(h.updatedAt)) : null)
      || (h.createdAt ? (typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt)) : null);
    if (ts && !isNaN(ts)) {
      timeStr = new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    return timeStr;
  }

  function ensureHistoryListAttached() {
    const list = document.getElementById('history-list');
    if (!list || typeof HistoryList === 'undefined') return false;
    if (!list.dataset.hlAttached) {
      list.dataset.hlAttached = '1';
      HistoryList.attach(list, {
        renderItem: renderHistoryItem,
        onAction: handleHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无对话历史</p></div>',
        stride: 78,
        overscan: 8
      });
      historySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'history',
        inputId: 'history-search-input',
        countId: 'history-search-count',
        listId: 'history-list',
        searchMode: 'chat',
        getRawItems: () => historyRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderHistoryItem,
        renderContentItem: renderHistoryContentItem,
        onAction: handleHistoryAction,
        restoreItems: () => HistoryList.setItems(list, historyRawItems)
      }) : null;
    }
    return true;
  }

  function renderHistoryItem(h) {
    const timeStr = formatHistoryTime(h);
    const countText = h.messageCount ? ` · ${h.messageCount} 条消息` : '';
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
    const status = live ? live.status : h.status;
    const attention = live ? live.attention : null;
    const lastError = live ? live.lastError : h.lastError;
    return `
      <div class="history-item" data-id="${escapeHtml(h.id)}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(status, lastError, attention)}</div>
          <div class="history-time">${timeStr}${countText}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="open-workspace" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderHistoryContentItem(h) {
    const timeStr = formatHistoryTime(h);
    const countText = h.messageCount ? ` · ${h.messageCount} 条消息` : '';
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
    const snippets = Array.isArray(h.snippets) ? h.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (h.snippetTotal && h.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${h.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${escapeHtml(h.id)}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(live ? live.status : h.status, live ? live.lastError : h.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr}${countText}</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="open-workspace" title="打开工作目录"><i class="fa-solid fa-folder-open"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function sanitizeHistoryFileName(name) {
    return (name || '对话记录').replace(/[\\/:*?"<>|]/g, '_');
  }

  function buildHistoryMarkdown(conv) {
    const title = conv.title || '未命名对话';
    const createdAt = conv.createdAt ? new Date(conv.createdAt).toLocaleString('zh-CN') : '';
    const updatedAt = conv.updatedAt ? new Date(conv.updatedAt).toLocaleString('zh-CN') : '';
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    if (createdAt) lines.push(`- 创建时间：${createdAt}`);
    if (updatedAt) lines.push(`- 更新时间：${updatedAt}`);
    if (conv.workspacePath) lines.push(`- 工作目录：${conv.workspacePath}`);
    lines.push('');
    (conv.messages || []).forEach(msg => {
      const role = msg.role || 'assistant';
      const roleName = role === 'user' ? '用户' : role === 'assistant' ? 'AI' : role === 'system' ? '系统' : '工具';
      lines.push(`## ${roleName}`);
      if (role === 'tool') {
        let toolContent = msg.content;
        try { toolContent = JSON.stringify(JSON.parse(msg.content), null, 2); } catch {}
        lines.push('```json');
        lines.push(toolContent || '');
        lines.push('```');
      } else {
        lines.push(msg.content || '');
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  /**
   * 共享的对话导出实现（Chat / Code / Babe 历史与 /export 命令共用）：
   * 原生保存对话框 + 与 Chat 历史一致的 JSON / Markdown 格式。
   * @returns {Promise<string|null>} 成功返回保存路径；用户取消/失败返回 null
   */
  async function exportConversationToFile(conv, format) {
    if (!conv) return null;
    const isJson = format === 'json';
    const filename = `${sanitizeHistoryFileName(conv.title || '对话记录')}.${isJson ? 'json' : 'md'}`;
    const result = await window.api.saveFileDialog({
      title: isJson ? '导出对话记录(JSON)' : '导出对话记录(Markdown)',
      defaultPath: filename,
      filters: isJson ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (!result.ok || !result.path) return null;
    const content = isJson ? JSON.stringify(conv, null, 2) : buildHistoryMarkdown(conv);
    const saveResult = await window.api.writeFile(result.path, content);
    if (saveResult.ok) {
      if (typeof window.showMessageModal === 'function') {
        window.showMessageModal(`已导出：${result.path}`, '导出成功', 'success');
      }
      return result.path;
    }
    if (typeof window.showMessageModal === 'function') {
      window.showMessageModal(`导出失败：${saveResult.error || '未知错误'}`, '导出失败', 'error');
    }
    return null;
  }

  async function handleHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;

    if (action === 'continue') {
      stopVoicePlayback();
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      const existing = sessionManager ? sessionManager.list('chat').find(s => String(s.id) === String(conv.id)) : null;
      if (existing) {
        agent = existing.agent;
        activateSession('chat', existing.key);
      } else {
        const ag = new Agent();
        ag.mode = 'chat';
        await ag.init();
        await ag.loadFromHistory(conv);
        wireChatAgent(ag);
        const target = sessionManager.registerAgent('chat', ag, { id: conv.id, title: conv.title || '未命名对话' });
        agent = ag;
        activateSession('chat', target.key);
      }
      setTitlebarTitle(agent.conversationTitle || '未命名对话');
      updateContextProgress();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById('page-chat')?.classList.add('active');
      chatMessages.innerHTML = '';
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
      WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
      WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
      const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
      await replayHistoryMessages(conv.messages || [], {
        cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
      });
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
      requestAnimationFrame(() => {
        const last = chatMessages.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    } else if (action === 'open-workspace') {
      const conv = await window.api.historyGet(id);
      if (conv?.workspacePath) {
        window.api.openFileExplorer(conv.workspacePath);
      } else {
        alert('该对话没有记录工作目录');
      }
    } else if (action === 'export-json' || action === 'export-md') {
      const conv = await window.api.historyGet(id);
      if (!conv) return;
      await exportConversationToFile(conv, action === 'export-json' ? 'json' : 'md');
    } else if (action === 'delete') {
      const conv = await window.api.historyGet(id).catch(() => null);
      const titleForConfirm = conv?.title || '此对话';
      const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
      if (!confirmed) return;
      await window.api.historyDelete(id);
      if (agent.conversationId === id) {
        agent.newConversation();
        clearChatMessagesUI();
        setTitlebarTitle('未命名对话');
      }
      loadHistoryPage();
    }
  }

  async function loadHistoryPageVirtual() {
    const list = document.getElementById('history-list');
    if (!list) return;
    ensureHistoryListAttached();
    HistoryList.showMessage(list, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载历史…</p></div>');
    try {
      const histories = await window.api.historyList();
      historyRawItems = Array.isArray(histories) ? histories : [];
      if (historySearch) historySearch.refresh();
      else HistoryList.setItems(list, historyRawItems);
      // 推送完整页面快照前展开虚拟列表，避免 WebUI 只看到当前窗口
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(list, `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message || '')}</p></div>`);
    }
  }

  // ---- Init AI Persona Display ----
  async function initPersonaDisplay() {
    const s = await window.api.getSettings();
    // i18n: initialize language from saved settings before any UI rendering
    if (typeof i18nInit === 'function') {
      i18nInit(s.language || 'zh-CN');
      i18nApplyToDOM();
      // Re-apply after a delay to catch dynamically rendered content
      setTimeout(() => i18nApplyToDOM(), 500);
      setTimeout(() => i18nApplyToDOM(), 1500);
    }
    // Update mode switcher labels based on language
    updateModeLabels(s.language || 'zh-CN');
    // 头像框系统：启动时加载 avatarFrame 状态并预加载 SVG 缓存
    if (s.aiPersona?.avatarFrame) {
      _avatarFrameState.ai = s.aiPersona.avatarFrame;
      await loadAvatarFrameSVG(s.aiPersona.avatarFrame);
    }
    if (s.userProfile?.avatarFrame) {
      _avatarFrameState.user = s.userProfile.avatarFrame;
      await loadAvatarFrameSVG(s.userProfile.avatarFrame);
    }
    if (s.babe?.avatarFrame) {
      _avatarFrameState.babe = s.babe.avatarFrame;
      await loadAvatarFrameSVG(s.babe.avatarFrame);
    }
    if (s.aiPersona) updatePersonaDisplay(s.aiPersona);
    // 启动时立即读取命运之牌可见性设置项并应用，避免未读设置导致 UI 不一致
    applyTarotVisibility(s.tarotVisible !== false);
    // 启动 Babe 主动消息定时器（即使用户未进入 Babe 模式，主动消息也应按时触发）
    restartBabeProactiveTimer(s.babe?.proactiveInterval);
  }

  // Update mode switcher button labels based on language
  function updateModeLabels(lang) {
    document.querySelectorAll('.mode-label').forEach(el => {
      const val = el.getAttribute('data-' + (lang || 'zh-CN')) || el.getAttribute('data-zh') || 'Chat';
      el.textContent = val;
    });
  }

  // ---- History 加载进度模态框（非阻塞解析大历史记录） ----
  // 大历史记录回放时逐批渲染，每批之间让出事件循环（yield），
  // 模态框实时显示进度，避免渲染器长时间阻塞卡死。
  function showHistoryProgress(total) {
    const modal = document.getElementById('history-progress-modal');
    if (!modal) return;
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    if (fill) fill.style.width = '0%';
    if (count) count.textContent = `0 / ${total}`;
    if (text) text.textContent = '正在解析历史记录…';
    modal.classList.remove('hidden');
  }

  function updateHistoryProgress(done, total, label) {
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
    if (fill) fill.style.width = pct + '%';
    if (count) count.textContent = `${done} / ${total}`;
    if (text && label) text.textContent = label;
  }

  function hideHistoryProgress() {
    const modal = document.getElementById('history-progress-modal');
    fadeOutHide(modal);
  }

  // 让出事件循环一帧（macrotask），使进度模态框能刷新、DOM 能回流
  function yieldHistoryUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // 分块异步回放历史消息：每块处理完 yield 一次并刷新进度条。
  // 返回 true 表示正常完成；返回 false 表示中途被取消（本次会话已切换）。
  async function replayHistoryMessages(messages, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const total = list.length;
    const chunkSize = opts.chunkSize || 40; // 每批处理 40 条，避免长任务阻塞
    const cancelCheck = opts.cancelCheck || null; // 可选取消检查函数
    const toolCallMap = {};
    if (total > 0) showHistoryProgress(total);
    let done = 0;
    try {
      for (let start = 0; start < total; start += chunkSize) {
        // 每个 chunk 前检查是否被取消（用户切换会话/清空）
        if (cancelCheck && cancelCheck()) return false;
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = list[i];
          if (!msg) continue;
          if (msg.role === 'user') {
            addMessageToChat('user', extractTextContent(msg.content));
          } else if (msg.role === 'assistant') {
            if (msg.content) addMessageToChat('assistant', extractTextContent(msg.content));
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                addToolCallToChat(displayName, toolName, args, tc.id);
                if (tc.id) toolCallMap[tc.id] = toolName;
              }
            }
          } else if (msg.role === 'tool') {
            const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
            // 兼容旧版多模态 tool 消息 content 为数组的情况：提取文本，避免显示 [object Object]
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            try { result = JSON.parse(result); } catch {}
            updateToolCallResult(toolName, result, false, msg.tool_call_id);
          } else if (msg.role === 'system') {
            // 回放历史时显示系统消息（不重复持久化）
            addSystemMessage(msg.content, { persist: false });
          }
          done++;
        }
        // 每个 chunk 处理完都刷新进度，并让出事件循环（使模态框能更新、DOM 能回流）
        const isLast = end >= total;
        updateHistoryProgress(done, total, isLast ? '渲染完成，正在收尾…' : `已渲染 ${done}/${total} 条消息`);
        await yieldHistoryUI();
      }
      return true;
    } finally {
      hideHistoryProgress();
    }
  }

  // 从历史会话重建 Chat UI（供 pending-resume 和其他场景使用）
  // 注意：调用方应已调用 agent.loadFromHistory(conv) 同步状态
  function rebuildChatUIFromHistory(conv) {
    setTitlebarTitle(agent.conversationTitle || conv?.title || '未命名对话');
    updateContextProgress();
    // 切换到 chat 页
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector('.nav-item[data-page="chat"]')?.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-chat')?.classList.add('active');
    // 清空并回放消息（异步分块渲染，避免长历史阻塞渲染器）
    chatMessages.innerHTML = '';
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
    if (typeof WebUIMirror !== 'undefined' && WebUIMirror.pushDomEvent) {
      WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
      WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
    }
    // 分块异步回放，不阻塞渲染器；完成后触发首屏渲染与滚动
    // 每次启动回放递增 generation；其他入口（新会话/切换）也会递增以取消进行中的回放
    const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
    replayHistoryMessages(conv?.messages || [], {
      cancelCheck: () => window.__chatReplayGeneration !== chatGeneration
    }).then(finished => {
      if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();
      if (!finished) return;
      // 重建子代理卡片：子代理聊天记录已持久化到历史，
      // 恢复会话后仍可打开详情模态框查看完整对话。
      if (conv?.subAgents && Array.isArray(conv.subAgents) && conv.subAgents.length > 0) {
        for (const rec of conv.subAgents) {
          if (!rec || !rec.id) continue;
          addSubAgentCard({
            id: rec.id,
            title: rec.task ? `子代理：${String(rec.task).slice(0, 20)}` : '子代理',
            task: rec.task || '',
            startTime: rec.startTime || Date.now(),
            status: rec.status || 'done'
          });
          updateSubAgentCard(rec.id, {
            status: rec.status || 'done',
            duration: (rec.endTime && rec.startTime) ? (rec.endTime - rec.startTime) : 0,
            toolUseCount: rec.toolUseCount || 0,
            usage: rec.usage || {},
            result: rec.result || ''
          });
        }
      }
      requestAnimationFrame(() => {
        const last = chatMessages.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    });
  }

  // Listen for language changes to update mode labels
  window.addEventListener('languagechange', (e) => {
    updateModeLabels(e.detail.lang);
  });

  initPersonaDisplay();

  // ---- GeoGebra Side Panel ----
  let ggbApplet = null;
  let ggbInitialized = false;
  let ggbInitPromise = null;
  let ggbLastError = null; // { message, ts }
  let ggbCurrentConfig = null; // { key, appName, perspective, enableCAS, enable3D }
  let ggbResizeObserver = null;
  const ggbPanel = document.getElementById('geogebra-panel');
  const btnCloseGgb = document.getElementById('btn-close-geogebra');

  // 完整离线：官方 Math Apps Bundle 的 web3d 编译产物经主进程 ggb:// 协议从本地加载。
  // 官方文档推荐形如 applet.setHTML5Codebase('GeoGebra/HTML5/5.0/web3d/')，此处等价替换为
  // ggb://app/...（协议根即 GeoGebra/HTML5/5.0）。不再访问 www.geogebra.org。
  const GGB_OFFLINE_CODEBASE = 'ggb://app/GeoGebra/HTML5/5.0/web3d/';
  const GGB_APPS = ['classic', 'graphing', 'geometry', '3d', 'cas', 'scientific', 'notes', 'evaluator', 'suite', 'probability'];
  const ggbConfigKey = (o) => {
    const appName = String((o && o.appName) || 'classic').toLowerCase();
    return [appName, (o && o.perspective) || '', (o && o.enableCAS) ? 'cas' : '', (o && o.enable3D) ? '3d' : ''].join('|');
  };

  // 异步初始化：返回 Promise，在 appletOnLoad 触发后 resolve。
  // options: { appName, perspective, enableCAS, enable3D }。appName 改变时销毁旧 applet 重建。
  window.initGeoGebra = function(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const appName = String(opts.appName || 'classic').toLowerCase();
    if (!GGB_APPS.includes(appName)) {
      return Promise.resolve({ ok: false, error: `未知 GeoGebra 应用类型: ${appName}（可选: ${GGB_APPS.join('/')}）`, ready: false });
    }
    const key = ggbConfigKey(opts);

    // 已初始化且配置一致 → 直接显示面板
    if (ggbInitialized && ggbApplet && ggbCurrentConfig && ggbCurrentConfig.key === key) {
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
      return Promise.resolve({ ok: true, message: 'GeoGebra已显示', ready: true, appName });
    }
    // 正在进行中的初始化：配置一致则复用其结果；否则等完成后按新配置重建
    if (ggbInitPromise) {
      return ggbInitPromise.then((r) => {
        if (r && r.ok && ggbCurrentConfig && ggbCurrentConfig.key === key) {
          ggbPanel.classList.remove('hidden');
          document.body.classList.add('geogebra-open');
          return { ...r, ready: true, appName };
        }
        return window.initGeoGebra(opts);
      });
    }
    // 配置切换：销毁旧 applet（GGB HTML5 无官方 remove()，清空容器并复位全局单例）
    if (ggbInitialized || ggbApplet) {
      try {
        if (ggbResizeObserver && typeof ggbResizeObserver.disconnect === 'function') ggbResizeObserver.disconnect();
      } catch (_) {}
      ggbResizeObserver = null;
      // 官方 applet 对象有 remove()（deployggb 的 removeExistingApplet 即依赖它），
      // 先优雅卸载旧实例（停止其渲染循环/事件），再清空容器，避免新旧实例并存引发卡死。
      try {
        if (ggbApplet && typeof ggbApplet.remove === 'function') ggbApplet.remove();
      } catch (_) {}
      ggbInitialized = false;
      ggbApplet = null;
      try { window.ggbApplet = null; } catch (_) {}
      ggbLastError = null;
      ggbCurrentConfig = null;
      const oldHost = document.getElementById('ggb-element');
      if (oldHost) oldHost.innerHTML = '';
    }

    ggbInitPromise = new Promise((resolve) => {
      const timeoutMs = 30000; // 30s 超时（本地加载 web3d 全模块 + deferredjs 分片）
      const timer = setTimeout(() => {
        if (!ggbInitialized) {
          ggbInitPromise = null;
          resolve({ ok: false, error: 'GeoGebra 加载超时（30s），请确认离线包 assets/geogebra-app 已完整下载', ready: false });
        }
      }, timeoutMs);

      // 关键：先显示面板并等待布局完成，读取 host 实际像素尺寸，
      // 再用具体像素值传给 GGB params（而非 '100%'）。
      // GGB inject 时会把 '100%' 解析为 host clientWidth/Height，若此时为 0（flex 布局未完成）就固化为 0×0，
      // 后续 setSize 也救不回来（GGB 内部 canvas 已按 0×0 创建）。
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');

      // 用 requestAnimationFrame ×2 确保布局完成（一帧可能不够，flex 有时需要两帧）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ggbHost = document.getElementById('ggb-element');
          const hostWidth = Math.max(100, ggbHost ? ggbHost.clientWidth : 480);
          const hostHeight = Math.max(100, ggbHost ? ggbHost.clientHeight : 600);

          // classic 在窄侧边栏（宽<高）会触发 GGT portrait 竖排（图形/代数上下各半），
          // 用 perspective 'AG' 在 init 时指定左右并排：铺满无白边、保留代数视图与输入栏、
          // 屏幕键盘保持挂载式随点击弹出。调用方显式传 perspective 可覆盖。
          const appPerspective = opts.perspective || (appName === 'classic' ? 'AG' : '');
          const params = {
            appName: appName,
            width: hostWidth,   // 用具体像素值，不用 '100%'
            height: hostHeight,
            showToolBar: true,
            showAlgebraInput: true,
            showMenuBar: false,
            showAppsPicker: false,
            showKeyboard: false,
            enableRightClick: false,
            enableShiftDragZoom: true,
            showResetIcon: true,
            appletOnLoad: function() {
              clearTimeout(timer);
              ggbApplet = window.ggbApplet;
              ggbInitialized = true;
              ggbCurrentConfig = { key, appName, perspective: opts.perspective || null, enableCAS: !!opts.enableCAS, enable3D: !!opts.enable3D };
              // 成功后必须清空 ggbInitPromise：否则再次 init（尤其切换 appName）会沿已 settle 的
              // promise 无限微任务递归，渲染器主线程被饿死（表现为"卡死"）。
              ggbInitPromise = null;
              // 加载后应用视角/CAS/3D 配置（仅在显式给出布尔值时才调用，避免误关 classic 默认能力）
              try {
                if (typeof opts.enableCAS === 'boolean' && typeof ggbApplet.enableCAS === 'function') ggbApplet.enableCAS(opts.enableCAS);
              } catch (_) {}
              try {
                if (typeof opts.enable3D === 'boolean' && typeof ggbApplet.enable3D === 'function') ggbApplet.enable3D(opts.enable3D);
              } catch (_) {}
              try {
                if (opts.perspective && typeof ggbApplet.setPerspective === 'function') ggbApplet.setPerspective(String(opts.perspective));
              } catch (_) {}
              // 注册错误监听器：GGB 命令失败时会回调
              try {
                if (ggbApplet && typeof ggbApplet.setErrorListener === 'function') {
                  ggbApplet.setErrorListener(function(msg) {
                    ggbLastError = { message: String(msg || 'GeoGebra 命令错误'), ts: Date.now() };
                  });
                }
                if (ggbApplet && typeof ggbApplet.setClientListener === 'function') {
                  ggbApplet.setClientListener(function(_applet, type, args) {
                    if (type === 'error' || (Array.isArray(args) && args && args[0] === 'ERROR')) {
                      ggbLastError = { message: String((args && args[1]) || 'GeoGebra 错误'), ts: Date.now() };
                    }
                  });
                }
              } catch (e) { /* 监听器注册失败忽略 */ }
              console.log('GeoGebra loaded');
              // 注册 ResizeObserver：GGB 不会自动跟随 host 尺寸变化，需手动 setSize
              try {
                const roHost = document.getElementById('ggb-element');
                if (roHost && typeof ResizeObserver === 'function') {
                  ggbResizeObserver = new ResizeObserver(() => {
                    if (ggbApplet && typeof ggbApplet.setSize === 'function') {
                      const w = Math.max(50, roHost.clientWidth);
                      const h = Math.max(50, roHost.clientHeight);
                      try { ggbApplet.setSize(w, h); } catch (_) { /* 忽略尺寸更新异常 */ }
                    }
                  });
                  ggbResizeObserver.observe(roHost);
                }
              } catch (_) { /* ResizeObserver 不可用 */ }
              // 梯度延迟 setSize：覆盖 GGB 内部布局完成的各个时间点
              const forceResize = () => {
                const fh = document.getElementById('ggb-element');
                if (!fh || !ggbApplet || typeof ggbApplet.setSize !== 'function') return;
                const w = Math.max(50, fh.clientWidth);
                const h = Math.max(50, fh.clientHeight);
                try { ggbApplet.setSize(w, h); } catch (_) {}
                try { if (typeof ggbApplet.setWidth === 'function') ggbApplet.setWidth(w); } catch (_) {}
                try { if (typeof ggbApplet.setHeight === 'function') ggbApplet.setHeight(h); } catch (_) {}
              };
              [0, 100, 300, 600, 1000].forEach(delay => {
                setTimeout(forceResize, delay);
              });
              resolve({ ok: true, message: 'GeoGebra已启动', ready: true, appName });
            }
          };
          if (appPerspective) params.perspective = appPerspective;

          // 面板已 remove('hidden')，host 已有真实尺寸，params 已用具体像素值。
          // 直接 inject（GGB 不会用 0×0 固化 canvas）。
          try {
            const ggbApp = new GGBApplet(params, true);
            ggbApp.setHTML5Codebase(GGB_OFFLINE_CODEBASE, true);
            ggbApp.inject('ggb-element');
          } catch (e) {
            clearTimeout(timer);
            ggbInitPromise = null;
            resolve({ ok: false, error: 'GeoGebra 注入失败: ' + (e && e.message || String(e)), ready: false });
          }
        });
      });
    });
    return ggbInitPromise;
  };

  window.evalGeoGebraCommand = async function(cmd) {
    if (!ggbApplet || typeof ggbApplet.evalCommand !== 'function') {
      // 尝试等待初始化完成
      if (ggbInitPromise) {
        await ggbInitPromise;
      }
      if (!ggbApplet || typeof ggbApplet.evalCommand !== 'function') {
        return { ok: false, error: 'GeoGebra未初始化（applet 尚未加载完成）' };
      }
    }
    if (!cmd || typeof cmd !== 'string') {
      return { ok: false, error: '命令为空' };
    }

    // 清空上次错误
    ggbLastError = null;

    const maxRetries = 8;
    const retryDelayMs = 200;
    // 兼容多种懒加载错误措辞
    const lazyModulePattern = /(not loaded yet|loading\s+\w+\s+module|commands? not available|正在加载|未加载)/i;

    const getObjectValue = (name) => {
      try {
        const type = ggbApplet.getObjectType(name);
        if (type === 'numeric') {
          const numVal = ggbApplet.getValue(name);
          return isFinite(numVal) ? numVal : ggbApplet.getValueString(name);
        }
        if (type === 'point') {
          const x = ggbApplet.getXcoord(name);
          const y = ggbApplet.getYcoord(name);
          return `(${x}, ${y})`;
        }
        return ggbApplet.getValueString(name);
      } catch {
        return null;
      }
    };

    // 判断命令是否预期产生新对象（赋值、Solve、Roots 等）；
    // 修改/设置类命令（SetColor/SetLineThickness/ShowLabel/Delete 等）用 () 语法但不产生 label，不应误判
    const isModifierCmd = /^\s*(Set|Show|Delete|Rename|ZoomIn|ZoomOut|Pan|Center|Select|Update|Freeze|Copy|Repaint|Refresh|SetActiveView|ShowAxes|ShowGrid|SetPerspective|SetBackgroundColor|SetRounding)\b/i.test(cmd);
    const producesLabel = !isModifierCmd && /[=:]|^(\s*)(Solve|Roots|Factor|Expand|Derivative|Integral|Limit|Sequence|Vertex|Intersect|Midpoint|Centroid|ClosestPoint|Root|Extremum|TurningPoint|Slope|Length|Area|Perimeter|Radius|Angle|Distance|Curvature)\b/i.test(cmd);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let label = null;
        if (typeof ggbApplet.evalCommandGetLabels === 'function') {
          label = ggbApplet.evalCommandGetLabels(cmd);
        } else {
          ggbApplet.evalCommand(cmd);
        }
        await new Promise(r => setTimeout(r, 120));
        // 优先检查错误监听器捕获的错误
        if (ggbLastError && Date.now() - (ggbLastError.ts || 0) < 3000) {
          const errMsg = ggbLastError.message;
          if (lazyModulePattern.test(errMsg) && attempt < maxRetries) {
            ggbLastError = null;
            await new Promise(r => setTimeout(r, retryDelayMs));
            continue;
          }
          return { ok: false, error: errMsg, cmd };
        }
        const labels = (label || '').split(',').map(s => s.trim()).filter(Boolean);
        let value = null;
        if (labels.length === 1) {
          value = getObjectValue(labels[0]);
        } else if (labels.length > 1) {
          value = labels.map(n => ({ name: n, value: getObjectValue(n) }));
        }
        // 如果命令应该产生 label 但返回空，视为失败
        if (producesLabel && labels.length === 0) {
          return { ok: false, error: `命令未产生任何对象，可能语法错误：${cmd}`, cmd, value: null };
        }
        return { ok: true, label: label || null, value, cmd };
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (lazyModulePattern.test(msg) && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        return { ok: false, error: msg, cmd };
      }
    }

    return { ok: false, error: '命令执行超时（懒加载模块未就绪）', cmd };
  };

  window.getAllGeoGebraObjects = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const names = ggbApplet.getAllObjectNames();
      const objs = [];
      for (const n of names) {
        const type = ggbApplet.getObjectType(n);
        let value = ggbApplet.getValueString(n);

        // 对数值类型尝试获取数值
        if (type === 'numeric') {
          try {
            const numVal = ggbApplet.getValue(n);
            if (!isNaN(numVal) && isFinite(numVal)) {
              value = numVal.toString();
            }
          } catch { /* 保持原 value */ }
        }
        // 对点类型，尝试获取坐标
        else if (type === 'point') {
          try {
            const x = ggbApplet.getXcoord(n);
            const y = ggbApplet.getYcoord(n);
            if (!isNaN(x) && !isNaN(y)) {
              value = `(${x}, ${y})`;
            }
          } catch { /* 保持原 value */ }
        }

        objs.push({
          name: n,
          type: type,
          value: value,
          visible: ggbApplet.getVisible(n)
        });
      }
      return { ok: true, objects: objs };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteGeoGebraObject = function(name) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      ggbApplet.deleteObject(name);
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportGeoGebraPNG = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      const png = ggbApplet.getPNGBase64(1, true, 72);
      return { ok: true, data: png };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // 等待初始化完成（供 CAS/对象/XML 等依赖 applet 的方法复用）
  async function ensureGgbReady() {
    if (ggbApplet) return true;
    if (ggbInitPromise) await ggbInitPromise;
    return !!(ggbApplet);
  }

  // 符号计算（CAS）：需要 classic/cas/suite 应用；按需启用 CAS
  window.evalGeoGebraCAS = async function(cmd) {
    if (!await ensureGgbReady()) {
      return { ok: false, error: 'GeoGebra未初始化（applet 尚未加载完成）' };
    }
    if (!cmd || typeof cmd !== 'string') return { ok: false, error: '命令为空' };
    if (typeof ggbApplet.evalCommandCAS !== 'function') {
      return { ok: false, error: '当前应用不支持 CAS（请使用 classic/cas/suite 应用）' };
    }
    ggbLastError = null;
    try {
      if (typeof ggbApplet.enableCAS === 'function') {
        try { ggbApplet.enableCAS(true); } catch (_) {}
        await new Promise(r => setTimeout(r, 120));
      }
      // Giac 符号引擎懒加载：首次调用先预热，并对 "?"（未就绪）做有限重试
      try { ggbApplet.evalCommandCAS('1+1'); } catch (_) {}
      let result = '?';
      for (let attempt = 0; attempt < 20; attempt++) {
        result = ggbApplet.evalCommandCAS(cmd);
        if (result !== '?' && result !== undefined && result !== null) break;
        await new Promise(r => setTimeout(r, 300));
      }
      if (ggbLastError && Date.now() - (ggbLastError.ts || 0) < 3000) {
        return { ok: false, error: ggbLastError.message, cmd };
      }
      const text = result == null ? '' : String(result);
      if (text === '?' || text === '') {
        return { ok: false, error: 'CAS 未能求值（结果为 ?，可能语法错误或引擎未就绪）', cmd, result: text };
      }
      return { ok: true, result: text, cmd };
    } catch (e) {
      return { ok: false, error: e.message, cmd };
    }
  };

  // 单个对象详情：类型、值、坐标、定义、命令、样式状态
  window.getGeoGebraObject = function(name) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!name) return { ok: false, error: '缺少对象名' };
    try {
      const type = ggbApplet.getObjectType(name);
      const obj = { name: String(name), type };
      let value = null;
      try { value = ggbApplet.getValueString(name); } catch (_) {}
      if (type === 'numeric') {
        try {
          const n = ggbApplet.getValue(name);
          if (isFinite(n)) value = n;
        } catch (_) {}
      } else if (type === 'point' || type === 'vector') {
        try {
          const x = ggbApplet.getXcoord(name);
          const y = ggbApplet.getYcoord(name);
          if (isFinite(x) && isFinite(y)) value = `(${x}, ${y})`;
        } catch (_) {}
      }
      obj.value = value;
      try { obj.definition = ggbApplet.getDefinitionString(name); } catch (_) {}
      try { if (typeof ggbApplet.getCommandString === 'function') obj.command = ggbApplet.getCommandString(name, false); } catch (_) {}
      try { obj.visible = ggbApplet.getVisible(name); } catch (_) {}
      try { if (typeof ggbApplet.getCaption === 'function') obj.caption = ggbApplet.getCaption(name); } catch (_) {}
      try { if (typeof ggbApplet.getLayer === 'function') obj.layer = ggbApplet.getLayer(name); } catch (_) {}
      return { ok: true, object: obj };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.getGeoGebraXML = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      return { ok: true, xml: String(ggbApplet.getXML() || '') };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // setXML 会清空当前作图后按 XML 重建（官方文档行为），适合加载整份文件
  window.setGeoGebraXML = function(xml) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!xml || typeof xml !== 'string') return { ok: false, error: 'XML 为空' };
    try {
      if (typeof ggbApplet.setXML === 'function') {
        ggbApplet.setXML(xml);
      } else if (typeof ggbApplet.evalXML === 'function') {
        ggbApplet.evalXML(xml);
      } else {
        return { ok: false, error: '当前应用不支持 XML 加载' };
      }
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // 颜色支持 '#rrggbb'/'#rgb'/数组/对象 归一化为 [r,g,b]
  function ggbParseColor(c) {
    if (Array.isArray(c)) return c.slice(0, 3).map(v => Math.max(0, Math.min(255, Number(v) || 0)));
    if (c && typeof c === 'object') {
      return [Math.max(0, Math.min(255, Number(c.r) || 0)), Math.max(0, Math.min(255, Number(c.g) || 0)), Math.max(0, Math.min(255, Number(c.b) || 0))];
    }
    const s = String(c || '').replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(s)) return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    if (/^[0-9a-f]{3}$/i.test(s)) return s.split('').map(x => parseInt(x + x, 16));
    return null;
  }

  window.setGeoGebraStyle = function(name, style) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!name) return { ok: false, error: '缺少对象名' };
    const s = style && typeof style === 'object' ? style : {};
    const applied = [];
    const call = (fn, args, label) => {
      if (typeof ggbApplet[fn] !== 'function') return false;
      try { ggbApplet[fn](...args); applied.push(label); return true; } catch (_) { return false; }
    };
    if (s.color !== undefined) {
      const rgb = ggbParseColor(s.color);
      if (rgb) call('setColor', [name, rgb[0], rgb[1], rgb[2]], 'color');
    }
    if (s.visible !== undefined) call('setVisible', [name, !!s.visible], 'visible');
    if (s.labelVisible !== undefined || s.label !== undefined) {
      call('setLabelVisible', [name, !!(s.labelVisible !== undefined ? s.labelVisible : s.label)], 'labelVisible');
    }
    if (s.labelStyle !== undefined) call('setLabelStyle', [name, Number(s.labelStyle)], 'labelStyle');
    if (s.caption !== undefined) call('setCaption', [name, String(s.caption)], 'caption');
    if (s.fixed !== undefined) call('setFixed', [name, !!s.fixed, s.selectionAllowed !== false], 'fixed');
    if (s.layer !== undefined) call('setLayer', [name, Number(s.layer)], 'layer');
    if (s.lineStyle !== undefined) call('setLineStyle', [name, Number(s.lineStyle)], 'lineStyle');
    if (s.lineThickness !== undefined) call('setLineThickness', [name, Number(s.lineThickness)], 'lineThickness');
    if (s.pointStyle !== undefined) call('setPointStyle', [name, Number(s.pointStyle)], 'pointStyle');
    if (s.pointSize !== undefined) call('setPointSize', [name, Number(s.pointSize)], 'pointSize');
    return { ok: true, applied };
  };

  // 取最后一次命令错误（读取即清空），形成"执行→读错→修正"闭环
  window.getGeoGebraError = function() {
    const last = ggbLastError || null;
    ggbLastError = null;
    let appError = null;
    try {
      if (ggbApplet && typeof ggbApplet.getErrorString === 'function') appError = ggbApplet.getErrorString();
    } catch (_) {}
    return { ok: true, error: (last && last.message) || appError || null, ts: last ? last.ts : null };
  };

  window.getGeoGebraPNGBase64 = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      return { ok: true, data: ggbApplet.getPNGBase64(1, true, 72) };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // getBase64 为异步回调 API，包成 Promise
  window.getGeoGebraBase64 = function() {
    return new Promise((resolve) => {
      if (!ggbApplet || typeof ggbApplet.getBase64 !== 'function') {
        return resolve({ ok: false, error: 'GeoGebra未初始化或版本不支持 getBase64' });
      }
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      try {
        ggbApplet.getBase64((b64) => done({ ok: true, base64: String(b64 || '') }));
        setTimeout(() => done({ ok: false, error: 'getBase64 超时（10s）' }), 10000);
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    });
  };

  window.setGeoGebraBase64 = function(b64) {
    if (!ggbApplet || typeof ggbApplet.setBase64 !== 'function') {
      return { ok: false, error: 'GeoGebra未初始化或版本不支持 setBase64' };
    }
    try {
      ggbApplet.setBase64(String(b64 || ''));
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // 命令目录：按需获取（不注入系统提示词，模型需要时经工具显式拉取）
  const GEOGEBRA_GUIDE = {
    overview: 'GeoGebra 命令按需目录。严格遵循 GGB 语法：命令区分大小写，参数用方括号 []，列表用花括号 {}。求根返回点标签（如 Roots[f] 得 A,B,C），提取值用 x(A)/y(A)。修改样式用 Set* 系列命令。',
    basics: { desc: '函数、曲线与基础对象', commands: ['f(x)=x^2-1', 'g: y=2x+1', 'A=(1,2)', 'a=Slider[0,5,1]', 'Curve[cos(t),sin(t),t,0,2π]', 'x^2+y^2=9（隐式曲线）', 'r=2+cos(θ)（极坐标）', 'Sequence[n^2,n,1,10]'] },
    algebra: { desc: '方程与代数', commands: ['Solve[x^2-1=0]', 'NSolve[x^3=2]', 'Roots[f]', 'Factor[x^2-1]', 'Expand[(x+1)^3]', 'Simplify[(x^2-1)/(x-1)]', 'Substitute[x^2+y^2,{x=1,y=2}]', 'PrimeFactors[360]', 'GCD[12,18]', 'LCM[4,6]'] },
    calculus: { desc: '微积分', commands: ['Derivative[f]', 'Derivative[f,2]', 'Integral[f]', 'Integral[f,0,1]', 'Limit[f,0]', 'TaylorPolynomial[f,0,4]', 'Extremum[f]', 'InflectionPoint[f]', 'Tangent[1,f]', 'Asymptote[f]', 'Sum[n,n,1,100]', 'Product[k,k,1,5]'] },
    geometry: { desc: '几何构造', commands: ['Point[{2,3}]', 'Segment[A,B]', 'Line[A,B]', 'Ray[A,B]', 'Circle[A,2]', 'Circle[A,B,C]', 'Polygon[A,B,C]', 'Intersect[f,g]', 'Midpoint[A,B]', 'PerpendicularLine[A,g]', 'ParallelLine[A,g]', 'Angle[A,B,C]', 'Distance[A,B]', 'PerpendicularBisector[A,B]', 'Locus[Q,P]'] },
    threed: { desc: '3D 图形', commands: ['Plane[A,B,C]', 'Cube[A,B]', 'Tetrahedron[A,B,C,D]', 'Pyramid[poly,H]', 'Surface[u,v,u v]', 'SurfaceOfRevolution[f,xAxis]', 'IntersectPath[a,b]', 'Volume[cube]', 'Sphere[A,2]', 'Cylinder[circle,H]'] },
    cas: { desc: '符号计算（经 geogebraEvalCAS，注意 CAS 与代数视图对象名不同）', commands: ['Solve[x^2-1=0,x]', 'Expand[(x+1)^3]', 'Factor[x^2-1]', 'Substitute[f,x=2]', 'TaylorSeries[sin(x),x,0,4]', 'Integral[x^2,x]', 'Derivative[x^3,x]', 'NSolve[x^3=2,x]'] },
    spreadsheet: { desc: '表格（引用 A1 单元格、批量填充与回归）', commands: ['A1=3', 'FillCells[A1:A10,Sequence[n,n,1,10]]', 'CellRange[A1,B2]', 'FitPoly[A1:A10,2]', 'FitLine[A1:A10]', 'FitExp[A1:A10]', 'Sum[A1:A10]', 'Mean[A1:A10]'] },
    statistics: { desc: '统计与概率', commands: ['Mean[{1,2,3,4,5}]', 'Median[{1,2,3,4,5}]', 'Variance[{1,2,3,4,5}]', 'SD[{1,2,3,4,5}]', 'Histogram[{1,2,2,3,3,3}]', 'BoxPlot[0,1,{1,2,3,4,5}]', 'Normal[0,1,1.96]', 'Binomial[10,0.5,3,false]', 'RandomBetween[1,6]', 'Sample[{1,2,3,4,5},2]'] },
    transform: { desc: '几何变换', commands: ['Reflect[obj,line]', 'Rotate[obj,90°,A]', 'Translate[obj,{2,1}]', 'Dilate[obj,2,A]', 'Stretch[obj,line,2]', 'Shear[obj,line,k]', 'Homothety[A,2,B]', 'MatrixTransform[{{0,1},{1,0}},obj]'] },
    style: { desc: '样式与显示（对象修改，返回无新对象）', commands: ['SetColor[A,255,0,0]', 'SetLineThickness[f,5]', 'SetLineStyle[f,2]', 'SetPointStyle[A,0]', 'SetCaption[A,"P"]', 'SetVisibleInView[f,1,true]', 'SetLayer[A,3]', 'ShowLabel[A,true]', 'ShowAxes[true]', 'ShowGrid[false]', 'SetPerspective["G"]'] },
    scripting: { desc: '脚本与动态（按钮/滑动条交互）', commands: ['Execute[{"SetValue[a,a+1]"}]', 'SetValue[a,2]', 'If[x>0,1,-1]', 'CopyFreeObject[f]', 'SetCoords[A,1,2]', 'StartAnimation[a]', 'SetActiveView[1]', 'Rename[A,"P"]'] }
  };

  window.getGeoGebraGuide = function(category) {
    const cats = Object.keys(GEOGEBRA_GUIDE).filter(k => k !== 'overview');
    if (!category) {
      return { ok: true, categories: cats, overview: GEOGEBRA_GUIDE.overview };
    }
    const key = String(category).toLowerCase();
    const entry = GEOGEBRA_GUIDE[key];
    if (!entry) {
      return { ok: false, error: `未知分类: ${category}`, categories: cats };
    }
    return { ok: true, category: key, desc: entry.desc, commands: entry.commands };
  };

  if (btnCloseGgb) {
    btnCloseGgb.addEventListener('click', () => {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Canvas Implementation ----
  const canvasPanel = document.getElementById('canvas-panel');
  const canvasSvg = document.getElementById('canvas-svg');
  const btnCloseCanvas = document.getElementById('btn-close-canvas');
  const canvasObjects = new Map(); // Store object references

  window.initCanvas = function() {
    if (!canvasPanel || !canvasSvg) {
      return { ok: false, error: '画布元素未找到' };
    }

    // Close GeoGebra if open (only one split-screen at a time)
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }

    canvasPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open'); // Reuse same CSS class for split-screen

    // Auto-clear canvas when initializing
    window.clearCanvas();

    return { ok: true, message: '画布已初始化并清空' };
  };

  window.clearCanvas = function() {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }

    // Remove all child elements
    while (canvasSvg.firstChild) {
      canvasSvg.removeChild(canvasSvg.firstChild);
    }
    canvasObjects.clear();

    return { ok: true, message: '画布已清空' };
  };

  window.addCanvasObject = function(type, id, attributes) {
    if (!canvasSvg) {
      return { ok: false, error: '画布未初始化' };
    }

    if (canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 已存在` };
    }

    try {
      const element = document.createElementNS('http://www.w3.org/2000/svg', type);
      element.setAttribute('id', id);

      // Set attributes
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }

      canvasSvg.appendChild(element);
      canvasObjects.set(id, element);

      return { ok: true, message: `对象 ${id} 已添加` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.updateCanvasObject = function(id, attributes) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }

    try {
      const element = canvasObjects.get(id);
      for (const [key, value] of Object.entries(attributes || {})) {
        element.setAttribute(key, value);
      }

      return { ok: true, message: `对象 ${id} 已更新` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.deleteCanvasObject = function(id) {
    if (!canvasObjects.has(id)) {
      return { ok: false, error: `对象ID ${id} 不存在` };
    }

    try {
      const element = canvasObjects.get(id);
      element.remove();
      canvasObjects.delete(id);

      return { ok: true, message: `对象 ${id} 已删除` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.exportCanvasSVG = async function(filename, workspacePath) {
    if (!canvasSvg || !workspacePath) {
      return { ok: false, error: '画布或工作区路径未设置' };
    }

    try {
      // Get SVG content
      const svgContent = new XMLSerializer().serializeToString(canvasSvg);
      const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>\n${svgContent}`;

      // Save to workspace
      const result = await window.api.writeFile(
        `${workspacePath}/${filename}`,
        fullSvg
      );

      if (result.ok) {
        return { ok: true, path: `${workspacePath}/${filename}`, message: 'SVG已导出' };
      } else {
        return result;
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  if (btnCloseCanvas) {
    btnCloseCanvas.addEventListener('click', () => {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet Implementation ----
  const spreadsheetPanel = document.getElementById('spreadsheet-panel');
  const spreadsheetBody = document.getElementById('spreadsheet-body');
  const btnCloseSpreadsheet = document.getElementById('btn-close-spreadsheet');
  let ssEngine = null;
  let ssUI = null;

  function ensureSpreadsheet() {
    if (!ssEngine) {
      ssEngine = new SpreadsheetEngine();
      ssUI = new SpreadsheetUI(ssEngine, 'spreadsheet-body');
    }
    // Wire up formula bar input
    const fxInput = spreadsheetPanel?.querySelector('.ss-fx');
    if (fxInput && !fxInput._bound) {
      fxInput._bound = true;
      fxInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && ssUI?.selectedCell) {
          ssEngine.setCell(ssUI.selectedCell, fxInput.value);
        }
      });
    }
    return { engine: ssEngine, ui: ssUI };
  }

  window.initSpreadsheet = function(title) {
    if (!spreadsheetPanel) return { ok: false, error: '数据表格面板元素未找到' };
    // Close other panels
    if (ggbPanel && !ggbPanel.classList.contains('hidden')) {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    if (canvasPanel && !canvasPanel.classList.contains('hidden')) {
      canvasPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    }
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    const { engine } = ensureSpreadsheet();
    if (title) engine.title = title;
    return { ok: true, message: '数据表格已打开' };
  };

  window.spreadsheetSetCells = function(entries) {
    const { engine } = ensureSpreadsheet();
    return engine.setCells(entries);
  };

  window.spreadsheetGetCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cells: engine.getCells(range) };
  };

  window.spreadsheetSetCellFormat = function(addr, format) {
    const { engine } = ensureSpreadsheet();
    return { ok: true, cell: engine.setCellFormat(addr, format) };
  };

  window.spreadsheetSetRangeFormat = function(range, format) {
    const { engine } = ensureSpreadsheet();
    return engine.setRangeFormat(range, format);
  };

  window.spreadsheetClearCells = function(range) {
    const { engine } = ensureSpreadsheet();
    return engine.clearCells(range);
  };

  window.spreadsheetInsertRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertRow(rowNum, count || 1);
  };

  window.spreadsheetDeleteRows = function(rowNum, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteRow(rowNum, count || 1);
  };

  window.spreadsheetInsertCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.insertCol(colLetter, count || 1);
  };

  window.spreadsheetDeleteCols = function(colLetter, count) {
    const { engine } = ensureSpreadsheet();
    return engine.deleteCol(colLetter, count || 1);
  };

  window.spreadsheetSortRange = function(range, colLetter, ascending) {
    const { engine } = ensureSpreadsheet();
    return engine.sortRange(range, colLetter, ascending);
  };

  window.spreadsheetGetData = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, data: engine.getData() };
  };

  window.spreadsheetExportCSV = function() {
    const { engine } = ensureSpreadsheet();
    return { ok: true, csv: engine.exportCSV() };
  };

  window.spreadsheetImportCSV = function(csv, startAddr) {
    const { engine } = ensureSpreadsheet();
    return engine.importCSV(csv, startAddr || 'A1');
  };

  if (btnCloseSpreadsheet) {
    btnCloseSpreadsheet.addEventListener('click', () => {
      spreadsheetPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }

  // ---- Spreadsheet File Import/Export ----
  window.spreadsheetImportFile = async function(filePath) {
    const result = await window.api.spreadsheetImportFile(filePath);
    if (!result.ok) return result;
    ensureSpreadsheet();
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    if (result.sheetName) ssEngine.title = result.sheetName;
    if (result.cells && result.cells.length > 0) {
      ssEngine.setCells(result.cells);
    }
    return { ok: true, message: `已导入 ${result.cells?.length || 0} 个单元格`, sheetName: result.sheetName };
  };

  window.spreadsheetExportFile = async function(filePath) {
    ensureSpreadsheet();
    const data = ssEngine.getData();
    // data.cells 是数组 [{addr, raw, value, format}, ...]
    // 直接传给导出函数，每个元素需要 addr + value/raw
    const cells = (data.cells || []).map(c => ({
      addr: c.addr,
      value: c.value,
      raw: c.raw,  // 保留原始公式/文本，让导出函数优先使用 raw
      format: c.format || {}  // 保留单元格格式（粗体/斜体/颜色/背景/对齐/字号）
    }));
    return await window.api.spreadsheetExportFile(filePath, cells, data.title || 'Sheet1');
  };

  // ---- Email Received Handler ----
  window.api.onEmailReceived((email) => {
    // Forward email content to agent as hot message
    if (agent && typeof agent.injectHotMessage === 'function') {
      const content = `[来自邮件] 发件人: ${email.from || '未知'}, 主题: ${email.subject || '无主题'}\n\n${email.text || email.html || ''}`;
      agent.injectHotMessage(content);
    }
  });

  // ---- Ask Questions (Chat Bubble) ----
  window.askQuestions = function(questions, callingAgent) {
    return new Promise((resolve) => {
      if (!Array.isArray(questions) || questions.length === 0) {
        resolve([]);
        return;
      }

      // 会话进入"等待问卷回答"状态：标签页/历史列表显示指示器，而不是"运行中"
      const ownerAgent = callingAgent || agent;
      const ownerSession = window.__sessionManager?.getByAgent(ownerAgent);
      if (window.__sessionManager && ownerSession) {
        window.__sessionManager.setAttention(ownerSession, { kind: 'questionnaire', label: '等待问卷回答' });
      }

      // 系统通知：问卷需要用户回答
      const firstQ = questions[0];
      const qLabel = firstQ?.label || firstQ?.title || firstQ?.question || '请回答问题';
      sendAppNotification('question', 'Agent 有问题想问您', qLabel);

      const answers = new Array(questions.length).fill('');
      let currentIndex = 0;

      const msg = document.createElement('div');
      msg.className = 'message assistant';
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      let avatarHTML = '';
      const persona = agent.settings?.aiPersona;
      avatarHTML = makeFramedAvatarHTML(persona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const content = document.createElement('div');
      content.className = 'message-content';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.gap = '12px';

      const header = document.createElement('div');
      header.style.fontWeight = '500';

      const optionsWrap = document.createElement('div');
      optionsWrap.style.display = 'flex';
      optionsWrap.style.flexDirection = 'column';
      optionsWrap.style.gap = '8px';

      const hint = document.createElement('div');
      hint.style.fontSize = '12px';
      hint.style.color = 'var(--error-color)';
      hint.style.display = 'none';

      const nav = document.createElement('div');
      nav.style.display = 'flex';
      nav.style.justifyContent = 'space-between';
      nav.style.gap = '8px';

      const btnPrev = document.createElement('button');
      btnPrev.className = 'btn-secondary';
      btnPrev.textContent = '上一题';

      const btnNext = document.createElement('button');
      btnNext.className = 'btn-primary';

      let customRadio = null;
      let customInput = null;

      nav.appendChild(btnPrev);
      nav.appendChild(btnNext);

      content.appendChild(header);
      content.appendChild(optionsWrap);
      content.appendChild(hint);
      content.appendChild(nav);

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(content);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);
      if (ownerSession && typeof appendSessionCard === 'function') {
        appendSessionCard(ownerSession, msg);
      } else {
        appendChatElement(msg);
      }

      const baseOptions = ['选项A', '选项B', '选项C'];

      function renderQuestion() {
        const q = questions[currentIndex] || {};
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        const options = baseOptions.map((fallback, i) => rawOptions[i] || fallback);
        const currentAnswer = answers[currentIndex];

        header.textContent = `${currentIndex + 1}/${questions.length} ${q.question || ''}`;
        optionsWrap.innerHTML = '';
        hint.style.display = 'none';

        const radioName = `question-${currentIndex}`;

        options.forEach((opt, idx) => {
          const label = document.createElement('label');
          label.style.display = 'flex';
          label.style.alignItems = 'center';
          label.style.gap = '8px';
          label.style.cursor = 'pointer';

          const input = document.createElement('input');
          input.type = 'radio';
          input.name = radioName;
          input.value = opt;
          input.style.accentColor = 'var(--accent-color, #4f8cff)';
          if (currentAnswer === opt) input.checked = true;

          input.addEventListener('change', () => {
            answers[currentIndex] = opt;
          });

          const text = document.createElement('span');
          const letter = String.fromCharCode(65 + idx);
          text.textContent = `${letter}. ${opt}`;

          label.appendChild(input);
          label.appendChild(text);
          optionsWrap.appendChild(label);
        });

        const customLabel = document.createElement('label');
        customLabel.style.display = 'flex';
        customLabel.style.alignItems = 'center';
        customLabel.style.gap = '8px';

        customRadio = document.createElement('input');
        customRadio.type = 'radio';
        customRadio.name = radioName;
        customRadio.value = '__custom__';
        customRadio.style.accentColor = 'var(--accent-color, #4f8cff)';

        const customPrefix = document.createElement('span');
        customPrefix.textContent = 'D.';

        customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.placeholder = '自定义选项';
        customInput.style.cssText = `
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border-color);
          border-radius: 6px;
          background-color: var(--bg-secondary);
          color: var(--text-primary);
          font-size: 14px;
          transition: border-color 0.2s, box-shadow 0.2s;
        `;

        // Add focus/blur styling
        customInput.addEventListener('focus', () => {
          customInput.style.borderColor = 'var(--accent-color, #4f8cff)';
          customInput.style.boxShadow = '0 0 0 2px var(--accent-bg, rgba(79, 140, 255, 0.15))';
          customRadio.checked = true;
          if (customInput.value.trim()) {
            answers[currentIndex] = customInput.value.trim();
          }
        });

        customInput.addEventListener('blur', () => {
          customInput.style.borderColor = 'var(--border-color)';
          customInput.style.boxShadow = 'none';
        });

        if (currentAnswer && !options.includes(currentAnswer)) {
          customRadio.checked = true;
          customInput.value = currentAnswer;
        }

        customInput.addEventListener('input', () => {
          if (customRadio.checked) {
            answers[currentIndex] = customInput.value.trim();
          }
        });

        customRadio.addEventListener('change', () => {
          answers[currentIndex] = customInput.value.trim();
        });

        customLabel.appendChild(customRadio);
        customLabel.appendChild(customPrefix);
        customLabel.appendChild(customInput);
        optionsWrap.appendChild(customLabel);

        btnPrev.disabled = currentIndex === 0;
        btnNext.textContent = currentIndex === questions.length - 1 ? '提交' : '下一题';

        // 语音输入钩子：唤醒/听写结果填入本题自定义选项并自动下一题/提交
        window.__activeQuestion = {
          submitAnswer(text) {
            const v = String(text || '').trim();
            if (!v) return;
            customRadio.checked = true;
            customInput.value = v;
            answers[currentIndex] = v;
            btnNext.click();
          },
        };
      }

      function finish() {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        window.__activeQuestion = null;
        // Disable all inputs
        const allInputs = optionsWrap.querySelectorAll('input');
        allInputs.forEach(inp => inp.disabled = true);

        // Update buttons to show submitted state
        btnPrev.style.display = 'none';
        btnNext.textContent = '已提交';
        btnNext.disabled = true;
        btnNext.className = 'btn-secondary';

        // Add submitted indicator
        const submittedMsg = document.createElement('div');
        submittedMsg.style.cssText = `
          margin-top: 8px;
          padding: 8px 12px;
          background: var(--success-bg, #d4edda);
          color: var(--success-color, #155724);
          border-radius: 6px;
          font-size: 14px;
          text-align: center;
        `;
        submittedMsg.innerHTML = '<i class="fa-solid fa-check-circle"></i> 问卷已提交';
        content.appendChild(submittedMsg);

        const result = questions.map((q, i) => ({
          question: q.question,
          answer: answers[i]
        }));
        resolve(result);
      }

      btnPrev.addEventListener('click', () => {
        if (currentIndex > 0) {
          currentIndex -= 1;
          renderQuestion();
        }
      });

      btnNext.addEventListener('click', () => {
        const answer = answers[currentIndex];
        if (!answer || !answer.trim()) {
          hint.textContent = '请选择一个选项，或填写自定义选项';
          hint.style.display = 'block';
          return;
        }

        if (currentIndex < questions.length - 1) {
          currentIndex += 1;
          renderQuestion();
          return;
        }

        finish();
      });

      renderQuestion();
    });
  };

  // ---- Confirm Modal ----
  let confirmResolve = null;
  let confirmReject = null;

  window.confirmDialog = function(message, title = '确认操作') {
    return new Promise((resolve, reject) => {
      const modal = document.getElementById('confirm-modal');
      const modalBody = document.querySelector('.confirm-modal-body');
      const modalHeader = modal?.querySelector('.modal-header h3');

      if (!modal || !modalBody) {
        reject(new Error('确认对话框未找到'));
        return;
      }

      confirmResolve = resolve;
      confirmReject = reject;

      if (modalHeader) {
        modalHeader.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${title}`;
      }
      modalBody.textContent = message;
      modal.classList.remove('hidden');
    });
  };

  document.getElementById('btn-close-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    fadeOutHide(modal);
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-cancel-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    fadeOutHide(modal);
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  document.getElementById('btn-accept-confirm')?.addEventListener('click', () => {
    const modal = document.getElementById('confirm-modal');
    fadeOutHide(modal);
    if (confirmResolve) {
      confirmResolve(true);
      confirmResolve = null;
      confirmReject = null;
    }
  });

  // ---- Message Modal ----
  window.showMessageModal = function(message, title = '提示', type = 'info') {
    const modal = document.getElementById('message-modal');
    const modalBody = document.querySelector('.message-modal-body');
    const modalHeader = modal?.querySelector('.modal-header h3');

    if (!modal || !modalBody) {
      console.error('消息对话框未找到');
      return;
    }

    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    else if (type === 'error') iconClass = 'fa-exclamation-triangle';
    else if (type === 'warning') iconClass = 'fa-exclamation-circle';

    if (modalHeader) {
      modalHeader.innerHTML = `<i class="fa-solid ${iconClass}"></i> ${title}`;
    }
    modalBody.innerHTML = message.replace(/\n/g, '<br>');
    modal.classList.remove('hidden');
  };

  document.getElementById('btn-close-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    fadeOutHide(modal);
  });

  document.getElementById('btn-ok-message')?.addEventListener('click', () => {
    const modal = document.getElementById('message-modal');
    fadeOutHide(modal);
  });

  // ---- 自定义输入/确认模态框（替代 prompt/confirm） ----
  function showInputModal(title, label, defaultValue) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-secondary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:500px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
      box.innerHTML = `
        <h3 style="margin:0 0 12px;font-size:16px;color:var(--text-primary,#333);">${escapeHtml(title)}</h3>
        <label style="display:block;font-size:13px;color:var(--text-secondary,#666);margin-bottom:6px;">${escapeHtml(label)}</label>
        <input type="text" style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border-color,#ddd);border-radius:6px;font-size:14px;background:var(--bg-primary,#fff);color:var(--text-primary,#333);outline:none;" value="${escapeHtml(defaultValue || '')}">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="btn-cancel" style="padding:6px 16px;border:1px solid var(--border-color,#ddd);border-radius:6px;background:transparent;color:var(--text-secondary,#666);cursor:pointer;font-size:14px;">取消</button>
          <button class="btn-ok" style="padding:6px 16px;border:none;border-radius:6px;background:var(--accent-color,#007bff);color:#fff;cursor:pointer;font-size:14px;">确定</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector('input');
      input.focus();
      input.select();
      function close(val) {
        fadeOutRemove(overlay);
        resolve(val);
      }
      box.querySelector('.btn-cancel').addEventListener('click', () => close(null));
      box.querySelector('.btn-ok').addEventListener('click', () => close(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  function showConfirmModal(title, message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-secondary,#fff);border-radius:12px;padding:24px;min-width:360px;max-width:500px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
      box.innerHTML = `
        <h3 style="margin:0 0 12px;font-size:16px;color:var(--text-primary,#333);">${escapeHtml(title)}</h3>
        <p style="margin:0 0 16px;font-size:14px;color:var(--text-secondary,#666);line-height:1.5;">${escapeHtml(message)}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn-cancel" style="padding:6px 16px;border:1px solid var(--border-color,#ddd);border-radius:6px;background:transparent;color:var(--text-secondary,#666);cursor:pointer;font-size:14px;">取消</button>
          <button class="btn-ok" style="padding:6px 16px;border:none;border-radius:6px;background:var(--danger,#dc3545);color:#fff;cursor:pointer;font-size:14px;">确认删除</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      function close(val) {
        fadeOutRemove(overlay);
        resolve(val);
      }
      box.querySelector('.btn-cancel').addEventListener('click', () => close(false));
      box.querySelector('.btn-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    });
  }
