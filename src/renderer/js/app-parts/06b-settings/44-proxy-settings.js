  // ---- Proxy Settings ----
  function renderNetworkPrivacyStatus(state) {
    const progress = document.getElementById('privacy-tor-progress');
    const status = document.getElementById('privacy-tor-status');
    if (progress) progress.value = state.progress || 0;
    const labels = { stopped: t('ui.networkPrivacy.stopped', '未连接'), preparing: t('ui.networkPrivacy.preparing', '正在准备 Tor…'), connecting: t('ui.networkPrivacy.connecting', '正在连接 Tor…'), ready: t('ui.networkPrivacy.ready', 'Tor 已连接'), error: t('ui.networkPrivacy.error', 'Tor 连接失败') };
    if (status) status.textContent = (labels[state.phase] || state.phase || '') + (state.phase === 'connecting' ? ' ' + (state.progress || 0) + '%' : '') + (state.error ? ' · ' + state.error : '');
  }
  function loadNetworkPrivacySettings(settings) {
    const config = settings.networkPrivacy?.tor || {};
    for (const [id, key] of [['setting-privacy-tor-enabled','enabled'],['setting-privacy-tor-auto','autoStart'],['setting-privacy-tor-bridges-enabled','useBridges'],['setting-privacy-tor-bridges','bridges']]) {
      const control = document.getElementById(id);
      if (control?.type === 'checkbox') control.checked = !!config[key];
      else if (control) control.value = config[key] || '';
    }
    window.api.privacyTorStatus?.().then(renderNetworkPrivacyStatus).catch(() => {});
  }
  window.api.onPrivacyTorState?.(renderNetworkPrivacyStatus);
  for (const [id, key] of [['setting-privacy-tor-enabled','enabled'],['setting-privacy-tor-auto','autoStart'],['setting-privacy-tor-bridges-enabled','useBridges'],['setting-privacy-tor-bridges','bridges']]) {
    document.getElementById(id)?.addEventListener('change', async event => {
      try {
        const settings = await readSettings();
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        if (key === 'bridges' && value.trim()) TorBridges.parse(value);
        await saveSettings({ networkPrivacy: { tor: { ...settings.networkPrivacy?.tor, [key]: value } } });
        renderNetworkPrivacyStatus(await window.api.privacyTorStatus());
      } catch (error) { renderNetworkPrivacyStatus({ phase: 'error', error: error.message }); }
    });
  }
  for (const [id, method] of [['btn-privacy-tor-start','privacyTorStart'],['btn-privacy-tor-stop','privacyTorStop']]) document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { renderNetworkPrivacyStatus(await window.api[method]()); }
    catch (error) { renderNetworkPrivacyStatus({ phase: 'error', error: error.message }); }
    finally { button.disabled = false; }
  });
  document.getElementById('btn-privacy-tor-meek')?.addEventListener('click', async () => {
    try {
      const settings = await readSettings();
      await window.api.privacyTorStop();
      await saveSettings({ networkPrivacy: { tor: { ...settings.networkPrivacy?.tor, useBridges: true, bridges: TorBridges.DEFAULT_MEEK } } });
      loadNetworkPrivacySettings(await readSettings());
    } catch (error) { renderNetworkPrivacyStatus({ phase: 'error', error: error.message }); }
  });
  document.getElementById('setting-opencode-transport')?.addEventListener('change', async event => {
    await saveSettings({ llm: { opencodeTransport: event.target.value } });
    updateZenFreeNotice().catch(() => {});
  });
  document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.proxy-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      const s = await readSettings();
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
      const s = await readSettings();
      if (!s.proxy) s.proxy = {};
      s.proxy[key] = e.target.value;
      await saveSettings(s);
      // 动态应用代理到 Electron session + aria2（无需重启）
      window.api.applyProxy(s.proxy).catch(() => {});
    });
  });
