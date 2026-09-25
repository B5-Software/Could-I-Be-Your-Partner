  async function loadTerminalSettings() {
    const s = await window.api.getSettings();
    const t = s.terminal || {};
    const abortSel = document.getElementById('setting-terminal-abortstrategy');
    const shellSel = document.getElementById('setting-terminal-shell');
    const customRow = document.getElementById('terminal-custom-shell-row');
    const customInput = document.getElementById('setting-terminal-custom-path');
    const sessionsMax = document.getElementById('setting-sessions-max');
    if (abortSel) abortSel.value = t.abortStrategy || 'kill';
    if (shellSel) shellSel.value = t.shell || 'auto';
    if (customInput) customInput.value = t.customShellPath || '';
    if (customRow) customRow.style.display = (shellSel && shellSel.value === 'custom') ? '' : 'none';
    if (sessionsMax) sessionsMax.value = String(Math.max(1, Number(s.sessions?.maxConcurrent) || 10));
  }
  document.getElementById('setting-terminal-abortstrategy')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.abortStrategy = e.target.value;
    await saveSettings(s);
    window.showToast?.('终端策略已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-shell')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.shell = e.target.value;
    await saveSettings(s);
    // 自定义路径输入框的显隐
    const customRow = document.getElementById('terminal-custom-shell-row');
    if (customRow) customRow.style.display = e.target.value === 'custom' ? '' : 'none';
    window.showToast?.('Shell 设置已保存', 'success', 2000);
  });
  document.getElementById('setting-terminal-custom-path')?.addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    if (!s.terminal) s.terminal = {};
    s.terminal.customShellPath = (e.target.value || '').trim();
    await saveSettings(s);
  });
  document.getElementById('setting-sessions-max')?.addEventListener('change', async (e) => {
    const value = Math.max(1, Math.min(50, Number(e.target.value) || 10));
    const s = await window.api.getSettings();
    if (!s.sessions) s.sessions = {};
    s.sessions.maxConcurrent = value;
    await saveSettings(s);
    if (sessionManager) sessionManager.maxConcurrent = value;
    e.target.value = String(value);
    window.showToast?.('最大并发会话数已保存', 'success', 2000);
  });
  loadTerminalSettings();
