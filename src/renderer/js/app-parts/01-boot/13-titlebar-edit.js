  // ---- Title Editing ----
  const titlebarTitle = document.getElementById('titlebar-title');
  const titlebarEdit = document.getElementById('titlebar-title-edit');

  titlebarTitle?.addEventListener('click', () => {
    titlebarTitle.classList.add('hidden');
    titlebarEdit.classList.remove('hidden');
    titlebarEdit.value = agent.conversationTitle || '未命名对话';
    titlebarEdit.focus();
    titlebarEdit.select();
  });

  titlebarEdit?.addEventListener('blur', async () => {
    const newTitle = titlebarEdit.value.trim() || '未命名对话';
    // 定位当前激活会话的 agent（code/babe 模式下避免误改 chat 会话标题）
    const active = (typeof sessionManager !== 'undefined' && sessionManager) ? sessionManager.getActive(currentMode) : null;
    const targetAgent = (active && active.agent) ? active.agent : agent;
    targetAgent.conversationTitle = newTitle;
    setTitlebarTitle(newTitle);
    titlebarEdit.classList.add('hidden');
    titlebarTitle.classList.remove('hidden');
    // 经 onTitleChange 传播给会话管理器：更新 session.title 并触发标签页重渲染
    if (typeof targetAgent.onTitleChange === 'function') targetAgent.onTitleChange(newTitle);
    // Save to history if conversation exists
    if (targetAgent.conversationId) {
      await window.api.historyRename(targetAgent.conversationId, newTitle);
    }
  });

  titlebarEdit?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      titlebarEdit.blur();
    } else if (e.key === 'Escape') {
      titlebarEdit.classList.add('hidden');
      titlebarTitle.classList.remove('hidden');
    }
  });
