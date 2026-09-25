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
