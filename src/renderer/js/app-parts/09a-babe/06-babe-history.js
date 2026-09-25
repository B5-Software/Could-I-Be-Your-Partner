  async function loadBabeHistoryPage() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    if (typeof HistoryList !== 'undefined') {
      await loadBabeHistoryPageVirtual();
      return;
    }
    try {
      const items = await window.api.babeHistoryList();
      if (!items || items.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>`;
        return;
      }
      // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
      listEl.innerHTML = items.map(item => {
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
            <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
            <button class="btn-icon history-export-json" data-id="${item.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
            <button class="btn-icon history-export-md" data-id="${item.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
            <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
      }).join('');
      // 绑定按钮（复用 Chat 模式的 class，但 Babe 历史需要走 Babe API）
      listEl.querySelectorAll('.history-continue').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          stopVoicePlayback(); // 切换会话前清空语音播放队列
          const id = btn.dataset.id;
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
        });
      });
      listEl.querySelectorAll('.history-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
          const result = await window.api.babeHistoryDelete(id);
          if (result.ok) loadBabeHistoryPage();
        });
      });
      const bindBabeExport = (btn, isJson) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const conv = await window.api.babeHistoryGet(btn.dataset.id);
          if (!conv) {
            if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在', '导出失败', 'error');
            return;
          }
          await exportConversationToFile(conv, isJson ? 'json' : 'md');
        });
      };
      listEl.querySelectorAll('.history-export-json').forEach(btn => bindBabeExport(btn, true));
      listEl.querySelectorAll('.history-export-md').forEach(btn => bindBabeExport(btn, false));
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    }
  }
