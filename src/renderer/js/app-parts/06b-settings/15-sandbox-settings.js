  // ---- 沙箱设置 + 后端自检 ----
  async function loadSandboxSettings() {
    const s = await window.api.getSettings();
    const sb = s.sandbox || {};
    const setSel = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    setSel('setting-sandbox-default', sb.defaultMode || 'danger-full-access');
    setSel('setting-sandbox-chat', sb.modeOverrides?.chat || '');
    setSel('setting-sandbox-code', sb.modeOverrides?.code || '');
    setSel('setting-sandbox-babe', sb.modeOverrides?.babe || '');
    const approvalEl = document.getElementById('setting-sandbox-approval');
    if (approvalEl) approvalEl.checked = sb.requireApproval !== false;
    refreshSandboxStatus();
  }
  async function refreshSandboxStatus() {
    const el = document.getElementById('sandbox-backend-status');
    if (!el || typeof window.api.sandboxGetStatus !== 'function') return;
    try {
      const st = await window.api.sandboxGetStatus();
      if (st.backendAvailable) {
        el.textContent = `✅ ${st.detail}（enforcement: ${st.enforcement}）`;
        el.style.color = 'var(--text-secondary)';
      } else {
        el.textContent = `⚠️ ${st.detail}：受限模式将拒绝执行（fail-closed）`;
        el.style.color = 'var(--warning, #b7791f)';
      }
    } catch (e) {
      el.textContent = '状态获取失败：' + (e.message || e);
    }
  }
  async function updateSandboxSettings(patch, toast) {
    const s = await window.api.getSettings();
    if (!s.sandbox || typeof s.sandbox !== 'object') s.sandbox = {};
    if (patch.modeOverrides !== undefined) {
      if (!s.sandbox.modeOverrides || typeof s.sandbox.modeOverrides !== 'object') s.sandbox.modeOverrides = {};
      Object.assign(s.sandbox.modeOverrides, patch.modeOverrides);
      delete patch.modeOverrides;
    }
    Object.assign(s.sandbox, patch);
    await saveSettings(s);
    // 同步到各 agent 实例
    for (const a of [agent, codeAgent, babeAgent]) {
      if (a && a.settings) a.settings.sandbox = s.sandbox;
    }
    if (toast) window.showToast?.(toast, 'success', 2000);
  }
  document.getElementById('setting-sandbox-default')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ defaultMode: e.target.value }, '沙箱默认模式已保存');
  });
  document.getElementById('setting-sandbox-chat')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { chat: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-code')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { code: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-babe')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { babe: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-approval')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ requireApproval: !!e.target.checked });
  });
  document.getElementById('btn-sandbox-probe')?.addEventListener('click', async () => {
    const el = document.getElementById('sandbox-backend-status');
    if (el) el.textContent = '自检中…';
    try {
      const r = await window.api.sandboxProbe();
      if (r.ok) {
        if (el) el.textContent = r.readOnlyWriteDenied
          ? `✅ 只读模式自检通过：受限写入被拒绝（${r.backend}，enforcement: ${r.enforcement}）`
          : `⚠️ 自检异常：只读模式下写入未被拒绝（${r.backend}）`;
      } else {
        if (el) el.textContent = `⚠️ 自检失败：${r.error || r.detail || '未知错误'}`;
      }
    } catch (e) {
      if (el) el.textContent = '自检失败：' + (e.message || e);
    }
  });
  loadSandboxSettings();
