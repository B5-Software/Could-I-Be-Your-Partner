  // ---- Chat Functions ----
  // 自动滚动控制器（stick-to-bottom，Chat/Code/Babe 共用）：
  //   - 默认吸附底部；用户上滚（滚轮/触屏/键盘）解除吸附
  //   - 回到底部按钮恢复吸附；内容后长（markdown 重渲染/图片/tool 结果）在吸附时自动补滚
  const _autoScrollStates = new WeakMap();
  const AUTO_SCROLL_BOTTOM_EPS = 48;
  const SCROLL_BTN_TARGETS = [
    { id: 'chat-messages', inputSelector: '.chat-input-area' },
    { id: 'code-chat-messages', inputSelector: '.code-chat-input' },
    { id: 'babe-chat-messages', inputSelector: '.babe-chat-input' },
  ];

  function _containerAtBottom(container) {
    return (container.scrollHeight - container.scrollTop - container.clientHeight) <= AUTO_SCROLL_BOTTOM_EPS;
  }

  function _ensureScrollState(container) {
    let st = _autoScrollStates.get(container);
    if (st) return st;
    st = { stick: true, scheduled: false, lastProgrammaticAt: 0, btn: null, observer: null };
    _autoScrollStates.set(container, st);

    const setStick = (value) => {
      st.stick = value;
      if (st.btn) _updateScrollButton(st);
    };

    container.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && !_containerAtBottom(container)) setStick(false);
    }, { passive: true });
    container.addEventListener('touchmove', () => {
      if (!_containerAtBottom(container)) setStick(false);
    }, { passive: true });
    container.addEventListener('keydown', (e) => {
      if ((e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') && !_containerAtBottom(container)) setStick(false);
    });
    container.addEventListener('scroll', () => {
      // 程序化滚动后的短窗口内忽略 scroll 事件，避免误清除吸附
      if (Date.now() - st.lastProgrammaticAt < 180) return;
      setStick(_containerAtBottom(container));
    }, { passive: true });

    const onGrow = () => {
      if (st.stick) _scheduleAutoScroll(container, st);
      if (st.btn) _updateScrollButton(st);
    };
    try {
      st.observer = new MutationObserver(onGrow);
      st.observer.observe(container, { childList: true, subtree: true, characterData: true });
    } catch { /* ignore */ }
    container.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'IMG') onGrow();
    }, true);
    container.addEventListener('resize', onGrow, true);
    return st;
  }

  function _scheduleAutoScroll(container, st) {
    if (!st.stick || st.scheduled) return;
    st.scheduled = true;
    requestAnimationFrame(() => {
      st.scheduled = false;
      if (!st.stick) return;
      st.lastProgrammaticAt = Date.now();
      container.scrollTop = container.scrollHeight;
    });
  }

  // 请求自动滚动（吸附状态才生效）
  function requestAutoScroll(container) {
    if (!container) return;
    const st = _ensureScrollState(container);
    _scheduleAutoScroll(container, st);
  }

  // 强制回到底部并恢复吸附（历史回放/切换会话）
  function forceScrollToBottom(container) {
    if (!container) return;
    const st = _ensureScrollState(container);
    st.stick = true;
    st.lastProgrammaticAt = Date.now();
    container.scrollTop = container.scrollHeight;
    if (st.btn) _updateScrollButton(st);
  }

  function _updateScrollButton(st) {
    if (!st.btn) return;
    const container = st.container;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const inputArea = st.inputSelector ? document.querySelector(st.inputSelector) : null;
    const inputTop = inputArea ? inputArea.getBoundingClientRect().top : rect.bottom;
    st.btn.style.right = Math.max(12, Math.round(window.innerWidth - rect.right + 18)) + 'px';
    st.btn.style.bottom = Math.max(12, Math.round(window.innerHeight - inputTop + 12)) + 'px';
    const visible = rect.width > 0 && rect.height > 0;
    const shouldShow = visible && !st.stick && !_containerAtBottom(container);
    st.btn.classList.toggle('sbb-hidden', !shouldShow);
  }

  function _ensureScrollButton(container, inputSelector) {
    const st = _ensureScrollState(container);
    st.container = container;
    st.inputSelector = inputSelector;
    if (st.btn) return st.btn;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scroll-to-bottom-btn sbb-hidden';
    btn.setAttribute('aria-label', 'scroll to bottom');
    btn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
    btn.addEventListener('click', () => {
      st.stick = true;
      st.lastProgrammaticAt = Date.now();
      if (st.btn) st.btn.classList.add('sbb-hidden');
      try { container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }); }
      catch { container.scrollTop = container.scrollHeight; }
    });
    document.body.appendChild(btn);
    st.btn = btn;
    _updateScrollButton(st);
    window.addEventListener('resize', () => _updateScrollButton(st));
    try {
      const ro = new ResizeObserver(() => _updateScrollButton(st));
      ro.observe(container);
      const inputArea = inputSelector ? document.querySelector(inputSelector) : null;
      if (inputArea) ro.observe(inputArea);
    } catch { /* ignore */ }
    return btn;
  }

  function _initAutoScrollTargets() {
    SCROLL_BTN_TARGETS.forEach(({ id, inputSelector }) => {
      const container = document.getElementById(id);
      if (!container) return;
      _ensureScrollState(container);
      _ensureScrollButton(container, inputSelector);
    });
  }

  // 滚动到指定聊天容器的底部（保留旧签名，供现有调用点复用）
  function scrollChatToBottom(targetEl) {
    const container = targetEl || document.getElementById('thinking-indicator')?.parentElement || chatMessages;
    requestAutoScroll(container);
  }

  // 元素所在模式的滚动容器
  function _scrollContainerOf(el) {
    const container = el && el.closest && el.closest('#chat-messages, #code-chat-messages, #babe-chat-messages');
    return container || document.getElementById('thinking-indicator')?.parentElement || chatMessages;
  }

  function scrollElementIntoView(el) {
    scrollChatToBottom(_scrollContainerOf(el));
  }

  _initAutoScrollTargets();
  window.requestAutoScroll = requestAutoScroll;
  window.forceScrollToBottom = forceScrollToBottom;

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
