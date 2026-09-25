  // ---- Settings Page ----
  function updateLLMProviderFields(provider) {
    const openaiFields = document.getElementById('llm-openai-fields');
    const zenFields = document.getElementById('llm-zen-fields');
    if (!openaiFields || !zenFields) return;
    if (provider === 'opencode-zen' || provider === 'opencode-go') {
      openaiFields.classList.add('hidden');
      zenFields.classList.remove('hidden');
    } else {
      openaiFields.classList.remove('hidden');
      zenFields.classList.add('hidden');
    }
  }

  async function refreshZenModels(selectedModel) {
    const sel = document.getElementById('setting-llm-zen-model');
    const hint = document.getElementById('zen-model-hint');
    if (!sel) return;
    // provider 决定 Zen / Go 端点
    const provider = document.getElementById('setting-llm-provider')?.value || 'opencode-zen';
    const isGo = provider === 'opencode-go';
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      const res = await window.api.zenFetchModels(isGo ? 'go' : 'zen');
      if (!res || !res.ok || !Array.isArray(res.models)) {
        sel.innerHTML = '<option value="">(获取失败)</option>';
        if (hint) hint.textContent = res?.error || '获取失败，请检查 OpenCode API Key 或网络';
        return;
      }
      const FREE_KEYWORDS = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
      // Zen：免登录公共 key 时只展示免费模型；Go：订阅制，展示全部
      const keyInput = document.getElementById('setting-llm-zen-key');
      const isPublicKey = !isGo && ((keyInput?.value || '').trim() === 'public' || keyInput?.dataset?.publicKey === '1');
      let models = res.models.slice();
      if (isPublicKey) {
        models = models.filter(m => FREE_KEYWORDS.test(m.id));
      }
      models.sort((a, b) => {
        const af = FREE_KEYWORDS.test(a.id) ? 0 : 1;
        const bf = FREE_KEYWORDS.test(b.id) ? 0 : 1;
        if (af !== bf) return af - bf;
        return (a.id || '').localeCompare(b.id || '');
      });
      sel.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        const isFree = !isGo && FREE_KEYWORDS.test(m.id);
        opt.textContent = (isFree ? '[免费] ' : '') + (m.name || m.id);
        sel.appendChild(opt);
      }
      if (selectedModel) {
        // try exact match
        let matched = false;
        for (const opt of sel.options) {
          if (opt.value === selectedModel) { opt.selected = true; matched = true; break; }
        }
        if (!matched && sel.options.length > 0) {
          sel.options[0].selected = true;
        }
      }
      if (hint) hint.textContent = isGo
        ? `共 ${models.length} 个 Go 订阅模型`
        : `共 ${models.length} 个可用模型（标 [免费] 的为免费模型）`;
      updateZenFreeNotice().catch(() => {});
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
      updateZenFreeNotice().catch(() => {});
    }
  }

  // OpenAI-compat 模型列表：原生 datalist 在模型过多时无法完整展示，
  // 改为自绘可搜索可滚动的下拉面板，保证所有模型都能看到。
