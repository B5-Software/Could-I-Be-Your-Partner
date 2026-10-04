  var terminalSettingsTarget = null;
  var terminalShellPending = Promise.resolve();
  function showTerminalShellStatus(text, error = false) {
    const status = document.getElementById('terminal-shell-status');
    status.textContent = text;
    status.dataset.state = error ? 'error' : 'saved';
    window.i18nApplyTextMap?.(status);
  }
  function saveTerminalShell(patch) {
    return terminalShellPending = saveSettings({ terminal: terminalSettingsTarget === 'vm' ? { vm: patch } : patch });
  }
  async function loadTerminalSettings() {
    const s = await readSettings();
    const t = s.terminal || {};
    const abortSel = document.getElementById('setting-terminal-abortstrategy');
    const shellSel = document.getElementById('setting-terminal-shell');
    const customRow = document.getElementById('terminal-custom-shell-row');
    const customInput = document.getElementById('setting-terminal-custom-path');
    const sessionsMax = document.getElementById('setting-sessions-max');
    if (abortSel) abortSel.value = t.abortStrategy || 'kill';
    terminalSettingsTarget ||= s.runtime?.location === 'vm' ? 'vm' : 'host';
    document.getElementById('setting-terminal-target').value = terminalSettingsTarget;
    const config = terminalSettingsTarget === 'vm' ? t.vm || {} : t;
    if (shellSel) shellSel.value = config.shell || 'auto';
    if (customInput) customInput.value = config.customShellPath || '';
    document.getElementById('setting-terminal-args').value = JSON.stringify(config.args || []);
    for (const option of shellSel.options) {
      option.disabled = terminalSettingsTarget === 'vm' || window.api.platform !== 'win32'
        ? ['cmd', 'powershell'].includes(option.value) : false;
    }
    if (customRow) customRow.style.display = (shellSel && shellSel.value === 'custom') ? '' : 'none';
    if (sessionsMax) sessionsMax.value = String(Math.max(1, Number(s.sessions?.maxConcurrent) || 10));
  }
  document.getElementById('setting-terminal-abortstrategy')?.addEventListener('change', async (e) => {
    await saveSettings({ terminal: { abortStrategy: e.target.value } });
    window.showToast?.('终端策略已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-shell')?.addEventListener('change', async (e) => {
    const patch = { shell: e.target.value };
    // 自定义路径输入框的显隐
    const customRow = document.getElementById('terminal-custom-shell-row');
    if (customRow) customRow.style.display = e.target.value === 'custom' ? '' : 'none';
    await saveTerminalShell(patch);
    showTerminalShellStatus('Shell 设置已保存，新建终端时生效');
  });
  document.getElementById('setting-terminal-custom-path')?.addEventListener('change', async (e) => {
    await saveTerminalShell({ customShellPath: (e.target.value || '').trim() });
    showTerminalShellStatus('Shell 设置已保存，新建终端时生效');
  });
  document.getElementById('setting-terminal-target').addEventListener('change', async e => {
    terminalSettingsTarget = e.target.value;
    showTerminalShellStatus('');
    await terminalShellPending.catch(() => {});
    await loadTerminalSettings();
  });
  document.getElementById('setting-terminal-args').addEventListener('change', async e => {
    try {
      const args = JSON.parse(e.target.value.trim() || '[]');
      if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('请填写最多 32 个字符串的 JSON 数组');
      e.target.removeAttribute('aria-invalid');
      await saveTerminalShell({ args });
      showTerminalShellStatus('Shell 设置已保存，新建终端时生效');
    } catch (error) {
      e.target.setAttribute('aria-invalid', 'true');
      showTerminalShellStatus(error.message, true);
    }
  });
  document.getElementById('btn-terminal-pick-shell').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const location = terminalSettingsTarget;
    try {
      const result = await window.api.terminalPickShell(location);
      if (!result.ok) throw new Error(result.error);
      if (result.canceled || !result.file) return;
      await (terminalShellPending = saveSettings({ terminal: location === 'vm' ? { vm: { shell: 'custom', customShellPath: result.file } } : { shell: 'custom', customShellPath: result.file } }));
      if (terminalSettingsTarget === location) await loadTerminalSettings();
      showTerminalShellStatus('Shell 设置已保存，新建终端时生效');
    } catch (error) { showTerminalShellStatus(error.message, true); }
    finally { document.getElementById('btn-terminal-pick-shell').disabled = false; }
  });
  document.getElementById('btn-terminal-check-shell').addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const location = terminalSettingsTarget;
    showTerminalShellStatus('正在检测 Shell…');
    try {
      await terminalShellPending;
      const result = await window.api.terminalShellInfo(location);
      if (location !== terminalSettingsTarget) return;
      if (!result.ok) throw new Error(result.error);
      showTerminalShellStatus(result.file + (result.args.length ? ' ' + JSON.stringify(result.args) : ''));
    } catch (error) { if (location === terminalSettingsTarget) showTerminalShellStatus(error.message, true); }
    finally { document.getElementById('btn-terminal-check-shell').disabled = false; }
  });
  document.getElementById('setting-sessions-max')?.addEventListener('change', async (e) => {
    const value = Math.max(1, Math.min(50, Number(e.target.value) || 10));
    await saveSettings({ sessions: { maxConcurrent: value } });
    if (sessionManager) sessionManager.maxConcurrent = value;
    e.target.value = String(value);
    window.showToast?.('最大并发会话数已保存', 'success', 2000);
  });
  loadTerminalSettings();
