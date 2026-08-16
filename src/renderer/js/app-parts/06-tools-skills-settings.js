  // ---- Tools Page ----
  function renderToolsStats(mode) {
    mode = mode || codeEditorModeFilter || 'chat';
    const enabledSettings = agent.settings.tools || {};
    const allDefs = getAllToolDefinitions(mode);
    const total = allDefs.length;
    const enabledCount = allDefs.filter(t => enabledSettings[t.name] !== false).length;
    const enabledSchemas = getToolSchemas(enabledSettings, mode);
    const schemaChars = JSON.stringify(enabledSchemas).length;
    const estTokens = Math.ceil(schemaChars / 4);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeTools = (typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name);
    const activeMap = {};
    allDefs.forEach(t => { activeMap[t.name] = false; });
    activeTools.forEach(n => { activeMap[n] = true; });
    const activeSchemas = getToolSchemas(activeMap, mode);
    const activeTokens = Math.ceil(JSON.stringify(activeSchemas).length / 4);
    const savedTokens = Math.max(0, estTokens - activeTokens);
    const mcpCount = MCP_DYNAMIC_TOOLS.length;
    const mcpBadge = mcpCount > 0 ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-plug-circle-bolt"></i> MCP动态 <strong>${mcpCount}</strong></span>` : '';
    const optimizedInfo = agent.settings.autoOptimizeToolSelection
      ? (hasOptimized
        ? `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>${activeTools.length}</strong> / ${enabledCount}</span><span class="tools-stat"><i class="fa-solid fa-compress"></i> 优化后 <strong>~${activeTokens.toLocaleString()}</strong> tokens（节省 ~${savedTokens.toLocaleString()}）</span><span class="tools-stat" title="${escapeHtml(agent.optimizedToolReason || '')}"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(agent.optimizedToolReason || '已优化')}</span>`
        : `<span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-wand-magic-sparkles"></i> 当前优化: <strong>未执行</strong></span>`)
      : '';
    const statsEl = document.getElementById('tools-stats');
    if (statsEl) {
      statsEl.innerHTML = `<span class="tools-stat"><i class="fa-solid fa-toggle-on"></i> 已启用 <strong>${enabledCount}</strong> / ${total} 个工具</span><span class="tools-stat-sep">·</span><span class="tools-stat"><i class="fa-solid fa-layer-group"></i> 工具上下文 <strong>~${estTokens.toLocaleString()}</strong> tokens</span>${mcpBadge}${optimizedInfo}`;
    }
  }

  // ---- 工具组模态框（两级视图的第二级）----
  let currentToolModalCategory = null;

  function renderToolGroupModal(category) {
    currentToolModalCategory = category;
    const enabledSettings = agent.settings.tools || {};
    const mode = codeEditorModeFilter || 'chat';
    const tools = getAllToolDefinitions(mode).filter(t => (t.category || '其他') === category);
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
    body.innerHTML = tools.map(tool => {
      const enabled = enabledSettings[tool.name] !== false;
      const desc = typeof i18nGetToolDesc === 'function' ? i18nGetToolDesc(tool.name, tool.desc) : tool.desc;
      const dsBadge = tool.pluginId
        ? `<span class="ds-compat-badge ${tool.compatTier || 'native'}">${tool.compatTier || 'native'}</span>`
        : '';
      return `
        <div class="tools-modal-row ${enabled ? '' : 'disabled'}" data-tool="${escapeHtml(tool.name)}">
          <div class="tmr-main">
            <div class="tmr-name"><i class="fa-solid tmr-icon ${escapeHtml(tool.icon)}"></i>${escapeHtml(tool.name)}${dsBadge}</div>
            <div class="tmr-desc">${escapeHtml(desc)}</div>
          </div>
          <div class="tmr-toggle">
            <div class="toggle-switch">
              <input type="checkbox" ${enabled ? 'checked' : ''} data-tool-name="${escapeHtml(tool.name)}">
              <span class="toggle-slider"></span>
            </div>
          </div>
        </div>`;
    }).join('');
    body.querySelectorAll('input[data-tool-name]').forEach(cb => {
      cb.addEventListener('change', async () => {
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
  document.getElementById('tools-group-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeToolGroupModal();
  });
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
    const allDefs = getAllToolDefinitions(mode);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeToolSet = new Set((typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => enabledSettings[t.name] !== false).map(t => t.name));
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
      const enabledCount = tools.filter(t => enabledSettings[t.name] !== false).length;
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
      return `
        <div class="tool-group-row ${isDsCategory(category) ? 'ds-plugin-row' : ''}" data-tool-category="${escapeHtml(category)}" role="button" tabindex="0">
          <div class="tgr-name"><span class="tgr-icon"><i class="fa-solid ${meta.icon || 'fa-layer-group'}"></i></span>${escapeHtml(title)}${dsBadge}</div>
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
    const toolsInCategory = getAllToolDefinitions(codeEditorModeFilter || 'chat').filter(t => (t.category || '其他') === category);
    toolsInCategory.forEach(t => {
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

  // ---- Skills Page ----
  async function importStandardSkillFile(skillMdPath) {
    const readResult = await window.api.readFile(skillMdPath);
    if (!readResult?.ok) return { ok: false, error: readResult?.error || '读取 SKILL.md 失败' };

    const rootDir = getPathDirname(skillMdPath);
    const scripts = await collectSkillScripts(rootDir);
    const skillPayload = buildStandardSkillFromMarkdown(skillMdPath, readResult.content || '', scripts);

    const existing = await window.api.listSkills();
    const matched = (Array.isArray(existing) ? existing : []).find(s => String(s?.sourcePath || '') === String(skillMdPath));
    if (matched?.id) {
      const updated = await window.api.updateSkill(matched.id, skillPayload);
      if (updated?.ok === false) return { ok: false, error: updated.error || '更新技能失败' };
      return { ok: true, mode: 'updated', name: skillPayload.name };
    }
    const created = await window.api.createSkill(skillPayload);
    if (!created) return { ok: false, error: '创建技能失败' };
    return { ok: true, mode: 'created', name: skillPayload.name };
  }

  async function loadSkillsPage() {
    const list = document.getElementById('skills-list');
    const userSkills = await window.api.listSkills();
    // Merge bundled (built-in) skills with user skills.
    // User skills with the same name override bundled skills (matching agent behavior).
    let bundled = [];
    try {
      if (typeof BUNDLED_SKILLS !== 'undefined') bundled = BUNDLED_SKILLS || [];
    } catch { /* bundled-skills.js not loaded */ }
    const overriddenNames = new Set(userSkills.map(s => s.name));
    const visibleBundled = bundled.filter(s => !overriddenNames.has(s.name));
    const allSkills = [...visibleBundled, ...userSkills];

    if (allSkills.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-lightbulb"></i><p>暂无技能，点击上方按钮添加或导入 SKILL.md</p></div>';
      return;
    }
    list.innerHTML = allSkills.map(s => {
      const isBundled = !!s.bundled;
      const isOverriding = !isBundled && bundled.some(b => b.name === s.name);
      const iconClass = isBundled ? 'fa-shield-halved' : 'fa-lightbulb';
      const badgeHtml = isBundled
        ? '<span class="skill-badge skill-badge-builtin">内置</span>'
        : (isOverriding ? '<span class="skill-badge skill-badge-override">覆盖内置</span>' : '');
      const actionsHtml = isBundled
        ? `<button class="btn-icon skill-view" data-id="${escapeHtml(s.id || '')}" title="查看（只读）"><i class="fa-solid fa-eye"></i></button>`
        : `<button class="btn-icon skill-edit" data-id="${escapeHtml(s.id || '')}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
           <button class="btn-icon skill-delete" data-id="${s.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>`;
      return `
      <div class="skill-card${isBundled ? ' skill-card-builtin' : ''}" data-id="${s.id}">
        <div class="skill-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="skill-info">
          <div class="skill-name">${escapeHtml(s.name || '')} ${badgeHtml}</div>
          <div class="skill-desc">${escapeHtml(s.description || '')}</div>
          <div class="skill-meta">${escapeHtml(getSkillSummaryMeta(s))}</div>
        </div>
        <div class="skill-actions">${actionsHtml}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.skill-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.deleteSkill(btn.dataset.id);
        if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        loadSkillsPage();
      });
    });

    list.querySelectorAll('.skill-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id });
      });
    });

    list.querySelectorAll('.skill-view').forEach(btn => {
      btn.addEventListener('click', () => {
        window.api.openSkillEditor({ id: btn.dataset.id, readonly: true });
      });
    });
  }

  // Skill Modal
  function _resetSkillModalEditable() {
    ['skill-name', 'skill-desc', 'skill-prompt'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) el.removeAttribute('readonly');
    });
    const saveBtn = document.getElementById('btn-save-skill');
    if (saveBtn) saveBtn.style.display = '';
  }
  document.getElementById('btn-add-skill').addEventListener('click', () => {
    window.api.openSkillEditor({});
  });

  document.getElementById('btn-close-skill-modal').addEventListener('click', () => {
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
  });

  document.getElementById('btn-cancel-skill').addEventListener('click', () => {
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
  });

  document.getElementById('btn-save-skill').addEventListener('click', async () => {
    const editId = document.getElementById('skill-edit-id').value;
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    const prompt = document.getElementById('skill-prompt').value.trim();
    if (!name) return;
    if (editId) {
      await window.api.updateSkill(editId, { name, description, prompt });
    } else {
      await window.api.createSkill({ name, description, prompt });
    }
    if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
    agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    _resetSkillModalEditable();
    fadeOutHide(document.getElementById('skill-modal'));
    document.getElementById('skill-name').value = '';
    document.getElementById('skill-desc').value = '';
    document.getElementById('skill-prompt').value = '';
    document.getElementById('skill-edit-id').value = '';
    loadSkillsPage();
  });

  const btnImportStandardSkill = document.getElementById('btn-import-standard-skill');
  if (btnImportStandardSkill) {
    btnImportStandardSkill.addEventListener('click', async () => {
      const selectResult = await window.api.openFileDialog({
        title: '选择标准 Skill 文件（SKILL.md）',
        multiple: true,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      });
      if (!selectResult?.ok || !Array.isArray(selectResult.paths) || selectResult.paths.length === 0) return;

      const resultLines = [];
      for (const skillPath of selectResult.paths) {
        try {
          const imported = await importStandardSkillFile(skillPath);
          if (imported.ok) {
            resultLines.push(`${imported.mode === 'updated' ? '更新' : '导入'}成功：${imported.name}`);
          } else {
            resultLines.push(`导入失败：${getPathBasename(skillPath)} (${imported.error || '未知错误'})`);
          }
        } catch (e) {
          resultLines.push(`导入失败：${getPathBasename(skillPath)} (${e.message})`);
        }
      }

      if (typeof agent.refreshSkillsCatalog === 'function') await agent.refreshSkillsCatalog();
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      loadSkillsPage();
      addMessage('system', `技能导入结果：\n- ${resultLines.join('\n- ')}`);
    });
  }

  // ---- Knowledge Page ----
  async function loadKnowledgePage(query = '') {
    const list = document.getElementById('knowledge-list');
    const items = await window.api.knowledgeSearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-database"></i><p>知识库为空</p></div>';
      return;
    }
    list.innerHTML = items.map(k => `
      <div class="knowledge-item" data-id="${k.id}">
        <div class="item-title">${escapeHtml(k.title || '未命名')}</div>
        <div class="item-content">${escapeHtml(k.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(k.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-actions">
            <button class="btn-icon knowledge-delete" data-id="${k.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.knowledge-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条知识吗？');
        if (!confirmed) return;
        await window.api.knowledgeDelete(btn.dataset.id);
        loadKnowledgePage(query);
      });
    });
  }

  document.getElementById('knowledge-search').addEventListener('input', (e) => {
    loadKnowledgePage(e.target.value);
  });

  // Knowledge import button
  const btnImportKnowledge = document.getElementById('btn-import-knowledge');
  if (btnImportKnowledge) {
    btnImportKnowledge.addEventListener('click', async () => {
      try {
        // 先选择文件
        const selectResult = await window.api.openFileDialog();
        if (!selectResult.ok || !selectResult.paths || selectResult.paths.length === 0) return;

        // 对每个文件进行导入
        for (const filePath of selectResult.paths) {
          const result = await window.api.knowledgeImportFile(filePath, agent.workspacePath);
          if (result.ok) {
            const title = result.fileName || '导入文件';
            await window.api.knowledgeAdd({ title, content: result.content });

            // 如果有提取的图片，也添加到消息中作为引用
            if (result.images && result.images.length > 0) {
              await window.api.knowledgeAdd({
                title: `${title} - 图片`,
                content: `图片文件：${result.images.join(', ')}`
              });
            }
          } else {
            const errMsg = result.error || '导入失败';
            if (typeof window.showToast === 'function') {
              window.showToast(`${result.fileName || '文件'}: ${errMsg}`, 'error', 6000);
            } else {
              console.error('Knowledge import failed:', errMsg);
            }
          }
        }
        loadKnowledgePage();
      } catch (e) {
        console.error('Import knowledge error:', e);
      }
    });
  }

  // ---- Memory Page ----
  async function loadMemoryPage(query = '') {
    const list = document.getElementById('memory-list');
    const items = await window.api.memorySearch(query);
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-brain"></i><p>暂无长期记忆</p></div>';
      return;
    }
    list.innerHTML = items.map(m => `
      <div class="memory-item" data-id="${m.id}">
        <div class="item-content">${escapeHtml(m.content || '')}</div>
        <div class="item-meta">
          <span>${new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
          <div class="item-tags">${(m.tags || []).map(t => `<span class="item-tag">${escapeHtml(t)}</span>`).join('')}</div>
          <div class="item-actions">
            <button class="btn-icon memory-edit" data-id="${m.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon memory-delete" data-id="${m.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      </div>`).join('');

    list.querySelectorAll('.memory-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await window.api.confirmSensitive('确定要删除这条记忆吗？');
        if (!confirmed) return;
        await window.api.memoryDelete(btn.dataset.id);
        loadMemoryPage(query);
      });
    });

    list.querySelectorAll('.memory-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const current = items.find(i => String(i.id) === String(id));
        const result = await openMemoryEditDialog(current);
        if (!result) return;
        await window.api.memoryUpdate(id, { content: result.content, tags: result.tags });
        loadMemoryPage(query);
      });
    });
  }

  document.getElementById('memory-search').addEventListener('input', (e) => {
    loadMemoryPage(e.target.value);
  });

  // ---- Memory Edit Modal ----
  let memoryEditResolve = null;
  function openMemoryEditDialog(item) {
    return new Promise((resolve) => {
      const modal = document.getElementById('memory-edit-modal');
      const contentEl = document.getElementById('memory-edit-content');
      const tagsEl = document.getElementById('memory-edit-tags');
      if (!modal || !contentEl || !tagsEl) {
        resolve(null);
        return;
      }
      memoryEditResolve = resolve;
      contentEl.value = item?.content || '';
      tagsEl.value = (item?.tags || []).join(', ');
      modal.classList.remove('hidden');
      contentEl.focus();
    });
  }

  function closeMemoryEditDialog(result) {
    const modal = document.getElementById('memory-edit-modal');
    fadeOutHide(modal);
    if (memoryEditResolve) {
      memoryEditResolve(result);
      memoryEditResolve = null;
    }
  }

  document.getElementById('btn-close-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-cancel-memory-edit')?.addEventListener('click', () => {
    closeMemoryEditDialog(null);
  });

  document.getElementById('btn-save-memory-edit')?.addEventListener('click', () => {
    const contentEl = document.getElementById('memory-edit-content');
    const tagsEl = document.getElementById('memory-edit-tags');
    const content = contentEl?.value.trim() || '';
    const tags = (tagsEl?.value || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!content) return;
    closeMemoryEditDialog({ content, tags });
  });

  // ---- Settings Page ----
  function updateLLMProviderFields(provider) {
    const openaiFields = document.getElementById('llm-openai-fields');
    const zenFields = document.getElementById('llm-zen-fields');
    if (!openaiFields || !zenFields) return;
    if (provider === 'opencode-zen') {
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
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      const res = await window.api.zenFetchModels();
      if (!res || !res.ok || !Array.isArray(res.models)) {
        sel.innerHTML = '<option value="">(获取失败)</option>';
        if (hint) hint.textContent = res?.error || '获取失败，请检查 Zen API Key 或网络';
        return;
      }
      const FREE_KEYWORDS = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
      // 检测是否为免登录公共 key：若是，则只展示免费模型
      const keyInput = document.getElementById('setting-llm-zen-key');
      const isPublicKey = (keyInput?.value || '').trim() === 'public' || keyInput?.dataset?.publicKey === '1';
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
        const isFree = FREE_KEYWORDS.test(m.id);
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
      if (hint) hint.textContent = `共 ${models.length} 个可用模型（标 [免费] 的为免费模型）`;
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }

  // OpenAI-compat 模型列表：原生 datalist 在模型过多时无法完整展示，
  // 改为自绘可搜索可滚动的下拉面板，保证所有模型都能看到。
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

  async function loadUsageStats(period) {
    const summaryEl = document.getElementById('usage-summary');
    const chartEl = document.getElementById('usage-chart');
    const modelsEl = document.getElementById('usage-models');
    if (!summaryEl || !chartEl || !modelsEl) return;
    summaryEl.innerHTML = '<div style="opacity:0.6">加载中...</div>';
    chartEl.innerHTML = '';
    modelsEl.innerHTML = '';
    try {
      const res = await window.api.usageGetRange(period || 'daily');
      if (!res || !res.ok) {
        summaryEl.innerHTML = '<div>加载失败</div>';
        return;
      }
      const fmt = (n) => (n || 0).toLocaleString();
      const fmtUSD = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const data = res;
      const hasCost = (data.costUSD || 0) > 0 || (data.inputCost || 0) > 0 || (data.outputCost || 0) > 0;
      const cards = [
        { label: '总 Token', value: fmt(data.totalTokens), accent: true },
        { label: '提示 Token', value: fmt(data.promptTokens) },
        { label: '生成 Token', value: fmt(data.completionTokens) },
        { label: '请求次数', value: fmt(data.requestCount) }
      ];
      // 若有费用数据则加入金钱卡片
      if (hasCost) {
        cards.push({ label: '总消费 (USD)', value: fmtUSD(data.costUSD), accent: true, kind: 'cost' });
        cards.push({ label: '输入消费', value: fmtUSD(data.inputCost), kind: 'cost' });
        cards.push({ label: '输出消费', value: fmtUSD(data.outputCost), kind: 'cost' });
        if ((data.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmtUSD(data.cacheReadCost), kind: 'cost' });
        if ((data.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmtUSD(data.cacheWriteCost), kind: 'cost' });
      }
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''}${c.kind === 'cost' ? ' cost' : ''}">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');
      // chart: 按小时（daily）或按天（weekly/monthly）
      const isHourly = data.isHourly;
      const chartTitleEl = document.getElementById('usage-chart-title');
      if (chartTitleEl) chartTitleEl.textContent = isHourly ? '按小时趋势' : '按日趋势';
      const chartData = isHourly ? (data.hours || []) : (data.days || []);
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        const max = Math.max(1, ...chartData.map(d => d.total || 0));
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round((d.total / max) * 140));
          const label = isHourly ? `${d.hour}h` : d.date.slice(5);
          const costStr = (d.costUSD || 0) > 0 ? ` · $${(d.costUSD || 0).toFixed(4)}` : '';
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.total)} tokens${costStr}` : `${d.date}: ${fmt(d.total)} tokens${costStr}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
        chartEl.style.marginBottom = '20px';
      }
      // by model
      const models = data.models || {};
      const modelEntries = Object.entries(models).sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
      if (modelEntries.length === 0) {
        modelsEl.innerHTML = '<div style="opacity:0.5;font-size:12px;">无数据</div>';
      } else {
        modelsEl.innerHTML = modelEntries.map(([id, st]) => {
          const costStr = (st.costUSD || 0) > 0 ? ` · <span style="color:var(--accent)">$${(st.costUSD || 0).toFixed(4)}</span>` : '';
          return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
            <span style="font-family:monospace;font-size:12px;">${id}</span>
            <span><b>${fmt(st.total)}</b> tokens · ${fmt(st.count)} 次${costStr}</span>
          </div>`;
        }).join('');
      }
    } catch (e) {
      summaryEl.innerHTML = '<div>错误: ' + (e?.message || e) + '</div>';
    }
  }

  async function loadSettingsPage() {
    const s = await window.api.getSettings();
    populateFontSelects(s);
    applyFontSettings(s);
    document.getElementById('setting-llm-url').value = s.llm.apiUrl || '';
    document.getElementById('setting-llm-key').value = s.llm.apiKey || '';
    document.getElementById('setting-llm-model').value = s.llm.model || '';
    document.getElementById('setting-llm-temp').value = s.llm.temperature;
    document.getElementById('setting-temp-val').textContent = s.llm.temperature;
    document.getElementById('setting-llm-ctx').value = s.llm.maxContextLength;
    document.getElementById('setting-llm-max-response').value = s.llm.maxResponseTokens || 8192;
    document.getElementById('setting-llm-daily-limit').value = s.llm.dailyMaxTokens || 0;
    document.getElementById('setting-llm-stream').checked = s.llm.streamResponses !== false;
    const forceVisionEl = document.getElementById('setting-llm-force-vision');
    if (forceVisionEl) forceVisionEl.checked = s.llm.forceVision === true;
    document.getElementById('setting-llm-retries').value = s.llm.maxRetries ?? 10;
    document.getElementById('setting-llm-timeout').value = Math.round((s.llm.timeoutMs ?? 300000) / 1000);
    document.getElementById('setting-llm-fallback-model').value = s.llm.fallbackModel || '';
    const llmUsage = s.llm.dailyTokensUsed || 0;
    const llmLimit = s.llm.dailyMaxTokens || 0;
    const llmUsageEl = document.getElementById('setting-llm-usage');
    llmUsageEl.textContent = `今日已用: ${llmUsage}`;
    if (llmLimit > 0 && llmUsage >= llmLimit * 0.8) {
      llmUsageEl.classList.add('warning');
      llmUsageEl.textContent = `今日已用: ${llmUsage} (接近限制 ${llmLimit})`;
    }

    // Provider / Zen / Reasoning
    const provider = s.llm.provider || 'openai-compat';
    document.getElementById('setting-llm-provider').value = provider;
    const zenKeyEl = document.getElementById('setting-llm-zen-key');
    if (zenKeyEl) {
      zenKeyEl.value = s.llm.zenApiKey || '';
      // 标记是否为免登录 public key，用于 refreshZenModels 过滤
      if ((s.llm.zenApiKey || '').trim() === 'public') {
        zenKeyEl.dataset.publicKey = '1';
      } else {
        delete zenKeyEl.dataset.publicKey;
      }
    }
    const reasoningEl = document.getElementById('setting-llm-reasoning');
    if (reasoningEl) reasoningEl.value = s.llm.reasoningEffort || 'off';
    // 动态变体档位：按当前模型能力拉取并收敛（异步，不阻塞设置页渲染）
    refreshReasoningVariants();
    updateLLMProviderFields(provider);
    if (provider === 'opencode-zen') {
      const zenModelSel = document.getElementById('setting-llm-zen-model');
      if (zenModelSel) refreshZenModels(s.llm.model);
    }

    document.getElementById('setting-img-url').value = s.imageGen.apiUrl || '';
    document.getElementById('setting-img-key').value = s.imageGen.apiKey || '';
    document.getElementById('setting-img-model').value = s.imageGen.model || '';
    document.getElementById('setting-img-size').value = s.imageGen.imageSize || '1024x1024';
    document.getElementById('setting-img-daily-limit').value = s.imageGen.dailyMaxImages || 0;
    const imgUsage = s.imageGen.dailyImagesUsed || 0;
    const imgLimit = s.imageGen.dailyMaxImages || 0;
    const imgUsageEl = document.getElementById('setting-img-usage');
    imgUsageEl.textContent = `今日已用: ${imgUsage}`;
    if (imgLimit > 0 && imgUsage >= imgLimit * 0.8) {
      imgUsageEl.classList.add('warning');
      imgUsageEl.textContent = `今日已用: ${imgUsage} (接近限制 ${imgLimit})`;
    }

    document.getElementById('setting-accent-color').value = s.theme.accentColor;
    document.getElementById('setting-bg-color').value = s.theme.backgroundColor;
    document.getElementById('setting-ui-animations').checked = s.animations !== false;
    document.getElementById('setting-ui-modal-animations').checked = s.modalAnimations !== false;
    document.getElementById('setting-auto-approve').checked = s.autoApproveSensitive;

    // 隐私信息保护
    const priv = s.privacyProtection || {};
    const privEnabledEl = document.getElementById('setting-privacy-enabled');
    if (privEnabledEl) privEnabledEl.checked = priv.enabled === true;
    const privResultsEl = document.getElementById('setting-privacy-filter-results');
    if (privResultsEl) privResultsEl.checked = priv.filterResults !== false;
    const privArgsEl = document.getElementById('setting-privacy-filter-args');
    if (privArgsEl) privArgsEl.checked = priv.filterArgs !== false;
    const privTermEl = document.getElementById('setting-privacy-filter-terminal');
    if (privTermEl) privTermEl.checked = priv.filterTerminal !== false;
    const privAttachEl = document.getElementById('setting-privacy-filter-attachments');
    if (privAttachEl) privAttachEl.checked = priv.filterAttachments !== false;
    // 过滤类别勾选（缺失键按 DEFAULT_CATEGORIES 默认值，如 evasion 默认关）
    const catEls = document.querySelectorAll('#privacy-categories-item input[data-cat]');
    if (catEls.length > 0) {
      const cats = (priv.categories && typeof priv.categories === 'object') ? priv.categories : {};
      const defCats = (window.PrivacyFilter && window.PrivacyFilter.DEFAULT_CATEGORIES) || {};
      catEls.forEach(inp => {
        const val = cats[inp.dataset.cat];
        inp.checked = val === true ? true : (val === false ? false : defCats[inp.dataset.cat] === true);
      });
    }
    updatePrivacyTriggerState(priv.enabled === true);

    // 后台托盘模式
    const trayEnabledEl = document.getElementById('setting-tray-enabled');
    const closeToTrayEl = document.getElementById('setting-close-to-tray');
    if (trayEnabledEl) trayEnabledEl.checked = s.trayEnabled !== false;
    if (closeToTrayEl) closeToTrayEl.value = ['ask', 'always', 'never'].includes(s.closeToTray) ? s.closeToTray : 'ask';

    // Theme mode
    document.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === s.theme.mode);
    });

    // AI Persona settings
    const persona = s.aiPersona || {};
    const nameEl = document.getElementById('setting-ai-name');
    const bioEl = document.getElementById('setting-ai-bio');
    const pronounsEl = document.getElementById('setting-ai-pronouns');
    const personalityEl = document.getElementById('setting-ai-personality');
    const customPromptEl = document.getElementById('setting-ai-custom-prompt');
    if (nameEl) nameEl.value = persona.name || '';
    if (bioEl) bioEl.value = persona.bio || '';
    if (pronounsEl) pronounsEl.value = persona.pronouns || '';
    if (personalityEl) personalityEl.value = persona.personality || '';
    if (customPromptEl) customPromptEl.value = persona.customPrompt || '';
    // 命运之牌 UI 可见性开关（默认 true）
    const tarotVisibleEl = document.getElementById('setting-tarot-visible');
    if (tarotVisibleEl) tarotVisibleEl.checked = s.tarotVisible !== false;
    applyTarotVisibility(s.tarotVisible !== false);
    // Notification settings (default: enabled + all categories on)
    const notif = s.notifications || {};
    const notifEnabledEl = document.getElementById('setting-notify-enabled');
    if (notifEnabledEl) notifEnabledEl.checked = notif.enabled !== false;
    const notifApprovalEl = document.getElementById('setting-notify-approval');
    if (notifApprovalEl) notifApprovalEl.checked = notif.approval !== false;
    const notifSessionEl = document.getElementById('setting-notify-session-done');
    if (notifSessionEl) notifSessionEl.checked = notif.sessionDone !== false;
    const notifQuestionEl = document.getElementById('setting-notify-question');
    if (notifQuestionEl) notifQuestionEl.checked = notif.question !== false;
    const notifPresentEl = document.getElementById('setting-notify-present');
    if (notifPresentEl) notifPresentEl.checked = notif.present !== false;
    const notifBabeProactiveEl = document.getElementById('setting-notify-babe-proactive');
    if (notifBabeProactiveEl) notifBabeProactiveEl.checked = notif.babeProactive !== false;
    const notifUpdateEl = document.getElementById('setting-notify-update');
    if (notifUpdateEl) notifUpdateEl.checked = notif.updateAvailable !== false;
    // Update-check settings
    const upd = s.updates || {};
    const updAutoEl = document.getElementById('setting-updates-auto');
    if (updAutoEl) updAutoEl.checked = upd.autoCheckEnabled !== false;
    const updIntervalEl = document.getElementById('setting-updates-interval');
    if (updIntervalEl) updIntervalEl.value = String([6, 12, 24].includes(Number(upd.intervalHours)) ? Number(upd.intervalHours) : 6);
    renderUpdateCheckResult(upd);
    // Language setting
    const langSelect = document.getElementById('setting-language');
    if (langSelect) langSelect.value = s.language || 'zh-CN';
    // Avatar migration: if stored as file path, convert to base64
    let aiAvatarData = persona.avatar || '';
    if (aiAvatarData && !aiAvatarData.startsWith('data:') && !aiAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(aiAvatarData);
      if (enc.ok) { aiAvatarData = enc.dataUrl; s.aiPersona.avatar = aiAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 AI 头像框状态并预加载 SVG
    _avatarFrameState.ai = persona.avatarFrame || null;
    if (_avatarFrameState.ai) await loadAvatarFrameSVG(_avatarFrameState.ai);
    updateAvatarPreview(aiAvatarData);

    // Babe Mode settings
    const babe = s.babe || {};
    const babeNameEl = document.getElementById('setting-babe-name');
    const babeGenderEl = document.getElementById('setting-babe-gender');
    const babeAgeEl = document.getElementById('setting-babe-age');
    const babePersonalityEl = document.getElementById('setting-babe-personality');
    const babePersonaEl = document.getElementById('setting-babe-persona');
    const babeUserNicknameEl = document.getElementById('setting-babe-user-nickname');
    const babeProactiveIntervalEl = document.getElementById('setting-babe-proactive-interval');
    const babeInitialAffectionEl = document.getElementById('setting-babe-initial-affection');
    if (babeNameEl) babeNameEl.value = babe.name || '';
    if (babeGenderEl) babeGenderEl.value = babe.gender || 'female';
    if (babeAgeEl) babeAgeEl.value = babe.age || '';
    if (babePersonalityEl) babePersonalityEl.value = babe.personality || '';
    if (babePersonaEl) babePersonaEl.value = babe.persona || '';
    if (babeUserNicknameEl) babeUserNicknameEl.value = babe.userNickname || '';
    if (babeProactiveIntervalEl) babeProactiveIntervalEl.value = String(babe.proactiveInterval ?? 0);
    if (babeInitialAffectionEl) babeInitialAffectionEl.value = babe.initialAffection ?? 30;
    // Babe 头像：迁移文件路径为 base64（与 AI/User 头像一致）
    let babeAvatarData = babe.avatar || '';
    if (babeAvatarData && !babeAvatarData.startsWith('data:') && !babeAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(babeAvatarData);
      if (enc.ok) { babeAvatarData = enc.dataUrl; s.babe.avatar = babeAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 Babe 头像框状态并预加载 SVG
    _avatarFrameState.babe = babe.avatarFrame || null;
    if (_avatarFrameState.babe) await loadAvatarFrameSVG(_avatarFrameState.babe);
    updateBabeAvatarPreview(babeAvatarData);

    // User Profile settings
    const userProfile = s.userProfile || {};
    const userNameEl = document.getElementById('setting-user-name');
    const userBioEl = document.getElementById('setting-user-bio');
    if (userNameEl) userNameEl.value = userProfile.name || '';
    if (userBioEl) userBioEl.value = userProfile.bio || '';
    let userAvatarData = userProfile.avatar || '';
    if (userAvatarData && !userAvatarData.startsWith('data:') && !userAvatarData.startsWith('http')) {
      const enc = await window.api.avatarEncodeFile(userAvatarData);
      if (enc.ok) { userAvatarData = enc.dataUrl; s.userProfile.avatar = userAvatarData; await window.api.setSettings(s); }
    }
    // 头像框系统：加载 User 头像框状态并预加载 SVG
    _avatarFrameState.user = userProfile.avatarFrame || null;
    if (_avatarFrameState.user) await loadAvatarFrameSVG(_avatarFrameState.user);
    updateUserAvatarPreview(userAvatarData);
    window.api.webControlSetAvatars({ ai: aiAvatarData, user: userAvatarData });

    // 头像框系统：加载并渲染头像框选择器 grid（异步，不阻塞设置面板其他渲染）
    loadAvatarFrames();
    // 同步更新 Hero 显示的头像框
    updatePersonaDisplay(persona);

    // Entropy settings
    const entropy = s.entropy || {};
    document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.source === (entropy.source || 'csprng')));
    document.getElementById('entropy-trng-settings').style.display = entropy.source === 'trng' ? '' : 'none';
    document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (entropy.trngMode || 'network')));
    document.getElementById('trng-network-settings').style.display = (entropy.trngMode || 'network') === 'network' ? '' : 'none';
    document.getElementById('trng-serial-settings').style.display = entropy.trngMode === 'serial' ? '' : 'none';
    const trngHostEl = document.getElementById('setting-trng-host');
    if (trngHostEl) trngHostEl.value = entropy.trngNetworkHost || '192.168.4.1';
    const trngPortEl = document.getElementById('setting-trng-port');
    if (trngPortEl) trngPortEl.value = entropy.trngNetworkPort || 80;
    const trngBaudEl = document.getElementById('setting-trng-serial-baud');
    if (trngBaudEl) trngBaudEl.value = entropy.trngSerialBaud || 115200;
    const trngSerialEl = document.getElementById('setting-trng-serial-port');
    if (trngSerialEl && entropy.trngSerialPort) trngSerialEl.value = entropy.trngSerialPort;
    if (entropy.trngMode === 'serial') {
      refreshTrngPorts(false);
    }

    // 更新配色方案可见性
    updateColorSchemeVisibility();

    // Proxy settings
    const proxy = s.proxy || {};
    document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === (proxy.mode || 'system'));
    });
    document.getElementById('manual-proxy-settings').style.display = proxy.mode === 'manual' ? '' : 'none';
    const proxyHttpEl = document.getElementById('setting-proxy-http');
    if (proxyHttpEl) proxyHttpEl.value = proxy.http || '';
    const proxyHttpsEl = document.getElementById('setting-proxy-https');
    if (proxyHttpsEl) proxyHttpsEl.value = proxy.https || '';
    const proxyBypassEl = document.getElementById('setting-proxy-bypass');
    if (proxyBypassEl) proxyBypassEl.value = proxy.bypass || 'localhost,127.0.0.1';

    // MCP settings
    await loadMcpServerList();
    setupMcpEvents();

    // Email settings
    const email = s.email || {};
    const eid = (id, prop, def='') => { const el = document.getElementById(id); if (el) el.value = email[prop] ?? def; };
    const emailModeEl = document.getElementById('setting-email-mode');
    if (emailModeEl) emailModeEl.value = email.mode || 'send-receive';
    updateEmailModeVisibility(email.mode || 'send-receive');
    eid('setting-email-smtp-host', 'smtpHost');
    eid('setting-email-smtp-port', 'smtpPort', 587);
    const smtpSecure = document.getElementById('setting-email-smtp-secure');
    if (smtpSecure) smtpSecure.checked = email.smtpSecure !== false;
    eid('setting-email-imap-host', 'imapHost');
    eid('setting-email-imap-port', 'imapPort', 993);
    const imapTls = document.getElementById('setting-email-imap-tls');
    if (imapTls) imapTls.checked = email.imapTls !== false;
    eid('setting-email-user', 'emailUser');
    eid('setting-email-pass', 'emailPass');
    eid('setting-email-owner', 'ownerAddress');
    eid('setting-email-totp-secret', 'totpSecret');
    eid('setting-email-poll-interval', 'pollInterval', 30);
    eid('setting-email-resend-interval', 'resendIntervalMinutes', 30);
    eid('setting-email-max-resends', 'maxResends', 3);
    const emailEnabled = document.getElementById('setting-email-enabled');
    if (emailEnabled) emailEnabled.checked = !!email.enabled;
    // 渲染控制白名单
    renderEmailAllowedSenders(email.allowedSenders || []);
    setupEmailEvents();

    // Web Control settings
    const wc = s.webControl || {};
    const wcPortEl = document.getElementById('setting-wc-port');
    if (wcPortEl) wcPortEl.value = wc.port || 3456;
    const wcEnabledEl = document.getElementById('setting-wc-enabled');
    if (wcEnabledEl) wcEnabledEl.checked = !!wc.enabled;
    const wcAutoStartEl = document.getElementById('setting-wc-autostart');
    if (wcAutoStartEl) wcAutoStartEl.checked = !!wc.autoStartOnOpen;
    const wc2faEl = document.getElementById('setting-wc-enable-2fa');
    if (wc2faEl) {
      wc2faEl.checked = !!wc.enable2FA;
      document.getElementById('wc-2fa-area').style.display = wc.enable2FA ? '' : 'none';
    }
    // Update toggle button state
    updateWcToggleButton();
    setupWebControlEvents();
    loadImeSettings();
  }

  // ---- MCP Settings Helpers ----
  let mcpEventsSetup = false;

  // ---- Email Settings Helpers ----
  let emailEventsSetup = false;

  function updateEmailModeVisibility(mode) {
    const smtpGroup = document.getElementById('email-smtp-group');
    const imapGroup = document.getElementById('email-imap-group');
    if (smtpGroup) smtpGroup.style.display = (mode === 'send-only' || mode === 'send-receive') ? '' : 'none';
    if (imapGroup) imapGroup.style.display = (mode === 'receive-only' || mode === 'send-receive') ? '' : 'none';
  }

  // 渲染邮件控制白名单列表
  function renderEmailAllowedSenders(senders) {
    const listEl = document.getElementById('email-allowed-senders-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const arr = Array.isArray(senders) ? senders : [];
    if (arr.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:12px;color:var(--text-tertiary);padding:6px 0';
      empty.textContent = '白名单为空。将只接受"用户邮箱地址"的指令。';
      listEl.appendChild(empty);
      return;
    }
    for (const addr of arr) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border)';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-envelope';
      icon.style.cssText = 'font-size:12px;color:var(--accent)';
      const text = document.createElement('span');
      text.style.cssText = 'flex:1;font-size:13px;word-break:break-all';
      text.textContent = addr;
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon btn-sm';
      delBtn.title = '删除';
      delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delBtn.style.cssText = 'color:var(--danger);padding:2px 6px';
      delBtn.addEventListener('click', async () => {
        const s = await window.api.getSettings();
        const cur = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders : [];
        const next = cur.filter(x => String(x).toLowerCase() !== String(addr).toLowerCase());
        s.email = { ...(s.email || {}), allowedSenders: next };
        await saveSettings(s);
        renderEmailAllowedSenders(next);
      });
      row.appendChild(icon);
      row.appendChild(text);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  // 绑定白名单输入框添加按钮事件（只绑定一次）
  let emailAllowedSendersEventsSetup = false;
  function setupEmailAllowedSendersEvents() {
    if (emailAllowedSendersEventsSetup) return;
    emailAllowedSendersEventsSetup = true;
    const addBtn = document.getElementById('btn-email-add-sender');
    const input = document.getElementById('email-allowed-sender-input');
    if (!addBtn || !input) return;

    const doAdd = async () => {
      const val = (input.value || '').trim().toLowerCase();
      if (!val) return;
      // 简单邮箱格式校验
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        alert('请输入有效的邮箱地址');
        return;
      }
      const s = await window.api.getSettings();
      const cur = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders.map(x => String(x).toLowerCase()) : [];
      if (cur.includes(val)) {
        alert('该邮箱已在白名单中');
        return;
      }
      cur.push(val);
      s.email = { ...(s.email || {}), allowedSenders: cur };
      await saveSettings(s);
      input.value = '';
      renderEmailAllowedSenders(cur);
    };

    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });
  }

  function setupEmailEvents() {
    if (emailEventsSetup) return;
    emailEventsSetup = true;

    // Mode change
    document.getElementById('setting-email-mode')?.addEventListener('change', (e) => {
      updateEmailModeVisibility(e.target.value);
    });

    // 白名单按钮事件
    setupEmailAllowedSendersEvents();

    // Generate TOTP
    document.getElementById('btn-email-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.emailGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('email-totp-qr-area');
        const qrImg = document.getElementById('email-totp-qr-img');
        const secretText = document.getElementById('email-totp-secret-text');
        const secretInput = document.getElementById('setting-email-totp-secret');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        if (secretInput) secretInput.value = result.secret;
        // Save secret immediately
        await window.api.emailSaveTOTPSecret(result.secret);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-email-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('email-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.emailVerifyTOTP(code);
      const span = document.getElementById('email-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Test connection
    document.getElementById('btn-email-test')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '正在测试连接...'; resultEl.style.color = 'var(--text-secondary)'; }
      // Save first
      await saveEmailSettings();
      const result = await window.api.emailConnect();
      if (result.ok) {
        if (resultEl) { resultEl.textContent = `✅ 连接成功。SMTP: ${result.smtp || 'OK'}, IMAP: ${result.imap || 'OK'}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (resultEl) { resultEl.textContent = `❌ 连接失败: ${result.error}`; resultEl.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save settings
    document.getElementById('btn-email-save')?.addEventListener('click', async () => {
      await saveEmailSettings();
      const resultEl = document.getElementById('email-test-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      // If enabled, start polling
      const enabled = document.getElementById('setting-email-enabled')?.checked;
      if (enabled) {
        const r = await window.api.emailStartPolling();
        if (r.ok && resultEl) resultEl.textContent += '，邮件轮询已启动';
      } else {
        await window.api.emailStopPolling();
      }
    });
  }

  async function saveEmailSettings() {
    const s = await window.api.getSettings();
    // 保留已有的 allowedSenders 列表（白名单由专门的添加/删除按钮管理，这里只读不覆盖）
    const existingAllowed = Array.isArray(s.email?.allowedSenders) ? s.email.allowedSenders : [];
    s.email = {
      enabled: document.getElementById('setting-email-enabled')?.checked || false,
      mode: document.getElementById('setting-email-mode')?.value || 'send-receive',
      smtpHost: document.getElementById('setting-email-smtp-host')?.value?.trim() || '',
      smtpPort: parseInt(document.getElementById('setting-email-smtp-port')?.value) || 587,
      smtpSecure: document.getElementById('setting-email-smtp-secure')?.checked ?? true,
      imapHost: document.getElementById('setting-email-imap-host')?.value?.trim() || '',
      imapPort: parseInt(document.getElementById('setting-email-imap-port')?.value) || 993,
      imapTls: document.getElementById('setting-email-imap-tls')?.checked ?? true,
      emailUser: document.getElementById('setting-email-user')?.value?.trim() || '',
      emailPass: document.getElementById('setting-email-pass')?.value?.trim() || '',
      ownerAddress: document.getElementById('setting-email-owner')?.value?.trim() || '',
      totpSecret: document.getElementById('setting-email-totp-secret')?.value?.trim() || s.email?.totpSecret || '',
      pollInterval: parseInt(document.getElementById('setting-email-poll-interval')?.value) || 30,
      resendIntervalMinutes: parseInt(document.getElementById('setting-email-resend-interval')?.value) || 30,
      maxResends: parseInt(document.getElementById('setting-email-max-resends')?.value) || 3,
      allowedSenders: existingAllowed,
    };
    await saveSettings(s);
  }

  // ---- Web Control Settings Helpers ----
  let wcEventsSetup = false;

  async function updateWcToggleButton() {
    const btn = document.getElementById('btn-wc-toggle');
    const resultEl = document.getElementById('wc-status-result');
    if (!btn) return;
    try {
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-danger');
        if (resultEl) { resultEl.textContent = `✅ 运行中: http://localhost:${status.port}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> 启动';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        if (resultEl) { resultEl.textContent = '未运行'; resultEl.style.color = 'var(--text-secondary)'; }
      }
    } catch {}
  }

  async function saveWebControlSettings() {
    const s = await window.api.getSettings();
    const passwordInput = document.getElementById('setting-wc-password')?.value?.trim();
    let passwordHash = s.webControl?.passwordHash || '';
    if (passwordInput) {
      const hashResult = await window.api.webControlHashPassword(passwordInput);
      if (hashResult.ok) passwordHash = hashResult.hash;
    }
    s.webControl = {
      enabled: document.getElementById('setting-wc-enabled')?.checked || false,
      autoStartOnOpen: document.getElementById('setting-wc-autostart')?.checked || false,
      port: parseInt(document.getElementById('setting-wc-port')?.value) || 3456,
      password: '',
      passwordHash,
      enable2FA: document.getElementById('setting-wc-enable-2fa')?.checked || false,
      totpSecret: s.webControl?.totpSecret || '',
    };
    await saveSettings(s);
    // Clear password field after save
    const pwEl = document.getElementById('setting-wc-password');
    if (pwEl) pwEl.value = '';
    // 热更新运行中服务的配置（修复改密码后 WebUI 登录仍用旧 hash 的问题）
    try { await window.api.webControlReconfigure(); } catch (_) {}
  }

  function setupWebControlEvents() {
    if (wcEventsSetup) return;
    wcEventsSetup = true;

    // 2FA toggle
    document.getElementById('setting-wc-enable-2fa')?.addEventListener('change', (e) => {
      document.getElementById('wc-2fa-area').style.display = e.target.checked ? '' : 'none';
    });

    // Generate TOTP
    document.getElementById('btn-wc-gen-totp')?.addEventListener('click', async () => {
      const result = await window.api.webControlGenerateTOTP();
      if (result.ok) {
        const qrArea = document.getElementById('wc-totp-qr-area');
        const qrImg = document.getElementById('wc-totp-qr-img');
        const secretText = document.getElementById('wc-totp-secret-text');
        if (qrArea) qrArea.style.display = '';
        if (qrImg) qrImg.src = result.qrDataUrl;
        if (secretText) secretText.textContent = `密钥: ${result.secret}`;
        // Save to settings
        const s = await window.api.getSettings();
        s.webControl = s.webControl || {};
        s.webControl.totpSecret = result.secret;
        await saveSettings(s);
      } else {
        alert('TOTP 生成失败: ' + (result.error || '未知错误'));
      }
    });

    // Verify TOTP
    document.getElementById('btn-wc-verify-totp')?.addEventListener('click', async () => {
      const code = document.getElementById('wc-totp-verify-code')?.value?.trim();
      if (!code) return;
      const result = await window.api.webControlVerifyTOTP(code);
      const span = document.getElementById('wc-totp-verify-result');
      if (result.ok && result.valid) {
        if (span) { span.textContent = '✅ 验证通过'; span.style.color = 'var(--success-color, #4caf50)'; }
      } else {
        if (span) { span.textContent = '❌ 验证失败'; span.style.color = 'var(--error-color, #f44336)'; }
      }
    });

    // Save
    document.getElementById('btn-wc-save')?.addEventListener('click', async () => {
      await saveWebControlSettings();
      const resultEl = document.getElementById('wc-status-result');
      if (resultEl) { resultEl.textContent = '✅ 设置已保存'; resultEl.style.color = 'var(--success-color, #4caf50)'; }
    });

    // Toggle start/stop
    document.getElementById('btn-wc-toggle')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('wc-status-result');
      const status = await window.api.webControlGetStatus();
      if (status.running) {
        const r = await window.api.webControlStop();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = '已停止'; resultEl.style.color = 'var(--text-secondary)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 停止失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      } else {
        // Save first, then start
        await saveWebControlSettings();
        const r = await window.api.webControlStart();
        if (r.ok) {
          if (resultEl) { resultEl.textContent = `✅ ${r.message}`; resultEl.style.color = 'var(--success-color, #4caf50)'; }
        } else {
          if (resultEl) { resultEl.textContent = '❌ 启动失败: ' + (r.error || ''); resultEl.style.color = 'var(--error-color, #f44336)'; }
        }
      }
      updateWcToggleButton();
    });
  }

  // ── Playwright Settings ──
  async function loadPlaywrightSettings() {
    const s = await window.api.getSettings();
    const pw = s.playwright || {};
    const modeSelect = document.getElementById('setting-pw-mode');
    const pathInput = document.getElementById('setting-pw-path');
    const followLangCheckbox = document.getElementById('setting-pw-follow-lang');
    const headlessCheckbox = document.getElementById('setting-pw-headless');
    const bannerCheckbox = document.getElementById('setting-pw-banner-enabled');
    const argsTextarea = document.getElementById('setting-pw-args');
    const customRow = document.getElementById('pw-custom-path-row');
    const testBtn = document.getElementById('btn-pw-test');
    const saveBtn = document.getElementById('btn-pw-save');
    const searchBtn = document.getElementById('btn-pw-search');
    const browseBtn = document.getElementById('btn-pw-browse');
    const detectedEl = document.getElementById('pw-detected-browsers');
    const testResultEl = document.getElementById('pw-test-result');

    if (modeSelect) modeSelect.value = pw.mode || 'auto';
    if (pathInput) pathInput.value = pw.path || '';
    if (followLangCheckbox) followLangCheckbox.checked = pw.followLang !== false;
    // UI 语义：checked = 有头模式；setting 语义：headless=true 表示无头
    if (headlessCheckbox) headlessCheckbox.checked = pw.headless !== true;
    // 横幅开关：默认开启，仅 headed 模式下显示
    if (bannerCheckbox) bannerCheckbox.checked = pw.bannerEnabled !== false;
    if (argsTextarea) argsTextarea.value = pw.args || '';

    // Show/hide custom path row
    function updateCustomRowVisibility() {
      if (!modeSelect || !customRow) return;
      if (modeSelect.value === 'custom') {
        customRow.style.display = '';
      } else {
        customRow.style.display = 'none';
      }
    }
    if (modeSelect) {
      modeSelect.addEventListener('change', updateCustomRowVisibility);
      updateCustomRowVisibility();
    }

    // Browse for browser binary
    if (browseBtn) {
      browseBtn.addEventListener('click', async () => {
        const result = await window.api.pwBrowserDialog();
        if (result.ok && pathInput) {
          pathInput.value = result.path;
        }
      });
    }

    // Search for browsers
    if (searchBtn) {
      searchBtn.addEventListener('click', async () => {
        if (detectedEl) {
          detectedEl.innerHTML = '<span style="color:var(--text-tertiary)">搜索中...</span>';
        }
        const result = await window.api.pwSearchBrowsers();
        if (result.ok && result.browsers && result.browsers.length > 0) {
          detectedEl.innerHTML = result.browsers.map(b =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span>${b.name}</span><code style="font-size:11px;color:var(--accent)">${b.path}</code></div>`
          ).join('');
        } else {
          detectedEl.innerHTML = '<span style="color:var(--danger)">未检测到已安装的浏览器</span>';
        }
      });
    }

    // Test launch
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        if (testResultEl) {
          testResultEl.textContent = '测试中...';
          testResultEl.style.color = 'var(--text-secondary)';
        }
        const testSettings = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : ''
        };
        // 先持久化设置：测试启动即应用，避免用户忘记点"保存"导致 Agent 调用仍用旧浏览器
        try {
          const s2 = await window.api.getSettings();
          s2.playwright = testSettings;
          await saveSettings(s2);
          await window.api.pwCloseBrowser();
        } catch (e) {
          console.warn('Test launch: persist settings failed:', e);
        }
        const result = await window.api.pwTestLaunch(testSettings);
        if (testResultEl) {
          if (result.ok) {
            testResultEl.textContent = '✅ ' + (result.message || '测试成功');
            testResultEl.style.color = 'var(--success, #4caf50)';
          } else {
            testResultEl.textContent = '❌ ' + (result.error || '测试失败');
            testResultEl.style.color = 'var(--danger, #f44336)';
          }
        }
      });
    }

    // Save
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const s2 = await window.api.getSettings();
        s2.playwright = {
          mode: modeSelect ? modeSelect.value : 'auto',
          path: pathInput ? pathInput.value : '',
          followLang: followLangCheckbox ? followLangCheckbox.checked : true,
          headless: headlessCheckbox ? !headlessCheckbox.checked : false,
          bannerEnabled: bannerCheckbox ? bannerCheckbox.checked : true,
          args: argsTextarea ? argsTextarea.value : ''
        };
        await saveSettings(s2);
        // Close existing browser so next launch uses new settings
        await window.api.pwCloseBrowser();
        if (testResultEl) {
          testResultEl.textContent = '✅ ' + (typeof i18nGetLanguage === 'function' && i18nGetLanguage() !== 'zh-CN' ? 'Settings saved' : '设置已保存');
          testResultEl.style.color = 'var(--success, #4caf50)';
        }
      });
    }
  }
  loadPlaywrightSettings();

  // ── Budget Control Settings ──
  // 数据结构：settings.budget = {
  //   monthlyCapUsd, dailyLimitUSD, overAction, fallbackModel, warningThreshold,
  //   models: { [modelId]: { inputPerM, cacheReadPerM, outputPerM, cacheWritePerM, hasCacheWrite } },
  //   peakHours: { enabled, start, end, inputMul, cacheReadMul, outputMul, cacheWriteMul }
  // }
  async function loadBudgetSettings() {
    const s = await window.api.getSettings();
    const budget = s.budget || {};
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    if (dailyCapInput) dailyCapInput.value = budget.dailyLimitUSD ?? 0;
    if (weeklyCapInput) weeklyCapInput.value = budget.weeklyLimitUSD ?? 0;
    if (capInput) capInput.value = budget.monthlyLimitUSD ?? 0;
    if (actionSel) actionSel.value = budget.overLimitAction || budget.overAction || 'warn';
    if (fallbackInput) fallbackInput.value = budget.fallbackModel || '';
    if (tzSel) tzSel.value = budget.timezone || 'Asia/Shanghai';
    if (weekModeSel) weekModeSel.value = budget.weekMode || 'natural';
    if (monthModeSel) monthModeSel.value = budget.monthMode || 'natural';

    // 峰谷时段字段
    const ph = budget.peakHours || {};
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    if (phEnabled) phEnabled.checked = !!ph.enabled;
    if (phStart) phStart.value = ph.start ?? 9;
    if (phEnd) phEnd.value = ph.end ?? 18;
    if (phInMul) phInMul.value = ph.inputMul ?? 1.5;
    if (phCrMul) phCrMul.value = ph.cacheReadMul ?? 1.5;
    if (phOutMul) phOutMul.value = ph.outputMul ?? 1.5;
    if (phCwMul) phCwMul.value = ph.cacheWriteMul ?? 1.5;

    const listEl = document.getElementById('budget-pricing-list');
    if (listEl) {
      listEl.innerHTML = '';
      const models = budget.models || {};
      for (const [modelId, price] of Object.entries(models)) {
        appendBudgetPricingRow(listEl, modelId, price);
      }
      // 默认至少显示一行空行
      if (listEl.children.length === 0) {
        appendBudgetPricingRow(listEl, '', {});
      }
    }

    // 按钮绑定
    const addRowBtn = document.getElementById('btn-budget-add-row');
    if (addRowBtn) {
      addRowBtn.onclick = () => {
        if (!listEl) return;
        appendBudgetPricingRow(listEl, '', {});
      };
    }
    const importCurrentBtn = document.getElementById('btn-budget-import-current');
    if (importCurrentBtn) {
      importCurrentBtn.onclick = async () => {
        const cur = await window.api.getSettings();
        const model = cur?.llm?.model;
        if (!model) { window.showToast('未检测到当前 LLM 模型', 'warn'); return; }
        if (!listEl) return;
        // 去重添加
        const existing = Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim());
        if (existing.includes(model)) { window.showToast('价格表中已存在该模型', 'info'); return; }
        // 默认根据模型名自动推断 hasCacheWrite
        appendBudgetPricingRow(listEl, model, { hasCacheWrite: /claude/i.test(model) });
      };
    }
    const importUsageBtn = document.getElementById('btn-budget-import-usage');
    if (importUsageBtn) {
      importUsageBtn.onclick = async () => {
        const res = await window.api.usageGetRange('monthly');
        if (!listEl) return;
        const usedModels = Object.keys(res?.models || {});
        if (usedModels.length === 0) { window.showToast('用量记录中没有模型数据', 'info'); return; }
        const existing = new Set(Array.from(listEl.querySelectorAll('.budget-model-id')).map(i => i.value.trim()));
        let added = 0;
        for (const m of usedModels) {
          if (!existing.has(m)) { appendBudgetPricingRow(listEl, m, { hasCacheWrite: /claude/i.test(m) }); added++; }
        }
        window.showToast(added > 0 ? `已导入 ${added} 个模型` : '所有已用模型都已在价格表中', 'success');
      };
    }
    const budgetRefreshBtn = document.getElementById('btn-budget-refresh');
    if (budgetRefreshBtn) budgetRefreshBtn.onclick = async () => {
      await refreshBudgetStatus();
      window.showToast('预算数据已刷新', 'success');
    };
    const pickFallbackBtn = document.getElementById('btn-budget-pick-fallback');
    if (pickFallbackBtn) {
      pickFallbackBtn.onclick = async () => {
        // 复用 LLM 设置的模型选择逻辑：列出可用模型
        try {
          const cur = await window.api.getSettings();
          // llmFetchModels 返回 {ok, models} 对象，需要从中提取 models 数组
          const provider = cur?.llm?.provider || 'openai-compat';
          const apiUrl = cur?.llm?.apiUrl || '';
          const apiKey = cur?.llm?.apiKey || '';
          const zenKey = cur?.llm?.zenApiKey || '';
          let res;
          if (provider === 'opencode-zen') {
            res = await window.api.zenFetchModels();
          } else {
            res = await window.api.llmFetchModels(provider, apiUrl, apiKey || zenKey);
          }
          const list = Array.isArray(res?.models) ? res.models : [];
          if (list.length === 0) {
            window.showToast('无可选模型，请先在 LLM 标签页获取模型列表', 'warn');
            return;
          }
          // 弹出简单选择框
          const picked = prompt('选择 fallback 模型（输入序号）:\n' + list.map((m, i) => `${i + 1}. ${m.id || m.name || m}`).join('\n'));
          const idx = parseInt(picked) - 1;
          if (!isNaN(idx) && list[idx]) {
            const modelId = typeof list[idx] === 'string' ? list[idx] : (list[idx].id || list[idx].name);
            if (fallbackInput) fallbackInput.value = modelId;
          }
        } catch (e) { window.showToast('获取模型列表失败: ' + e.message, 'error'); }
      };
    }

    // 自动保存：绑定输入事件
    [dailyCapInput, capInput, actionSel, fallbackInput, phEnabled, phStart, phEnd, phInMul, phCrMul, phOutMul, phCwMul].forEach(el => {
      if (!el) return;
      el.addEventListener('change', saveBudgetSettings);
    });
    listEl?.addEventListener('input', () => { /* 输入时仅更新内部状态，保存由 change 触发 */ });
    // 注意：listEl 不再绑定 change 事件，因为 appendBudgetPricingRow 中
    // 已经为每个 input 单独绑定了 change → saveBudgetSettings，
    // 若 listEl 也绑定会导致 change 事件冒泡时重复触发保存（弹两次 toast）

    await refreshBudgetStatus(budget);
  }

  function appendBudgetPricingRow(listEl, modelId, price) {
    price = price || {};
    // 旧字段迁移：promptPerK/completionPerK → inputPerM/outputPerM
    let inputPerM = price.inputPerM;
    if (inputPerM == null && price.promptPerK != null) inputPerM = (Number(price.promptPerK) || 0) * 1000;
    let outputPerM = price.outputPerM;
    if (outputPerM == null && price.completionPerK != null) outputPerM = (Number(price.completionPerK) || 0) * 1000;
    let cacheReadPerM = price.cacheReadPerM;
    if (cacheReadPerM == null && inputPerM != null) cacheReadPerM = (Number(inputPerM) || 0) * 0.1;
    let cacheWritePerM = price.cacheWritePerM;
    if (cacheWritePerM == null && inputPerM != null) cacheWritePerM = (Number(inputPerM) || 0) * 1.25;
    const hasCacheWrite = price.hasCacheWrite != null ? !!price.hasCacheWrite : /claude/i.test(modelId || '');
    const esc = (v) => String(v ?? '').replace(/[<>&"]/g, s => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[s]));
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1.6fr 0.9fr 0.9fr 0.9fr 0.9fr 0.7fr auto;gap:6px;align-items:center';
    row.innerHTML = `
      <input type="text" class="budget-model-id" value="${esc(modelId)}" placeholder="model-id">
      <input type="number" class="budget-input-perm" value="${inputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输入价格 (USD)">
      <input type="number" class="budget-cacheread-perm" value="${cacheReadPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存读取价格 (USD)">
      <input type="number" class="budget-output-perm" value="${outputPerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 输出价格 (USD)">
      <input type="number" class="budget-cachewrite-perm" value="${cacheWritePerM ?? ''}" placeholder="0.00" step="0.0001" min="0" title="每 1M token 缓存写入价格 (USD)">
      <input type="checkbox" class="budget-has-cache-write" ${hasCacheWrite ? 'checked' : ''} title="该模型支持缓存写入计费" style="justify-self:center">
      <button class="btn-icon" title="删除"><i class="fa-solid fa-trash-can"></i></button>
    `;
    // 当模型 ID 改变且未手动勾选过 CW 时，根据模型名自动推断
    const idEl = row.querySelector('.budget-model-id');
    const cwEl = row.querySelector('.budget-has-cache-write');
    idEl?.addEventListener('change', () => {
      if (/claude/i.test(idEl.value || '')) {
        cwEl.checked = true;
        saveBudgetSettings();
      }
    });
    row.querySelector('button').onclick = () => {
      row.remove();
      saveBudgetSettings();
    };
    row.querySelectorAll('input').forEach(i => i.addEventListener('change', saveBudgetSettings));
    listEl.appendChild(row);
  }

  async function saveBudgetSettings() {
    const dailyCapInput = document.getElementById('setting-budget-daily-cap');
    const weeklyCapInput = document.getElementById('setting-budget-weekly-cap');
    const capInput = document.getElementById('setting-budget-monthly-cap');
    const actionSel = document.getElementById('setting-budget-action');
    const fallbackInput = document.getElementById('setting-budget-fallback-model');
    const tzSel = document.getElementById('setting-budget-timezone');
    const weekModeSel = document.getElementById('setting-budget-week-mode');
    const monthModeSel = document.getElementById('setting-budget-month-mode');
    const listEl = document.getElementById('budget-pricing-list');
    const phEnabled = document.getElementById('setting-budget-peak-enabled');
    const phStart = document.getElementById('setting-budget-peak-start');
    const phEnd = document.getElementById('setting-budget-peak-end');
    const phInMul = document.getElementById('setting-budget-peak-input-mul');
    const phCrMul = document.getElementById('setting-budget-peak-cacheread-mul');
    const phOutMul = document.getElementById('setting-budget-peak-output-mul');
    const phCwMul = document.getElementById('setting-budget-peak-cachewrite-mul');
    const models = {};
    if (listEl) {
      listEl.querySelectorAll(':scope > div').forEach(row => {
        const idEl = row.querySelector('.budget-model-id');
        if (!idEl) return;
        const mid = (idEl.value || '').trim();
        if (!mid) return;
        const pEl = row.querySelector('.budget-input-perm');
        const crEl = row.querySelector('.budget-cacheread-perm');
        const cEl = row.querySelector('.budget-output-perm');
        const cwEl = row.querySelector('.budget-cachewrite-perm');
        const hcwEl = row.querySelector('.budget-has-cache-write');
        models[mid] = {
          inputPerM: parseFloat(pEl?.value) || 0,
          cacheReadPerM: parseFloat(crEl?.value) || 0,
          outputPerM: parseFloat(cEl?.value) || 0,
          cacheWritePerM: parseFloat(cwEl?.value) || 0,
          hasCacheWrite: !!hcwEl?.checked
        };
      });
    }
    const budget = {
      dailyLimitUSD: parseFloat(dailyCapInput?.value) || 0,
      weeklyLimitUSD: parseFloat(weeklyCapInput?.value) || 0,
      monthlyLimitUSD: parseFloat(capInput?.value) || 0,
      monthlyCapUsd: parseFloat(capInput?.value) || 0, // 保留旧字段以兼容旧代码
      overLimitAction: actionSel?.value || 'warn',
      overAction: actionSel?.value || 'warn', // 保留旧字段以兼容旧代码
      fallbackModel: (fallbackInput?.value || '').trim(),
      warningThreshold: 0.8,
      timezone: tzSel?.value || 'Asia/Shanghai',
      weekMode: weekModeSel?.value || 'natural',
      monthMode: monthModeSel?.value || 'natural',
      models,
      peakHours: {
        enabled: !!phEnabled?.checked,
        start: parseInt(phStart?.value) ?? 9,
        end: parseInt(phEnd?.value) ?? 18,
        inputMul: parseFloat(phInMul?.value) || 1,
        cacheReadMul: parseFloat(phCrMul?.value) || 1,
        outputMul: parseFloat(phOutMul?.value) || 1,
        cacheWriteMul: parseFloat(phCwMul?.value) || 1
      }
    };
    await saveSettings({ budget });
    await refreshBudgetStatus(budget);
    if (typeof window.showToast === 'function') window.showToast('预算设置已保存', 'success', 2500);
  }

  async function refreshBudgetStatus(budget) {
    const statusEl = document.getElementById('budget-status');
    if (!statusEl) return;
    try {
      // 使用新的 budget:getStatus API（后端已根据价格表+峰谷价计算好）
      const st = await window.api.budgetGetStatus();
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const renderSection = (title, info) => {
        const limit = info.limitUSD > 0;
        const pct = info.pct;
        const barColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        return `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-weight:600">
              <span>${title}</span><span style="color:${barColor}">${fmt(info.costUSD)}${limit ? ` / ${fmtLimit(info.limitUSD)} (${pct.toFixed(1)}%)` : '（未设限）'}</span>
            </div>
            ${limit ? `<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.3s"></div></div>` : ''}
            <div style="font-size:11px;color:var(--text-secondary);display:grid;grid-template-columns:1fr 1fr;gap:2px 12px">
              <span>输入 ${fmt(info.inputCost)}</span>
              <span>输出 ${fmt(info.outputCost)}</span>
              <span>缓存读 ${fmt(info.cacheReadCost)}</span>
              <span>缓存写 ${fmt(info.cacheWriteCost)}</span>
            </div>
          </div>
        `;
      };
      const peak = st?.peakHours || {};
      const peakBadge = peak.enabled ? `<span style="font-size:10px;color:var(--text-tertiary);margin-left:6px">峰时段 ${peak.start}-${peak.end}</span>` : '';
      statusEl.innerHTML = `
        ${renderSection('今日消费' + peakBadge, st?.daily || {})}
        ${st?.weekly ? renderSection('本周消费', st.weekly) : ''}
        ${renderSection('本月消费', st?.monthly || {})}
      `;
      // 同步刷新图表区域（若存在）
      const activePeriod = document.querySelector('.budget-period-btn.active');
      if (activePeriod) loadBudgetChart(activePeriod.dataset.period);
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">加载失败: ${e.message}</span>`;
    }
  }

  // 预算统计图表：渲染卡片 + 柱状图 + 圆环占比
  async function loadBudgetChart(period) {
    const summaryEl = document.getElementById('budget-chart-summary');
    const chartEl = document.getElementById('budget-chart');
    const ringsEl = document.getElementById('budget-rings');
    if (!summaryEl || !chartEl || !ringsEl) return;
    try {
      const [status, usage] = await Promise.all([
        window.api.budgetGetStatus(),
        window.api.usageGetRange(period || 'daily')
      ]);
      if (!status?.ok) {
        summaryEl.innerHTML = '<div style="opacity:0.6">加载失败</div>';
        return;
      }
      const periodInfo = status[period || 'daily'] || {};
      const periodLabels = { daily: '今日', weekly: '本周', monthly: '本月' };
      const fmt = (v) => `$${(Number(v) || 0).toFixed(4)}`;
      const fmtLimit = (v) => `$${(Number(v) || 0).toFixed(2)}`;
      const hasLimit = periodInfo.limitUSD > 0;
      const pct = periodInfo.pct || 0;
      const barColor = periodInfo.level === 'danger' ? '#f44336' : (periodInfo.level === 'warn' ? '#ff9800' : 'var(--accent)');

      // 卡片
      const cards = [
        { label: `${periodLabels[period]}消费`, value: fmt(periodInfo.costUSD), accent: true },
        { label: '输入消费', value: fmt(periodInfo.inputCost) },
        { label: '输出消费', value: fmt(periodInfo.outputCost) }
      ];
      if ((periodInfo.cacheReadCost || 0) > 0) cards.push({ label: '缓存读消费', value: fmt(periodInfo.cacheReadCost) });
      if ((periodInfo.cacheWriteCost || 0) > 0) cards.push({ label: '缓存写消费', value: fmt(periodInfo.cacheWriteCost) });
      summaryEl.innerHTML = cards.map(c =>
        `<div class="usage-card${c.accent ? ' accent' : ''} cost">
          <div class="usage-card-label">${c.label}</div>
          <div class="usage-card-value">${c.value}</div>
        </div>`
      ).join('');

      // 柱状图（按小时或按日）
      const isHourly = usage.isHourly;
      const chartData = isHourly ? (usage.hours || []) : (usage.days || []);
      const max = Math.max(0.0001, ...chartData.map(d => d.costUSD || 0));
      if (chartData.length === 0) {
        chartEl.innerHTML = '<div style="opacity:0.5;font-size:12px;width:100%;text-align:center;">无数据</div>';
      } else {
        chartEl.innerHTML = chartData.map(d => {
          const h = Math.max(2, Math.round(((d.costUSD || 0) / max) * 100));
          const label = isHourly ? `${d.hour}h` : (d.date || '').slice(5);
          const title = isHourly ? `${d.hour}:00 - ${fmt(d.costUSD)}` : `${d.date}: ${fmt(d.costUSD)}`;
          return `<div title="${title}" style="flex:1;min-width:4px;height:${h}px;background:var(--accent);border-radius:2px 2px 0 0;position:relative;">
            <div style="position:absolute;bottom:-16px;left:50%;transform:translateX(-50%);font-size:9px;opacity:0.5;white-space:nowrap;">${label}</div>
          </div>`;
        }).join('');
      }

      // 圆环占比（日/周/月三个）
      const periods = ['daily', 'weekly', 'monthly'];
      const labels = { daily: '日', weekly: '周', monthly: '月' };
      ringsEl.innerHTML = periods.map(p => {
        const info = status[p] || {};
        const pPct = info.pct || 0;
        const pColor = info.level === 'danger' ? '#f44336' : (info.level === 'warn' ? '#ff9800' : 'var(--accent)');
        const r = 15.915;
        const dashArray = `${(pPct/100 * 100).toFixed(1)} ${(100 - pPct/100 * 100).toFixed(1)}`;
        return `<div style="text-align:center">
          <svg viewBox="0 0 36 36" width="64" height="64">
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--border)" stroke-width="3"/>
            <circle cx="18" cy="18" r="${r}" fill="none" stroke="${pColor}" stroke-width="3"
              stroke-dasharray="${dashArray}" stroke-dashoffset="0" transform="rotate(-90 18 18)" stroke-linecap="round"/>
            <text x="18" y="20" text-anchor="middle" font-size="9" fill="var(--text-primary)" font-weight="600">${pPct.toFixed(0)}%</text>
          </svg>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${labels[p]}预算</div>
          <div style="font-size:10px;color:var(--text-tertiary)">${fmt(info.costUSD)}${info.limitUSD > 0 ? ' / ' + fmtLimit(info.limitUSD) : ''}</div>
        </div>`;
      }).join('');
    } catch (e) {
      console.error('loadBudgetChart failed:', e);
    }
  }

  // 预算周期按钮切换
  document.querySelectorAll('.budget-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.budget-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadBudgetChart(btn.dataset.period);
    });
  });
  // 周期设置变化时刷新图表
  document.getElementById('setting-budget-timezone')?.addEventListener('change', () => loadBudgetChart('daily'));
  document.getElementById('setting-budget-week-mode')?.addEventListener('change', () => loadBudgetChart('weekly'));
  document.getElementById('setting-budget-month-mode')?.addEventListener('change', () => loadBudgetChart('monthly'));
  loadBudgetSettings();

  // ── Terminal Settings ──
  // settings.terminal = { abortStrategy: 'kill'|'clearC'|'none', shell: 'auto'|..., customShellPath }
  async function loadTerminalSettings() {
    const s = await window.api.getSettings();
    const t = s.terminal || {};
    const abortSel = document.getElementById('setting-terminal-abortstrategy');
    const shellSel = document.getElementById('setting-terminal-shell');
    const customRow = document.getElementById('terminal-custom-shell-row');
    const customInput = document.getElementById('setting-terminal-custom-path');
    const sessionsMax = document.getElementById('setting-sessions-max');
    if (abortSel) abortSel.value = t.abortStrategy || 'kill';
    if (shellSel) shellSel.value = t.shell || 'auto';
    if (customInput) customInput.value = t.customShellPath || '';
    if (customRow) customRow.style.display = (shellSel && shellSel.value === 'custom') ? '' : 'none';
    if (sessionsMax) sessionsMax.value = String(Math.max(1, Number(s.sessions?.maxConcurrent) || 10));
  }
  document.getElementById('setting-terminal-abortstrategy')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.abortStrategy = e.target.value;
    await saveSettings(s);
    window.showToast?.('终端策略已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-shell')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.shell = e.target.value;
    await saveSettings(s);
    // 自定义路径输入框的显隐
    const customRow = document.getElementById('terminal-custom-shell-row');
    if (customRow) customRow.style.display = e.target.value === 'custom' ? '' : 'none';
    window.showToast?.('Shell 设置已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-custom-path')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.customShellPath = (e.target.value || '').trim();
    await saveSettings(s);
  });
  document.getElementById('setting-sessions-max')?.addEventListener('change', async (e) => {
    const value = Math.max(1, Math.min(50, Number(e.target.value) || 10));
    const s = await window.api.getSettings();
    if (!s.sessions) s.sessions = {};
    s.sessions.maxConcurrent = value;
    await saveSettings(s);
    if (sessionManager) sessionManager.maxConcurrent = value;
    e.target.value = String(value);
    window.showToast?.('最大并发会话数已保存', 'success', 2000);
  });
  loadTerminalSettings();

  // ---- 上下文压缩设置（水位线策略）----
  async function loadContextCompactionSettings() {
    const s = await window.api.getSettings();
    const c = s.contextCompaction || {};
    const autoEl = document.getElementById('setting-context-auto');
    const thEl = document.getElementById('setting-context-threshold');
    const thVal = document.getElementById('setting-context-threshold-val');
    const rtEl = document.getElementById('setting-context-retain');
    const rtVal = document.getElementById('setting-context-retain-val');
    const retriesEl = document.getElementById('setting-context-retries');
    const maxTEl = document.getElementById('setting-context-max-tokens');
    if (autoEl) autoEl.checked = c.enabled !== false;
    if (thEl) {
      thEl.value = String(Math.round((Number(c.thresholdRatio) || 0.80) * 100));
      if (thVal) thVal.textContent = `${thEl.value}%`;
    }
    if (rtEl) {
      rtEl.value = String(Math.round((Number(c.retainRatio) || 0.16) * 100));
      if (rtVal) rtVal.textContent = `${rtEl.value}%`;
    }
    if (retriesEl) retriesEl.value = String(c.compactionRetries ?? 1);
    if (maxTEl) maxTEl.value = String(c.summarizeMaxTokens ?? 2048);
  }
  async function updateContextCompactionSettings(patch, toast) {
    const s = await window.api.getSettings();
    if (!s.contextCompaction || typeof s.contextCompaction !== 'object') s.contextCompaction = {};
    Object.assign(s.contextCompaction, patch);
    await saveSettings(s);
    if (toast) window.showToast?.(toast, 'success', 2000);
  }
  // 滑动条指示器实时跟随拖动（input 事件），保存仍走 change（释放时落盘）
  function bindRangeIndicator(rangeId, valId, min, max) {
    const range = document.getElementById(rangeId);
    const val = document.getElementById(valId);
    if (!range || !val) return;
    range.addEventListener('input', () => {
      const v = Math.max(min, Math.min(max, Number(range.value) || min));
      val.textContent = `${v}%`;
    });
  }
  bindRangeIndicator('setting-context-threshold', 'setting-context-threshold-val', 60, 95);
  bindRangeIndicator('setting-context-retain', 'setting-context-retain-val', 5, 40);
  document.getElementById('setting-context-auto')?.addEventListener('change', async (e) => {
    await updateContextCompactionSettings({ enabled: !!e.target.checked }, '上下文自动压缩已' + (e.target.checked ? '开启' : '关闭'));
  });
  document.getElementById('setting-context-threshold')?.addEventListener('change', async (e) => {
    const pct = Math.max(60, Math.min(95, Number(e.target.value) || 80));
    e.target.value = String(pct);
    const valEl = document.getElementById('setting-context-threshold-val');
    if (valEl) valEl.textContent = `${pct}%`;
    await updateContextCompactionSettings({ thresholdRatio: pct / 100 });
  });
  document.getElementById('setting-context-retain')?.addEventListener('change', async (e) => {
    const pct = Math.max(5, Math.min(40, Number(e.target.value) || 16));
    e.target.value = String(pct);
    const valEl = document.getElementById('setting-context-retain-val');
    if (valEl) valEl.textContent = `${pct}%`;
    await updateContextCompactionSettings({ retainRatio: pct / 100 });
  });
  document.getElementById('setting-context-retries')?.addEventListener('change', async (e) => {
    const v = Math.max(0, Math.min(5, Number(e.target.value) || 1));
    e.target.value = String(v);
    await updateContextCompactionSettings({ compactionRetries: v });
  });
  document.getElementById('setting-context-max-tokens')?.addEventListener('change', async (e) => {
    const v = Math.max(512, Math.min(8192, Number(e.target.value) || 2048));
    e.target.value = String(v);
    await updateContextCompactionSettings({ summarizeMaxTokens: v });
  });
  document.getElementById('btn-context-compact-now')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('context-compact-status');
    const targetAgent = (typeof currentMode !== 'undefined' && currentMode === 'code') ? codeAgent
      : ((typeof currentMode !== 'undefined' && currentMode === 'babe') ? babeAgent : agent);
    const cm = targetAgent?.contextManager;
    if (!cm) {
      if (statusEl) statusEl.textContent = '当前无可压缩的会话上下文';
      return;
    }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = '正在压缩…';
    try {
      const res = await cm.summarizeWithLLM({
        sessionKey: targetAgent.sessionKey || null,
        tools: targetAgent.getRuntimeToolSchemas?.() || null
      });
      if (statusEl) {
        const stats = cm.getStats();
        statusEl.textContent = res.skipped
          ? `跳过：${res.message}（当前占用 ${stats.usageWithReserve ?? stats.usage}%）`
          : `${res.message}（当前占用 ${stats.usageWithReserve ?? stats.usage}%）`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = '压缩失败：' + (err.message || err);
    } finally {
      btn.disabled = false;
    }
  });
  loadContextCompactionSettings();

  // ---- 沙箱设置 + 后端自检 ----
  async function loadSandboxSettings() {
    const s = await window.api.getSettings();
    const sb = s.sandbox || {};
    const setSel = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    setSel('setting-sandbox-default', sb.defaultMode || 'danger-full-access');
    setSel('setting-sandbox-chat', sb.modeOverrides?.chat || '');
    setSel('setting-sandbox-code', sb.modeOverrides?.code || '');
    setSel('setting-sandbox-babe', sb.modeOverrides?.babe || '');
    const approvalEl = document.getElementById('setting-sandbox-approval');
    if (approvalEl) approvalEl.checked = sb.requireApproval !== false;
    refreshSandboxStatus();
  }
  async function refreshSandboxStatus() {
    const el = document.getElementById('sandbox-backend-status');
    if (!el || typeof window.api.sandboxGetStatus !== 'function') return;
    try {
      const st = await window.api.sandboxGetStatus();
      if (st.backendAvailable) {
        el.textContent = `✅ ${st.detail}（enforcement: ${st.enforcement}）`;
        el.style.color = 'var(--text-secondary)';
      } else {
        el.textContent = `⚠️ ${st.detail}：受限模式将拒绝执行（fail-closed）`;
        el.style.color = 'var(--warning, #b7791f)';
      }
    } catch (e) {
      el.textContent = '状态获取失败：' + (e.message || e);
    }
  }
  async function updateSandboxSettings(patch, toast) {
    const s = await window.api.getSettings();
    if (!s.sandbox || typeof s.sandbox !== 'object') s.sandbox = {};
    if (patch.modeOverrides !== undefined) {
      if (!s.sandbox.modeOverrides || typeof s.sandbox.modeOverrides !== 'object') s.sandbox.modeOverrides = {};
      Object.assign(s.sandbox.modeOverrides, patch.modeOverrides);
      delete patch.modeOverrides;
    }
    Object.assign(s.sandbox, patch);
    await saveSettings(s);
    // 同步到各 agent 实例
    for (const a of [agent, codeAgent, babeAgent]) {
      if (a && a.settings) a.settings.sandbox = s.sandbox;
    }
    if (toast) window.showToast?.(toast, 'success', 2000);
  }
  document.getElementById('setting-sandbox-default')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ defaultMode: e.target.value }, '沙箱默认模式已保存');
  });
  document.getElementById('setting-sandbox-chat')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { chat: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-code')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { code: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-babe')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ modeOverrides: { babe: e.target.value || null } });
  });
  document.getElementById('setting-sandbox-approval')?.addEventListener('change', async (e) => {
    await updateSandboxSettings({ requireApproval: !!e.target.checked });
  });
  document.getElementById('btn-sandbox-probe')?.addEventListener('click', async () => {
    const el = document.getElementById('sandbox-backend-status');
    if (el) el.textContent = '自检中…';
    try {
      const r = await window.api.sandboxProbe();
      if (r.ok) {
        if (el) el.textContent = r.readOnlyWriteDenied
          ? `✅ 只读模式自检通过：受限写入被拒绝（${r.backend}，enforcement: ${r.enforcement}）`
          : `⚠️ 自检异常：只读模式下写入未被拒绝（${r.backend}）`;
      } else {
        if (el) el.textContent = `⚠️ 自检失败：${r.error || r.detail || '未知错误'}`;
      }
    } catch (e) {
      if (el) el.textContent = '自检失败：' + (e.message || e);
    }
  });
  loadSandboxSettings();

  // ---- 自动化触发设置（HTTP 信号服务器，fail-closed + Token 列表权限） ----
  let autoCfg = { enabled: false, allowNoToken: false, serverPort: 8765, tokens: [] };
  let autoTasks = [];
  async function loadAutomationSettings() {
    const s = await window.api.getSettings();
    autoCfg = s.automation || autoCfg;
    const enabledEl = document.getElementById('setting-automation-enabled');
    const noTokenEl = document.getElementById('setting-automation-allow-notoken');
    const portEl = document.getElementById('setting-automation-port');
    if (enabledEl) enabledEl.checked = autoCfg.enabled === true;
    if (noTokenEl) noTokenEl.checked = autoCfg.allowNoToken === true;
    if (portEl) portEl.value = autoCfg.serverPort || 8765;
    renderAutomationTokens();
    refreshAutomationServerStatus();
  }
  async function refreshAutomationTasks() {
    try {
      const res = await window.api.automationList();
      autoTasks = (res && res.ok && res.tasks) || [];
    } catch { autoTasks = []; }
    renderAutomationTokens();
  }
  async function saveAutomationCfg(cfgPatch, toast) {
    const r = await window.api.automationUpdateSettings(cfgPatch);
    if (!r || !r.ok) {
      window.showToast?.(r?.error || '保存失败', 'error', 2500);
      return null;
    }
    autoCfg = r.settings;
    renderAutomationTokens();
    if (toast) window.showToast?.(toast, 'success', 2000);
    refreshAutomationServerStatus();
    return r;
  }
  function fmtExpiry(ms) {
    if (!ms || ms <= 0) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function renderAutomationTokens() {
    const listEl = document.getElementById('automation-tokens-list');
    if (!listEl) return;
    const tokens = autoCfg.tokens || [];
    listEl.innerHTML = '';
    if (tokens.length === 0) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--text-tertiary)">暂无 Token（可点击下方「添加 Token」，或开启「允许无 Token 启动」）</div>';
    }
    tokens.forEach(t => {
      const row = document.createElement('div');
      row.className = 'automation-token-row';
      row.style.cssText = 'border:1px solid var(--border-color, rgba(128,128,128,.25));border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px';
      row.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" data-field="name" value="${escapeHtml(t.name || '')}" placeholder="名称" style="width:120px">
          <input type="text" data-field="value" readonly value="${escapeHtml(t.value || '')}" style="flex:1;font-family:monospace;font-size:12px">
          <button class="btn-secondary btn-sm" data-act="copy" title="复制"><i class="fa-solid fa-copy"></i></button>
          <button class="btn-secondary btn-sm" data-act="roll" title="生成新值"><i class="fa-solid fa-rotate"></i></button>
          <button class="btn-secondary btn-sm" data-act="del" title="删除" style="color:#c0392b"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px">
          <label class="checkbox-label" style="flex-shrink:0">
            <input type="checkbox" data-field="allowParams" ${t.allowParams === false ? '' : 'checked'}> 允许传参
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;color:var(--text-secondary);white-space:nowrap;flex-shrink:0">
            有效期
            <input type="datetime-local" data-field="expiresAt" value="${escapeHtml(fmtExpiry(t.expiresAt))}" style="width:auto">
            <button class="btn-secondary btn-sm" data-act="clear-expiry" title="清除有效期" style="display:${t.expiresAt ? '' : 'none'}">清除</button>
          </label>
          <label style="display:inline-flex;align-items:center;gap:4px;color:var(--text-secondary);white-space:nowrap;flex-shrink:0">
            任务范围
            <select data-field="scope">
              <option value="all" ${t.scope === 'all' ? 'selected' : ''}>全部任务</option>
              <option value="selected" ${Array.isArray(t.scope) ? 'selected' : ''}>指定任务…</option>
            </select>
          </label>
          ${expiredHint(t)}
        </div>
        <div data-role="scope-detail" style="display:${Array.isArray(t.scope) ? 'flex' : 'none'};padding-left:16px;flex-wrap:wrap;gap:8px">
          ${renderScopeTasks(t)}
        </div>`;
      listEl.appendChild(row);
      row.querySelector('[data-field="name"]').addEventListener('change', (e) => {
        updateToken(t.id, { name: e.target.value });
      });
      row.querySelector('[data-field="allowParams"]').addEventListener('change', (e) => {
        updateToken(t.id, { allowParams: e.target.checked });
      });
      row.querySelector('[data-field="expiresAt"]').addEventListener('change', (e) => {
        const v = e.target.value;
        updateToken(t.id, { expiresAt: v ? new Date(v).getTime() : 0 });
      });
      row.querySelector('[data-field="scope"]').addEventListener('change', (e) => {
        updateToken(t.id, { scope: e.target.value === 'all' ? 'all' : [] });
      });
      row.querySelector('[data-act="copy"]').addEventListener('click', () => {
        navigator.clipboard.writeText(t.value || '').then(
          () => window.showToast?.('Token 已复制', 'success', 1500),
          () => window.showToast?.('复制失败', 'error', 2000)
        );
      });
      row.querySelector('[data-act="roll"]').addEventListener('click', async () => {
        const r = await window.api.automationGenerateTokenValue();
        if (!r || !r.ok) return;
        await updateToken(t.id, { value: r.value });
        window.showToast?.('已生成新 Token 值', 'success', 2000);
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async () => {
        const next = (autoCfg.tokens || []).filter(x => x.id !== t.id);
        await saveAutomationCfg({ tokens: next });
      });
      const clearExpiry = row.querySelector('[data-act="clear-expiry"]');
      if (clearExpiry) clearExpiry.addEventListener('click', async () => {
        await updateToken(t.id, { expiresAt: 0 });
      });
      row.querySelectorAll('[data-role="scope-task"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const scope = Array.isArray(t.scope) ? t.scope.slice() : [];
          const id = e.target.value;
          const i = scope.indexOf(id);
          if (e.target.checked) { if (i < 0) scope.push(id); }
          else if (i >= 0) scope.splice(i, 1);
          updateToken(t.id, { scope });
        });
      });
    });
  }
  function expiredHint(t) {
    if (!t.expiresAt || t.expiresAt <= 0) return '';
    const expired = t.expiresAt < Date.now();
    return `<span style="color:${expired ? '#c0392b' : 'var(--text-tertiary)'}">${expired ? '（已过期）' : '（' + new Date(t.expiresAt).toLocaleString() + ' 前有效）'}</span>`;
  }
  function renderScopeTasks(t) {
    const sel = Array.isArray(t.scope) ? t.scope : [];
    if (autoTasks.length === 0) {
      return '<span style="color:var(--text-tertiary);font-size:12px">暂无任务，可在触发页先创建自动化任务</span>';
    }
    return autoTasks.map(task => {
      const checked = sel.includes(task.id);
      return `<label class="checkbox-label">
        <input type="checkbox" data-role="scope-task" value="${escapeHtml(task.id)}" ${checked ? 'checked' : ''}> ${escapeHtml(task.name || task.id)}
      </label>`;
    }).join('');
  }
  async function updateToken(id, patch) {
    const tokens = (autoCfg.tokens || []).map(t => t.id === id ? Object.assign({}, t, patch) : t);
    await saveAutomationCfg({ tokens });
  }
  async function refreshAutomationServerStatus() {
    const el = document.getElementById('automation-settings-server-status');
    if (!el) return;
    try {
      const res = await window.api.automationList();
      const srv = (res && res.server) || { running: false, state: 'off' };
      const tokenCount = autoCfg.tokens ? autoCfg.tokens.length : 0;
      if (srv.running && srv.insecure) {
        el.textContent = `⚠️ 运行中但无 Token 鉴权（127.0.0.1:${srv.port || '?'}）— 不安全，任何本机程序均可触发`;
        el.style.color = '#c0392b';
      } else if (srv.running) {
        el.textContent = `✅ 运行中（127.0.0.1:${srv.port || '?'}，${tokenCount} 个 Token）`;
        el.style.color = 'var(--text-secondary)';
      } else if (srv.state === 'disabled') {
        el.textContent = '⏸ 未启用：服务器未启动（打开上方开关后生效）';
        el.style.color = 'var(--text-tertiary)';
      } else if (srv.state === 'missing-token') {
        el.textContent = `⚠️ 已启用但没有 Token：服务器未启动（添加 Token，或开启「允许无 Token 启动」）`;
        el.style.color = 'var(--warning, #b7791f)';
      } else {
        el.textContent = '未运行（无启用中的 HTTP 触发任务）';
        el.style.color = 'var(--text-tertiary)';
      }
    } catch (e) {
      el.textContent = '状态获取失败：' + (e.message || e);
    }
  }
  document.getElementById('setting-automation-enabled')?.addEventListener('change', async (e) => {
    const r = await saveAutomationCfg({ enabled: e.target.checked });
    if (!r) { e.target.checked = !e.target.checked; return; }
    window.showToast?.(e.target.checked ? 'HTTP 信号服务器已启用' : 'HTTP 信号服务器已禁用', 'success', 2000);
  });
  document.getElementById('setting-automation-allow-notoken')?.addEventListener('change', async (e) => {
    const r = await saveAutomationCfg({ allowNoToken: e.target.checked });
    if (!r) { e.target.checked = !e.target.checked; return; }
    window.showToast?.(e.target.checked ? '已开启无 Token 模式（不安全）' : '无 Token 模式已关闭', 'success', 2000);
  });
  document.getElementById('setting-automation-port')?.addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      e.target.value = autoCfg.serverPort || 8765;
      window.showToast?.('端口需在 1-65535', 'error', 2500);
      return;
    }
    const r = await saveAutomationCfg({ serverPort: v }, '端口已保存（需重启服务器生效）');
    if (r) e.target.value = r.settings.serverPort;
  });
  document.getElementById('btn-automation-add-token')?.addEventListener('click', async () => {
    const gen = await window.api.automationGenerateTokenValue();
    if (!gen || !gen.ok) { window.showToast?.(gen?.error || '生成失败', 'error', 2500); return; }
    const tokens = (autoCfg.tokens || []).concat([{
      name: '新 Token',
      value: gen.value,
      scope: 'all',
      allowParams: true,
      expiresAt: 0
    }]);
    const r = await saveAutomationCfg({ tokens }, 'Token 已添加');
    if (!r) window.showToast?.('添加失败', 'error', 2500);
  });
  loadAutomationSettings();
  refreshAutomationTasks();

  // ---- DeepSeek 插件：工具注册 + 管理页 ----
  async function refreshDsPluginTools() {
    if (typeof window.api.dsListPluginTools !== 'function') return;
    try {
      const res = await window.api.dsListPluginTools();
      if (!res || !res.ok) return;
      clearDsPluginTools();
      for (const p of res.plugins || []) {
        const tools = (p.tools || []).map(t => ({
          name: t.name,
          description: t.description,
          icon: 'fa-puzzle-piece',
          compatTier: t.compatTier || 'native'
        }));
        const schemas = {};
        for (const t of p.tools || []) schemas[t.name] = t.schema || { type: 'object', properties: {} };
        registerDsPluginTools(p.id, p.name, tools, schemas);
      }
      // 工具集变化：同步提示词（会话冻结纪律——下个会话生效；这里只更新定义与页面）
      agent.contextManager?.setSystemPrompt(agent.getSystemPrompt());
      if (document.getElementById('page-tools')?.classList.contains('active')) loadToolsPage();
    } catch (e) {
      console.error('[DS Plugins] 刷新工具失败', e);
    }
  }
  async function renderPluginsList() {
    const listEl = document.getElementById('plugins-list');
    if (!listEl || typeof window.api.dsListPlugins !== 'function') return;
    const res = await window.api.dsListPlugins();
    const plugins = (res && res.ok && Array.isArray(res.plugins)) ? res.plugins : [];
    if (plugins.length === 0) {
      listEl.innerHTML = '<p style="font-size:12px;color:var(--text-tertiary)">尚未安装任何 DeepSeek 插件</p>';
      return;
    }
    listEl.innerHTML = plugins.map(p => {
      const tier = p.compatTier || 'native';
      const issues = (p.compatIssues || []).slice(0, 2).map(i => `<div style="color:var(--error-color,#d04848);font-size:11px">⚠ ${escapeHtml(i)}</div>`).join('');
      const srcLabel = p.source?.type === 'local' ? '本地' : p.source?.type === 'npm' ? 'npm' : p.source?.type === 'github' ? 'GitHub' : 'tgz';
      return `
        <div class="plugin-card" data-plugin-id="${escapeHtml(p.id)}">
          <div class="plugin-card-main">
            <div class="plugin-card-name">
              <i class="fa-solid fa-puzzle-piece" style="color:var(--accent)"></i>
              ${escapeHtml(p.name)} <span style="font-size:11px;color:var(--text-tertiary)">v${escapeHtml(p.version)}</span>
              <span class="ds-compat-badge ${tier}">${tier}</span>
            </div>
            <div class="plugin-card-desc">${escapeHtml(p.description || '')}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:3px">${srcLabel} · ${p.toolCount} 个工具</div>
            ${issues}
          </div>
          <div class="plugin-card-actions">
            <div class="toggle-switch"><input type="checkbox" ${p.enabled ? 'checked' : ''} data-plugin-toggle="${escapeHtml(p.id)}"><span class="toggle-slider"></span></div>
            <button class="btn-secondary btn-sm" data-plugin-config="${escapeHtml(p.id)}">配置</button>
            <button class="btn-secondary btn-sm" data-plugin-uninstall="${escapeHtml(p.id)}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('input[data-plugin-toggle]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const r = await window.api.dsSetPluginEnabled(cb.dataset.pluginToggle, cb.checked);
        if (!r.ok) { cb.checked = !cb.checked; window.showToast?.(r.error, 'error', 3000); return; }
        window.showToast?.(`插件已${cb.checked ? '启用' : '禁用'}（工具集下个会话生效）`, 'success', 2500);
        await renderPluginsList();
        await refreshDsPluginTools();
      });
    });
    listEl.querySelectorAll('[data-plugin-uninstall]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await window.confirmDialog(`卸载插件并删除其文件？此操作不可恢复。`, '卸载插件');
        if (!ok) return;
        const r = await window.api.dsUninstallPlugin(btn.dataset.pluginUninstall);
        if (!r.ok) { window.showToast?.(r.error, 'error', 3000); return; }
        await renderPluginsList();
        await refreshDsPluginTools();
      });
    });
    listEl.querySelectorAll('[data-plugin-config]').forEach(btn => {
      btn.addEventListener('click', () => {
        const plugin = plugins.find(p => p.id === btn.dataset.pluginConfig);
        if (!plugin) return;
        openPluginConfigModal(plugin);
      });
    });
  }
  // ---- 插件配置模态框（替代 renderer 不支持的 window.prompt）----
  let pluginConfigTarget = null;
  function openPluginConfigModal(plugin) {
    pluginConfigTarget = plugin;
    const title = document.getElementById('plugin-config-title');
    const ta = document.getElementById('plugin-config-textarea');
    const err = document.getElementById('plugin-config-error');
    if (title) title.textContent = `插件配置 · ${plugin.name}`;
    if (ta) ta.value = JSON.stringify(plugin.config || {}, null, 2);
    if (err) err.style.display = 'none';
    document.getElementById('plugin-config-modal')?.classList.remove('hidden');
  }
  function closePluginConfigModal() {
    fadeOutHide(document.getElementById('plugin-config-modal'));
    pluginConfigTarget = null;
  }
  document.getElementById('btn-close-plugin-config')?.addEventListener('click', closePluginConfigModal);
  document.getElementById('btn-cancel-plugin-config')?.addEventListener('click', closePluginConfigModal);
  document.getElementById('btn-save-plugin-config')?.addEventListener('click', async () => {
    const plugin = pluginConfigTarget;
    const ta = document.getElementById('plugin-config-textarea');
    const err = document.getElementById('plugin-config-error');
    if (!plugin || !ta) return;
    let patch;
    try {
      patch = JSON.parse(ta.value || '{}');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置必须是 JSON 对象');
    } catch (e) {
      if (err) { err.textContent = '配置 JSON 无效：' + e.message; err.style.display = ''; }
      return;
    }
    const r = await window.api.dsSetPluginConfig(plugin.id, patch);
    if (!r.ok) {
      if (err) { err.textContent = r.error || '保存失败'; err.style.display = ''; }
      return;
    }
    closePluginConfigModal();
    window.showToast?.(`插件 ${plugin.name} 配置已保存`, 'success', 2500);
    await renderPluginsList();
    await refreshDsPluginTools();
  });
  async function installPlugin(source) {
    const statusEl = document.getElementById('plugin-install-status');
    if (statusEl) statusEl.textContent = '安装中…';
    // 实时显示 npm 输出尾部（安装已是异步执行，不再阻塞渲染器）
    let offProgress = null;
    if (typeof window.api.onPluginsInstallProgress === 'function') {
      offProgress = window.api.onPluginsInstallProgress((p) => {
        if (!statusEl || !p) return;
        const line = p.line || p.stage || '';
        statusEl.textContent = '安装中… ' + String(line).slice(-140);
      });
    }
    let r;
    try {
      if (source.type === 'local') {
        const dir = (document.getElementById('plugin-install-dir')?.value || '').trim();
        if (!dir) { if (statusEl) statusEl.textContent = '请输入插件目录'; return; }
        r = await window.api.dsInstallLocal(dir);
      } else if (source.type === 'npm') {
        const name = (document.getElementById('plugin-install-npm')?.value || '').trim();
        if (!name) { if (statusEl) statusEl.textContent = '请输入 npm 包名'; return; }
        r = await window.api.dsInstallNpm(name);
      } else if (source.type === 'github') {
        const repo = (document.getElementById('plugin-install-github')?.value || '').trim();
        if (!repo) { if (statusEl) statusEl.textContent = '请输入 owner/repo'; return; }
        r = await window.api.dsInstallGithub(repo);
      }
    } catch (e) {
      r = { ok: false, error: e.message };
    } finally {
      if (typeof offProgress === 'function') { try { offProgress(); } catch { /* ignore */ } }
    }
    if (statusEl) {
      if (r && r.ok) {
        statusEl.textContent = `✅ 已安装 ${r.plugin?.name || ''}（默认禁用，请在下方启用）`;
      } else if (r && Array.isArray(r.catalog) && r.catalog.length) {
        statusEl.innerHTML = `<div style="margin-bottom:6px">❌ ${escapeHtml(r.error || '安装失败')}</div>`
          + `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">目录中的插件（点击直接安装）：</div>`
          + `<div style="display:flex;flex-wrap:wrap;gap:6px">${r.catalog.slice(0, 60).map(repo =>
            `<button class="btn-secondary btn-sm" data-catalog-repo="${escapeHtml(repo)}">${escapeHtml(repo)}</button>`).join('')}</div>`;
        statusEl.querySelectorAll('[data-catalog-repo]').forEach(btn => {
          btn.addEventListener('click', () => {
            const input = document.getElementById('plugin-install-github');
            if (input) input.value = btn.dataset.catalogRepo;
            installPlugin({ type: 'github' });
          });
        });
      } else {
        statusEl.textContent = `❌ ${r?.error || '安装失败'}`;
      }
    }
    await renderPluginsList();
  }
  document.getElementById('btn-plugin-pick-dir')?.addEventListener('click', async () => {
    const r = await window.api.openFileDialog({ directory: true, title: '选择插件目录' });
    if (r && r.ok && Array.isArray(r.paths) && r.paths.length > 0) {
      const input = document.getElementById('plugin-install-dir');
      if (input) input.value = r.paths[0];
    }
  });
  document.getElementById('btn-plugin-install-dir')?.addEventListener('click', () => installPlugin({ type: 'local' }));
  document.getElementById('btn-plugin-install-npm')?.addEventListener('click', () => installPlugin({ type: 'npm' }));
  document.getElementById('btn-plugin-install-github')?.addEventListener('click', () => installPlugin({ type: 'github' }));
  if (typeof window.api.onPluginsChanged === 'function') {
    window.api.onPluginsChanged(() => {
      renderPluginsList().catch(() => {});
      refreshDsPluginTools().catch(() => {});
    });
  }
  renderPluginsList().catch(() => {});
  refreshDsPluginTools().catch(() => {});

  async function loadMcpServerList() {
    const listEl = document.getElementById('mcp-servers-list');
    const toolsEl = document.getElementById('mcp-connected-tools');
    if (!listEl) return;

    try {
      const servers = await window.api.mcpListServers();
      if (!servers || servers.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">暂无 MCP 服务器配置</p>';
        toolsEl.innerHTML = '暂无已连接的 MCP 服务器';
        return;
      }

      listEl.innerHTML = servers.map(s => {
        const statusDot = s.status === 'connected' ? 'connected' : s.status === 'error' ? 'error' : '';
        const statusText = s.status === 'connected' ? '已连接' : s.status === 'connecting' ? '连接中...' : s.status === 'error' ? '错误' : '未连接';
        return `
          <div class="mcp-server-card" data-name="${s.name}">
            <div class="mcp-server-icon"><i class="fa-solid fa-server"></i></div>
            <div class="mcp-server-info">
              <h4>${s.name}</h4>
              <p>${s.command || ''} ${(s.args || []).join(' ')}</p>
            </div>
            <div class="mcp-server-status">
              <span class="dot ${statusDot}"></span>
              <span>${statusText}${s.toolCount ? ` (${s.toolCount} 工具)` : ''}</span>
            </div>
            <div class="mcp-server-actions">
              ${s.status === 'connected'
                ? `<button class="btn-icon btn-mcp-disconnect" data-name="${s.name}" title="断开"><i class="fa-solid fa-plug-circle-xmark"></i></button>`
                : `<button class="btn-icon btn-mcp-connect" data-name="${s.name}" title="连接"><i class="fa-solid fa-plug-circle-check"></i></button>`
              }
              <button class="btn-icon btn-mcp-remove" data-name="${s.name}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>`;
      }).join('');

      // Bind buttons
      listEl.querySelectorAll('.btn-mcp-connect').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          btn.disabled = true;
          await window.api.mcpConnect(name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-disconnect').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpDisconnect(btn.dataset.name);
          await loadMcpServerList();
        });
      });
      listEl.querySelectorAll('.btn-mcp-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          await window.api.mcpRemoveServer(btn.dataset.name);
          await loadMcpServerList();
        });
      });

      // Show connected tools
      const toolsResult = await window.api.mcpListTools();
      if (toolsResult.ok && toolsResult.tools.length > 0) {
        toolsEl.innerHTML = toolsResult.tools.map(t =>
          `<div style="margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border)">
            <strong>${t.name}</strong> <span style="color:var(--text-secondary);font-size:11px">[${t.serverName}]</span>
            <br><span style="font-size:12px">${t.description || ''}</span>
          </div>`
        ).join('');
      } else {
        toolsEl.innerHTML = '暂无已连接的工具';
      }
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--error-color)">加载失败: ${e.message}</p>`;
    }
  }

  function setupMcpEvents() {
    if (mcpEventsSetup) return;
    mcpEventsSetup = true;

    const btnAdd = document.getElementById('btn-mcp-add');
    const form = document.getElementById('mcp-add-form');
    const btnCancel = document.getElementById('btn-mcp-cancel');
    const btnSave = document.getElementById('btn-mcp-save');

    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        form.classList.toggle('hidden');
      });
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        form.classList.add('hidden');
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const name = document.getElementById('mcp-new-name').value.trim();
        const command = document.getElementById('mcp-new-command').value.trim();
        const argsStr = document.getElementById('mcp-new-args').value.trim();
        const envStr = document.getElementById('mcp-new-env').value.trim();
        const cwd = document.getElementById('mcp-new-cwd').value.trim();
        const autoConnect = document.getElementById('mcp-new-autoconnect').checked;

        if (!name || !command) {
          alert('名称和命令不能为空');
          return;
        }

        let args = [];
        let env = {};
        try { if (argsStr) args = JSON.parse(argsStr); } catch { alert('参数格式错误(需JSON数组)'); return; }
        try { if (envStr) env = JSON.parse(envStr); } catch { alert('环境变量格式错误(需JSON对象)'); return; }

        const result = await window.api.mcpAddServer({ name, command, args, env, cwd: cwd || undefined, autoConnect });
        if (result.ok) {
          document.getElementById('mcp-new-name').value = '';
          document.getElementById('mcp-new-command').value = '';
          document.getElementById('mcp-new-args').value = '';
          document.getElementById('mcp-new-env').value = '';
          document.getElementById('mcp-new-cwd').value = '';
          document.getElementById('mcp-new-autoconnect').checked = false;
          form.classList.add('hidden');
          await loadMcpServerList();
        } else {
          alert(result.error || '添加失败');
        }
      });
    }
  }

  function updateAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-ai-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('ai');
  }

  function updateUserAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-user-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, false, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('user');
  }

  function updateBabeAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-babe-avatar-preview');
    if (!preview) return;
    // Babe 默认头像：无图时使用心形图标
    if (avatarData) {
      preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    } else {
      preview.innerHTML = '<i class="fa-solid fa-heart"></i>';
    }
    updateAvatarPreviewFrame('babe');
  }

  // ---- 环境检测面板（Python / Node+npm 或 Bun 任选其一 / Git）----
  const ENV_META = {
    python: { label: 'Python', icon: 'fa-brands fa-python', hint: 'Python 3 解释器（含 pip）' },
    git: { label: 'Git', icon: 'fa-brands fa-git-alt', hint: '分布式版本控制' }
  };
  const RUNTIME_CHOICES = {
    node: { label: 'Node.js（含 npm）', icon: 'fa-brands fa-node-js', verify: 'node --version 和 npm --version', hint: '推荐 LTS 长期支持版，自带 npm' },
    bun: { label: 'Bun', icon: 'fa-solid fa-bolt', verify: 'bun --version', hint: '自带 bun install 包管理器' }
  };
  const KIND_DESCRIPTIONS = {
    python: { name: 'Python', detail: 'Python 3 解释器（含 pip）', verify: 'python3 --version' },
    git: { name: 'Git', detail: '分布式版本控制', verify: 'git --version' },
    node: { name: 'Node.js（含 npm）', detail: '推荐 LTS 长期支持版，自带 npm 包管理器', verify: 'node --version 和 npm --version' },
    bun: { name: 'Bun', detail: '自带 bun install 包管理器', verify: 'bun --version' },
    runtime: { name: 'JavaScript 运行时（Node.js 含 npm 或 Bun 任选其一）', detail: '二选一即可，推荐 Node.js LTS', verify: 'node --version 或 bun --version' }
  };
  let envDetectCache = null;

  function buildEnvironmentRows() {
    const d = envDetectCache || {};
    const node = d.node || {};
    const npm = d.npm || {};
    const bun = d.bun || {};
    const rows = Object.entries(ENV_META).map(([kind, meta]) => {
      const item = d[kind] || {};
      return {
        kind,
        label: meta.label,
        icon: meta.icon,
        hint: meta.hint,
        found: !!item.found,
        text: item.version || null,
        path: item.path || null,
        choices: null
      };
    });
    const runtime = node.found
      ? {
          kind: 'runtime', label: 'Node.js 运行时', icon: 'fa-brands fa-node-js',
          hint: 'Node+npm 或 Bun 任选其一', found: true,
          text: `Node.js ${node.version || ''}${npm.found ? ` · npm ${npm.version}` : ''}`,
          path: node.path || null, choices: null
        }
      : bun.found
        ? {
            kind: 'runtime', label: 'Bun 运行时', icon: 'fa-solid fa-bolt',
            hint: 'Node+npm 或 Bun 任选其一', found: true,
            text: `Bun ${bun.version || ''}`, path: bun.path || null, choices: null
          }
        : {
            kind: 'runtime', label: 'JavaScript 运行时', icon: 'fa-brands fa-js',
            hint: 'Node+npm 或 Bun 任选其一', found: false,
            text: null, path: null, choices: ['node', 'bun']
          };
    rows.splice(1, 0, runtime);
    return rows;
  }

  function renderEnvironmentPanel(result) {
    const list = document.getElementById('env-detect-list');
    const actions = document.getElementById('env-detect-actions');
    const status = document.getElementById('env-detect-status');
    if (!list) return;
    if (!result || !result.ok) {
      if (status) status.textContent = '检测失败：' + ((result && result.error) || '未知错误');
      list.innerHTML = '';
      if (actions) actions.innerHTML = '';
      return;
    }
    envDetectCache = result.results || {};
    const platformLabel = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[result.platform] || (result.platform || '');
    if (status) status.textContent = `检测完成${platformLabel ? `（${platformLabel}）` : ''}`;
    const rows = buildEnvironmentRows();
    const missing = rows.filter(r => !r.found).map(r => r.kind);
    list.innerHTML = rows.map(row => {
      const badge = row.found
        ? `<span class="env-badge ok"><i class="fa-solid fa-circle-check"></i> ${escapeHtml(row.text || '已安装')}</span>`
        : `<span class="env-badge missing"><i class="fa-solid fa-triangle-exclamation"></i> 未检测到</span>`;
      const pathLine = (row.found && row.path) ? `<div class="env-path" title="${escapeHtml(row.path)}">${escapeHtml(row.path)}</div>` : '';
      const disabled = isRemoteMode ? 'disabled title="Remote 模式下不可用"' : '';
      let installBtns = '';
      if (!row.found) {
        if (Array.isArray(row.choices)) {
          installBtns = `<div class="env-actions">${row.choices.map(c => `<button class="btn-primary btn-sm env-install-btn" data-install="${c}" ${disabled}>安装 ${escapeHtml(RUNTIME_CHOICES[c].label)}</button>`).join('')}</div>`;
        } else {
          installBtns = `<button class="btn-primary btn-sm env-install-btn" data-install="${row.kind}" ${disabled}>让 Agent 安装</button>`;
        }
      }
      return `
        <div class="env-detect-row">
          <div class="env-icon"><i class="${row.icon}"></i></div>
          <div class="env-main">
            <div class="env-name">${row.label}<span class="env-hint">${escapeHtml(row.hint)}</span></div>
            ${pathLine}
          </div>
          ${badge}
          ${installBtns}
        </div>`;
    }).join('');
    if (actions) {
      actions.innerHTML = (missing.length && !isRemoteMode)
        ? `<button class="btn-primary btn-sm" id="btn-env-install-all"><i class="fa-solid fa-wrench"></i> 一键让 Agent 安装全部缺失项（${missing.length}）</button>`
        : '';
      const allBtn = document.getElementById('btn-env-install-all');
      if (allBtn) allBtn.addEventListener('click', () => askAgentInstallMissing(missing));
    }
    list.querySelectorAll('.env-install-btn').forEach(btn => {
      btn.addEventListener('click', () => askAgentToInstall(btn.dataset.install));
    });
  }

  function buildInstallPrompt(kinds) {
    const descs = kinds.map(k => KIND_DESCRIPTIONS[k]).filter(Boolean);
    if (!descs.length) return '';
    const names = descs.map(d => d.name).join('、');
    const lines = descs.map(d => `- ${d.name}（${d.detail}）：未检测到，或不在 PATH 中`);
    return [
      `请帮我在本机安装并验证开发环境组件：${names}。`,
      '',
      '当前检测结果：',
      ...lines,
      '',
      '请按以下步骤处理：',
      '1. 先判断操作系统和已装的包管理器（macOS 可用 Homebrew，Windows 可用 winget，Linux 用对应系统包管理器），选择对用户最稳妥的官方安装方式；',
      `2. 逐个安装 ${names}，如需把程序加入 PATH 请明确处理；若包含 JavaScript 运行时，Node.js（含 npm）与 Bun 二选一即可，不要两个都装；`,
      `3. 安装完成后分别运行版本命令验证（${descs.map(d => d.verify).join('、')}），并把版本号汇报给我；`,
      '4. 如果某个组件其实已安装但检测不到，优先排查 PATH 配置，而不是重复安装。'
    ].join('\n');
  }

  async function openChatSessionAndSend(prompt) {
    if (typeof createNewSession !== 'function') throw new Error('会话模块未就绪');
    await createNewSession('chat');
    // 等待会话激活完成（跨模式切换是异步的）
    await new Promise(r => setTimeout(r, 80));
    // 确保导航到聊天页（用户可能停留在设置页，而当前模式已是 chat）
    document.querySelector('.nav-item[data-page="chat"]')?.click();
    const sm = window.__sessionManager;
    const session = sm ? sm.getActive('chat') : null;
    const ag = (session && session.agent) || agent;
    if (!ag) throw new Error('无法获取 Chat Agent');
    if (typeof addMessageToChat === 'function') addMessageToChat('user', prompt);
    if (typeof addThinkingIndicator === 'function') addThinkingIndicator();
    try {
      await ag.sendMessage(prompt, []);
    } finally {
      if (typeof removeThinkingIndicator === 'function') removeThinkingIndicator();
    }
  }

  async function askAgentToInstall(kind) {
    if (!KIND_DESCRIPTIONS[kind]) return;
    const btn = document.querySelector(`.env-install-btn[data-install="${kind}"]`);
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打开会话…'; }
    try {
      await openChatSessionAndSend(buildInstallPrompt([kind]));
    } catch (e) {
      console.error('让 Agent 安装失败:', e);
      if (btn) { btn.disabled = false; btn.textContent = original || '让 Agent 安装'; }
    }
  }

  async function askAgentInstallMissing(kinds) {
    if (!kinds || !kinds.length) return;
    const btn = document.getElementById('btn-env-install-all');
    if (btn) { btn.disabled = true; btn.textContent = '正在打开会话…'; }
    try {
      await openChatSessionAndSend(buildInstallPrompt(kinds));
    } catch (e) {
      console.error('让 Agent 安装失败:', e);
      if (btn) { btn.disabled = false; btn.textContent = `一键让 Agent 安装全部缺失项（${kinds.length}）`; }
    }
  }

  async function refreshEnvironmentPanel() {
    const status = document.getElementById('env-detect-status');
    if (status) status.textContent = '检测中…';
    const list = document.getElementById('env-detect-list');
    if (list) list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>正在检测运行环境…</p></div>';
    try {
      const result = await window.api.detectEnvironment();
      renderEnvironmentPanel(result);
    } catch (e) {
      renderEnvironmentPanel({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  document.getElementById('btn-env-refresh')?.addEventListener('click', refreshEnvironmentPanel);

  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.querySelector(`.settings-panel[data-tab="${btn.dataset.tab}"]`);
      if (panel) panel.classList.add('active');
      // Lazy-load usage stats when the tab is opened
      if (btn.dataset.tab === 'usage') {
        const activePeriod = document.querySelector('.usage-period-btn.active');
        loadUsageStats(activePeriod ? activePeriod.dataset.period : 'daily');
      }
      if (btn.dataset.tab === 'environment') refreshEnvironmentPanel();
      // 推送设置选项卡和面板的 active 状态到 WebUI/Remote
      document.querySelectorAll('.settings-tab').forEach(b => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-tab[data-tab="' + b.dataset.tab + '"]', attr: 'class', value: b.className });
      });
      document.querySelectorAll('.settings-panel').forEach(p => {
        if (p.dataset.tab) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-panel[data-tab="' + p.dataset.tab + '"]', attr: 'class', value: p.className });
      });
    });
  });

  // ============ 设置页搜索（Ctrl/Cmd+F 打开，仅设置页生效） ============
  const settingsSearch = (() => {
    const input = document.getElementById('settings-search-input');
    const countEl = document.getElementById('settings-search-count');
    if (!input || !countEl) return null;

    let query = '';
    let lastActiveTab = 'ai';

    function activateTab(tabId) {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
    }

    function settingItemText(item) {
      let text = item.textContent || '';
      item.querySelectorAll('input, textarea, select').forEach(el => {
        text += ' ' + (el.value || '') + ' ' + (el.placeholder || '');
      });
      return text.toLowerCase();
    }

    function applyQuery() {
      const q = query;
      const panels = Array.from(document.querySelectorAll('#page-settings .settings-panel'));
      let matchCount = 0;
      let firstPanelTab = null;
      panels.forEach(panel => {
        const items = Array.from(panel.querySelectorAll(':scope > .settings-group > .setting-item, :scope > .setting-item'));
        let panelMatches = 0;
        items.forEach(item => {
          const ok = !q || settingItemText(item).includes(q);
          item.classList.toggle('settings-search-match', !!q && ok);
          item.style.display = q ? (ok ? '' : 'none') : '';
          if (q && ok) panelMatches++;
        });
        panel.querySelectorAll(':scope > .settings-group').forEach(group => {
          const hasVisibleItem = group.querySelector('.setting-item:not([style*="display: none"])');
          const titleMatch = q && group.querySelector('h3') && (group.querySelector('h3').textContent || '').toLowerCase().includes(q);
          group.style.display = q ? ((hasVisibleItem || titleMatch) ? '' : 'none') : '';
        });
        const panelVisible = !q || panelMatches > 0;
        panel.style.display = q ? (panelVisible ? '' : 'none') : '';
        if (panelVisible && q) {
          matchCount += panelMatches;
          if (!firstPanelTab) firstPanelTab = panel.dataset.tab;
        }
        const tab = document.querySelector(`.settings-tab[data-tab="${panel.dataset.tab}"]`);
        if (tab) tab.style.display = q ? (panelVisible ? '' : 'none') : '';
      });
      countEl.textContent = q ? `${matchCount} 项` : '';
      input.classList.toggle('has-results', !!q);
      if (q && firstPanelTab) activateTab(firstPanelTab);
      else if (!q) activateTab(lastActiveTab);
    }

    function open() {
      lastActiveTab = document.querySelector('.settings-tab.active')?.dataset.tab || 'ai';
      input.focus({ preventScroll: true });
      try { input.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      Promise.resolve().then(() => input.focus({ preventScroll: true }));
    }

    function close() {
      if (query || input.value) {
        query = '';
        input.value = '';
        applyQuery();
      }
      input.blur();
    }

    input.addEventListener('input', () => {
      query = input.value.trim().toLowerCase();
      applyQuery();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    document.querySelectorAll('.settings-tab').forEach(b => {
      b.addEventListener('click', () => { if (!query) lastActiveTab = b.dataset.tab; });
    });

    if (typeof window.registerPageSearch === 'function') {
      window.registerPageSearch('settings', { open, close });
    }
    return { open, close };
  })();

  // Settings change handlers
  async function saveSettings(updates) {
    const current = await window.api.getSettings();
    const merged = { ...current, ...updates };
    await window.api.setSettings(merged);
    // 全局字体即时生效
    if (typeof applyFontSettings === 'function') applyFontSettings(merged);
    // 即时生效：更新 maxTokens + 重算 systemPrompt（persona/llm 变更后立即生效，无需重启）
    if (typeof agent.applySettings === 'function') {
      agent.applySettings(merged);
    } else {
      agent.settings = merged;
    }
    // 隐私信息保护：同步到 Code / Babe 代理实例（其 settings 为独立快照）
    if (merged.privacyProtection) {
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) codeAgent.settings.privacyProtection = merged.privacyProtection;
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) babeAgent.settings.privacyProtection = merged.privacyProtection;
    }
  }

  // LLM settings
  ['setting-llm-url', 'setting-llm-key', 'setting-llm-model', 'setting-llm-ctx', 'setting-llm-daily-limit', 'setting-llm-max-response'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-llm-url': 'apiUrl', 'setting-llm-key': 'apiKey', 'setting-llm-model': 'model', 'setting-llm-ctx': 'maxContextLength', 'setting-llm-daily-limit': 'dailyMaxTokens', 'setting-llm-max-response': 'maxResponseTokens' }[id];
      const val = (id === 'setting-llm-ctx' || id === 'setting-llm-daily-limit' || id === 'setting-llm-max-response') ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      s.llm[key] = val;
      await saveSettings(s);
      if (key === 'maxContextLength') agent.contextManager.setMaxTokens(val);
      if (key === 'model' || key === 'apiUrl') refreshReasoningVariants();
    });
  });

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

  // Provider selection — switches between OpenAI-compat and Zen fields
  document.getElementById('setting-llm-provider').addEventListener('change', async (e) => {
    const provider = e.target.value;
    const s = await window.api.getSettings();
    s.llm.provider = provider;
    // When switching to Zen, persist a sensible default apiUrl/model
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
    }
    await saveSettings(s);
    updateLLMProviderFields(provider);
    refreshReasoningVariants();
    if (provider === 'opencode-zen') {
      await refreshZenModels(s.llm.model);
      // sync zen-model dropdown with current model
      const zenSel = document.getElementById('setting-llm-zen-model');
      if (zenSel) zenSel.value = s.llm.model;
    } else {
      // restore model field text
      const modelEl = document.getElementById('setting-llm-model');
      if (modelEl) modelEl.value = s.llm.model || '';
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
    try {
      const apiUrl = provider === 'opencode-zen' ? '' : (s.llm.apiUrl || '');
      const apiKey = provider === 'opencode-zen' ? (s.llm.zenApiKey || '') : (s.llm.apiKey || '');
      const res = await window.api.llmCapabilities?.(provider, model, apiUrl, apiKey);
      if (res && res.ok && Array.isArray(res.variants) && res.variants.length > 0) {
        variants = res.variants;
        defaultId = res.defaultId || 'off';
      }
    } catch (_) { /* 网络/端点失败：走本地兜底 */ }
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
  document.querySelectorAll('.usage-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.usage-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadUsageStats(btn.dataset.period);
    });
  });

  // Usage stats refresh button
  const usageRefreshBtn = document.getElementById('btn-usage-refresh');
  if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', async () => {
    const activePeriod = document.querySelector('.usage-period-btn.active');
    await loadUsageStats(activePeriod ? activePeriod.dataset.period : 'daily');
    window.showToast('用量统计已刷新', 'success');
  });

  // Image settings
  ['setting-img-url', 'setting-img-key', 'setting-img-model', 'setting-img-daily-limit'].forEach(id => {
    document.getElementById(id).addEventListener('change', async (e) => {
      const key = { 'setting-img-url': 'apiUrl', 'setting-img-key': 'apiKey', 'setting-img-model': 'model', 'setting-img-daily-limit': 'dailyMaxImages' }[id];
      const s = await window.api.getSettings();
      const val = id === 'setting-img-daily-limit' ? parseInt(e.target.value) : e.target.value;
      s.imageGen[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-img-size').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.imageGen.imageSize = e.target.value;
    await saveSettings(s);
  });

  // Theme mode
  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const s = await window.api.getSettings();
      const oldMode = s.theme.mode;
      s.theme.mode = btn.dataset.mode;

      // 检测是否切换了深浅色模式
      const oldDark = await ThemeManager.getCurrentDarkMode(oldMode);
      const newDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
      const currentBgDark = ThemeManager.isBackgroundDark(s.theme.backgroundColor);

      // 如果深浅色模式改变，或者当前配色与目标模式不符，随机应用目标色系的配色
      if (oldDark !== newDark || currentBgDark !== newDark) {
        const scheme = ThemeManager.getRandomScheme(newDark);
        s.theme.accentColor = scheme.accent;
        s.theme.backgroundColor = scheme.bg;
        document.getElementById('setting-accent-color').value = scheme.accent;
        document.getElementById('setting-bg-color').value = scheme.bg;
      }

      await saveSettings(s);
      ThemeManager.apply(s.theme);
      updateColorSchemeVisibility();
    });
  });

  // Accent color
  document.getElementById('setting-accent-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.accentColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#accent-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-accent-color').value = color;
      const s = await window.api.getSettings();
      s.theme.accentColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Background color
  document.getElementById('setting-bg-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.backgroundColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#bg-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-bg-color').value = color;
      const s = await window.api.getSettings();
      s.theme.backgroundColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // 界面动效开关（主标签页切换动画）
  document.getElementById('setting-ui-animations').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.animations = e.target.checked;
    document.documentElement.setAttribute('data-animations', s.animations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // 模态框动效开关（打开/关闭渐显渐隐）
  document.getElementById('setting-ui-modal-animations').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.modalAnimations = e.target.checked;
    document.documentElement.setAttribute('data-modal-animations', s.modalAnimations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // Color schemes
  async function updateColorSchemeVisibility() {
    const s = await window.api.getSettings();
    const isDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
    document.querySelectorAll('.scheme-btn').forEach(btn => {
      const bgColor = btn.dataset.bg;
      const btnIsDark = ThemeManager.isBackgroundDark(bgColor);
      // 只显示当前深浅色系的配色
      if (btnIsDark === isDark) {
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    });
  }

  document.querySelectorAll('.scheme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const accent = btn.dataset.accent;
      const bg = btn.dataset.bg;
      document.getElementById('setting-accent-color').value = accent;
      document.getElementById('setting-bg-color').value = bg;
      const s = await window.api.getSettings();
      s.theme.accentColor = accent;
      s.theme.backgroundColor = bg;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Password toggle
  document.querySelectorAll('.btn-toggle-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target.type === 'password') {
        target.type = 'text';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      } else {
        target.type = 'password';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      }
    });
  });

  // Auto-approve toggle
  document.getElementById('setting-auto-approve').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const confirmed = await window.api.confirmSensitive('开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。\n\n确定要开启吗？');
      if (!confirmed) {
        e.target.checked = false;
        return;
      }
    }
    const s = await window.api.getSettings();
    s.autoApproveSensitive = e.target.checked;
    await saveSettings(s);
  });

  // 隐私信息保护：总开关与过滤触发器
  function updatePrivacyTriggerState(enabled) {
    const item = document.getElementById('privacy-trigger-item');
    if (item) {
      item.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      item.style.opacity = enabled ? '' : '0.5';
    }
    const catItem = document.getElementById('privacy-categories-item');
    if (catItem) {
      catItem.querySelectorAll('input').forEach(inp => { inp.disabled = !enabled; });
      catItem.style.opacity = enabled ? '' : '0.5';
    }
  }

  async function savePrivacySettings() {
    const s = await window.api.getSettings();
    const categories = {};
    document.querySelectorAll('#privacy-categories-item input[data-cat]').forEach(inp => {
      categories[inp.dataset.cat] = inp.checked;
    });
    s.privacyProtection = {
      enabled: document.getElementById('setting-privacy-enabled').checked,
      filterResults: document.getElementById('setting-privacy-filter-results').checked,
      filterArgs: document.getElementById('setting-privacy-filter-args').checked,
      filterTerminal: document.getElementById('setting-privacy-filter-terminal').checked,
      filterAttachments: document.getElementById('setting-privacy-filter-attachments').checked,
      categories
    };
    await saveSettings(s);
  }

  document.getElementById('setting-privacy-enabled').addEventListener('change', (e) => {
    updatePrivacyTriggerState(e.target.checked);
    savePrivacySettings();
  });
  ['setting-privacy-filter-results', 'setting-privacy-filter-args', 'setting-privacy-filter-terminal'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => savePrivacySettings());
  });

  // 后台托盘：启用托盘图标
  document.getElementById('setting-tray-enabled')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      const r = await window.api.traySetEnabled(enabled);
      if (r && r.ok) {
        // 同步本地 settings 缓存
        try { agent.settings = r.settings; } catch {}
      } else {
        e.target.checked = !enabled; // 回滚
      }
    } catch (err) {
      console.error('[Tray] set enabled failed:', err);
      e.target.checked = !enabled;
    }
  });

  // 后台托盘：关闭窗口行为
  document.getElementById('setting-close-to-tray')?.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (!['ask', 'always', 'never'].includes(mode)) return;
    try {
      const r = await window.api.traySetCloseToTray(mode);
      if (r && r.ok) {
        try { agent.settings = r.settings; } catch {}
      }
    } catch (err) {
      console.error('[Tray] set closeToTray failed:', err);
    }
  });

  // 后台托盘：测试隐藏按钮
  document.getElementById('btn-tray-test-hide')?.addEventListener('click', () => {
    try { window.api.trayHideToTray(); } catch (err) {
      console.error('[Tray] test hide failed:', err);
    }
  });

  // Usage reset button
  document.getElementById('btn-reset-usage')?.addEventListener('click', async () => {
    const confirmed = await window.api.confirmSensitive('确定要重置每日使用量统计吗？\n\n这将清零今日的Token用量和图片生成数。');
    if (!confirmed) return;

    const s = await window.api.getSettings();
    s.llm.dailyTokensUsed = 0;
    s.llm.dailyTokenDate = '';
    s.imageGen.dailyImagesUsed = 0;
    s.imageGen.dailyImageDate = '';
    await saveSettings(s);

    // Refresh display
    document.getElementById('setting-llm-usage').textContent = '今日已用: 0';
    document.getElementById('setting-img-usage').textContent = '今日已用: 0';
    alert('使用量已重置');
  });

  // Firmware export button
  document.getElementById('btn-export-firmware')?.addEventListener('click', async () => {
    const result = await window.api.firmwareExport();
    if (result.ok) {
      showMessageModal(`固件源码已导出到：<br>${result.path}<br><br>请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。`, '导出成功', 'success');
      window.api.openFileExplorer(result.path);
    } else {
      showMessageModal(`导出失败：${result.error || '未知错误'}`, '导出失败', 'error');
    }
  });

  // Arduino download link
  document.querySelectorAll('.link-arduino-download').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openBrowser('https://www.arduino.cc/en/software');
    });
  });

  // ---- AI Persona Settings ----
  ['setting-ai-name', 'setting-ai-bio', 'setting-ai-pronouns', 'setting-ai-personality', 'setting-ai-custom-prompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-ai-name': 'name',
          'setting-ai-bio': 'bio',
          'setting-ai-pronouns': 'pronouns',
          'setting-ai-personality': 'personality',
          'setting-ai-custom-prompt': 'customPrompt',
        }[id];
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona[key] = el.value;
        await saveSettings(s);
        // Update agent system prompt
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        // Update display
        updatePersonaDisplay(s.aiPersona);
      });
    }
  });

  // 命运之牌可见性开关
  const tarotVisibleToggle = document.getElementById('setting-tarot-visible');
  if (tarotVisibleToggle) {
    tarotVisibleToggle.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      s.tarotVisible = tarotVisibleToggle.checked;
      await saveSettings(s);
      applyTarotVisibility(s.tarotVisible);
    });
  }

  // 通知开关 - 总开关 + 分类 + 测试按钮
  const notifyToggles = [
    { id: 'setting-notify-enabled', key: 'enabled' },
    { id: 'setting-notify-approval', key: 'approval' },
    { id: 'setting-notify-session-done', key: 'sessionDone' },
    { id: 'setting-notify-question', key: 'question' },
    { id: 'setting-notify-present', key: 'present' },
    { id: 'setting-notify-babe-proactive', key: 'babeProactive' },
    { id: 'setting-notify-update', key: 'updateAvailable' }
  ];
  notifyToggles.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.notifications) s.notifications = {};
      s.notifications[key] = el.checked;
      await saveSettings(s);
    });
  });
  const btnNotifyTest = document.getElementById('btn-notify-test');
  if (btnNotifyTest) {
    btnNotifyTest.addEventListener('click', async () => {
      try {
        const r = await window.api.sendNotification({
          title: 'CIBYP 测试通知',
          body: '如果您看到这条通知，说明系统通知工作正常。'
        });
        if (!r?.ok) {
          alert('通知发送失败：' + (r?.error || '未知原因'));
        }
      } catch (e) {
        alert('通知发送异常：' + e.message);
      }
    });
  }

  // ---- 更新检查（GitHub Releases）----
  const updAutoEl = document.getElementById('setting-updates-auto');
  updAutoEl?.addEventListener('change', async () => {
    const s = await window.api.getSettings();
    if (!s.updates) s.updates = {};
    s.updates.autoCheckEnabled = updAutoEl.checked;
    const r = await window.api.updatesSave({ autoCheckEnabled: updAutoEl.checked });
    if (r?.ok) s.updates = r.updates;
    await saveSettings(s);
  });
  const updIntervalEl = document.getElementById('setting-updates-interval');
  updIntervalEl?.addEventListener('change', async () => {
    const s = await window.api.getSettings();
    if (!s.updates) s.updates = {};
    s.updates.intervalHours = Number(updIntervalEl.value);
    const r = await window.api.updatesSave({ intervalHours: Number(updIntervalEl.value) });
    if (r?.ok) s.updates = r.updates;
    await saveSettings(s);
  });

  // 渲染更新检查结果区（lastResult 快照或本次手动检查结果）
  function renderUpdateCheckResult(upd, manual) {
    const wrap = document.getElementById('updates-result-wrap');
    const statusEl = document.getElementById('updates-check-status');
    const currentEl = document.getElementById('updates-current-version');
    const bodyEl = document.getElementById('updates-result-body');
    const last = upd?.lastResult;
    if (manual?.error) {
      if (statusEl) { statusEl.textContent = '检查失败：' + manual.error; statusEl.style.color = 'var(--danger, #e05252)'; }
      return;
    }
    if (!last && !manual) return;
    const latest = manual?.latest || last;
    const isNewer = manual ? !!manual.updateAvailable : (last?.updateAvailable === true);
    const curVersion = (manual?.current || '').replace(/^v/i, '');
    if (statusEl) {
      statusEl.textContent = isNewer ? '发现新版本！' : '已是最新版本';
      statusEl.style.color = 'var(--success, #4caf50)';
    }
    if (wrap) wrap.style.display = 'flex';
    if (currentEl) currentEl.textContent = '当前版本：' + curVersion + ' · 最新版本：' + (latest?.version || '').replace(/^v/i, '');
    if (bodyEl && latest) {
      const tag = (latest.tagName || '').replace(/^v/i, '');
      const body = latest.body || '(该版本未提供更新说明)';
      bodyEl.innerHTML = '';
      const h = document.createElement('div');
      h.style.marginBottom = '8px';
      h.innerHTML = `<strong>${escapeHtml(tag)}${latest.prerelease ? ' <span style="color:var(--warning,#e6a23c)">(pre-release)</span>' : ''}</strong><span style="color:var(--text-tertiary);font-size:11px"> · 发布于 ${escapeHtml((latest.publishedAt || '').slice(0, 10))}</span>`;
      const p = document.createElement('div');
      p.style.lineHeight = '1.6';
      p.innerHTML = renderMarkdown(body);
      bodyEl.appendChild(h);
      bodyEl.appendChild(p);
    }
  }

  const btnUpdatesCheck = document.getElementById('btn-updates-check');
  btnUpdatesCheck?.addEventListener('click', async () => {
    const statusEl = document.getElementById('updates-check-status');
    if (statusEl) { statusEl.textContent = '检查中…'; statusEl.style.color = 'var(--text-secondary)'; }
    try {
      const r = await window.api.updatesCheck();
      renderUpdateCheckResult({ lastResult: r?.ok ? { ...r.latest, updateAvailable: r.updateAvailable } : null }, r);
    } catch (e) {
      renderUpdateCheckResult({}, { error: e.message });
    }
  });
  const btnUpdatesOpenRelease = document.getElementById('btn-updates-open-release');
  btnUpdatesOpenRelease?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    const url = s.updates?.lastResult?.htmlUrl;
    await window.api.updatesOpenRelease(url);
  });

  // Language settings save button
  const btnSaveLanguage = document.getElementById('btn-save-language');
  if (btnSaveLanguage) {
    btnSaveLanguage.addEventListener('click', async () => {
      const langSelect = document.getElementById('setting-language');
      const lang = langSelect ? langSelect.value : 'zh-CN';
      const s = await window.api.getSettings();
      s.language = lang;
      await saveSettings(s);
      if (typeof i18nSetLanguage === 'function') {
        i18nSetLanguage(lang);
        i18nApplyToDOM();
      }
      // Update agent instances so system prompts use the new language
      if (typeof agent !== 'undefined' && agent && agent.settings) {
        agent.settings.language = lang;
        agent.contextManager?.setSystemPrompt(agent.getSystemPrompt());
      }
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) {
        codeAgent.settings.language = lang;
        codeAgent.contextManager?.setSystemPrompt(codeAgent.getSystemPrompt());
      }
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) {
        babeAgent.settings.language = lang;
        babeAgent.contextManager?.setSystemPrompt(babeAgent.getSystemPrompt());
      }
      window.showMessageModal?.(t('ui.language.saved', '语言设置已保存，部分文本将在下次启动后完全生效', {}), t('ui.language.notice', '提示', {}), 'info');
    });
  }

  // ---- Babe Mode Settings ----
  ['setting-babe-name', 'setting-babe-gender', 'setting-babe-age', 'setting-babe-personality', 'setting-babe-persona', 'setting-babe-user-nickname', 'setting-babe-proactive-interval', 'setting-babe-initial-affection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-babe-name': 'name',
          'setting-babe-gender': 'gender',
          'setting-babe-age': 'age',
          'setting-babe-personality': 'personality',
          'setting-babe-persona': 'persona',
          'setting-babe-user-nickname': 'userNickname',
          'setting-babe-proactive-interval': 'proactiveInterval',
          'setting-babe-initial-affection': 'initialAffection'
        }[id];
        const val = (id === 'setting-babe-proactive-interval' || id === 'setting-babe-initial-affection')
          ? parseInt(el.value, 10) || 0
          : el.value;
        const s = await window.api.getSettings();
        if (!s.babe) s.babe = {};
        s.babe[key] = val;
        await saveSettings(s);
        // 如果修改了初始好感度，且当前没有活跃 Babe 会话，更新 babeAgent 的好感度
        if (key === 'initialAffection' && babeAgent && !babeCurrentHistoryId) {
          babeAgent.babeAffection = val;
          updateBabeAffection(val);
        }
        // 主动消息频率变更时重启定时器
        if (key === 'proactiveInterval') {
          restartBabeProactiveTimer(val);
        }
      });
    }
  });

  // AI avatar file picker
  document.getElementById('btn-ai-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.aiPersona) s.aiPersona = {};
      s.aiPersona.avatar = result.dataUrl;
      await saveSettings(s);
      updateAvatarPreview(result.dataUrl);
      updatePersonaDisplay(s.aiPersona);
      window.api.webControlSetAvatars({ ai: result.dataUrl, user: s.userProfile?.avatar || '' });
    }
  });

  document.getElementById('btn-ai-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.aiPersona) s.aiPersona = {};
    s.aiPersona.avatar = '';
    await saveSettings(s);
    updateAvatarPreview('');
    updatePersonaDisplay(s.aiPersona);
    window.api.webControlSetAvatars({ ai: '', user: s.userProfile?.avatar || '' });
  });

  function updatePersonaDisplay(persona) {
    const nameEl = document.getElementById('agent-name-display');
    const avatarEl = document.getElementById('agent-avatar-display');
    if (nameEl && persona?.name) nameEl.textContent = persona.name;
    if (avatarEl) {
      const frameId = _avatarFrameState.ai;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制（140% 与 overlay 同尺寸对齐）
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:28px;height:28px;border-radius:50%;object-fit:cover';
      avatarEl.innerHTML = makeAvatarHTML(persona?.avatar, true, avatarSize);
      // Hero 头像框叠加
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
    }
  }

  // ---- User Profile Settings ----
  ['setting-user-name', 'setting-user-bio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = { 'setting-user-name': 'name', 'setting-user-bio': 'bio' }[id];
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile[key] = el.value;
        await saveSettings(s);
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      });
    }
  });

  document.getElementById('btn-user-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.userProfile) s.userProfile = {};
      s.userProfile.avatar = result.dataUrl;
      await saveSettings(s);
      updateUserAvatarPreview(result.dataUrl);
      window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: result.dataUrl });
    }
  });

  document.getElementById('btn-user-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.userProfile) s.userProfile = {};
    s.userProfile.avatar = '';
    await saveSettings(s);
    updateUserAvatarPreview('');
    window.api.webControlSetAvatars({ ai: s.aiPersona?.avatar || '', user: '' });
  });

  // ---- Babe Avatar Settings ----
  document.getElementById('btn-babe-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode();
    if (result.ok && result.dataUrl) {
      const s = await window.api.getSettings();
      if (!s.babe) s.babe = {};
      s.babe.avatar = result.dataUrl;
      await saveSettings(s);
      // 同步到 babeAgent.settings
      if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
      updateBabeAvatarPreview(result.dataUrl);
      updateBabePersonaDisplay(s.babe);
    }
  });

  document.getElementById('btn-babe-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.babe) s.babe = {};
    s.babe.avatar = '';
    await saveSettings(s);
    if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
    updateBabeAvatarPreview('');
    updateBabePersonaDisplay(s.babe);
  });

  // ---- Entropy Source Settings ----
  document.querySelectorAll('.entropy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const source = btn.dataset.source;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.source = source;
      await saveSettings(s);
      document.getElementById('entropy-trng-settings').style.display = source === 'trng' ? '' : 'none';
    });
  });

  document.querySelectorAll('.trng-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy.trngMode = mode;
      await saveSettings(s);
      document.getElementById('trng-network-settings').style.display = mode === 'network' ? '' : 'none';
      document.getElementById('trng-serial-settings').style.display = mode === 'serial' ? '' : 'none';
      if (mode === 'serial') {
        refreshTrngPorts(true);
      }
    });
  });

  ['setting-trng-host', 'setting-trng-port'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id === 'setting-trng-host' ? 'trngNetworkHost' : 'trngNetworkPort';
      const val = id === 'setting-trng-port' ? parseInt(e.target.value) : e.target.value;
      const s = await window.api.getSettings();
      if (!s.entropy) s.entropy = {};
      s.entropy[key] = val;
      await saveSettings(s);
    });
  });

  document.getElementById('setting-trng-serial-port')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialPort = e.target.value;
    await saveSettings(s);
  });
  document.getElementById('setting-trng-serial-baud')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.entropy) s.entropy = {};
    s.entropy.trngSerialBaud = parseInt(e.target.value);
    await saveSettings(s);
  });

  async function refreshTrngPorts(showStatus) {
    const result = await window.api.trngListPorts();
    const sel = document.getElementById('setting-trng-serial-port');
    const statusEl = document.getElementById('trng-port-status');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">选择串口...</option>';

    if (result.ok && Array.isArray(result.ports)) {
      result.ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} ${p.manufacturer || ''} ${p.serialNumber || ''}`.trim();
        sel.appendChild(opt);
      });
      if (current) sel.value = current;
      if (statusEl && showStatus) {
        statusEl.textContent = result.ports.length > 0 ? `发现 ${result.ports.length} 个串口` : '未检测到串口';
        statusEl.className = 'setting-hint';
      }
      sel.disabled = false;
      return;
    }

    const errMsg = result?.error || '串口列表获取失败';
    if (statusEl && showStatus) {
      statusEl.textContent = errMsg.includes('serialport') ? 'serialport 未安装，请先安装依赖' : `串口列表失败: ${errMsg}`;
      statusEl.className = 'setting-hint warning';
    }
    sel.disabled = true;
  }

  document.getElementById('btn-refresh-ports')?.addEventListener('click', async () => {
    refreshTrngPorts(true);
  });

  document.getElementById('btn-trng-test')?.addEventListener('click', async () => {
    const el = document.getElementById('trng-test-result');
    if (el) el.textContent = '正在测试...';
    const result = await window.api.trngTest();
    if (el) {
      if (result.ok) {
        const r = result.result;
        const _lang3 = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
        const _isZh3 = (_lang3 === 'zh-CN');
        el.textContent = `${_isZh3 ? '连接成功! 抽到: ' : 'Connected! Drew: '}${r.name}${r.orientation === 'reversed' ? ' (Reversed)' : ' (Upright)'} - ${r.entropySource}`;
        el.className = 'setting-hint success';
      } else {
        el.textContent = `连接失败: ${result.error}`;
        el.className = 'setting-hint warning';
      }
    }
  });

  // ---- Proxy Settings ----
  document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.proxy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy.mode = mode;
      await saveSettings(s);
      document.getElementById('manual-proxy-settings').style.display = mode === 'manual' ? '' : 'none';
      // 动态应用代理到 Electron session + aria2（无需重启）
      window.api.applyProxy(s.proxy).catch(() => {});
    });
  });

  ['setting-proxy-http', 'setting-proxy-https', 'setting-proxy-bypass'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', async (e) => {
      const key = id.replace('setting-proxy-', '');
      const s = await window.api.getSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy[key] = e.target.value;
      await saveSettings(s);
      // 动态应用代理到 Electron session + aria2（无需重启）
      window.api.applyProxy(s.proxy).catch(() => {});
    });
  });
