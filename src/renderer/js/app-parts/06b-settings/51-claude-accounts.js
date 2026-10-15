  let claudeAccountState = null, claudeAvailableModels = [], claudeModelGeneration = 0;
  const claudeText = (key, fallback) => window.t('ui.claudeSubscription.' + key, fallback);
  function claudeStatusMessage(message) { document.getElementById('claude-account-status').textContent = message; }
  async function claudeAccountAction(action) {
    try { const result = await action(); if (result?.ok === false) throw new Error(result.error); return result; }
    catch (error) { claudeStatusMessage(error.message); return null; }
  }
  function renderClaudeAccounts(state) {
    claudeAccountState = state;
    const select = document.getElementById('claude-account-select');
    select.replaceChildren(new Option(claudeText('notLoggedIn', '尚未登录 Claude'), ''), ...state.accounts.map(a => new Option(a.label + ' · ' + a.plan, a.id)));
    select.value = state.activeId || '';
    document.getElementById('btn-claude-login').disabled = !!state.pending;
    document.getElementById('btn-claude-cancel').hidden = !state.pending;
    for (const id of ['btn-claude-logout', 'btn-claude-use', 'btn-claude-reauth', 'btn-claude-refresh']) document.getElementById(id).disabled = !state.activeId || !!state.pending;
    const link = document.getElementById('claude-login-url'); link.hidden = !state.pending?.url;
    if (state.pending?.url) link.href = state.pending.url; else link.removeAttribute('href');
    document.getElementById('claude-login-manual').hidden = !state.pending;
    claudeStatusMessage(state.error || (state.pending ? claudeText('pending', '请在浏览器中完成 Claude 登录…') : state.activeId ? claudeText('ready', '已登录 Claude 订阅账号') : claudeText('notLoggedIn', '尚未登录 Claude')));
    if (!state.activeId) { ++claudeModelGeneration; claudeAvailableModels = []; document.getElementById('claude-model-select').replaceChildren(); }
  }
  async function refreshClaudeModels() {
    const generation = ++claudeModelGeneration;
    const result = await claudeAccountAction(() => window.api.claudeModels());
    if (!result || generation !== claudeModelGeneration) return;
    claudeAvailableModels = result.models;
    document.getElementById('claude-model-select').replaceChildren(...result.models.map(m => new Option(m.name, m.id)));
  }
  async function refreshClaudeAccounts() {
    const state = await claudeAccountAction(() => window.api.claudeStatus());
    if (!state) return; renderClaudeAccounts(state);
    if (state.activeId && !state.pending) await refreshClaudeModels();
  }
  document.getElementById('btn-claude-login')?.addEventListener('click', () => claudeAccountAction(() => window.api.claudeLogin()));
  document.getElementById('btn-claude-reauth')?.addEventListener('click', () => claudeAccountAction(() => window.api.claudeLogin(claudeAccountState.activeId)));
  document.getElementById('btn-claude-cancel')?.addEventListener('click', () => claudeAccountAction(() => window.api.claudeCancel()));
  document.getElementById('btn-claude-refresh')?.addEventListener('click', refreshClaudeModels);
  document.getElementById('btn-claude-logout')?.addEventListener('click', async () => { await claudeAccountAction(() => window.api.claudeLogout(claudeAccountState.activeId)); await refreshClaudeAccounts(); });
  document.getElementById('claude-account-select')?.addEventListener('change', async event => { if (event.target.value) { ++claudeModelGeneration; await claudeAccountAction(() => window.api.claudeSwitch(event.target.value)); await refreshClaudeAccounts(); } });
  document.getElementById('btn-claude-code')?.addEventListener('click', async () => { const input = document.getElementById('claude-login-code'); const code = input.value; input.value = ''; await claudeAccountAction(() => window.api.claudeCode(code)); });
  document.getElementById('btn-claude-usage')?.addEventListener('click', () => window.api.openHostBrowser('https://claude.ai/settings/usage'));
  document.getElementById('claude-login-url')?.addEventListener('click', event => { event.preventDefault(); if (claudeAccountState?.pending?.url) window.api.openHostBrowser(claudeAccountState.pending.url); });
  document.getElementById('btn-claude-use')?.addEventListener('click', async () => {
    const model = claudeAvailableModels.find(m => m.id === document.getElementById('claude-model-select').value);
    if (!model || !claudeAccountState?.activeId) return;
    await claudeAccountAction(async () => {
      const settings = await readSettings(), pool = settings.llm.pool?.slice() || [];
      let entry = pool.find(e => e.provider === 'claude-subscription' && e.model === model.id);
      if (!entry) { entry = { id: 'pool-' + crypto.randomUUID(), label: model.name, provider: 'claude-subscription', model: model.id,
        apiUrl: 'claude-sdk://subscription', apiKey: '', contextLength: model.contextLength || 200000, vision: true,
        effort: 'auto', intelligence: 80, priority: 0, enabled: true }; pool.push(entry); }
      await savePool(pool, { activeEntryId: entry.id });
      claudeStatusMessage(claudeText('added', '已添加到模型池；新会话将使用此模型'));
      return { ok: true };
    });
  });
  window.api.onClaudeChanged?.(state => { ++claudeModelGeneration; renderClaudeAccounts(state); if (state.activeId && !state.pending) refreshClaudeModels(); });
  refreshClaudeAccounts();
