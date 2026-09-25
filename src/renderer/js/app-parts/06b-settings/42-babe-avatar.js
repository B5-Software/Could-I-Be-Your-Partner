  // ---- Babe Avatar Settings ----
  document.getElementById('btn-babe-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode('babe');
    if (result.ok && (result.path || result.dataUrl)) {
      const s = await window.api.getSettings();
      if (!s.babe) s.babe = {};
      s.babe.avatar = result.path || result.dataUrl;
      await saveSettings(s);
      // 同步到 babeAgent.settings
      if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
      updateBabeAvatarPreview(s.babe.avatar);
      updateBabePersonaDisplay(s.babe);
    }
  });

  document.getElementById('btn-babe-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.babe) s.babe = {};
    s.babe.avatar = '';
    await saveSettings(s);
    if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
    updateBabeAvatarPreview('');
    updateBabePersonaDisplay(s.babe);
  });
