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
