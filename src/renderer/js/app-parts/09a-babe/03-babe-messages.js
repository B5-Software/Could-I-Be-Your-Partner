  function createBabeStreamBubble() {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return null;
    const welcome = msgsEl.querySelector('.babe-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'babe-message assistant streaming';
    msg.id = 'babe-stream-' + Date.now();
    // Babe 流式气泡头像：使用 Babe 头像（含头像框）
    const babeAvatar = babeAgent?.settings?.babe?.avatar || '';
    const avatarHTML = makeBabeFramedAvatarHTML(babeAvatar, 'babe');
    msg.innerHTML = `
      <div class="babe-msg-avatar">${avatarHTML}</div>
      <div class="babe-msg-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i><span>TA 的心声</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="babe-msg-bubble markdown-body"></div>
        <div class="babe-msg-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Babe 流式气泡创建后追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: msg.outerHTML });
    scrollChatToBottom(msgsEl);
    return {
      el: msg,
      contentEl: msg.querySelector('.babe-msg-bubble'),
      reasoningEl: msg.querySelector('.reasoning-content'),
      reasoningSection: msg.querySelector('.reasoning-section'),
      rawContent: '',
      rawReasoning: '',
      contentStarted: false,
      renderTimer: null // 用于流式 chunk 推送节流
    };
  }

  function addBabeMessage(role, content) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const welcome = msgsEl.querySelector('.babe-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = 'babe-message ' + role;
    const rendered = (role === 'assistant' || role === 'system') ? renderMarkdown(content) : escapeHtml(content);
    // 懒渲染用：保留原始内容与角色，离屏折叠后滚回时重新渲染
    msg.dataset.lazyRaw = content;
    msg.dataset.lazyRole = (role === 'assistant' || role === 'system') ? 'md' : 'text';
    // 头像：assistant 用 Babe 头像（含头像框），user 用用户头像（含头像框），system 用图标
    let avatarHTML;
    if (role === 'assistant') {
      const babeAvatar = babeAgent?.settings?.babe?.avatar || '';
      avatarHTML = makeBabeFramedAvatarHTML(babeAvatar, 'babe');
    } else if (role === 'user') {
      const userAvatar = babeAgent?.settings?.userProfile?.avatar || '';
      avatarHTML = makeBabeFramedAvatarHTML(userAvatar, 'user');
    } else {
      avatarHTML = '<i class="fa-solid fa-info-circle"></i>';
    }
    msg.innerHTML = `
      <div class="babe-msg-avatar">${avatarHTML}</div>
      <div class="babe-msg-body">
        <div class="babe-msg-bubble markdown-body">${rendered}</div>
        <div class="babe-msg-time">${new Date().toLocaleTimeString('zh-CN', {hour12: false})}</div>
      </div>`;
    msgsEl.appendChild(msg);
    // 增量推送：Babe 消息追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: msg.outerHTML });
    scrollChatToBottom(msgsEl);
    babeMessages.push({ role, content });
  }

  function addBabeToolCall(data) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'tool-call-card';
    div.id = 'babe-tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    if (data.callId) div.dataset.callId = data.callId;
    const argsStr = data.args ? JSON.stringify(data.args, null, 2).slice(0, 500) : '';
    div.innerHTML = `<div class="tool-call-header"><i class="fa-solid fa-wrench"></i> <span>${escapeHtml(data.name || 'tool')}</span></div>` +
      (argsStr ? `<pre class="tool-call-args">${escapeHtml(argsStr)}</pre>` : '') +
      `<div class="tool-call-status"><i class="fa-solid fa-spinner fa-spin"></i> 执行中...</div>`;
    msgsEl.appendChild(div);
    // 增量推送：Babe 工具调用卡片追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: div.outerHTML });
    scrollChatToBottom(msgsEl);
    return div;
  }

  function addBabeToolResult(data) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    let targetCard = null;
    if (data.callId) {
      targetCard = msgsEl.querySelector(`.tool-call-card[data-call-id="${cssEscape(data.callId)}"]`);
    }
    if (!targetCard) {
      const cards = msgsEl.querySelectorAll('.tool-call-card');
      for (let i = cards.length - 1; i >= 0; i--) {
        const statusEl = cards[i].querySelector('.tool-call-status');
        if (statusEl && statusEl.innerHTML.includes('fa-spin')) { targetCard = cards[i]; break; }
      }
      if (!targetCard) targetCard = cards[cards.length - 1];
    }
    if (!targetCard) return;
    const statusEl = targetCard.querySelector('.tool-call-status');
    if (!statusEl) return;
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const ok = data.result?.ok !== false;
    statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败') +
      (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
    // 增量推送：更新 Babe 工具调用卡片结果到 WebUI
    if (targetCard.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + targetCard.id, html: targetCard.outerHTML });
    }
    // 结果注入会撑高卡片：吸附状态下补滚到底
    scrollChatToBottom(msgsEl);
  }

  // 更新好感度显示
  function updateBabeAffection(value) {
    const v = Math.max(0, Math.min(100, value || 0));
    const valueEl = document.getElementById('babe-affection-value');
    const fillEl = document.getElementById('babe-affection-fill');
    if (valueEl) valueEl.textContent = v;
    if (fillEl) fillEl.style.width = v + '%';
    // 增量推送：好感度数值与进度条更新同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#babe-affection-value', text: String(v) });
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#babe-affection-fill', attr: 'style', value: 'width: ' + v + '%' });
  }

  // 显示好感度变化提示
  function showBabeAffectionChange(delta, newValue) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl) return;
    const div = document.createElement('div');
    div.className = 'babe-affection-change ' + (delta > 0 ? 'up' : 'down');
    div.id = 'babe-aff-change-' + Date.now();
    const icon = delta > 0 ? 'fa-heart' : 'fa-heart-crack';
    const sign = delta > 0 ? '+' : '';
    div.innerHTML = `<i class="fa-solid ${icon}"></i> 好感度 ${sign}${delta} → ${newValue}`;
    msgsEl.appendChild(div);
    // 增量推送：好感度变化提示追加到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: '#babe-chat-messages', html: div.outerHTML });
    scrollChatToBottom(msgsEl);
    // 2秒后淡出
    setTimeout(() => { div.style.opacity = '0'; if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + div.id, attr: 'style', value: div.getAttribute('style') || '' }); }, 2000);
    setTimeout(() => { div.remove(); if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id }); }, 3000);
  }

  // 更新 Babe persona 显示（姓名、头像、头像框）
  // babeOverride: 可选，传入最新的 babe 设置对象（用于尚未初始化 babeAgent 时）
