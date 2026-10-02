  let agent = new Agent();

  function allLiveAgents() {
    return [...new Set([agent, ...(window.__sessionManager?.list() || []).map(session => session.agent)])];
  }
  let settingsRefresh = 0;
  window.api.onSettingsChanged?.(async () => {
    const revision = ++settingsRefresh;
    const settings = await window.api.getSettings();
    if (revision !== settingsRefresh) return;
    const previousAppearance = JSON.stringify([agent.settings?.aiPersona, agent.settings?.userProfile, agent.settings?.babe?.avatarFrame]);
    for (const live of allLiveAgents()) live.applySettings(settings);
    if (previousAppearance !== JSON.stringify([settings.aiPersona, settings.userProfile, settings.babe?.avatarFrame])) {
      await initPersonaDisplay();
      refreshCodeAvatars();
    }
    window.refreshSettingsOverview?.(settings);
    window.refreshTokenSettings?.(settings);
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
