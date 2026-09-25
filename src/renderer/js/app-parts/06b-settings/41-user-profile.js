  // ---- User Profile Settings ----
  ['setting-user-name', 'setting-user-bio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = { 'setting-user-name': 'name', 'setting-user-bio': 'bio' }[id];
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile[key] = el.value;
        await saveSettings(s);
        agent.settings = s;
        agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
      });
    }
  });

  document.getElementById('btn-user-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode('userProfile');
    if (result.ok && (result.path || result.dataUrl)) {
      const s = await window.api.getSettings();
      if (!s.userProfile) s.userProfile = {};
      s.userProfile.avatar = result.path || result.dataUrl;
      await saveSettings(s);
      updateUserAvatarPreview(s.userProfile.avatar);
      window.api.webControlSetAvatars({ ai: await _avatarMirrorData(s.aiPersona?.avatar || ''), user: result.dataUrl || '' });
    }
  });

  document.getElementById('btn-user-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.userProfile) s.userProfile = {};
    s.userProfile.avatar = '';
    await saveSettings(s);
    updateUserAvatarPreview('');
    window.api.webControlSetAvatars({ ai: await _avatarMirrorData(s.aiPersona?.avatar || ''), user: '' });
  });
