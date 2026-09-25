  // ---- 工具组模态框（两级视图的第二级）----
  let currentToolModalCategory = null;

  function renderToolGroupModal(category) {
    currentToolModalCategory = category;
    const enabledSettings = agent.settings.tools || {};
    const mode = codeEditorModeFilter || 'chat';
    const allDefs = getAllToolDefinitions(mode);
    const tools = (typeof filterToolDefsByConfig === 'function'
      ? filterToolDefsByConfig(allDefs, agent.settings)
      : allDefs).filter(t => (t.category || '其他') === category);
    const meta = typeof getCategoryMeta === 'function' ? getCategoryMeta(category) : { icon: 'fa-layer-group', desc: '' };
    const isMcp = String(category || '').startsWith('MCP:');
    const titleText = isMcp
      ? category.replace(/^MCP:/, '')
      : (tools[0]?.pluginName || (typeof i18nGetCategory === 'function' ? i18nGetCategory(category, category) : category));
    const titleEl = document.getElementById('tools-modal-title');
    if (titleEl) {
      titleEl.innerHTML = `<i class="fa-solid ${meta.icon || 'fa-layer-group'}"></i> <span>${escapeHtml(titleText)}</span>`;
    }
    const refreshBtn = document.getElementById('tools-modal-mcp-refresh');
    if (refreshBtn) refreshBtn.style.display = isMcp ? '' : 'none';
    const body = document.getElementById('tools-modal-body');
    if (!body) return;
    if (tools.length === 0) {
      body.innerHTML = '<div class="empty-state"><i class="fa-solid fa-inbox"></i><p>该组在当前模式下无可用工具</p></div>';
      return;
    }
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeSet = hasOptimized
      ? new Set((typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : [])
      : null;
    body.innerHTML = tools.map(tool => {
      const gated = typeof isConfigGatedTool === 'function' && isConfigGatedTool(tool.name);
      const enabled = typeof isToolEnabledForSettings === 'function'
        ? isToolEnabledForSettings(tool.name, agent.settings)
        : enabledSettings[tool.name] !== false;
      const desc = typeof i18nGetToolDesc === 'function' ? i18nGetToolDesc(tool.name, tool.desc) : tool.desc;
      const dsBadge = tool.pluginId
        ? `<span class="ds-compat-badge ${tool.compatTier || 'native'}">${tool.compatTier || 'native'}</span>`
        : '';
      const autoBadge = gated ? '<span class="ds-compat-badge native">配置后自动启用</span>' : '';
      const isActive = activeSet ? activeSet.has(tool.name) : null;
      const optClass = isActive === true ? 'optimized-active' : (isActive === false && enabled ? 'optimized-muted' : '');
      const optBadge = isActive === true ? '<span class="ds-compat-badge optimized" data-i18n="当前优化"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化</span>' : '';
      return `
        <div class="tools-modal-row ${enabled ? '' : 'disabled'} ${optClass}" data-tool="${escapeHtml(tool.name)}"${isActive === true ? ' data-optimized="1"' : ''}>
          <div class="tmr-main">
            <div class="tmr-name"><i class="fa-solid tmr-icon ${escapeHtml(tool.icon)}"></i>${escapeHtml(tool.name)}${dsBadge}${autoBadge}${optBadge}</div>
            <div class="tmr-desc">${escapeHtml(desc)}</div>
          </div>
          <div class="tmr-toggle">
            <div class="toggle-switch">
              <input type="checkbox" ${enabled ? 'checked' : ''} ${gated ? 'disabled' : ''} data-tool-name="${escapeHtml(tool.name)}">
              <span class="toggle-slider"></span>
            </div>
          </div>
        </div>`;
    }).join('');
    body.querySelectorAll('input[data-tool-name]').forEach(cb => {
      cb.addEventListener('change', async () => {
        if (typeof isConfigGatedTool === 'function' && isConfigGatedTool(cb.dataset.toolName)) {
          cb.checked = true;
          return; // 门控工具配置后自动启用，不允许手动关闭
        }
        await updateToolSetting(cb.dataset.toolName, cb.checked, cb);
        renderToolGroupModal(category);
        loadToolsPage();
      });
    });
  }

  function openToolGroupModal(category) {
    if (!category) return;
    renderToolGroupModal(category);
    const modal = document.getElementById('tools-group-modal');
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    try { window.api.webControlPushDomEvent?.({ type: 'dom_update', selector: '#tools-group-modal', attr: 'class', value: modal.className }); } catch (_) {}
  }

  function closeToolGroupModal() {
    const modal = document.getElementById('tools-group-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  document.getElementById('tools-modal-close')?.addEventListener('click', closeToolGroupModal);
  if (typeof bindBackdropClose === 'function') {
    bindBackdropClose(document.getElementById('tools-group-modal'), closeToolGroupModal);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('tools-group-modal')?.classList.contains('open')) {
      closeToolGroupModal();
    }
  });
  document.getElementById('tools-modal-all-on')?.addEventListener('click', async () => {
    if (currentToolModalCategory) {
      await setToolCategoryEnabled(currentToolModalCategory, true);
      renderToolGroupModal(currentToolModalCategory);
      loadToolsPage();
    }
  });
  document.getElementById('tools-modal-all-off')?.addEventListener('click', async () => {
    if (currentToolModalCategory) {
      await setToolCategoryEnabled(currentToolModalCategory, false);
      renderToolGroupModal(currentToolModalCategory);
      loadToolsPage();
    }
  });
  document.getElementById('tools-modal-mcp-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    btn.disabled = true;
    try {
      const result = await window.api.mcpListTools();
      if (result && result.tools) {
        registerMcpTools(result.tools);
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        loadToolsPage();
        if (currentToolModalCategory) renderToolGroupModal(currentToolModalCategory);
      }
    } catch (err) {
      console.error('[MCP Refresh]', err);
    } finally {
      btn.classList.remove('spinning');
      btn.disabled = false;
    }
  });

  function loadToolsPage() {
    const groupsEl = document.getElementById('tools-groups');
    const enabledSettings = agent.settings.tools || {};
    // DeepSeek 插件工具：首次进入工具页时异步拉取一次（幂等，防漏显 DS 分组）
    if (typeof refreshDsPluginTools === 'function' && !window.__dsToolsRefreshed) {
      window.__dsToolsRefreshed = true;
      refreshDsPluginTools().catch(() => {});
    }
    // Filter tools by current mode (Chat vs Code)
    const mode = codeEditorModeFilter || 'chat';
    const allDefsRaw = getAllToolDefinitions(mode);
    // 配置门控工具（生图/决策）：未配置时不出现在工具页
    const allDefs = typeof filterToolDefsByConfig === 'function'
      ? filterToolDefsByConfig(allDefsRaw, agent.settings)
      : allDefsRaw;
    const isToolOn = (name) => (typeof isToolEnabledForSettings === 'function'
      ? isToolEnabledForSettings(name, agent.settings)
      : enabledSettings[name] !== false);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeToolSet = new Set((typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => isToolOn(t.name)).map(t => t.name));
    renderToolsStats(mode);

    // Sync mode switcher buttons
    document.querySelectorAll('.tools-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.toolMode === mode);
      // Style active button
      if (btn.dataset.toolMode === mode) {
        btn.style.background = 'var(--accent, #6366f1)';
        btn.style.color = 'white';
        btn.style.borderColor = 'transparent';
      } else {
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
      }
    });

    const autoOptimizeEl = document.getElementById('toggle-auto-optimize-tools');
    const autoOptimizeLabel = document.querySelector('.tools-auto-optimize');
    if (autoOptimizeEl) {
      autoOptimizeEl.checked = !!agent.settings.autoOptimizeToolSelection;
      // Code 模式不使用自动优化（始终用全部启用工具），隐藏开关
      if (autoOptimizeLabel) autoOptimizeLabel.style.display = (mode === 'code') ? 'none' : '';
      autoOptimizeEl.onchange = async () => {
        if (autoOptimizeEl.checked) {
          const confirmed = await window.confirmDialog(
            '开启后，每个新对话首条消息前会先优化本次可用工具集合，以节省上下文占用。\n\n注意：若任务中途发现工具不足，AI会通过内部机制重新优化。是否继续开启？',
            '开启自动优化工具选择'
          );
          if (!confirmed) {
            autoOptimizeEl.checked = false;
            return;
          }
        }
        agent.settings.autoOptimizeToolSelection = !!autoOptimizeEl.checked;
        await window.api.setSettings(agent.settings);
        if (typeof agent.resetOptimizedTools === 'function') {
          agent.resetOptimizedTools();
        }
        updateReoptimizeButtonVisibility();
        renderToolsStats();
      };
    }

    const categoryMap = new Map();
    for (const tool of allDefs) {
      const cat = tool.category || '其他';
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat).push(tool);
    }

    const isDsCategory = (cat) => String(cat || '').startsWith('DS:');
    const isMcpCategory = (cat) => String(cat || '').startsWith('MCP:');
    const dsEntries = [];
    const normalEntries = [];
    for (const [category, tools] of categoryMap.entries()) {
      (isDsCategory(category) ? dsEntries : normalEntries).push([category, tools]);
    }

    const renderRow = ([category, tools]) => {
      const enabledCount = tools.filter(t => isToolOn(t.name)).length;
      const allOn = enabledCount === tools.length;
      const noneOn = enabledCount === 0;
      const meta = typeof getCategoryMeta === 'function' ? getCategoryMeta(category) : { icon: 'fa-layer-group', desc: '' };
      const title = isMcpCategory(category)
        ? category.replace(/^MCP:/, '')
        : (tools[0]?.pluginName || (typeof i18nGetCategory === 'function' ? i18nGetCategory(category, category) : category));
      const dsBadge = isDsCategory(category)
        ? `<span class="ds-compat-badge ${tools[0]?.compatTier || 'native'}">${tools[0]?.compatTier || 'native'}</span>`
        : '';
      const stateLabel = allOn ? '开' : (noneOn ? '关' : '半开');
      const indeterminate = (!allOn && !noneOn) ? ' data-indeterminate="1"' : '';
      const optimizedCount = hasOptimized ? tools.filter(t => activeToolSet.has(t.name)).length : 0;
      const optClass = hasOptimized ? (optimizedCount > 0 ? 'optimized-active' : 'optimized-muted') : '';
      const optBadge = hasOptimized && optimizedCount > 0
        ? `<span class="tgr-optimized-badge" title="当前优化已选 ${optimizedCount} / ${tools.length}"><i class="fa-solid fa-wand-magic-sparkles"></i> ${optimizedCount}</span>`
        : '';
      return `
        <div class="tool-group-row ${isDsCategory(category) ? 'ds-plugin-row' : ''} ${optClass}" data-tool-category="${escapeHtml(category)}"${hasOptimized ? ` data-optimized-count="${optimizedCount}"` : ''} role="button" tabindex="0">
          <div class="tgr-name"><span class="tgr-icon"><i class="fa-solid ${meta.icon || 'fa-layer-group'}"></i></span>${escapeHtml(title)}${dsBadge}${optBadge}</div>
          <div class="tgr-desc">${escapeHtml(meta.desc || '')}</div>
          <div class="tgr-count"><strong>${enabledCount}</strong> / ${tools.length}</div>
          <div class="tgr-toggle">
            <span class="tgr-state-label">${stateLabel}</span>
            <div class="toggle-switch">
              <input type="checkbox" ${allOn ? 'checked' : ''}${indeterminate} data-tool-category-toggle="${escapeHtml(category)}">
              <span class="toggle-slider"></span>
            </div>
          </div>
        </div>`;
    };

    const sections = [];
    if (normalEntries.length > 0) {
      sections.push(`<div class="tools-group-section">${normalEntries.map(renderRow).join('')}</div>`);
    }
    if (dsEntries.length > 0) {
      sections.push(`
        <div class="tools-group-section ds-section">
          <div class="ds-section-header"><i class="fa-solid fa-puzzle-piece"></i> DeepSeek 插件工具</div>
          ${dsEntries.map(renderRow).join('')}
        </div>`);
    }
    groupsEl.innerHTML = sections.join('');

    // 三态：indeterminate 是 DOM 属性，无法用模板设置，需在插入后单独赋值
    groupsEl.querySelectorAll('input[data-tool-category-toggle][data-indeterminate]').forEach(cb => {
      cb.indeterminate = true;
      cb.removeAttribute('data-indeterminate');
    });

    // 组行点击 → 打开模态框
    groupsEl.querySelectorAll('.tool-group-row').forEach(row => {
      const open = (e) => {
        if (e.target.closest('input, .toggle-switch, .toggle-slider')) return;
        openToolGroupModal(row.dataset.toolCategory);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
      });
    });

    // 整组三态开关
    groupsEl.querySelectorAll('input[data-tool-category-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const category = cb.dataset.toolCategoryToggle;
        // 半开 → 点击时全部开启（组开关语义：非全开则全开）
        await setToolCategoryEnabled(category, cb.checked);
      });
    });

    // 渲染工具首次使用授权状态列表（Playwright / Computer Use）
    renderToolAuthList();
  }

  /**
   * 渲染工具首次使用授权状态列表（在工具管理页底部）。
   * 显示每个可授权工具的类别、当前状态（已授权/待授权）和撤销按钮。
   */
  async function renderToolAuthList() {
    const listEl = document.getElementById('tool-auth-list');
    if (!listEl) return;
    let settings;
    try { settings = await window.api.getSettings(); }
    catch (e) { return; }
    const granted = settings?.toolAuthGranted || { playwright: false, computerUse: false };
    const items = [
      {
        category: 'playwright',
        icon: 'fa-globe',
        name: '内置浏览器（Playwright）',
        granted: !!granted.playwright
      },
      {
        category: 'computerUse',
        icon: 'fa-desktop',
        name: '电脑控制（Computer Use）',
        granted: !!granted.computerUse
      }
    ];
    listEl.innerHTML = items.map(it => `
      <div class="tool-auth-item" data-category="${it.category}">
        <div class="ta-name"><i class="fa-solid ${it.icon}"></i> ${escapeHtml(it.name)}</div>
        <div class="ta-status ${it.granted ? 'granted' : 'pending'}">${it.granted ? '已授权' : '待授权'}</div>
        <button class="ta-revoke" ${it.granted ? '' : 'disabled'} data-cat="${it.category}">
          <i class="fa-solid fa-rotate-left"></i> 撤销
        </button>
      </div>
    `).join('');
    // 绑定撤销按钮
    listEl.querySelectorAll('.ta-revoke').forEach(btn => {
      btn.onclick = async () => {
        const cat = btn.dataset.cat;
        if (!cat) return;
        const ok = await window.confirmDialog(
          `撤销"${cat === 'playwright' ? '内置浏览器' : '电脑控制'}"的授权？\n\n下次 AI 调用该工具时将再次弹出授权询问。`,
          '撤销工具授权'
        );
        if (!ok) return;
        try {
          const s = await window.api.getSettings();
          if (!s.toolAuthGranted) s.toolAuthGranted = { playwright: false, computerUse: false };
          s.toolAuthGranted[cat] = false;
          await window.api.setSettings(s);
          // 同步刷新当前 agent 实例的 settings 和会话内缓存
          for (const a of [agent, codeAgent, babeAgent]) {
            if (a && a.settings) a.settings = s;
            if (a && a._sessionToolAuth) a._sessionToolAuth[cat] = false;
          }
          renderToolAuthList();
        } catch (e) { /* ignore */ }
      };
    });
  }

  async function setToolCategoryEnabled(category, enabled) {
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    const allCategoryTools = getAllToolDefinitions(codeEditorModeFilter || 'chat').filter(t => (t.category || '其他') === category);
    const toolsInCategory = typeof filterToolDefsByConfig === 'function'
      ? filterToolDefsByConfig(allCategoryTools, agent.settings)
      : allCategoryTools;
    toolsInCategory.forEach(t => {
      // 配置门控工具（生图/决策）配置后自动启用，不允许被组开关关闭
      if (typeof isConfigGatedTool === 'function' && isConfigGatedTool(t.name)) return;
      agent.settings.tools[t.name] = enabled;
    });
    await window.api.setSettings(agent.settings);
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    loadToolsPage();
  }

  async function updateToolSetting(name, enabled, checkboxEl) {
    // 配置门控工具（生图/决策）配置后自动启用，不允许手动关闭
    if (typeof isConfigGatedTool === 'function' && isConfigGatedTool(name)) {
      if (checkboxEl) checkboxEl.checked = true;
      return;
    }
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    agent.settings.tools[name] = enabled;
    await window.api.setSettings(agent.settings);
    if (checkboxEl) {
      checkboxEl.closest('.tool-card')?.classList.toggle('disabled', !enabled);
    }
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    if (typeof agent.resetOptimizedTools === 'function') {
      agent.resetOptimizedTools();
    }
    renderToolsStats();
    const groupEl = checkboxEl?.closest('.tool-group');
    if (groupEl) {
      const allChecks = Array.from(groupEl.querySelectorAll('input[data-tool-name]'));
      const enabledCount = allChecks.filter(c => c.checked).length;
      const countEl = groupEl.querySelector('[data-category-enabled]');
      if (countEl) countEl.textContent = String(enabledCount);
      const toggle = groupEl.querySelector('input[data-tool-category-toggle]');
      if (toggle) toggle.checked = enabledCount === allChecks.length;
    }
  }
