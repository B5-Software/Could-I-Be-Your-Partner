  function unsubscribeAgentStreams(ag) {
    if (!ag) return;
    if (typeof ag.unsubscribeStreams === 'function') {
      try { ag.unsubscribeStreams(); } catch { /* ignore */ }
    }
  }

  function setupAgentStreamSubscriptions(ag, mode) {
    if (!ag || !window.api) return;
    if (window.api.onLLMRetry && !ag._llmRetryUnsub) {
      ag._llmRetryUnsub = window.api.onLLMRetry((info) => {
        if (!info || !ag.onMessage) return;
        // 仅处理属于当前会话的重试事件，避免其他模式会话的重试气泡串进来
        if (info.sessionKey && info.sessionKey !== ag.sessionKey) return;
        const kind = info.kind || 'unknown';
        const delayTxt = info.delayMs ? `，${Math.round(info.delayMs / 100) / 10}s 后重试` : '';
        const reasonTxt = info.reason ? `（${info.reason}）` : '';
        ag.onMessage('system', `LLM 请求失败（${kind}），第 ${info.attempt || 1} 次重试${delayTxt}${reasonTxt}`);
      });
    }
    if (window.api.onStreamChunk && !ag._streamChunkUnsub) {
      ag._streamChunkUnsub = window.api.onStreamChunk((chunk) => {
        if (!chunk || chunk.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-chunk', chunk);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && chunk.content && (!session || session.active)) {
          window.VoiceUI.feedStreamChunk(chunk.content);
        }
      });
    }
    if (window.api.onStreamEnd && !ag._streamEndUnsub) {
      ag._streamEndUnsub = window.api.onStreamEnd((data) => {
        if (!data || data.requestId !== ag._activeStreamRequestId) return;
        if (ag.onMessage) ag.onMessage('stream-end', data);
        const session = sessionManager?.getByAgent(ag);
        if (window.VoiceUI && (!session || session.active)) {
          window.VoiceUI.feedStreamEnd(data && data.content ? data.content : null);
        }
      });
    }
  }

  function wireCodeAgent(ag) {
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
      const msgsEl = document.getElementById('code-chat-messages');
      if (!msgsEl) return;
      if (!isActive()) {
        if (type === 'approval') {
          // SessionManager 已记录等待审批状态，这里只刷新 tab。
          if (typeof renderAllSessionTabs === 'function') renderAllSessionTabs();
        } else if (type === 'present-file' && sessionManager) {
          const session = sessionManager.getByAgent(ag);
          if (session) sessionManager.bufferUiEvent(session, { type: 'present-file', data });
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
        }
        return;
      }
      switch (type) {
        case 'assistant':
          addCodeMessage('assistant', data);
          break;
        case 'system':
          addCodeMessage('system', data);
          break;
        case 'stream-chunk': {
          const bubble = codeStreamBubble;
          if (!bubble) return;
          if (data.content) {
            const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, data.content);
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
          const bubble = codeStreamBubble;
          if (!bubble) {
            if (isAuthoritativeFinal && data.requestId) {
              const target = msgsEl.querySelector(`[data-stream-request="${cssEscape(data.requestId)}"]`);
              if (target) {
                const body = target.querySelector('.message-content, .code-msg-content, .message-body');
                const clean = String(data.content || '').trimEnd();
                if (body && clean) body.innerHTML = renderMarkdown(clean);
              }
            }
            codeStreamBubble = null;
            return;
          }
          if (!isAuthoritativeFinal) return;
          if (bubble.renderTimer) { clearTimeout(bubble.renderTimer); bubble.renderTimer = null; }
          const hasReasoning = !!(data.reasoning || bubble.rawReasoning);
          const finalContent = String(data.content || bubble.rawContent).trimEnd();
          const hasContent = !!(finalContent && finalContent.trim());
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
            const timeEl = bubble.el.querySelector('.message-time');
            if (timeEl) timeEl.style.display = 'none';
          } else {
            bubble.el.remove();
            if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
            codeStreamBubble = null;
            break;
          }
          bubble.el.classList.remove('streaming');
          if (bubble.el.id) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          codeStreamBubble = null;
          break;
        }
        case 'stream-start':
          codeStreamBubble = createCodeStreamBubble();
          if (codeStreamBubble?.el && data?.requestId) {
            codeStreamBubble.el.setAttribute('data-stream-request', String(data.requestId));
          }
          break;
        case 'tool_call':
          addCodeToolCall(data);
          break;
        case 'approval':
          showCodeApprovalPanel(data.toolName, data.args);
          break;
        case 'tool-auth-required':
          showToolAuthModal(data.toolName, data.category, ag);
          break;
        case 'tool-result':
          addCodeToolResult(data);
          if (data && _fileSystemTools.has(data.name) && codeWorkspacePath) loadCodeFileTree(codeWorkspacePath);
          break;
        case 'present-file':
          addFilePresentCard(data);
          sendAppNotification('present', 'Agent 向您呈递文件', data?.title || data?.filename || '请查看文件内容');
          break;
      }
    };
  }
