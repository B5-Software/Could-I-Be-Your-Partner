  // ==================== Babe Mode (恋爱模式) ====================
  let babeAgent = null;
  let babeMessages = [];
  let babeCurrentHistoryId = null;
  let babeStreamBubble = null;
  let babeProactiveTimer = null;
  // 主动消息追踪：标记当前是否为主动消息回合，以及是否已产生内容
  let babeProactiveActive = false;
  let babeProactiveProduced = false;

  function clearBabeStreamBubble() {
    if (babeStreamBubble?.renderTimer) clearTimeout(babeStreamBubble.renderTimer);
    babeStreamBubble = null;
  }

  function restoreBabeStreamBubble(stream) {
    if (!stream || (!stream.requestId && !stream.content && !stream.reasoning)) return null;
    clearBabeStreamBubble();
    const bubble = createBabeStreamBubble();
    if (!bubble) return null;
    if (stream.requestId && bubble.el) {
      bubble.el.setAttribute('data-stream-request', String(stream.requestId));
    }
    setReasoningLabel(bubble.reasoningSection, stream);
    bubble.rawContent = String(stream.content || '').replace(/【好感度[+-]?\d+】/g, '');
    bubble.rawReasoning = stream.reasoning || '';
    bubble.contentStarted = Boolean(bubble.rawContent);
    if (bubble.rawReasoning) {
      bubble.reasoningSection.style.display = 'block';
      if (stream.finalized) {
        bubble.reasoningSection.classList.add('collapsed');
        bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
      } else {
        bubble.reasoningSection.classList.remove('collapsed');
        const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor"></span>';
        bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning) + rCursor;
      }
    }
    if (bubble.rawContent) {
      bubble.contentEl.innerHTML =
        renderMarkdown(bubble.rawContent) + (stream.finalized ? '' : '<span class="streaming-cursor"></span>');
    } else if (stream.finalized && bubble.rawReasoning) {
      bubble.contentEl.style.display = 'none';
      const timeEl = bubble.el.querySelector('.babe-msg-time');
      if (timeEl) timeEl.style.display = 'none';
    }
    if (stream.finalized) {
      window.CibypMessages?.bind(bubble.el, { mode: 'babe', role: 'assistant', content: bubble.rawContent });
      bubble.el.classList.remove('streaming');
      babeStreamBubble = null;
    } else {
      babeStreamBubble = bubble;
    }
    return bubble;
  }

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
        case 'conversation-replaced':
          replayBabeSession(sessionManager?.getByAgent(ag) || { agent: ag });
          break;
        case 'user': addBabeMessage('user', data); break;
        case 'assistant':
          addBabeMessage('assistant', data);
          if (babeProactiveActive) babeProactiveProduced = true;
          break;
        case 'system':
          addBabeMessage('system', data);
          break;
        case 'stream-chunk': {
          if (!babeStreamBubble || !babeStreamBubble.el?.isConnected) {
            babeStreamBubble = createBabeStreamBubble();
            if (babeStreamBubble?.el && data?.requestId) {
              babeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
            }
          }
          const bubble = babeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const cleanContent = data.content.replace(/【好感度[+-]?\d+】/g, '');
            bubble.rawContent += cleanContent;
            bubble.contentStarted = true;
            bubble.contentEl.innerHTML = renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor"></span>';
            if (bubble.rawReasoning) bubble.reasoningEl.innerHTML = renderMarkdown(bubble.rawReasoning);
          }
          setReasoningLabel(bubble.reasoningSection, data);
          if (data.reasoning) {
            bubble.rawReasoning += data.reasoning;
            bubble.reasoningSection.style.display = 'block';
            const rCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor"></span>';
            renderStreamingReasoning(bubble.reasoningEl, renderMarkdown(bubble.rawReasoning) + rCursor);
          }
          scrollChatToBottom(msgsEl);
          if (!bubble.renderTimer) {
            bubble.renderTimer = setTimeout(() => {
              bubble.renderTimer = null;
              if (bubble.el?.isConnected && bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
            }, 120);
          }
          break;
        }
        case 'stream-end': {
          const isAuthoritativeFinal = !!(data && typeof data === 'object' && data.content !== undefined);
          if (!isAuthoritativeFinal) return;
          let bubble = babeStreamBubble;
          if (!bubble || !bubble.el?.isConnected) {
            if (data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.babe-msg-bubble, .babe-msg-content, .babe-msg-body, .message-content');
                const clean = String(data.content || '').replace(/【好感度[+-]?\d+】/g, '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
                target.classList.remove('streaming');
                babeStreamBubble = null;
                return;
              }
            }
            const cleanFinal = String(data.content || '').replace(/【好感度[+-]?\d+】/g, '').trimEnd();
            if (cleanFinal || data.reasoning) {
              bubble = createBabeStreamBubble();
              if (bubble?.el && data.requestId) bubble.el.setAttribute('data-stream-request', String(data.requestId));
            }
          }
          if (!bubble) {
            babeStreamBubble = null;
            return;
          }
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          setReasoningLabel(bubble.reasoningSection, data);
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = (data.content || bubble.rawContent).replace(/【好感度[+-]?\d+】/g, '').trimEnd();
          bubble.rawContent = finalContent;
          const hasContent = !!(finalContent && finalContent.trim());
          if (babeProactiveActive && hasContent) babeProactiveProduced = true;
          if (hasReasoning) {
            bubble.reasoningSection.classList.add('collapsed');
            bubble.reasoningSection.style.display = 'block';
            bubble.reasoningEl.innerHTML = renderMarkdown(data.reasoning || bubble.rawReasoning);
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
          window.CibypMessages?.bind(bubble.el, {mode:'babe', role:'assistant', content:finalContent});
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          babeStreamBubble = null;
          break;
        }
        case 'stream-start':
          clearBabeStreamBubble();
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
        case 'relationship-change':
          renderBabeRelationship(data);
          break;
        case 'affection-change':
          showBabeAffectionChange(data.delta, data.value);
          updateBabeAffection(data.value);
          break;
        case 'error':
          showToast(data?.error || data?.message || String(data), 'error');
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
