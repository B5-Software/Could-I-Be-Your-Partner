  // ---- 会话交互卡片（问卷/游戏邀请等）跨切换保留 ----
  function sessionContainerEl(session) {
    if (!session) return null;
    if (session.mode === 'code') return document.getElementById('code-chat-messages');
    if (session.mode === 'babe') return document.getElementById('babe-chat-messages');
    return chatMessages;
  }

  // 会话激活后：把挂在离屏根节点上的交互卡片移回可见容器
  function flushSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    while (session.uiRoot.firstChild) {
      container.appendChild(session.uiRoot.firstChild);
    }
    if (typeof window.forceScrollToBottom === 'function') window.forceScrollToBottom(container);
  }

  // 会话切走前：把属于该会话的交互卡片从可见容器收回离屏根节点
  function retractSessionUiRoot(session) {
    if (!session || !session.uiRoot) return;
    const container = sessionContainerEl(session);
    if (!container) return;
    const nodes = container.querySelectorAll(`[data-session-key="${cssEscape(session.key)}"]`);
    for (const node of nodes) session.uiRoot.appendChild(node);
  }

  // 创建交互卡片时使用：卡片挂到所属会话的离屏根节点，
  // 会话激活时立即冲入可见容器，保证后台会话的卡片不丢、不串到别的会话。
  function appendSessionCard(session, node) {
    if (!session || !node) return;
    node.dataset.sessionKey = session.key;
    session.uiRoot.appendChild(node);
    if (session.active) flushSessionUiRoot(session);
  }

  // 切回会话时重放后台期间缓冲的瞬时 UI 事件（文件呈递/命运牌/牌阵）
  function applyBufferedUiEvents(session) {
    if (!session || !Array.isArray(session.uiEvents) || !session.uiEvents.length) return;
    for (const ev of session.uiEvents) {
      try {
        if (ev.type === 'present-file' && typeof addFilePresentCard === 'function') {
          addFilePresentCard(ev.data);
        } else if (ev.type === 'tarot-spread' && typeof addTarotSpreadToChat === 'function') {
          addTarotSpreadToChat(ev.result);
        } else if (ev.type === 'tarot' && ev.data && agentTarot) {
          // 后台期间命运牌文本未写入聊天记录，这里以 UI-only 方式补渲染
          const data = ev.data;
          const iconHtml = data.icon ? `<i class="fa-solid ${data.icon}"></i>` : '<i class="fa-solid fa-star"></i>';
          const _lang = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
          const _isZh = (_lang === 'zh-CN');
          const position = data.isReversed ? (_isZh ? '逆位' : 'Reversed') : (_isZh ? '正位' : 'Upright');
          const _cardName = _isZh ? data.name : (data.nameEn || data.name);
          const meaning = data.isReversed ? data.meaningOfReversed : data.meaningOfUpright;
          const eSource = data.entropySource || 'CSPRNG';
          const isTRNG = eSource.startsWith('TRNG');
          const trngBadge = isTRNG ? '<span class="trng-badge" style="margin-left:6px;font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';
          agentTarot.innerHTML = `${iconHtml}<span>${_isZh ? '命运之牌：' : 'Tarot: '}${_cardName}(${position})</span>${trngBadge}`;
          agentTarot.title = `${_cardName}(${position}) - ${meaning || ''} [${eSource}]`;
          const entropyNote = isTRNG ? (_isZh ? ' [TRNG 硬件真随机]' : ' [TRNG Hardware Random]') : '';
          addSystemMessage(`${_isZh ? '抽取了命运之牌：' : 'Drew Tarot: '}${_cardName}(${position})${_isZh ? '（' : ' ('}${data.nameEn}${_isZh ? '）' : ')'}${entropyNote}\n${meaning || ''}`, { persist: false });
        }
      } catch { /* ignore */ }
    }
  }

  // 切回会话时同步发送/停止按钮与状态显示
  function syncSessionControls(mode, session) {
    const ag = session?.agent;
    if (mode === 'chat') {
      if (ag && ag.running) {
        if (typeof setSendButtons === 'function') setSendButtons(true);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 工作中...';
          agentStatus.className = 'agent-status working';
        }
        if (typeof addThinkingIndicator === 'function' && !document.getElementById('thinking-indicator')) {
          addThinkingIndicator();
        }
      } else {
        if (typeof setSendButtons === 'function') setSendButtons(false);
        if (agentStatus) {
          agentStatus.innerHTML = '<i class="fa-solid fa-circle"></i> 待命中';
          agentStatus.className = 'agent-status';
        }
      }
      const att = session?.attention;
      if (att && agentStatus) {
        agentStatus.innerHTML = `<i class="fa-solid fa-circle"></i> ${escapeHtml(att.label || '等待处理')}`;
        agentStatus.className = 'agent-status working';
      }
      // 多会话镜像：同步状态栏与发送/停止按钮到 WebUI
      if (!isRemoteMode) {
        try {
          WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#agent-status', html: agentStatus.outerHTML });
          if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-stop', attr: 'class', value: btnStop.className });
          if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-send', attr: 'class', value: btnSend.className });
        } catch { /* ignore */ }
      }
    } else if (mode === 'code') {
      if (typeof refreshCodeStopButton === 'function') refreshCodeStopButton();
    } else if (mode === 'babe') {
      if (typeof refreshBabeStopButton === 'function') refreshBabeStopButton();
    }
  }

  /**
   * 批量关闭指定模式的会话。
   * - 若关闭后该模式没有剩余会话，立即新建一个（标签栏常驻，绝不出现空栏）；
   * - 若关闭的是当前激活会话，则自动激活剩余的第一个会话。
   */
