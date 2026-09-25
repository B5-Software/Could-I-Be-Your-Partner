  // ---- Babe 模式附件功能（与 Chat 模式独立，避免冲突）----
  let babeAttachments = [];
  const babeAttachmentsPreview = document.getElementById('babe-attachments-preview');

  function renderBabeAttachments() {
    if (!babeAttachmentsPreview) return;
    if (babeAttachments.length === 0) {
      babeAttachmentsPreview.classList.add('hidden');
      babeAttachmentsPreview.innerHTML = '';
      return;
    }
    babeAttachmentsPreview.classList.remove('hidden');
    babeAttachmentsPreview.innerHTML = babeAttachments.map((att, i) => `
      <div class="attachment-item">
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    babeAttachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        babeAttachments.splice(parseInt(btn.dataset.index), 1);
        renderBabeAttachments();
      });
    });
  }

  async function copyBabeAttachmentsToWorkspace(attachments) {
    const workspacePath = babeAgent?.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;
    // 仅用于路径比较的规范化（平台无关），写入文件系统时仍用原始路径
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    const normalizedWorkspace = norm(workspacePath).replace(/\/+$/, '');
    await window.api.makeDirectory(workspacePath);
    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) await Promise.all(pending);
    for (const att of attachments) {
      if (!att.path) continue;
      if (norm(att.path).startsWith(normalizedWorkspace + '/')) continue;
      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${workspacePath}/${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) { att.originalPath = att.path; att.path = destPath; }
    }
  }

  // Babe 附件按钮
  document.getElementById('btn-babe-attach-file')?.addEventListener('click', async () => {
    const result = await window.api.openFileDialog({ multiple: true });
    if (result.ok && result.paths) {
      for (const p of result.paths) {
        const name = p.split(/[\\/]/).pop();
        const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
        babeAttachments.push({ name, path: p, isImage });
      }
      renderBabeAttachments();
    }
  });

  // Babe 输入框粘贴图片
  document.getElementById('babe-chat-input')?.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            babeAttachments.push({ name, path: result.path, isImage: true });
            renderBabeAttachments();
          }
        }
      }
    }
  });

  // 发送 Babe 消息
  async function sendBabeMessage() {
    const input = document.getElementById('babe-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && babeAttachments.length === 0) return;
    if (!babeAgent) {
      const ok = await initBabeAgent();
      if (!ok) return;
    }
    if (babeAgent.running) {
      window.showMessageModal('TA 还在回复中，请稍等...', '提示', 'warning');
      return;
    }
    if (!babeAgent.settings?.llm?.apiUrl) {
      window.showMessageModal('请先在设置中配置 LLM API', '提示', 'warning');
      return;
    }
    const babeSession = sessionManager?.getByAgent(babeAgent);
    if (babeSession && !babeAgent.running && !sessionManager.requestStart(babeSession)) {
      const queued = babeAttachments.map(att => ({
        name: att.name,
        path: att.path,
        isImage: att.isImage
      }));
      addBabeMessage('user', text);
      input.value = '';
      babeAttachments = [];
      renderBabeAttachments();
      sessionManager.queue(babeSession, { text, attachments: queued });
      addBabeMessage('system', '当前并发会话较多，本消息已排队，有空闲槽位后会自动开始。');
      return;
    }
    // 复制附件到工作区并处理（OCR/文本提取）
    const attachments = [...babeAttachments];
    babeAttachments = [];
    renderBabeAttachments();
    await copyBabeAttachmentsToWorkspace(attachments);
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
            const importResult = await window.api.knowledgeImportFile(att.path, babeAgent.workspacePath);
            if (importResult.ok && importResult.content) att.extractedText = importResult.content;
          } catch (e) { console.error('Document extraction error:', e); }
        }
      }
    }
    // 显示用户消息（含附件标记）
    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map(a => a.name).join(', ');
      displayText += `\n[附件: ${names}]`;
    }
    addBabeMessage('user', displayText);
    input.value = '';
    input.style.height = 'auto';
    // 推送输入框清空到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_value', selector: '#babe-chat-input', value: '' });
    // 发送给 Agent（带附件，复用 Agent.sendMessage 的多模态注入逻辑）
    try {
      await babeAgent.sendMessage(text, attachments);
    } catch (e) {
      addBabeMessage('system', '发送失败: ' + e.message);
    }
  }

  // Babe 历史页面
