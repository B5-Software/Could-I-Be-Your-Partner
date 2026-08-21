  // ---- Chat Functions ----
  // 滚动节流：合并同一帧内的多次滚动请求，避免密集重排
  let _scrollRafScheduled = false;
  // 滚动到指定聊天容器的底部。目标元素取容器最后一条消息（而非 thinking-indicator），
  // 这样当 Agent 发送问卷、卡片等带交互的富内容时，滚动定位到内容自身而不是工具调用控件。
  function scrollChatToBottom(targetEl) {
    const container = targetEl || document.getElementById('thinking-indicator')?.parentElement || chatMessages;
    if (_scrollRafScheduled) return;
    _scrollRafScheduled = true;
    requestAnimationFrame(() => {
      _scrollRafScheduled = false;
      const target = container.lastElementChild;
      if (target && target.scrollIntoView) {
        // 直接定位到容器内容底部（内容可能比视口高，用 end 保证底部贴齐）
        target.scrollIntoView({ behavior: 'auto', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  // 暴露 renderMarkdown 供 VirtualScroller 使用
  window.renderMarkdown = renderMarkdown;

  function appendChatElement(el) {
    // 模式感知：根据当前模式把元素追加到对应的消息容器，
    // 避免 Code/Babe 模式的问卷等交互逃逸到 Chat 模式。
    let targetMessagesEl = chatMessages;
    if (currentMode === 'code') {
      targetMessagesEl = document.getElementById('code-chat-messages') || chatMessages;
    } else if (currentMode === 'babe') {
      targetMessagesEl = document.getElementById('babe-chat-messages') || chatMessages;
    }
    const thinking = document.getElementById('thinking-indicator');
    const insertedBeforeThinking = thinking && targetMessagesEl === chatMessages;
    if (insertedBeforeThinking) {
      targetMessagesEl.insertBefore(el, thinking);
    } else {
      targetMessagesEl.appendChild(el);
    }
    scrollChatToBottom(targetMessagesEl);
    // 增量推送：非远程模式才序列化 outerHTML 推送（序列化大元素开销大）
    if (!isRemoteMode) {
      WebUIMirror.pushDomEvent({
        type: 'dom_append',
        container: getChatContainerSelector(),
        html: el.outerHTML,
        before: insertedBeforeThinking ? '#thinking-indicator' : null,
      });
    }
  }

  // ============ 聊天记录搜索（Chat/Code/Babe 共用，Ctrl+F 打开） ============
  const chatSearch = (() => {
    const overlay = document.getElementById('chat-search-overlay');
    const input = document.getElementById('chat-search-input');
    const countEl = document.getElementById('chat-search-count');
    if (!overlay || !input || !countEl) return null;

    let query = '';
    let marks = [];      // 所有高亮 <mark> 元素
    let activeIdx = -1;  // 当前激活的 mark 索引
    let searchableMsgs = []; // 上次搜索的消息元素列表

    // 获取当前模式对应的消息容器选择器
    function getContainer() {
      if (currentMode === 'code') return document.getElementById('code-chat-messages');
      if (currentMode === 'babe') return document.getElementById('babe-chat-messages');
      return chatMessages;
    }

    // 清理所有高亮标记
    function clearMarks() {
      marks.forEach(m => {
        try {
          const parent = m.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(m.textContent), m);
            parent.normalize();
          }
        } catch { /* ignore */ }
      });
      marks = [];
      activeIdx = -1;
      restoreAutoExpandedReasoning();
    }

    // 搜索期间自动展开的 Reasoning 段，切换/关闭时按原状态恢复折叠
    let lastExpandedReasoning = null;
    function restoreAutoExpandedReasoning() {
      if (lastExpandedReasoning) {
        const rs = lastExpandedReasoning.section;
        if (rs && rs.isConnected && lastExpandedReasoning.wasCollapsed && !rs.classList.contains('streaming-reasoning')) {
          rs.classList.add('collapsed');
        }
        lastExpandedReasoning = null;
      }
    }
    // 命中点落在折叠的 Reasoning 内时，临时展开对应段（离开后由 restore 恢复）
    function expandReasoningAround(mark) {
      restoreAutoExpandedReasoning();
      if (!mark || !mark.closest) return;
      const rs = mark.closest('.reasoning-section');
      if (!rs) return;
      lastExpandedReasoning = { section: rs, wasCollapsed: rs.classList.contains('collapsed') };
      rs.classList.remove('collapsed');
    }

    // 在文本节点中查找并包裹匹配片段（保留原始 DOM 结构）
    function highlightNode(node, q) {
      const text = node.textContent;
      const lower = text.toLowerCase();
      const ql = q.toLowerCase();
      if (!ql || !lower.includes(ql)) return;
      const frag = document.createDocumentFragment();
      let idx = 0;
      let start = lower.indexOf(ql);
      while (start !== -1) {
        if (start > idx) frag.appendChild(document.createTextNode(text.slice(idx, start)));
        const mark = document.createElement('mark');
        mark.className = 'chat-search-mark';
        mark.textContent = text.slice(start, start + q.length);
        frag.appendChild(mark);
        marks.push(mark);
        idx = start + q.length;
        start = lower.indexOf(ql, idx);
      }
      if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
      node.parentNode.replaceChild(frag, node);
    }

    // 递归遍历消息元素的可搜索文本节点（跳过时间戳、按钮、图标等）
    function walkTextNodes(el) {
      if (!el) return;
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          highlightNode(child, query);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const cls = child.className || '';
          const tag = child.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BUTTON' ||
              cls.includes('message-time') || cls.includes('msg-time') || cls.includes('message-avatar')) continue;
          walkTextNodes(child);
        }
      }
    }

    // 执行搜索
    function runSearch(q) {
      clearMarks();
      query = q.trim();
      const container = getContainer();
      if (!container) { countEl.textContent = '0 / 0'; return; }

      // 收集消息元素（message / babe-message）
      searchableMsgs = Array.from(container.querySelectorAll('.message, .babe-message'));
      if (!query) {
        marks = [];
        countEl.textContent = '0 / 0';
        return;
      }

      // 对每个消息元素内的文本节点做高亮
      for (const msg of searchableMsgs) {
        walkTextNodes(msg);
      }

      // 过滤出包含匹配的消息
      const matchedMsgs = [];
      for (const msg of searchableMsgs) {
        if (msg.querySelector('.chat-search-mark')) matchedMsgs.push(msg);
      }

      // 在匹配消息上打标记（隐藏不匹配消息，但保持布局简单：只滚动定位）
      // 统计实际 mark 数量
      countEl.textContent = marks.length > 0 ? `1 / ${marks.length}` : '0 / 0';
      if (marks.length > 0) {
        activeIdx = 0;
        activateMark(0, matchedMsgs);
      }
      searchableMsgs = matchedMsgs;
    }

    // 可靠地将 mark 滚动到滚动容器可视区域居中。
    // 不使用 scrollIntoView({ behavior:'smooth' })，避免在 Code 模式内容重新渲染 /
    // 自动滚屏竞争时失效，直接按容器 scrollTop 定位。
    function scrollContainerToMark(mark) {
      const container = getContainer();
      if (!container || !mark || container.clientHeight <= 0) return;
      try {
        const cRect = container.getBoundingClientRect();
        const mRect = mark.getBoundingClientRect();
        // mark 已在可视区域且未越界时保持不动（避免扰乱用户手动滚动位置）
        const alreadyVisible =
          mRect.top >= cRect.top - 8 && mRect.bottom <= cRect.bottom + 8;
        if (alreadyVisible) return;
        const rel = mRect.top - cRect.top;
        container.scrollTop += rel - container.clientHeight / 2;
      } catch { /* ignore */ }
    }

    // 激活指定 mark，并滚动到可见
    function activateMark(idx, matchedMsgs) {
      if (!marks.length) return;
      idx = ((idx % marks.length) + marks.length) % marks.length;
      activeIdx = idx;
      marks.forEach((m, i) => m.classList.toggle('active', i === idx));
      const mark = marks[idx];
      expandReasoningAround(mark);
      scrollContainerToMark(mark);
      // 若 mark 位于嵌套可滚动元素内（如 code 工具调用参数），再滚动该嵌套容器的父链
      let owner = mark.closest('pre.tool-call-args, .message-body, .content');
      if (owner && owner.scrollTo) {
        try {
          const oRect = owner.getBoundingClientRect();
          const mRect = mark.getBoundingClientRect();
          if (mRect.top < oRect.top || mRect.bottom > oRect.bottom) {
            owner.scrollIntoView({ block: 'nearest' });
          }
        } catch { /* ignore */ }
      }
      // 更新计数器：当前第几个 / 总数
      const matchedCount = matchedMsgs ? matchedMsgs.length : searchableMsgs.length;
      countEl.textContent = `${idx + 1} / ${marks.length}（${matchedCount}条消息）`;
    }

    function next(step = 1) {
      if (!marks.length) return;
      const idx = (activeIdx + step + marks.length) % marks.length;
      activateMark(idx);
    }

    // open 幂等化：已打开时只聚焦+全选，不清空已输入的内容（避免"点了没反应"）
    function open() {
      const wasOpen = !overlay.classList.contains('hidden');
      overlay.classList.remove('hidden');
      if (wasOpen) {
        focusInput(true);
        return;
      }
      clearMarks();
      input.value = '';
      query = '';
      countEl.textContent = '0 / 0';
      focusInput(false);
    }

    // 稳定地把焦点交给输入框（同步执行 + 微任务兜底，确保 Code/Babe 模式下也能稳定获得焦点）
    function focusInput(selectText) {
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      if (selectText) input.select();
      Promise.resolve().then(() => { if (isOpen()) { input.focus({ preventScroll: true }); if (selectText) input.select(); } });
    }

    function close() {
      clearMarks();
      fadeOutHide(overlay);
      input.blur();
    }

    function isOpen() { return !overlay.classList.contains('hidden'); }

    // 事件绑定
    input.addEventListener('input', () => runSearch(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); next(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.getElementById('chat-search-next')?.addEventListener('click', () => { next(1); focusInput(true); });
    document.getElementById('chat-search-prev')?.addEventListener('click', () => { next(-1); focusInput(true); });
    document.getElementById('chat-search-close')?.addEventListener('click', close);
    // 浮窗内点空白处也关闭（可选，增强交互）
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    // Chat 模式搜索按钮（下载按钮左边）——绑定放在 IIFE 内，保证与搜索模块同生命周期
    document.getElementById('btn-chat-search')?.addEventListener('click', () => {
      open();
    });
    // Code 模式搜索按钮（对齐其他模式的搜索入口）
    document.getElementById('btn-code-chat-search')?.addEventListener('click', () => {
      open();
    });

    // 模式切换时关闭搜索（避免高亮残留到别的容器）
    document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { if (isOpen()) close(); });
    });

    return { open, close, isOpen, runSearch, clearMarks };
  })();

  // ============ Ctrl/Cmd+F 页面级搜索路由 ============
  // 聊天搜索只作用于 Chat/Code/Babe 聊天界面；历史页/设置页各有自己的搜索，
  // 其余标签页不拦截 Ctrl+F，避免聊天搜索泄露到无关页面。
  window.__pageSearchHandlers = window.__pageSearchHandlers || {};
  window.registerPageSearch = function (pageId, handler) {
    if (pageId && handler) window.__pageSearchHandlers[pageId] = handler;
  };

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'f' && e.key !== 'F')) return;
    const active = document.querySelector('.page.active');
    const pageId = active ? String(active.id || '').replace(/^page-/, '') : '';
    if (pageId === 'chat' || pageId === 'code' || pageId === 'babe') {
      e.preventDefault();
      if (chatSearch) chatSearch.open();
      return;
    }
    const handler = window.__pageSearchHandlers[pageId];
    if (handler && typeof handler.open === 'function') {
      e.preventDefault();
      handler.open();
    }
  }, true);

  // 离开历史/设置等页面时关闭其搜索，恢复完整列表
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.nav-item[data-page]');
    if (!nav) return;
    const target = nav.dataset.page;
    if (target === 'chat' || target === 'code' || target === 'babe') return;
    Object.values(window.__pageSearchHandlers || {}).forEach(h => {
      try { if (h && typeof h.close === 'function') h.close(); } catch { /* ignore */ }
    });
  }, true);

  async function normalizeToolSettings() {
    if (!agent.settings) return;
    if (!agent.settings.tools || typeof agent.settings.tools !== 'object') {
      agent.settings.tools = {};
    }
    if (typeof agent.settings.autoOptimizeToolSelection !== 'boolean') {
      agent.settings.autoOptimizeToolSelection = false;
    }
    const toolNames = new Set(TOOL_DEFINITIONS.map(t => t.name));
    let changed = false;

    TOOL_DEFINITIONS.forEach(tool => {
      if (agent.settings.tools[tool.name] === undefined) {
        agent.settings.tools[tool.name] = true;
        changed = true;
      }
    });

    Object.keys(agent.settings.tools).forEach(name => {
      if (!toolNames.has(name)) {
        delete agent.settings.tools[name];
        changed = true;
      }
    });

    if (changed) {
      await window.api.setSettings(agent.settings);
      agent.contextManager.setSystemPrompt(agent.getSystemPrompt());
    }
  }

  function addMessageToChat(role, content) {
    // Remove welcome message if present
    const welcome = chatMessages.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // Avatar handling（Remote 模式优先使用远端头像）
    let avatarHTML = '';
    if (role === 'user') {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.user || '') : agent.settings?.userProfile?.avatar, false);
    } else {
      avatarHTML = makeFramedAvatarHTML(isRemoteMode ? (remoteAvatars?.ai || '') : agent.settings?.aiPersona?.avatar, true);
    }

    const bodyClass = role === 'assistant' ? 'message-content markdown-body' : 'message-content';
    // 虚拟滚动优化：assistant 消息延迟渲染 markdown
    // - 批量加载模式（历史回放）：先占位，可见时再渲染
    // - 实时模式（新消息）：立即渲染（保持流式体验）
    if (role === 'assistant' && typeof VirtualScroller !== 'undefined' && VirtualScroller.observeMessage) {
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}"></div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
      // 注册到虚拟滚动器，原始内容存在 dataset 中，可见时才渲染
      VirtualScroller.observeMessage(msg, content);
    } else {
      // user 消息或无虚拟滚动器：直接渲染
      const rendered = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content);
      msg.innerHTML = `
        <div class="message-avatar">${avatarHTML}</div>
        <div class="message-body">
          <div class="${bodyClass}">${rendered}</div>
          <div class="message-time">${time}</div>
        </div>`;
      appendChatElement(msg);
    }

    // Add right-click context menu for deletion
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e, msg, role);
    });
  }

  // ---- Streaming message rendering ----
  // Creates a placeholder assistant bubble for a streaming response.
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
            ? renderMarkdown(bubble.rawContent) + '<span class="streaming-cursor">▋</span>'
            : '';
        }
        if (bubble.reasoningContentEl && bubble.rawReasoning) {
          // During streaming: show reasoning expanded (live)
          // 一旦 final content 开始，就移除 reasoning 的光标（思考已结束）
          bubble.reasoningEl.classList.remove('collapsed');
          const reasoningCursor = bubble.contentStarted ? '' : '<span class="streaming-cursor">▋</span>';
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

  function addImageMessage(imageUrl) {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // AI avatar
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);

    const imgId = 'img-' + Date.now();
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="message-content">
          <img id="${imgId}" src="${imageUrl}" style="max-width:400px;max-height:400px;border-radius:8px;cursor:pointer;display:block"/>
        </div>
        <div class="message-time">${time}</div>
      </div>`;

    appendChatElement(msg);

    // 添加点击放大功能
    const imgEl = document.getElementById(imgId);
    if (imgEl) {
      imgEl.addEventListener('click', () => openImageModal(imageUrl));

      // 添加右键菜单
      imgEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showImageContextMenu(e, imageUrl);
      });
    }

    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      msg.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // 显示塔罗牌阵卡片
  function addTarotSpreadToChat(tarotResult) {
    const spread = tarotResult.spread;
    const cards = tarotResult.cards || [];
    if (!spread || cards.length === 0) return;
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    const eSource = cards[0]?.entropySource || 'CSPRNG';
    const isTRNG = eSource.startsWith('TRNG');
    const trngBadge = isTRNG ? ' <span class="trng-badge" style="font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';

    const cardsHtml = cards.map(c => {
      const meaning = c.isReversed ? c.meaningOfReversed : c.meaningOfUpright;
      const position = c.position?.name || '';
      const posDesc = c.position?.description || '';
      const _lang2 = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
      const _isZh2 = (_lang2 === 'zh-CN');
      const _cardName2 = _isZh2 ? c.name : (c.nameEn || c.name);
      const _orientation2 = c.isReversed ? (_isZh2 ? '逆位' : 'Reversed') : (_isZh2 ? '正位' : 'Upright');
      return '<div class="tarot-spread-card' + (c.isReversed ? ' reversed' : '') + '">' +
        '<div class="card-position">' + escapeHtml(position) + '</div>' +
        '<div class="card-icon"><i class="fa-solid ' + (c.icon || 'fa-star') + '"></i></div>' +
        '<div class="card-name">' + escapeHtml(_cardName2) + '</div>' +
        '<div class="card-orientation">' + _orientation2 + '</div>' +
        '<div class="card-meaning">' + escapeHtml(meaning || '') + '</div>' +
      '</div>';
    }).join('');

    msg.innerHTML =
      '<div class="message-avatar">' + avatarHTML + '</div>' +
      '<div class="message-body">' +
        '<div class="message-content">' +
          '<div style="font-weight:600;margin-bottom:4px">' + escapeHtml(spread.name) + trngBadge + '</div>' +
          '<div style="font-size:0.85em;color:var(--text-secondary);margin-bottom:4px">' + escapeHtml(spread.description || '') + '</div>' +
          '<div class="tarot-spread-display">' + cardsHtml + '</div>' +
        '</div>' +
        '<div class="message-time">' + time + '</div>' +
      '</div>';
    appendChatElement(msg);
    requestAnimationFrame(() => { msg.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
  }

  // 显示图片右键菜单
  function showImageContextMenu(e, imageUrl) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.image-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'image-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 120px;
    `;

    const menuItems = [
      {
        icon: 'fa-copy',
        label: '复制图片',
        action: async () => {
          try {
            // 读取图片文件为blob
            const response = await fetch(imageUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([
              new ClipboardItem({ [blob.type]: blob })
            ]);
            addSystemMessage('图片已复制到剪贴板');
          } catch (err) {
            addSystemMessage(`复制失败: ${err.message}`);
          }
        }
      },
      {
        icon: 'fa-floppy-disk',
        label: '另存为',
        action: async () => {
          try {
            const sourcePath = imageUrl.replace(/^file:\/\/\/?/, '');
            const fileName = sourcePath.split(/[\\/]/).pop() || 'image.png';
            const result = await window.api.saveFileDialog({
              title: '保存图片',
              defaultPath: fileName,
              filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            });
            if (result.ok && result.path) {
              await window.api.copyFile(sourcePath, result.path);
              addSystemMessage(`图片已保存到: ${result.path}`);
            }
          } catch (err) {
            addSystemMessage(`保存失败: ${err.message}`);
          }
        }
      }
    ];

    menuItems.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        transition: background 0.2s;
      `;
      menuItem.innerHTML = `<i class="fa-solid ${item.icon}" style="width:16px"></i><span>${item.label}</span>`;

      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = 'var(--bg-hover)';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });
      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);

    // 点击其他地方关闭菜单
    const closeMenu = (evt) => {
      if (!menu.contains(evt.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  // 提取消息正文纯文本（排除推理过程、工具调用卡片、时间戳等）
  function getMessagePlainText(messageElement) {
    const body = messageElement && messageElement.querySelector('.message-body');
    const root = body || messageElement;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.reasoning-section, .tool-call, .message-time, .message-avatar, .msg-actions, .message-actions').forEach((n) => n.remove());
    let text = clone.innerText || '';
    text = text.replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '').replace(/<thinking[\s\S]*?<\/thinking>/gi, '');
    return text.trim();
  }

  // 右键菜单条目
  function makeMenuEntry(icon, label, color) {
    const item = document.createElement('div');
    item.style.cssText = `
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
      color: ${color || 'var(--text-primary)'};
    `;
    // 图标固定宽度并居中，保证不同图标下文字始终左对齐
    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${icon}`;
    iconEl.style.cssText = 'width: 20px; flex-shrink: 0; text-align: center; font-size: 13px;';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    item.append(iconEl, labelEl);
    item.addEventListener('mouseenter', () => {
      item.style.backgroundColor = 'var(--bg-hover)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.backgroundColor = 'transparent';
    });
    return item;
  }

  // 显示消息右键菜单
  function showMessageContextMenu(e, messageElement, role) {
    // 移除已存在的菜单
    const existingMenu = document.querySelector('.message-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${e.clientX}px;
      top: ${e.clientY}px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      padding: 4px 0;
      z-index: 10000;
      min-width: 160px;
    `;

    // 朗读：清空当前朗读队列并朗读本条消息
    const speakItem = makeMenuEntry('fa-volume-high', '朗读');
    speakItem.addEventListener('click', async () => {
      menu.remove();
      const text = getMessagePlainText(messageElement);
      if (!text) return;
      if (typeof window.VoiceUI !== 'object' || typeof window.VoiceUI.speakText !== 'function') return;
      const s = await window.api.getSettings();
      if (!s || (s.voice && s.voice.ttsEnabled === false)) {
        if (typeof window.showToast === 'function') window.showToast('TTS 未开启，请到语音设置开启后再朗读', 'error', 4000);
        return;
      }
      window.VoiceUI.speakText(text);
    });

    const menuItem = makeMenuEntry('fa-trash', '删除对话', '#e74c3c');

    menuItem.addEventListener('click', async () => {
      menu.remove();

      // 查找完整的对话轮次：user -> (system/tool-call)* -> assistant
      const allElements = Array.from(chatMessages.children);
      const currentIndex = allElements.indexOf(messageElement);

      if (currentIndex === -1) return;

      let userMsg = null;
      let assistantMsg = null;
      const middleElements = []; // system messages and tool calls

      if (role === 'user') {
        // 从 user 开始，向后找 assistant
        userMsg = messageElement;
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            // 遇到下一个 user，停止
            break;
          }
        }
      } else if (role === 'assistant') {
        // 从 assistant 开始，向前找 user
        assistantMsg = messageElement;
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            // 遇到上一个 assistant，停止
            break;
          }
        }
      } else {
        // 从 system/tool-call 开始，找前后的 user 和 assistant
        // 向前找 user
        for (let i = currentIndex - 1; i >= 0; i--) {
          const el = allElements[i];
          if (el.classList.contains('user')) {
            userMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.unshift(el);
          } else if (el.classList.contains('assistant')) {
            break;
          }
        }
        // 向后找 assistant
        middleElements.push(messageElement); // 当前元素
        for (let i = currentIndex + 1; i < allElements.length; i++) {
          const el = allElements[i];
          if (el.classList.contains('assistant')) {
            assistantMsg = el;
            break;
          } else if (el.classList.contains('system') || el.classList.contains('tool-call')) {
            middleElements.push(el);
          } else if (el.classList.contains('user')) {
            break;
          }
        }
      }

      if (!userMsg && !assistantMsg) return;

      const pending = [];
      if (userMsg) pending.push(userMsg);
      pending.push(...middleElements);
      if (assistantMsg) pending.push(assistantMsg);

      pending.forEach(el => el.classList.add('pending-delete'));

      // Confirm deletion
      const delParts = [];
      if (userMsg) delParts.push('用户消息');
      if (middleElements.length > 0) delParts.push('工具调用');
      if (assistantMsg) delParts.push('AI回复');
      let delDetail = '';
      if (delParts.length === 1) delDetail = '包括' + delParts[0];
      else if (delParts.length > 1) delDetail = '包括' + delParts.slice(0, -1).join('、') + '和' + delParts[delParts.length - 1];
      const confirmed = await window.confirmDialog(
        `确定要删除这轮对话吗？\n${delDetail}`,
        '删除对话'
      );

      if (confirmed) {
        pending.forEach(el => el.remove());
      } else {
        pending.forEach(el => el.classList.remove('pending-delete'));
      }
    });

    menu.append(speakItem, menuItem);
    document.body.appendChild(menu);

    const closeMenu = () => {
      if (menu && menu.parentNode) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  }

  function openImageModal(src) {
    const img = document.getElementById('image-preview-img');
    if (img) {
      img.src = src;
      img.alt = '预览';
    }
    imagePreviewModal.classList.remove('hidden');
  }

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
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
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

  // ---- 文件呈递卡片（游戏邀请风格） ----
  function addFilePresentCard(data) {
    if (!data) return;
    const cardId = 'file-present-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const el = document.createElement('div');
    el.className = 'file-present-card';
    el.id = cardId;
    const sizeStr = data.size > 1024 * 1024
      ? (data.size / 1024 / 1024).toFixed(1) + ' MB'
      : data.size > 1024
        ? (data.size / 1024).toFixed(1) + ' KB'
        : data.size + ' B';
    const ext = (data.filename || '').split('.').pop().toUpperCase();
    const iconClass = _getFileIcon(data.filename);
    el.innerHTML = `
      <div class="file-present-header">
        <i class="fa-solid ${iconClass} file-present-icon"></i>
        <div class="file-present-info">
          <span class="file-present-badge">${ext}</span>
          <span class="file-present-title">${escapeHtml(data.title || data.filename || '文件')}</span>
        </div>
      </div>
      ${data.description ? `<div class="file-present-desc">${escapeHtml(data.description)}</div>` : ''}
      <div class="file-present-meta">
        <span><i class="fa-solid fa-file"></i> ${escapeHtml(data.filename || '')}</span>
        <span><i class="fa-solid fa-database"></i> ${sizeStr}</span>
      </div>
      <button class="file-present-download-btn" data-file-path="${escapeHtml(data.fullPath || '')}" data-filename="${escapeHtml(data.filename || 'download')}">
        <i class="fa-solid fa-download"></i> 下载文件
      </button>`;
    // 根据当前模式追加到对应容器
    const container = currentMode === 'code' ? document.getElementById('code-chat-messages')
      : currentMode === 'babe' ? document.getElementById('babe-chat-messages')
      : chatMessages;
    if (!container) return;
    // 移除欢迎消息
    const welcome = container.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    container.appendChild(el);
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'end' }); });
    // 绑定下载按钮点击
    const dlBtn = el.querySelector('.file-present-download-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', function() {
        handleFileDownload(this.dataset.filePath, this.dataset.filename);
      });
    }
    // 推送到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: getChatContainerSelector(), html: el.outerHTML });
  }

  function _getFileIcon(filename) {
    if (!filename) return 'fa-file';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      js: 'fa-file-code', ts: 'fa-file-code', jsx: 'fa-file-code', tsx: 'fa-file-code',
      py: 'fa-file-code', java: 'fa-file-code', c: 'fa-file-code', cpp: 'fa-file-code',
      html: 'fa-file-code', css: 'fa-file-code', json: 'fa-file-code',
      md: 'fa-file-lines', txt: 'fa-file-lines', pdf: 'fa-file-pdf',
      doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image', svg: 'fa-file-image',
      zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      mp3: 'fa-file-audio', wav: 'fa-file-audio', mp4: 'fa-file-video', avi: 'fa-file-video',
    };
    return map[ext] || 'fa-file';
  }

  // 文件下载处理：App 直接下载，Remote 请求远端，WebUI 回传 blob
  function handleFileDownload(filePath, filename) {
    if (!filePath) return;
    // Remote 模式：文件在远端，发送请求让远端回传文件数据
    if (isRemoteMode && remoteWs && remoteWs.readyState === 1) {
      remoteWsSend({ type: 'requestFileDownload', path: filePath, filename: filename });
      return;
    }
    // 本地模式 / WebUI 点击转发：读取文件并下载
    window.api.readFileBase64(filePath).then(function(result) {
      if (!result.ok) { console.error('[FileDownload] 读取失败:', result.error); return; }
      // result.data 格式为 data URL: "data:mime;base64,xxxx"
      var dataUrl = result.data || '';
      var base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
      var mimeType = result.mime || 'application/octet-stream';
      // 如果是 WebUI 转发的点击（_applyingRemote 为 true），通过 WS 回传文件数据
      if (WebUIMirror._applyingRemote) {
        try {
          window.api.webControlMirrorUpdate({ type: 'file_download', filename: filename, data: base64, mimeType: mimeType });
        } catch (e) { console.error('[FileDownload] WebUI 回传失败:', e); }
        return;
      }
      // 本地 Electron：直接 blob 下载
      _triggerBlobDownload(base64, filename, mimeType);
    });
  }

  function _triggerBlobDownload(base64Data, filename, mimeType) {
    var binary = atob(base64Data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 子代理全屏宽度卡片：标题 + 状态 + 用时 + token + 工具调用次数，点击展开完整对话
  const _subAgentCards = new Map(); // id → { el, logEl, startTime, timer }

  function addSubAgentCard({ id, title, task, startTime, status }) {
    const el = document.createElement('div');
    el.className = 'sub-agent-card';
    el.dataset.subAgentId = id;
    el.dataset.status = status || 'running';
    const fmtDur = (ms) => {
      const s = Math.floor((ms || 0) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    el.innerHTML = `
      <div class="sub-agent-card-header" title="点击查看完整记录">
        <div class="sub-agent-card-icon"><i class="fa-solid fa-robot"></i></div>
        <div class="sub-agent-card-meta">
          <div class="sub-agent-card-title">${escapeHtml(title)}</div>
          <div class="sub-agent-card-task">${escapeHtml(task || '').slice(0, 120)}${(task || '').length > 120 ? '…' : ''}</div>
        </div>
        <div class="sub-agent-card-stats">
          <span class="sub-agent-stat sub-agent-status"><i class="fa-solid fa-circle-notch fa-spin"></i> 运行中</span>
          <span class="sub-agent-stat sub-agent-duration"><i class="fa-regular fa-clock"></i> <span class="dur-text">00:00</span></span>
          <span class="sub-agent-stat sub-agent-tools hidden"><i class="fa-solid fa-wrench"></i> <span class="tools-text">0</span></span>
          <span class="sub-agent-stat sub-agent-tokens hidden"><i class="fa-solid fa-coins"></i> <span class="tokens-text">0</span></span>
        </div>
        <button class="btn-icon sub-agent-card-expand" title="查看完整对话"><i class="fa-solid fa-window-maximize"></i></button>
      </div>
      <div class="sub-agent-card-log"></div>`;
    appendChatElement(el);
    const logEl = el.querySelector('.sub-agent-card-log');
    const record = { el, logEl, startTime: startTime || Date.now(), timer: null };
    _subAgentCards.set(id, record);
    // 用时计时器
    const durText = el.querySelector('.dur-text');
    record.timer = setInterval(() => {
      if (durText) durText.textContent = fmtDur(Date.now() - record.startTime);
    }, 1000);
    // 整个卡片头部点击 → 打开详情模态框（参考 claude-code-ref：子代理记录在卡片后台）
    const openDetail = (e) => {
      // 避免点击 stats 区域误触发
      if (e.target.closest('.sub-agent-card-stats')) return;
      showSubAgentDetailModal(id);
    };
    el.querySelector('.sub-agent-card-header').addEventListener('click', openDetail);
    el.querySelector('.sub-agent-card-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      showSubAgentDetailModal(id);
    });
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  function updateSubAgentCard(id, updates) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const { el, timer } = rec;
    if (updates.status === 'done') {
      el.dataset.status = 'done';
      if (timer) { clearInterval(timer); rec.timer = null; }
      const statusEl = el.querySelector('.sub-agent-status');
      if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--success, #4caf50)"></i> 完成';
      // 最终用时
      const durText = el.querySelector('.dur-text');
      if (durText && updates.duration != null) {
        const s = Math.floor(updates.duration / 1000);
        durText.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      // 工具调用次数
      if (updates.toolUseCount != null) {
        const toolsEl = el.querySelector('.sub-agent-tools');
        if (toolsEl) {
          toolsEl.classList.remove('hidden');
          el.querySelector('.tools-text').textContent = updates.toolUseCount;
        }
      }
      // Token 数
      if (updates.usage && updates.usage.total != null) {
        const tokEl = el.querySelector('.sub-agent-tokens');
        if (tokEl) {
          tokEl.classList.remove('hidden');
          el.querySelector('.tokens-text').textContent = fmtTokenCount(updates.usage.total);
        }
      }
      // 结果摘要（默认折叠，避免长结果撑高卡片影响阅读）
      if (updates.result) {
        const resultEl = document.createElement('div');
        resultEl.className = 'sub-agent-card-result collapsed';
        const previewText = updates.result.length > 100
          ? updates.result.substring(0, 100) + '...'
          : updates.result;
        resultEl.innerHTML = `
          <div class="sub-agent-card-result-header">
            <span class="sub-agent-card-result-label">最终结果</span>
            <button class="btn-icon btn-xs sub-agent-result-toggle" title="展开/折叠">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          <div class="sub-agent-card-result-preview">${escapeHtml(previewText)}</div>
          <div class="sub-agent-card-result-full markdown-body" style="display:none">${renderMarkdown(updates.result)}</div>`;
        // 绑定展开/折叠按钮
        const toggleBtn = resultEl.querySelector('.sub-agent-result-toggle');
        const fullEl = resultEl.querySelector('.sub-agent-card-result-full');
        const previewEl = resultEl.querySelector('.sub-agent-card-result-preview');
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = resultEl.classList.toggle('collapsed');
          fullEl.style.display = collapsed ? 'none' : '';
          previewEl.style.display = collapsed ? '' : 'none';
          toggleBtn.querySelector('i').className = collapsed
            ? 'fa-solid fa-chevron-down'
            : 'fa-solid fa-chevron-up';
        });
        el.appendChild(resultEl);
      }
      // 达到迭代上限提示
      if (updates.hitMaxIter) {
        const warnEl = document.createElement('div');
        warnEl.className = 'sub-agent-card-warn';
        warnEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 已达迭代上限，结果为完整报告';
        el.appendChild(warnEl);
      }
    }
    requestAnimationFrame(() => { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  function appendSubAgentLog(id, content) {
    const rec = _subAgentCards.get(id);
    if (!rec) return;
    const line = document.createElement('div');
    line.className = 'sub-agent-log-line';
    line.innerHTML = `<div class="markdown-body">${renderMarkdown(content)}</div>`;
    rec.logEl.appendChild(line);
    requestAnimationFrame(() => { rec.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  }

  // 子代理详情模态框：显示完整对话历史、上下文窗口、token 用量
  // 当前打开的子代理模态框 ID（用于实时刷新）
  let _openSubAgentModalId = null;
  let _subAgentModalRefreshTimer = null;
  // 当前打开的模态框的 render 函数引用（供 sub-agent-message 事件触发立即刷新）
  let _subAgentModalRender = null;

  function showSubAgentDetailModal(id) {
    let existing = document.getElementById('sub-agent-modal');
    if (existing) existing.remove();
    const rec = agent.getSubAgent ? agent.getSubAgent(id) : null;
    const cardRec = _subAgentCards.get(id);
    if (!rec && !cardRec) return;

    _openSubAgentModalId = id;
    const modal = document.createElement('div');
    modal.id = 'sub-agent-modal';
    modal.className = 'sub-agent-modal';
    document.body.appendChild(modal);

    // 渲染函数：首次渲染整个模态框；后续刷新只更新消息列表和统计信息，避免重播动画
    let _modalInitialized = false;
    const render = () => {
      const liveRec = agent.getSubAgent ? agent.getSubAgent(id) : null;
      const liveCardRec = _subAgentCards.get(id);
      if (!liveRec && !liveCardRec) {
        closeModal();
        return;
      }
      // 优先使用实时消息（运行中也能看到）；否则回退到完成时的快照
      const liveMessages = liveRec?.subAgent?.contextManager?.getMessages?.() || [];
      const messages = liveMessages.length > 0 ? liveMessages : (liveRec?.messages || []);
      const usage = liveRec?.usage || liveCardRec?.usage || {};
      const fmtTok = (n) => fmtTokenCount(n);
      const fmtDur = (ms) => {
        if (!ms) return '-';
        const s = Math.floor(ms / 1000);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      };
      // 上下文窗口使用：基于当前上下文消息的 token 估算（而非累计用量）
      // 累计 usage.prompt + usage.completion 会持续增长，不能反映当前上下文占用
      const maxCtx = liveRec?.subAgent?.contextManager?.maxTokens || (agent?.settings?.llm?.maxContextLength || 131072);
      let usedTokens = 0;
      const subCm = liveRec?.subAgent?.contextManager;
      if (subCm) {
        // 估算当前上下文中所有消息的 token 数
        const estimateMsg = (msg) => subCm.estimateMessageTokens ? subCm.estimateMessageTokens(msg) : 0;
        const estimateText = (text) => subCm.estimateTokens ? subCm.estimateTokens(text) : 0;
        const sysTok = subCm.systemPrompt ? estimateMsg(subCm.systemPrompt) : 0;
        const summaryTok = (subCm.summaries || []).reduce((acc, s) => acc + estimateText(String(s || '')) + 4, 0);
        let chatTok = 0, toolResTok = 0;
        (subCm.messages || []).forEach(msg => {
          if (!msg) return;
          if (msg.role === 'tool') toolResTok += estimateMsg(msg);
          else if (msg.role === 'user' || msg.role === 'assistant') chatTok += estimateMsg(msg);
        });
        usedTokens = sysTok + summaryTok + chatTok + toolResTok;
      }
      // 如果无法从 contextManager 获取，回退到最后一次请求的 prompt token
      if (usedTokens === 0) usedTokens = usage.lastPrompt || 0;
      // 输出预留：为模型生成回复保留 maxResponseTokens 的空间
      // 总占用 = 当前输入 + 输出预留，分母为完整上下文窗口 maxCtx
      const maxResp = agent?.settings?.llm?.maxResponseTokens || 8192;
      const totalOcc = usedTokens + maxResp;
      const effectiveMaxCtx = maxCtx;
      const ctxPct = maxCtx > 0 ? Math.min(100, Math.round((totalOcc / maxCtx) * 100)) : 0;
      const ctxColor = ctxPct >= 95 ? 'var(--danger, #e74c3c)' : (ctxPct >= 80 ? 'var(--warning, #f39c12)' : 'var(--accent)');
      const isRunning = liveRec?.status === 'running' || (!liveRec?.endTime);
      const bodyHtml = messages.length === 0
        ? '<div class="sub-agent-modal-empty">暂无消息记录（子代理可能仍在初始化）</div>'
        : messages.map(m => renderSubAgentMessage(m)).join('');

      // 首次渲染：构建整个模态框结构
      if (!_modalInitialized) {
        modal.innerHTML = `
        <div class="sub-agent-modal-backdrop"></div>
        <div class="sub-agent-modal-dialog">
          <div class="sub-agent-modal-header">
            <div class="sub-agent-modal-title">
              <i class="fa-solid fa-robot"></i>
              <span>子代理详情</span>
              <span class="sub-agent-modal-running"></span>
              <span class="sub-agent-modal-tarot"></span>
            </div>
            <div class="sub-agent-modal-stats"></div>
            <button class="btn-icon sub-agent-modal-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="sub-agent-modal-task"></div>
          <div class="sub-agent-modal-context" style="padding:8px 18px;border-bottom:1px solid var(--border);background:var(--bg-tertiary, var(--bg-secondary));font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:10px;flex-shrink:0">
            <span><i class="fa-solid fa-window-maximize" style="color:var(--accent)"></i> 上下文窗口</span>
            <div style="flex:1;height:6px;background:var(--bg-primary);border-radius:3px;overflow:hidden;border:1px solid var(--border)">
              <div class="ctx-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s"></div>
            </div>
            <span class="ctx-pct" style="font-variant-numeric:tabular-nums;font-weight:600">0%</span>
            <span class="ctx-tokens" style="color:var(--text-tertiary);font-size:11px">0 / 0</span>
          </div>
          <div class="sub-agent-modal-body">${bodyHtml}</div>
        </div>`;
        modal.querySelector('.sub-agent-modal-close').onclick = closeModal;
        modal.querySelector('.sub-agent-modal-backdrop').onclick = closeModal;
        _modalInitialized = true;
      } else {
        // 后续刷新：只更新 body 内容，避免重播模态框动画
        const bodyEl = modal.querySelector('.sub-agent-modal-body');
        if (bodyEl) bodyEl.innerHTML = bodyHtml;
      }

      // 更新统计区（无论首次还是后续）
      const runningEl = modal.querySelector('.sub-agent-modal-running');
      if (runningEl) runningEl.innerHTML = isRunning ? '<i class="fa-solid fa-circle-notch fa-spin"></i> 运行中' : '';
      const tarotEl = modal.querySelector('.sub-agent-modal-tarot');
      if (tarotEl) tarotEl.innerHTML = liveRec?.tarot ? `命运之牌: ${escapeHtml(liveRec.tarot.name)}${liveRec.tarot.isReversed ? '(逆位)' : '(正位)'}` : '';

      const statsEl = modal.querySelector('.sub-agent-modal-stats');
      if (statsEl) statsEl.innerHTML = `
        <span><i class="fa-regular fa-clock"></i> ${fmtDur(liveRec ? ((liveRec.endTime || Date.now()) - liveRec.startTime) : 0)}</span>
        <span><i class="fa-solid fa-rotate"></i> ${liveRec?.iterations || 0} 轮</span>
        <span><i class="fa-solid fa-wrench"></i> ${liveRec?.toolUseCount || 0} 次工具</span>
        <span><i class="fa-solid fa-coins"></i> 输入 ${fmtTok(usage.prompt)} / 输出 ${fmtTok(usage.completion)} / 共 ${fmtTok(usage.total)}</span>
        ${usage.cached > 0 ? `<span><i class="fa-solid fa-bolt"></i> 缓存命中 ${fmtTok(usage.cached)}</span>` : ''}`;

      const taskEl = modal.querySelector('.sub-agent-modal-task');
      if (taskEl) taskEl.textContent = liveRec?.task || liveCardRec?.el?.dataset?.subAgentId || '';

      const barEl = modal.querySelector('.ctx-progress-bar');
      if (barEl) { barEl.style.width = `${ctxPct}%`; barEl.style.background = ctxColor; }
      const pctEl = modal.querySelector('.ctx-pct');
      if (pctEl) { pctEl.textContent = `${ctxPct}%`; pctEl.style.color = ctxColor; }
      const tokEl = modal.querySelector('.ctx-tokens');
      if (tokEl) tokEl.textContent = `${fmtTok(totalOcc)} / ${fmtTok(effectiveMaxCtx)} (含预留${fmtTok(maxResp)})`;

      // 自动滚动到底部（如果有新消息）
      const body = modal.querySelector('.sub-agent-modal-body');
      if (body && isRunning) body.scrollTop = body.scrollHeight;
    };

    const closeModal = () => {
      if (_subAgentModalRefreshTimer) {
        clearInterval(_subAgentModalRefreshTimer);
        _subAgentModalRefreshTimer = null;
      }
      _openSubAgentModalId = null;
      fadeOutRemove(modal);
      document.removeEventListener('keydown', escHandler);
    };

    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    document.addEventListener('keydown', escHandler);

    // 首次渲染
    render();
    _subAgentModalRender = render;

    // 如果子代理还在运行，启动定时刷新（每 1.5 秒）
    const checkRunning = agent.getSubAgent ? agent.getSubAgent(id) : null;
    if (checkRunning && (checkRunning.status === 'running' || !checkRunning.endTime)) {
      _subAgentModalRefreshTimer = setInterval(() => {
        try {
          const cur = agent.getSubAgent ? agent.getSubAgent(id) : null;
          if (!cur || cur.status !== 'running') {
            // 已完成，最后刷新一次然后停止
            render();
            if (_subAgentModalRefreshTimer) {
              clearInterval(_subAgentModalRefreshTimer);
              _subAgentModalRefreshTimer = null;
            }
          } else if (_openSubAgentModalId === id) {
            render();
          } else {
            // 模态框已关闭
            if (_subAgentModalRefreshTimer) {
              clearInterval(_subAgentModalRefreshTimer);
              _subAgentModalRefreshTimer = null;
            }
          }
        } catch (e) {
          console.error('[SubAgent Modal] refresh error:', e);
        }
      }, 1500);
    }
  }

  function renderSubAgentMessage(m) {
    const role = m.role || 'unknown';
    const roleLabels = { system: '系统', user: '任务', assistant: '子代理', tool: '工具结果' };
    const roleIcon = { system: 'fa-gear', user: 'fa-flag', assistant: 'fa-robot', tool: 'fa-wrench' }[role] || 'fa-message';
    // 截断 content：工具结果可能很长，限制显示长度
    let content = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => typeof c === 'string' ? c : (c?.text || '')).join('') : '');
    const MAX_CONTENT = 2000;
    let truncated = false;
    if (content.length > MAX_CONTENT) {
      content = content.substring(0, MAX_CONTENT);
      truncated = true;
    }
    let html = `<div class="sub-agent-msg-item role-${role}">
      <div class="sub-agent-msg-role"><i class="fa-solid ${roleIcon}"></i> ${roleLabels[role] || role}</div>`;
    if (m.tool_calls && m.tool_calls.length > 0) {
      html += `<div class="sub-agent-msg-toolcalls">`;
      for (const tc of m.tool_calls) {
        let argsStr = tc.function?.arguments || '{}';
        try { argsStr = JSON.stringify(JSON.parse(argsStr), null, 2); } catch {}
        // 截断工具参数
        const MAX_ARGS = 800;
        let argsTruncated = false;
        if (argsStr.length > MAX_ARGS) {
          argsStr = argsStr.substring(0, MAX_ARGS);
          argsTruncated = true;
        }
        html += `<div class="sub-agent-msg-tc"><span class="tc-name">${escapeHtml(tc.function?.name || '')}</span><pre class="tc-args">${escapeHtml(argsStr)}${argsTruncated ? '\n…(已截断)' : ''}</pre></div>`;
      }
      html += `</div>`;
    }
    if (content) {
      html += `<div class="sub-agent-msg-content markdown-body">${renderMarkdown(content)}${truncated ? '<div class="sub-agent-msg-truncated">…(内容已截断，完整内容请查看工具返回)</div>' : ''}</div>`;
    }
    if (m.name) {
      html += `<div class="sub-agent-msg-tool-name">工具: ${escapeHtml(m.name)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  function addSystemMessage(content, { persist = true } = {}) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `
      <div class="system-icon"><i class="fa-solid fa-info-circle"></i></div>
      <div class="system-content">${escapeHtml(content)}</div>`;
    appendChatElement(el);
    // 同步保存到聊天历史（确保所有可见的系统消息都会持久化）
    if (persist && agent?.contextManager && agent.conversationId) {
      try {
        agent.contextManager.addSystemMessage(content);
        // 异步触发历史保存（不阻塞 UI）
        if (typeof agent.saveToHistory === 'function') {
          agent.saveToHistory();
        }
      } catch (e) { /* 静默失败：UI 已显示，不应阻塞 */ }
    }
    // Ensure complete scroll to bottom
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // ---- 系统通知辅助 ----
  // 根据设置过滤通知；category: 'approval' | 'sessionDone' | 'question' | 'present'
  // 仅当窗口失焦或被最小化/隐藏时才发送（避免在用户正盯着界面时打扰）
  async function sendAppNotification(category, title, body, force = false, extra = {}) {
    try {
      if (!window.api?.sendNotification) return;
      const s = await window.api.getSettings();
      const n = s.notifications || {};
      // 默认开启：未设置时视为 true
      if (n.enabled === false) return;
      if (n[category] === false) return;
      // 仅在窗口非聚焦或不可见时打扰用户
      const isFocused = document.hasFocus();
      const isHidden = document.visibilityState === 'hidden';
      if (!force && isFocused && !isHidden) return;
      await window.api.sendNotification({ title, body, category, ...(extra || {}) });
    } catch (e) {
      console.warn('[App] sendAppNotification failed:', e?.message || e);
    }
  }

  // ---- Game Invitation Card ----
  const GAME_META = {
    flyingFlower: { name: '飞花令', icon: 'fa-feather', desc: '经典诗词接龙游戏，各方轮流说出含有指定字的诗句', defaultAgents: 2 },
    sanguosha: { name: '三国杀', icon: 'fa-khanda', desc: '经典卡牌对战游戏，选择武将、出牌博弈', defaultAgents: 3 },
    undercover: { name: '谁是卧底', icon: 'fa-user-secret', desc: '经典社交推理游戏，通过描述找出卧底', defaultAgents: 4 },
    idiom: { name: '成语接龙', icon: 'fa-link', desc: '四字成语首尾相接，LLM 生成 + LLM 裁判验证', defaultAgents: 3 },
    guessCharacter: { name: '是否猜人物', icon: 'fa-magnifying-glass', desc: '通过提问只能用是/否回答，猜出 AI 心中的人物', defaultAgents: 1 },
  };

  window.showGameInvitation = function(game, message, suggestedAgents, callingAgent) {
    return new Promise((resolve) => {
      const meta = GAME_META[game] || { name: game, icon: 'fa-gamepad', desc: '', defaultAgents: 2 };
      const numAgents = suggestedAgents || meta.defaultAgents;
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      // 会话进入"等待游戏邀请回应"状态：标签页/历史列表显示指示器，而不是"运行中"
      const ownerAgent = callingAgent || agent;
      const ownerSession = window.__sessionManager?.getByAgent(ownerAgent);
      if (window.__sessionManager && ownerSession) {
        window.__sessionManager.setAttention(ownerSession, { kind: 'game', label: '等待游戏回应' });
      }

      // Wrap inside AI message bubble (like askQuestions)
      const msg = document.createElement('div');
      msg.className = 'message assistant';

      const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);

      const body = document.createElement('div');
      body.className = 'message-body';

      const card = document.createElement('div');
      card.className = 'game-invite-card';
      card.innerHTML = `
        <div class="game-invite-header">
          <div class="game-invite-icon"><i class="fa-solid ${meta.icon}"></i></div>
          <div class="game-invite-info">
            <h4>${escapeHtml(meta.name)}</h4>
            <p>${escapeHtml(meta.desc)}</p>
          </div>
        </div>
        ${message ? `<div class="game-invite-msg">${escapeHtml(message)}</div>` : ''}
        ${game === 'guessCharacter' ? '' : `<div class="game-invite-agents">
          <label>参与 Agent 数量：</label>
          <input type="number" min="1" max="8" value="${numAgents}" class="agent-count-input" />
        </div>`}
        <div class="game-invite-actions">
          <button class="btn-game-ignore">忽略</button>
          <button class="btn-game-accept"><i class="fa-solid fa-play"></i> 开始游戏</button>
        </div>`;

      const timeEl = document.createElement('div');
      timeEl.className = 'message-time';
      timeEl.textContent = time;

      body.appendChild(card);
      body.appendChild(timeEl);

      msg.innerHTML = `<div class="message-avatar">${avatarHTML}</div>`;
      msg.appendChild(body);

      const btnAccept = card.querySelector('.btn-game-accept');
      const btnIgnore = card.querySelector('.btn-game-ignore');
      const agentInput = card.querySelector('.agent-count-input');

      btnAccept.addEventListener('click', () => {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        const count = agentInput ? (parseInt(agentInput.value) || numAgents) : numAgents;
        card.classList.add('accepted');
        btnAccept.textContent = '已接受';
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        if (agentInput) agentInput.disabled = true;
        resolve({ accepted: true, game, agentCount: count });
      });

      btnIgnore.addEventListener('click', () => {
        if (window.__sessionManager && ownerSession) window.__sessionManager.setAttention(ownerSession, null);
        card.classList.add('ignored');
        btnAccept.disabled = true;
        btnIgnore.disabled = true;
        if (agentInput) agentInput.disabled = true;
        resolve({ accepted: false, game, agentCount: 0 });
      });

      if (ownerSession && typeof appendSessionCard === 'function') {
        appendSessionCard(ownerSession, msg);
      } else {
        appendChatElement(msg);
      }

      // Add right-click deletion support (counts as that turn's AI message)
      msg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMessageContextMenu(e, msg, 'assistant');
      });

      requestAnimationFrame(() => msg.scrollIntoView({ behavior: 'smooth', block: 'end' }));
    });
  };

  function addThinkingIndicator() {
    addThinkingIndicatorWithText('AI 正在思考...');
  }

  function addThinkingIndicatorWithText(text) {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span>${escapeHtml(text || 'AI 正在思考...')}</span>`;
    chatMessages.appendChild(el);
    scrollChatToBottom();
    // 增量推送：思考指示器追加到 chat 容器
    WebUIMirror.pushDomEvent({
      type: 'dom_append',
      container: '#chat-messages',
      html: el.outerHTML,
    });
  }

  function removeThinkingIndicator() {
    const el = document.getElementById('thinking-indicator');
    if (el) el.remove();
    scrollChatToBottom();
    // 增量推送：移除思考指示器
    WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
  }

  function setSendButtons(isWorking) {
    if (isWorking) {
      if (btnStop) btnStop.classList.remove('hidden');
      // 热对话：发送按钮始终可见
    } else {
      // 仅在未播放语音时才隐藏停止按钮
      const speaking = (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
      if (btnStop) btnStop.classList.toggle('hidden', !speaking);
      btnSend.classList.remove('hidden');
    }
  }

  // ---- Send Message ----
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text && currentAttachments.length === 0) return;

    // Remote 模式：转发到远程 WS，不在本地执行 Agent
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      const attachments = [...currentAttachments];
      clearAttachments();
      chatInput.value = '';
      chatInput.style.height = 'auto';

      // 上传附件到远端，构建带附件路径的消息（与 WebUI 协议一致）
      let fullMsg = text;
      if (attachments.length > 0) {
        const uploadedPaths = [];
        for (const att of attachments) {
          const up = await uploadAttachmentRemote(att);
          if (up) uploadedPaths.push(`附件: ${up.path} (${up.name})`);
          else fullMsg += `\n[附件上传失败: ${att.name}]`;
        }
        if (uploadedPaths.length > 0) {
          fullMsg = (text ? text + '\n' : '') + uploadedPaths.join('\n');
        }
      }

      if (fullMsg) addMessageToChat('user', fullMsg);
      addThinkingIndicator();
      remoteWs.send(JSON.stringify({ type: 'sendMessage', message: fullMsg }));
      return;
    }

    // 热对话：Agent工作中时注入新消息
    if (agent.running) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
      WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

      // Process attachments
      const attachments = [...currentAttachments];
      clearAttachments();

      let displayText = text;
      if (attachments.length > 0) {
        const names = attachments.map(a => a.name).join(', ');
        displayText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', displayText);

      await copyAttachmentsToWorkspace(attachments);

      // Process attachments: OCR for images, text extraction for documents
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
              const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
              if (importResult.ok && importResult.content) {
                const workspacePath = agent.workspacePath;
                if (workspacePath) {
                  const textFileName = att.name.replace(/\.\w+$/, '.txt');
                  const textFilePath = `${workspacePath}\\${textFileName}`;
                  const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                  if (saveResult.ok) {
                    att.convertedPath = textFilePath;
                    att.extractedText = `已转换为文本文件：${textFilePath}`;
                  } else {
                    att.extractedText = importResult.content;
                  }
                } else {
                  att.extractedText = importResult.content;
                }
                if (importResult.images && importResult.images.length > 0) {
                  att.extractedImages = importResult.images;
                }
              }
            } catch (e) { console.error('Document extraction error:', e); }
          }
        }
      }

      agent.injectHotMessage(text, attachments);
      return;
    }

    const chatSession = sessionManager?.getByAgent(agent);
    if (chatSession && !agent.running && !sessionManager.requestStart(chatSession)) {
      const queuedAttachments = [...currentAttachments];
      clearAttachments();
      let queuedText = text;
      if (queuedAttachments.length > 0) {
        const names = queuedAttachments.map(a => a.name).join(', ');
        queuedText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', queuedText);
      sessionManager.queue(chatSession, { text, attachments: queuedAttachments });
      addSystemMessage('当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', { persist: false });
      return;
    }

    // 正常发送（Agent空闲时）

    // Show stop button immediately
    setSendButtons(true);

    // Check daily limits before sending
    const settings = await window.api.getSettings();
    const llmLimit = settings.llm.dailyMaxTokens || 0;
    const llmUsed = settings.llm.dailyTokensUsed || 0;
    if (llmLimit > 0) {
      if (llmUsed >= llmLimit) {
        addSystemMessage(`⚠️ 已达到今日LLM Token上限(${llmLimit})，请明天再试或在设置中重置使用量。`);
        setSendButtons(false);
        return;
      } else if (llmUsed >= llmLimit * 0.9) {
        addSystemMessage(`⚠️ 警告：今日Token已使用${llmUsed}，接近限制${llmLimit}(${((llmUsed/llmLimit)*100).toFixed(1)}%)`);
      }
    }

    chatInput.value = '';
    chatInput.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

    // Process attachments
    const attachments = [...currentAttachments];
    clearAttachments();

    // Show message with attachment indicators
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addMessageToChat('user', displayText);
    addThinkingIndicator();
    window.api.webControlPushMessage('user', displayText);

    await copyAttachmentsToWorkspace(attachments);

    // Process attachments: OCR for images, text extraction for documents
    for (const att of attachments) {
      if (att.isImage && att.path) {
        // OCR for images
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) {
            att.ocrText = ocrResult.text;
          }
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        // Extract text from Office/PDF files
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
            if (importResult.ok && importResult.content) {
              // 将转换后的文本保存到工作目录
              const workspacePath = agent.workspacePath;
              if (workspacePath) {
                const textFileName = att.name.replace(/\.\w+$/, '.txt');
                const textFilePath = `${workspacePath}\\${textFileName}`;
                const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                if (saveResult.ok) {
                  att.convertedPath = textFilePath;
                  att.extractedText = `已转换为文本文件：${textFilePath}`;
                } else {
                  att.extractedText = importResult.content;
                }
              } else {
                att.extractedText = importResult.content;
              }
              // 如果有图片，也提取出来
              if (importResult.images && importResult.images.length > 0) {
                att.extractedImages = importResult.images;
              }
            }
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }

    try {
      await agent.sendMessage(text, attachments);
    } finally {
      removeThinkingIndicator();
    }
  }

  // ---- Stop Button ----
  // 停止所有语音播报 + 清空播放队列（含后续推理的 TTS）
  function stopVoicePlayback() {
    try { if (window.VoiceUI && window.VoiceUI.stopSpeaking) window.VoiceUI.stopSpeaking(); } catch (_) {}
  }

  // 语音播报全部排空后：若 Agent 也已停止，隐藏"停止"按钮（仅在两者都完成时才隐藏）
  function refreshChatStopButton() {
    if (!btnStop) return;
    const speaking = (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
    if (speaking) {
      btnStop.classList.remove('hidden');
    } else {
      btnStop.classList.add('hidden');
    }
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
  }
  // 语音队列全部播完（清空）后回调：重新判断是否隐藏停止按钮
  window.onVoicePlaybackIdle = () => {
    // 仅在非工作状态下评估（工作中按钮早已显示）
    if (agent && !agent.running) {
      try { refreshChatStopButton(); } catch (_) {}
      try { refreshCodeStopButton(); } catch (_) {}
      try { refreshBabeStopButton(); } catch (_) {}
    }
  };
  // 语音开始/继续播放时回调：确保 TTS 先于 Agent 结束的补播也能显示停止按钮
  window.onVoicePlaybackActive = () => {
    if (agent && !agent.running) {
      try { refreshChatStopButton(); } catch (_) {}
      try { refreshCodeStopButton(); } catch (_) {}
      try { refreshBabeStopButton(); } catch (_) {}
    }
  };

  function voiceSpeakingNow() {
    return (window.VoiceUI && window.VoiceUI.isSpeaking) ? window.VoiceUI.isSpeaking() : false;
  }
  function refreshCodeStopButton() {
    const stopBtn = document.getElementById('btn-code-stop');
    if (!stopBtn) return;
    stopBtn.classList.toggle('hidden', !(codeAgent && codeAgent.running) && !voiceSpeakingNow());
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: stopBtn.className });
  }
  function refreshBabeStopButton() {
    const stopBtn = document.getElementById('btn-babe-stop');
    if (!stopBtn) return;
    stopBtn.classList.toggle('hidden', !(babeAgent && babeAgent.running) && !voiceSpeakingNow());
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-babe-stop', attr: 'class', value: stopBtn.className });
  }

  if (btnStop) {
    btnStop.addEventListener('click', () => {
      if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
        remoteWs.send(JSON.stringify({ type: 'stopAgent' }));
        removeThinkingIndicator();
        return;
      }
      stopVoicePlayback();
      agent.stop();
      removeThinkingIndicator();
    });
  }

  btnSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    // 输入框所在页面隐藏时跳过：scrollHeight 为 0，会把高度写成 0px 导致返回后塌陷
    if (chatInput.offsetParent === null) return;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  // Quick actions
  document.querySelectorAll('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.dataset.prompt;
      sendMessage();
    });
  });

  // ---- Attachment Handling ----
  function addAttachment(file) {
    const isImage = file.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(file.name);
    const att = { name: file.name, size: file.size, type: file.type, isImage, path: file.path || null, pendingSave: null };

    // If it's a blob/File without path, save to workspace
    if (!att.path && file.arrayBuffer) {
      att.pendingSave = file.arrayBuffer().then(buf => {
        return window.api.saveUploadedFile(file.name, buf).then(result => {
          if (result.ok) att.path = result.path;
        });
      });
    }

    currentAttachments.push(att);
    renderAttachments();
  }

  async function copyAttachmentsToWorkspace(attachments) {
    const workspacePath = agent.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;

    // 仅用于路径比较的规范化（平台无关），写入文件系统时仍用原始路径
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    const normalizedWorkspace = norm(workspacePath).replace(/\/+$/, '');
    await window.api.makeDirectory(workspacePath);

    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    for (const att of attachments) {
      if (!att.path) continue;
      if (norm(att.path).startsWith(normalizedWorkspace + '/')) continue;

      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${workspacePath}/${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) {
        att.originalPath = att.path;
        att.path = destPath;
      }
    }
  }

  function removeAttachment(index) {
    currentAttachments.splice(index, 1);
    renderAttachments();
  }

  function clearAttachments() {
    currentAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (currentAttachments.length === 0) {
      attachmentsPreview.classList.add('hidden');
      attachmentsPreview.innerHTML = '';
      return;
    }
    attachmentsPreview.classList.remove('hidden');
    attachmentsPreview.innerHTML = currentAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    attachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeAttachment(parseInt(btn.dataset.index)));
    });
  }

  // Attach file button
  if (btnAttachFile) {
    btnAttachFile.addEventListener('click', async () => {
      const result = await window.api.openFileDialog({ multiple: true });
      if (result.ok && result.paths) {
        for (const p of result.paths) {
          const name = p.split(/[\\/]/).pop();
          const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
          currentAttachments.push({ name, path: p, isImage });
        }
        renderAttachments();
      }
    });
  }

  // WebUI 上传文件后通知渲染器刷新附件列表
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded((data) => {
      if (data && data.path) {
        currentAttachments.push({ name: data.name, path: data.path, isImage: data.isImage });
        renderAttachments();
      }
    });
  }

  // Drag and drop
  chatMessages.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatMessages.classList.add('drag-over');
  });
  chatMessages.addEventListener('dragleave', () => {
    chatMessages.classList.remove('drag-over');
  });
  chatMessages.addEventListener('drop', (e) => {
    e.preventDefault();
    chatMessages.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        addAttachment(file);
      }
    }
  });

  // Paste image
  chatInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          // Save file directly
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            currentAttachments.push({ name, path: result.path, isImage: true });
            renderAttachments();
          }
        }
      }
    }
  });

  // ---- Camera Modal ----
  if (btnCamera) {
    btnCamera.addEventListener('click', async () => {
      cameraModal.classList.remove('hidden');
      const video = document.getElementById('camera-video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.play();
      } catch (e) {
        console.error('Camera error:', e);
        fadeOutHide(cameraModal);
      }
    });
  }

  document.getElementById('btn-close-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-cancel-camera')?.addEventListener('click', () => {
    closeCameraModal();
  });

  document.getElementById('btn-capture-photo')?.addEventListener('click', async () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    const name = `camera-${Date.now()}.png`;
    const result = await window.api.saveUploadedFile(name, arrayBuffer);
    if (result.ok) {
      currentAttachments.push({ name, path: result.path, isImage: true });
      renderAttachments();
    }
    closeCameraModal();
  });

  function closeCameraModal() {
    const video = document.getElementById('camera-video');
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    fadeOutHide(cameraModal);
  }

  // ---- Image Preview Modal ----
  document.getElementById('btn-close-image-modal')?.addEventListener('click', () => {
    fadeOutHide(imagePreviewModal);
  });
  imagePreviewModal?.addEventListener('click', (e) => {
    if (e.target === imagePreviewModal) fadeOutHide(imagePreviewModal);
  });

  // ---- Open Workspace ----
  if (btnOpenWorkspace) {
    btnOpenWorkspace.addEventListener('click', async () => {
      if (agent.workspacePath) {
        await window.api.workspaceOpenInExplorer(agent.workspacePath);
      } else {
        const base = await window.api.workspaceGetBase();
        if (base.ok) await window.api.openFileExplorer(base.path);
      }
    });
  }

  // 统一的 Chat 欢迎消息渲染：根据生图模型配置决定是否显示"生成图片"按钮
  function renderChatWelcome() {
    const imgConfigured = !!(agent.settings?.imageGen?.apiUrl && agent.settings?.imageGen?.apiKey && agent.settings?.imageGen?.model);
    const imgBtn = imgConfigured
      ? `<button class="quick-action-btn" data-prompt="帮我生成一张风景图片"><i class="fa-solid fa-image"></i> 生成图片</button>`
      : '';
    chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <h2>你好，我是你的AI伙伴</h2>
        <p>我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索${imgConfigured ? '、图像生成' : ''}等。告诉我你需要什么帮助吧！</p>
        <div class="quick-actions">
          <button class="quick-action-btn" data-prompt="帮我搜索一下最新的科技新闻"><i class="fa-solid fa-magnifying-glass"></i> 搜索新闻</button>
          ${imgBtn}
          <button class="quick-action-btn" data-prompt="帮我创建一个待办事项列表"><i class="fa-solid fa-list-check"></i> 待办事项</button>
          <button class="quick-action-btn" data-prompt="帮我写一段JavaScript代码"><i class="fa-solid fa-code"></i> 编写代码</button>
        </div>
      </div>`;
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => { chatInput.value = btn.dataset.prompt; sendMessage(); });
    });
    // 增量推送：替换聊天容器内容为欢迎页
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#chat-messages', html: chatMessages.innerHTML });
  }

  // New chat
  btnNewChat.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'newChat' }));
      setTitlebarTitle('未命名对话');
      clearChatMessagesUI();
      renderChatWelcome();
      return;
    }
    createNewSession('chat');
  });

  btnClearChat.addEventListener('click', () => {
    stopVoicePlayback(); // 清空语音播放队列
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'newChat' }));
      setTitlebarTitle('未命名对话');
      clearChatMessagesUI();
      return;
    }
    const session = sessionManager?.getActive('chat');
    if (session) {
      const running = session.status === SessionStatus.RUNNING
        || session.status === SessionStatus.WAITING_APPROVAL
        || session.status === SessionStatus.WAITING_TOOL_AUTH;
      if (running && !window.confirm('当前会话仍在运行，确定停止并清空吗？')) return;
      sessionManager.close(session);
      if (session.agent === agent) {
        const next = sessionManager.list('chat')[0];
        agent = next ? next.agent : new Agent();
      }
    }
    createNewSession('chat');
  });

  // ---- Todo Panel ----
  document.getElementById('btn-todo-toggle').addEventListener('click', () => {
    todoPanel.classList.toggle('hidden');
  });

  document.getElementById('btn-close-todo').addEventListener('click', () => {
    todoPanel.classList.add('hidden');
  });

  document.getElementById('btn-add-todo').addEventListener('click', () => {
    const text = todoInput.value.trim();
    if (!text) return;
    agent.handleTodo({ action: 'add', text });
    todoInput.value = '';
  });

  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = todoInput.value.trim();
      if (!text) return;
      agent.handleTodo({ action: 'add', text });
      todoInput.value = '';
    }
  });

  function renderTodoList(items) {
    if (items.length === 0) {
      todoList.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-list-check"></i><p>暂无待办事项</p></div>';
    } else {
      todoList.innerHTML = items.map(item => `
        <div class="todo-item ${item.done ? 'done' : ''}" data-id="${item.id}">
          <div class="todo-checkbox"><i class="fa-solid fa-check"></i></div>
          <span class="todo-text">${escapeHtml(item.text)}</span>
          <button class="btn-icon todo-delete" title="删除"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
    }
    // 增量推送：替换待办列表内容
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#todo-list', html: todoList.innerHTML });
  }

  // ---- Approval Panel ----
  function showApprovalPanel(toolName, args) {
    approvalPanel.classList.remove('hidden');
    approvalPanel.dataset.toolName = toolName || 'unknown';
    const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
    approvalContent.textContent = `操作: ${toolDef?.desc || toolName}\n\n参数:\n${JSON.stringify(args, null, 2)}`;
    // 增量推送：显示审批面板并更新内容
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#approval-content', text: approvalContent.textContent });
    // 系统通知：敏感操作需要审批时
    const dispName = toolDef?.desc || toolName || '未知操作';
    sendAppNotification('approval', '需要您的批准', `Agent 请求执行: ${dispName}`);
  }

  document.getElementById('btn-approve').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户批准执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: true }));
      return;
    }
    agent.resolveApproval(true);
  });

  document.getElementById('btn-deny').addEventListener('click', () => {
    approvalPanel.classList.add('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#approval-panel', attr: 'class', value: approvalPanel.className });
    // 持久化审批决策到聊天历史
    try {
      const toolName = approvalPanel.dataset.toolName || 'unknown';
      addSystemMessage(`[审批] 用户拒绝执行工具: ${toolName}`, { persist: true });
    } catch {}
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(JSON.stringify({ type: 'approvalResponse', approved: false }));
      return;
    }
    agent.resolveApproval(false);
  });

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

  // ---- 关闭时询问"后台运行"模态框（Tray Mode）----
  const trayAskModal = document.getElementById('tray-ask-modal');
  function _showTrayAskModal() {
    if (!trayAskModal) return;
    trayAskModal.classList.remove('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
  }
  function _closeTrayAskModal() {
    if (!trayAskModal) return;
    fadeOutHide(trayAskModal, () => {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
    });
  }
  function _respondTrayAsk(decision) {
    _closeTrayAskModal();
    try { window.api.trayRespondCloseDecision(decision); } catch {}
  }
  const _btnTrayNever = document.getElementById('btn-tray-never');
  const _btnTrayOnce = document.getElementById('btn-tray-once');
  const _btnTrayAlways = document.getElementById('btn-tray-always');
  const _btnTrayCancel = document.getElementById('btn-tray-cancel');
  if (_btnTrayNever) _btnTrayNever.addEventListener('click', () => _respondTrayAsk('never'));
  if (_btnTrayOnce) _btnTrayOnce.addEventListener('click', () => _respondTrayAsk('once'));
  if (_btnTrayAlways) _btnTrayAlways.addEventListener('click', () => _respondTrayAsk('always'));
  if (_btnTrayCancel) _btnTrayCancel.addEventListener('click', () => _respondTrayAsk('cancel'));
  // 监听主进程的询问事件
  try {
    window.api.onTrayAskCloseDecision(() => _showTrayAskModal());
  } catch {}
