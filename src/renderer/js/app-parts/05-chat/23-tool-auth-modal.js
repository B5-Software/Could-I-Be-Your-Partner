  // ---- 工具首次使用授权模态框（Playwright / Computer Use）----
  // 不同类别展示不同的风险说明
  const _TOOL_AUTH_META = {
    playwright: {
      title: '内置浏览器授权',
      icon: 'fa-globe',
      warning: `<strong>AI 请求使用内置浏览器（Playwright）。</strong><br>该工具可由 AI 自动打开网页、点击元素、输入文字并截图。可能涉及：`
        + `<ul><li>自动浏览未知网页（可能触发验证码或追踪）</li>`
        + `<li>自动填写表单（请勿在敏感网站登录时使用）</li>`
        + `<li>页面截图可能包含隐私内容</li></ul>`
    },
    computerUse: {
      title: '电脑控制授权',
      icon: 'fa-desktop',
      warning: `<strong>AI 请求使用电脑控制（Computer Use Protocol）。</strong><br>该工具将截取屏幕、模拟鼠标点击与键盘输入，可控制整个桌面。可能涉及：`
        + `<ul><li>截取整个屏幕（可能包含敏感信息）</li>`
        + `<li>自动点击任意位置（包括系统按钮、文件）</li>`
        + `<li>模拟键盘输入（可能触发快捷键、关闭窗口）</li></ul>`
        + `<strong>请确保已保存所有工作，关闭敏感窗口后再授权。</strong>`
    }
  };

  /**
   * 显示"工具首次使用授权"模态框。
   * @param {string} toolName - 当前调用的工具名（用于显示）
   * @param {'playwright'|'computerUse'} category - 授权类别
   * @param {object} agentInstance - 当前模式的 agent 实例（用于回调 resolveToolAuth）
   */
  function showToolAuthModal(toolName, category, agentInstance) {
    if (!toolAuthModal) return;
    _toolAuthAgent = agentInstance || null;
    const meta = _TOOL_AUTH_META[category] || {
      title: '工具授权',
      icon: 'fa-shield-halved',
      warning: `<strong>AI 请求使用工具 ${toolName}。</strong><br>该工具需要您授权后才能使用。`
    };
    if (toolAuthTitleEl) toolAuthTitleEl.textContent = meta.title;
    if (toolAuthIconEl) toolAuthIconEl.className = `fa-solid ${meta.icon}`;
    if (toolAuthWarningEl) toolAuthWarningEl.innerHTML = meta.warning;
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    const dispName = toolDef?.desc || toolName;
    if (toolAuthToolEl) {
      toolAuthToolEl.innerHTML = `当前工具：<code>${escapeHtmlSimple(toolName)}</code> — ${escapeHtmlSimple(dispName)}`;
    }
    toolAuthModal.classList.remove('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tool-auth-modal', attr: 'class', value: toolAuthModal.className });
    // 系统通知
    sendAppNotification('approval', '工具授权请求', `AI 请求使用: ${dispName}`);
  }

  function _closeToolAuthModal() {
    if (!toolAuthModal) return;
    fadeOutHide(toolAuthModal, () => {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tool-auth-modal', attr: 'class', value: toolAuthModal.className });
    });
  }

  function _resolveToolAuth(decision) {
    _closeToolAuthModal();
    const a = _toolAuthAgent;
    _toolAuthAgent = null;
    try {
      if (a && typeof a.resolveToolAuth === 'function') a.resolveToolAuth(decision);
    } catch (e) { /* ignore */ }
    // 授权决策完成后，异步刷新工具页"授权状态列表"
    // agent 在 'allow-always' 时会异步写入 settings.toolAuthGranted，等其完成再刷新
    if (decision === 'allow-always' || decision === 'allow-once' || decision === 'deny') {
      setTimeout(() => {
        try { renderToolAuthList(); } catch {}
      }, 300);
    }
  }

  const _btnToolAuthDeny = document.getElementById('btn-tool-auth-deny');
  const _btnToolAuthOnce = document.getElementById('btn-tool-auth-once');
  const _btnToolAuthAlways = document.getElementById('btn-tool-auth-always');
  const _btnCloseToolAuth = document.getElementById('btn-close-tool-auth');
  if (_btnToolAuthDeny) _btnToolAuthDeny.addEventListener('click', () => _resolveToolAuth('deny'));
  if (_btnToolAuthOnce) _btnToolAuthOnce.addEventListener('click', () => _resolveToolAuth('allow-once'));
  if (_btnToolAuthAlways) _btnToolAuthAlways.addEventListener('click', () => _resolveToolAuth('allow-always'));
  if (_btnCloseToolAuth) _btnCloseToolAuth.addEventListener('click', () => _resolveToolAuth('deny'));
