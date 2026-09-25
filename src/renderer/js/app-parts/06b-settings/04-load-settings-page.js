  async function loadSettingsPage() {
    const s = await window.api.getSettings();
    populateFontSelects(s);
    applyFontSettings(s);
    document.getElementById('setting-llm-url').value = s.llm.apiUrl || '';
    document.getElementById('setting-llm-key').value = s.llm.apiKey || '';
    document.getElementById('setting-llm-model').value = s.llm.model || '';
    document.getElementById('setting-llm-temp').value = s.llm.temperature;
    document.getElementById('setting-temp-val').textContent = s.llm.temperature;
    document.getElementById('setting-llm-ctx').value = s.llm.maxContextLength;
    document.getElementById('setting-llm-max-response').value = s.llm.maxResponseTokens || 8192;
    document.getElementById('setting-llm-daily-limit').value = s.llm.dailyMaxTokens || 0;
    document.getElementById('setting-llm-stream').checked = s.llm.streamResponses !== false;
    const forceVisionEl = document.getElementById('setting-llm-force-vision');
    if (forceVisionEl) forceVisionEl.checked = s.llm.forceVision === true;
    // 外置视觉
    const evUrl = document.getElementById('setting-llm-external-vision-url');
    const evKey = document.getElementById('setting-llm-external-vision-key');
    const evModel = document.getElementById('setting-llm-external-vision-model');
    if (evUrl) evUrl.value = s.llm.externalVision?.apiUrl || '';
    if (evKey) evKey.value = s.llm.externalVision?.apiKey || '';
    if (evModel) evModel.value = s.llm.externalVision?.model || '';
    document.getElementById('setting-llm-retries').value = s.llm.maxRetries ?? 10;
    document.getElementById('setting-llm-timeout').value = Math.round((s.llm.timeoutMs ?? 300000) / 1000);
    document.getElementById('setting-llm-fallback-model').value = s.llm.fallbackModel || '';
    const llmUsage = s.llm.dailyTokensUsed || 0;
    const llmLimit = s.llm.dailyMaxTokens || 0;
    const llmUsageEl = document.getElementById('setting-llm-usage');
    llmUsageEl.textContent = `今日已用: ${llmUsage}`;
    if (llmLimit > 0 && llmUsage >= llmLimit * 0.8) {
      llmUsageEl.classList.add('warning');
      llmUsageEl.textContent = `今日已用: ${llmUsage} (接近限制 ${llmLimit})`;
    }

    // Provider / Zen / Reasoning
    const provider = s.llm.provider || 'openai-compat';
    document.getElementById('setting-llm-provider').value = provider;
    const zenKeyEl = document.getElementById('setting-llm-zen-key');
    if (zenKeyEl) {
      zenKeyEl.value = s.llm.zenApiKey || '';
      // 标记是否为免登录 public key，用于 refreshZenModels 过滤
      if ((s.llm.zenApiKey || '').trim() === 'public') {
        zenKeyEl.dataset.publicKey = '1';
      } else {
        delete zenKeyEl.dataset.publicKey;
      }
    }
    const reasoningEl = document.getElementById('setting-llm-reasoning');
    if (reasoningEl) reasoningEl.value = s.llm.reasoningEffort || 'off';
    const ocAutoEl = document.getElementById('setting-llm-oc-auto');
    if (ocAutoEl) ocAutoEl.checked = s.llm.autoOpencodeHeaders !== false;
    // 动态变体档位：按当前模型能力拉取并收敛（异步，不阻塞设置页渲染）
    refreshReasoningVariants();
    updateLLMProviderFields(provider);
    if (provider === 'opencode-zen' || provider === 'opencode-go') {
      const zenModelSel = document.getElementById('setting-llm-zen-model');
      if (zenModelSel) refreshZenModels(s.llm.model);
    }
    // 自定义请求头编辑器
    if (llmHeaderEditor) llmHeaderEditor.render(s.llm.customHeaders);
    if (imgHeaderEditor) imgHeaderEditor.render(s.imageGen.customHeaders);
    // 免费模型官方方案警示（含已添加 UA 状态）
    updateZenFreeNotice().catch(() => {});

    document.getElementById('setting-img-url').value = s.imageGen.apiUrl || '';
    document.getElementById('setting-img-key').value = s.imageGen.apiKey || '';
    document.getElementById('setting-img-model').value = s.imageGen.model || '';
    document.getElementById('setting-img-size').value = s.imageGen.imageSize || '1024x1024';
    document.getElementById('setting-img-daily-limit').value = s.imageGen.dailyMaxImages || 0;
    const imgUsage = s.imageGen.dailyImagesUsed || 0;
    const imgLimit = s.imageGen.dailyMaxImages || 0;
    const imgUsageEl = document.getElementById('setting-img-usage');
    imgUsageEl.textContent = `今日已用: ${imgUsage}`;
    if (imgLimit > 0 && imgUsage >= imgLimit * 0.8) {
      imgUsageEl.classList.add('warning');
      imgUsageEl.textContent = `今日已用: ${imgUsage} (接近限制 ${imgLimit})`;
    }
    // 生图多厂商预设 / 高级参数回填（异步，不阻塞设置页渲染）
    refreshImageGenUI(s.imageGen).catch(() => {});
    // 模型池 + 决策模型设置回填
    refreshPoolUI(s).catch(() => {});
    loadDecisionSettings(s);

    document.getElementById('setting-accent-color').value = s.theme.accentColor;
    document.getElementById('setting-bg-color').value = s.theme.backgroundColor;
    document.getElementById('setting-ui-animations').checked = s.animations !== false;
    document.getElementById('setting-ui-modal-animations').checked = s.modalAnimations !== false;
    document.getElementById('setting-auto-approve').checked = s.autoApproveSensitive;

    // 隐私信息保护
    const priv = s.privacyProtection || {};
    const privEnabledEl = document.getElementById('setting-privacy-enabled');
    if (privEnabledEl) privEnabledEl.checked = priv.enabled === true;
    const privResultsEl = document.getElementById('setting-privacy-filter-results');
    if (privResultsEl) privResultsEl.checked = priv.filterResults !== false;
    const privArgsEl = document.getElementById('setting-privacy-filter-args');
    if (privArgsEl) privArgsEl.checked = priv.filterArgs !== false;
    const privTermEl = document.getElementById('setting-privacy-filter-terminal');
    if (privTermEl) privTermEl.checked = priv.filterTerminal !== false;
    const privAttachEl = document.getElementById('setting-privacy-filter-attachments');
    if (privAttachEl) privAttachEl.checked = priv.filterAttachments !== false;
    // 过滤类别勾选（缺失键按 DEFAULT_CATEGORIES 默认值，如 evasion 默认关）
    const catEls = document.querySelectorAll('#privacy-categories-item input[data-cat]');
    if (catEls.length > 0) {
      const cats = (priv.categories && typeof priv.categories === 'object') ? priv.categories : {};
      const defCats = (window.PrivacyFilter && window.PrivacyFilter.DEFAULT_CATEGORIES) || {};
      catEls.forEach(inp => {
        const val = cats[inp.dataset.cat];
        inp.checked = val === true ? true : (val === false ? false : defCats[inp.dataset.cat] === true);
      });
    }
    updatePrivacyTriggerState(priv.enabled === true);

    // 后台托盘模式
    const trayEnabledEl = document.getElementById('setting-tray-enabled');
    const closeToTrayEl = document.getElementById('setting-close-to-tray');
    if (trayEnabledEl) trayEnabledEl.checked = s.trayEnabled !== false;
    if (closeToTrayEl) closeToTrayEl.value = ['ask', 'always', 'never'].includes(s.closeToTray) ? s.closeToTray : 'ask';

    // Theme mode
    document.querySelectorAll('.theme-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === s.theme.mode);
    });

    // AI Persona settings
    const persona = s.aiPersona || {};
    const nameEl = document.getElementById('setting-ai-name');
    const bioEl = document.getElementById('setting-ai-bio');
    const pronounsEl = document.getElementById('setting-ai-pronouns');
    const personalityEl = document.getElementById('setting-ai-personality');
    const customPromptEl = document.getElementById('setting-ai-custom-prompt');
    if (nameEl) nameEl.value = persona.name || '';
    if (bioEl) bioEl.value = persona.bio || '';
    if (pronounsEl) pronounsEl.value = persona.pronouns || '';
    if (personalityEl) personalityEl.value = persona.personality || '';
    if (customPromptEl) customPromptEl.value = persona.customPrompt || '';
    // 命运之牌 UI 可见性开关（默认 true）
    const tarotVisibleEl = document.getElementById('setting-tarot-visible');
    if (tarotVisibleEl) tarotVisibleEl.checked = s.tarotVisible !== false;
    applyTarotVisibility(s.tarotVisible !== false);
    // Notification settings (default: enabled + all categories on)
    const notif = s.notifications || {};
    const notifEnabledEl = document.getElementById('setting-notify-enabled');
    if (notifEnabledEl) notifEnabledEl.checked = notif.enabled !== false;
    const notifApprovalEl = document.getElementById('setting-notify-approval');
    if (notifApprovalEl) notifApprovalEl.checked = notif.approval !== false;
    const notifSessionEl = document.getElementById('setting-notify-session-done');
    if (notifSessionEl) notifSessionEl.checked = notif.sessionDone !== false;
    const notifQuestionEl = document.getElementById('setting-notify-question');
    if (notifQuestionEl) notifQuestionEl.checked = notif.question !== false;
    const notifPresentEl = document.getElementById('setting-notify-present');
    if (notifPresentEl) notifPresentEl.checked = notif.present !== false;
    const notifBabeProactiveEl = document.getElementById('setting-notify-babe-proactive');
    if (notifBabeProactiveEl) notifBabeProactiveEl.checked = notif.babeProactive !== false;
    const notifUpdateEl = document.getElementById('setting-notify-update');
    if (notifUpdateEl) notifUpdateEl.checked = notif.updateAvailable !== false;
    // Update-check settings
    const upd = s.updates || {};
    const updAutoEl = document.getElementById('setting-updates-auto');
    if (updAutoEl) updAutoEl.checked = upd.autoCheckEnabled !== false;
    const updIntervalEl = document.getElementById('setting-updates-interval');
    if (updIntervalEl) updIntervalEl.value = String([6, 12, 24].includes(Number(upd.intervalHours)) ? Number(upd.intervalHours) : 6);
    const updChannelEl = document.getElementById('setting-updates-channel');
    if (updChannelEl) updChannelEl.value = (upd.channel === 'all') ? 'all' : 'stable';
    renderUpdateCheckResult(upd);
    // Language setting
    const langSelect = document.getElementById('setting-language');
    if (langSelect) langSelect.value = s.language || 'zh-CN';
    // 头像以文件路径为准；data URL 仅在推送到 WebUI 镜像时按需生成（不写回 settings）
    const aiAvatarData = persona.avatar || '';
    const aiAvatarMirror = await _avatarMirrorData(aiAvatarData);
    // 头像框系统：加载 AI 头像框状态并预加载 SVG
    _avatarFrameState.ai = persona.avatarFrame || null;
    if (_avatarFrameState.ai) await loadAvatarFrameSVG(_avatarFrameState.ai);
    updateAvatarPreview(aiAvatarData);

    // Babe Mode settings
    const babe = s.babe || {};
    const babeNameEl = document.getElementById('setting-babe-name');
    const babeGenderEl = document.getElementById('setting-babe-gender');
    const babeAgeEl = document.getElementById('setting-babe-age');
    const babePersonalityEl = document.getElementById('setting-babe-personality');
    const babePersonaEl = document.getElementById('setting-babe-persona');
    const babeUserNicknameEl = document.getElementById('setting-babe-user-nickname');
    const babeProactiveIntervalEl = document.getElementById('setting-babe-proactive-interval');
    const babeInitialAffectionEl = document.getElementById('setting-babe-initial-affection');
    if (babeNameEl) babeNameEl.value = babe.name || '';
    if (babeGenderEl) babeGenderEl.value = babe.gender || 'female';
    if (babeAgeEl) babeAgeEl.value = babe.age || '';
    if (babePersonalityEl) babePersonalityEl.value = babe.personality || '';
    if (babePersonaEl) babePersonaEl.value = babe.persona || '';
    if (babeUserNicknameEl) babeUserNicknameEl.value = babe.userNickname || '';
    if (babeProactiveIntervalEl) babeProactiveIntervalEl.value = String(babe.proactiveInterval ?? 0);
    if (babeInitialAffectionEl) babeInitialAffectionEl.value = babe.initialAffection ?? 30;
    // Babe 头像：文件路径为准
    const babeAvatarData = babe.avatar || '';
    // 头像框系统：加载 Babe 头像框状态并预加载 SVG
    _avatarFrameState.babe = babe.avatarFrame || null;
    if (_avatarFrameState.babe) await loadAvatarFrameSVG(_avatarFrameState.babe);
    updateBabeAvatarPreview(babeAvatarData);

    // User Profile settings
    const userProfile = s.userProfile || {};
    const userNameEl = document.getElementById('setting-user-name');
    const userBioEl = document.getElementById('setting-user-bio');
    if (userNameEl) userNameEl.value = userProfile.name || '';
    if (userBioEl) userBioEl.value = userProfile.bio || '';
    const userAvatarData = userProfile.avatar || '';
    const userAvatarMirror = await _avatarMirrorData(userAvatarData);
    // 头像框系统：加载 User 头像框状态并预加载 SVG
    _avatarFrameState.user = userProfile.avatarFrame || null;
    if (_avatarFrameState.user) await loadAvatarFrameSVG(_avatarFrameState.user);
    updateUserAvatarPreview(userAvatarData);
    window.api.webControlSetAvatars({ ai: aiAvatarMirror, user: userAvatarMirror });

    // 头像框系统：加载并渲染头像框选择器 grid（异步，不阻塞设置面板其他渲染）
    loadAvatarFrames();
    // 同步更新 Hero 显示的头像框
    updatePersonaDisplay(persona);

    // Entropy settings
    const entropy = s.entropy || {};
    document.querySelectorAll('.entropy-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.source === (entropy.source || 'csprng')));
    document.getElementById('entropy-trng-settings').style.display = entropy.source === 'trng' ? '' : 'none';
    document.querySelectorAll('.trng-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (entropy.trngMode || 'network')));
    document.getElementById('trng-network-settings').style.display = (entropy.trngMode || 'network') === 'network' ? '' : 'none';
    document.getElementById('trng-serial-settings').style.display = entropy.trngMode === 'serial' ? '' : 'none';
    const trngHostEl = document.getElementById('setting-trng-host');
    if (trngHostEl) trngHostEl.value = entropy.trngNetworkHost || '192.168.4.1';
    const trngPortEl = document.getElementById('setting-trng-port');
    if (trngPortEl) trngPortEl.value = entropy.trngNetworkPort || 80;
    const trngBaudEl = document.getElementById('setting-trng-serial-baud');
    if (trngBaudEl) trngBaudEl.value = entropy.trngSerialBaud || 115200;
    const trngSerialEl = document.getElementById('setting-trng-serial-port');
    if (trngSerialEl && entropy.trngSerialPort) trngSerialEl.value = entropy.trngSerialPort;
    if (entropy.trngMode === 'serial') {
      refreshTrngPorts(false);
    }

    // 更新配色方案可见性
    updateColorSchemeVisibility();

    // Proxy settings
    const proxy = s.proxy || {};
    document.querySelectorAll('.proxy-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === (proxy.mode || 'system'));
    });
    document.getElementById('manual-proxy-settings').style.display = proxy.mode === 'manual' ? '' : 'none';
    const proxyHttpEl = document.getElementById('setting-proxy-http');
    if (proxyHttpEl) proxyHttpEl.value = proxy.http || '';
    const proxyHttpsEl = document.getElementById('setting-proxy-https');
    if (proxyHttpsEl) proxyHttpsEl.value = proxy.https || '';
    const proxyBypassEl = document.getElementById('setting-proxy-bypass');
    if (proxyBypassEl) proxyBypassEl.value = proxy.bypass || 'localhost,127.0.0.1';

    // MCP settings
    await loadMcpServerList();
    setupMcpEvents();

    // Email settings
    const email = s.email || {};
    const eid = (id, prop, def='') => { const el = document.getElementById(id); if (el) el.value = email[prop] ?? def; };
    const emailModeEl = document.getElementById('setting-email-mode');
    if (emailModeEl) emailModeEl.value = email.mode || 'send-receive';
    updateEmailModeVisibility(email.mode || 'send-receive');
    eid('setting-email-smtp-host', 'smtpHost');
    eid('setting-email-smtp-port', 'smtpPort', 587);
    const smtpSecure = document.getElementById('setting-email-smtp-secure');
    if (smtpSecure) smtpSecure.checked = email.smtpSecure !== false;
    eid('setting-email-imap-host', 'imapHost');
    eid('setting-email-imap-port', 'imapPort', 993);
    const imapTls = document.getElementById('setting-email-imap-tls');
    if (imapTls) imapTls.checked = email.imapTls !== false;
    eid('setting-email-user', 'emailUser');
    eid('setting-email-pass', 'emailPass');
    eid('setting-email-owner', 'ownerAddress');
    eid('setting-email-totp-secret', 'totpSecret');
    eid('setting-email-poll-interval', 'pollInterval', 30);
    eid('setting-email-resend-interval', 'resendIntervalMinutes', 30);
    eid('setting-email-max-resends', 'maxResends', 3);
    const emailEnabled = document.getElementById('setting-email-enabled');
    if (emailEnabled) emailEnabled.checked = !!email.enabled;
    // 渲染控制白名单
    renderEmailAllowedSenders(email.allowedSenders || []);
    setupEmailEvents();

    // FediKitten settings
    const fkActive = (s.fedikitten && s.fedikitten.active) || {};
    const fkUrlEl = document.getElementById('setting-fedikitten-url');
    if (fkUrlEl) fkUrlEl.value = fkActive.url || '';
    const fkUserEl = document.getElementById('setting-fedikitten-username');
    if (fkUserEl) fkUserEl.value = fkActive.username || '';
    const fkPassEl = document.getElementById('setting-fedikitten-password');
    if (fkPassEl) fkPassEl.value = '';
    setupFediKittenEvents();
    refreshFediKittenStatus();

    // CIBYP-IM settings
    const cibypActive = (s.cibypIm && s.cibypIm.active) || null;
    const ciUrlEl = document.getElementById('setting-cibypim-url');
    if (ciUrlEl && cibypActive) ciUrlEl.value = cibypActive.url || '';
    const ciUserEl = document.getElementById('setting-cibypim-username');
    if (ciUserEl && cibypActive) ciUserEl.value = cibypActive.username || '';
    const ciPassEl = document.getElementById('setting-cibypim-password');
    if (ciPassEl) ciPassEl.value = '';
    setupCibypImEvents();
    refreshCibypImStatus();

    // Web Control settings
    const wc = s.webControl || {};
    const wcPortEl = document.getElementById('setting-wc-port');
    if (wcPortEl) wcPortEl.value = wc.port || 3456;
    const wcEnabledEl = document.getElementById('setting-wc-enabled');
    if (wcEnabledEl) wcEnabledEl.checked = !!wc.enabled;
    const wcAutoStartEl = document.getElementById('setting-wc-autostart');
    if (wcAutoStartEl) wcAutoStartEl.checked = !!wc.autoStartOnOpen;
    const wc2faEl = document.getElementById('setting-wc-enable-2fa');
    if (wc2faEl) {
      wc2faEl.checked = !!wc.enable2FA;
      document.getElementById('wc-2fa-area').style.display = wc.enable2FA ? '' : 'none';
    }
    // Update toggle button state
    updateWcToggleButton();
    setupWebControlEvents();
    loadImeSettings();
  }
