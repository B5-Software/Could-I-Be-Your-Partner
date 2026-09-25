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
