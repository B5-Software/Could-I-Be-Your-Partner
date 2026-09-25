  const btnSaveLanguage = document.getElementById('btn-save-language');
  if (btnSaveLanguage) {
    btnSaveLanguage.addEventListener('click', async () => {
      const langSelect = document.getElementById('setting-language');
      const lang = langSelect ? langSelect.value : 'zh-CN';
      const s = await window.api.getSettings();
      s.language = lang;
      await saveSettings(s);
      if (typeof i18nSetLanguage === 'function') {
        i18nSetLanguage(lang);
        i18nApplyToDOM();
      }
      // Update agent instances so system prompts use the new language
      if (typeof agent !== 'undefined' && agent && agent.settings) {
        agent.settings.language = lang;
        agent.contextManager?.setSystemPrompt(agent.getSystemPrompt());
      }
      if (typeof codeAgent !== 'undefined' && codeAgent && codeAgent.settings) {
        codeAgent.settings.language = lang;
        codeAgent.contextManager?.setSystemPrompt(codeAgent.getSystemPrompt());
      }
      if (typeof babeAgent !== 'undefined' && babeAgent && babeAgent.settings) {
        babeAgent.settings.language = lang;
        babeAgent.contextManager?.setSystemPrompt(babeAgent.getSystemPrompt());
      }
      window.showMessageModal?.(t('ui.language.saved', '语言设置已保存，部分文本将在下次启动后完全生效', {}), t('ui.language.notice', '提示', {}), 'info');
    });
  }
