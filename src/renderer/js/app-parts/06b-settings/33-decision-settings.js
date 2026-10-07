  // ---- 决策模型设置页 ----
  let _decisionBound = false;
  let _decisionDiscoveryGeneration = 0;
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
    _decisionDiscoveryGeneration++;
    const cfg = (s && s.decision) || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    chk('setting-decision-enabled', cfg.enabled);
    set('setting-decision-provider', cfg.provider || 'zen');
    set('setting-decision-url', cfg.apiUrl || '');
    set('setting-decision-key', cfg.apiKey || '');
    set('setting-decision-model', cfg.model || '');
    set('setting-decision-models-url', cfg.modelsUrl || '');
    for (const type of ['noul', 'choice', 'score']) chk('setting-decision-cap-' + type, cfg.capabilities?.[type] !== false);
    const list = document.getElementById('system-one-models');
    if (list) list.replaceChildren();
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
        el.textContent = t('ui.systemOne.usage', '今日已调用: {calls}{limit} · 模型 {model}', { calls: st.callsToday || 0, limit, model: st.model || t('ui.systemOne.serverDefault', '服务端默认') });
      }
      const provider = document.getElementById('setting-decision-provider')?.value;
      const preset = st?.providers?.[provider];
      if (preset) {
        const url = document.getElementById('setting-decision-url');
        const model = document.getElementById('setting-decision-model');
        if (url) url.placeholder = preset.url || (provider === 'cloudflare' ? 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run/@cf/cloudflare/clef' : 'http://127.0.0.1:8000/v1/systemone');
        if (model) model.placeholder = preset.model || t('ui.systemOne.modelHint', '选择或输入决策模型 ID');
      }
    } catch (_) {}
  }

  function bindDecisionSettings() {
    if (_decisionBound) return;
    _decisionBound = true;
    const saveField = (id, key, transform) => {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        _decisionDiscoveryGeneration++;
        const s = await readSettings();
        if (!s.decision) s.decision = {};
        s.decision[key] = transform ? transform(e.target.value) : e.target.value;
        await saveSettings(s);
        refreshDecisionStatus().catch(() => {});
      });
    };
    document.getElementById('setting-decision-enabled')?.addEventListener('change', async (e) => {
      const s = await readSettings();
      s.decision = { ...(s.decision || {}), enabled: e.target.checked };
      await saveSettings(s);
      refreshDecisionStatus().catch(() => {});
    });
    document.getElementById('setting-decision-provider')?.addEventListener('change', async (e) => {
      const s = await readSettings();
      const provider = e.target.value;
      s.decision = { ...(s.decision || {}), provider, apiUrl: '', apiKey: '', model: '', modelsUrl: '', capabilities: { noul: true, choice: true, score: true } };
      await saveSettings(s);
      loadDecisionSettings(s);
    });
    saveField('setting-decision-url', 'apiUrl');
    saveField('setting-decision-key', 'apiKey');
    saveField('setting-decision-model', 'model');
    saveField('setting-decision-models-url', 'modelsUrl');
    for (const type of ['noul', 'choice', 'score']) {
      document.getElementById('setting-decision-cap-' + type)?.addEventListener('change', async (e) => {
        const s = await readSettings();
        s.decision = { ...(s.decision || {}), capabilities: { ...s.decision?.capabilities, [type]: e.target.checked } };
        await saveSettings(s);
      });
    }
    document.getElementById('btn-decision-models')?.addEventListener('click', async (e) => {
      const generation = ++_decisionDiscoveryGeneration;
      const status = document.getElementById('decision-models-status');
      e.currentTarget.disabled = true;
      if (status) status.textContent = t('ui.systemOne.loadingModels', '正在获取决策模型…');
      try {
        const result = await window.api.decisionModels();
        if (generation !== _decisionDiscoveryGeneration) { if (status) status.textContent = ''; return; }
        if (!result?.ok) throw new Error(result?.error || t('ui.systemOne.noModels', '服务商未提供模型列表，可手动输入模型 ID'));
        const list = document.getElementById('system-one-models');
        if (list) list.replaceChildren(...result.models.map((model) => {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.name;
          return option;
        }));
        if (status) status.textContent = result.models.length ? t('ui.systemOne.modelsFound', '找到 {count} 个决策模型，可在模型框中选择', { count: result.models.length }) : t('ui.systemOne.noModels', '服务商未提供模型列表，可手动输入模型 ID');
      } catch (error) {
        if (status) status.textContent = t('ui.systemOne.failure', '失败: {error}', { error: error.message });
      } finally { document.getElementById('btn-decision-models').disabled = false; }
    });
    saveField('setting-decision-threshold', 'confidenceThreshold', (v) => Math.max(0.05, Math.min(0.99, parseFloat(v) || 0.5)));
    saveField('setting-decision-guard', 'guardThreshold', (v) => Math.max(0.5, Math.min(0.99, parseFloat(v) || 0.85)));
    saveField('setting-decision-timeout', 'timeoutMs', (v) => Math.max(1000, Math.min(60000, parseInt(v, 10) || 8000)));
    saveField('setting-decision-limit', 'dailyMaxCalls', (v) => Math.max(0, parseInt(v, 10) || 0));
    for (const [key, id] of Object.entries(DECISION_USAGE_IDS)) {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        const s = await readSettings();
        if (!s.decision) s.decision = {};
        s.decision.usages = { ...(s.decision.usages || {}), [key]: e.target.checked };
        await saveSettings(s);
      });
    }
    document.getElementById('btn-decision-test')?.addEventListener('click', async () => {
      const statusEl = document.getElementById('decision-test-status');
      const button = document.getElementById('btn-decision-test');
      button.disabled = true;
      if (statusEl) statusEl.textContent = t('ui.systemOne.testing', '测试中…');
      try {
        const r = await window.api.decisionTest();
        if (statusEl) statusEl.textContent = r && r.ok ? t('ui.systemOne.connected', '连通正常') : t('ui.systemOne.failure', '失败: {error}', { error: r?.error || t('ui.systemOne.noResponse', '无响应') });
      } catch (e) {
        if (statusEl) statusEl.textContent = t('ui.systemOne.failure', '失败: {error}', { error: e.message });
      }
      button.disabled = false;
      refreshDecisionStatus().catch(() => {});
    });
  }
  bindDecisionSettings();

  // Theme mode
