  // ---- Send Message ----
  async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text && currentAttachments.length === 0) return;

    // Remote 模式：转发到远程 WS，不在本地执行 Agent
    if (isRemoteMode && remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      const attachments = [...currentAttachments];
      clearAttachments();
      chatInput.value = '';
      chatInput.style.height = 'auto';

      // 上传附件到远端，构建带附件路径的消息（与 WebUI 协议一致）
      let fullMsg = text;
      if (attachments.length > 0) {
        const uploadedPaths = [];
        for (const att of attachments) {
          const up = await uploadAttachmentRemote(att);
          if (up) uploadedPaths.push(`附件: ${up.path} (${up.name})`);
          else fullMsg += `\n[附件上传失败: ${att.name}]`;
        }
        if (uploadedPaths.length > 0) {
          fullMsg = (text ? text + '\n' : '') + uploadedPaths.join('\n');
        }
      }

      if (fullMsg) addMessageToChat('user', fullMsg);
      addThinkingIndicator();
      remoteWs.send(JSON.stringify({ type: 'sendMessage', message: fullMsg }));
      return;
    }

    // 热对话：Agent工作中时注入新消息
    if (agent.running) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
      WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

      // Process attachments
      const attachments = [...currentAttachments];
      clearAttachments();

      let displayText = text;
      if (attachments.length > 0) {
        const names = attachments.map(a => a.name).join(', ');
        displayText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', displayText);

      await copyAttachmentsToWorkspace(attachments);

      // Process attachments: OCR for images, text extraction for documents
      for (const att of attachments) {
        if (att.isImage && att.path) {
          try {
            const ocrResult = await window.api.ocrRecognize(att.path);
            if (ocrResult.ok && ocrResult.text) att.ocrText = ocrResult.text;
          } catch (e) { console.error('OCR error:', e); }
        } else if (att.path) {
          const ext = att.name.split('.').pop().toLowerCase();
          const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
          if (officeFormats.includes(ext)) {
            try {
              const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
              if (importResult.ok && importResult.content) {
                const workspacePath = agent.workspacePath;
                if (workspacePath) {
                  const textFileName = att.name.replace(/\.\w+$/, '.txt');
                  const textFilePath = `${workspacePath}\\${textFileName}`;
                  const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                  if (saveResult.ok) {
                    att.convertedPath = textFilePath;
                    att.extractedText = `已转换为文本文件：${textFilePath}`;
                  } else {
                    att.extractedText = importResult.content;
                  }
                } else {
                  att.extractedText = importResult.content;
                }
                if (importResult.images && importResult.images.length > 0) {
                  att.extractedImages = importResult.images;
                }
              }
            } catch (e) { console.error('Document extraction error:', e); }
          }
        }
      }

      agent.injectHotMessage(text, attachments);
      return;
    }

    const chatSession = sessionManager?.getByAgent(agent);
    if (chatSession && !agent.running && !sessionManager.requestStart(chatSession)) {
      const queuedAttachments = [...currentAttachments];
      clearAttachments();
      let queuedText = text;
      if (queuedAttachments.length > 0) {
        const names = queuedAttachments.map(a => a.name).join(', ');
        queuedText += `\n[附件: ${names}]`;
      }
      addMessageToChat('user', queuedText);
      sessionManager.queue(chatSession, { text, attachments: queuedAttachments });
      addSystemMessage('当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。', { persist: false });
      return;
    }

    // 正常发送（Agent空闲时）

    // Show stop button immediately
    setSendButtons(true);

    // Check daily limits before sending
    const settings = await window.api.getSettings();
    const llmLimit = settings.llm.dailyMaxTokens || 0;
    const llmUsed = settings.llm.dailyTokensUsed || 0;
    if (llmLimit > 0) {
      if (llmUsed >= llmLimit) {
        addSystemMessage(`⚠️ 已达到今日LLM Token上限(${llmLimit})，请明天再试或在设置中重置使用量。`);
        setSendButtons(false);
        return;
      } else if (llmUsed >= llmLimit * 0.9) {
        addSystemMessage(`⚠️ 警告：今日Token已使用${llmUsed}，接近限制${llmLimit}(${((llmUsed/llmLimit)*100).toFixed(1)}%)`);
      }
    }

    chatInput.value = '';
    chatInput.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#chat-input', value: '' });

    // Process attachments
    const attachments = [...currentAttachments];
    clearAttachments();

    // Show message with attachment indicators
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addMessageToChat('user', displayText);
    addThinkingIndicator();
    window.api.webControlPushMessage('user', displayText);

    await copyAttachmentsToWorkspace(attachments);

    // Process attachments: OCR for images, text extraction for documents
    for (const att of attachments) {
      if (att.isImage && att.path) {
        // OCR for images
        try {
          const ocrResult = await window.api.ocrRecognize(att.path);
          if (ocrResult.ok && ocrResult.text) {
            att.ocrText = ocrResult.text;
          }
        } catch (e) { console.error('OCR error:', e); }
      } else if (att.path) {
        // Extract text from Office/PDF files
        const ext = att.name.split('.').pop().toLowerCase();
        const officeFormats = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'pdf', 'odt', 'ods', 'odp'];
        if (officeFormats.includes(ext)) {
          try {
            const importResult = await window.api.knowledgeImportFile(att.path, agent.workspacePath);
            if (importResult.ok && importResult.content) {
              // 将转换后的文本保存到工作目录
              const workspacePath = agent.workspacePath;
              if (workspacePath) {
                const textFileName = att.name.replace(/\.\w+$/, '.txt');
                const textFilePath = `${workspacePath}\\${textFileName}`;
                const saveResult = await window.api.writeFile(textFilePath, importResult.content);
                if (saveResult.ok) {
                  att.convertedPath = textFilePath;
                  att.extractedText = `已转换为文本文件：${textFilePath}`;
                } else {
                  att.extractedText = importResult.content;
                }
              } else {
                att.extractedText = importResult.content;
              }
              // 如果有图片，也提取出来
              if (importResult.images && importResult.images.length > 0) {
                att.extractedImages = importResult.images;
              }
            }
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }

    try {
      await agent.sendMessage(text, attachments);
    } finally {
      removeThinkingIndicator();
    }
  }
