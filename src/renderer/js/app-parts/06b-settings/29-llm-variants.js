  document.addEventListener('click', (e) => {
    if (llmModelField && !llmModelField.contains(e.target)) hideLlmModelDropdown();
  });

  // Zen auth link
  const zenAuthLink = document.getElementById('link-zen-auth');
  if (zenAuthLink) zenAuthLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openBrowser('https://opencode.ai/auth');
  });

  // Reasoning effort
  document.getElementById('setting-llm-reasoning').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.reasoningEffort = e.target.value;
    await saveSettings(s);
  });

  // 动态变体档位：按当前 provider+model 查询可用档位，重绘下拉框并收敛非法值
  const VARIANT_LABEL_FALLBACK = {
    off: '关闭', auto: '自动（模型默认）', none: '无推理', minimal: '极低',
    low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高'
  };
  async function refreshReasoningVariants() {
    const el = document.getElementById('setting-llm-reasoning');
    if (!el) return;
    const s = await window.api.getSettings();
    const provider = s.llm.provider || 'openai-compat';
    const model = s.llm.model || '';
    let variants = null;
    let defaultId = 'off';
    let contextLength = null;
    try {
      const apiUrl = provider === 'opencode-zen' ? '' : (s.llm.apiUrl || '');
      const apiKey = provider === 'opencode-zen' ? (s.llm.zenApiKey || '') : (s.llm.apiKey || '');
      const res = await window.api.llmCapabilities?.(provider, model, apiUrl, apiKey);
      if (res && res.ok && Array.isArray(res.variants) && res.variants.length > 0) {
        variants = res.variants;
        defaultId = res.defaultId || 'off';
      }
      if (res && res.ok && res.contextLength) contextLength = res.contextLength;
    } catch (_) { /* 网络/端点失败：走本地兜底 */ }
    // 上下文长度：仅当用户未手动改过（空或默认 131072）时用 API 元数据补全
    const ctxEl = document.getElementById('setting-llm-ctx');
    if (ctxEl && contextLength && (!ctxEl.value || Number(ctxEl.value) === 131072) && Number(contextLength) !== Number(ctxEl.value)) {
      ctxEl.value = String(contextLength);
      s.llm.maxContextLength = Number(contextLength);
      try { await saveSettings(s); } catch (_) { /* 忽略保存失败 */ }
    }
    if (!variants || !variants.length) {
      // 未知 openai-compat 兜底五档（off/auto/low/medium/high）
      variants = ['off', 'auto', 'low', 'medium', 'high'].map(id => ({
        id, label: VARIANT_LABEL_FALLBACK[id] || id, wire: id
      }));
      defaultId = 'auto';
    }
    const current = s.llm.reasoningEffort || 'off';
    const ids = variants.map(v => v.id);
    const next = ids.includes(current) ? current : defaultId;
    el.innerHTML = variants.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
    el.value = next;
    if (current !== next) {
      s.llm.reasoningEffort = next;
      try { await saveSettings(s); } catch (_) { /* 忽略保存失败 */ }
      if (typeof window.showToast === 'function') {
        const label = (variants.find(v => v.id === next) || {}).label || next;
        window.showToast(`当前模型不支持变体「${current}」，已自动调整为「${label}」`, 'info', 4500);
      }
    }
    const hint = el.parentElement?.querySelector('.setting-hint');
    if (hint) hint.textContent = `当前模型支持：${variants.map(v => v.label).join(' / ')}`;
    return { variants, next };
  }
  window.refreshReasoningVariants = refreshReasoningVariants;

  // Usage stats period buttons
