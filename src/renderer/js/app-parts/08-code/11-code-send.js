  async function sendCodeMessage() {
    const input = document.getElementById('code-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && codeCurrentAttachments.length === 0) return;
    if (!codeAgent) {
      const ok = await initCodeAgent();
      if (!ok) return;
    }
    // 会话可在尚未选择工作区时先行创建（与其他模式对齐），
    // 真正发送时再要求工作区，避免"空工作区"直接进入 Agent。
    if (!codeWorkspacePath) {
      window.showMessageModal('请先打开工作区文件夹', '提示', 'warning');
      return;
    }
    if (codeAgent.workspacePath !== codeWorkspacePath || codeAgent.codeWorkspacePath !== codeWorkspacePath) {
      codeAgent.workspacePath = codeWorkspacePath;
      codeAgent.codeWorkspacePath = codeWorkspacePath;
    }
    if (codeAgent.running) return;
    const codeSession = sessionManager?.getByAgent(codeAgent);
    if (codeSession && !sessionManager.requestStart(codeSession)) {
      const queued = codeCurrentAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage,
        extractedText: att.content || ''
      }));
      addCodeMessage('user', text);
      input.value = '';
      clearCodeAttachments();
      sessionManager.queue(codeSession, { text, attachments: queued });
      addCodeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', false);
      return;
    }

    // 与 Chat 模式一致：UI 与历史只记录 [附件: 文件名]，文件内容通过 attachments 参数交给 Agent 内部处理
    const attachments = codeCurrentAttachments.map(att => ({
      name: att.name,
      path: att.path,
      isImage: att.isImage,
      extractedText: att.content || ''
    }));

    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += (displayText ? '\n' : '') + `[附件: ${names}]`;
    }

    addCodeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    clearCodeAttachments();
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#code-chat-input', value: '' });

    // Toggle stop button
    const btnSend = document.getElementById('btn-code-send');
    const btnStop = document.getElementById('btn-code-stop');
    btnSend?.classList.add('hidden');
    btnStop?.classList.remove('hidden');
    // 推送按钮状态变化到 WebUI
    if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
    if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });

    try {
      // 与 Chat 模式一致：附件作为独立参数传入，sendMessage 内部负责构造 [附件: xxx] 摘要
      await codeAgent.sendMessage(text, attachments);
    } catch (e) {
      addCodeMessage('system', `错误: ${e.message}`);
    } finally {
      btnSend?.classList.remove('hidden');
      // 仅当 Code Agent 完成 且 语音播报也完成时才隐藏停止按钮
      try { refreshCodeStopButton(); } catch (_) {}
      // 推送按钮状态恢复到 WebUI
      if (btnSend) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-send', attr: 'class', value: btnSend.className });
      if (btnStop) WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#btn-code-stop', attr: 'class', value: btnStop.className });
      // Auto-save history
      await saveCodeHistory();
    }
  }
