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

      scrollElementIntoView(msg);
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
