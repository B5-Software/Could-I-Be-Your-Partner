  document.getElementById('btn-code-send')?.addEventListener('click', sendCodeMessage);
  document.getElementById('btn-code-stop')?.addEventListener('click', () => {
    stopVoicePlayback();
    const session = sessionManager?.getActive('code');
    if (session) sessionManager.stop(session);
  });
  document.getElementById('code-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendCodeMessage();
    }
  });
  document.getElementById('code-chat-input')?.addEventListener('input', (e) => {
    if (e.target.offsetParent === null) return; // 隐藏时不调整高度，避免 0px 塌陷
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  });

  document.getElementById('btn-code-new-session')?.addEventListener('click', () => createCodeSession().catch(error => showToast(error.message, 'error')));
