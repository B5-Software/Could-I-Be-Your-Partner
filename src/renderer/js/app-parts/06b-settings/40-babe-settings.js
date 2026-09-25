  // ---- Babe Mode Settings ----
  ['setting-babe-name', 'setting-babe-gender', 'setting-babe-age', 'setting-babe-personality', 'setting-babe-persona', 'setting-babe-user-nickname', 'setting-babe-proactive-interval', 'setting-babe-initial-affection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', async () => {
        const key = {
          'setting-babe-name': 'name',
          'setting-babe-gender': 'gender',
          'setting-babe-age': 'age',
          'setting-babe-personality': 'personality',
          'setting-babe-persona': 'persona',
          'setting-babe-user-nickname': 'userNickname',
          'setting-babe-proactive-interval': 'proactiveInterval',
          'setting-babe-initial-affection': 'initialAffection'
        }[id];
        const val = (id === 'setting-babe-proactive-interval' || id === 'setting-babe-initial-affection')
          ? parseInt(el.value, 10) || 0
          : el.value;
        const s = await window.api.getSettings();
        if (!s.babe) s.babe = {};
        s.babe[key] = val;
        await saveSettings(s);
        // 如果修改了初始好感度，且当前没有活跃 Babe 会话，更新 babeAgent 的好感度
        if (key === 'initialAffection' && babeAgent && !babeCurrentHistoryId) {
          babeAgent.babeAffection = val;
          updateBabeAffection(val);
        }
        // 主动消息频率变更时重启定时器
        if (key === 'proactiveInterval') {
          restartBabeProactiveTimer(val);
        }
      });
    }
  });

  // AI avatar file picker
  document.getElementById('btn-ai-avatar-pick')?.addEventListener('click', async () => {
    const result = await window.api.avatarPickAndEncode('aiPersona');
    if (result.ok && (result.path || result.dataUrl)) {
      const s = await window.api.getSettings();
      if (!s.aiPersona) s.aiPersona = {};
      s.aiPersona.avatar = result.path || result.dataUrl;
      await saveSettings(s);
      updateAvatarPreview(s.aiPersona.avatar);
      updatePersonaDisplay(s.aiPersona);
      window.api.webControlSetAvatars({ ai: result.dataUrl || '', user: await _avatarMirrorData(s.userProfile?.avatar || '') });
    }
  });

  document.getElementById('btn-ai-avatar-clear')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    if (!s.aiPersona) s.aiPersona = {};
    s.aiPersona.avatar = '';
    await saveSettings(s);
    updateAvatarPreview('');
    updatePersonaDisplay(s.aiPersona);
    window.api.webControlSetAvatars({ ai: '', user: await _avatarMirrorData(s.userProfile?.avatar || '') });
  });

  function updatePersonaDisplay(persona) {
    const nameEl = document.getElementById('agent-name-display');
    const avatarEl = document.getElementById('agent-avatar-display');
    if (nameEl && persona?.name) nameEl.textContent = persona.name;
    if (avatarEl) {
      const frameId = _avatarFrameState.ai;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制（140% 与 overlay 同尺寸对齐）
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:28px;height:28px;border-radius:50%;object-fit:cover';
      avatarEl.innerHTML = makeAvatarHTML(persona?.avatar, true, avatarSize);
      // Hero 头像框叠加
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
    }
  }
