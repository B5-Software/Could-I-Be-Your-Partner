  if (typeof VirtualScroller !== 'undefined' && chatMessages) {
    VirtualScroller.attach(chatMessages);
    // Code/Babe 消息容器未接入主虚拟滚动：挂载轻量懒渲染，
    // 长会话下自动折叠离屏消息的渲染内容，防止 DOM 无界增长
    const codeMsgsEl = document.getElementById('code-chat-messages');
    if (codeMsgsEl) {
      VirtualScroller.attachLazyContainer(codeMsgsEl, { selector: '.message', contentSel: '.message-content' });
    }
    const babeMsgsEl = document.getElementById('babe-chat-messages');
    if (babeMsgsEl) {
      VirtualScroller.attachLazyContainer(babeMsgsEl, { selector: '.babe-message', contentSel: '.babe-msg-bubble' });
    }
  }

  // 推送容器选择器：根据 currentMode 返回对应消息容器的选择器
  function getChatContainerSelector() {
    if (currentMode === 'code') return '#code-chat-messages';
    if (currentMode === 'babe') return '#babe-chat-messages';
    return '#chat-messages';
  }

  // 统一的聊天容器清空 + 增量推送
  function clearChatMessagesUI() {
    chatMessages.innerHTML = '';
    // 清理子代理卡片记录：DOM 已随 innerHTML 清空，同步释放 Map 引用与计时器
    // （否则下次"新对话"后旧子代理卡片引用仍驻留在 _subAgentCards 中）
    if (typeof _subAgentCards !== 'undefined' && _subAgentCards) {
      for (const rec of _subAgentCards.values()) {
        if (rec.timer) clearInterval(rec.timer);
      }
      _subAgentCards.clear();
    }
    // 清空虚拟滚动观察状态：彻底释放旧会话的消息节点、占位 div 与
    // dataset 中缓存的原始内容引用，避免每次"新对话"线性累积内存
    if (typeof VirtualScroller !== 'undefined' && VirtualScroller.reset) VirtualScroller.reset();
    // 递增回放 generation：取消任何进行中的异步历史回放，
    // 防止新会话消息与旧会话残留交错
    window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1;
    WebUIMirror.pushDomEvent({ type: 'dom_clear', container: getChatContainerSelector() });
    // 同步移除思考指示器（若存在）
    WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
  }

  function setTitlebarTitle(title) {
    const titleEl = document.getElementById('titlebar-title');
    if (titleEl) titleEl.textContent = title || '未命名对话';
    // 增量推送：更新标题文本
    WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#titlebar-title', text: title || '未命名对话' });
  }

  // Attachment state
  let currentAttachments = [];

  // ---- Window Controls ----
  // macOS 使用系统红绿灯按钮，隐藏自定义窗口控制按钮
