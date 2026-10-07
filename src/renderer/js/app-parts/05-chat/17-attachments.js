  // ---- Attachment Handling ----
  async function chooseAttachmentFiles(button, options = { multiple: true }) {
    const browser = /^https?:$/.test(location.protocol);
    const vm = (await window.api.runtime.getLocation()).location === 'vm';
    if (!browser && !vm) return window.api.openFileDialog(options);
    const local = await new Promise(resolve => {
      const menu = document.createElement('dialog'); menu.className = 'attachment-source-menu';
      const language = (agent.settings?.language || 'zh').split('-')[0];
      const labels = language === 'de' ? ['Dateien auf diesem Gerät', 'Dateien im Arbeitsbereich', 'Abbrechen'] : language === 'en' ? ['Files on this device', 'Workspace files', 'Cancel'] : ['本机文件', '工作区文件', '取消'];
      labels.forEach((label, index) => { const item = document.createElement('button'); item.textContent = label; item.className = 'btn-secondary'; item.onclick = () => { menu.close(); menu.remove(); resolve(index === 2 ? null : index === 0); }; menu.append(item); });
      menu.addEventListener('cancel', () => { menu.remove(); resolve(null); }); document.body.append(menu); menu.showModal();
      menu.addEventListener('close', () => button?.focus());
    });
    if (local === null) return { ok: false, canceled: true };
    const result = local ? await window.api.pickLocalFiles(options) : await window.api.openFileDialog(options);
    if (!result.ok && result.error) showToast(result.error, 'error');
    return result;
  }
  function addAttachment(file) {
    const isImage = file.type?.startsWith('image/') || /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(file.name);
    const att = { name: file.name, size: file.size, type: file.type, isImage, path: file.path || null, pendingSave: null };

    // If it's a blob/File without path, save to workspace
    if (file.arrayBuffer) {
      att.pendingSave = file.arrayBuffer().then(buf => {
        return window.api.saveUploadedFile(file.name, buf).then(result => {
          if (!result.ok) throw new Error(result.error || 'Attachment import failed');
          att.path = result.path;
        });
      }).catch(error => { att.error = error.message; showToast(error.message, 'error'); renderAttachments(); });
    }

    currentAttachments.push(att);
    renderAttachments();
  }

  async function copyAttachmentsToWorkspace(attachments) {
    const workspacePath = agent.workspacePath;
    if (!workspacePath || !attachments || attachments.length === 0) return;

    // 仅用于路径比较的规范化（平台无关），写入文件系统时仍用原始路径
    const norm = (p) => String(p || '').replace(/\\/g, '/');
    const normalizedWorkspace = norm(workspacePath).replace(/\/+$/, '');
    await window.api.makeDirectory(workspacePath);

    const pending = attachments.map(att => att.pendingSave).filter(Boolean);
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    for (const att of attachments) {
      if (!att.path) continue;
      if (norm(att.path).startsWith(normalizedWorkspace + '/')) continue;

      const safeName = (att.name || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
      const destPath = `${workspacePath}/${safeName}`;
      const copyResult = await window.api.copyFile(att.path, destPath);
      if (copyResult.ok) {
        att.originalPath = att.path;
        att.hostPath = destPath;
        // 运行位置=虚拟机：path 翻译为 VM 内路径（未就绪/本机模式则原样）
        att.path = (typeof window.api?.runtimeToVmPath === 'function')
          ? (await window.api.runtimeToVmPath(destPath).then(r => (r && r.ok && r.path) ? r.path : destPath).catch(() => destPath))
          : destPath;
      }
    }
  }

  function removeAttachment(index) {
    currentAttachments.splice(index, 1);
    renderAttachments();
  }

  function clearAttachments() {
    currentAttachments = [];
    renderAttachments();
  }

  function renderAttachments() {
    if (currentAttachments.length === 0) {
      attachmentsPreview.classList.add('hidden');
      attachmentsPreview.innerHTML = '';
      return;
    }
    attachmentsPreview.classList.remove('hidden');
    attachmentsPreview.innerHTML = currentAttachments.map((att, i) => `
      <div class="attachment-item" ${att.error ? 'data-failed="true"' : ''}>
        <i class="fa-solid ${att.isImage ? 'fa-image' : 'fa-file'}"></i>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        ${att.error ? `<span class="attachment-error" title="${escapeHtml(att.error)}"><i class="fa-solid fa-triangle-exclamation"></i></span>` : ''}
        <button class="btn-icon attachment-remove" data-index="${i}"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `).join('');
    attachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeAttachment(parseInt(btn.dataset.index)));
    });
  }

  // Attach file button
  if (btnAttachFile) {
    btnAttachFile.addEventListener('click', async () => {
      const result = await chooseAttachmentFiles(btnAttachFile, { multiple: true });
      if (result.ok && result.paths) {
        for (const p of result.paths) {
          const name = result.files?.find(file => file.path === p)?.name || p.split(/[\\/]/).pop();
          const isImage = /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name);
          // 运行位置=虚拟机：路径翻译为 VM 内路径（hostPath 保留宿主原路径）
          const vmPath = (typeof window.api?.runtimeToVmPath === 'function')
            ? (await window.api.runtimeToVmPath(p).then(r => (r && r.ok && r.path) ? r.path : p).catch(() => p))
            : p;
          currentAttachments.push({ name, path: vmPath, hostPath: p, isImage });
        }
        renderAttachments();
      }
    });
  }

  // WebUI 上传文件后通知渲染器刷新附件列表
  if (typeof window.api?.onWebControlFileUploaded === 'function') {
    window.api.onWebControlFileUploaded(async (data) => {
      if (data && data.path) {
        const hostPath = data.path;
        const vmPath = (typeof window.api?.runtimeToVmPath === 'function')
          ? await window.api.runtimeToVmPath(hostPath).then(r => (r && r.ok && r.path) ? r.path : hostPath).catch(() => hostPath)
          : hostPath;
        currentAttachments.push({ name: data.name, path: vmPath, hostPath, isImage: data.isImage });
        renderAttachments();
      }
    });
  }

  // Drag and drop
  chatMessages.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatMessages.classList.add('drag-over');
  });
  chatMessages.addEventListener('dragleave', () => {
    chatMessages.classList.remove('drag-over');
  });
  chatMessages.addEventListener('drop', (e) => {
    e.preventDefault();
    chatMessages.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        addAttachment(file);
      }
    }
  });

  function bindLocalFileDrop(element, attach) {
    if (!element) return;
    element.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; element.classList.add('drag-over');
    });
    element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over'); });
    element.addEventListener('drop', async event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); element.classList.remove('drag-over');
      try { await attach([...event.dataTransfer.files]); } catch (error) { showToast(error.message, 'error'); }
    });
  }
  bindLocalFileDrop(document.querySelector('.chat-input-area'), files => files.forEach(addAttachment));
  for (const selector of ['#code-chat-messages', '.code-agent-composer']) bindLocalFileDrop(document.querySelector(selector), async files => {
    const owner = codeAgent, workspace = codeWorkspacePath;
    for (const file of files) {
      const result = await window.api.saveUploadedFile(file.name, await file.arrayBuffer());
      if (!result.ok) throw new Error(result.error || 'Attachment import failed');
      if (owner !== codeAgent || workspace !== codeWorkspacePath) return;
      await addFileToCodeContext({ path: result.path, name: file.name, type: 'file' });
    }
  });
  for (const selector of ['#babe-chat-messages', '.babe-chat-input']) bindLocalFileDrop(document.querySelector(selector), async files => {
    const owner = babeAgent;
    for (const file of files) {
      const result = await window.api.saveUploadedFile(file.name, await file.arrayBuffer());
      if (!result.ok) throw new Error(result.error || 'Attachment import failed');
      if (owner !== babeAgent) return;
      babeAttachments.push({ name: file.name, path: result.path, size: file.size, type: file.type, isImage: file.type.startsWith('image/') });
    }
    renderBabeAttachments();
  });

  // Paste image
  chatInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const name = `paste-${Date.now()}.png`;
          // Save file directly
          const arrayBuffer = await file.arrayBuffer();
          const result = await window.api.saveUploadedFile(name, arrayBuffer);
          if (result.ok) {
            currentAttachments.push({ name, path: result.path, isImage: true });
            renderAttachments();
          }
        }
      }
    }
  });
