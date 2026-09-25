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
