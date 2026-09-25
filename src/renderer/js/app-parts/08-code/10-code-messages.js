  let codeStreamBubble = null;

  function createCodeStreamBubble() {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return null;
    // Remove welcome message
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message assistant streaming';
    msg.id = 'code-stream-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid fa-robot"></i></div>
      <div class="message-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i><span>推理过程</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="message-content markdown-body"></div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：流式气泡创建后追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    scrollChatToBottom(msgsEl);
    return {
      el: msg,
      contentEl: msg.querySelector('.message-content'),
      reasoningEl: msg.querySelector('.reasoning-content'),
      reasoningSection: msg.querySelector('.reasoning-section'),
      rawContent: '',
      rawReasoning: '',
      contentStarted: false,
      renderTimer: null // 用于流式 chunk 推送节流
    };
  }

  function addCodeMessage(role, content, track = true) {
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const welcome = msgsEl.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'message ' + role;
    const avatarIcon = role === 'assistant' ? 'fa-robot' : (role === 'system' ? 'fa-info-circle' : 'fa-user');
    const rendered = (role === 'assistant') ? renderMarkdown(content) : escapeHtml(content);
    // 懒渲染用：保留原始内容与角色，离屏折叠后滚回时重新渲染
    msg.dataset.lazyRaw = content;
    msg.dataset.lazyRole = (role === 'assistant') ? 'md' : 'text';
    msg.innerHTML = `
      <div class="message-avatar"><i class="fa-solid ${avatarIcon}"></i></div>
      <div class="message-body">
        <div class="message-content markdown-body">${rendered}</div>
        <div class="message-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Code 消息追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: msg.outerHTML });
    scrollChatToBottom(msgsEl);

    // Track for history
    if (track) codeMessages.push({ role, content });
  }

  function addCodeToolCall(data) {
    // 工具调用 UI（卡片式）— 显示工具名 + 参数
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'tool-call-card';
    div.id = 'code-tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    if (data.callId) div.dataset.callId = data.callId;
    const argsStr = data.args ? JSON.stringify(data.args, null, 2).slice(0, 500) : '';
    div.innerHTML = `<div class="tool-call-header"><i class="fa-solid fa-wrench"></i> <span>${escapeHtml(data.name || 'tool')}</span></div>` +
      (argsStr ? `<pre class="tool-call-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="tool-call-status"><i class="fa-solid fa-spinner fa-spin"></i> 执行中...</div>`;
    msgsEl.appendChild(div);
    // 增量推送：工具调用卡片追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    scrollChatToBottom(msgsEl);
    return div;
  }

  function addCodeToolResult(data) {
    // 在 tool-call-card 中填充结果
    // 优先通过 callId 精确匹配（历史加载时多个工具调用可能连续出现）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    let targetCard = null;
    if (data.callId) {
      targetCard = msgsEl.querySelector(`.tool-call-card[data-call-id="${cssEscape(data.callId)}"]`);
    }
    if (!targetCard) {
      // 回退：取最后一个未完成的 card（状态为"执行中"的）
      const cards = msgsEl.querySelectorAll('.tool-call-card');
      for (let i = cards.length - 1; i >= 0; i--) {
        const statusEl = cards[i].querySelector('.tool-call-status');
        if (statusEl && statusEl.innerHTML.includes('fa-spin')) { targetCard = cards[i]; break; }
      }
      // 最终回退：取最后一个 card
      if (!targetCard) targetCard = cards[cards.length - 1];
    }
    if (!targetCard) return;
    const statusEl = targetCard.querySelector('.tool-call-status');
    if (!statusEl) return;
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const ok = data.result?.ok !== false;
    statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败') +
      (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
    // 增量推送：更新工具调用卡片结果到 WebUI
    if (targetCard.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + targetCard.id, html: targetCard.outerHTML });
    }
    // 结果注入会撑高卡片：吸附状态下补滚到底
    scrollChatToBottom(msgsEl);
  }

  function showCodeApprovalPanel(toolName, args) {
    // Code 模式独立的 approval UI（在 code-chat-messages 区域内显示，不逃逸到 Chat 模式）
    const msgsEl = document.getElementById('code-chat-messages');
    if (!msgsEl) return;
    // 移除已存在的 approval 面板
    const existing = msgsEl.querySelector('.code-approval-panel');
    if (existing) {
      if (existing.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + existing.id });
      existing.remove();
    }
    const div = document.createElement('div');
    div.className = 'code-approval-panel';
    div.id = 'code-approval-' + Date.now();
    const argsStr = args ? JSON.stringify(args, null, 2) : '';
    div.innerHTML = `<div class="approval-header"><i class="fa-solid fa-shield-halved"></i> 工具审批：${escapeHtml(toolName)}</div>` +
      (argsStr ? `<pre class="approval-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="approval-actions">
        <button class="btn-danger btn-approval-deny"><i class="fa-solid fa-xmark"></i> 拒绝</button>
        <button class="btn-primary btn-approval-approve"><i class="fa-solid fa-check"></i> 批准</button>
      </div>`;
    msgsEl.appendChild(div);
    // 增量推送：审批面板追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#code-chat-messages', html: div.outerHTML });
    scrollChatToBottom(msgsEl);
    div.querySelector('.btn-approval-approve').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(true);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
    div.querySelector('.btn-approval-deny').addEventListener('click', () => {
      if (codeAgent) codeAgent.resolveApproval(false);
      div.remove();
      if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id });
    });
  }
