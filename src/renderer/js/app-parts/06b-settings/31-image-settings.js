  // ---- Image settings（多厂商预设 / 高级参数）----
  let _imageProviders = null;
  let _imageProviderBound = false;

  async function loadImageProviders() {
    if (_imageProviders) return _imageProviders;
    try { _imageProviders = await window.api.imageProviders(); }
    catch (_) { _imageProviders = { ok: false, providers: [] }; }
    return _imageProviders;
  }

  function applyImageProviderFields(g, preset) {
    const sizeSel = document.getElementById('setting-img-size');
    if (sizeSel) {
      const sizes = (preset && preset.sizes && preset.sizes.length) ? preset.sizes : [g?.imageSize || '1024x1024'];
      const current = (g && g.imageSize) || sizes[0];
      const options = sizes.includes(current) ? sizes : [current, ...sizes];
      sizeSel.innerHTML = options.map(s => `<option value="${s}">${s}</option>`).join('');
      sizeSel.value = current;
    }
    const dl = document.getElementById('setting-img-model-presets');
    if (dl) {
      dl.innerHTML = ((preset && preset.models) || []).map(m => `<option value="${m}"></option>`).join('');
    }
    const hint = document.getElementById('setting-img-provider-hint');
    if (hint && preset) hint.textContent = preset.hint || '';
    const tplItem = document.getElementById('setting-img-template-item');
    if (tplItem) tplItem.style.display = (preset && preset.id === 'custom') ? '' : 'none';
  }

  function fillImageGenForm(g) {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    const provSel = document.getElementById('setting-img-provider');
    if (provSel && g.provider) provSel.value = g.provider;
    setVal('setting-img-url', g.apiUrl);
    setVal('setting-img-key', g.apiKey);
    setVal('setting-img-model', g.model);
    setVal('setting-img-n', g.n || 1);
    setVal('setting-img-quality', g.quality || '');
    setVal('setting-img-background', g.background || '');
    setVal('setting-img-format', g.outputFormat || '');
    setVal('setting-img-negative', g.negativePrompt || '');
    setVal('setting-img-seed', g.seed);
    setVal('setting-img-steps', g.steps);
    setVal('setting-img-guidance', g.guidance);
    setVal('setting-img-style', g.style || '');
    setVal('setting-img-template', g.bodyTemplate || '');
    setChk('setting-img-watermark', g.watermark);
  }

  async function refreshImageGenUI(g) {
    const data = await loadImageProviders();
    const providers = (data && data.providers) || [];
    const provSel = document.getElementById('setting-img-provider');
    if (!provSel) return;
    if (!_imageProviderBound) {
      _imageProviderBound = true;
      provSel.innerHTML = providers.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
    }
    const preset = providers.find(p => p.id === (g?.provider || data.current)) || providers[0] || null;
    fillImageGenForm(g || {});
    applyImageProviderFields(g || {}, preset);
  }

  function bindImageSettings() {
    if (window.__imgSettingsBound) return;
    window.__imgSettingsBound = true;
    const saveField = (id, key, transform) => {
      document.getElementById(id)?.addEventListener('change', async (e) => {
        const s = await window.api.getSettings();
        let v = e.target.value;
        if (transform) v = transform(v);
        s.imageGen[key] = v;
        await saveSettings(s);
      });
    };
    // 厂商切换：保存 + 更新预设（自动填充空 URL / 空模型）
    document.getElementById('setting-img-provider')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      const data = await loadImageProviders();
      const preset = ((data && data.providers) || []).find(p => p.id === e.target.value);
      s.imageGen.provider = e.target.value;
      if (preset) {
        const otherDefaults = ((data && data.providers) || [])
          .filter(p => p.id !== preset.id).map(p => p.defaultUrl).filter(Boolean);
        if (!s.imageGen.apiUrl || otherDefaults.includes(s.imageGen.apiUrl)) s.imageGen.apiUrl = preset.defaultUrl || '';
        if (!s.imageGen.model && preset.models && preset.models.length) s.imageGen.model = preset.models[0];
      }
      await saveSettings(s);
      fillImageGenForm(s.imageGen);
      applyImageProviderFields(s.imageGen, preset);
    });
    saveField('setting-img-url', 'apiUrl');
    saveField('setting-img-key', 'apiKey');
    saveField('setting-img-model', 'model');
    saveField('setting-img-daily-limit', 'dailyMaxImages', (v) => parseInt(v) || 0);
    document.getElementById('setting-img-size')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.imageGen.imageSize = e.target.value;
      await saveSettings(s);
    });
    saveField('setting-img-n', 'n', (v) => Math.max(1, Math.min(10, parseInt(v) || 1)));
    saveField('setting-img-quality', 'quality');
    saveField('setting-img-background', 'background');
    saveField('setting-img-format', 'outputFormat');
    saveField('setting-img-negative', 'negativePrompt');
    saveField('setting-img-seed', 'seed');
    saveField('setting-img-steps', 'steps');
    saveField('setting-img-guidance', 'guidance');
    saveField('setting-img-style', 'style');
    saveField('setting-img-template', 'bodyTemplate');
    document.getElementById('setting-img-watermark')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.imageGen.watermark = e.target.checked;
      await saveSettings(s);
    });
  }
  bindImageSettings();
