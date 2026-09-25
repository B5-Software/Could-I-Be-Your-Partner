  // ---- AI Persona Settings ----
  ['setting-ai-name', 'setting-ai-bio', 'setting-ai-pronouns', 'setting-ai-personality', 'setting-ai-custom-prompt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-ai-name': 'name',
          'setting-ai-bio': 'bio',
          'setting-ai-pronouns': 'pronouns',
          'setting-ai-personality': 'personality',
          'setting-ai-custom-prompt': 'customPrompt',
        }[id];
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona[key] = el.value;
        await saveSettings(s);
        // Update agent system prompt
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
        // Update display
        updatePersonaDisplay(s.aiPersona);
      });
    }
  });

  // 命运之牌可见性开关
  const tarotVisibleToggle = document.getElementById('setting-tarot-visible');
  if (tarotVisibleToggle) {
    tarotVisibleToggle.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      s.tarotVisible = tarotVisibleToggle.checked;
      await saveSettings(s);
      applyTarotVisibility(s.tarotVisible);
    });
  }

  // 通知开关 - 总开关 + 分类 + 测试按钮
