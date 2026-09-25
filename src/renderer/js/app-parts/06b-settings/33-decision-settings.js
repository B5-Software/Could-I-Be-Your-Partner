  // ---- 决策模型设置页 ----
  let _decisionBound = false;
  const DECISION_USAGE_IDS = {
    modelRouting: 'setting-decision-use-model',
    reasoningRouting: 'setting-decision-use-effort',
    toolSelection: 'setting-decision-use-tools',
    commandGuard: 'setting-decision-use-guard',
    gameDecisions: 'setting-decision-use-games',
    llmTool: 'setting-decision-use-llm-tool',
    emailIntent: 'setting-decision-use-email',
    contextRetention: 'setting-decision-use-context',
  };

  function loadDecisionSettings(s) {
    const cfg = (s && s.decision) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    chk('setting-decision-enabled', cfg.enabled);
    set('setting-decision-provider', cfg.provider === 'typesafe' ? 'typesafe' : 'zen');
    set('setting-decision-url', cfg.apiUrl || '');
    set('setting-decision-key', cfg.apiKey || '');
    set('setting-decision-model', cfg.model || '');
    set('setting-decision-threshold', cfg.confidenceThreshold != null ? cfg.confidenceThreshold : 0.5);
    set('setting-decision-guard', cfg.guardThreshold != null ? cfg.guardThreshold : 0.85);
    set('setting-decision-timeout', cfg.timeoutMs != null ? cfg.timeoutMs : 8000);
    set('setting-decision-limit', cfg.dailyMaxCalls != null ? cfg.dailyMaxCalls : 0);
    const usages = cfg.usages || {};
    for (const [key, id] of Object.entries(DECISION_USAGE_IDS)) chk(id, usages[key] !== false);
    refreshDecisionStatus().catch(() => {});
  }

  async function refreshDecisionStatus() {
    try {
      const st = await window.api.decisionStatus();
      const el = document.getElementById('decision-usage');
      if (el && st && st.ok) {
        const limit = st.dailyMaxCalls > 0 ? ` / ${st.dailyMaxCalls}` : '';
        el.textContent = `今日已调用: ${st.callsToday || 0}${limit} · 模型 ${st.model}`;
      }
    } catch (_) {}
  }

  function bindDecisionSettings() {
    if (_decisionBound) return;
    _decisionBound = true;
    const saveField = (id, key, transform) => {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        const s = await window.api.getSettings();
        if (!s.decision) s.decision = {};
        s.decision[key] = transform ? transform(e.target.value) : e.target.value;
        await saveSettings(s);
      });
    };
    document.getElementById('setting-decision-enabled')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.decision = { ...(s.decision || {}), enabled: e.target.checked };
      await saveSettings(s);
      refreshDecisionStatus().catch(() => {});
    });
    document.getElementById('setting-decision-provider')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      const provider = e.target.value === 'typesafe' ? 'typesafe' : 'zen';
      s.decision = { ...(s.decision || {}), provider, apiUrl: '', model: '' };
      await saveSettings(s);
      loadDecisionSettings(s);
    });
    saveField('setting-decision-url', 'apiUrl');
    saveField('setting-decision-key', 'apiKey');
    saveField('setting-decision-model', 'model');
    saveField('setting-decision-threshold', 'confidenceThreshold', (v) => Math.max(0.05, Math.min(0.99, parseFloat(v) || 0.5)));
    saveField('setting-decision-guard', 'guardThreshold', (v) => Math.max(0.5, Math.min(0.99, parseFloat(v) || 0.85)));
    saveField('setting-decision-timeout', 'timeoutMs', (v) => Math.max(1000, Math.min(60000, parseInt(v, 10) || 8000)));
    saveField('setting-decision-limit', 'dailyMaxCalls', (v) => Math.max(0, parseInt(v, 10) || 0));
    for (const [key, id] of Object.entries(DECISION_USAGE_IDS)) {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        const s = await window.api.getSettings();
        if (!s.decision) s.decision = {};
        s.decision.usages = { ...(s.decision.usages || {}), [key]: e.target.checked };
        await saveSettings(s);
      });
    }
    document.getElementById('btn-decision-test')?.addEventListener('click', async () => {
      const statusEl = document.getElementById('decision-test-status');
      if (statusEl) statusEl.textContent = '测试中…';
      try {
        const r = await window.api.decisionTest();
        if (statusEl) statusEl.textContent = r && r.ok ? `连通正常（概率 ${Number(r.probability).toFixed(3)}）` : `失败: ${(r && r.error) || '无响应'}`;
      } catch (e) {
        if (statusEl) statusEl.textContent = '失败: ' + e.message;
      }
      refreshDecisionStatus().catch(() => {});
    });
  }
  bindDecisionSettings();

  // Theme mode
