  let llmFetchedModels = [];

  function renderLlmModelOptions(filterText) {
    const box = document.getElementById('llm-model-options');
    if (!box) return;
    const f = String(filterText || '').trim().toLowerCase();
    const models = llmFetchedModels.filter(m => !f || String(m.id || m.name || '').toLowerCase().includes(f));
    box.innerHTML = '';
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'llm-model-options-empty';
      empty.textContent = llmFetchedModels.length ? '无匹配模型' : '暂无模型，点击右侧刷新按钮获取';
      box.appendChild(empty);
      return;
    }
    for (const m of models) {
      const row = document.createElement('div');
      row.className = 'llm-model-option';
      row.textContent = m.id || m.name || '';
      row.addEventListener('click', () => {
        const input = document.getElementById('setting-llm-model');
        if (input) {
          input.value = m.id || m.name || '';
          input.dispatchEvent(new Event('change'));
        }
        hideLlmModelDropdown();
      });
      box.appendChild(row);
    }
  }

  function showLlmModelDropdown(resetFilter) {
    const dd = document.getElementById('llm-model-dropdown');
    const filter = document.getElementById('llm-model-filter');
    if (resetFilter && filter) filter.value = '';
    renderLlmModelOptions(filter ? filter.value : '');
    if (dd) dd.classList.remove('hidden');
  }

  function hideLlmModelDropdown() {
    const dd = document.getElementById('llm-model-dropdown');
    if (dd) dd.classList.add('hidden');
  }

  async function refreshLLMModels() {
    const provider = document.getElementById('setting-llm-provider')?.value || 'openai-compat';
    const apiUrl = document.getElementById('setting-llm-url')?.value || '';
    const apiKey = document.getElementById('setting-llm-key')?.value || '';
    const hint = document.getElementById('llm-model-hint');
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      const res = await window.api.llmFetchModels(provider, apiUrl, apiKey);
      if (!res || !res.ok || !Array.isArray(res.models)) {
        if (hint) hint.textContent = res?.error || '获取失败，请检查 API URL/Key 或网络';
        return;
      }
      llmFetchedModels = Array.isArray(res.models) ? res.models.slice() : [];
      showLlmModelDropdown(true);
      if (hint) hint.textContent = `共 ${res.models.length} 个可用模型`;
    } catch (e) {
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }
