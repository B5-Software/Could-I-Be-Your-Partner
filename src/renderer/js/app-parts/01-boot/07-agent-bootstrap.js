  let agent = new Agent();

  // Skill 编辑器保存/创建/删除后，主窗口自动刷新目录和当前技能页。
  if (typeof window.api.onSkillsChanged === 'function') {
    window.api.onSkillsChanged(async () => {
      if (typeof agent.refreshSkillsCatalog === 'function') {
        try { await agent.refreshSkillsCatalog(); } catch { /* ignore */ }
      }
      if (agent.contextManager && typeof agent.getSystemPrompt === 'function') {
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      }
      const activePage = document.querySelector('.page.active');
      if (activePage && activePage.id === 'page-skills' && typeof loadSkillsPage === 'function') {
        loadSkillsPage();
      }
    });
  }
