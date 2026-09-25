  async function loadCodeHistoryPage() {
    const listEl = document.getElementById('code-history-list');
    const descEl = document.getElementById('code-history-desc');
    if (!listEl) return;
    if (!codeWorkspacePath) {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史（需先打开工作区）</p></div>';
      if (descEl) descEl.textContent = '按工作区隔离的编程对话历史';
      return;
    }
    if (descEl) descEl.textContent = `工作区: ${codeWorkspacePath}`;
    if (typeof HistoryList !== 'undefined') {
      await loadCodeHistoryPageVirtual();
      return;
    }
    listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>';
    try {
      const result = await window.api.codeListHistory(codeWorkspacePath);
      if (result.ok && result.history && result.history.length > 0) {
        // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
        listEl.innerHTML = result.history.map(item => {
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
              <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
              <button class="btn-icon history-export-json" data-id="${item.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
              <button class="btn-icon history-export-md" data-id="${item.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
              <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>`;
        }).join('');
        listEl.querySelectorAll('.history-continue').forEach(btn => {
          btn.addEventListener('click', async () => {
            stopVoicePlayback(); // 切换会话前清空语音播放队列
            const id = btn.dataset.id;
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
          });
        });
        listEl.querySelectorAll('.history-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            // 对齐 Babe 模式：删除 Code 历史记录前二次确认，防止误删
            const titleForConfirm = btn.closest('.history-item')?.querySelector('.history-title')?.textContent?.trim() || '此对话';
            const confirmed = await window.confirmDialog(`确定删除"${String(titleForConfirm).slice(0, 40)}"吗？此操作不可恢复。`, '删除确认');
            if (!confirmed) return;
            await window.api.codeDeleteHistory(codeWorkspacePath, btn.dataset.id);
            loadCodeHistoryPage();
          });
        });
        const bindCodeExport = (btn, isJson) => {
          btn.addEventListener('click', async () => {
            const loadRes = await window.api.codeLoadHistory(codeWorkspacePath, btn.dataset.id);
            if (!loadRes.ok || !loadRes.data) {
              if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在或读取失败', '导出失败', 'error');
              return;
            }
            await exportConversationToFile(loadRes.data, isJson ? 'json' : 'md');
          });
        };
        listEl.querySelectorAll('.history-export-json').forEach(btn => bindCodeExport(btn, true));
        listEl.querySelectorAll('.history-export-md').forEach(btn => bindCodeExport(btn, false));
      } else {
        listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>暂无 Code 历史</p></div>';
      }
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>${e.message}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-code-history', html: document.getElementById('page-code-history').innerHTML });
    }
  }
