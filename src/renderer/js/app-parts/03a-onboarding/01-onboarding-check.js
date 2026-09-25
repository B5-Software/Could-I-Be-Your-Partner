  // ---- 初次使用引导 ----
  // 仅检测 onboardingCompleted 标志：完成过一次就不再弹（用户可随时从设置主动改）
  // 直接从磁盘读取，避免 agent.settings 尚未加载时误判
  async function checkOnboarding() {
    try {
      const s = await window.api.getSettings();
      return !s.onboardingCompleted;
    } catch {
      const s = agent.settings || {};
      return !s.onboardingCompleted;
    }
  }
  async function showOnboardingIfNeeded() {
    if (!(await checkOnboarding())) return;
    const obModal = document.getElementById('onboarding-modal');
    if (!obModal) return;
    obModal.classList.remove('hidden');
    // 预填现有值
    const s = agent.settings || {};
    document.getElementById('ob-ai-name').value = s.aiPersona?.name || '';
    document.getElementById('ob-ai-pronouns').value = s.aiPersona?.pronouns || '';
    document.getElementById('ob-ai-personality').value = s.aiPersona?.personality || '';
    document.getElementById('ob-ai-persona').value = s.aiPersona?.customPrompt || '';
    document.getElementById('ob-user-name').value = s.userProfile?.name || '';
    // 头像预览（settings 存文件路径，需解析为可显示的 data URL/直接路径）
    const obResolvePreview = async (value, previewId) => {
      if (!value) return;
      let src = value;
      if (!value.startsWith('data:') && !value.startsWith('http')) {
        try {
          const enc = await window.api.avatarEncodeFile(value);
          if (enc && enc.ok) src = enc.dataUrl;
        } catch { /* ignore */ }
      }
      const preview = document.getElementById(previewId);
      if (preview) {
        preview.innerHTML = `<img src="${src}" alt="">`;
        preview.dataset.avatar = value;
      }
    };
    obResolvePreview(s.aiPersona?.avatar, 'ob-ai-avatar-preview');
    obResolvePreview(s.userProfile?.avatar, 'ob-user-avatar-preview');
    // LLM 字段
    const provider = s.llm?.provider || 'opencode-zen';
    document.getElementById('ob-llm-provider').value = provider;
    document.getElementById('ob-llm-zen-key').value = s.llm?.zenApiKey || 'public';
    document.getElementById('ob-llm-url').value = s.llm?.apiUrl || '';
    document.getElementById('ob-llm-key').value = s.llm?.apiKey || '';
    updateObProviderFields(provider);
    // 先显示第一步，避免模型加载慢时向导空白（按钮点击无反馈的假象）
    showOnboardingStep(1);
    await refreshObModels();
    // 默认选 DeepSeek 模型
    autoSelectDeepSeek();
    updateObFreeNotice().catch(() => {});
  }
