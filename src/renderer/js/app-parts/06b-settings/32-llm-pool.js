  // ---- LLM 模型池（单层：每条自带 provider/URL/Key）----
  const POOL_PROVIDER_LABELS = {
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
              <div class="llm-pool-meta">${poolEsc(e.model || '')} · 智慧 ${Number(e.intelligence) || 0} · 优先级 ${Number(e.priority) || 0} · Effort ${poolEsc(POOL_EFFORT_LABELS[e.effort] || e.effort || '关闭')}${e.apiKey ? ' · 已配 Key' : ' · 无 Key'}</div>
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
    if (!s) s = await window.api.getSettings();
    renderPoolList(s);
  }

  async function savePool(pool, extra = {}) {
    const s = await window.api.getSettings();
    s.llm.pool = pool;
    if (extra.activeEntryId !== undefined) s.llm.activeEntryId = extra.activeEntryId;
    if (extra.routing) s.llm.routing = extra.routing;
    await saveSettings(s);
    renderPoolList(s);
  }

  function fillPoolEditor(entry) {
    const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val == null ? '' : val; };
    const c = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const e = entry || {};
    v('pool-edit-label', e.label || '');
    v('pool-edit-provider', e.provider || 'opencode-zen');
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

  // 池编辑器：按 provider+model 动态填充 effort 档位与上下文长度（API 元数据优先，失败保持静态兜底）
  async function refreshPoolEditorVariants() {
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
    if (variants && variants.length) {
      const current = effortEl.value;
      effortEl.innerHTML = variants.map(v => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label || v.id)}</option>`).join('');
      effortEl.value = variants.some(v => v.id === current) ? current : (variants[0]?.id || 'off');
    }
    const ctxEl = document.getElementById('pool-edit-ctx');
    if (ctxEl && contextLength && (!ctxEl.value || Number(ctxEl.value) === 131072)) {
      ctxEl.value = String(contextLength);
    }
  }

  function openPoolEditor(entry) {
    _poolEditingId = entry ? entry.id : null;
    const title = document.getElementById('llm-pool-editor-title');
    if (title) title.textContent = entry ? '编辑模型' : '添加模型';
    fillPoolEditor(entry);
    document.getElementById('llm-pool-editor')?.classList.remove('hidden');
    // 已有模型：异步拉取元数据刷新档位/上下文长度
    if (entry && entry.model) refreshPoolEditorVariants().catch(() => {});
  }

  function closePoolEditor() {
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
      apiUrl: val('pool-edit-url'),
      apiKey: val('pool-edit-key'),
      model,
      contextLength: parseInt(val('pool-edit-ctx'), 10) || 131072,
      intelligence: Math.max(0, Math.min(100, parseInt(val('pool-edit-intelligence'), 10) || 0)),
      priority: Math.max(0, parseInt(val('pool-edit-priority'), 10) || 0),
      effort: val('pool-edit-effort') || 'off',
      vision: chk('pool-edit-vision'),
      enabled: chk('pool-edit-enabled'),
    };
    const s = await window.api.getSettings();
    const pool = Array.isArray(s.llm.pool) ? s.llm.pool.slice() : [];
    const idx = pool.findIndex(x => x.id === entry.id);
    if (idx >= 0) pool[idx] = entry; else pool.push(entry);
    const activeEntryId = s.llm.activeEntryId || entry.id;
    await savePool(pool, { activeEntryId });
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
    document.getElementById('btn-pool-edit-fetch')?.addEventListener('click', async () => {
      const provider = document.getElementById('pool-edit-provider')?.value || '';
      const apiUrl = document.getElementById('pool-edit-url')?.value || '';
      const apiKey = document.getElementById('pool-edit-key')?.value || '';
      const btn = document.getElementById('btn-pool-edit-fetch');
      if (btn) btn.disabled = true;
      try {
        let models = [];
        if (provider === 'opencode-zen' || provider === 'opencode-go') {
          const r = await window.api.zenFetchModels();
          const list = (r && (r.data || r.models)) || [];
          models = list.map(m => ({ id: m.id, name: m.name || '' }));
        } else {
          const r = await window.api.llmFetchModels(provider, apiUrl, apiKey);
          models = (r && (r.models || r.data)) || [];
        }
        const sel = document.getElementById('pool-edit-model-select');
        if (sel && models.length) {
          sel.innerHTML = '<option value="">-- 选择模型 --</option>' + models.map(m => `<option value="${poolEsc(m.id)}">${poolEsc(m.name || m.id)}</option>`).join('');
          sel.classList.remove('hidden');
        } else {
          window.showToast('未获取到模型列表', 'warn');
        }
      } catch (e) {
        window.showToast('获取失败: ' + e.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    document.getElementById('pool-edit-model-select')?.addEventListener('change', (e) => {
      const modelEl = document.getElementById('pool-edit-model');
      if (modelEl && e.target.value) modelEl.value = e.target.value;
      refreshPoolEditorVariants().catch(() => {});
    });
    document.getElementById('pool-edit-model')?.addEventListener('change', () => {
      refreshPoolEditorVariants().catch(() => {});
    });
    document.getElementById('pool-edit-provider')?.addEventListener('change', (e) => {
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
      const s = await window.api.getSettings();
      const pool = Array.isArray(s.llm.pool) ? s.llm.pool.slice() : [];
      const idx = pool.findIndex(x => x.id === id);
      if (idx < 0) return;
      const act = btn.dataset.poolAct;
      if (act === 'edit') openPoolEditor(pool[idx]);
      else if (act === 'default') await savePool(pool, { activeEntryId: id });
      else if (act === 'delete') {
        const ok = window.api.confirmSensitive ? await window.api.confirmSensitive('确定删除该模型条目吗？') : window.confirm('确定删除该模型条目吗？');
        if (!ok) return;
        pool.splice(idx, 1);
        const activeEntryId = s.llm.activeEntryId === id ? (pool[0]?.id || '') : s.llm.activeEntryId;
        await savePool(pool, { activeEntryId });
      }
    });
    document.getElementById('setting-llm-model-strategy')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.llm.routing = { ...(s.llm.routing || {}), modelStrategy: e.target.value };
      await saveSettings(s);
      renderPoolList(s);
    });
    document.getElementById('setting-llm-effort-strategy')?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      s.llm.routing = { ...(s.llm.routing || {}), effortStrategy: e.target.value };
      await saveSettings(s);
    });
  }
  bindPoolUI();
