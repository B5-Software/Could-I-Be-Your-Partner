  // ============ 自动化任务页（触发：定时/通知/HTTP → 新 Chat 会话） ============
  let automationEditor = null;
  let automationEditingId = null;
  const automationModal = () => document.getElementById('automation-editor-modal');

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

  function renderAutomationTriggerConfig(type) {
    const host = document.getElementById('automation-trigger-config');
    if (!host) return;
    if (type === 'schedule') {
      host.innerHTML = `
        <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px">cron（分 时 日 月 周，5 段）</label>
        <input type="text" id="auto-cron" placeholder="*/5 * * * *" style="width:280px">
        <p class="setting-hint">例：<code>*/5 * * * *</code> 每 5 分钟；<code>0 9 * * 1-5</code> 工作日 9 点；<code>0 0 * * *</code> 每天 0 点。</p>`;
    } else if (type === 'notification') {
      host.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <div><label style="font-size:12px;color:var(--text-secondary);display:block">通知类别</label>
          <select id="auto-notif-kind" style="width:180px">
            <option value="any">任意</option>
            <option value="sessionDone">会话完成</option>
            <option value="sessionError">会话失败</option>
            <option value="approval">等待审批</option>
            <option value="other">其他</option>
          </select></div>
          <div><label style="font-size:12px;color:var(--text-secondary);display:block">标题匹配（正则，可选）</label>
          <input type="text" id="auto-notif-title" placeholder=".*已完成.*" style="width:180px"></div>
          <div><label style="font-size:12px;color:var(--text-secondary);display:block">正文匹配（正则，可选）</label>
          <input type="text" id="auto-notif-body" placeholder=".*失败.*" style="width:180px"></div>
        </div>`;
    } else {
      host.innerHTML = `
        <p class="setting-hint">启用后启动专用信号服务器（默认端口 8765，可到 设置 → 网络 附近查阅文档调整）。请求方式见 <code>docs/automation.md</code>：</p>
        <pre style="font-size:11px;background:var(--bg-primary);padding:8px;border-radius:8px;overflow:auto">POST /trigger/{id}
Authorization: Bearer &lt;token&gt;
Content-Type: application/json
{"任意":"JSON 参数，进入 DSL 的 args"}</pre>`;
    }
  }

  function fillAutomationEditor(task) {
    automationEditingId = task?.id || null;
    document.getElementById('automation-name').value = task?.name || '';
    document.getElementById('automation-enabled').checked = task ? !!task.enabled : true;
    document.getElementById('automation-trigger-type').value = task?.trigger?.type || 'schedule';
    renderAutomationTriggerConfig(task?.trigger?.type || 'schedule');
    const cfg = task?.trigger?.config || {};
    if (task?.trigger?.type === 'schedule') document.getElementById('auto-cron').value = cfg.cron || '*/5 * * * *';
    if (task?.trigger?.type === 'notification') {
      document.getElementById('auto-notif-kind').value = cfg.kind || 'any';
      document.getElementById('auto-notif-title').value = cfg.titleRegex || '';
      document.getElementById('auto-notif-body').value = cfg.bodyRegex || '';
    }
    if (automationEditor) automationEditor.setValue(task?.dsl || 'return "你好，我是自动化任务。"');
  }

  async function ensureAutomationMonaco() {
    if (automationEditor) return automationEditor;
    if (typeof ensureMonaco !== 'function') return null;
    const monaco = await ensureMonaco();
    const host = document.getElementById('automation-dsl-editor');
    if (!host || !monaco) return null;
    automationEditor = monaco.editor.create(host, {
      value: 'return "你好，我是自动化任务。"',
      language: 'javascript',
      theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'vs',
      minimap: { enabled: false },
      fontSize: 13,
      automaticLayout: true,
      scrollBeyondLastLine: false
    });
    return automationEditor;
  }

  async function openAutomationEditor(task) {
    document.getElementById('automation-editor-error').style.display = 'none';
    automationModal()?.classList.remove('hidden');
    await ensureAutomationMonaco();
    fillAutomationEditor(task);
  }

  function closeAutomationEditor() {
    automationModal()?.classList.add('hidden');
    if (automationEditor) { try { automationEditor.dispose(); } catch { /* ignore */ } automationEditor = null; }
    automationEditingId = null;
  }

  function collectAutomationTask() {
    const type = document.getElementById('automation-trigger-type').value;
    let config = {};
    if (type === 'schedule') config = { cron: (document.getElementById('auto-cron')?.value || '').trim() };
    if (type === 'notification') {
      config = {
        kind: document.getElementById('auto-notif-kind')?.value || 'any',
        titleRegex: (document.getElementById('auto-notif-title')?.value || '').trim(),
        bodyRegex: (document.getElementById('auto-notif-body')?.value || '').trim()
      };
    }
    return {
      id: automationEditingId || undefined,
      name: (document.getElementById('automation-name')?.value || '').trim() || '未命名任务',
      enabled: document.getElementById('automation-enabled')?.checked !== false,
      trigger: { type, config },
      dsl: automationEditor ? automationEditor.getValue() : ''
    };
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
  document.getElementById('btn-close-automation-editor')?.addEventListener('click', closeAutomationEditor);
  document.getElementById('btn-cancel-automation-editor')?.addEventListener('click', closeAutomationEditor);
  document.getElementById('automation-trigger-type')?.addEventListener('change', (e) => renderAutomationTriggerConfig(e.target.value));
  document.getElementById('btn-save-automation')?.addEventListener('click', async () => {
    const errEl = document.getElementById('automation-editor-error');
    const task = collectAutomationTask();
    if (task.trigger.type === 'schedule' && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(task.trigger.config.cron)) {
      if (errEl) { errEl.textContent = 'cron 需要 5 段（分 时 日 月 周）'; errEl.style.display = ''; }
      return;
    }
    const r = await window.api.automationSave(task);
    if (!r.ok) {
      if (errEl) { errEl.textContent = r.error || '保存失败'; errEl.style.display = ''; }
      return;
    }
    closeAutomationEditor();
    window.showToast?.('自动化任务已保存', 'success', 2500);
    loadAutomationPage();
  });
  document.getElementById('btn-automation-test')?.addEventListener('click', async () => {
    const errEl = document.getElementById('automation-editor-error');
    const r = await window.api.automationTest(collectAutomationTask(), {});
    if (!r.ok) {
      if (errEl) { errEl.textContent = r.error || '渲染失败'; errEl.style.display = ''; }
      return;
    }
    if (errEl) {
      errEl.textContent = '渲染结果：\n' + (r.result?.prompt || '');
      errEl.style.color = 'var(--text-secondary)';
      errEl.style.display = '';
    }
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
