  // ---- 标签栏常驻兜底 ----
  // 无论是什么原因把标签栏隐藏/清空（远端镜像替换、页面切换竞态等），
  // 都自动恢复为可见并渲染当前会话。Remote 模式跳过（DOM 由远端驱动）。
  let _sessionTabsRepairPending = false;
  function repairSessionTabs() {
    if (_sessionTabsRepairPending) return;
    _sessionTabsRepairPending = true;
    requestAnimationFrame(() => {
      _sessionTabsRepairPending = false;
      if (typeof isRemoteMode !== 'undefined' && isRemoteMode) return;
      let host = document.getElementById('session-tabs-host');
      if (!host) {
        // 极端情况：宿主节点被整块移除 → 原地重建（含三根栏）
        const mc = document.getElementById('main-content');
        if (mc) {
          host = document.createElement('div');
          host.id = 'session-tabs-host';
          for (const m of ['chat', 'code', 'babe']) {
            const el = document.createElement('div');
            el.className = 'session-tabs';
            el.id = `${m}-session-tabs`;
            el.dataset.mode = m;
            host.appendChild(el);
          }
          mc.insertBefore(host, mc.firstChild);
        }
      }
      if (!host) return;
      showSessionTabsForMode(currentMode);
      if (host.classList.contains('hidden')) host.classList.remove('hidden');
      for (const mode of ['chat', 'code', 'babe']) {
        const el = document.getElementById(`${mode}-session-tabs`);
        if (!el) continue;
        const want = sessionManager ? sessionManager.list(mode).length : 0;
        const have = el.querySelectorAll('.session-tab').length;
        const hasAdd = !!el.querySelector('.session-tab-add');
        if (want !== have || !hasAdd) {
          try { renderSessionTabs(mode); } catch { /* ignore */ }
        }
      }
    });
  }
  if (typeof MutationObserver === 'function') {
    const _sessionTabsObserver = new MutationObserver(repairSessionTabs);
    _sessionTabsObserver.observe(document.getElementById('main-content') || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
  // 周期看门狗：无论什么原因（异常清空、替换、竞态）都每 1.5s 自愈一次
  setInterval(() => {
    try { repairSessionTabs(); } catch { /* ignore */ }
  }, 1500);
