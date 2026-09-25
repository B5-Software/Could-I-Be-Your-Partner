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
