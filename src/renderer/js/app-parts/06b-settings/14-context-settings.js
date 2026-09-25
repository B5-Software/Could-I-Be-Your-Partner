  // ---- 上下文压缩设置（水位线策略）----
  async function loadContextCompactionSettings() {
    const s = await window.api.getSettings();
    const c = s.contextCompaction || {};
    const autoEl = document.getElementById('setting-context-auto');
    const thEl = document.getElementById('setting-context-threshold');
    const thVal = document.getElementById('setting-context-threshold-val');
    const rtEl = document.getElementById('setting-context-retain');
    const rtVal = document.getElementById('setting-context-retain-val');
    const retriesEl = document.getElementById('setting-context-retries');
    const maxTEl = document.getElementById('setting-context-max-tokens');
    if (autoEl) autoEl.checked = c.enabled !== false;
    if (thEl) {
      thEl.value = String(Math.round((Number(c.thresholdRatio) || 0.80) * 100));
      if (thVal) thVal.textContent = `${thEl.value}%`;
    }
    if (rtEl) {
      rtEl.value = String(Math.round((Number(c.retainRatio) || 0.16) * 100));
      if (rtVal) rtVal.textContent = `${rtEl.value}%`;
    }
    if (retriesEl) retriesEl.value = String(c.compactionRetries ?? 1);
    if (maxTEl) maxTEl.value = String(c.summarizeMaxTokens ?? 2048);
  }
  async function updateContextCompactionSettings(patch, toast) {
    const s = await window.api.getSettings();
    if (!s.contextCompaction || typeof s.contextCompaction !== 'object') s.contextCompaction = {};
    Object.assign(s.contextCompaction, patch);
    await saveSettings(s);
    if (toast) window.showToast?.(toast, 'success', 2000);
  }
  // 滑动条指示器实时跟随拖动（input 事件），保存仍走 change（释放时落盘）
  function bindRangeIndicator(rangeId, valId, min, max) {
    const range = document.getElementById(rangeId);
    const val = document.getElementById(valId);
    if (!range || !val) return;
    range.addEventListener('input', () => {
      const v = Math.max(min, Math.min(max, Number(range.value) || min));
      val.textContent = `${v}%`;
    });
  }
  bindRangeIndicator('setting-context-threshold', 'setting-context-threshold-val', 60, 95);
  bindRangeIndicator('setting-context-retain', 'setting-context-retain-val', 5, 40);
  document.getElementById('setting-context-auto')?.addEventListener('change', async (e) => {
    await updateContextCompactionSettings({ enabled: !!e.target.checked }, '上下文自动压缩已' + (e.target.checked ? '开启' : '关闭'));
  });
  document.getElementById('setting-context-threshold')?.addEventListener('change', async (e) => {
    const pct = Math.max(60, Math.min(95, Number(e.target.value) || 80));
    e.target.value = String(pct);
    const valEl = document.getElementById('setting-context-threshold-val');
    if (valEl) valEl.textContent = `${pct}%`;
    await updateContextCompactionSettings({ thresholdRatio: pct / 100 });
  });
  document.getElementById('setting-context-retain')?.addEventListener('change', async (e) => {
    const pct = Math.max(5, Math.min(40, Number(e.target.value) || 16));
    e.target.value = String(pct);
    const valEl = document.getElementById('setting-context-retain-val');
    if (valEl) valEl.textContent = `${pct}%`;
    await updateContextCompactionSettings({ retainRatio: pct / 100 });
  });
  document.getElementById('setting-context-retries')?.addEventListener('change', async (e) => {
    const v = Math.max(0, Math.min(5, Number(e.target.value) || 1));
    e.target.value = String(v);
    await updateContextCompactionSettings({ compactionRetries: v });
  });
  document.getElementById('setting-context-max-tokens')?.addEventListener('change', async (e) => {
    const v = Math.max(512, Math.min(8192, Number(e.target.value) || 2048));
    e.target.value = String(v);
    await updateContextCompactionSettings({ summarizeMaxTokens: v });
  });
  document.getElementById('btn-context-compact-now')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('context-compact-status');
    const targetAgent = (typeof currentMode !== 'undefined' && currentMode === 'code') ? codeAgent
      : ((typeof currentMode !== 'undefined' && currentMode === 'babe') ? babeAgent : agent);
    const cm = targetAgent?.contextManager;
    if (!cm) {
      if (statusEl) statusEl.textContent = '当前无可压缩的会话上下文';
      return;
    }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = '正在压缩…';
    try {
      const res = await cm.summarizeWithLLM({
        sessionKey: targetAgent.sessionKey || null,
        tools: targetAgent.getRuntimeToolSchemas?.() || null
      });
      if (statusEl) {
        const stats = cm.getStats();
        statusEl.textContent = res.skipped
          ? `跳过：${res.message}（当前占用 ${stats.usageWithReserve ?? stats.usage}%）`
          : `${res.message}（当前占用 ${stats.usageWithReserve ?? stats.usage}%）`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = '压缩失败：' + (err.message || err);
    } finally {
      btn.disabled = false;
    }
  });
  loadContextCompactionSettings();
