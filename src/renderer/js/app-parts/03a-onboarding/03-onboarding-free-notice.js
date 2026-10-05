  function updateObFreeNotice() {
    const model = obModels.find((entry) => entry.id === obConfig().model);
    document.getElementById('ob-model-detail').textContent = model
      ? `${model.id}${model.contextLength ? ' · ' + Math.round(model.contextLength / 1000) + (model.free ? 'K 渠道上下文上限' : 'K 上下文') : ''}${model.vision ? ' · 视觉输入' : ''}` : '';
  }
  for (const id of ['ob-llm-provider', 'ob-llm-zen-key', 'ob-llm-url', 'ob-llm-key']) {
    document.getElementById(id)?.addEventListener('change', () => {
      if (id === 'ob-llm-provider') { obPreferredModel = ''; updateObProviderFields(document.getElementById(id).value); }
      refreshObModels();
    });
  }
  document.getElementById('ob-btn-refresh-models')?.addEventListener('click', refreshObModels);
  document.getElementById('ob-free-only')?.addEventListener('change', () => renderObModels(document.getElementById('ob-llm-model').value));
  document.getElementById('ob-llm-model')?.addEventListener('change', () => { updateObFreeNotice(); document.getElementById('ob-connection-status').textContent = ''; });
  document.getElementById('ob-llm-model-id')?.addEventListener('change', (event) => {
    const id = event.target.value.trim();
    if (!id) return;
    ++obModelsGeneration;
    obPreferredModel = '';
    document.getElementById('ob-btn-refresh-models').disabled = false;
    document.getElementById('ob-btn-finish').disabled = obSaving;
    const select = document.getElementById('ob-llm-model');
    if (![...select.options].some((option) => option.value === id)) select.add(new Option(id, id));
    select.disabled = false; select.value = id; updateObFreeNotice();
  });
  document.getElementById('ob-btn-test')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = document.getElementById('ob-connection-status');
    const generation = obModelsGeneration;
    const config = obConfig();
    if (!config.model) { status.textContent = '请先选择模型'; return; }
    button.disabled = true; status.textContent = '正在验证…';
    try {
      const result = await window.api.llmProbe(config);
      if (generation !== obModelsGeneration || config.model !== obConfig().model) return;
      status.textContent = result.ok ? '连接成功，可以开始对话' : '连接失败：' + result.error;
      status.dataset.state = result.ok ? 'success' : 'error';
    } catch (error) { status.textContent = '连接失败：' + error.message; status.dataset.state = 'error'; }
    finally { button.disabled = false; }
  });
  async function obPickAvatar(target) {
    try {
      const result = await window.api.avatarPickAndEncode(target === 'ai' ? 'aiPersona' : 'userProfile');
      if (!result?.ok || (!result.path && !result.dataUrl)) return;
      const preview = document.getElementById('ob-' + target + '-avatar-preview');
      const image = document.createElement('img'); image.src = result.dataUrl || result.path; image.alt = '';
      preview.replaceChildren(image); preview.dataset.avatar = result.path || result.dataUrl;
    } catch (error) { window.showToast('无法选择头像：' + error.message, 'error'); }
  }
  for (const target of ['ai', 'user']) {
    document.getElementById('ob-btn-' + target + '-avatar')?.addEventListener('click', () => obPickAvatar(target));
    document.getElementById('ob-btn-' + target + '-avatar-clear')?.addEventListener('click', () => {
      const preview = document.getElementById('ob-' + target + '-avatar-preview');
      preview.innerHTML = `<i class="fa-solid fa-${target === 'ai' ? 'user-astronaut' : 'user'}"></i>`; preview.dataset.avatar = '';
    });
  }
  document.getElementById('ob-btn-finish')?.addEventListener('click', async () => {
    if (obSaving) return;
    const llm = obConfig();
    if (!llm.model || !llm.apiUrl) { window.showToast('请选择模型并填写 API 地址', 'error'); return; }
    obSaving = true;
    const button = document.getElementById('ob-btn-finish'); button.disabled = true;
    try {
      if (llm.provider === 'opencode-zen' || llm.provider === 'chatgpt-codex') {
        const check = await window.api.llmProbe(llm);
        if (!check.ok) { document.getElementById('ob-connection-status').textContent = '连接失败：' + check.error; document.getElementById('ob-connection-status').dataset.state = 'error'; if (llm.provider === 'opencode-zen') await refreshObModels(); return; }
      }
      const s = await window.api.getSettings();
      const value = (id) => document.getElementById(id).value.trim();
      const aiPersona = { ...s.aiPersona, name: value('ob-ai-name') || 'Partner', pronouns: value('ob-ai-pronouns') || 'Ta', personality: value('ob-ai-personality'), customPrompt: value('ob-ai-persona'), avatar: document.getElementById('ob-ai-avatar-preview').dataset.avatar || '' };
      const userProfile = { ...s.userProfile, name: value('ob-user-name') || agent.systemInfo?.username || '用户', avatar: document.getElementById('ob-user-avatar-preview').dataset.avatar || '' };
      const metadata = obModels.find((model) => model.id === llm.model);
      const pool = Array.isArray(s.llm?.pool) ? s.llm.pool.slice() : [];
      const existing = pool.find((entry) => entry.provider === llm.provider && entry.model === llm.model && entry.apiKey === llm.apiKey);
      const id = existing?.id || 'pool-' + crypto.randomUUID();
      const entry = { ...existing, id, label: metadata?.name || llm.model, ...llm, contextLength: metadata?.contextLength || 131072, providerLimits: metadata?.providerLimits || null, vision: metadata?.vision || false, enabled: true, intelligence: existing?.intelligence ?? 50, priority: existing?.priority ?? 0, effort: 'off' };
      if (existing) pool[pool.indexOf(existing)] = entry; else pool.push(entry);
      const patch = { aiPersona, userProfile, llm: { ...s.llm, ...llm, pool, activeEntryId: id, maxContextLength: entry.contextLength, maxContextLengthExplicit: false }, onboardingCompleted: true };
      await window.api.setSettings(patch);
      const saved = await window.api.getSettings();
      if (typeof agent.applySettings === 'function') agent.applySettings(saved); else agent.settings = saved;
      if (typeof updatePersonaDisplay === 'function') updatePersonaDisplay(aiPersona);
      fadeOutHide(document.getElementById('onboarding-modal'));
      try { await window.api.webControlSetAvatars(aiPersona.avatar, userProfile.avatar); } catch { /* optional mirror */ }
    } catch (error) { window.showToast('保存失败：' + error.message, 'error'); }
    finally { obSaving = false; button.disabled = false; }
  });
  showOnboardingIfNeeded();
