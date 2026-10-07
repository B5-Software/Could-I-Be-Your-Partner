  let chatGPTState = null;
  let chatGPTModelGeneration = 0;
  let chatGPTModels = [];
  const chatGPTErrors = {
    'No usage-limit reset credits are available': '没有可用的额度重置卡', 'ChatGPT account changed': 'ChatGPT 账号已变更',
    'This reset credit is unavailable or expired': '此重置卡不可用或已过期', 'A reset request is already pending': '正在处理另一个重置请求',
    'Codex quota reader is unavailable. Install the official Codex CLI or set CIBYP_CODEX_BINARY to its executable': '额度读取器不可用；请安装官方 Codex CLI，或配置 CIBYP_CODEX_BINARY',
    'This login provides no readable subscription limits; view and manage usage in ChatGPT': '当前登录方式未提供可读取的订阅额度；请在 ChatGPT 用量管理中查看和调整。这不影响使用模型。',
    'Add your OpenCode Go API key in Model & connection settings': '请在模型与连接设置中添加 OpenCode Go API Key',
    'OpenCode Go key is invalid': 'OpenCode Go Key 无效', 'OpenCode Go subscription is required': '需要 OpenCode Go 订阅',
  };
  const chatGPTText = text => { text = chatGPTErrors[text] || text; return typeof _i18nDict !== 'undefined' ? (_i18nDict._textMap?.[text] || text) : text; };
  const chatGPTStatusText = text => { const el = document.getElementById('chatgpt-account-status'); if (el) el.textContent = chatGPTText(text); };
  async function refreshChatGPTAccounts() {
    try {
      const state = await window.api.chatGPTStatus();
      if (state.ok === false) throw new Error(state.error);
      renderChatGPTAccounts(state);
      if (state.activeId && !state.pending) { await refreshChatGPTModels(); refreshChatGPTLimits(); }
    } catch (error) { chatGPTStatusText(error.message); }
  }
  function renderChatGPTAccounts(state) {
    chatGPTState = state;
    const select = document.getElementById('chatgpt-account-select');
    if (!select) return;
    select.replaceChildren(new Option(chatGPTText('选择已保存账号'), ''), ...state.accounts.map(account => new Option(`${account.label} · ${account.id.slice(-6)}${account.signedIn ? '' : ' · ' + chatGPTText('已注销')}`, account.id)));
    select.value = state.activeId || '';
    document.getElementById('btn-chatgpt-cancel').hidden = !state.pending;
    document.getElementById('btn-chatgpt-login').disabled = !!state.pending;
    document.getElementById('btn-chatgpt-logout').disabled = !state.activeId;
    document.getElementById('btn-chatgpt-reauth').disabled = !select.value || !!state.pending;
    document.getElementById('btn-chatgpt-use').disabled = !state.activeId || !!state.pending;
    document.getElementById('btn-chatgpt-limits').disabled = !state.activeId || !!state.pending;
    const active = state.accounts.find(account => account.id === state.activeId);
    chatGPTStatusText(state.error || (state.pending ? state.pending.stage === 'verifying' ? '正在验证账号…' : '请在浏览器中完成 ChatGPT 登录…' : active ? active.planEnabled ? '已登录，订阅授权已启用' : '已登录，但未授权订阅额度；请重新授权' : '尚未登录 ChatGPT'));
    if (!active) { chatGPTModels = []; document.getElementById('chatgpt-model-select').replaceChildren(new Option(chatGPTText('登录后获取'), '')); document.getElementById('chatgpt-quota-windows').replaceChildren(); }
  }
  async function refreshChatGPTModels() {
    const generation = ++chatGPTModelGeneration;
    const select = document.getElementById('chatgpt-model-select');
    const old = select.value;
    const result = await window.api.chatGPTModels();
    if (generation !== chatGPTModelGeneration) return;
    if (!result.ok) { chatGPTStatusText(result.error); return; }
    chatGPTModels = result.models;
    select.replaceChildren(...(result.models.length ? result.models.map(model => new Option(model.name || model.id, model.id)) : [new Option(chatGPTText('账号没有可用模型'), '')]));
    if (result.models.some(model => model.id === old)) select.value = old;
  }
  async function chatGPTAction(action) {
    try { const result = await action(); if (result?.ok === false) throw new Error(result.error); return result; }
    catch (error) { chatGPTStatusText(error.message); return null; }
  }
  document.getElementById('btn-chatgpt-login')?.addEventListener('click', () => chatGPTAction(() => window.api.chatGPTLogin()));
  document.getElementById('btn-chatgpt-reauth')?.addEventListener('click', () => {
    const id = document.getElementById('chatgpt-account-select').value;
    if (id) chatGPTAction(() => window.api.chatGPTLogin(id));
  });
  document.getElementById('btn-chatgpt-cancel')?.addEventListener('click', () => chatGPTAction(() => window.api.chatGPTCancel()));
  document.getElementById('chatgpt-account-select')?.addEventListener('change', async event => {
    const account = chatGPTState?.accounts.find(account => account.id === event.target.value);
    if (!account) return;
    ++chatGPTModelGeneration;
    chatGPTModels = []; document.getElementById('chatgpt-quota-windows').replaceChildren();
    const result = await chatGPTAction(() => account.signedIn ? window.api.chatGPTSwitch(account.id) : window.api.chatGPTLogin(account.id));
    if (result?.ok) refreshChatGPTAccounts();
  });
  document.getElementById('btn-chatgpt-logout')?.addEventListener('click', async () => {
    ++chatGPTModelGeneration;
    const result = await chatGPTAction(() => window.api.chatGPTLogout(document.getElementById('chatgpt-account-select').value));
    if (result?.ok) { await refreshChatGPTAccounts(); if (!result.revoked) chatGPTStatusText('已在本机注销；远端撤销未确认，可在 ChatGPT 设置中断开授权'); }
  });
  document.getElementById('btn-chatgpt-use')?.addEventListener('click', async () => {
    const model = chatGPTModels.find(model => model.id === document.getElementById('chatgpt-model-select').value);
    if (!model || !chatGPTState?.activeId) return;
    await chatGPTAction(async () => {
      const settings = await readSettings();
      const pool = settings.llm.pool?.slice() || [];
      let entry = pool.find(entry => entry.provider === 'chatgpt-codex' && entry.model === model.id);
      if (!entry) { entry = { id: 'pool-' + crypto.randomUUID(), provider: 'chatgpt-codex', model: model.id, label: model.name, apiUrl: 'https://api.openai.com/v1/responses', apiKey: '', contextLength: model.contextLength || 131072, vision: !!model.vision, effort: 'auto', intelligence: 80, priority: 0, enabled: true }; pool.push(entry); }
      await savePool(pool, { activeEntryId: entry.id });
      document.getElementById('setting-llm-provider').value = 'chatgpt-codex'; updateLLMProviderFields('chatgpt-codex');
      chatGPTStatusText('已添加到模型池并设为默认；新会话将使用此模型'); return { ok: true };
    });
  });
  document.getElementById('btn-chatgpt-usage')?.addEventListener('click', () => chatGPTAction(() => window.api.openHostBrowser('https://chatgpt.com/settings/usage')));
  async function refreshChatGPTLimits() {
    const button = document.getElementById('btn-chatgpt-limits'); button.disabled = true;
    const active = chatGPTState?.activeId;
    try {
      const result = await window.api.chatGPTLimits();
      if (active !== chatGPTState?.activeId) return;
      const container = document.getElementById('chatgpt-quota-windows'); container.replaceChildren();
      if (!result.ok) { container.textContent = chatGPTText(result.error); return; }
      if (result.unavailable) { container.textContent = chatGPTText(result.message); container.classList.add('setting-hint'); return; }
      const buckets = Object.values(result.rateLimitsByLimitId || (result.rateLimits ? { codex: result.rateLimits } : {}));
      for (const bucket of buckets) for (const window of [bucket.primary, bucket.secondary].filter(Boolean)) {
        const row = document.createElement('div'); row.className = 'chatgpt-quota-row';
        const label = document.createElement('span'); const progress = document.createElement('progress'); const details = document.createElement('span');
        label.textContent = `${bucket.limitName || bucket.limitId || 'Codex'} · ${window.windowDurationMins === 300 ? chatGPTText('5 小时') : window.windowDurationMins === 10080 ? chatGPTText('每周') : window.windowDurationMins + ' min'}`;
        if (Number.isFinite(window.usedPercent)) { progress.max = 100; progress.value = Math.max(0, Math.min(100, window.usedPercent)); details.textContent = `${(100-progress.value).toFixed(0)}% ${chatGPTText('剩余')}`; } else details.textContent = chatGPTText('额度不可用');
        if (window.resetsAt) details.textContent += ' · ' + new Date(window.resetsAt * 1000).toLocaleString();
        row.append(label, progress, details); container.append(row);
      }
      if (!container.children.length) container.textContent = chatGPTText('账号暂未提供额度数据');
      const credits = result.rateLimitResetCredits;
      if (credits?.availableCount > 0) {
        const cards = credits.credits?.filter(card => card.status === 'available') || [];
        for (const card of cards.length ? cards : [null]) {
          const row = document.createElement('div'); row.className = 'chatgpt-reset-credit';
          const label = document.createElement('span'); label.textContent = `${chatGPTText('额度重置卡')} · ${card?.title || card?.resetType || credits.availableCount}${card?.expiresAt ? ' · ' + new Date(card.expiresAt * 1000).toLocaleString() : ''}`;
          const use = document.createElement('button'); use.className = 'btn-secondary'; use.textContent = chatGPTText('使用重置卡…');
          use.addEventListener('click', async event => {
            if (!event.isTrusted || use.disabled) return;
            use.disabled = true;
            try {
              const response = await window.api.chatGPTConsumeReset({ accountId: active, creditId: card?.id });
              if (active !== chatGPTState?.activeId || response.cancelled) return;
              chatGPTStatusText(response.ok ? response.redemption?.outcome === 'reset' ? '额度已重置' : response.redemption?.outcome === 'alreadyRedeemed' ? '此重置请求已完成' : '服务端未执行重置，请刷新额度' : response.error);
              await refreshChatGPTLimits();
            } finally { use.disabled = false; }
          }); row.append(label, use); container.append(row);
        }
      }
    } catch (error) { if (active === chatGPTState?.activeId) document.getElementById('chatgpt-quota-windows').textContent = error.message; } finally { button.disabled = !chatGPTState?.activeId || !!chatGPTState?.pending; }
  }
  document.getElementById('btn-chatgpt-limits')?.addEventListener('click', refreshChatGPTLimits);
  let subscriptionWindowsGeneration = 0;
  async function refreshSubscriptionWindows(force = false) {
    const generation = ++subscriptionWindowsGeneration;
    const button = document.getElementById('btn-subscription-usage-refresh');
    const container = document.getElementById('subscription-usage-windows');
    if (!button || !container) return;
    button.disabled = true;
    try {
      const result = await window.api.subscriptionUsage({ includeWindows: true, force });
      if (generation !== subscriptionWindowsGeneration) return;
      container.replaceChildren();
      if (!result.subscription) { document.getElementById('subscription-usage-settings').hidden = true; return; }
      for (const quota of result.windows || []) {
        const row = document.createElement('div'); row.className = 'chatgpt-quota-row';
        const label = document.createElement('span'); const progress = document.createElement('progress'); const details = document.createElement('span');
        label.textContent = (quota.label || '') + ' · ' + chatGPTText(quota.period === '5hour' ? '5 小时' : quota.period === 'weekly' ? '每周' : quota.period === 'monthly' ? '每月' : '额度');
        progress.max = 100; progress.value = quota.usedPercent;
        details.textContent = (100 - quota.usedPercent).toFixed(0) + '% ' + chatGPTText('剩余') + (quota.resetsAt ? ' · ' + chatGPTText('重置时间') + ': ' + new Date(quota.resetsAt).toLocaleString(_i18nLang || 'zh-CN') : '');
        row.append(label, progress, details); container.append(row);
      }
      if (!container.children.length) container.textContent = chatGPTText(result.error || '账号暂未提供对应额度数据');
    } catch (error) { if (generation === subscriptionWindowsGeneration) container.textContent = chatGPTText(error.message); }
    finally { if (generation === subscriptionWindowsGeneration) button.disabled = false; }
  }
  document.getElementById('btn-subscription-usage-refresh')?.addEventListener('click', () => refreshSubscriptionWindows(true));
  window.api.onChatGPTChanged?.(state => {
    ++chatGPTModelGeneration; renderChatGPTAccounts(state);
    if (state.activeId && !state.pending) { refreshChatGPTModels().catch(error => chatGPTStatusText(error.message)); refreshChatGPTLimits(); if (document.getElementById('ob-llm-provider')?.value === 'chatgpt-codex') refreshObModels(); }
  });
  document.getElementById('ob-btn-chatgpt-login')?.addEventListener('click', async () => {
    const result = await window.api.chatGPTLogin();
    if (!result.ok) document.getElementById('ob-model-hint').textContent = result.error;
    else document.getElementById('ob-model-hint').textContent = chatGPTText('请在浏览器中完成 ChatGPT 登录…');
  });
  let autoPricingGeneration = 0;
  async function refreshAutoPricing(force = false) {
    const generation = ++autoPricingGeneration; const status = document.getElementById('model-auto-pricing');
    if (!status) return;
    try {
      const settings = await readSettings(); const result = await window.api.llmPricing(settings.llm.model, settings.llm.provider, force);
      if (generation !== autoPricingGeneration) return;
      const price = result.price || {};
      status.textContent = result.source === 'unknown' ? chatGPTText('自动价格暂不可用；可填写手动价格') : `${settings.llm.model} · ${chatGPTText(result.source === 'override' ? '手动覆盖' : '自动价格')} · ${chatGPTText('输入')} $${price.inputPerM ?? '—'} / ${chatGPTText('缓存')} $${price.cacheReadPerM ?? '—'} / ${chatGPTText('输出')} $${price.outputPerM ?? '—'} / 1M tokens${result.apiReference ? ' · ' + chatGPTText('API 参考价；订阅不按此扣费') : ''}`;
    } catch (error) { if (generation === autoPricingGeneration) status.textContent = error.message; }
  }
  document.getElementById('btn-model-auto-pricing')?.addEventListener('click', () => refreshAutoPricing(true));
