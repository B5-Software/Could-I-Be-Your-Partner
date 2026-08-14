  // ============ 自动化任务页（触发：定时/通知/HTTP → 新 Chat 会话） ============
  function triggerSummary(trigger) {
    if (!trigger) return '—';
    if (trigger.type === 'schedule') return `定时 ${trigger.config?.cron || '?'}`;
    if (trigger.type === 'notification') {
      const parts = [trigger.config?.kind || 'any'];
      if (trigger.config?.titleRegex) parts.push(`标题/${trigger.config.titleRegex}/`);
      if (trigger.config?.bodyRegex) parts.push(`正文/${trigger.config.bodyRegex}/`);
      return `通知 ${parts.join(' ')}`;
    }
    if (trigger.type === 'http') return `HTTP POST /trigger/${trigger.config?.path || '{id}'}`;
    return trigger.type;
  }

  // 编辑/新建在独立 IDE 窗口中进行（实时跟随主窗口主题）
  function openAutomationEditor(task) {
    if (typeof window.api.openAutomationEditor === 'function') {
      window.api.openAutomationEditor(task?.id || null);
    }
  }

  async function loadAutomationPage() {
    const res = await window.api.automationList();
    const listEl = document.getElementById('automation-list');
    const serverEl = document.getElementById('automation-server-status');
    if (!listEl) return;
    const tasks = (res && res.ok && res.tasks) || [];
    const server = (res && res.server) || { running: false };
    if (serverEl) {
      serverEl.textContent = server.running
        ? `信号服务器运行中：${server.url}/trigger/:id（POST，鉴权见 docs/automation.md）`
        : '信号服务器未启动（启用任一 HTTP 触发任务后自动启动）';
    }
    if (!tasks.length) {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-bolt"></i><p>暂无自动化任务</p></div>';
      return;
    }
    listEl.innerHTML = tasks.map(t => `
      <div class="automation-card" data-id="${escapeHtml(t.id)}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <i class="fa-solid fa-bolt" style="color:var(--accent)"></i>
            <strong>${escapeHtml(t.name)}</strong>
            <span style="font-size:11px;color:var(--text-tertiary)">${escapeHtml(triggerSummary(t.trigger))}</span>
          </div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">已运行 ${t.runCount || 0} 次${t.lastRunAt ? ` · 上次 ${new Date(t.lastRunAt).toLocaleString()}` : ''}${t.lastError ? ` · <span style="color:var(--danger)">${escapeHtml(t.lastError)}</span>` : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="toggle-switch"><input type="checkbox" ${t.enabled ? 'checked' : ''} data-auto-toggle="${escapeHtml(t.id)}"><span class="toggle-slider"></span></div>
          <button class="btn-secondary btn-sm" data-auto-run="${escapeHtml(t.id)}"><i class="fa-solid fa-play"></i></button>
          <button class="btn-secondary btn-sm" data-auto-edit="${escapeHtml(t.id)}"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-secondary btn-sm" data-auto-delete="${escapeHtml(t.id)}"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('[data-auto-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const r = await window.api.automationSetEnabled(cb.dataset.autoToggle, cb.checked);
        if (!r.ok) { cb.checked = !cb.checked; window.showToast?.(r.error, 'error', 3000); }
        loadAutomationPage();
      });
    });
    listEl.querySelectorAll('[data-auto-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = await window.api.automationRun(btn.dataset.autoRun, {});
        window.showToast?.(r.ok ? '已触发，正在新建 Chat 会话…' : (r.error || '执行失败'), r.ok ? 'success' : 'error', 3000);
        loadAutomationPage();
      });
    });
    listEl.querySelectorAll('[data-auto-edit]').forEach(btn => {
      btn.addEventListener('click', () => openAutomationEditor(tasks.find(x => x.id === btn.dataset.autoEdit)));
    });
    listEl.querySelectorAll('[data-auto-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await window.confirmDialog('删除此自动化任务？此操作不可恢复。', '删除任务')) return;
        await window.api.automationDelete(btn.dataset.autoDelete);
        loadAutomationPage();
      });
    });
  }

  document.getElementById('btn-automation-new')?.addEventListener('click', () => openAutomationEditor(null));
  // 编辑器窗口保存/删除后，主页面回到前台时刷新列表
  window.addEventListener('focus', () => {
    if (document.getElementById('page-automation')?.classList.contains('active')) loadAutomationPage();
  });

  // 自动化分发：新建一个 Chat 会话并发送渲染后的提示词
  if (typeof window.api.onAutomationDispatch === 'function') {
    window.api.onAutomationDispatch(async (payload) => {
      if (typeof createNewSession !== 'function') throw new Error('会话模块未就绪');
      await createNewSession('chat');
      await new Promise(r => setTimeout(r, 80));
      document.querySelector('.nav-item[data-page="chat"]')?.click();
      const sm = window.__sessionManager;
      const session = sm ? sm.getActive('chat') : null;
      const ag = (session && session.agent) || agent;
      if (!ag) throw new Error('无法获取 Chat Agent');
      const prompt = String(payload.prompt || '');
      if (typeof addMessageToChat === 'function') addMessageToChat('user', prompt);
      if (typeof addThinkingIndicator === 'function') addThinkingIndicator();
      try {
        await ag.sendMessage(prompt, []);
      } finally {
        if (typeof removeThinkingIndicator === 'function') removeThinkingIndicator();
      }
      return { sessionKey: ag.sessionKey || (session && session.key) || null };
    });
  }
