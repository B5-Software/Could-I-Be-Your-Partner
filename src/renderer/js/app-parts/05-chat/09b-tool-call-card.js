  function addToolCallToChat(displayName, toolName, args, callId) {
    // runSubAgent 工具调用不在此显示卡片 — 子代理有独立的卡片和详情模态框
    // 避免 args 中过长的任务描述和 result 撑爆聊天页面
    if (toolName === 'runSubAgent') return;

    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = `tool-${toolName}-${Date.now()}`;
    el.dataset.toolName = toolName;
    if (callId) el.dataset.toolCallId = callId;
    // 截断 args：字符串值限制 200 字符，对象 JSON 限制 500 字符
    const argsStr = Object.entries(args || {})
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v.substring(0, 200)}${v.length > 200 ? '…(已截断)' : ''}`;
        const json = JSON.stringify(v);
        return `${k}: ${json.length > 500 ? json.substring(0, 500) + '…(已截断)' : json}`;
      })
      .join('\n');
    el.innerHTML = `
      <div class="tool-call-header">
        <i class="fa-solid fa-gear fa-spin"></i>
        <span>调用工具: ${escapeHtml(displayName)}</span>
        <span class="trng-badge" style="display:none"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>
      </div>
      ${argsStr ? `<div class="tool-call-args">${escapeHtml(argsStr)}</div>` : ''}
      <div class="tool-call-result" style="display:none"></div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    scrollElementIntoView(el);
  }

  function updateToolCallResult(toolName, result, isError = false, callId = null) {
    let el = null;
    if (callId) {
      // 同一轮多个同名工具调用时，必须按 callId 精确匹配，
      // 否则多个结果会全部覆盖到最后一个卡片上。
      el = chatMessages.querySelector(`[data-tool-call-id="${cssEscape(callId)}"]`);
    }
    if (!el) {
      const els = chatMessages.querySelectorAll(`[data-tool-name="${toolName}"]`);
      el = els[els.length - 1];
    }
    if (!el) return;
    const header = el.querySelector('.tool-call-header i');
    const isFailure = isError || result?.ok === false;
    if (header) { header.className = `fa-solid ${isFailure ? 'fa-xmark' : 'fa-check'}`; }
    // Show TRNG badge if applicable
    if (result?.entropySource && result.entropySource.startsWith('TRNG')) {
      const badge = el.querySelector('.trng-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
    const resultEl = el.querySelector('.tool-call-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      resultEl.textContent = text.substring(0, 500);
      if (isFailure) resultEl.classList.add('error');
    }
    // 增量推送：更新工具调用卡片的完整 outerHTML
    if (el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, html: el.outerHTML });
    }
  }
