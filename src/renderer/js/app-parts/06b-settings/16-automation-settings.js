  // ---- 自动化触发设置（HTTP 信号服务器，fail-closed + Token 列表权限） ----
  let autoCfg = { enabled: false, allowNoToken: false, serverPort: 8765, tokens: [] };
  let autoTasks = [];
  async function loadAutomationSettings() {
    const s = await window.api.getSettings();
    autoCfg = s.automation || autoCfg;
    const enabledEl = document.getElementById('setting-automation-enabled');
    const noTokenEl = document.getElementById('setting-automation-allow-notoken');
    const portEl = document.getElementById('setting-automation-port');
    if (enabledEl) enabledEl.checked = autoCfg.enabled === true;
    if (noTokenEl) noTokenEl.checked = autoCfg.allowNoToken === true;
    if (portEl) portEl.value = autoCfg.serverPort || 8765;
    renderAutomationTokens();
    refreshAutomationServerStatus();
  }
  async function refreshAutomationTasks() {
    try {
      const res = await window.api.automationList();
      autoTasks = (res && res.ok && res.tasks) || [];
    } catch { autoTasks = []; }
    renderAutomationTokens();
  }
  async function saveAutomationCfg(cfgPatch, toast) {
    const r = await window.api.automationUpdateSettings(cfgPatch);
    if (!r || !r.ok) {
      window.showToast?.(r?.error || '保存失败', 'error', 2500);
      return null;
    }
    autoCfg = r.settings;
    renderAutomationTokens();
    if (toast) window.showToast?.(toast, 'success', 2000);
    refreshAutomationServerStatus();
    return r;
  }
  function fmtExpiry(ms) {
    if (!ms || ms <= 0) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function renderAutomationTokens() {
    const listEl = document.getElementById('automation-tokens-list');
    if (!listEl) return;
    const tokens = autoCfg.tokens || [];
    listEl.innerHTML = '';
    if (tokens.length === 0) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary)">暂无 Token（可点击下方「添加 Token」，或开启「允许无 Token 启动」）</div>';
    }
    tokens.forEach(t => {
      const row = document.createElement('div');
      row.className = 'automation-token-row';
      row.style.cssText = 'border:1px solid var(--border-color, rgba(128,128,128,.25));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px';
      row.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" data-field="name" value="${escapeHtml(t.name || '')}" placeholder="名称" style="width:120px">
          <input type="text" data-field="value" readonly value="${escapeHtml(t.value || '')}" style="flex:1;font-family:monospace;font-size:12px">
          <button class="btn-secondary btn-sm" data-act="copy" title="复制"><i class="fa-solid fa-copy"></i></button>
          <button class="btn-secondary btn-sm" data-act="roll" title="生成新值"><i class="fa-solid fa-rotate"></i></button>
          <button class="btn-secondary btn-sm" data-act="del" title="删除" style="color:#c0392b"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px">
          <label class="checkbox-label" style="flex-shrink:0">
            <input type="checkbox" data-field="allowParams" ${t.allowParams === false ? '' : 'checked'}> 允许传参
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;color:var(--text-secondary);white-space:nowrap;flex-shrink:0">
            有效期
            <input type="datetime-local" data-field="expiresAt" value="${escapeHtml(fmtExpiry(t.expiresAt))}" style="width:auto">
            <button class="btn-secondary btn-sm" data-act="clear-expiry" title="清除有效期" style="display:${t.expiresAt ? '' : 'none'}">清除</button>
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;color:var(--text-secondary);white-space:nowrap;flex-shrink:0">
            任务范围
            <select data-field="scope">
              <option value="all" ${t.scope === 'all' ? 'selected' : ''}>全部任务</option>
              <option value="selected" ${Array.isArray(t.scope) ? 'selected' : ''}>指定任务…</option>
            </select>
          </label>
          ${expiredHint(t)}
        </div>
        <div data-role="scope-detail" style="display:${Array.isArray(t.scope) ? 'flex' : 'none'};padding-left:16px;flex-wrap:wrap;gap:8px">
          ${renderScopeTasks(t)}
        </div>`;
      listEl.appendChild(row);
      row.querySelector('[data-field="name"]').addEventListener('change', (e) => {
        updateToken(t.id, { name: e.target.value });
      });
      row.querySelector('[data-field="allowParams"]').addEventListener('change', (e) => {
        updateToken(t.id, { allowParams: e.target.checked });
      });
      row.querySelector('[data-field="expiresAt"]').addEventListener('change', (e) => {
        const v = e.target.value;
        updateToken(t.id, { expiresAt: v ? new Date(v).getTime() : 0 });
      });
      row.querySelector('[data-field="scope"]').addEventListener('change', (e) => {
        updateToken(t.id, { scope: e.target.value === 'all' ? 'all' : [] });
      });
      row.querySelector('[data-act="copy"]').addEventListener('click', () => {
        navigator.clipboard.writeText(t.value || '').then(
          () => window.showToast?.('Token 已复制', 'success', 1500),
          () => window.showToast?.('复制失败', 'error', 2000)
        );
      });
      row.querySelector('[data-act="roll"]').addEventListener('click', async () => {
        const r = await window.api.automationGenerateTokenValue();
        if (!r || !r.ok) return;
        await updateToken(t.id, { value: r.value });
        window.showToast?.('已生成新 Token 值', 'success', 2000);
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async () => {
        const next = (autoCfg.tokens || []).filter(x => x.id !== t.id);
        await saveAutomationCfg({ tokens: next });
      });
      const clearExpiry = row.querySelector('[data-act="clear-expiry"]');
      if (clearExpiry) clearExpiry.addEventListener('click', async () => {
        await updateToken(t.id, { expiresAt: 0 });
      });
      row.querySelectorAll('[data-role="scope-task"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const scope = Array.isArray(t.scope) ? t.scope.slice() : [];
          const id = e.target.value;
          const i = scope.indexOf(id);
          if (e.target.checked) { if (i < 0) scope.push(id); }
          else if (i >= 0) scope.splice(i, 1);
          updateToken(t.id, { scope });
        });
      });
    });
  }
  function expiredHint(t) {
    if (!t.expiresAt || t.expiresAt <= 0) return '';
    const expired = t.expiresAt < Date.now();
    return `<span style="color:${expired ? '#c0392b' : 'var(--text-tertiary)'}">${expired ? '（已过期）' : '（' + new Date(t.expiresAt).toLocaleString() + ' 前有效）'}</span>`;
  }
  function renderScopeTasks(t) {
    const sel = Array.isArray(t.scope) ? t.scope : [];
    if (autoTasks.length === 0) {
      return '<span style="color:var(--text-tertiary);font-size:12px">暂无任务，可在触发页先创建自动化任务</span>';
    }
    return autoTasks.map(task => {
      const checked = sel.includes(task.id);
      return `<label class="checkbox-label">
        <input type="checkbox" data-role="scope-task" value="${escapeHtml(task.id)}" ${checked ? 'checked' : ''}> ${escapeHtml(task.name || task.id)}
      </label>`;
    }).join('');
  }
  async function updateToken(id, patch) {
    const tokens = (autoCfg.tokens || []).map(t => t.id === id ? Object.assign({}, t, patch) : t);
    await saveAutomationCfg({ tokens });
  }
  async function refreshAutomationServerStatus() {
    const el = document.getElementById('automation-settings-server-status');
    if (!el) return;
    try {
      const res = await window.api.automationList();
      const srv = (res && res.server) || { running: false, state: 'off' };
      const tokenCount = autoCfg.tokens ? autoCfg.tokens.length : 0;
      if (srv.running && srv.insecure) {
        el.textContent = `⚠️ 运行中但无 Token 鉴权（127.0.0.1:${srv.port || '?'}）— 不安全，任何本机程序均可触发`;
        el.style.color = '#c0392b';
      } else if (srv.running) {
        el.textContent = `✅ 运行中（127.0.0.1:${srv.port || '?'}，${tokenCount} 个 Token）`;
        el.style.color = 'var(--text-secondary)';
      } else if (srv.state === 'disabled') {
        el.textContent = '⏸ 未启用：服务器未启动（打开上方开关后生效）';
        el.style.color = 'var(--text-tertiary)';
      } else if (srv.state === 'missing-token') {
        el.textContent = `⚠️ 已启用但没有 Token：服务器未启动（添加 Token，或开启「允许无 Token 启动」）`;
        el.style.color = 'var(--warning, #b7791f)';
      } else {
        el.textContent = '未运行（无启用中的 HTTP 触发任务）';
        el.style.color = 'var(--text-tertiary)';
      }
    } catch (e) {
      el.textContent = '状态获取失败：' + (e.message || e);
    }
  }
  document.getElementById('setting-automation-enabled')?.addEventListener('change', async (e) => {
    const r = await saveAutomationCfg({ enabled: e.target.checked });
    if (!r) { e.target.checked = !e.target.checked; return; }
    window.showToast?.(e.target.checked ? 'HTTP 信号服务器已启用' : 'HTTP 信号服务器已禁用', 'success', 2000);
  });
  document.getElementById('setting-automation-allow-notoken')?.addEventListener('change', async (e) => {
    const r = await saveAutomationCfg({ allowNoToken: e.target.checked });
    if (!r) { e.target.checked = !e.target.checked; return; }
    window.showToast?.(e.target.checked ? '已开启无 Token 模式（不安全）' : '无 Token 模式已关闭', 'success', 2000);
  });
  document.getElementById('setting-automation-port')?.addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      e.target.value = autoCfg.serverPort || 8765;
      window.showToast?.('端口需在 1-65535', 'error', 2500);
      return;
    }
    const r = await saveAutomationCfg({ serverPort: v }, '端口已保存（需重启服务器生效）');
    if (r) e.target.value = r.settings.serverPort;
  });
  document.getElementById('btn-automation-add-token')?.addEventListener('click', async () => {
    const gen = await window.api.automationGenerateTokenValue();
    if (!gen || !gen.ok) { window.showToast?.(gen?.error || '生成失败', 'error', 2500); return; }
    const tokens = (autoCfg.tokens || []).concat([{
      name: '新 Token',
      value: gen.value,
      scope: 'all',
      allowParams: true,
      expiresAt: 0
    }]);
    const r = await saveAutomationCfg({ tokens }, 'Token 已添加');
    if (!r) window.showToast?.('添加失败', 'error', 2500);
  });
  loadAutomationSettings();
  refreshAutomationTasks();
