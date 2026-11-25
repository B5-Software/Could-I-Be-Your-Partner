  // ---- History 加载进度模态框（非阻塞解析大历史记录） ----
  // 大历史记录回放时逐批渲染，每批之间让出事件循环（yield），
  // 模态框实时显示进度，避免渲染器长时间阻塞卡死。
  function showHistoryProgress(total) {
    const modal = document.getElementById('history-progress-modal');
    if (!modal) return;
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    if (fill) fill.style.width = '0%';
    if (count) count.textContent = `0 / ${total}`;
    if (text) text.textContent = '正在解析历史记录…';
    modal.classList.remove('hidden');
  }

  function updateHistoryProgress(done, total, label) {
    const fill = document.getElementById('history-progress-fill');
    const count = document.getElementById('history-progress-count');
    const text = document.getElementById('history-progress-text');
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 100;
    if (fill) fill.style.width = pct + '%';
    if (count) count.textContent = `${done} / ${total}`;
    if (text && label) text.textContent = label;
  }

  function hideHistoryProgress() {
    const modal = document.getElementById('history-progress-modal');
    fadeOutHide(modal);
  }

  // 让出事件循环一帧（macrotask），使进度模态框能刷新、DOM 能回流
  function yieldHistoryUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // 分块异步回放历史消息：小历史直接同步完成消除闪动/竞态，大历史分块并 yield。
  // 返回 true 表示正常完成；返回 false 表示中途被取消（本次会话已切换）。
  async function replayHistoryMessages(messages, opts = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const total = list.length;
    const chunkSize = opts.chunkSize || 40; // 每批处理 40 条，避免长任务阻塞
    const cancelCheck = opts.cancelCheck || null; // 可选取消检查函数
    const toolCallMap = {};
    const needChunking = total > chunkSize;
    if (needChunking) showHistoryProgress(total);
    let done = 0;
    try {
      for (let start = 0; start < total; start += chunkSize) {
        // 每个 chunk 前检查是否被取消（用户切换会话/清空）
        if (cancelCheck && cancelCheck()) return false;
        const end = Math.min(total, start + chunkSize);
        for (let i = start; i < end; i++) {
          const msg = list[i];
          if (!msg || msg.metadata?.kind === 'context-update') continue;
          if (msg.role === 'user') {
            addMessageToChat('user', msg);
          } else if (msg.role === 'assistant') {
            if (msg.content || ReasoningData.presentation(msg).reasoning) addMessageToChat('assistant', msg);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              for (const tc of msg.tool_calls) {
                const toolName = tc.function?.name || 'tool';
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                const toolDef = TOOL_DEFINITIONS.find(t => t.name === toolName);
                const displayName = toolDef?.desc || toolName;
                addToolCallToChat(displayName, toolName, args, tc.id);
                if (tc.id) toolCallMap[tc.id] = toolName;
              }
            }
          } else if (msg.role === 'tool') {
            const toolName = msg.name || toolCallMap[msg.tool_call_id] || 'tool';
            // 兼容旧版多模态 tool 消息 content 为数组的情况：提取文本，避免显示 [object Object]
            let result = msg.content;
            if (Array.isArray(result)) result = extractTextContent(result);
            try { result = JSON.parse(result); } catch {}
            updateToolCallResult(toolName, result, false, msg.tool_call_id);
            // 历史回放：恢复 AI 生图气泡（结果 JSON 中含 url/path）
            if (toolName === 'generateImage' && result && typeof result === 'object' && result.ok && result.url) {
              addImageMessage(result.url, { path: result.path });
            }
          } else if (msg.role === 'system' && msg.metadata?.type !== 'error') {
            // 回放历史时显示系统消息（不重复持久化）
            addSystemMessage(msg.content, { persist: false });
          }
          done++;
        }
        if (needChunking) {
          const isLast = end >= total;
          updateHistoryProgress(done, total, isLast ? '渲染完成，正在收尾…' : `已渲染 ${done}/${total} 条消息`);
          await yieldHistoryUI();
        }
      }
      if (cancelCheck && cancelCheck()) return false;
      return true;
    } finally {
      if (needChunking) hideHistoryProgress();
    }
  }

  // 从历史会话重建 Chat UI（供会话切换、pending-resume 和其他场景使用）
  // 返回 Promise<boolean>（true=完整完成，false=被新的切换取消）。
  async function rebuildChatUIFromHistory(conv, opts = {}) {
    setTitlebarTitle(agent.conversationTitle || conv?.title || '未命名对话');
    updateContextProgress();
    // 切换到 chat 页（可选跳过，例如后台预同步）
    if (opts.navigate !== false) navigatePage('chat');
    if (typeof clearChatStreamingBubbles === 'function') clearChatStreamingBubbles();
    if (typeof clearSubAgentCards === 'function') clearSubAgentCards();
    // 清空并回放消息
    chatMessages.innerHTML = '';
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.reset();
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchStart();
    if (typeof WebUIMirror !== 'undefined' && WebUIMirror.pushDomEvent) {
      WebUIMirror.pushDomEvent({ type: 'dom_clear', container: '#chat-messages' });
      WebUIMirror.pushDomEvent({ type: 'dom_remove', selector: '#thinking-indicator' });
    }
    const chatGeneration = (window.__chatReplayGeneration = (window.__chatReplayGeneration || 0) + 1);
    const finished = await replayHistoryMessages(conv?.messages || [], {
      cancelCheck: () => window.__chatReplayGeneration !== chatGeneration || (opts.cancelCheck ? opts.cancelCheck() : false)
    });
    if (!finished) return false;
    if (typeof VirtualScroller !== 'undefined') VirtualScroller.markBatchEnd();

    const hasLiveActivity = Boolean(
      conv?.activeStream ||
      conv?.unadmittedInput ||
      opts.running
    );
    if (!conv?.messages?.length && !conv?.subAgents?.length && !hasLiveActivity) {
      renderChatWelcome();
    }
    // 重建子代理卡片
    if (conv?.subAgents && Array.isArray(conv.subAgents) && conv.subAgents.length > 0) {
      for (const rec of conv.subAgents) {
        if (!rec || !rec.id) continue;
        addSubAgentCard({
          id: rec.id,
          title: rec.task ? `子代理：${String(rec.task).slice(0, 20)}` : '子代理',
          task: rec.task || '',
          startTime: rec.startTime || Date.now(),
          status: rec.status || 'done'
        });
        updateSubAgentCard(rec.id, {
          status: rec.status || 'done',
          duration: (rec.endTime && rec.startTime) ? (rec.endTime - rec.startTime) : 0,
          toolUseCount: rec.toolUseCount || 0,
          usage: rec.usage || {},
          result: rec.result || ''
        });
      }
    }
    if (conv?.unadmittedInput && (conv.unadmittedInput.text || conv.unadmittedInput.attachments?.length)) {
      addMessageToChat('user', conv.unadmittedInput.text || '', conv.unadmittedInput.attachments || []);
    }
    if (conv?.activeStream && typeof restoreChatStreamBubble === 'function') {
      restoreChatStreamBubble(conv.activeStream);
    }
    if (typeof window.forceScrollToBottom === 'function') window.forceScrollToBottom(chatMessages);
    return true;
  }

  // Listen for language changes to update mode labels
  window.addEventListener('languagechange', (e) => {
    updateModeLabels(e.detail.lang);
  });

  initPersonaDisplay();
