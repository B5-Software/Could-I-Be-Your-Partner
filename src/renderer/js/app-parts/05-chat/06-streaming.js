  function startStreamingMessage(requestId) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    // 保留思考指示器直到第一个 chunk 到达——避免流式开始前的视觉空白期。
    // appendStreamChunk 在首个 chunk 到达时会移除 thinking 指示器。

    const msg = document.createElement('div');
    msg.className = 'message assistant streaming';
    msg.id = 'stream-' + requestId;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="reasoning-section" style="display:none;">
          <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <i class="fa-solid fa-brain"></i>
            <span>推理过程</span>
            <i class="fa-solid fa-chevron-down reasoning-toggle-icon"></i>
          </div>
          <div class="reasoning-content markdown-body"></div>
        </div>
        <div class="message-content markdown-body"></div>
        <div class="message-time">${time}</div>
      </div>`;
    msg.style.display = 'none'; // hidden until first chunk arrives
    appendChatElement(msg);
    streamingBubbles.set(requestId, {
      el: msg,
      contentEl: msg.querySelector('.message-content'),
      reasoningEl: msg.querySelector('.reasoning-section'),
      reasoningContentEl: msg.querySelector('.reasoning-content'),
      timeEl: msg.querySelector('.message-time'),
      rawContent: '',
      rawReasoning: '',
      renderTimer: null,
      shown: false,
      reasoningShown: false,
      contentStarted: false // 标记 final content 是否开始（用于移除 reasoning 光标）
    });
  }

  // 流式 chunk 去重辅助：只做绝对安全的去重（防同一份数据被消费两次），
  // 不做"边界重叠剥离"——Babe 语气存在大量真实叠词，易误伤。
  // 返回 { raw, lastChunk }
  function dedupAppendChunk(raw, lastChunk, chunkContent) {
    if (!chunkContent) return { raw, lastChunk };
    // 连续重复 chunk（同一份数据被传输/消费两次）：丢弃
    if (chunkContent === lastChunk) return { raw, lastChunk };
    // 累积模式：chunk 包含此前全部已渲染文本（替换而非追加）
    if (chunkContent.length > raw.length && chunkContent.startsWith(raw)) {
      return { raw: chunkContent, lastChunk };
    }
    return { raw: raw + chunkContent, lastChunk: chunkContent };
  }

  // Appends a chunk to the streaming bubble (throttled markdown re-render).
  function appendStreamChunk(requestId, chunk) {
    const bubble = streamingBubbles.get(requestId);
    if (!bubble) return;
    const chunkContent = typeof chunk === 'string' ? chunk : (chunk?.content || '');
    const chunkReasoning = typeof chunk === 'object' ? (chunk?.reasoning || '') : '';
    if (!chunkContent && !chunkReasoning) return;

    if (chunkReasoning) {
      bubble.rawReasoning += chunkReasoning;
      if (!bubble.reasoningShown) {
        bubble.reasoningEl.style.display = '';
        bubble.reasoningShown = true;
      }
    }
    if (chunkContent) {
      const dedup = dedupAppendChunk(bubble.rawContent, bubble._lastChunk, chunkContent);
      bubble.rawContent = dedup.raw;
      bubble._lastChunk = dedup.lastChunk;
      bubble.contentStarted = true; // 标记 final content 开始，停止 reasoning 光标
    }
    if (!bubble.shown) {
      bubble.el.style.display = '';
      bubble.shown = true;
      // 第一个 chunk 到达，移除思考指示器（流式内容接管显示）
      removeThinkingIndicator();
    }
    // Throttle markdown re-render to ~8 fps to avoid layout thrash on long streams.
    if (!bubble.renderTimer) {
      bubble.renderTimer = setTimeout(() => {
        bubble.renderTimer = null;
        if (bubble.contentEl) {
          bubble.contentEl.innerHTML = bubble.rawContent
            ? renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor"></span>'
            : '';
        }
        if (bubble.reasoningContentEl && bubble.rawReasoning) {
          // During streaming: show reasoning expanded (live)
          // 一旦 final content 开始，就移除 reasoning 的光标（思考已结束）
          bubble.reasoningEl.classList.remove('collapsed');
          const reasoningCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor"></span>';
          bubble.reasoningContentEl.innerHTML = renderMarkdown(bubble.rawReasoning) + reasoningCursor;
          // 自动滚屏：让最新 reasoning 文本可见
          try { bubble.reasoningContentEl.scrollTop = bubble.reasoningContentEl.scrollHeight; } catch (_) {}
        }
        scrollChatToBottom();
        // 远程镜像推送进一步降频：每 ~480ms 推送一次（每 4 次渲染推送 1 次）
        // outerHTML 序列化大元素开销大，是子代理运行时卡顿的主要来源
        if (!isRemoteMode && bubble.el.id) {
          bubble._mirrorCounter = (bubble._mirrorCounter || 0) + 1;
          if (bubble._mirrorCounter >= 4) {
            bubble._mirrorCounter = 0;
            WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
          }
        }
      }, 120);
    }
  }

  // Finalizes the streaming bubble: full markdown render, collapse reasoning.
  function finalizeStreamMessage(requestId, data) {
    const bubble = streamingBubbles.get(requestId);
    if (!bubble) return;
    // main.js 先广播的无 content 流结束信号：不固化，等待带权威 content 的结束（agent.js commit）。
    // 只有 data 携带 content（或为字符串内容）时才做最终固化，避免显示停留在流式累积的中间状态。
    const isAuthoritativeFinal = (typeof data === 'string')
      || !(data && typeof data === 'object')
      || data.content !== undefined;
    if (!isAuthoritativeFinal) return;
    streamingBubbles.delete(requestId);
    if (bubble.renderTimer) {
      clearTimeout(bubble.renderTimer);
      bubble.renderTimer = null;
    }
    const fullContent = typeof data === 'object' ? (data?.content || '') : (typeof data === 'string' ? data : '');
    const fullReasoning = typeof data === 'object' ? (data?.reasoning || '') : '';
    const content = fullContent || bubble.rawContent;
    const reasoning = fullReasoning || bubble.rawReasoning;

    if (!content || !content.trim()) {
      if (!reasoning || !reasoning.trim()) {
        // Empty response (e.g. only tool calls) — remove the placeholder bubble.
        bubble.el.remove();
        // 增量推送：移除空响应的流式气泡
        if (bubble.el.id) {
          WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#' + bubble.el.id });
        }
        return;
      }
      // 仅 reasoning 无 final content：隐藏空的内容气泡和时间戳，只保留 reasoning 容器
      if (bubble.contentEl) bubble.contentEl.style.display = 'none';
      if (bubble.timeEl) bubble.timeEl.style.display = 'none';
      if (bubble.reasoningContentEl && reasoning.trim()) {
        bubble.reasoningEl.style.display = '';
        bubble.reasoningEl.classList.remove('collapsed'); // reasoning-only 时默认展开
        bubble.reasoningContentEl.innerHTML = renderMarkdown(reasoning);
      }
      bubble.el.classList.remove('streaming');
      bubble.el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, bubble.el, 'assistant');
      });
      scrollChatToBottom();
      // 增量推送：更新流式气泡为最终状态
      if (bubble.el.id) {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
      }
      return;
    }
    bubble.rawContent = content;
    if (bubble.contentEl) {
      bubble.contentEl.innerHTML = content ? renderMarkdown(content) : '';
    }
    // After completion: collapse reasoning by default (user can expand)
    if (bubble.reasoningContentEl && reasoning && reasoning.trim()) {
      bubble.reasoningEl.style.display = '';
      bubble.reasoningEl.classList.add('collapsed');
      bubble.reasoningContentEl.innerHTML = renderMarkdown(reasoning);
      // 即使折叠，也滚到底部，方便用户展开后看到最新内容
      try { bubble.reasoningContentEl.scrollTop = bubble.reasoningContentEl.scrollHeight; } catch (_) {}
    }
    bubble.el.classList.remove('streaming');
    // Attach context menu like a normal assistant message
    bubble.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, bubble.el, 'assistant');
    });
    scrollChatToBottom();
    // 增量推送：更新流式气泡为最终状态
    if (bubble.el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + bubble.el.id, html: bubble.el.outerHTML });
    }
  }

  // ---- 图片操作公共实现（右键菜单 / 悬浮工具栏 / 预览工具栏共用）----
