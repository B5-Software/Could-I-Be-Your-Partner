  // ============ Code 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let codeHistoryRawItems = [];
  let codeHistorySearch = null;

  function ensureCodeHistoryListAttached() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderCodeHistoryItem,
        onAction: handleCodeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>',
        stride: 78,
        overscan: 8
      });
      codeHistorySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'code-history',
        inputId: 'code-history-search-input',
        countId: 'code-history-search-count',
        listId: 'code-history-list',
        searchMode: 'code',
        getWorkspacePath: () => codeWorkspacePath,
        getRawItems: () => codeHistoryRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderCodeHistoryItem,
        renderContentItem: renderCodeHistoryContentItem,
        onAction: handleCodeHistoryAction,
        restoreItems: () => HistoryList.setItems(listEl, codeHistoryRawItems)
      }) : null;
    }
    return true;
  }

  function renderCodeHistoryItem(item) {
    const date = new Date(item.ts);
    const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('code', item) : null;
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息${item.workingMs > 0 ? ` · 用时 ${formatWorkDuration(item.workingMs)}` : ''}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderCodeHistoryContentItem(item) {
    const date = new Date(item.updatedAt || item.ts || Date.now());
    const timeStr = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('code', item) : null;
    const snippets = Array.isArray(item.snippets) ? item.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (item.snippetTotal && item.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${item.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名')} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息${item.workingMs > 0 ? ` · 用时 ${formatWorkDuration(item.workingMs)}` : ''}</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  async function handleCodeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
      if (loadRes.ok && loadRes.data) {
        codeCurrentHistoryId = id;
        const conv = loadRes.data;
        let session = sessionManager ? sessionManager.list('code').find(s => String(s.id) === String(id)) : null;
        if (session) {
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
          activateSession('code', session.key);
        } else {
          session = await createCodeSession();
          if (!session) return;
          codeAgent = session.agent;
          await codeAgent.loadFromHistory(conv);
          sessionManager.retag(session, id);
        }
        codeMessages = codeAgent.contextManager.getHistoryMessages().slice();
        await replayCodeSession(session);
        document.querySelector('.nav-item[data-page="code"]')?.click();
      }
    } else if (action === 'export-json' || action === 'export-md') {
      const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, id);
      if (!loadRes.ok || !loadRes.data) {
        if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在或读取失败', '导出失败', 'error');
        return;
      }
      await exportConversationToFile(loadRes.data, action === 'export-json' ? 'json' : 'md');
    } else if (action === 'delete') {
      const titleForConfirm = item.title || '此对话';
      const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
      if (!confirmed) return;
      await window.api.codeDeleteHistory(codeWorkspacePath, id);
      loadCodeHistoryPage();
    }
  }

  async function loadCodeHistoryPageVirtual() {
    const listEl = document.getElementById('code-history-list');
    if (!listEl) return;
    ensureCodeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && Array.isArray(result.history)) {
        codeHistoryRawItems = result.history;
      } else {
        codeHistoryRawItems = [];
      }
      if (codeHistorySearch) codeHistorySearch.refresh();
      else HistoryList.setItems(listEl, codeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-code-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${escapeHtml(e.message)}</p></div>`);
    }
  }

  // Code mode event handlers
  document.getElementById('btn-code-open-workspace')?.addEventListener('click', async () => {
    const result = await window.api.codeOpenWorkspace();
    if (result.ok && result.path) {
      codeWorkspacePath = result.path;
      const wsPathEl = document.getElementById('code-workspace-path');
      if (wsPathEl) wsPathEl.textContent = result.path;
      await loadCodeFileTree(result.path);
      // 工作区切换：Code 历史按工作区隔离保存，旧工作区的会话一律停止并关闭，
      // 随后立即创建新工作区的第一个会话标签（与其他模式行为对齐）。
      if (sessionManager) {
        const oldSessions = sessionManager.list('code');
        for (const session of oldSessions) {
          try { sessionManager.close(session); } catch { /* ignore */ }
        }
      }
      // Reset current conversation
      unsubscribeAgentStreams(codeAgent);
      codeAgent = null;
      codeCurrentHistoryId = null;
      codeMessages = [];
      const msgsEl = document.getElementById('code-chat-messages');
      if (msgsEl) {
        msgsEl.innerHTML = '<div class="welcome-message"><div class="welcome-icon"><i class="fa-solid fa-code"></i></div><h2>Code 模式</h2><p>工作区已打开，开始编程任务吧。历史记录按工作区隔离保存。</p></div>';
      }
      await createCodeSession();
    }
  });

  document.getElementById('btn-code-new-chat')?.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    createCodeSession().catch(err => console.error('[code] 新建会话失败:', err));
  });

  // 在系统文件管理器中打开当前工作区（Windows 资源管理器 / macOS Finder）
  // 启动时根据平台动态设置按钮 title（Finder / 资源管理器）
  (function _initCodeExplorerBtnTitle() {
    const btn = document.getElementById('btn-code-open-in-explorer');
    if (btn) {
      const fmName = _fileManagerName();
      btn.title = `在${fmName}中打开工作区`;
    }
  })();
  document.getElementById('btn-code-open-in-explorer')?.addEventListener('click', () => {
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区', '提示', 'warning');
      return;
    }
    window.api.openFileExplorer?.(codeWorkspacePath);
  });
