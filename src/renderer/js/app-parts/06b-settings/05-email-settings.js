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
