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
    scrollElementIntoView(el);
  }
