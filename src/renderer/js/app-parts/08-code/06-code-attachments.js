  async function addFileToCodeContext(file) {
    const owner = codeAgent;
    const workspace = codeWorkspacePath;
    const mapped = await window.api.runtimeToVmPath(file.path);
    if (!mapped?.ok) throw new Error(mapped?.error || '无法解析附件路径');
    const path = mapped.path;
    if (codeCurrentAttachments.some(item => item.path === path)) return;
    const name = file.name || path.split(/[\\/]/).pop();
    const isImage = /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(name);
    let content = '';
    if (!isImage && /\.(txt|md|json|ya?ml|[cm]?jsx?|tsx?|py|rs|go|c|cpp|h|java|html|css|sh|sql|toml|xml|csv|log)$/i.test(name)) {
      const result = await window.api.readFile(path);
      if (!result.ok) throw new Error(result.error);
      content = String(result.content || '');
      if (content.length > 24000) content = content.slice(0, 24000) + '\n[附件内容已截取，请使用文件工具读取完整内容]';
    }
    if (owner !== codeAgent || workspace !== codeWorkspacePath) return;
    codeCurrentAttachments.push({ name, path, hostPath: file.path, isImage, content });
    renderCodeAttachments();
  }

  function removeCodeAttachment(index) {
    codeCurrentAttachments.splice(index, 1);
    renderCodeAttachments();
  }

  function clearCodeAttachments() {
    codeCurrentAttachments = [];
    renderCodeAttachments();
  }

  function renderCodeAttachments() {
    const container = document.getElementById('code-attachments-preview');
    if (!container) return;
    if (codeCurrentAttachments.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
      WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
      return;
    }
    container.classList.remove('hidden');
    container.innerHTML = codeCurrentAttachments.map((att, i) =>
      '<div class="attachment-item">' +
        '<i class="fa-solid ' + (att.isImage ? 'fa-image' : 'fa-file') + '"></i>' +
        '<span class="attachment-name">' + escapeHtml(att.name) + '</span>' +
        '<button class="btn-icon attachment-remove" data-index="' + i + '" title="从上下文移除"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>'
    ).join('');
    container.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => removeCodeAttachment(parseInt(btn.dataset.index)));
    });
    // 增量推送：附件列表更新后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#code-attachments-preview', attr: 'class', value: container.className });
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-attachments-preview', html: container.innerHTML });
  }
