  // ==================== Babe Mode (恋爱模式) ====================
  let babeAgent = null;
  let babeMessages = [];
  let babeCurrentHistoryId = null;
  let babeStreamBubble = null;
  let babeProactiveTimer = null;
  // 主动消息追踪：标记当前是否为主动消息回合，以及是否已产生内容
  let babeProactiveActive = false;
  let babeProactiveProduced = false;

  // 初始化 Babe Agent
  function wireBabeAgent(ag) {
    if (!ag) return;
    const isActive = () => {
      const session = sessionManager?.getByAgent(ag);
      return !session || session.active;
    };

    ag.onTitleChange = (title) => {
      if (isActive()) setTitlebarTitle(title);
      if (isActive()) window.api.webControlPushTitle(title);
    };

    ag.onMessage = (type, data) => {
      const msgsEl = document.getElementById('babe-chat-messages');
      if (!msgsEl) return;
      if (!isActive()) {
        if (type === 'approval' && typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        else if (type === 'present-file' && sessionManager) {
          const session = sessionManager.getByAgent(ag);
          if (session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        }
        return;
      }
      switch (type) {
        case 'assistant':
          addBabeMessage('assistant', data);
          if (babeProactiveActive) babeProactiveProduced = true;
          break;
        case 'system':
          addBabeMessage('system', data);
          break;
        case 'stream-chunk': {
          const bubble = babeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const cleanContent = data.content.replace(/【好感度[+-]?\d+】/g, '');
            const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, cleanContent);
            bubble.rawContent = dedup.raw;
            bubble._lastChunk = dedup.lastChunk;
            bubble.contentStarted = true;
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
            bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          msgsEl.scrollTop = msgsEl.scrollHeight;
          if (!bubble.renderTimer) {
            bubble.renderTimer = setTimeout(() => {
              bubble.renderTimer = null;
              if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
            }, 120);
          }
          break;
        }
        case 'stream-end': {
          const isAuthoritativeFinal = !!(data && typeof data === 'object' && data.content !== undefined);
          const bubble = babeStreamBubble;
          if (!bubble) {
            if (isAuthoritativeFinal && data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.babe-msg-content, .babe-msg-body, .message-content');
                const clean = String(data.content || '').replace(/【好感度[+-]?\d+】/g, '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
              }
            }
            babeStreamBubble = null;
            return;
          }
          if (!isAuthoritativeFinal) return;
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = (data.content || bubble.rawContent).replace(/【好感度[+-]?\d+】/g, '').trimEnd();
          bubble.rawContent = finalContent;
          const hasContent = !!(finalContent && finalContent.trim());
          if (babeProactiveActive && hasContent) babeProactiveProduced = true;
          if (hasReasoning) {
            bubble.reasoningSection.classList.add('collapsed');
            bubble.reasoningSection.style.display = 'block';
            bubble.reasoningEl.innerHTML = renderMarkdown(data.reasoning || bubble.rawReasoning);
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          if (hasContent) {
            bubble.contentEl.innerHTML = renderMarkdown(finalContent);
          } else if (hasReasoning) {
            bubble.contentEl.style.display = 'none';
            const timeEl = bubble.el.querySelector('.babe-msg-time');
            if (timeEl) timeEl.style.display = 'none';
          } else {
            bubble.el.remove();
            if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
            babeStreamBubble = null;
            break;
          }
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          babeStreamBubble = null;
          break;
        }
        case 'stream-start':
          babeStreamBubble = createBabeStreamBubble();
          if (babeStreamBubble?.el && data?.requestId) {
            babeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
          }
          break;
        case 'tool_call':
          addBabeToolCall(data);
          break;
        case 'tool-result':
          addBabeToolResult(data);
          break;
        case 'present-file':
          addFilePresentCard(data);
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
        case 'affection-change':
          showBabeAffectionChange(data.delta, data.value);
          updateBabeAffection(data.value);
          break;
        case 'error':
          addBabeMessage('system', '错误: ' + (typeof data === 'string' ? data : (data?.error || JSON.stringify(data))));
          break;
      }
    };

    ag.onStatusChange = (status) => {
      if (!isActive()) {
        if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        return;
      }
      const sendBtn = document.getElementById('btn-babe-send');
      const stopBtn = document.getElementById('btn-babe-stop');
      if (status === 'working') {
        sendBtn?.classList.add('hidden');
        stopBtn?.classList.remove('hidden');
      } else {
        sendBtn?.classList.remove('hidden');
        if (stopBtn) stopBtn.classList.toggle('hidden', !voiceSpeakingNow());
      }
      if (sendBtn) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-send', attr: 'class', value: sendBtn.className });
      if (stopBtn) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-stop', attr: 'class', value: stopBtn.className });
    };
  }

  async function initBabeAgent() {
    if (babeAgent) {
      // 已初始化，仅更新显示
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      return true;
    }
    try {
      babeAgent = new Agent();
      babeAgent.mode = 'babe';
      babeAgent.settings = await window.api.getSettings();
      if (!babeAgent.settings.tools || typeof babeAgent.settings.tools !== 'object') {
        babeAgent.settings.tools = {};
      }
      babeAgent.systemInfo = await window.api.getFullSystemInfo();
      const maxCtx = babeAgent.settings.llm?.maxContextLength || 131072;
      babeAgent.contextManager = new ContextManager(maxCtx);
      babeAgent.contextManager.setMaxTokens(maxCtx);
      babeAgent.contextManager.setOutputReserve(babeAgent.settings.llm?.maxResponseTokens || 8192);
      babeAgent.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      // 初始好感度
      babeAgent.babeAffection = babeAgent.settings.babe?.initialAffection ?? 30;
      await babeAgent.refreshSkillsCatalog();
      babeAgent.contextManager.setSystemPrompt(babeAgent.getSystemPrompt());
      setupAgentStreamSubscriptions(babeAgent, 'babe');
      wireBabeAgent(babeAgent);
      updateBabeAffection(babeAgent.babeAffection);
      updateBabePersonaDisplay();
      // 启动主动消息定时器
      restartBabeProactiveTimer();
      if (sessionManager) {
        const babeSession = sessionManager.registerAgent('babe', babeAgent, {
          title: babeAgent.conversationTitle || '未命名 Babe 会话'
        });
        sessionManager.activate('babe', babeSession.key);
      }
      return true;
    } catch (e) {
      console.error('[Babe] initBabeAgent failed:', e);
      addBabeMessage('system', '初始化 Babe 模式失败: ' + e.message);
      return false;
    }
  }

  async function createBabeSession() {
    const ag = new Agent();
    ag.mode = 'babe';
    ag.settings = await window.api.getSettings();
    if (!ag.settings.tools || typeof ag.settings.tools !== 'object') ag.settings.tools = {};
    ag.systemInfo = await window.api.getFullSystemInfo();
    const maxCtx = ag.settings.llm?.maxContextLength || 131072;
    ag.contextManager = new ContextManager(maxCtx);
    ag.contextManager.setMaxTokens(maxCtx);
    ag.contextManager.setOutputReserve(ag.settings.llm?.maxResponseTokens || 8192);
    ag.conversationId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    ag.babeAffection = ag.settings.babe?.initialAffection ?? 30;
    await ag.refreshSkillsCatalog();
    ag.contextManager.setSystemPrompt(ag.getSystemPrompt());
    wireBabeAgent(ag);
    setupAgentStreamSubscriptions(ag, 'babe');
    if (!sessionManager) return null;
    const session = sessionManager.registerAgent('babe', ag, { title: '未命名 Babe 会话' });
    activateSession('babe', session.key);
    return session;
  }

  async function replayBabeSession(session) {
    const msgsEl = document.getElementById('babe-chat-messages');
    if (!msgsEl || !session?.agent) return;
    babeStreamBubble = null;
    msgsEl.innerHTML = '';
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#babe-chat-messages' });
    const messages = session.agent.contextManager?.getHistoryMessages() || [];
    if (messages.length === 0) {
      msgsEl.innerHTML = `<div class="babe-welcome"><div class="babe-welcome-icon"><i class="fa-solid fa-heart"></i></div><h2>新的开始</h2><p>开始一段新的对话吧~</p></div>`;
      updateBabeAffection(session.agent.babeAffection);
      return;
    }
    const total = messages.length;
    const chunkSize = 30;
    const toolCallMap = {};
    showHistoryProgress(total);
    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const m = messages[i];
          if (m.role === 'user') {
            addBabeMessage('user', extractTextContent(m.content) || '[多模态内容]');
          } else if (m.role === 'assistant') {
            const textContent = extractTextContent(m.content);
            if (textContent) addBabeMessage('assistant', textContent);
            if (m.tool_calls && m.tool_calls.length > 0) {
              for (const tc of m.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                const card = addBabeToolCall({ name: displayName, args, callId: tc.id });
                if (tc.id && card) toolCallMap[tc.id] = { card, name: toolName };
              }
            }
          } else if (m.role === 'tool') {
            const key = m.tool_call_id;
            const entry = key ? toolCallMap[key] : null;
            let result = m.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
            if (entry) {
              const statusEl = entry.card.querySelector('.tool-call-status');
              const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
              const ok = (result && typeof result === 'object') ? result.ok !== false : true;
              if (statusEl) {
                statusEl.innerHTML = (ok ? '<i class="fa-solid fa-check"></i> 完成' : '<i class="fa-solid fa-xmark"></i> 失败')
                  (resultStr ? `<pre class="tool-call-result">${escapeHtml(resultStr.slice(0, 800))}</pre>` : '');
              }
            } else {
              addBabeMessage('system', `[工具结果] ${m.name || 'tool'}: ${String(result).slice(0, 200)}`);
            }
          } else if (m.role === 'system') {
            addBabeMessage('system', typeof m.content === 'string' ? m.content : String(m.content || ''));
          }
        }
        updateHistoryProgress(end, total, end >= total ? '渲染完成，正在收尾…' : `已渲染 ${end}/${total} 条消息`);
        await yieldHistoryUI();
      }
    } finally {
      hideHistoryProgress();
    }
    requestAnimationFrame(() => {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#babe-chat-messages', html: msgsEl.innerHTML });
    });
    updateBabeAffection(session.agent.babeAffection);
  }

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
    msgsEl.scrollTop = msgsEl.scrollHeight;
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
    msgsEl.scrollTop = msgsEl.scrollHeight;
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
    msgsEl.scrollTop = msgsEl.scrollHeight;
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
    msgsEl.scrollTop = msgsEl.scrollHeight;
    // 2秒后淡出
    setTimeout(() => { div.style.opacity = '0'; if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + div.id, attr: 'style', value: div.getAttribute('style') || '' }); }, 2000);
    setTimeout(() => { div.remove(); if (div.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + div.id }); }, 3000);
  }

  // 更新 Babe persona 显示（姓名、头像、头像框）
  // babeOverride: 可选，传入最新的 babe 设置对象（用于尚未初始化 babeAgent 时）
  function updateBabePersonaDisplay(babeOverride) {
    const babe = babeOverride || babeAgent?.settings?.babe;
    if (!babe) return;
    const nameEl = document.getElementById('babe-name-display');
    if (nameEl) nameEl.textContent = babe.name || 'Babe';
    // 增量推送：Babe 名称更新同步到 WebUI
    if (nameEl) WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#babe-name-display', text: babe.name || 'Babe' });
    // Hero 头像（含头像框叠加层）
    const avatarEl = document.getElementById('babe-avatar');
    if (avatarEl) {
      const frameId = _avatarFrameState.babe;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:100%;height:100%;border-radius:50%;object-fit:cover';
      // 使用 makeAvatarHTML（直接子元素 img/i），与 AI Hero 头像结构一致
      // Babe 无头像时使用心形图标作为默认
      let inner;
      if (babe.avatar) {
        inner = makeAvatarHTML(babe.avatar, true, avatarSize);
      } else {
        inner = '<i class="fa-solid fa-heart" style="' + avatarSize + '"></i>';
      }
      avatarEl.innerHTML = inner;
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
      // 增量推送：Babe Hero 头像更新同步到 WebUI
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#babe-avatar', html: avatarEl.innerHTML, attr: 'class', value: avatarEl.className });
    }
  }

  // ---- Babe 模式附件功能（与 Chat 模式独立，避免冲突）----
  let babeAttachments = [];
  const babeAttachmentsPreview = document.getElementById('babe-attachments-preview');

  function renderBabeAttachments() {
    if (!babeAttachmentsPreview) return;
    if (babeAttachments.length === 0) {
      babeAttachmentsPreview.classList.add('hidden');
      babeAttachmentsPreview.innerHTML = '';
      return;
    }
    babeAttachmentsPreview.classList.remove('hidden');
    babeAttachmentsPreview.innerHTML = babeAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    babeAttachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        babeAttachments.splice(parseInt(btn.dataset.index), 1);
        renderBabeAttachments();
      });
    });
  }

  async function copyBabeAttachmentsToWorkspace(attachments) {
    const workspacePath = babeAgent?.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;
    const normalizePath = (p) => (p || '').replace(/\//g, '\\');
    const normalizedWorkspace = normalizePath(workspacePath);
    await window.api.makeDirectory(normalizedWorkspace);
    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) await Promise.all(pending);
    for (const att of attachments) {
      if (!att.path) continue;
      const normalizedPath = normalizePath(att.path);
      if (normalizedPath.startsWith(normalizedWorkspace + '\\')) continue;
      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${normalizedWorkspace}\\${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) { att.originalPath = att.path; att.path = destPath; }
    }
  }

  // Babe 附件按钮
  document.getElementById('btn-babe-attach-file')?.addEventListener('click', async () => {
    const result = await window.api.openFileDialog({ multiple: true });
    if (result.ok && result.paths) {
      for (const p of result.paths) {
        const name = p.split(/[\\/]/).pop();
        const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
        babeAttachments.push({ name, path: p, isImage });
      }
      renderBabeAttachments();
    }
  });

  // Babe 输入框粘贴图片
  document.getElementById('babe-chat-input')?.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            babeAttachments.push({ name, path: result.path, isImage: true });
            renderBabeAttachments();
          }
        }
      }
    }
  });

  // 发送 Babe 消息
  async function sendBabeMessage() {
    const input = document.getElementById('babe-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && babeAttachments.length === 0) return;
    if (!babeAgent) {
      const ok = await initBabeAgent();
      if (!ok) return;
    }
    if (babeAgent.running) {
      window.showMessageModal('TA 还在回复中，请稍等...', '提示', 'warning');
      return;
    }
    if (!babeAgent.settings?.llm?.apiUrl) {
      window.showMessageModal('请先在设置中配置 LLM API', '提示', 'warning');
      return;
    }
    const babeSession = sessionManager?.getByAgent(babeAgent);
    if (babeSession && !babeAgent.running && !sessionManager.requestStart(babeSession)) {
      const queued = babeAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage
      }));
      addBabeMessage('user', text);
      input.value = '';
      babeAttachments = [];
      renderBabeAttachments();
      sessionManager.queue(babeSession, { text, attachments: queued });
      addBabeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。');
      return;
    }
    // 复制附件到工作区并处理（OCR/文本提取）
    const attachments = [...babeAttachments];
    babeAttachments = [];
    renderBabeAttachments();
    await copyBabeAttachmentsToWorkspace(attachments);
    for (const att of attachments) {
      if (att.isImage && att.path) {
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) att.ocrText = ocrResult.text;
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, babeAgent.workspacePath);
            if (importResult.ok && importResult.content) att.extractedText = importResult.content;
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }
    // 显示用户消息（含附件标记）
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addBabeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#babe-chat-input', value: '' });
    // 发送给 Agent（带附件，复用 Agent.sendMessage 的多模态注入逻辑）
    try {
      await babeAgent.sendMessage(text, attachments);
    } catch (e) {
      addBabeMessage('system', '发送失败: ' + e.message);
    }
  }

  // Babe 历史页面
  async function loadBabeHistoryPage() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    if (typeof HistoryList !== 'undefined') {
      await loadBabeHistoryPageVirtual();
      return;
    }
    try {
      const items = await window.api.babeHistoryList();
      if (!items || items.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>`;
        return;
      }
      // 对齐 Chat 模式结构：history-info(标题+时间) / history-actions(按钮组)
      listEl.innerHTML = items.map(item => {
        const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
        const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
        const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
        const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
        return `
        <div class="history-item" data-id="${item.id}">
          <div class="history-info">
            <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
            <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息${item.workingMs > 0 ? ` · 用时 ${formatWorkDuration(item.workingMs)}` : ''}</div>
          </div>
          <div class="history-actions">
            <button class="btn-icon history-continue" data-id="${item.id}" title="继续对话"><i class="fa-solid fa-play"></i></button>
            <button class="btn-icon history-export-json" data-id="${item.id}" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
            <button class="btn-icon history-export-md" data-id="${item.id}" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
            <button class="btn-icon history-delete" data-id="${item.id}" title="删除"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
      }).join('');
      // 绑定按钮（复用 Chat 模式的 class，但 Babe 历史需要走 Babe API）
      listEl.querySelectorAll('.history-continue').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          stopVoicePlayback(); // 切换会话前清空语音播放队列
          const id = btn.dataset.id;
          const existing = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
          if (existing) {
            babeAgent = existing.agent;
            const conversation = await window.api.babeHistoryGet(id);
            if (conversation) {
              babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
              await babeAgent.loadFromHistory(conversation);
              sessionManager.retag(existing, id);
            }
            activateSession('babe', existing.key);
          } else {
            await loadBabeConversation(id);
          }
        });
      });
      listEl.querySelectorAll('.history-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
          const result = await window.api.babeHistoryDelete(id);
          if (result.ok) loadBabeHistoryPage();
        });
      });
      const bindBabeExport = (btn, isJson) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const conv = await window.api.babeHistoryGet(btn.dataset.id);
          if (!conv) {
            if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在', '导出失败', 'error');
            return;
          }
          await exportConversationToFile(conv, isJson ? 'json' : 'md');
        });
      };
      listEl.querySelectorAll('.history-export-json').forEach(btn => bindBabeExport(btn, true));
      listEl.querySelectorAll('.history-export-md').forEach(btn => bindBabeExport(btn, false));
      // 推送历史列表到 WebUI/Remote
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`;
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: document.getElementById('page-babe-history').innerHTML });
    }
  }

  // ============ Babe 历史虚拟滚动 + Ctrl/Cmd+F 搜索 ============
  let babeHistoryRawItems = [];
  let babeHistorySearch = null;

  function ensureBabeHistoryListAttached() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl || typeof HistoryList === 'undefined') return false;
    if (!listEl.dataset.hlAttached) {
      listEl.dataset.hlAttached = '1';
      HistoryList.attach(listEl, {
        renderItem: renderBabeHistoryItem,
        onAction: handleBabeHistoryAction,
        renderEmpty: () => '<div class="empty-state"><i class="fa-solid fa-heart"></i><p>暂无 Babe 历史</p><p class="setting-hint">在 Babe 模式中开始对话后会自动保存</p></div>',
        stride: 78,
        overscan: 8
      });
      babeHistorySearch = (typeof window.makeHistorySearchV2 === 'function') ? window.makeHistorySearchV2({
        key: 'babe-history',
        inputId: 'babe-history-search-input',
        countId: 'babe-history-search-count',
        listId: 'babe-history-list',
        searchMode: 'babe',
        getRawItems: () => babeHistoryRawItems,
        getTitleText: (item) => item.title || '',
        renderItem: renderBabeHistoryItem,
        renderContentItem: renderBabeHistoryContentItem,
        onAction: handleBabeHistoryAction,
        restoreItems: () => HistoryList.setItems(listEl, babeHistoryRawItems)
      }) : null;
    }
    return true;
  }

  function renderBabeHistoryItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    return `
      <div class="history-item" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息${item.workingMs > 0 ? ` · 用时 ${formatWorkDuration(item.workingMs)}` : ''}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  function renderBabeHistoryContentItem(item) {
    const ts = item.updatedAt ? (typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(item.updatedAt)) : NaN;
    const timeStr = !isNaN(ts) ? new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知时间';
    const affectionBadge = `<span class="babe-history-affection" title="好感度"><i class="fa-solid fa-heart"></i> ${item.affection ?? 0}</span>`;
    const live = (typeof getSessionLiveState === 'function') ? getSessionLiveState('babe', item) : null;
    const snippets = Array.isArray(item.snippets) ? item.snippets.slice(0, 10) : [];
    const snippetsHtml = snippets.map(s => `<div class="history-snippet">${(typeof buildSearchSnippetHtml === 'function') ? buildSearchSnippetHtml(s) : escapeHtml(s.hit || '')}</div>`).join('');
    const moreHtml = (item.snippetTotal && item.snippetTotal > 10)
      ? `<div class="history-snippet-more">还有 ${item.snippetTotal - 10} 处命中</div>`
      : '';
    return `
      <div class="history-item history-item-content" data-id="${item.id}">
        <div class="history-info">
          <div class="history-title">${escapeHtml(item.title || '未命名对话')} ${affectionBadge} ${sessionStatusBadge(live ? live.status : item.status, live ? live.lastError : item.lastError, live ? live.attention : null)}</div>
          <div class="history-time">${timeStr} · ${item.messageCount || 0} 条消息${item.workingMs > 0 ? ` · 用时 ${formatWorkDuration(item.workingMs)}` : ''}</div>
          <div class="history-snippets">${snippetsHtml}${moreHtml}</div>
        </div>
        <div class="history-actions">
          <button class="btn-icon" data-action="continue" title="继续对话"><i class="fa-solid fa-play"></i></button>
          <button class="btn-icon" data-action="export-json" title="导出为JSON"><i class="fa-solid fa-file-code"></i></button>
          <button class="btn-icon" data-action="export-md" title="导出为Markdown"><i class="fa-solid fa-file-lines"></i></button>
          <button class="btn-icon" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`;
  }

  async function handleBabeHistoryAction(action, item) {
    if (!item || !item.id) return;
    const id = item.id;
    if (action === 'continue') {
      stopVoicePlayback();
      const existing = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
      if (existing) {
        babeAgent = existing.agent;
        const conversation = await window.api.babeHistoryGet(id);
        if (conversation) {
          babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
          await babeAgent.loadFromHistory(conversation);
          sessionManager.retag(existing, id);
        }
        activateSession('babe', existing.key);
      } else {
        await loadBabeConversation(id);
      }
    } else if (action === 'export-json' || action === 'export-md') {
      const conv = await window.api.babeHistoryGet(id);
      if (!conv) {
        if (typeof window.showMessageModal === 'function') window.showMessageModal('导出失败：记录不存在', '导出失败', 'error');
        return;
      }
      await exportConversationToFile(conv, action === 'export-json' ? 'json' : 'md');
    } else if (action === 'delete') {
      if (!await window.confirmDialog('确定删除这段和 TA 的回忆吗？', '删除确认')) return;
      const result = await window.api.babeHistoryDelete(id);
      if (result.ok) loadBabeHistoryPage();
    }
  }

  async function loadBabeHistoryPageVirtual() {
    const listEl = document.getElementById('babe-history-list');
    if (!listEl) return;
    ensureBabeHistoryListAttached();
    HistoryList.showMessage(listEl, '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>加载中...</p></div>');
    try {
      const items = await window.api.babeHistoryList();
      babeHistoryRawItems = Array.isArray(items) ? items : [];
      if (babeHistorySearch) babeHistorySearch.refresh();
      else HistoryList.setItems(listEl, babeHistoryRawItems);
      HistoryList.materializeAll();
      const pageHtml = document.getElementById('page-babe-history')?.innerHTML || '';
      HistoryList.restoreAll();
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#page-babe-history', html: pageHtml });
    } catch (e) {
      HistoryList.showMessage(listEl, `<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>加载历史失败: ${escapeHtml(e.message)}</p></div>`);
    }
  }

  // 加载 Babe 历史
  async function loadBabeConversation(id) {
    const conversation = await window.api.babeHistoryGet(id);
    if (!conversation) {
      window.showMessageModal('找不到该对话', '错误', 'error');
      return;
    }
    let session = sessionManager ? sessionManager.list('babe').find(s => String(s.id) === String(id)) : null;
    if (!session) {
      session = await createBabeSession();
      if (!session) return;
    }
    babeAgent = session.agent;
    babeCurrentHistoryId = id;
    babeMessages = conversation.messages || [];
    babeAgent.babeAffection = conversation.affection ?? babeAgent.settings?.babe?.initialAffection ?? 30;
    await babeAgent.loadFromHistory(conversation);
    sessionManager.retag(session, id);
    activateSession('babe', session.key);
    await replayBabeSession(session);
    updateBabeAffection(babeAgent.babeAffection);
    // 切换到 Babe 页面
    document.querySelector('.nav-item[data-page="babe"]')?.click();
  }

  // 主动消息定时器
  function restartBabeProactiveTimer(intervalOverride) {
    if (babeProactiveTimer) {
      clearInterval(babeProactiveTimer);
      babeProactiveTimer = null;
    }
    // 支持在 babeAgent 尚未初始化时由启动流程传入 interval
    const interval = intervalOverride ?? babeAgent?.settings?.babe?.proactiveInterval;
    if (!interval || interval <= 0) return;
    // 转换为毫秒（设置中以分钟为单位）
    const ms = interval * 60 * 1000;
    babeProactiveTimer = setInterval(() => {
      babeProactiveMessage();
    }, ms);
  }

  // 主动发消息：让 Babe 主动发起一条话题
  // 无论当前是否在 Babe 模式都会触发；消息只追加到 Babe Session（不会泄露到其他模式）
  // 如果当前没有 Babe 会话，则自动新建一个
  async function babeProactiveMessage() {
    // 若 babeAgent 尚未初始化，则自动新建 Babe 会话
    if (!babeAgent) {
      const ok = await initBabeAgent();
      if (!ok) return;
    }
    if (babeAgent.running) return; // 正在回复中，跳过
    // 注意：不再检查是否在 Babe 模式页面 —— 主动消息在任何模式下都应触发
    // 聊天内容只写入 #babe-chat-messages 和 babeMessages，天然与其他模式隔离
    babeProactiveActive = true;
    babeProactiveProduced = false;
    try {
      // 随机选一个话题提示，交给 LLM 以 Babe 口吻生成主动消息
      const topicHints = [
        '关心用户今天过得怎么样',
        '分享自己刚想到的一件小事',
        '询问用户最近在忙什么',
        '表达想用户的心情',
        '聊聊最近看到的有趣事物',
        '问问用户有没有好好吃饭'
      ];
      const hint = topicHints[Math.floor(Math.random() * topicHints.length)];
      // 调用 proactiveSend：让 Babe 主动发起，不走 user 消息路径
      await babeAgent.proactiveSend(hint);
    } catch (e) {
      console.error('[Babe] proactive message failed:', e);
    } finally {
      // 主动消息接收完成时发送系统通知（仅当确实产生了内容）
      const produced = babeProactiveProduced;
      babeProactiveActive = false;
      babeProactiveProduced = false;
      if (produced) {
        const babeName = babeAgent?.settings?.babe?.name || 'Babe';
        // 用户正在 Babe 模式页面时无需通知（直接可见）；否则绕过 sendAppNotification 的焦点检查
        const babePage = document.getElementById('page-babe');
        const onBabePage = !!(babePage && babePage.classList.contains('active'));
        if (!onBabePage) {
          try {
            const s = await window.api.getSettings();
            const n = s.notifications || {};
            if (n.enabled !== false && n.babeProactive !== false) {
              await window.api.sendNotification({
                title: `${babeName} 主动发来一条消息`,
                body: '快去看看 TA 说了什么吧',
                category: 'babeProactive'
              });
            }
          } catch (e) {
            console.warn('[Babe] proactive notification failed:', e?.message || e);
          }
        }
      }
    }
  }

  // ---- Babe Mode 事件绑定 ----
  document.getElementById('btn-babe-send')?.addEventListener('click', sendBabeMessage);
  document.getElementById('btn-babe-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('babe');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('btn-babe-new')?.addEventListener('click', async () => {
    stopVoicePlayback(); // 清空语音播放队列
    await createBabeSession();
  });
  document.getElementById('btn-babe-proactive')?.addEventListener('click', () => {
    if (!babeAgent) {
      window.showMessageModal('请先初始化 Babe 模式', '提示', 'warning');
      return;
    }
    babeProactiveMessage();
  });
  document.getElementById('babe-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBabeMessage();
    }
  });
  document.getElementById('babe-chat-input')?.addEventListener('input', (e) => {
    if (e.target.offsetParent === null) return; // 隐藏时不调整高度，避免 0px 塌陷
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  /* ==================== 屏幕软键盘 (OSK) ==================== */
  function getOskCore() {
    return window.OskCoreInstance || null;
  }
  function toggleOsk() {
    const osk = getOskCore();
    if (!osk) return;
    if (osk.visible) osk.hide();
    else { osk._ensureDict().catch(() => {}); osk.show(); }
    syncOskBtn();
  }

  function syncOskBtn() {
    const osk = getOskCore();
    const btn = document.getElementById('osk-toggle-btn');
    if (btn && osk) {
      btn.classList.toggle('active', osk.visible);
      btn.setAttribute('data-active', osk.visible ? '1' : '0');
    }
  }

  // 标题栏按钮
  const oskToggleBtn = document.getElementById('osk-toggle-btn');
  if (oskToggleBtn) {
    oskToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOsk();
    });
  }

  // 快捷键 F8
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      toggleOsk();
    }
  });

  // WebUI → 切换屏幕软键盘
  if (typeof window.api?.onWebControlToggleOsk === 'function') {
    window.api.onWebControlToggleOsk(() => { toggleOsk(); syncOskBtn(); });
  }

  // OSK 状态变化 → 同步标题栏按钮 + WebUI
  function oskStateObserver() {
    const osk = getOskCore();
    if (!osk) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(oskStateObserver, 50));
      } else {
        setTimeout(oskStateObserver, 100);
      }
      return;
    }
    const origPush = osk._pushWebState.bind(osk);
    osk._pushWebState = () => {
      syncOskBtn();
      origPush();
    };
  }
  oskStateObserver();

  // 设置变化 → 同步到 OSK（含子页面 settings:changed 广播）
  if (typeof window.api?.onSettingsChanged === 'function') {
    window.api.onSettingsChanged((s) => {
      if (s && s.ime && getOskCore()) getOskCore().applySettings(s.ime);
      // 托盘语音唤醒开关 → 设置页勾选状态联动回显
      if (s && s.voice && typeof s.voice.wakeEnabled === 'boolean') {
        const wakeEl = document.getElementById('setting-voice-wake');
        if (wakeEl && wakeEl.checked !== s.voice.wakeEnabled) wakeEl.checked = s.voice.wakeEnabled;
      }
    });
  }

  // 语音唤醒：采集窗状态/引擎错误 → 全局 toast。
  // macOS 隐藏采集窗口的 getUserMedia 失败（麦克风权限）与 AudioContext 挂起此前完全静默，
  // 用户勾选唤醒后毫无反应也看不到原因。
  if (typeof window.api?.onVoiceClientState === 'function') {
    let lastCaptureError = '';
    window.api.onVoiceClientState((d) => {
      if (!d || d.source !== 'capture') return;
      if (d.error) {
        if (d.error === lastCaptureError) return;
        lastCaptureError = d.error;
        const hint = /(notallowed|permission|denied|拒绝|权限)/i.test(d.error)
          ? '（请在 系统设置 → 隐私与安全性 → 麦克风 中允许本应用）'
          : '';
        if (typeof window.showToast === 'function') {
          window.showToast(`语音唤醒采集失败：${d.error}${hint}`, 'error', 7000);
        }
      } else {
        lastCaptureError = '';
      }
    });
  }
  if (typeof window.api?.onVoiceError === 'function') {
    let lastWakeError = '';
    window.api.onVoiceError((d) => {
      if (!d || d.scope !== 'wake') return;
      const msg = String(d.error || d.message || '');
      if (!msg || msg === lastWakeError) return;
      lastWakeError = msg;
      if (typeof window.showToast === 'function') {
        window.showToast(`语音唤醒异常：${msg}`, 'error', 7000);
      }
    });
  }

  /* ==================== 设置页：输入法标签 ==================== */
  async function loadImeSettings() {
    const s = await window.api.getSettings();
    const ime = s.ime || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    set('setting-ime-mode', ime.mode || 'zh');
    set('setting-ime-candidate-count', ime.candidateCount ?? 9);
    setChk('setting-ime-enabled', ime.enabled);
    const opEl = document.getElementById('setting-ime-opacity');
    const opVal = document.getElementById('setting-ime-opacity-val');
    const opPct = Math.round((ime.opacity ?? 1) * 100);
    if (opEl) { opEl.value = Math.max(30, Math.min(100, opPct)); if (opVal) opVal.textContent = opEl.value + '%'; }
  }

  function bindImeSettings() {
    const els = {
      'setting-ime-mode': (v) => ({ mode: v }),
      'setting-ime-candidate-count': (v) => ({ candidateCount: parseInt(v) || 9 }),
      'setting-ime-enabled': (v) => ({ enabled: !!v }),
      'setting-ime-opacity': (v) => ({ opacity: (parseInt(v) || 100) / 100 }),
    };
    Object.keys(els).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const build = els[id];
      const handler = async (e) => {
        let val = e.target.value;
        if (e.target.type === 'checkbox') val = e.target.checked;
        const s = await window.api.getSettings();
        s.ime = Object.assign({}, s.ime || {}, build(val));
        await saveSettings(s);
        if (getOskCore()) getOskCore().applySettings(s.ime);
        if (id === 'setting-ime-enabled') {
          const osk = getOskCore();
          if (val && osk) { osk._ensureDict().catch(() => {}); osk.show(); }
          if (!val && osk) osk.hide();
        }
        window.showToast?.('输入法设置已保存', 'success', 2000);
      };
      el.addEventListener('change', handler);
      if (el.type === 'range') {
        el.addEventListener('input', () => {
          const valId = id + '-val';
          const valEl = document.getElementById(valId);
          if (valEl) valEl.textContent = (id === 'setting-ime-opacity') ? el.value + '%' : el.value + 'px';
        });
      }
    });
  }

  // 挂载到 loadSettingsPage：每次打开设置页时刷新输入法设置
  bindImeSettings();
  loadImeSettings();

  /* ==================== 设置页：语音标签 ==================== */
  async function loadVoiceSettings() {
    const s = await window.api.getSettings();
    const v = s.voice || {};
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    setChk('setting-voice-stt', v.sttEnabled !== false);
    set('setting-voice-stt-model', (v.sttModel === 'tiny' ? 'tiny' : 'base'));
    set('setting-voice-stt-send-keywords', (v.sttSendKeywords || []).join('、'));
    setChk('setting-voice-tts', v.ttsEnabled === true);
    setChk('setting-voice-tts-auto', v.ttsAutoSpeak === true);
    set('setting-voice-tts-lang', v.ttsLang || 'auto');
    set('setting-voice-zh', (v.ttsVoices && v.ttsVoices.zh) || 'zf_xiaoxiao');
    set('setting-voice-en', (v.ttsVoices && v.ttsVoices.en) || 'af_heart');
    const speedEl = document.getElementById('setting-voice-speed');
    const speedValEl = document.getElementById('setting-voice-speed-val');
    const speed = Math.round((v.ttsSpeed != null ? v.ttsSpeed : 1.0) * 100);
    if (speedEl) { speedEl.value = Math.max(50, Math.min(200, speed)); if (speedValEl) speedValEl.textContent = (speed / 100).toFixed(2) + 'x'; }
    const volEl = document.getElementById('setting-voice-volume');
    const volValEl = document.getElementById('setting-voice-volume-val');
    const vol = Math.round((v.ttsVolume != null ? v.ttsVolume : 1.0) * 100);
    if (volEl) { volEl.value = Math.max(10, Math.min(100, vol)); if (volValEl) volValEl.textContent = vol + '%'; }
    const chunkEl = document.getElementById('setting-voice-tts-chunk');
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    const chunkSizeValEl = document.getElementById('setting-voice-tts-chunk-size-val');
    const chunkEnabled = v.ttsAutoChunk !== false;
    if (chunkEl) chunkEl.checked = chunkEnabled;
    const chunkChars = v.ttsChunkChars != null ? Math.round(v.ttsChunkChars) : 120;
    if (chunkSizeEl) {
      chunkSizeEl.value = Math.max(40, Math.min(300, chunkChars));
      if (chunkSizeValEl) chunkSizeValEl.textContent = Math.max(40, Math.min(300, chunkChars)) + '字';
    }
    const chunkRow = chunkSizeEl && chunkSizeEl.closest('.setting-item');
    if (chunkRow) chunkRow.style.opacity = chunkEnabled ? '1' : '0.4';
    setChk('setting-voice-wake', v.wakeEnabled === true);
    set('setting-voice-kws-threshold', (v.kws && v.kws.threshold != null) ? String(v.kws.threshold) : '0.25');
    set('setting-voice-hotkey', v.hotkey || 'Control+Shift+Space');
    renderWakeWordsList(s);
    refreshVoiceModelStatus();
  }

  async function renderWakeWordsList(s) {
    const listEl = document.getElementById('voice-wake-words-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const words = (s && s.voice && s.voice.wakeWords) || [];
    if (words.length === 0) {
      listEl.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary)">暂无唤醒词</span>';
      return;
    }
    words.forEach((w, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;';
      const tag = document.createElement('span');
      tag.textContent = w.phrase;
      tag.style.cssText = 'flex:1;padding:2px 8px;background:var(--surface-alt);border-radius:4px;';
      const actLabel = w.action === 'mainwindow' ? '弹主窗' : '语音条';
      const actEl = document.createElement('span');
      actEl.textContent = actLabel;
      actEl.style.cssText = 'font-size:10px;color:var(--text-tertiary);min-width:40px;text-align:right;';
      const enChk = document.createElement('input');
      enChk.type = 'checkbox';
      enChk.checked = w.enabled !== false;
      enChk.title = '启用';
      enChk.style.cssText = 'margin:0;cursor:pointer';
      enChk.addEventListener('change', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        if (currentW[idx]) currentW[idx].enabled = enChk.checked;
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已更新');
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon';
      delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      delBtn.style.cssText = 'font-size:10px;padding:0;width:18px;height:18px';
      delBtn.addEventListener('click', async () => {
        const currentS = await window.api.getSettings();
        const currentW = (currentS.voice && currentS.voice.wakeWords) || [];
        currentW.splice(idx, 1);
        if (!currentS.voice) currentS.voice = {};
        currentS.voice.wakeWords = currentW;
        await saveVoiceSettings(currentS, '唤醒词已删除');
        renderWakeWordsList(currentS);
      });
      row.appendChild(tag);
      row.appendChild(actEl);
      row.appendChild(enChk);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    });
  }

  async function saveVoiceSettings(s, toast) {
    if (typeof s === 'string') { toast = s; s = await window.api.getSettings(); }
    if (!s) s = await window.api.getSettings();
    try {
      await saveSettings(s);
      if (toast && typeof window.showToast === 'function') window.showToast(toast, 'success', 2000);
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('保存失败: ' + (e && e.message), 'error', 3000);
    }
  }

  async function refreshVoiceModelStatus() {
    const el = document.getElementById('voice-model-status');
    if (!el) return;
    try {
      const r = await window.api.voiceGetStatus();
      if (r && r.ok) {
        if (r.missing && r.missing.length) {
          el.textContent = '缺失模型: ' + r.missing.join(', ');
        } else {
          el.textContent = '内置模型就绪（whisper-base + Kokoro 中英 + Piper 德语）';
        }
      } else {
        el.textContent = '语音引擎未启动或模型缺失';
      }
    } catch {
      el.textContent = '无法查询引擎状态';
    }
  }

  function bindVoiceSettings() {
    const setChkId = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = el.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    setChkId('setting-voice-stt', 'sttEnabled');
    setChkId('setting-voice-tts', 'ttsEnabled');
    setChkId('setting-voice-tts-auto', 'ttsAutoSpeak');

    const bind = (id, key, transform) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        const val = el.type === 'checkbox' ? el.checked : el.value;
        if (transform) transform(s.voice, val);
        else s.voice[key] = val;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    };
    bind('setting-voice-tts-lang', 'ttsLang');
    bind('setting-voice-stt-model', 'sttModel');
    bind('setting-voice-kws-threshold', 'threshold', (voice, val) => { if (!voice.kws) voice.kws = {}; voice.kws.threshold = parseFloat(val) || 0.25; });
    bind('setting-voice-stt-send-keywords', 'sttSendKeywords', (voice, val) => {
      voice.sttSendKeywords = String(val || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    });

    // 中文音色
    const zhEl = document.getElementById('setting-voice-zh');
    if (zhEl) zhEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.zh = zhEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });
    const enEl = document.getElementById('setting-voice-en');
    if (enEl) enEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.ttsVoices) s.voice.ttsVoices = {};
      s.voice.ttsVoices.en = enEl.value;
      await saveVoiceSettings(s);
      try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
    });

    // 长文本自动分块开关
    const chunkToggleEl = document.getElementById('setting-voice-tts-chunk');
    if (chunkToggleEl) {
      chunkToggleEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsAutoChunk = chunkToggleEl.checked;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
        const sizeEl = document.getElementById('setting-voice-tts-chunk-size');
        const row = sizeEl && sizeEl.closest('.setting-item');
        if (row) row.style.opacity = chunkToggleEl.checked ? '1' : '0.4';
      });
    }
    const chunkSizeEl = document.getElementById('setting-voice-tts-chunk-size');
    if (chunkSizeEl) {
      chunkSizeEl.addEventListener('input', () => {
        const valEl = document.getElementById('setting-voice-tts-chunk-size-val');
        if (valEl) valEl.textContent = chunkSizeEl.value + '字';
      });
      chunkSizeEl.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice.ttsChunkChars = parseInt(chunkSizeEl.value) || 80;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 语速/音量 range
    for (const [id, key, label] of [['setting-voice-speed', 'ttsSpeed', 'x'], ['setting-voice-volume', 'ttsVolume', '%']]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const valEl = document.getElementById(id + '-val');
        if (valEl) valEl.textContent = key === 'ttsSpeed' ? (parseInt(el.value) / 100).toFixed(2) + label : el.value + label;
      });
      el.addEventListener('change', async () => {
        const s = await window.api.getSettings();
        if (!s.voice) s.voice = {};
        s.voice[key] = parseInt(el.value) / 100;
        await saveVoiceSettings(s);
        try { if (window.VoiceUI) window.VoiceUI.applySettings(s); } catch (_) {}
      });
    }
    // 唤醒
    setChkId('setting-voice-wake', 'wakeEnabled');
    // 热键
    const hotkeyEl = document.getElementById('setting-voice-hotkey');
    if (hotkeyEl) hotkeyEl.addEventListener('change', async () => {
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      s.voice.hotkey = hotkeyEl.value;
      await saveVoiceSettings(s);
    });
    // 试听按钮
    const testBtn = document.getElementById('btn-voice-test');
    if (testBtn) testBtn.addEventListener('click', () => {
      const lang = document.getElementById('setting-voice-tts-lang')?.value || 'zh';
      const testTexts = { zh: '你好，我是你的AI伙伴，很高兴能为你服务！', en: 'Hello! I am your AI partner, ready to assist you.', de: 'Hallo! Ich bin dein KI-Partner und helfe dir gerne.' };
      try { if (window.VoiceUI) window.VoiceUI.speakText(testTexts[lang] || testTexts.zh, lang); } catch (_) {}
    });
    // 添加唤醒词
    const addBtn = document.getElementById('btn-voice-add-wake');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const phrase = document.getElementById('voice-new-wake-phrase')?.value?.trim();
      const action = document.getElementById('voice-new-wake-action')?.value || 'voicebar';
      if (!phrase) return;
      const s = await window.api.getSettings();
      if (!s.voice) s.voice = {};
      if (!s.voice.wakeWords) s.voice.wakeWords = [];
      s.voice.wakeWords.push({ phrase, action, enabled: true });
      document.getElementById('voice-new-wake-phrase').value = '';
      await saveVoiceSettings(s, '唤醒词已添加');
      renderWakeWordsList(s);
    });
    // 录制热键
    const recBtn = document.getElementById('btn-voice-record-hotkey');
    if (recBtn) {
      recBtn.addEventListener('click', () => {
        const input = document.getElementById('setting-voice-hotkey');
        if (!input) return;
        const origText = recBtn.textContent;
        const origDisabled = recBtn.disabled;
        recBtn.textContent = '按下组合键（松开结束）…';
        recBtn.disabled = true;

        // 归一化按键名（修饰键统一命名，字母大写，空格映射为 Space）
        const norm = (e) => {
          const k = e.key || '';
          if (k === 'Control' || k === 'Ctrl') return 'Control';
          if (k === 'Shift') return 'Shift';
          if (k === 'Alt') return 'Alt';
          if (k === 'Meta') return 'Command';
          if (k === ' ') return 'Space';
          if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
          return k;
        };

        const pressed = new Set();   // 当前按住的键（归一化）
        const recorded = new Set();  // 本次录制出现过的键（用于最终组合）
        const isModifier = (n) => ['Control', 'Shift', 'Alt', 'Command'].includes(n);

        const render = () => {
          // 修饰键按固定顺序排列在前，主键在后
          const mods = ['Control', 'Command', 'Shift', 'Alt'].filter((m) => recorded.has(m));
          const main = [...recorded].find((n) => !isModifier(n));
          const parts = main ? [...mods, main] : mods;
          input.value = parts.join('+');
        };

        const cleanup = (commit) => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', onKeyUp, true);
          window.removeEventListener('blur', onBlur, true);
          recBtn.textContent = origText;
          recBtn.disabled = origDisabled;
          // 提交录制结果：触发 change 事件以持久化到设置
          if (commit && recorded.size > 0) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };

        const onKeyDown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') { cleanup(false); return; }
          const n = norm(e);
          if (!n) return;
          pressed.add(n);
          recorded.add(n);
          render();
        };

        const onKeyUp = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const n = norm(e);
          if (!n) return;
          pressed.delete(n);
          // 全部松开且本次已录入至少一个键 → 完成
          if (pressed.size === 0 && recorded.size > 0) {
            cleanup(true);
          }
        };

        const onBlur = () => {
          if (recorded.size > 0 && pressed.size === 0) {
            cleanup(true);
          }
        };

        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur, true);
      });
    }
    // 刷新模型状态
    const refreshBtn = document.getElementById('btn-voice-refresh-status');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshVoiceModelStatus());
  }

  bindVoiceSettings();
  loadVoiceSettings();
  // 启动时将语音设置同步给 VoiceUI（试听/自动朗读依赖 settings 判开关）
  window.api.getSettings().then((s) => {
    if (window.VoiceUI) {
      try { window.VoiceUI.applySettings(s); } catch (_) {}
    }
  });
