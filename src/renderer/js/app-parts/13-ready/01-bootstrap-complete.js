  // Every page and mode is initialized before settings notifications and UI work run.
  await normalizeToolSettings();
  setTitlebarTitle(agent.conversationTitle || '未命名对话');
  updateReoptimizeButtonVisibility();
  updateContextProgress();
  renderAllSessionTabs();
  showSessionTabsForMode(currentMode);

  // Wait for a painted frame before revealing the main window.
  if (typeof window.api.rendererReady === 'function') {
    await document.fonts.ready;
    requestAnimationFrame(() => requestAnimationFrame(() => window.api.rendererReady()));
  }
