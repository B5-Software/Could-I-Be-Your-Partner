  // ============ Babe 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let babeHistoryRawItems = [];
  let babeHistorySearch = null;

  function ensureBabeHistoryListAttached() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderBabeHistoryItem,
        onAction: handleBabeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>',
        stride: 78,
        overscan: 8
      });
      babeHistorySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'babe-history',
        inputId: 'babe-history-search-input',
        countId: 'babe-history-search-count',
        listId: 'babe-history-list',
        searchMode: 'babe',
        getRawItems: () => babeHistoryRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderBabeHistoryItem,
        renderContentItem: renderBabeHistoryContentItem,
        onAction: handleBabeHistoryAction,
        restoreItems: () => HistoryList.setItems(listEl, babeHistoryRawItems)
      }) : null;
    }
    return true;
  }

  function renderBabeHistoryItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
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

  function renderBabeHistoryContentItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    const snippets = Array.isArray(item.snippets) ? item.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (item.snippetTotal && item.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${item.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
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

  async function handleBabeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const existing = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
      if (existing) {
        babeAgent = existing.agent;
        const conversation = await window.api.babeHistoryGet(id);
        if (conversation) {
          babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
          await babeAgent.loadFromHistory(conversation);
          sessionManager.retag(existing, id);
        }
        activateSession('babe', existing.key);
      } else {
        await loadBabeConversation(id);
      }
    } else if (action === 'export-json' || action === 'export-md') {
      const conv = await window.api.babeHistoryGet(id);
      if (!conv) {
        if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在', '导出失败', 'error');
        return;
      }
      await exportConversationToFile(conv, action === 'export-json' ? 'json' : 'md');
    } else if (action === 'delete') {
      if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
      const result = await window.api.babeHistoryDelete(id);
      if (result.ok) loadBabeHistoryPage();
    }
  }

  async function loadBabeHistoryPageVirtual() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    ensureBabeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const items = await window.api.babeHistoryList();
      babeHistoryRawItems = Array.isArray(items) ? items : [];
      if (babeHistorySearch) babeHistorySearch.refresh();
      else HistoryList.setItems(listEl, babeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-babe-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`);
    }
  }

  // 加载 Babe 历史
  async function loadBabeConversation(id) {
    const conversation = await window.api.babeHistoryGet(id);
    if (!conversation) {
      window.showMessageModal('找不到该对话', '错误', 'error');
      return;
    }
    let session = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
    if (!session) {
      session = await createBabeSession();
      if (!session) return;
    }
    babeAgent = session.agent;
    babeCurrentHistoryId = id;
    babeMessages = conversation.messages || [];
    babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
    await babeAgent.loadFromHistory(conversation);
    sessionManager.retag(session, id);
    activateSession('babe', session.key);
    await replayBabeSession(session);
    updateBabeAffection(babeAgent.babeAffection);
    // 切换到 Babe 页面
    document.querySelector('.nav-item[data-page="babe"]')?.click();
  }

  // 主动消息定时器
