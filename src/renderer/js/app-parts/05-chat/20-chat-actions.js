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
