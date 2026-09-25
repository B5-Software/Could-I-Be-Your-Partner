  // ---- Tools Page ----
  function renderToolsStats(mode) {
    mode = mode || codeEditorModeFilter || 'chat';
    const isEnabled = (name) => (typeof isToolEnabledForSettings === 'function'
      ? isToolEnabledForSettings(name, agent.settings)
      : (agent.settings.tools || {})[name] !== false);
    // 配置门控工具（生图/决策）未配置时直接不展示
    const allDefs = typeof filterToolDefsByConfig === 'function'
      ? filterToolDefsByConfig(getAllToolDefinitions(mode), agent.settings)
      : getAllToolDefinitions(mode);
    const total = allDefs.length;
    const enabledCount = allDefs.filter(t => isEnabled(t.name)).length;
    const enabledSchemas = getToolSchemas(Object.fromEntries(allDefs.filter(t => isEnabled(t.name)).map(t => [t.name, true])), mode);
    const schemaChars = JSON.stringify(enabledSchemas).length;
    const estTokens = Math.ceil(schemaChars / 4);
    const hasOptimized = (typeof agent.hasUsableOptimizedSelection === 'function')
      ? agent.hasUsableOptimizedSelection()
      : Array.isArray(agent.optimizedToolNames);
    const activeTools = (typeof agent.getActiveToolNames === 'function') ? agent.getActiveToolNames() : allDefs.filter(t => isEnabled(t.name)).map(t => t.name);
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
