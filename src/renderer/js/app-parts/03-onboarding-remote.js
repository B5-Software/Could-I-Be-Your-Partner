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
    // 头像预览
    if (s.aiPersona?.avatar) {
      document.getElementById('ob-ai-avatar-preview').innerHTML = `<img src="${s.aiPersona.avatar}" alt="">`;
    }
    if (s.userProfile?.avatar) {
      document.getElementById('ob-user-avatar-preview').innerHTML = `<img src="${s.userProfile.avatar}" alt="">`;
    }
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
  }
  // ---- 步骤向导导航 ----
  const ONBOARDING_TOTAL_STEPS = 3;
  let currentOnboardingStep = 1;
  function showOnboardingStep(n) {
    if (n < 1) n = 1;
    if (n > ONBOARDING_TOTAL_STEPS) n = ONBOARDING_TOTAL_STEPS;
    currentOnboardingStep = n;
    // 切换步骤页面显示
    document.querySelectorAll('.ob-page').forEach(s => {
      if (parseInt(s.dataset.step) === n) s.classList.add('active');
      else s.classList.remove('active');
    });
    // 更新步骤指示器（active + done 状态）
    document.querySelectorAll('.ob-step-item').forEach(d => {
      const step = parseInt(d.dataset.step);
      d.classList.toggle('active', step === n);
      d.classList.toggle('done', step < n);
    });
    // 更新进度条
    const bar = document.getElementById('ob-progress-bar');
    if (bar) bar.style.width = `${((n - 1) / (ONBOARDING_TOTAL_STEPS - 1)) * 100}%`;
    // 更新步骤文本
    const text = document.getElementById('ob-step-text');
    if (text) text.textContent = `${n} / ${ONBOARDING_TOTAL_STEPS}`;
    // 上一步按钮：第一步隐藏
    const prevBtn = document.getElementById('ob-btn-prev');
    if (prevBtn) prevBtn.classList.toggle('hidden', n === 1);
    // 下一步 / 完成按钮：最后一步切换为"完成"
    const nextBtn = document.getElementById('ob-btn-next');
    const finishBtn = document.getElementById('ob-btn-finish');
    if (n === ONBOARDING_TOTAL_STEPS) {
      if (nextBtn) nextBtn.style.display = 'none';
      if (finishBtn) finishBtn.style.display = '';
    } else {
      if (nextBtn) {
        nextBtn.style.display = '';
        nextBtn.innerHTML = '下一步 <i class="fa-solid fa-arrow-right"></i>';
      }
      if (finishBtn) finishBtn.style.display = 'none';
    }
    // 推送 onboarding 步骤切换到 WebUI（整个模态框内容替换，确保所有子元素状态同步）
    const obModal = document.getElementById('onboarding-modal');
    if (obModal) {
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#onboarding-modal', html: obModal.innerHTML });
    }
  }
  // 下一步
  document.getElementById('ob-btn-next')?.addEventListener('click', () => {
    if (currentOnboardingStep < ONBOARDING_TOTAL_STEPS) showOnboardingStep(currentOnboardingStep + 1);
  });
  // 上一步
  document.getElementById('ob-btn-prev')?.addEventListener('click', () => {
    if (currentOnboardingStep > 1) showOnboardingStep(currentOnboardingStep - 1);
  });
  // 跳过引导：直接完成，标记 onboardingCompleted 并关闭
  document.getElementById('ob-btn-skip')?.addEventListener('click', async () => {
    const s = await window.api.getSettings();
    s.onboardingCompleted = true;
    await window.api.setSettings(s);
    if (typeof agent.applySettings === 'function') agent.applySettings(s);
    else agent.settings = s;
    fadeOutHide(document.getElementById('onboarding-modal'));
  });
  function updateObProviderFields(provider) {
    const zenFields = document.getElementById('ob-zen-key-field');
    const openaiFields = document.getElementById('ob-openai-fields');
    const openaiKeyField = document.getElementById('ob-openai-key-field');
    if (provider === 'opencode-zen') {
      zenFields?.classList.remove('hidden');
      openaiFields?.classList.add('hidden');
      openaiKeyField?.classList.add('hidden');
    } else {
      zenFields?.classList.add('hidden');
      openaiFields?.classList.remove('hidden');
      openaiKeyField?.classList.remove('hidden');
    }
  }
  async function refreshObModels() {
    const provider = document.getElementById('ob-llm-provider')?.value || 'opencode-zen';
    const sel = document.getElementById('ob-llm-model');
    const hint = document.getElementById('ob-model-hint');
    if (!sel) return;
    sel.innerHTML = '<option value="">加载中...</option>';
    if (hint) hint.textContent = '正在获取模型列表...';
    try {
      if (provider === 'opencode-zen') {
        const res = await window.api.zenFetchModels();
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        const FREE = /free|big-pickle|mimo|north-mini|nemotron|hy3/;
        const isPub = (document.getElementById('ob-llm-zen-key')?.value || '').trim() === 'public';
        let models = res.models.slice();
        if (isPub) models = models.filter(m => FREE.test(m.id));
        models.sort((a,b) => (a.id||'').localeCompare(b.id||''));
        sel.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = (FREE.test(m.id) ? '[免费] ' : '') + (m.name || m.id);
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${models.length} 个可用模型`;
      } else {
        const url = document.getElementById('ob-llm-url')?.value || '';
        const key = document.getElementById('ob-llm-key')?.value || '';
        if (!url || !key) {
          sel.innerHTML = '<option value="">请先填写 URL 和 Key</option>';
          if (hint) hint.textContent = '请先填写 API URL 和 Key';
          return;
        }
        const res = await window.api.llmFetchModels(provider, url, key);
        if (!res?.ok || !Array.isArray(res.models)) {
          sel.innerHTML = '<option value="">(获取失败)</option>';
          if (hint) hint.textContent = res?.error || '获取失败';
          return;
        }
        sel.innerHTML = '';
        for (const m of res.models) {
          const opt = document.createElement('option');
          opt.value = m.id || m.name || '';
          opt.textContent = m.id || m.name || '';
          sel.appendChild(opt);
        }
        if (hint) hint.textContent = `共 ${res.models.length} 个可用模型`;
      }
    } catch (e) {
      sel.innerHTML = '<option value="">(获取失败)</option>';
      if (hint) hint.textContent = '错误: ' + (e?.message || e);
    }
  }
  function autoSelectDeepSeek() {
    const sel = document.getElementById('ob-llm-model');
    if (!sel) return;
    // 优先选含 deepseek 的模型
    for (const opt of sel.options) {
      if (/deepseek/i.test(opt.value)) { opt.selected = true; return; }
    }
    // 次选 free 模型
    for (const opt of sel.options) {
      if (/free|big-pickle/i.test(opt.value)) { opt.selected = true; return; }
    }
  }
  // provider 切换
  document.getElementById('ob-llm-provider')?.addEventListener('change', (e) => {
    updateObProviderFields(e.target.value);
    refreshObModels().then(autoSelectDeepSeek);
  });
  document.getElementById('ob-llm-zen-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-url')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-llm-key')?.addEventListener('change', refreshObModels);
  document.getElementById('ob-btn-zen-genkey')?.addEventListener('click', () => {
    document.getElementById('ob-llm-zen-key').value = 'public';
    refreshObModels().then(autoSelectDeepSeek);
  });
  // 头像选择（复用 avatarPickAndEncode，与设置页一致，macOS/Windows 均可用）
  async function obPickAvatar(target) {
    try {
      const result = await window.api.avatarPickAndEncode();
      if (!result?.ok || !result.dataUrl) return;
      const preview = document.getElementById(target === 'ai' ? 'ob-ai-avatar-preview' : 'ob-user-avatar-preview');
      if (preview) {
        preview.innerHTML = `<img src="${result.dataUrl}" alt="">`;
        preview.dataset.avatar = result.dataUrl;
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
    if (provider === 'opencode-zen') {
      s.llm.zenApiKey = document.getElementById('ob-llm-zen-key').value.trim() || 'public';
      s.llm.apiUrl = 'https://opencode.ai/zen/v1/chat/completions';
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

  // ---- Local/Remote 选择器 ----
  // Remote 模式：把本渲染器当作远程主机的“瘦客户端 / 镜像”，所有 Agent 执行发生在远端。
  let remoteWs = null;             // Remote 模式的 WS 连接
  var isRemoteMode = false;         // 当前是否为 Remote 模式（用 var 提升，避免 WebUIMirror 早期引用触发 TDZ）
  let remoteBaseUrl = '';           // 远程 HTTP 基址（用于显示）
  let remotePassword = '';          // 远程密码（保存以便重连）
  let remoteTotp = '';              // 远程 TOTP（保存以便重连）
  let remoteIntentionalClose = false; // 主动断开标志（避免触发自动重连）
  let remoteReconnectTimer = null; // 自动重连定时器
  let remoteAvatars = null;         // { ai, user } 远端头像
  const _remoteWsPendingByType = new Map(); // WS 请求/响应映射（按期望响应类型）
  let remoteConnectionId = 0;        // 连接生成计数器，invalidate 旧的连接尝试

  function setConnectionMode(mode) {
    const localBtn = document.getElementById('conn-btn-local');
    const remoteBtn = document.getElementById('conn-btn-remote');
    if (mode === 'remote') {
      localBtn?.classList.remove('active');
      remoteBtn?.classList.add('active');
      document.getElementById('remote-connect-modal').classList.remove('hidden');
    } else {
      localBtn?.classList.add('active');
      remoteBtn?.classList.remove('active');
      // 主动断开远程连接
      remoteIntentionalClose = true;
      remoteConnectionId++; // invalidate 所有进行中的连接尝试
      if (remoteReconnectTimer) { clearTimeout(remoteReconnectTimer); remoteReconnectTimer = null; }
      if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
      const wasRemote = isRemoteMode;
      isRemoteMode = false;
      remoteAvatars = null;
      // 停用事件委托
      disableRemoteEventDelegation();
      // Local 模式不显示远程连接横幅
      const banner = document.getElementById('remote-conn-banner');
      if (banner) banner.classList.add('hidden');
      setRemoteBadge('');
      // 恢复本地 UI 状态
      if (btnReoptimizeTools) btnReoptimizeTools.classList.add('hidden');
      hideApprovalPanelRemote();
      // 如果之前在 Remote 模式，mirror_body 已替换 #app 内容，需要重新加载恢复本地 DOM
      if (wasRemote) {
        location.reload();
        return;
      }
    }
  }
  document.getElementById('conn-btn-local')?.addEventListener('click', () => setConnectionMode('local'));
  document.getElementById('conn-btn-remote')?.addEventListener('click', () => setConnectionMode('remote'));
  document.getElementById('btn-remote-cancel')?.addEventListener('click', () => {
    fadeOutHide(document.getElementById('remote-connect-modal'));
    setConnectionMode('local');
  });

  // 远程连接横幅状态
  function setRemoteBanner(state, message) {
    const banner = document.getElementById('remote-conn-banner');
    if (!banner) return;
    banner.dataset.state = state;
    banner.classList.remove('hidden');
    const txt = banner.querySelector('.remote-conn-text');
    const reconnectBtn = banner.querySelector('.remote-conn-reconnect');
    if (txt) {
      const addr = remoteBaseUrl ? ` (${remoteBaseUrl})` : '';
      if (state === 'connecting') txt.textContent = '正在连接远程主机…' + addr;
      else if (state === 'connected') txt.textContent = '已连接远程主机' + addr;
      else if (state === 'disconnected') txt.textContent = message || ('未连接远程主机' + addr);
      else if (state === 'reconnecting') txt.textContent = '远程连接断开，正在重连…' + addr;
      else if (state === 'error') txt.textContent = (message || '远程连接错误') + addr;
    }
    if (reconnectBtn) reconnectBtn.style.display = (state === 'disconnected' || state === 'error') ? '' : 'none';
  }

  // 标题栏远程地址徽标
  function setRemoteBadge(addr) {
    const badge = document.getElementById('remote-addr-badge');
    if (!badge) return;
    if (addr) { badge.textContent = '🌐 ' + addr.replace(/^https?:\/\//, ''); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  // 横幅“重连”按钮
  document.querySelector('#remote-conn-banner .remote-conn-reconnect')?.addEventListener('click', () => {
    if (remoteBaseUrl && remotePassword) connectRemote(remoteBaseUrl, remotePassword, remoteTotp, true);
  });
  // 横幅“关闭”按钮：仅隐藏，不影响连接状态
  document.querySelector('#remote-conn-banner .remote-conn-dismiss')?.addEventListener('click', () => {
    const banner = document.getElementById('remote-conn-banner');
    if (banner) banner.classList.add('hidden');
  });

  // 发起一次远程连接。reconnect=true 表示自动重连调用。
  async function connectRemote(url, pwd, totp, reconnect = false) {
    const myId = ++remoteConnectionId;
    const statusEl = document.getElementById('remote-status');
    if (!reconnect && statusEl) statusEl.textContent = '连接中...';
    setRemoteBanner('connecting');
    // 先关掉旧连接
    remoteIntentionalClose = true;
    if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
    remoteIntentionalClose = false;
    try {
      // 1. 预校验凭据（HTTP 登录）。跨源时 CORS 已在服务端放行；cookie 不需要。
      const loginRes = await fetch(`${url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, totpCode: totp })
      });
      if (myId !== remoteConnectionId) return; // 已被 setConnectionMode('local') 取消
      const loginData = await loginRes.json();
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!loginData.ok) {
        if (!reconnect && statusEl) statusEl.textContent = loginData.error || '登录失败';
        setRemoteBanner('error', loginData.error || '登录失败');
        return;
      }
      // 2. 建立 WS（http→ws, https→wss）
      const wsUrl = url.replace(/^http/, 'ws') + '/ws';
      remoteWs = new WebSocket(wsUrl);
      remoteWs.onopen = () => {
        if (myId !== remoteConnectionId) { try { remoteWs.close(); } catch (_) {} return; }
        // 跨源 WS 无法携带 cookie，用首条 auth 消息完成认证
        remoteWs.send(JSON.stringify({ type: 'auth', password: pwd, totpCode: totp }));
      };
      remoteWs.onmessage = (ev) => {
        try { handleRemoteMessage(JSON.parse(ev.data)); } catch (_) {}
      };
      remoteWs.onerror = () => {
        if (myId !== remoteConnectionId) return;
        if (!reconnect && statusEl) statusEl.textContent = '连接失败，请检查地址或网络';
        setRemoteBanner('error', 'WebSocket 连接失败');
      };
      remoteWs.onclose = () => {
        if (myId !== remoteConnectionId) return; // 旧连接，不重连
        const wasRemote = isRemoteMode;
        isRemoteMode = false;
        // 清理挂起的请求
        for (const [, p] of _remoteWsPendingByType) { clearTimeout(p.timer); try { p.reject(new Error('连接已断开')); } catch {} }
        _remoteWsPendingByType.clear();
        if (remoteIntentionalClose) {
          setRemoteBanner('disconnected');
          return;
        }
        // 意外断开：自动重连
        if (wasRemote || reconnect) {
          setRemoteBanner('reconnecting');
          if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
          remoteReconnectTimer = setTimeout(() => {
            connectRemote(url, pwd, totp, true);
          }, 3000);
        } else {
          setRemoteBanner('disconnected');
        }
      };
    } catch (e) {
      if (myId !== remoteConnectionId) return; // 已被取消
      if (!reconnect && statusEl) statusEl.textContent = '错误: ' + (e?.message || e);
      setRemoteBanner('error', String(e?.message || e));
      // 网络错误也尝试重连
      if (remoteReconnectTimer) clearTimeout(remoteReconnectTimer);
      remoteReconnectTimer = setTimeout(() => connectRemote(url, pwd, totp, true), 5000);
    }
  }

  document.getElementById('btn-remote-connect')?.addEventListener('click', async () => {
    let url = document.getElementById('remote-url').value.trim().replace(/\/$/, '');
    const pwd = document.getElementById('remote-password').value;
    const totp = document.getElementById('remote-totp').value.trim();
    const statusEl = document.getElementById('remote-status');
    if (!url || !pwd) { statusEl.textContent = '请填写地址和密码'; return; }
    // 自动补全协议前缀：用户可能输入 "172.168.7.48:3456" 而未带 http://
    // 不补全的话 fetch 会把它当作相对路径，解析为 file:// 协议下的路径
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    remoteBaseUrl = url;
    remotePassword = pwd;
    remoteTotp = totp;
    setRemoteBadge(url);
    await connectRemote(url, pwd, totp, false);
  });

  // WS 请求/响应：发送 msg 并等待 expectedType 响应
  function remoteWsRequest(msg, expectedType, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) { reject(new Error('未连接到远程主机')); return; }
      if (_remoteWsPendingByType.has(expectedType)) { reject(new Error('已有相同请求进行中')); return; }
      const timer = setTimeout(() => { _remoteWsPendingByType.delete(expectedType); reject(new Error('请求超时')); }, timeout);
      _remoteWsPendingByType.set(expectedType, { resolve, reject, timer });
      remoteWs.send(JSON.stringify(msg));
    });
  }

  function remoteWsSend(msg) {
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // 上传附件到远程（通过 WS，跨源无法用 HTTP+cookie）
  async function uploadAttachmentRemote(att) {
    try {
      let dataUrl;
      if (att.file && att.file.arrayBuffer) {
        const buf = await att.file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        dataUrl = `data:${att.type || 'application/octet-stream'};base64,${btoa(bin)}`;
      } else if (att.path) {
        // 本地路径文件：通过 preload 读取
        const r = await window.api.readFileBase64?.(att.path);
        if (r?.ok && r.data) dataUrl = r.data;
      }
      if (!dataUrl) return null;
      const resp = await remoteWsRequest({ type: 'uploadAttachment', name: att.name, type: att.type, data: dataUrl }, 'uploadResult');
      if (resp.ok) return { name: resp.name, path: resp.path, type: resp.type };
      return null;
    } catch (e) { console.error('[Remote] 附件上传失败:', e); return null; }
  }

  // ---- Remote 镜像应用函数（与 WebUI 客户端逻辑一致）----
  let _remoteApplying = false; // 防止事件委托反馈循环
  let _remoteEventHandlers = null; // 事件委托处理器引用
  let _remoteBodyChunks = null; // 分块 mirror_body 重组缓冲区

  // 本地控制元素：不被远端镜像覆盖（Local/Remote 切换器、远程连接模态框、连接横幅）
  function _isLocalControlEl(el) {
    if (!el || el.nodeType !== 1) return false;
    return !!(el.closest('#connection-switcher') || el.closest('#remote-connect-modal') ||
              el.closest('#remote-conn-banner') || el.closest('#titlebar'));
  }

  // CSS path 生成（与 WebUI 客户端 cssPath 一致）
  function remoteCssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var selector = cur.nodeName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var parent = cur.parentNode;
      if (parent && parent.children) {
        var typeIdx = 1;
        var sib = cur.previousElementSibling;
        while (sib) {
          if (sib.nodeName.toLowerCase() === selector) typeIdx++;
          sib = sib.previousElementSibling;
        }
        var sameType = 0;
        for (var si = 0; si < parent.children.length; si++) {
          if (parent.children[si].nodeName.toLowerCase() === selector) sameType++;
        }
        if (sameType > 1) selector += ':nth-of-type(' + typeIdx + ')';
      }
      if (cur.className && typeof cur.className === 'string') {
        var cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector += '.' + cls;
      }
      parts.unshift(selector);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }

  function applyRemoteHead(msg) {
    _remoteApplying = true;
    try {
      var html = msg.html || '';
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      if (msg.theme_mode) document.documentElement.setAttribute('data-theme', msg.theme_mode);
      var head = document.head;
      // 移除已有的渲染器 CSS（保留 FA 链接和 shell 样式）
      var toRemove = head.querySelectorAll('link:not([href*="fontawesome"]),style:not([data-shell])');
      for (var i = 0; i < toRemove.length; i++) toRemove[i].remove();
      // 插入远端 head 内容
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var nodes = tmp.querySelectorAll('link,style');
      for (var j = 0; j < nodes.length; j++) head.appendChild(nodes[j].cloneNode(true));
    } catch (e) { console.error('[Remote] applyHead error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteBody(msg) {
    _remoteApplying = true;
    try {
      // Remote 端保留本地标题栏（含 Local/Remote 切换器、窗口控制按钮），
      // 不用主机的 titlebar 覆盖 —— 否则远端将无法切换回 Local 模式。
      // 对话标题通过单独的 dom_text 事件同步到 #titlebar-title。
      var app = document.getElementById('app');
      if (!app) return;
      app.innerHTML = msg.html || '';
      // canvas 替换为占位符（canvas 内容无法镜像）
      var canvases = app.querySelectorAll('canvas');
      for (var c = 0; c < canvases.length; c++) {
        var cv = canvases[c];
        var div = document.createElement('div');
        div.style.cssText = 'width:' + (cv.style.width || '100%') + ';height:' + (cv.style.height || '200px') + ';min-height:100px;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary,#ebebeb);color:var(--text-tertiary,#999);font-size:12px;border-radius:4px;';
        div.textContent = '[Canvas 内容不可镜像]';
        if (cv.parentNode) cv.parentNode.replaceChild(div, cv);
      }
      // 恢复本地连接横幅状态（远端 mirror_body 可能覆盖它）
      var banner = app.querySelector('#remote-conn-banner');
      if (banner) { banner.classList.add('hidden'); banner.setAttribute('data-state', 'connected'); }
    } catch (e) { console.error('[Remote] applyBody error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  function applyRemoteDomClear(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = ''; }
    catch (e) { console.error('[Remote] dom_clear error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomReplace(msg) {
    _remoteApplying = true;
    try { var c = document.querySelector(msg.container); if (c && !_isLocalControlEl(c)) c.innerHTML = msg.html || ''; }
    catch (e) { console.error('[Remote] dom_replace error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomRemove(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.remove(); }
    catch (e) { console.error('[Remote] dom_remove error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomUpdate(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (!el || _isLocalControlEl(el)) return;
      if (msg.attr !== undefined) {
        el.setAttribute(msg.attr, msg.value != null ? msg.value : '');
      } else if (msg.html !== undefined && el.outerHTML) {
        el.outerHTML = msg.html;
      }
    } catch (e) { console.error('[Remote] dom_update error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomText(msg) {
    _remoteApplying = true;
    try { var el = document.querySelector(msg.selector); if (el && !_isLocalControlEl(el)) el.textContent = msg.text != null ? msg.text : ''; }
    catch (e) { console.error('[Remote] dom_text error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomAppend(msg) {
    _remoteApplying = true;
    try {
      var c = document.querySelector(msg.container);
      if (c && !_isLocalControlEl(c)) {
        var tmp = document.createElement('div');
        tmp.innerHTML = msg.html || '';
        while (tmp.firstChild) c.appendChild(tmp.firstChild);
        // 自动滚屏（聊天容器）
        var chatContainers = ['#chat-messages', '#code-chat-messages', '#babe-chat-messages'];
        for (var i = 0; i < chatContainers.length; i++) {
          if (c.closest(chatContainers[i])) { c.scrollTop = c.scrollHeight; break; }
        }
      }
    } catch (e) { console.error('[Remote] dom_append error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }
  function applyRemoteDomValue(msg) {
    _remoteApplying = true;
    try {
      var el = document.querySelector(msg.selector);
      if (el && !_isLocalControlEl(el) && 'value' in el) {
        el.value = msg.value != null ? msg.value : '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) { console.error('[Remote] dom_value error:', e); }
    finally { setTimeout(function() { _remoteApplying = false; }, 20); }
  }

  // ---- 事件委托：Remote 模式下所有交互通过 ui_event 转发到远端 ----
  function enableRemoteEventDelegation() {
    if (_remoteEventHandlers) return; // 已启用
    var sendEvent = function(evtType, target, extra) {
      if (_remoteApplying || !remoteWs || remoteWs.readyState !== 1) return;
      // 跳过本地控制元素（连接切换器、远程模态框、横幅）
      if (target.closest('#connection-switcher') || target.closest('#remote-connect-modal') ||
          target.closest('#remote-conn-banner')) return;
      var path = remoteCssPath(target);
      if (!path) return;
      var data = { type: 'ui_event', event: evtType, target: path };
      if (extra) for (var k in extra) data[k] = extra[k];
      remoteWsSend(data);
    };
    var clickHandler = function(e) {
      if (_remoteApplying) return;
      // 拦截 Markdown 链接：http/https 链接在本地新标签页打开，不转发到远端
      var link = e.target.closest('a');
      if (link) {
        var href = link.getAttribute('href');
        if (href && (href.indexOf('http://') === 0 || href.indexOf('https://') === 0)) {
          e.preventDefault(); e.stopPropagation();
          window.open(href, '_blank');
          return;
        }
        e.preventDefault();
      }
      sendEvent('click', e.target);
    };
    var inputHandler = function(e) {
      if (_remoteApplying) return;
      sendEvent('input', e.target, { value: e.target.value });
    };
    var changeHandler = function(e) {
      if (_remoteApplying) return;
      // 文件输入：读取为 base64 并上传
      if (e.target.type === 'file' && e.target.files && e.target.files.length > 0) {
        var file = e.target.files[0];
        var reader = new FileReader();
        reader.onload = function() {
          var dataUrl = reader.result;
          var base64 = dataUrl.split(',')[1];
          remoteWsSend({ type: 'uploadAttachment', name: file.name, type: file.type, data: base64 });
        };
        reader.readAsDataURL(file);
        return;
      }
      sendEvent('change', e.target, { value: e.target.value, checked: e.target.checked });
    };
    var submitHandler = function(e) {
      if (_remoteApplying) return;
      e.preventDefault();
      sendEvent('submit', e.target);
    };
    // keydown 委托：处理输入框的 Enter 发送（applyRemoteBody 替换 DOM 后原始监听器会丢失）
    var keydownHandler = function(e) {
      if (_remoteApplying) return;
      // 只处理 Enter 键（发送）和 Shift+Enter（换行，不转发）
      if (e.key !== 'Enter' || e.shiftKey) return;
      var target = e.target;
      // 匹配各模式的输入框
      var isChatInput = target.id === 'chat-input' || target.id === 'code-chat-input' || target.id === 'babe-chat-input';
      if (!isChatInput) return;
      // Remote 模式下直接调用本地 sendMessage（sendMessage 内部会转发到 WS）
      e.preventDefault();
      if (target.id === 'chat-input') sendMessage();
      else if (target.id === 'code-chat-input') sendCodeMessage();
      else if (target.id === 'babe-chat-input') sendBabeMessage();
    };
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('input', inputHandler, true);
    document.addEventListener('change', changeHandler, true);
    document.addEventListener('submit', submitHandler, true);
    document.addEventListener('keydown', keydownHandler, true);
    _remoteEventHandlers = { clickHandler: clickHandler, inputHandler: inputHandler, changeHandler: changeHandler, submitHandler: submitHandler, keydownHandler: keydownHandler };
    console.log('[Remote] 事件委托已启用');
  }

  function disableRemoteEventDelegation() {
    if (!_remoteEventHandlers) return;
    document.removeEventListener('click', _remoteEventHandlers.clickHandler, true);
    document.removeEventListener('input', _remoteEventHandlers.inputHandler, true);
    document.removeEventListener('change', _remoteEventHandlers.changeHandler, true);
    document.removeEventListener('submit', _remoteEventHandlers.submitHandler, true);
    document.removeEventListener('keydown', _remoteEventHandlers.keydownHandler, true);
    _remoteEventHandlers = null;
    console.log('[Remote] 事件委托已停用');
  }

  // 处理远程推送的消息（服务端 WS 协议）
  // Remote 模式采用镜像机制：直接应用 mirror_head/mirror_body/dom_* 到本地 DOM，
  // 与 WebUI 浏览器客户端行为一致。语义消息（message/status/tarot 等）由 dom_* 覆盖，不再处理。
  function handleRemoteMessage(data) {
    if (!data?.type) return;
    // 1. 响应类消息分发到挂起的请求
    const pending = _remoteWsPendingByType.get(data.type);
    if (pending) {
      _remoteWsPendingByType.delete(data.type);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    switch (data.type) {
      case 'init':
        // 连接已建立：设置本地状态，等待 mirror_head + mirror_body 到达
        isRemoteMode = true;
        remoteIntentionalClose = false;
        fadeOutHide(document.getElementById('remote-connect-modal'));
        const statusEl0 = document.getElementById('remote-status');
        if (statusEl0) statusEl0.textContent = '已连接，可远程操作';
        setRemoteBanner('connected');
        // 启用事件委托：所有交互通过 ui_event 转发到远端
        enableRemoteEventDelegation();
        // 请求模式 / 上下文 / 重新优化按钮的快照
        remoteWsSend({ type: 'requestState' });
        break;

      // ---- 镜像消息：直接应用到本地 DOM（与 WebUI 客户端一致）----
      case 'mirror_head':
        applyRemoteHead(data);
        break;
      case 'mirror_body':
        applyRemoteBody(data);
        break;
      case 'mirror_body_start':
        _remoteBodyChunks = { transferId: data.transferId, chunks: new Array(data.totalChunks), totalChunks: data.totalChunks, received: 0 };
        break;
      case 'mirror_body_chunk':
        if (_remoteBodyChunks && _remoteBodyChunks.transferId === data.transferId) {
          _remoteBodyChunks.chunks[data.index] = data.chunk;
          _remoteBodyChunks.received++;
        }
        break;
      case 'mirror_body_end':
        if (_remoteBodyChunks && _remoteBodyChunks.transferId === data.transferId) {
          try {
            var fullJson = _remoteBodyChunks.chunks.join('');
            var snapshot = JSON.parse(fullJson);
            applyRemoteBody(snapshot);
          } catch (e) { console.error('[Remote] Failed to reassemble chunked mirror_body:', e); }
          _remoteBodyChunks = null;
        }
        break;
      case 'dom_clear':
        applyRemoteDomClear(data);
        break;
      case 'dom_replace':
        applyRemoteDomReplace(data);
        break;
      case 'dom_remove':
        applyRemoteDomRemove(data);
        break;
      case 'dom_update':
        applyRemoteDomUpdate(data);
        break;
      case 'dom_append':
        applyRemoteDomAppend(data);
        break;
      case 'dom_text':
        applyRemoteDomText(data);
        break;
      case 'dom_value':
        applyRemoteDomValue(data);
        break;

      // ---- UI 状态消息（镜像不覆盖的特殊状态）----
      case 'theme':
        applyRemoteTheme(data.theme);
        break;
      case 'modeSwitch':
        // 镜像模式下页面切换由 dom_update 处理，这里仅同步按钮高亮
        handleRemoteModeSwitch(data.mode);
        break;
      case 'contextProgress':
        updateRemoteContextProgress(data.data);
        break;
      case 'reoptimizeState':
        if (btnReoptimizeTools) btnReoptimizeTools.classList.toggle('hidden', !data.visible);
        break;
      case 'approval':
        if (data.toolName) showApprovalPanel(data.toolName, data.args);
        break;
      case 'approvalCleared':
        hideApprovalPanelRemote();
        break;
      case 'stateSnapshot':
        if (data.mode) handleRemoteModeSwitch(data.mode);
        if (data.contextProgress) updateRemoteContextProgress(data.contextProgress);
        if (btnReoptimizeTools) btnReoptimizeTools.classList.toggle('hidden', !data.reoptimizeVisible);
        break;
      case 'auth_fail':
        // 认证失败：显示错误，关闭连接
        const statusEl = document.getElementById('remote-status');
        if (statusEl) statusEl.textContent = data.error || '认证失败';
        setRemoteBanner('error', data.error || '认证失败');
        remoteIntentionalClose = true;
        if (remoteWs) { try { remoteWs.close(); } catch (_) {} remoteWs = null; }
        isRemoteMode = false;
        disableRemoteEventDelegation();
        break;
      case 'requestFileDownload': {
        // 远端请求下载文件（Remote 模式下本地渲染器是 Agent 端）
        if (data.path) {
          window.api.readFileBase64(data.path).then(function(result) {
            if (!result.ok) {
              remoteWsSend({ type: 'fileDownloadResponse', ok: false, error: result.error, filename: data.filename });
              return;
            }
            // 提取纯 base64 数据（去掉 data URL 前缀）
            var base64 = (result.data || '').replace(/^data:[^;]+;base64,/, '');
            remoteWsSend({
              type: 'fileDownloadResponse',
              ok: true,
              filename: data.filename,
              data: base64,
              mimeType: result.mime || 'application/octet-stream'
            });
          });
        }
        break;
      }
      case 'fileDownloadResponse': {
        // 远端回传的文件数据，在本地触发下载
        if (data.ok && data.data) {
          _triggerBlobDownload(data.data, data.filename, data.mimeType);
        } else {
          console.error('[Remote] 文件下载失败:', data.error);
        }
        break;
      }

      // ---- 以下语义消息在镜像模式下由 dom_* 覆盖，不再单独处理 ----
      // message, messagesSync, status, title, tarot, avatars, toolCall, conversationSwitch
      case 'history':
      case 'conversationDeleted':
        // 已被 remoteWsRequest 消费；此处仅为兜底
        break;
      default:
        break;
    }
  }

  function applyRemoteTheme(t) {
    if (!t) return;
    const root = document.documentElement;
    if (t.accent) root.style.setProperty('--accent', t.accent);
    if (t.accentLight) root.style.setProperty('--accent-light', t.accentLight);
    if (t.accentDark) root.style.setProperty('--accent-dark', t.accentDark);
    if (t.accentBg) {
      root.style.setProperty('--accent-bg', t.accentBg);
      root.style.setProperty('--accent-bg-hover', t.accentBg.replace('0.08', '0.14'));
    }
    if (t.bgPrimary) root.style.setProperty('--bg-primary', t.bgPrimary);
    if (t.bgSecondary) root.style.setProperty('--bg-secondary', t.bgSecondary);
    if (t.bgTertiary) root.style.setProperty('--bg-tertiary', t.bgTertiary);
    if (t.bgHover) root.style.setProperty('--bg-hover', t.bgHover);
    if (typeof t.isDark === 'boolean') {
      root.setAttribute('data-theme', t.isDark ? 'dark' : 'light');
    }
  }

  // 远端模式切换：仅同步按钮高亮，不导航、不回推，避免循环
  function handleRemoteModeSwitch(mode) {
    if (!mode || mode === currentMode) return;
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const nameEl = document.getElementById('agent-name-display');
    if (nameEl) {
      if (mode === 'code') nameEl.textContent = 'Coding Agent';
      else if (mode === 'babe') nameEl.textContent = 'Babe';
      else nameEl.textContent = 'AI Agent';
    }
  }

  function updateRemoteContextProgress(d) {
    if (!d) return;
    const fill = document.getElementById('context-progress-fill');
    const text = document.getElementById('context-progress-text');
    const ind = document.getElementById('chat-context-indicator');
    const pct = Math.min(100, Math.max(0, d.percentage || 0));
    const circumference = 100;
    const dashLen = (pct / 100) * circumference;
    if (fill) fill.setAttribute('stroke-dasharray', `${dashLen} ${circumference}`);
    if (text) {
      const used = d.used || 0, max = d.max || 8192;
      const fmt = (n) => fmtTokenCount(n);
      text.textContent = `${fmt(used)}/${fmt(max)}`;
    }
    if (ind) {
      if (d.used != null) ind.dataset.used = d.used;
      if (d.max != null) ind.dataset.max = d.max;
      if (pct >= 85) ind.dataset.level = 'danger';
      else if (pct >= 65) ind.dataset.level = 'warn';
      else ind.dataset.level = 'normal';
      ind.title = `上下文使用量: ${d.used || 0}/${d.max || 8192} (${Math.round(pct)}%)`;
    }
  }

  function hideApprovalPanelRemote() {
    if (approvalPanel) approvalPanel.classList.add('hidden');
  }

  function updateReoptimizeButtonVisibility() {
    if (!btnReoptimizeTools) return;
    // Code 模式不使用自动优化，隐藏按钮
    // Babe 模式同理（Babe 有独立的 context-indicator）
    const currentAgent = currentMode === 'code' ? codeAgent : (currentMode === 'babe' ? babeAgent : agent);
    const visible = currentMode === 'chat'
      && !!agent.settings?.autoOptimizeToolSelection
      && !(agent.sessionAutoOptimizeDisabled);
    btnReoptimizeTools.classList.toggle('hidden', !visible);
    // 同步重新优化按钮可见性到 WebUI
    try { window.api.webControlPushReoptimizeState(visible); } catch (_) {}
  }

  // 更新上下文进度条函数
  // 通用：更新指定 agent 的上下文圆扇形指示器
  function updateAgentContextProgress(agentInstance, fillId, textId) {
    if (!agentInstance || !agentInstance.contextManager) return;
    const cm = agentInstance.contextManager;
    const stats = cm.getStats ? cm.getStats() : null;
    const progressFill = document.getElementById(fillId);
    const progressText = document.getElementById(textId);
    if (!progressFill || !progressText) return;
    const indicator = progressFill.closest('.context-indicator');
    const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
    const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
    const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
    const toolDefsTokens = Math.ceil(JSON.stringify(
      (typeof agentInstance.getRuntimeToolSchemas === 'function')
        ? agentInstance.getRuntimeToolSchemas()
        : (typeof getToolSchemas === 'function' ? getToolSchemas(agentInstance.settings?.tools || {}) : [])
    ).length / 4);

    let chatTokens = 0;
    let toolResultTokens = 0;
    (cm.messages || []).forEach(msg => {
      if (!msg) return;
      if (msg.role === 'tool') {
        toolResultTokens += estimateMsg(msg);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        chatTokens += estimateMsg(msg);
      }
    });

    const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
    const otherTokens = Math.max(0, summaryTokens);
    const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
    const maxTokens = stats?.maxTokens ?? (agentInstance.settings?.llm?.maxContextLength || 0);
    // 输出预留：为模型生成回复保留 maxResponseTokens 的空间
    // 总占用 = 当前输入 token + 输出预留，分母为完整上下文窗口 maxTokens
    // （不再用 maxTokens - maxResponseTokens 做分母，避免输出预留被计算两次的错觉）
    const maxResponseTokens = agentInstance.settings?.llm?.maxResponseTokens || 8192;
    const totalOccupied = tokens + maxResponseTokens;
    const effectiveMax = maxTokens;
    const percentage = maxTokens ? Math.min(100, (totalOccupied / maxTokens) * 100) : 0;
    const inputOnlyPct = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;

    // 更新 SVG 圆扇形：已用段实色 + 输出预留段半透明。
    // 圆周长 = 2 * PI * r = 2 * PI * 15.915 ≈ 100，所以直接用百分比。
    const usedPct = Math.min(100, inputOnlyPct);
    const reservePct = Math.max(0, Math.min(100, percentage - usedPct));
    progressFill.setAttribute('stroke-dasharray', `${usedPct} ${100 - usedPct}`);
    if (indicator) {
      const reserveFill = indicator.querySelector('.context-ring-reserve');
      if (reserveFill) {
        reserveFill.setAttribute('stroke-dasharray', `${reservePct} 100`);
        reserveFill.setAttribute('stroke-dashoffset', `${-usedPct}`);
      }
    }
    // 文本：精简显示（≥1K 用 K，≥1M 用 M，≥1G/T/P 用对应单位），显示当前占用+输出预留 / 完整上下文窗口
    const fmt = (n) => fmtTokenCount(n);
    progressText.textContent = `${fmt(totalOccupied)}/${fmt(effectiveMax)}`;

    // 颜色级别
    if (indicator) {
      indicator.dataset.used = totalOccupied;
      indicator.dataset.max = effectiveMax;
      if (percentage >= 95) indicator.dataset.level = 'danger';
      else if (percentage >= 80) indicator.dataset.level = 'warn';
      else indicator.dataset.level = 'normal';
      // 更新/创建 tooltip
      let tooltip = indicator.querySelector('.context-tooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'context-tooltip';
        indicator.appendChild(tooltip);
      }
      // 绘制迷你扇形图 + 细化占比（已用实色 + 预留半透明）
      const segPct = (v, total) => total > 0 ? (v/total*100).toFixed(1) : '0';
      const miniR = 12, miniCx = 15, miniCy = 15, miniCircum = 2 * Math.PI * miniR;
      const sysPct = (systemGuidanceTokens / Math.max(1, tokens)) * 100;
      const toolPct = (toolDefsTokens / Math.max(1, tokens)) * 100;
      const chatPct = (chatTokens / Math.max(1, tokens)) * 100;
      const toolResPct = (toolResultTokens / Math.max(1, tokens)) * 100;
      const miniUsedLen = (usedPct / 100 * miniCircum);
      const miniReserveLen = (reservePct / 100 * miniCircum);
      tooltip.innerHTML = `
        <div class="context-tooltip-title">上下文使用详情</div>
        <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${miniUsedLen.toFixed(1)} ${miniCircum.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <circle cx="${miniCx}" cy="${miniCy}" r="${miniR}" fill="none" stroke="var(--accent)" stroke-width="4" opacity="0.32"
          stroke-dasharray="${miniReserveLen.toFixed(1)} ${miniCircum.toFixed(1)}"
          stroke-dashoffset="${(-miniUsedLen).toFixed(1)}" transform="rotate(-90 ${miniCx} ${miniCy})"/>
          <text x="${miniCx}" y="${miniCy+3}" text-anchor="middle" font-size="9" fill="var(--text-primary)">${percentage.toFixed(0)}%</text>
        </svg>
        <div class="context-tooltip-row"><span>系统指导</span><span>${systemGuidanceTokens} (${segPct(systemGuidanceTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具定义</span><span>${toolDefsTokens} (${segPct(toolDefsTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>聊天记录</span><span>${chatTokens} (${segPct(chatTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>工具结果</span><span>${toolResultTokens} (${segPct(toolResultTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row"><span>其他</span><span>${otherTokens} (${segPct(otherTokens, tokens)}%)</span></div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
          <span>当前输入</span><span>${tokens} / ${maxTokens}</span>
        </div>
        <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
          <span>输出预留</span><span>${maxResponseTokens}</span>
        </div>
        <div class="context-tooltip-row"><span>占比（含预留）</span><span>${percentage.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputOnlyPct.toFixed(1)}%</span></div>
        <div class="context-tooltip-row" style="font-weight:600">
          <span>总占用</span><span>${fmt(totalOccupied)} / ${fmt(effectiveMax)}</span>
        </div>
        ${renderSessionTokenStats(agentInstance)}
      `;
    }
  }

  // 渲染当前会话的累计 Token 统计和费用（从 agent.sessionUsage 累计）
  function renderSessionTokenStats(agentInstance) {
    const su = agentInstance?.sessionUsage;
    if (!su) return '';
    // API 未返回 usage 时使用估算值，数字前加 ~ 前缀标识
    const pfx = su.estimated ? '~' : '';
    // ≥1M 用 M（非 10M），≥1G/T/P 用对应单位（防御性编程）
    const fmt = (n) => fmtTokenCount(n, pfx);
    const cachedPct = su.prompt > 0 ? (su.cached / su.prompt * 100).toFixed(1) : '0.0';
    const esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    // 按模型分桶：混合模型会话按各自单价计价并求和
    const byModel = agentInstance?.sessionUsageByModel || {};
    const entries = Object.entries(byModel)
      .filter(([, u]) => u && (u.total > 0 || u.prompt > 0 || u.completion > 0));
    let perModelRows = '';
    let totalCost = 0;
    let pricedCount = 0;
    if (entries.length > 0) {
      const rows = [];
      for (const [model, mu] of entries) {
        const cost = computeSessionCostForModel(agentInstance, model, mu);
        if (cost) { totalCost += cost.totalCost; pricedCount++; }
        rows.push(`<div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)"><span>　${esc(model)}</span><span>${fmt(mu.total)}${cost ? ` · $${cost.totalCost.toFixed(5)}` : ''}</span></div>`);
      }
      perModelRows = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px;font-weight:600"><span>按模型明细</span><span></span></div>` + rows.join('');
    }
    // 总费用：有分桶时按模型求和；旧数据（无分桶）回退到当前模型单价 × 扁平总量
    let costRow = '';
    if (entries.length > 0) {
      if (pricedCount > 0) {
        costRow = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px"><span>费用（合计）</span><span>$${totalCost.toFixed(5)}</span></div>`;
      }
    } else {
      const activeModel = (typeof agentInstance?.getActiveModelId === 'function')
        ? agentInstance.getActiveModelId() : agentInstance?.settings?.llm?.model;
      const cost = computeSessionCostForModel(agentInstance, activeModel, su);
      if (cost) {
        costRow = `<div class="context-tooltip-row" style="border-top:1px solid var(--border);padding-top:4px">
          <span>费用（${esc(cost.pricing.model)}）</span><span>$${cost.totalCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　输入</span><span>$${cost.inputCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　输出</span><span>$${cost.outputCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　缓存读</span><span>$${cost.cacheReadCost.toFixed(5)}</span>
        </div>
        <div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)">
          <span>　缓存写</span><span>$${cost.cacheWriteCost.toFixed(5)}</span>
        </div>${cost.pricing.hasCacheWrite ? '' : '<div class="context-tooltip-row" style="font-size:10px;color:var(--text-tertiary)"><span>　(此模型不计缓存写入费)</span></div>'}`;
      }
    }
    return `
      <div class="context-tooltip-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;font-weight:600">
        <span>会话累计 Token${su.estimated ? ' <span style="font-size:10px;color:var(--text-tertiary);font-weight:normal">(估算)</span>' : ''}</span><span></span>
      </div>
      <div class="context-tooltip-row"><span>　输入</span><span>${fmt(su.prompt)}</span></div>
      <div class="context-tooltip-row"><span>　输出</span><span>${fmt(su.completion)}</span></div>
      <div class="context-tooltip-row"><span>　总计</span><span>${fmt(su.total)}</span></div>
      ${su.cached > 0 ? `<div class="context-tooltip-row"><span>　缓存命中</span><span>${fmt(su.cached)} (${cachedPct}%)</span></div>` : ''}
      ${su.cacheCreation > 0 ? `<div class="context-tooltip-row"><span>　缓存创建</span><span>${fmt(su.cacheCreation || 0)}</span></div>` : ''}
      ${perModelRows}
      ${costRow}
    `;
  }

  // 计算某模型的会话费用（含峰谷倍率）。无价格配置返回 null。
  function computeSessionCostForModel(agentInstance, model, usage) {
    const pricing = getSessionPricing(agentInstance, model);
    if (!pricing) return null;
    const su = usage || {};
    const toPerM = (v, isPerK) => isPerK ? (Number(v) || 0) * 1000 : (Number(v) || 0);
    const inputPerM = toPerM(pricing.inputPerM ?? pricing.promptPerK, !pricing.inputPerM && !!pricing.promptPerK);
    const cacheReadPerM = pricing.cacheReadPerM != null ? Number(pricing.cacheReadPerM) : inputPerM * 0.1;
    const outputPerM = toPerM(pricing.outputPerM ?? pricing.completionPerK, !pricing.outputPerM && !!pricing.completionPerK);
    const cacheWritePerM = pricing.hasCacheWrite
      ? (pricing.cacheWritePerM != null ? Number(pricing.cacheWritePerM) : inputPerM * 1.25)
      : 0;
    const ph = agentInstance?.settings?.budget?.peakHours || {};
    let inMul = 1, crMul = 1, outMul = 1, cwMul = 1;
    if (ph.enabled) {
      const hour = new Date().getHours();
      const s = Number(ph.start) ?? 0;
      const e = Number(ph.end) ?? 24;
      const isPeak = s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
      if (isPeak) {
        inMul = Number(ph.inputMul) || 1;
        crMul = Number(ph.cacheReadMul) || 1;
        outMul = Number(ph.outputMul) || 1;
        cwMul = Number(ph.cacheWriteMul) || 1;
      }
    }
    const nonCachedPrompt = Math.max(0, (su.prompt || 0) - (su.cached || 0) - (su.cacheCreation || 0));
    const inputCost = (nonCachedPrompt / 1e6) * inputPerM * inMul;
    const cacheReadCost = ((su.cached || 0) / 1e6) * cacheReadPerM * crMul;
    const outputCost = ((su.completion || 0) / 1e6) * outputPerM * outMul;
    const cacheWriteCost = ((su.cacheCreation || 0) / 1e6) * cacheWritePerM * cwMul;
    return {
      inputCost, cacheReadCost, outputCost, cacheWriteCost,
      totalCost: inputCost + cacheReadCost + outputCost + cacheWriteCost,
      pricing
    };
  }

  // 获取当前会话所用模型的单价配置（来自 settings.budget.models）
  // 支持新格式（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM/hasCacheWrite）
  // 和旧格式（promptPerK/completionPerK）回退
  function getSessionPricing(agentInstance, modelId) {
    try {
      const model = modelId || agentInstance?.settings?.llm?.model;
      if (!model) return null;
      const prices = agentInstance?.settings?.budget?.models || {};
      const p = prices[model];
      if (!p) return null;
      // 优先识别新格式字段
      const hasNew = p.inputPerM != null || p.outputPerM != null || p.cacheReadPerM != null || p.cacheWritePerM != null;
      const hasOld = p.promptPerK != null || p.completionPerK != null;
      if (!hasNew && !hasOld) return null;
      // hasCacheWrite 显式配置优先，否则按模型名推断（Claude 系默认 true）
      const hasCacheWrite = p.hasCacheWrite != null ? !!p.hasCacheWrite : /claude/i.test(model);
      return {
        model,
        inputPerM: p.inputPerM,
        cacheReadPerM: p.cacheReadPerM,
        outputPerM: p.outputPerM,
        cacheWritePerM: p.cacheWritePerM,
        // 旧字段保留以便回退
        promptPerK: p.promptPerK,
        completionPerK: p.completionPerK,
        hasCacheWrite
      };
    } catch { return null; }
  }

  // 模式 agent 未初始化时，用主 agent 的共享系统指导 + 工具定义估算上下文占用，
  // 并渲染完整的上下文 tooltip（对齐 Chat 模式，避免显示 0）
  function ensureFallbackContext(ind, fill, textEl, sharedMaxCtx) {
    if (!ind) return;
    ind.dataset.used = 0;
    ind.dataset.max = sharedMaxCtx;
    ind.dataset.level = 'normal';
    let sysT = 0, toolT = 0;
    try {
      const cm = agent?.contextManager;
      const sysP = cm?.systemPrompt;
      if (sysP) {
        sysT = cm.estimateMessageTokens ? cm.estimateMessageTokens(sysP) : Math.ceil(String(sysP).length / 4);
      }
      const schemas = (typeof agent?.getRuntimeToolSchemas === 'function')
        ? agent.getRuntimeToolSchemas()
        : (typeof getToolSchemas === 'function' ? getToolSchemas(agent?.settings?.tools || {}) : []);
      toolT = Math.ceil(JSON.stringify(schemas || []).length / 4);
    } catch (_) {}
    const maxResp = agent?.settings?.llm?.maxResponseTokens || 8192;
    const tokens = sysT + toolT;
    const total = tokens + maxResp;
    const pct = sharedMaxCtx ? Math.min(100, (total / sharedMaxCtx) * 100) : 0;
    const inputPct = sharedMaxCtx ? Math.min(100, (tokens / sharedMaxCtx) * 100) : 0;
    const seg = (v) => (v > 0 ? (v / tokens * 100).toFixed(1) : '0');
    if (textEl) textEl.textContent = `${fmtTokenCount(total)}/${fmtTokenCount(sharedMaxCtx)}`;
    if (fill) {
      const usedPct = Math.min(100, inputPct);
      const reservePct = Math.max(0, Math.min(100, pct - usedPct));
      fill.setAttribute('stroke-dasharray', `${usedPct} ${100 - usedPct}`);
      const reserveFill = ind.querySelector('.context-ring-reserve');
      if (reserveFill) {
        reserveFill.setAttribute('stroke-dasharray', `${reservePct} 100`);
        reserveFill.setAttribute('stroke-dashoffset', `${-usedPct}`);
      }
    }
    // 创建/重建 tooltip
    let tooltip = ind.querySelector('.context-tooltip');
    if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'context-tooltip'; ind.appendChild(tooltip); }
    const cc = 2 * Math.PI * 12;
    const usedLen = (inputPct / 100 * cc);
    const reserveLen = (Math.max(0, Math.min(100, pct - inputPct)) / 100 * cc);
    tooltip.innerHTML = `
      <div class="context-tooltip-title">上下文使用详情</div>
      <svg class="context-tooltip-mini-ring" viewBox="0 0 30 30" width="60" height="60">
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--bg-tertiary)" stroke-width="4"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--accent)" stroke-width="4"
          stroke-dasharray="${usedLen.toFixed(1)} ${cc.toFixed(1)}"
          stroke-dashoffset="0" transform="rotate(-90 15 15)"/>
        <circle cx="15" cy="15" r="12" fill="none" stroke="var(--accent)" stroke-width="4" opacity="0.32"
          stroke-dasharray="${reserveLen.toFixed(1)} ${cc.toFixed(1)}"
          stroke-dashoffset="${(-usedLen).toFixed(1)}" transform="rotate(-90 15 15)"/>
        <text x="15" y="18" text-anchor="middle" font-size="9" fill="var(--text-primary)">${pct.toFixed(0)}%</text>
      </svg>
      <div class="context-tooltip-row"><span>系统指导</span><span>${sysT} (${seg(sysT)}%)</span></div>
      <div class="context-tooltip-row"><span>工具定义</span><span>${toolT} (${seg(toolT)}%)</span></div>
      <div class="context-tooltip-row"><span>聊天记录</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row"><span>工具结果</span><span>0 (0%)</span></div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600">
        <span>当前输入</span><span>${fmtTokenCount(tokens)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>
      <div class="context-tooltip-row" style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-weight:600;color:var(--accent)">
        <span>输出预留</span><span>${fmtTokenCount(maxResp)}</span>
      </div>
      <div class="context-tooltip-row"><span>占比（含预留）</span><span>${pct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="color:var(--text-tertiary)"><span>占比（仅输入）</span><span>${inputPct.toFixed(1)}%</span></div>
      <div class="context-tooltip-row" style="font-weight:600">
        <span>总占用</span><span>${fmtTokenCount(total)} / ${fmtTokenCount(sharedMaxCtx)}</span>
      </div>`;
  }

  function updateContextProgress() {
    updateAgentContextProgress(agent, 'context-progress-fill', 'context-progress-text');
    // Code / Babe 圆扇形：agent 已初始化时用其 contextManager，否则回退到已加载的 settings 值
    const sharedMaxCtx = agent?.settings?.llm?.maxContextLength || 131072;
    try {
      if (codeAgent) {
        updateAgentContextProgress(codeAgent, 'code-context-progress-fill', 'code-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('code-context-indicator'),
          document.getElementById('code-context-progress-fill'),
          document.getElementById('code-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* codeAgent TDZ */ }
    try {
      if (babeAgent) {
        updateAgentContextProgress(babeAgent, 'babe-context-progress-fill', 'babe-context-progress-text');
      } else {
        ensureFallbackContext(
          document.getElementById('babe-context-indicator'),
          document.getElementById('babe-context-progress-fill'),
          document.getElementById('babe-context-progress-text'),
          sharedMaxCtx
        );
      }
    } catch (_) { /* babeAgent TDZ */ }
    // 同步主对话的上下文进度到 WebUI（按当前模式推送对应 agent 的数据）
    try {
      const targetAgent = (currentMode === 'code' && codeAgent) ? codeAgent
        : (currentMode === 'babe' && babeAgent) ? babeAgent
        : agent;
      if (targetAgent && targetAgent.contextManager) {
        const cm = targetAgent.contextManager;
        const stats = cm.getStats ? cm.getStats() : null;
        const estimateMsg = (msg) => (cm.estimateMessageTokens ? cm.estimateMessageTokens(msg) : 0);
        const estimateText = (text) => (cm.estimateTokens ? cm.estimateTokens(text) : 0);
        const systemGuidanceTokens = cm.systemPrompt ? estimateMsg(cm.systemPrompt) : 0;
        const toolDefsTokens = Math.ceil(JSON.stringify(
          (typeof targetAgent.getRuntimeToolSchemas === 'function')
            ? targetAgent.getRuntimeToolSchemas()
            : []
        ).length / 4);
        let chatTokens = 0, toolResultTokens = 0;
        (cm.messages || []).forEach(msg => {
          if (!msg) return;
          if (msg.role === 'tool') toolResultTokens += estimateMsg(msg);
          else if (msg.role === 'user' || msg.role === 'assistant') chatTokens += estimateMsg(msg);
        });
        const summaryTokens = (cm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
        const otherTokens = Math.max(0, summaryTokens);
        const tokens = systemGuidanceTokens + toolDefsTokens + chatTokens + toolResultTokens + otherTokens;
        const maxTokens = stats?.maxTokens ?? (targetAgent.settings?.llm?.maxContextLength || 0);
        const percentage = maxTokens ? Math.min(100, (tokens / maxTokens) * 100) : 0;
        // Remote 模式下不向本地 WebUI 服务器推送（避免远端/本地循环推送导致上下文进度抽搐）
        if (!isRemoteMode) {
          window.api.webControlPushContextProgress({
            mode: currentMode,
            used: tokens,
            max: maxTokens,
            percentage,
            details: { systemGuidanceTokens, toolDefsTokens, chatTokens, toolResultTokens, otherTokens }
          });
        }
      }
    } catch (_) {}
  }

  // 定时更新进度条
  setInterval(updateContextProgress, 1000);

  // 刷新上下文指示器右侧的实时预算进度条（今日花费/上限）
  // 在 LLM 响应结束、token 用量更新后调用
  async function refreshBudgetMiniBars() {
    try {
      const st = await window.api.budgetGetStatus();
      if (!st?.ok) return;
      const daily = st.daily || {};
      const monthly = st.monthly || {};
      // 三种模式的预算小条使用同一份数据（按当日总花费）
      const targets = ['chat-budget-mini-bar', 'code-budget-mini-bar', 'babe-budget-mini-bar'];
      for (const id of targets) {
        const el = document.getElementById(id);
        if (!el) continue;
        const cost = daily.costUSD || 0;
        const limit = daily.limitUSD || 0;
        // 仅在 (有限额) 或 (已花费 > 0) 时显示
        if (limit > 0 || cost > 0) {
          el.style.display = '';
          el.dataset.level = daily.level || 'normal';
          const fill = el.querySelector('.bmb-fill');
          const costEl = el.querySelector('.bmb-cost');
          if (fill) fill.style.width = `${Math.min(100, daily.pct || 0)}%`;
          if (costEl) {
            const fmtCost = cost >= 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(6)}`;
            costEl.textContent = limit > 0 ? `${fmtCost} / $${limit.toFixed(2)}` : fmtCost;
          }
          // title 包含今日/本月详情
          const peakTag = (st.peakHours?.enabled) ? ` · 峰时段 ${st.peakHours.start}-${st.peakHours.end}` : '';
          el.title = `今日 $${cost.toFixed(4)}${limit > 0 ? ` / $${limit.toFixed(2)}` : ''} · 本月 $${(monthly.costUSD || 0).toFixed(4)}${peakTag}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败：不影响主流程 */ }
  }
  // 启动时和每 5 秒刷新一次（实时性，但又不至于过频）
  refreshBudgetMiniBars();
  setInterval(refreshBudgetMiniBars, 5000);
  // 监听 LLM 流结束事件以即时刷新
  try {
    window.api.onStreamEnd?.(() => { setTimeout(refreshBudgetMiniBars, 300); });
  } catch (_) {}

  // 刷新上下文指示器右侧的"当前会话消费"小数字（按 agent.sessionUsage + 价格表实时计算）
  function refreshSessionCostMini() {
    try {
      const agents = [
        { id: 'chat-session-cost', agent: typeof agent !== 'undefined' ? agent : null },
        { id: 'code-session-cost', agent: typeof codeAgent !== 'undefined' ? codeAgent : null },
        { id: 'babe-session-cost', agent: typeof babeAgent !== 'undefined' ? babeAgent : null }
      ];
      for (const { id, agent: a } of agents) {
        const el = document.getElementById(id);
        if (!el) continue;
        const su = a?.sessionUsage;
        if (!su) { el.style.display = 'none'; continue; }
        // 混合模型：按分桶逐模型计价求和；旧数据回退到当前模型单价
        const byModel = a?.sessionUsageByModel || {};
        const entries = Object.entries(byModel)
          .filter(([, u]) => u && (u.total > 0 || u.prompt > 0 || u.completion > 0));
        let totalCost = 0;
        let modelLabel = '';
        let priced = false;
        if (entries.length > 0) {
          const names = [];
          for (const [model, mu] of entries) {
            const cost = computeSessionCostForModel(a, model, mu);
            if (cost) {
              totalCost += cost.totalCost;
              priced = true;
              names.push(model);
            }
          }
          modelLabel = names.join(' + ');
        } else {
          const activeModel = (typeof a?.getActiveModelId === 'function') ? a.getActiveModelId() : a?.settings?.llm?.model;
          const cost = computeSessionCostForModel(a, activeModel, su);
          if (cost) {
            totalCost = cost.totalCost;
            priced = true;
            modelLabel = activeModel || '';
          }
        }
        if (!priced) { el.style.display = 'none'; continue; }
        if (totalCost > 0) {
          el.style.display = '';
          const valEl = el.querySelector('.scm-value');
          const fmtCost = totalCost >= 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(6)}`;
          if (valEl) valEl.textContent = (su.estimated ? '~' : '') + fmtCost;
          el.title = `当前会话消费${su.estimated ? ' (估算)' : ''}：${fmtCost}\n模型：${modelLabel || '未知'}`;
        } else {
          el.style.display = 'none';
        }
      }
    } catch (_) { /* 静默失败 */ }
  }
  setInterval(refreshSessionCostMini, 1000);

  btnReoptimizeTools?.addEventListener('click', async () => {
    if (!agent.settings?.autoOptimizeToolSelection) return;
    const seed = chatInput.value.trim() || (typeof agent.getLatestUserMessageText === 'function' ? agent.getLatestUserMessageText() : '') || '手动触发工具重优化';
    await agent.optimizeToolsForConversation(seed, '用户手动点击“重新优化工具选择”');
    updateReoptimizeButtonVisibility();
    if (document.getElementById('page-tools')?.classList.contains('active')) {
      loadToolsPage();
    }
  });
