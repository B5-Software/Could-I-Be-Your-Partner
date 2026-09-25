  // 语音设置入口默认隐藏（index.html hidden），仅在语音可用平台上显示。
  // 语音不可用平台（如 Windows ARM64，sherpa-onnx-node 无官方原生库）保持隐藏。
  if (window.api && window.api.voiceGetStatus) {
    window.api.voiceGetStatus()
      .then((s) => {
        if (s && s.supported !== false) {
          const vTab = document.querySelector('.settings-tab[data-tab="voice"]');
          const vPanel = document.querySelector('.settings-panel[data-tab="voice"]');
          if (vTab) vTab.hidden = false;
          if (vPanel) vPanel.hidden = false;
          // 必需模型未下载时锁定语音设置并提示前往「资源下载」
          if (typeof refreshVoiceGate === 'function') refreshVoiceGate().catch(() => {});
        }
      })
      .catch(() => {});
  }
  // 资源下载面板（语音模型）：初始化事件绑定
  if (typeof initResourceDownloads === 'function') {
    try { initResourceDownloads(); } catch (_) {}
  }

  function activateSettingsTabCore(btn) {
    if (!btn || !btn.dataset || !btn.dataset.tab) return;
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.querySelector(`.settings-panel[data-tab="${btn.dataset.tab}"]`);
    if (panel) panel.classList.add('active');
    // Lazy-load usage stats when the tab is opened
    if (btn.dataset.tab === 'usage') {
      const activePeriod = document.querySelector('.usage-period-btn.active');
      loadUsageStats(activePeriod ? activePeriod.dataset.period : 'daily');
    }
    if (btn.dataset.tab === 'environment') refreshEnvironmentPanel();
    if (btn.dataset.tab === 'resources' && typeof refreshResourcePanel === 'function') {
      refreshResourcePanel().catch(() => {});
    }
    if (btn.dataset.tab === 'runtime' && typeof refreshVmSettings === 'function') {
      refreshVmSettings().catch(() => {});
    }
    if (btn.dataset.tab === 'decision' && typeof refreshDecisionStatus === 'function') {
      refreshDecisionStatus().catch(() => {});
    }
    if (btn.dataset.tab === 'llm' && typeof refreshPoolUI === 'function') {
      refreshPoolUI().catch(() => {});
    }
    if (btn.dataset.tab === 'voice' && typeof refreshVoiceGate === 'function') {
      refreshVoiceGate().catch(() => {});
    }
    // 推送设置选项卡和面板的 active 状态到 WebUI/Remote
    document.querySelectorAll('.settings-tab').forEach(b => {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-tab[data-tab="' + b.dataset.tab + '"]', attr: 'class', value: b.className });
    });
    document.querySelectorAll('.settings-panel').forEach(p => {
      if (p.dataset.tab) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '.settings-panel[data-tab="' + p.dataset.tab + '"]', attr: 'class', value: p.className });
    });
  }

  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => activateSettingsTabCore(btn));
  });

  // 供 /config、语音页跳转等复用；按 id 激活并触发懒加载
  window.activateSettingsTab = (tabId) => {
    const btn = document.querySelector(`.settings-tab[data-tab="${tabId}"]`);
    if (!btn || btn.hidden || btn.style.display === 'none') return false;
    activateSettingsTabCore(btn);
    return true;
  };

  // 初始高亮：HTML 只有面板带 active，补上对应 tab 高亮
  try {
    if (!document.querySelector('.settings-tab.active')) {
      const activePanel = document.querySelector('.settings-panel.active[data-tab]');
      const initial = (activePanel && document.querySelector(`.settings-tab[data-tab="${activePanel.dataset.tab}"]`))
        || document.querySelector('.settings-tab:not([hidden])');
      if (initial) initial.classList.add('active');
    }
  } catch { /* ignore */ }
