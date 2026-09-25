  window.api.onSavePending(async () => {
    try {
      const runningSessions = sessionManager
        ? sessionManager.list().filter(s => s.status === SessionStatus.RUNNING
            || s.status === SessionStatus.WAITING_APPROVAL
            || s.status === SessionStatus.WAITING_TOOL_AUTH
            || s.status === SessionStatus.QUEUED)
        : [];
      if (runningSessions.length === 0) {
        await window.api.skipPending();
        return;
      }
      const sessions = runningSessions.map(session => {
        const ag = session.agent;
        const lastUserMsg = (ag?.contextManager?.messages || [])
          .filter(m => m.role === 'user')
          .slice(-1)[0];
        const lastUserText = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content.slice(0, 200)
          : '[多模态内容]';
        return {
          conversationId: ag?.conversationId || session.id,
          conversationTitle: session.title || ag?.conversationTitle || '未命名对话',
          mode: session.mode,
          sessionKey: session.key,
          status: session.status,
          workspacePath: ag?.workspacePath || null,
          codeWorkspacePath: ag?.codeWorkspacePath || null,
          babeAffection: ag?.babeAffection ?? 0,
          tarotCard: ag?.tarotCard || null,
          messageCount: ag?.contextManager?.messages?.length || 0,
          lastUserMessage: lastUserText,
          sessionUsage: ag?.sessionUsage || null
        };
      });
      await window.api.savePendingSession({ sessions });
    } catch (e) {
      console.error('[App] savePendingSession failed:', e.message);
      try { await window.api.skipPending(); } catch {}
    }
  });

  // App 启动时检查是否有 pending 会话，有则弹模态框询问是否继续
  async function checkPendingSessionOnStartup() {
    try {
      const pending = await window.api.getPendingSession();
      const sessions = pending?.sessions;
      const hasLegacy = pending && pending.conversationId;
      if (!pending || (!Array.isArray(sessions) && !hasLegacy)) {
        return;
      }
      if (Array.isArray(sessions) && sessions.length === 0) {
        await window.api.clearPendingSession();
        return;
      }
      // 距离上次保存超过 7 天则忽略
      try {
        const savedAt = new Date(pending.savedAt).getTime();
        if (Date.now() - savedAt > 7 * 24 * 3600 * 1000) {
          await window.api.clearPendingSession();
          return;
        }
      } catch {}
      showPendingResumeModal(pending);
    } catch (e) {
      console.warn('[App] checkPendingSessionOnStartup failed:', e.message);
    }
  }
  // 延迟调用以确保 UI 已就绪
  setTimeout(checkPendingSessionOnStartup, 1500);

  async function resumePendingItem(item) {
    if (!item?.conversationId) return;
    if (item.mode && item.mode !== currentMode) {
      const modeBtn = document.querySelector(`.mode-btn[data-mode="${item.mode}"]`);
      if (modeBtn) modeBtn.click();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (item.mode === 'code') {
      if (item.codeWorkspacePath) {
        codeWorkspacePath = item.codeWorkspacePath;
        try { await window.api.codeSetLastWorkspace?.(item.codeWorkspacePath); } catch { /* ignore */ }
        const wsPathEl = document.getElementById('code-workspace-path');
        if (wsPathEl) wsPathEl.textContent = item.codeWorkspacePath;
        await loadCodeFileTree(item.codeWorkspacePath);
        await loadCodeHistoryPage();
        await new Promise(resolve => setTimeout(resolve, 250));
        const continueBtn = document.querySelector(`#code-history-list .history-continue[data-id="${item.conversationId}"]`);
        if (continueBtn) continueBtn.click();
      }
      return;
    }
    if (item.mode === 'babe') {
      await loadBabeConversation(item.conversationId);
      return;
    }
    const conv = await window.api.historyGet(item.conversationId);
    if (!conv) return;
    const existing = sessionManager?.list('chat').find(s => String(s.id) === String(conv.id));
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
  }

  // 显示"上次会话中断"模态框，提供继续/忽略/查看历史等选项
  function showPendingResumeModal(pending) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:9999;background:rgba(0,0,0,0.5);';
    const modeNames = { chat: 'Chat', code: 'Code', babe: 'Babe' };
    const sessions = Array.isArray(pending.sessions) && pending.sessions.length > 0 ? pending.sessions : [pending];
    const primary = sessions[0] || pending;
    const modeLabel = modeNames[primary.mode] || primary.mode || 'Chat';
    const savedAtStr = (() => {
      try { return new Date(pending.savedAt).toLocaleString('zh-CN'); } catch { return ''; }
    })();
    overlay.innerHTML = `
      <div class="modal pending-resume-modal" style="max-width:480px;width:92vw;background:var(--bg-primary);border-radius:16px;box-shadow:var(--shadow-lg);overflow:hidden;border:1px solid var(--border);">
        <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
          <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--warning),#d97706);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;flex-shrink:0;">
            <i class="fa-solid fa-clock-rotate-left"></i>
          </div>
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text-primary);">上次会话未结束</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">中断于 ${savedAtStr}${sessions.length > 1 ? ` · ${sessions.length} 个会话` : ''}</div>
          </div>
        </div>
        <div style="padding:20px 24px;">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">检测到上次 App 异常关闭时正在执行的会话尚未保存。是否继续该会话？</div>
          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:12px 14px;font-size:12px;color:var(--text-secondary);">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">模式</span>
              <span style="font-weight:600;color:var(--text-primary);">${modeLabel}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">会话标题</span>
              <span style="font-weight:600;color:var(--text-primary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(primary.conversationTitle || '').replace(/"/g, '&quot;')}">${primary.conversationTitle || '未命名对话'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="color:var(--text-tertiary);">消息数</span>
              <span style="font-weight:600;color:var(--text-primary);">${primary.messageCount || 0}</span>
            </div>
            ${primary.lastUserMessage ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);"><div style="color:var(--text-tertiary);margin-bottom:4px;">最后用户消息：</div><div style="color:var(--text-primary);white-space:pre-wrap;word-break:break-word;max-height:80px;overflow:auto;">${(primary.lastUserMessage || '').replace(/</g, '&lt;')}</div></div>` : ''}
          </div>
        </div>
        <div style="padding:14px 24px;border-top:1px solid var(--border);background:var(--bg-secondary);display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" id="pending-ignore-btn" style="padding:8px 16px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-secondary);border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">忽略并清除</button>
          <button type="button" id="pending-continue-btn" style="padding:8px 16px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 2px 8px var(--accent-bg);">
            <i class="fa-solid fa-play" style="margin-right:6px;"></i>继续会话
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeOverlay = () => fadeOutRemove(overlay);

    overlay.querySelector('#pending-continue-btn').addEventListener('click', async () => {
      try {
        for (const item of sessions) {
          try {
            await resumePendingItem(item);
          } catch (e) {
            console.error('[App] resume pending session failed:', e.message);
          }
        }
        await window.api.clearPendingSession();
      } catch (e) {
        console.error('[App] pending continue failed:', e.message);
      }
      closeOverlay();
    });

    overlay.querySelector('#pending-ignore-btn').addEventListener('click', async () => {
      await window.api.clearPendingSession().catch(() => {});
      closeOverlay();
    });
  }
