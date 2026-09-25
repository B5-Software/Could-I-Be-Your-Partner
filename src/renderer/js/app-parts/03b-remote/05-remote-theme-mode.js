  function applyRemoteTheme(t) {
    if (!t) return;
    const root = document.documentElement;
    if (t.accent) root.style.setProperty('--accent', t.accent);
    if (t.accentLight) root.style.setProperty('--accent-light', t.accentLight);
    if (t.accentDark) root.style.setProperty('--accent-dark', t.accentDark);
    if (t.accentBg) {
      root.style.setProperty('--accent-bg', t.accentBg);
      root.style.setProperty('--accent-bg-hover', t.accentBg.replace('0.08', '0.14'));
    }
    if (t.bgPrimary) root.style.setProperty('--bg-primary', t.bgPrimary);
    if (t.bgSecondary) root.style.setProperty('--bg-secondary', t.bgSecondary);
    if (t.bgTertiary) root.style.setProperty('--bg-tertiary', t.bgTertiary);
    if (t.bgHover) root.style.setProperty('--bg-hover', t.bgHover);
    if (typeof t.isDark === 'boolean') {
      root.setAttribute('data-theme', t.isDark ? 'dark' : 'light');
    }
  }

  // 远端模式切换：仅同步按钮高亮，不导航、不回推，避免循环
  function handleRemoteModeSwitch(mode) {
    if (!mode || mode === currentMode) return;
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const nameEl = document.getElementById('agent-name-display');
    if (nameEl) {
      if (mode === 'code') nameEl.textContent = 'Coding Agent';
      else if (mode === 'babe') nameEl.textContent = 'Babe';
      else nameEl.textContent = 'AI Agent';
    }
  }

  function updateRemoteContextProgress(d) {
    if (!d) return;
    const fill = document.getElementById('context-progress-fill');
    const text = document.getElementById('context-progress-text');
    const ind = document.getElementById('chat-context-indicator');
    const pct = Math.min(100, Math.max(0, d.percentage || 0));
    const circumference = 100;
    const dashLen = (pct / 100) * circumference;
    if (fill) fill.setAttribute('stroke-dasharray', `${dashLen} ${circumference}`);
    if (text) {
      const used = d.used || 0, max = d.max || 8192;
      const fmt = (n) => fmtTokenCount(n);
      text.textContent = `${fmt(used)}/${fmt(max)}`;
    }
    if (ind) {
      if (d.used != null) ind.dataset.used = d.used;
      if (d.max != null) ind.dataset.max = d.max;
      if (pct >= 85) ind.dataset.level = 'danger';
      else if (pct >= 65) ind.dataset.level = 'warn';
      else ind.dataset.level = 'normal';
      ind.title = `上下文使用量: ${d.used || 0}/${d.max || 8192} (${Math.round(pct)}%)`;
    }
  }

  function hideApprovalPanelRemote() {
    if (approvalPanel) approvalPanel.classList.add('hidden');
  }
