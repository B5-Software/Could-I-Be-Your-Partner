  // WebUI is a frontend of the shared backend, independent of GUI lifetime.
  let wcEventsSetup = false;
  function wcMessage(message, error = false) {
    const el = document.getElementById('wc-status-result');
    if (el) { el.textContent = message; el.style.color = error ? 'var(--error-color)' : 'var(--text-secondary)'; }
  }
  async function updateWcToggleButton() {
    const current = await readSettings();
    const tor = current.remote?.tor || {};
    for (const [id,key] of [['setting-tor-auto','autoStart'],['setting-tor-bridges-enabled','useBridges']]) { const el = document.getElementById(id); if (el) el.checked = !!tor[key]; }
    const bridges = document.getElementById('setting-tor-bridges'); if (bridges && document.activeElement !== bridges) bridges.value = tor.bridges || '';
    window.api.remoteTorStatus().then(renderTorStatus).catch(console.error);
    const btn = document.getElementById('btn-wc-toggle');
    if (!btn) return;
    try {
      const status = await window.api.webControlGetStatus();
      btn.innerHTML = status.running ? '<i class="fa-solid fa-stop"></i> ' + t('ui.webui.stop', '停止 WebUI') : '<i class="fa-solid fa-play"></i> ' + t('ui.webui.start', '启动 WebUI');
      btn.classList.toggle('btn-danger', status.running);
      btn.classList.toggle('btn-primary', !status.running);
      wcMessage(status.running ? t('ui.webui.running', '运行中：{url}', { url: (status.addresses || [status.url]).join(' · ') }) : t('ui.webui.stopped', 'WebUI 未启动；后台会话仍可继续运行'));
      const detail = document.getElementById('wc-backend-status');
      if (detail) detail.textContent = t('ui.webui.backendStatus', '后台 PID {pid} · {clients} 个浏览器 / Remote 连接', { pid: status.backendPid, clients: status.clients || 0 });
    } catch (error) { wcMessage(error.message, true); }
  }
  async function saveWebControlSettings() {
    const s = await readSettings();
    const passwordInput = document.getElementById('setting-wc-password');
    let passwordHash = s.webControl?.passwordHash || '';
    if (passwordInput?.value) {
      const result = await window.api.webControlHashPassword(passwordInput.value);
      if (!result.ok) throw new Error(result.error || t('ui.webui.passwordFailed', '密码保存失败'));
      passwordHash = result.hash;
    }
    const port = Number(document.getElementById('setting-wc-port')?.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(t('ui.webui.invalidPort', '端口必须为 1024–65535 的整数'));
    const enable2FA = !!document.getElementById('setting-wc-enable-2fa')?.checked;
    if (enable2FA && !s.webControl?.totpSecret) throw new Error(t('ui.webui.needTotp', '请先生成并验证 TOTP 密钥'));
    s.webControl = { ...s.webControl,
      enabled: !!document.getElementById('setting-wc-enabled')?.checked,
      autoStartOnOpen: !!document.getElementById('setting-wc-autostart')?.checked,
      host: document.getElementById('setting-wc-host')?.value || '127.0.0.1', port,
      password: '', passwordHash, enable2FA,
    };
    const useBridges = !!document.getElementById('setting-tor-bridges-enabled')?.checked;
    const bridgeText = document.getElementById('setting-tor-bridges')?.value || '';
    const bridges = useBridges ? TorBridges.parse(bridgeText).map(b => b.line).join('\n') : bridgeText;
    s.remote = { ...s.remote, tor: { ...s.remote?.tor, useBridges, bridges,
      autoStart: !!document.getElementById('setting-tor-auto')?.checked } };
    await saveSettings(s);
    if (passwordInput) passwordInput.value = '';
    const result = await window.api.webControlReconfigure();
    if (result?.ok === false) throw new Error(result.error);
  }
  function setupWebControlEvents() {
    if (wcEventsSetup) return;
    wcEventsSetup = true;
    window.api.onRemoteTorState(renderTorStatus);
    for (const [id,key] of [['setting-tor-auto','autoStart'],['setting-tor-bridges-enabled','useBridges'],['setting-tor-bridges','bridges']]) {
      document.getElementById(id)?.addEventListener('change', async e => {
        const settings = await readSettings(); const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        await saveSettings({ ...settings, remote: { ...settings.remote, tor: { ...settings.remote?.tor, [key]: value } } });
      });
    }
    document.getElementById('btn-tor-start')?.addEventListener('click', async () => {
      try { await saveWebControlSettings(); renderTorStatus(await window.api.remoteTorStart()); } catch (e) { wcMessage(e.message,true); }
    });
    document.getElementById('btn-tor-stop')?.addEventListener('click', async () => renderTorStatus(await window.api.remoteTorStop()));
    document.getElementById('btn-tor-bridges')?.addEventListener('click', () => window.api.updatesOpenRelease('https://bridges.torproject.org/'));
    document.getElementById('btn-tor-meek')?.addEventListener('click', async e => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const settings = await readSettings();
        await saveSettings({ ...settings, remote: { ...settings.remote, tor: { ...settings.remote?.tor, useBridges: true, bridges: TorBridges.DEFAULT_MEEK } } });
        document.getElementById('setting-tor-bridges-enabled').checked = true;
        document.getElementById('setting-tor-bridges').value = TorBridges.DEFAULT_MEEK;
        renderTorStatus(await window.api.remoteTorStop());
        wcMessage(t('ui.tor.meekSelected', '已应用 meek 网桥，点击“连接 Tor”启动'));
      } catch (error) { wcMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    const run = async (button, action) => {
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      wcMessage(t('ui.webui.applying', '正在应用…'));
      try { await action(); await updateWcToggleButton(); }
      catch (error) { wcMessage(error.message, true); }
      finally { button.disabled = false; button.removeAttribute('aria-busy'); }
    };
    document.getElementById('setting-wc-enable-2fa')?.addEventListener('change', e => {
      document.getElementById('wc-2fa-area').style.display = e.target.checked ? '' : 'none';
    });
    document.getElementById('btn-wc-gen-totp')?.addEventListener('click', e => run(e.currentTarget, async () => {
      const result = await window.api.webControlGenerateTOTP();
      if (!result.ok) throw new Error(result.error);
      document.getElementById('wc-totp-qr-area').style.display = '';
      document.getElementById('wc-totp-qr-img').src = result.qrDataUrl;
      document.getElementById('wc-totp-secret-text').textContent = result.secret;
      const s = await readSettings(); s.webControl = { ...s.webControl, totpSecret: result.secret };
      await saveSettings(s);
    }));
    document.getElementById('btn-wc-verify-totp')?.addEventListener('click', e => run(e.currentTarget, async () => {
      const result = await window.api.webControlVerifyTOTP(document.getElementById('wc-totp-verify-code').value.trim());
      document.getElementById('wc-totp-verify-result').textContent = result.valid ? t('ui.webui.verified', '验证通过') : t('ui.webui.invalidCode', '验证码不正确');
    }));
    document.getElementById('btn-wc-save')?.addEventListener('click', e => run(e.currentTarget, saveWebControlSettings));
    document.getElementById('btn-wc-refresh')?.addEventListener('click', () => updateWcToggleButton());
    document.getElementById('btn-wc-toggle')?.addEventListener('click', e => run(e.currentTarget, async () => {
      const status = await window.api.webControlGetStatus();
      if (!status.running) await saveWebControlSettings();
      const result = status.running ? await window.api.webControlStop() : await window.api.webControlStart();
      if (!result.ok) throw new Error(result.error);
    }));
  }

  // ── Playwright Settings ──
  function renderTorStatus(state) {
    const labels = { stopped: t('ui.tor.stopped','Tor 未连接'), preparing: t('ui.tor.preparing','正在准备 Tor'), connecting: t('ui.tor.connecting','正在连接 Tor'), ready: t('ui.tor.ready','Tor 已连接'), error: t('ui.tor.error','Tor 连接失败') };
    const status = document.getElementById('tor-status'); if (status) status.textContent = (labels[state.phase] || state.phase) + (state.error ? ': ' + state.error : state.phase === 'connecting' ? ` ${state.progress}%` : '');
    const progress = document.getElementById('tor-progress'); if (progress) progress.value = state.progress || 0;
    const address = document.getElementById('tor-onion-address'); if (address) address.value = state.onion || '';
    const start = document.getElementById('btn-tor-start'); if (start) start.disabled = ['preparing','connecting','ready'].includes(state.phase);
  }
