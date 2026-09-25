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
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor"></span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor"></span>';
            bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
            try { bubble.reasoningEl.scrollTop = bubble.reasoningEl.scrollHeight; } catch (_) {}
          }
          scrollChatToBottom(msgsEl);
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
