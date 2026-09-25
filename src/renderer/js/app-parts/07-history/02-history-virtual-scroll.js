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
    const workText = h.workingMs > 0 ? ` · 用时 ${formatWorkDuration(h.workingMs)}` : '';
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('chat', h) : null;
    const status = live ? live.status : h.status;
    const attention = live ? live.attention : null;
    const lastError = live ? live.lastError : h.lastError;
    return `
      <div class="history-item" data-id="${escapeHtml(h.id)}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(h.title || '未命名对话')} ${sessionStatusBadge(status, lastError, attention)}</div>
          <div class="history-time">${timeStr}${countText}${workText}</div>
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
    const workText = h.workingMs > 0 ? ` · 用时 ${formatWorkDuration(h.workingMs)}` : '';
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
          <div class="history-time">${timeStr}${countText}${workText}</div>
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
      if (typeof window.forceScrollToBottom === 'function') window.forceScrollToBottom(chatMessages);
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
