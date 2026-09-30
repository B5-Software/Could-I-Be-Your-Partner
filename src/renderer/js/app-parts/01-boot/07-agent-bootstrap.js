  let agent = new Agent();

  function allLiveAgents() {
    return [...new Set([agent, ...(window.__sessionManager?.list() || []).map(session => session.agent)])];
  }
  let settingsRefresh = 0;
  window.api.onSettingsChanged?.(async () => {
    const revision = ++settingsRefresh;
    const settings = await window.api.getSettings();
    if (revision !== settingsRefresh) return;
    for (const live of allLiveAgents()) live.applySettings(settings);
  });

  // Skill 编辑器保存/创建/删除后，主窗口自动刷新目录和当前技能页。
  if (typeof window.api.onSkillsChanged === 'function') {
    window.api.onSkillsChanged(async () => {
      await Promise.allSettled(allLiveAgents().map(async live => {
        await live.refreshSkillsCatalog();
        live.contextManager.setSystemPrompt(live.getSystemPrompt());
      }));
      const activePage = document.querySelector('.page.active');
      if (activePage && activePage.id === 'page-skills' && typeof loadSkillsPage === 'function') {
        loadSkillsPage();
      }
    });
  }
