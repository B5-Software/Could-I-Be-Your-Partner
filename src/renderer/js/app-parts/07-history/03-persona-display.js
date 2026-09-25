  // ---- Init AI Persona Display ----
  async function initPersonaDisplay() {
    const s = await window.api.getSettings();
    // i18n: initialize language from saved settings before any UI rendering
    if (typeof i18nInit === 'function') {
      i18nInit(s.language || 'zh-CN');
      i18nApplyToDOM();
      // Re-apply after a delay to catch dynamically rendered content
      setTimeout(() => i18nApplyToDOM(), 500);
      setTimeout(() => i18nApplyToDOM(), 1500);
    }
    // Update mode switcher labels based on language
    updateModeLabels(s.language || 'zh-CN');
    // 头像框系统：启动时加载 avatarFrame 状态并预加载 SVG 缓存
    if (s.aiPersona?.avatarFrame) {
      _avatarFrameState.ai = s.aiPersona.avatarFrame;
      await loadAvatarFrameSVG(s.aiPersona.avatarFrame);
    }
    if (s.userProfile?.avatarFrame) {
      _avatarFrameState.user = s.userProfile.avatarFrame;
      await loadAvatarFrameSVG(s.userProfile.avatarFrame);
    }
    if (s.babe?.avatarFrame) {
      _avatarFrameState.babe = s.babe.avatarFrame;
      await loadAvatarFrameSVG(s.babe.avatarFrame);
    }
    if (s.aiPersona) updatePersonaDisplay(s.aiPersona);
    // 启动时立即读取命运之牌可见性设置项并应用，避免未读设置导致 UI 不一致
    applyTarotVisibility(s.tarotVisible !== false);
    // 启动 Babe 主动消息定时器（即使用户未进入 Babe 模式，主动消息也应按时触发）
    restartBabeProactiveTimer(s.babe?.proactiveInterval);
  }

  // Update mode switcher button labels based on language
  function updateModeLabels(lang) {
    document.querySelectorAll('.mode-label').forEach(el => {
      const val = el.getAttribute('data-' + (lang || 'zh-CN')) || el.getAttribute('data-zh') || 'Chat';
      el.textContent = val;
    });
  }
