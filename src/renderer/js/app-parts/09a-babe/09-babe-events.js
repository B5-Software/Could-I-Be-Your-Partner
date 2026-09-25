  // ---- Babe Mode 事件绑定 ----
  document.getElementById('btn-babe-send')?.addEventListener('click', sendBabeMessage);
  document.getElementById('btn-babe-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('babe');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('btn-babe-new')?.addEventListener('click', async () => {
    stopVoicePlayback(); // 清空语音播放队列
    await createBabeSession();
  });
  document.getElementById('btn-babe-proactive')?.addEventListener('click', () => {
    if (!babeAgent) {
      window.showMessageModal('请先初始化 Babe 模式', '提示', 'warning');
      return;
    }
    babeProactiveMessage();
  });
  document.getElementById('babe-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBabeMessage();
    }
  });
  document.getElementById('babe-chat-input')?.addEventListener('input', (e) => {
    if (e.target.offsetParent === null) return; // 隐藏时不调整高度，避免 0px 塌陷
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });
