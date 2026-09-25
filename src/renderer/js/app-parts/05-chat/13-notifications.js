  // ---- 系统通知辅助 ----
  // 根据设置过滤通知；category: 'approval' | 'sessionDone' | 'question' | 'present'
  // 仅当窗口失焦或被最小化/隐藏时才发送（避免在用户正盯着界面时打扰）
  async function sendAppNotification(category, title, body, force = false, extra = {}) {
    try {
      if (!window.api?.sendNotification) return;
      const s = await window.api.getSettings();
      const n = s.notifications || {};
      // 默认开启：未设置时视为 true
      if (n.enabled === false) return;
      if (n[category] === false) return;
      // 仅在窗口非聚焦或不可见时打扰用户
      const isFocused = document.hasFocus();
      const isHidden = document.visibilityState === 'hidden';
      if (!force && isFocused && !isHidden) return;
      await window.api.sendNotification({ title, body, category, ...(extra || {}) });
    } catch (e) {
      console.warn('[App] sendAppNotification failed:', e?.message || e);
    }
  }
