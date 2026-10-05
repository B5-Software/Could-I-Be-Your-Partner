  // ---- LLM 模型池（单层：每条自带 provider/URL/Key）----
  const POOL_PROVIDER_LABELS = {
    auto: '自动识别 API 格式',
    'chatgpt-codex': 'ChatGPT / Codex',
    'opencode-zen': 'OpenCode Zen',
    'opencode-go': 'OpenCode Go',
    'openai-compat': 'OpenAI 兼容',
    'openai-responses': 'OpenAI Responses',
    'anthropic-compat': 'Anthropic 兼容',
  };
  const POOL_EFFORT_LABELS = {
    off: '关闭', auto: '自动', none: '无推理', minimal: '极低',
    low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高'
  };
  let _poolEditingId = null;
  let _poolBound = false;
  let _poolCtxTouched = false;
  let _poolModelsGeneration = 0;
  let _poolModels = [];

  function renderPoolModels() {
    const select = document.getElementById('pool-edit-model-select');
    const current = document.getElementById('pool-edit-model').value;
    const zen = document.getElementById('pool-edit-provider').value === 'opencode-zen';
    const models = _poolModels.filter((model) => !zen || !document.getElementById('pool-edit-free-only').checked || model.free);
    select.replaceChildren(new Option('选择模型', ''), ...models.map((model) => new Option((model.free ? '免费 · ' : '') + (model.name || model.id), model.id)));
    select.classList.remove('hidden');
    select.value = models.some((model) => model.id === current) ? current : '';
    if (!current && zen && models.length) {
      const model = models.find((model) => model.verified) || models.find((model) => model.id === 'big-pickle') || models.find((model) => model.free);
      if (model) { select.value = model.id; document.getElementById('pool-edit-model').value = model.id; applyPoolModelMetadata(model); }
    }
    document.getElementById('pool-edit-model-status').textContent = models.length ? `识别到 ${models.length} 个模型` : '暂无模型；可关闭免费筛选或手动填写 ID';
  }

  function applyPoolModelMetadata(model) {
    if (!_poolCtxTouched && model?.contextLength) document.getElementById('pool-edit-ctx').value = model.contextLength;
    if (model) document.getElementById('pool-edit-vision').checked = !!model.vision;
    refreshPoolEditorVariants().catch(() => {});
  }

  async function fetchPoolModels() {
    const generation = ++_poolModelsGeneration;
    const provider = document.getElementById('pool-edit-provider').value;
    const apiUrl = document.getElementById('pool-edit-url').value.trim();
    const apiKey = document.getElementById('pool-edit-key').value.trim();
    const zen = provider.startsWith('opencode');
    document.getElementById('pool-edit-opencode-note').classList.toggle('hidden', !zen);
    document.getElementById('pool-edit-free-filter').classList.toggle('hidden', provider !== 'opencode-zen');
    const button = document.getElementById('btn-pool-edit-fetch');
    const status = document.getElementById('pool-edit-model-status');
    button.disabled = true;
    _poolModels = [];
    document.getElementById('pool-edit-model-select').classList.add('hidden');
    status.textContent = '正在识别模型…';
    try {
      if (!zen && provider !== 'chatgpt-codex' && !apiUrl) throw new Error('填写 API 地址后自动识别模型');
      const result = zen ? await window.api.zenFetchModels(provider === 'opencode-go' ? 'go' : 'zen', { apiKey: apiKey || 'public', verifyFree: true })
        : await window.api.llmFetchModels(provider, apiUrl, apiKey);
      if (generation !== _poolModelsGeneration) return;
      if (!result?.ok || !Array.isArray(result.models)) throw new Error(result?.error || '模型列表格式无效');
      _poolModels = result.models; renderPoolModels();
    } catch (error) { if (generation === _poolModelsGeneration) status.textContent = error.message + '；可手动填写模型 ID。'; }
    finally { if (generation === _poolModelsGeneration) button.disabled = false; }
  }

  function poolEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function poolEntryLabel(e) {
    return e.label || e.model || '未命名模型';
  }

  function renderPoolList(s) {
    const listEl = document.getElementById('llm-pool-list');
    if (!listEl) return;
    const pool = Array.isArray(s?.llm?.pool) ? s.llm.pool : [];
    const activeId = s?.llm?.activeEntryId || '';
    if (pool.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>模型池为空：点击下方「添加模型」，可自由组合 OpenCode Zen/Go、OpenAI 兼容、Anthropic 兼容等</p></div>';
    } else {
      const sorted = pool.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
      listEl.innerHTML = sorted.map((e) => {
        const enabled = e.enabled !== false;
        const active = e.id === activeId;
        return `
          <div class="llm-pool-card${active ? ' active' : ''}${enabled ? '' : ' disabled'}" data-id="${poolEsc(e.id)}">
            <div class="llm-pool-main">
              <div class="llm-pool-name">${poolEsc(poolEntryLabel(e))}
                <span class="pool-badge provider">${poolEsc(POOL_PROVIDER_LABELS[e.provider] || e.provider || '?')}</span>
                ${active ? '<span class="pool-badge default">默认</span>' : ''}
                ${e.vision ? '<span class="pool-badge vision">视觉</span>' : ''}
                ${enabled ? '' : '<span class="pool-badge off">已禁用</span>'}
              </div>
              <div class="llm-pool-meta">${poolEsc(e.model || '')} · 智慧 ${Number(e.intelligence) || 0} · 优先级 ${Number(e.priority) || 0} · Effort ${poolEsc(POOL_EFFORT_LABELS[e.effort] || e.effort || '关闭')}${e.provider === 'chatgpt-codex' ? ' · 订阅账号' : e.apiKey ? ' · 已配 Key' : ' · 无 Key'}</div>
            </div>
            <div class="llm-pool-actions">
              ${active ? '' : '<button class="btn-secondary btn-sm" data-pool-act="default">设为默认</button>'}
              <button class="btn-secondary btn-sm" data-pool-act="edit">编辑</button>
              <button class="btn-secondary btn-sm" data-pool-act="delete">删除</button>
            </div>
          </div>`;
      }).join('');
    }
    const routing = s?.llm?.routing || {};
    const modelStrategyEl = document.getElementById('setting-llm-model-strategy');
    const effortStrategyEl = document.getElementById('setting-llm-effort-strategy');
    if (modelStrategyEl) modelStrategyEl.value = routing.modelStrategy === 'intelligence' ? 'intelligence' : 'priority';
    if (effortStrategyEl) effortStrategyEl.value = routing.effortStrategy === 'jev' ? 'jev' : 'manual';
    const hintEl = document.getElementById('llm-pool-hint');
    if (hintEl) {
      const enabledCount = pool.filter(e => e.enabled !== false).length;
      hintEl.textContent = pool.length ? `${enabledCount}/${pool.length} 个启用；优先级越小越先被选中` : '';
    }
  }

  async function refreshPoolUI(s) {
    if (!s) s = await readSettings();
    renderPoolList(s);
  }

  async function savePool(pool, extra = {}) {
    const s = await readSettings();
    s.llm.pool = pool;
    if (extra.activeEntryId !== undefined) s.llm.activeEntryId = extra.activeEntryId;
    if (extra.routing) s.llm.routing = extra.routing;
    if (extra.maxContextLength !== undefined) s.llm.maxContextLength = extra.maxContextLength;
    if (extra.maxContextLengthExplicit !== undefined) s.llm.maxContextLengthExplicit = extra.maxContextLengthExplicit;
    await saveSettings(s);
    renderPoolList(s);
  }

  function fillPoolEditor(entry) {
    const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val == null ? '' : val; };
    const c = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const e = entry || {};
    v('pool-edit-label', e.label || '');
    v('pool-edit-provider', e.provider || 'opencode-zen');
    updatePoolAccountFields();
    v('pool-edit-url', e.apiUrl || '');
    v('pool-edit-key', e.apiKey || '');
    v('pool-edit-model', e.model || '');
    v('pool-edit-ctx', e.contextLength || 131072);
    v('pool-edit-intelligence', e.intelligence != null ? e.intelligence : 50);
    v('pool-edit-priority', e.priority != null ? e.priority : 0);
    v('pool-edit-effort', e.effort || 'off');
    c('pool-edit-vision', e.vision);
    c('pool-edit-enabled', e.enabled !== false);
    const sel = document.getElementById('pool-edit-model-select');
    if (sel) { sel.classList.add('hidden'); sel.innerHTML = ''; }
  }

  function updatePoolAccountFields() {
    const account = document.getElementById('pool-edit-provider').value === 'chatgpt-codex';
    for (const id of ['pool-edit-url', 'pool-edit-key']) document.getElementById(id)?.closest('.setting-item')?.classList.toggle('hidden', account);
  }

  // 池编辑器：按 provider+model 动态填充 effort 档位与上下文长度（API 元数据优先，失败保持静态兜底）
  async function refreshPoolEditorVariants() {
    const generation = _poolModelsGeneration;
    const provider = document.getElementById('pool-edit-provider')?.value || 'openai-compat';
    const model = (document.getElementById('pool-edit-model')?.value || '').trim();
    const apiUrl = document.getElementById('pool-edit-url')?.value || '';
    const apiKey = document.getElementById('pool-edit-key')?.value || '';
    const effortEl = document.getElementById('pool-edit-effort');
    if (!effortEl) return;
    let variants = null;
    let contextLength = null;
    try {
      if (model && typeof window.api.llmCapabilities === 'function') {
        const res = await window.api.llmCapabilities(provider, model, apiUrl, apiKey);
        if (res && res.ok) {
          if (Array.isArray(res.variants) && res.variants.length) variants = res.variants;
          contextLength = res.contextLength || null;
        }
      }
    } catch { /* keep static fallback */ }
    if (generation !== _poolModelsGeneration || model !== document.getElementById('pool-edit-model')?.value.trim() || provider !== document.getElementById('pool-edit-provider')?.value) return;
    if (variants && variants.length) {
      const current = effortEl.value;
      effortEl.innerHTML = variants.map(v => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label || v.id)}</option>`).join('');
      effortEl.value = variants.some(v => v.id === current) ? current : (variants[0]?.id || 'off');
    }
    const ctxEl = document.getElementById('pool-edit-ctx');
    // 用户已手动改过上下文长度：不再用 API 元数据覆盖（只有没填时才拉）
    if (ctxEl && contextLength && !_poolCtxTouched && (!ctxEl.value || Number(ctxEl.value) === 131072)) {
      ctxEl.value = String(contextLength);
    }
  }

  function openPoolEditor(entry) {
    _poolEditingId = entry ? entry.id : null;
    _poolCtxTouched = false;
    const title = document.getElementById('llm-pool-editor-title');
    if (title) title.textContent = entry ? '编辑模型' : '添加模型';
    fillPoolEditor(entry);
    document.getElementById('llm-pool-editor')?.classList.remove('hidden');
    document.getElementById('pool-edit-free-only').checked = !entry || /-free$/.test(entry.model) || entry.model === 'big-pickle';
    fetchPoolModels();
    // 已有模型：异步拉取元数据刷新档位/上下文长度
    if (entry && entry.model) refreshPoolEditorVariants().catch(() => {});
  }

  function closePoolEditor() {
    ++_poolModelsGeneration;
    document.getElementById('llm-pool-editor')?.classList.add('hidden');
    _poolEditingId = null;
  }

  async function savePoolEditor() {
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const chk = (id) => !!document.getElementById(id)?.checked;
    const provider = val('pool-edit-provider') || 'openai-compat';
    const model = val('pool-edit-model');
    if (!model) { window.showToast('请填写模型 ID', 'error'); return; }
    const entry = {
      id: _poolEditingId || ('pool-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      label: val('pool-edit-label') || model,
      provider,
      apiUrl: provider === 'chatgpt-codex' ? 'https://api.openai.com/v1/responses' : val('pool-edit-url'),
      apiKey: provider === 'chatgpt-codex' ? '' : val('pool-edit-key') || (provider.startsWith('opencode') ? 'public' : ''),
      ...(provider.startsWith('opencode') ? { autoOpencodeHeaders: true } : {}),
      model,
      providerLimits: _poolModels.find(model => model.id === val('pool-edit-model'))?.providerLimits || null,
      contextLength: parseInt(val('pool-edit-ctx'), 10) || 131072,
      intelligence: Math.max(0, Math.min(100, parseInt(val('pool-edit-intelligence'), 10) || 0)),
      priority: Math.max(0, parseInt(val('pool-edit-priority'), 10) || 0),
      effort: val('pool-edit-effort') || 'off',
      vision: chk('pool-edit-vision'),
      enabled: chk('pool-edit-enabled'),
    };
    if (provider === 'auto') {
      const result = await window.api.llmDetectFormat(entry);
      if (!result.ok) { window.showToast(result.error, 'error'); return; }
      entry.provider = result.provider; entry.apiUrl = result.apiUrl;
    }
    const s = await readSettings();
    const pool = Array.isArray(s.llm.pool) ? s.llm.pool.slice() : [];
    const idx = pool.findIndex(x => x.id === entry.id);
    if (idx >= 0) pool[idx] = entry; else pool.push(entry);
    const activeEntryId = s.llm.activeEntryId || entry.id;
    const extra = { activeEntryId };
    // 编辑的是当前生效条目且用户改过上下文长度：视为用户显式填写，主进程不再覆盖
    if (_poolCtxTouched && activeEntryId === entry.id) {
      extra.maxContextLength = entry.contextLength;
      extra.maxContextLengthExplicit = true;
    }
    await savePool(pool, extra);
    closePoolEditor();
    window.showToast(idx >= 0 ? '模型已更新' : '模型已添加', 'success', 2000);
  }

  function bindPoolUI() {
    if (_poolBound) return;
    _poolBound = true;
    document.getElementById('btn-pool-add')?.addEventListener('click', () => openPoolEditor(null));
    document.getElementById('btn-pool-editor-close')?.addEventListener('click', closePoolEditor);
    document.getElementById('btn-pool-editor-cancel')?.addEventListener('click', closePoolEditor);
    document.getElementById('btn-pool-editor-save')?.addEventListener('click', () => { savePoolEditor().catch(e => window.showToast('保存失败: ' + e.message, 'error')); });
    if (typeof bindBackdropClose === 'function') {
      bindBackdropClose(document.getElementById('llm-pool-editor'), closePoolEditor);
    }
    document.getElementById('btn-pool-edit-fetch')?.addEventListener('click', fetchPoolModels);
    document.getElementById('pool-edit-free-only')?.addEventListener('change', renderPoolModels);
    for (const id of ['pool-edit-key', 'pool-edit-url', 'pool-edit-provider']) document.getElementById(id)?.addEventListener('change', fetchPoolModels);
    document.getElementById('pool-edit-model-select')?.addEventListener('change', (e) => {
      const modelEl = document.getElementById('pool-edit-model');
      if (modelEl && e.target.value) modelEl.value = e.target.value;
      const model = _poolModels.find(model => model.id === e.target.value);
      if (model) {
        if (!_poolCtxTouched && model.contextLength) document.getElementById('pool-edit-ctx').value = model.contextLength;
        document.getElementById('pool-edit-vision').checked = model.vision === true || model.capabilities?.vision === true;
        if (!document.getElementById('pool-edit-label').value.trim()) document.getElementById('pool-edit-label').value = model.name || model.id;
      }
      refreshPoolEditorVariants().catch(() => {});
    });
    document.getElementById('pool-edit-model')?.addEventListener('change', () => {
      refreshPoolEditorVariants().catch(() => {});
    });
    document.getElementById('pool-edit-ctx')?.addEventListener('input', () => { _poolCtxTouched = true; });
    document.getElementById('pool-edit-provider')?.addEventListener('change', (e) => {
      updatePoolAccountFields();
      const urlEl = document.getElementById('pool-edit-url');
      if (urlEl && !urlEl.value.trim()) {
        urlEl.placeholder = (e.target.value === 'opencode-zen' || e.target.value === 'opencode-go')
          ? '留空自动使用 OpenCode 端点'
          : 'https://api.example.com/v1/chat/completions';
      }
    });
    document.getElementById('llm-pool-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-pool-act]');
      const card = e.target.closest('.llm-pool-card');
      if (!btn || !card) return;
      const id = card.dataset.id;
      const s = await readSettings();
      const pool = Array.isArray(s.llm.pool) ? s.llm.pool.slice() : [];
      const idx = pool.findIndex(x => x.id === id);
      if (idx < 0) return;
      const act = btn.dataset.poolAct;
      if (act === 'edit') openPoolEditor(pool[idx]);
      else if (act === 'default') {
        // 切换默认模型：采用新条目的上下文长度，并清除"用户显式填写"标记
        const next = pool[idx];
        await savePool(pool, {
          activeEntryId: id,
          maxContextLength: next.contextLength || s.llm.maxContextLength,
          maxContextLengthExplicit: false,
        });
      }
      else if (act === 'delete') {
        const ok = window.api.confirmSensitive ? await window.api.confirmSensitive('确定删除该模型条目吗？') : window.confirm('确定删除该模型条目吗？');
        if (!ok) return;
        const wasActive = s.llm.activeEntryId === id;
        pool.splice(idx, 1);
        const activeEntryId = wasActive ? (pool[0]?.id || '') : s.llm.activeEntryId;
        const extra = { activeEntryId };
        if (wasActive) {
          const nextActive = pool.find(x => x.id === activeEntryId);
          if (nextActive && nextActive.contextLength) extra.maxContextLength = nextActive.contextLength;
          extra.maxContextLengthExplicit = false;
        }
        await savePool(pool, extra);
      }
    });
    document.getElementById('setting-llm-model-strategy')?.addEventListener('change', async (e) => {
      const s = await readSettings();
      s.llm.routing = { ...(s.llm.routing || {}), modelStrategy: e.target.value };
      await saveSettings(s);
      renderPoolList(s);
    });
    document.getElementById('setting-llm-effort-strategy')?.addEventListener('change', async (e) => {
      const s = await readSettings();
      s.llm.routing = { ...(s.llm.routing || {}), effortStrategy: e.target.value };
      await saveSettings(s);
    });
  }
  bindPoolUI();
