  // ---- 免费模型官方方案警示（不自动伪装 UA，由用户决定并自行承担风险）----
  const OB_FREE_MODEL_RE = /-free$|big-pickle|north-mini|nemotron|hy3/;
  const OB_UA_FALLBACK = '1.18.31';
  function obFindUaHeader(list) {
    for (const item of (list || [])) {
      if (String(item?.name || '').trim().toLowerCase() === 'user-agent') return item;
    }
    return null;
  }
  async function updateObFreeNotice() {
    const notice = document.getElementById('ob-free-notice');
    if (!notice) return;
    const provider = document.getElementById('ob-llm-provider')?.value || 'opencode-zen';
    const key = (document.getElementById('ob-llm-zen-key')?.value || '').trim();
    const model = document.getElementById('ob-llm-model')?.value || '';
    const isFree = provider === 'opencode-zen' && (key === 'public' || OB_FREE_MODEL_RE.test(model));
    notice.classList.toggle('hidden', !isFree);
    if (!isFree) return;
    const s = await window.api.getSettings();
    const ua = obFindUaHeader(s?.llm?.customHeaders);
    const status = document.getElementById('ob-ua-status');
    if (status) status.textContent = ua ? `已添加: User-Agent: ${ua.value || '(空)'}` : '';
  }
  // 用户主动点击才写入官方 UA（写进自定义请求头，可随时删除）
  document.getElementById('ob-btn-add-ua')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    s.llm = s.llm || {};
    s.llm.customHeaders = Array.isArray(s.llm.customHeaders) ? s.llm.customHeaders : [];
    const cached = s.llm.opencodeVersion;
    const version = (cached && typeof cached.version === 'string' && cached.version.trim()) ? cached.version.trim() : OB_UA_FALLBACK;
    const existing = obFindUaHeader(s.llm.customHeaders);
    if (existing) {
      existing.value = `opencode/${version}`;
      existing.enabled = true;
    } else {
      s.llm.customHeaders.push({ name: 'User-Agent', value: `opencode/${version}` });
    }
    await window.api.setSettings(s);
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    await updateObFreeNotice();
    window.showToast(`已添加 User-Agent: opencode/${version}（风险自负，可随时在设置 → 自定义请求头中删除）`, 'success');
  });
  // provider 切换
  document.getElementById('ob-llm-provider')?.addEventListener('change', (e) => {
    updateObProviderFields(e.target.value);
    refreshObModels().then(async () => {
      autoSelectDeepSeek();
      await updateObFreeNotice().catch(() => {});
    });
  });
  document.getElementById('ob-llm-zen-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-model')?.addEventListener('change', () => updateObFreeNotice().catch(() => {}));
  document.getElementById('ob-llm-zen-key')?.addEventListener('change', () => updateObFreeNotice().catch(() => {}));
  document.getElementById('ob-llm-url')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-btn-zen-genkey')?.addEventListener('click', () => {
    document.getElementById('ob-llm-zen-key').value = 'public';
    refreshObModels().then(async () => {
      autoSelectDeepSeek();
      await updateObFreeNotice().catch(() => {});
    });
  });
  // 头像选择（复用 avatarPickAndEncode，与设置页一致，macOS/Windows 均可用）
  async function obPickAvatar(target) {
    try {
      const result = await window.api.avatarPickAndEncode(target === 'ai' ? 'aiPersona' : 'userProfile');
      if (!result?.ok || (!result.path && !result.dataUrl)) return;
      const preview = document.getElementById(target === 'ai' ? 'ob-ai-avatar-preview' : 'ob-user-avatar-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.dataUrl || result.path}" alt="">`;
        // settings 存文件路径；dataUrl 仅用于即时预览
        preview.dataset.avatar = result.path || result.dataUrl;
      }
    } catch (e) {
      console.error('[Onboarding] avatar pick failed:', e);
    }
  }
  function obClearAvatar(target) {
    const preview = document.getElementById(target === 'ai' ? 'ob-ai-avatar-preview' : 'ob-user-avatar-preview');
    if (preview) {
      preview.innerHTML = `<i class="fa-solid fa-${target === 'ai' ? 'user-astronaut' : 'user'}"></i>`;
      delete preview.dataset.avatar;
    }
  }
  document.getElementById('ob-btn-ai-avatar')?.addEventListener('click', () => obPickAvatar('ai'));
  document.getElementById('ob-btn-ai-avatar-clear')?.addEventListener('click', () => obClearAvatar('ai'));
  document.getElementById('ob-btn-user-avatar')?.addEventListener('click', () => obPickAvatar('user'));
  document.getElementById('ob-btn-user-avatar-clear')?.addEventListener('click', () => obClearAvatar('user'));
  // 完成配置
  document.getElementById('ob-btn-finish')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    // AI 形象
    const aiPreview = document.getElementById('ob-ai-avatar-preview');
    s.aiPersona = s.aiPersona || {};
    s.aiPersona.name = document.getElementById('ob-ai-name').value.trim() || 'Partner';
    s.aiPersona.pronouns = document.getElementById('ob-ai-pronouns').value.trim() || 'Ta';
    s.aiPersona.personality = document.getElementById('ob-ai-personality').value.trim() || '活泼可爱、热情友善';
    s.aiPersona.customPrompt = document.getElementById('ob-ai-persona').value.trim();
    if (aiPreview?.dataset.avatar) s.aiPersona.avatar = aiPreview.dataset.avatar;
    // 用户形象
    const userPreview = document.getElementById('ob-user-avatar-preview');
    s.userProfile = s.userProfile || {};
    s.userProfile.name = document.getElementById('ob-user-name').value.trim() || (agent.systemInfo?.username || '用户');
    if (userPreview?.dataset.avatar) s.userProfile.avatar = userPreview.dataset.avatar;
    // LLM 配置
    const provider = document.getElementById('ob-llm-provider').value;
    s.llm = s.llm || {};
    s.llm.provider = provider;
    if (provider === 'opencode-zen' || provider === 'opencode-go') {
      s.llm.zenApiKey = document.getElementById('ob-llm-zen-key').value.trim() || 'public';
      if (provider === 'opencode-go') {
        s.llm.apiUrl = 'https://opencode.ai/zen/go/v1/chat/completions';
      } else {
        s.llm.apiUrl = 'https://opencode.ai/zen/v1/chat/completions';
      }
      s.llm.apiKey = s.llm.zenApiKey;
    } else {
      s.llm.apiUrl = document.getElementById('ob-llm-url').value.trim();
      s.llm.apiKey = document.getElementById('ob-llm-key').value.trim();
    }
    s.llm.model = document.getElementById('ob-llm-model').value || s.llm.model || '';
    s.onboardingCompleted = true;
    await window.api.setSettings(s);
    // 即时生效
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    // 更新 UI 显示
    if (typeof updatePersonaDisplay === 'function') updatePersonaDisplay(s.aiPersona);
    fadeOutHide(document.getElementById('onboarding-modal'));
    // 通知 WebUI 同步头像
    try { await window.api.webControlSetAvatars(s.aiPersona?.avatar, s.userProfile?.avatar); } catch (_) {}
  });
  showOnboardingIfNeeded();
