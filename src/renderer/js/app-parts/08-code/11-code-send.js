  let codePreparingAgent = null;
  async function submitCodeTask(text, attachments, context, allowQueue = true) {
    if (!codeWorkspacePath) throw new Error('请先打开工作区文件夹');
    if (!codeAgent && !await initCodeAgent()) throw new Error('Agent 初始化失败');
    const ag = codeAgent;
    const workspace = codeWorkspacePath;
    if (ag.running || ag.codeTaskPending) throw new Error('当前 Agent 正在处理任务，请等待完成或停止后重试。');
    const editorWorkspace = context?.workspace?.[0]?.path;
    const windowsHost = context?.workspace?.[0]?.location !== 'vm' && ag.systemInfo?.platform === 'win32';
    const workspaceKey = value => { const key = value.replace(/\\/g, '/'); return windowsHost ? key.toLowerCase() : key; };
    if (editorWorkspace && workspaceKey(editorWorkspace) !== workspaceKey(workspace)) {
      throw new Error('编辑器工作区已改变，请等待切换完成后重试。');
    }
    const taskAttachments = attachments.map(item => ({ ...item, extractedText: item.extractedText || item.content || '' }));
    ag.contextManager.setContextSource('当前编辑器', context?.content ? JSON.stringify(context, null, 2) : '');
    ag.workspacePath = workspace;
    ag.codeWorkspacePath = workspace;
    const session = sessionManager?.getByAgent(ag);
    const canStart = !session || sessionManager.requestStart(session);
    if (!canStart && !allowQueue) throw new Error('当前并发会话已达上限，请稍后重试。');
    const display = text + (attachments.length ? '\n[附件: ' + attachments.map(item => item.name).join(', ') + ']' : '');
    addCodeMessage('user', display);
    clearCodeAttachments();
    const input = document.getElementById('code-chat-input');
    input.value = '';
    input.style.height = 'auto';
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#code-chat-input', value: '' });
    if (!canStart) {
      sessionManager.queue(session, { text, attachments: taskAttachments });
      addCodeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', false);
      return;
    }
    ag.codeTaskPending = true;
    if (session) sessionManager.setStatus(session, SessionStatus.RUNNING);
    try {
      const task = ag.sendMessage(text, taskAttachments);
      syncSessionControls('code', session);
      await task;
    } finally {
      ag.codeTaskPending = false;
      if (codeAgent === ag) syncSessionControls('code', session);
      await ag.saveToHistory();
    }
  }

  async function sendCodeMessage() {
    const input = document.getElementById('code-chat-input');
    const text = input.value.trim();
    if ((!text && !codeCurrentAttachments.length) || codeAgent?.running || codePreparingAgent) return;
    const ag = codeAgent;
    const workspace = codeWorkspacePath;
    const attachments = [...codeCurrentAttachments];
    const preparation = {};
    codePreparingAgent = preparation;
    document.getElementById('btn-code-send').disabled = true;
    try {
      if (!workspace) throw new Error('请先打开工作区文件夹');
      const context = await codeAgentPanel.context();
      if (ag !== codeAgent || workspace !== codeWorkspacePath) throw new Error('会话或工作区已改变，请重新发送。');
      if (!codeAgent && !await initCodeAgent()) throw new Error('Agent 初始化失败');
      const task = submitCodeTask(text, attachments, context);
      codePreparingAgent = null;
      document.getElementById('btn-code-send').disabled = false;
      await task;
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      if (codePreparingAgent === preparation) codePreparingAgent = null;
      if (!codePreparingAgent) document.getElementById('btn-code-send').disabled = false;
    }
  }
