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
    // 浮窗内点空白处也关闭（可选，增强交互）；拖选文本松手到框外不触发
    if (typeof bindBackdropClose === 'function') bindBackdropClose(overlay, close);
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
