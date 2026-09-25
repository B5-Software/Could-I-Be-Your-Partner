  const ocAutoEl = document.getElementById('setting-llm-oc-auto');
  if (ocAutoEl) {
    ocAutoEl.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.llm.autoOpencodeHeaders = e.target.checked;
      await saveSettings(s);
    });
  }

  // Provider selection — switches between OpenAI-compat and Zen/Go fields
  document.getElementById('setting-llm-provider').addEventListener('change', async (e) => {
    const provider = e.target.value;
    const s = await window.api.getSettings();
    s.llm.provider = provider;
    // When switching to Zen/Go, persist a sensible default apiUrl/model
    if (provider === 'opencode-zen') {
      if (!s.llm.model || !s.llm.model.startsWith('gpt-') && !s.llm.model.startsWith('claude-') &&
          !s.llm.model.startsWith('qwen') && !s.llm.model.startsWith('deepseek') &&
          !s.llm.model.startsWith('kimi') && !s.llm.model.startsWith('glm-') &&
          !s.llm.model.startsWith('big-pickle') && !s.llm.model.startsWith('mimo') &&
          !s.llm.model.startsWith('north-mini') && !s.llm.model.startsWith('nemotron') &&
          !s.llm.model.startsWith('gemini') && !s.llm.model.startsWith('minimax') &&
          !s.llm.model.startsWith('grok-')) {
        s.llm.model = 'big-pickle';
      }
    } else if (provider === 'opencode-go') {
      if (!s.llm.model || !s.llm.model.startsWith('glm-') && !s.llm.model.startsWith('kimi-') &&
          !s.llm.model.startsWith('deepseek') && !s.llm.model.startsWith('minimax-') &&
          !s.llm.model.startsWith('qwen') && !s.llm.model.startsWith('mimo-') &&
          !s.llm.model.startsWith('grok-') && !s.llm.model.startsWith('gpt-5') &&
          !s.llm.model.startsWith('muse-') && !s.llm.model.startsWith('hy') &&
          !s.llm.model.startsWith('longcat-') && !s.llm.model.startsWith('omen-')) {
        s.llm.model = 'glm-5.3-flash';
      }
    }
    await saveSettings(s);
    updateLLMProviderFields(provider);
    refreshReasoningVariants();
    if (provider === 'opencode-zen' || provider === 'opencode-go') {
      await refreshZenModels(s.llm.model);
      // sync zen-model dropdown with current model
      const zenSel = document.getElementById('setting-llm-zen-model');
      if (zenSel) zenSel.value = s.llm.model;
      updateZenFreeNotice().catch(() => {});
    } else {
      // restore model field text
      const modelEl = document.getElementById('setting-llm-model');
      if (modelEl) modelEl.value = s.llm.model || '';
      updateZenFreeNotice().catch(() => {});
    }
  });

  // Zen API key
  document.getElementById('setting-llm-zen-key').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.zenApiKey = e.target.value.trim();
    // 用户手动改 key 时清除 public 标记
    if (e.target.value.trim() === 'public') {
      e.target.dataset.publicKey = '1';
    } else {
      delete e.target.dataset.publicKey;
    }
    await saveSettings(s);
    // refresh models with new key
    await refreshZenModels(s.llm.model);
  });

  // Zen model select — sync to llm.model
  document.getElementById('setting-llm-zen-model').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.model = e.target.value;
    await saveSettings(s);
    refreshReasoningVariants();
    updateZenFreeNotice().catch(() => {});
  });

  // Zen refresh button
  const zenRefreshBtn = document.getElementById('btn-zen-refresh');
  if (zenRefreshBtn) zenRefreshBtn.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    await refreshZenModels(s.llm.model);
  });

  // Zen 生成免登录公共 Key（public，限免模型可用）
  const zenGenKeyBtn = document.getElementById('btn-zen-generate-key');
  if (zenGenKeyBtn) zenGenKeyBtn.addEventListener('click', async () => {
    const keyInput = document.getElementById('setting-llm-zen-key');
    if (!keyInput) return;
    // 使用 opencode 内置的免登录公共 key："public"（仅可调用限时免费模型）
    keyInput.value = 'public';
    keyInput.dataset.publicKey = '1';
    const s = await window.api.getSettings();
    s.llm.zenApiKey = 'public';
    s.llm.provider = 'opencode-zen';
    s.llm.apiUrl = 'https://opencode.ai/zen/v1/chat/completions';
    await saveSettings(s);
    // 同步接入方式下拉框显示（当前可能停留在其他选项）
    const providerSel = document.getElementById('setting-llm-provider');
    if (providerSel) providerSel.value = 'opencode-zen';
    updateLLMProviderFields('opencode-zen');
    // 刷新模型列表，过滤为仅显示免费模型
    await refreshZenModels(s.llm.model);
    const hint = document.getElementById('zen-model-hint');
    if (hint) hint.textContent = '已使用免登录公共 Key（public），仅可调用限时免费模型';
  });

  // OpenAI/Anthropic compatible models refresh button
  const llmRefreshBtn = document.getElementById('btn-llm-refresh-models');
  if (llmRefreshBtn) llmRefreshBtn.addEventListener('click', () => refreshLLMModels());

  // 模型下拉：聚焦/输入时展示并过滤，点击选项回填，点击外部/Esc 关闭
  const llmModelInput = document.getElementById('setting-llm-model');
  const llmModelFilter = document.getElementById('llm-model-filter');
  const llmModelField = document.getElementById('llm-model-field');
  if (llmModelInput && llmModelField) {
    llmModelInput.addEventListener('focus', () => {
      if (llmFetchedModels.length) showLlmModelDropdown(true);
    });
    llmModelInput.addEventListener('input', () => {
      if (llmFetchedModels.length) showLlmModelDropdown(false);
    });
    llmModelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideLlmModelDropdown();
    });
  }
  if (llmModelFilter) {
    llmModelFilter.addEventListener('input', () => renderLlmModelOptions(llmModelFilter.value));
    llmModelFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideLlmModelDropdown(); llmModelInput?.focus(); }
    });
  }
