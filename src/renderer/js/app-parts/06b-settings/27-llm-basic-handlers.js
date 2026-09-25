  document.getElementById('setting-llm-temp').addEventListener('input', async (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('setting-temp-val').textContent = val;
    const s = await window.api.getSettings();
    s.llm.temperature = val;
    await saveSettings(s);
  });

  // Streaming / retry / timeout / fallback model
  document.getElementById('setting-llm-stream').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.streamResponses = e.target.checked;
    await saveSettings(s);
  });
  const forceVisionSaveEl = document.getElementById('setting-llm-force-vision');
  if (forceVisionSaveEl) {
    forceVisionSaveEl.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.llm.forceVision = e.target.checked;
      await saveSettings(s);
    });
  }
    // 外置视觉保存（失焦时自动持久化）
    for (const id of ['setting-llm-external-vision-url', 'setting-llm-external-vision-key', 'setting-llm-external-vision-model']) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', async () => {
          const s = await window.api.getSettings();
          if (!s.llm.externalVision) s.llm.externalVision = {};
          const fieldMap = { 'setting-llm-external-vision-url': 'apiUrl', 'setting-llm-external-vision-key': 'apiKey', 'setting-llm-external-vision-model': 'model' };
          s.llm.externalVision[fieldMap[id]] = el.value.trim();
          await saveSettings(s);
        });
      }
    }

    // 对齐主 Agent：根据当前 provider 复制正确的 apiUrl/apiKey 到外置视觉
    const alignBtn = document.getElementById('btn-ev-align-main');
    if (alignBtn) {
      alignBtn.addEventListener('click', async () => {
        const s = await window.api.getSettings();
        const llm = s.llm || {};
        const provider = llm.provider || 'openai-compat';
        let url = '', key = '';
        if (provider === 'opencode-zen') {
          url = 'https://opencode.ai/zen/v1/chat/completions';
          key = llm.zenApiKey || '';
        } else if (llm.apiUrl) {
          url = llm.apiUrl;
          key = llm.apiKey || '';
        }
        if (!url) { return; }
        const urlEl = document.getElementById('setting-llm-external-vision-url');
        const keyEl = document.getElementById('setting-llm-external-vision-key');
        if (urlEl) urlEl.value = url;
        if (keyEl) keyEl.value = key;
        for (const id of ['setting-llm-external-vision-url', 'setting-llm-external-vision-key']) {
          document.getElementById(id)?.dispatchEvent(new Event('change'));
        }
      });
    }

    // 获取模型列表：调 llm:fetchModels 填充 select（不过滤，给完整列表）
    const fetchModelsBtn = document.getElementById('btn-ev-fetch-models');
    const modelSelect = document.getElementById('setting-llm-external-vision-model-select');
    const modelInput = document.getElementById('setting-llm-external-vision-model');
    if (fetchModelsBtn) {
      fetchModelsBtn.addEventListener('click', async () => {
        const apiUrl = document.getElementById('setting-llm-external-vision-url')?.value?.trim();
        const apiKey = document.getElementById('setting-llm-external-vision-key')?.value?.trim();
        const status = document.getElementById('ev-model-status');
        if (!apiUrl) { if (status) status.textContent = '请先填写 API URL'; return; }
        if (status) status.textContent = '获取模型列表中…';
        try {
          const res = await window.api.llmFetchModels('openai-compat', apiUrl, apiKey);
          if (!res || !res.ok || !Array.isArray(res.models)) {
            if (status) status.textContent = '获取失败：' + (res?.error || '未知错误');
            return;
          }
          const allModels = res.models.map(m => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean);
          if (modelSelect) {
            modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>'
              + allModels.map(m => `<option value="${m}">${m}</option>`).join('');
            modelSelect.style.display = '';
            modelSelect.onchange = () => {
              if (modelSelect.value && modelInput) {
                modelInput.value = modelSelect.value;
                // 手动触发 change 以激活持久化
                modelInput.dispatchEvent(new Event('change'));
              }
            };
          }
          if (status) status.textContent = `发现 ${allModels.length} 个模型`;
        } catch (e) {
          if (status) status.textContent = '获取失败: ' + e.message;
        }
      });
    }
  document.getElementById('setting-llm-retries').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.maxRetries = Math.max(0, parseInt(e.target.value) || 0);
    await saveSettings(s);
  });
  document.getElementById('setting-llm-timeout').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.timeoutMs = Math.max(0, parseInt(e.target.value) || 0) * 1000;
    await saveSettings(s);
  });
  document.getElementById('setting-llm-fallback-model').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.llm.fallbackModel = e.target.value.trim();
    await saveSettings(s);
  });
  // OpenCode 自动头开关
