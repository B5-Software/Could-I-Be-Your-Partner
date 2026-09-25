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
  const updChannelEl = document.getElementById('setting-updates-channel');
  updChannelEl?.addEventListener('change', async () => {
    const channel = updChannelEl.value === 'all' ? 'all' : 'stable';
    const s = await window.api.getSettings();
    if (!s.updates) s.updates = {};
    s.updates.channel = channel;
    const r = await window.api.updatesSave({ channel });
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
