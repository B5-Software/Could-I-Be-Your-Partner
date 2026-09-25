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
            <button class="btn-secondary btn-sm" data-plugin-update="${escapeHtml(p.id)}" title="更新"><i class="fa-solid fa-rotate"></i></button>
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
    listEl.querySelectorAll('[data-plugin-update]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const plugin = plugins.find(p => p.id === btn.dataset.pluginUpdate);
        if (!plugin) return;
        const isLocal = plugin.source?.type === 'local';
        let ref = null;
        if (isLocal) {
          // 本地安装：更新需选择一个新目录（或原来的目录）
          const pick = await window.api.openFileDialog({ directory: true, title: `选择 ${plugin.name} 的插件目录` });
          if (!pick || !pick.ok || !Array.isArray(pick.paths) || !pick.paths.length) return;
          ref = pick.paths[0];
        }
        const confirmText = isLocal
          ? `更新本地插件 ${plugin.name}？将从所选目录重新复制安装。`
          : `更新插件 ${plugin.name}？将从 ${(plugin.source?.type || '来源').toUpperCase()} 重新安装。`;
        if (!await window.confirmDialog(confirmText, '更新插件')) return;

        const statusEl = document.getElementById('plugin-install-status');
        if (statusEl) statusEl.textContent = `正在更新 ${plugin.name}…`;
        let offProgress = null;
        if (typeof window.api.onPluginsInstallProgress === 'function') {
          offProgress = window.api.onPluginsInstallProgress((p) => {
            if (!statusEl || !p) return;
            statusEl.textContent = `更新中… ${String(p.line || p.stage || '').slice(-140)}`;
          });
        }
        let r;
        try {
          r = await window.api.dsUpdatePlugin(plugin.id, ref);
        } catch (e) {
          r = { ok: false, error: e.message };
        } finally {
          if (typeof offProgress === 'function') { try { offProgress(); } catch { /* ignore */ } }
        }
        if (statusEl) {
          statusEl.textContent = (r && r.ok)
            ? `✅ 已更新 ${(r.plugin && r.plugin.name) || plugin.name} 到 v${(r.plugin && r.plugin.version) || ''}`
            : `❌ ${(r && r.error) || '更新失败'}`;
        }
        await renderPluginsList();
        await refreshDsPluginTools();
      });
    });
  }
