  // ---- 文件呈递卡片（游戏邀请风格） ----
  function addFilePresentCard(data) {
    if (!data) return;
    const cardId = 'file-present-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const el = document.createElement('div');
    el.className = 'file-present-card';
    el.id = cardId;
    const sizeStr = data.size > 1024 * 1024
      ? (data.size / 1024 / 1024).toFixed(1) + ' MB'
      : data.size > 1024
        ? (data.size / 1024).toFixed(1) + ' KB'
        : data.size + ' B';
    const ext = (data.filename || '').split('.').pop().toUpperCase();
    const iconClass = _getFileIcon(data.filename);
    el.innerHTML = `
      <div class="file-present-header">
        <i class="fa-solid ${iconClass} file-present-icon"></i>
        <div class="file-present-info">
          <span class="file-present-badge">${ext}</span>
          <span class="file-present-title">${escapeHtml(data.title || data.filename || '文件')}</span>
        </div>
      </div>
      ${data.description ? `<div class="file-present-desc">${escapeHtml(data.description)}</div>` : ''}
      <div class="file-present-meta">
        <span><i class="fa-solid fa-file"></i> ${escapeHtml(data.filename || '')}</span>
        <span><i class="fa-solid fa-database"></i> ${sizeStr}</span>
      </div>
      <button class="file-present-download-btn" data-file-path="${escapeHtml(data.fullPath || '')}" data-filename="${escapeHtml(data.filename || 'download')}">
        <i class="fa-solid fa-download"></i> 下载文件
      </button>`;
    // 根据当前模式追加到对应容器
    const container = currentMode === 'code' ? document.getElementById('code-chat-messages')
      : currentMode === 'babe' ? document.getElementById('babe-chat-messages')
      : chatMessages;
    if (!container) return;
    // 移除欢迎消息
    const welcome = container.querySelector('.welcome-message');
    if (welcome) welcome.remove();
    container.appendChild(el);
      scrollElementIntoView(el);
    // 绑定下载按钮点击
    const dlBtn = el.querySelector('.file-present-download-btn');
    if (dlBtn) {
      dlBtn.addEventListener('click', function() {
        handleFileDownload(this.dataset.filePath, this.dataset.filename);
      });
    }
    // 推送到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_append', container: getChatContainerSelector(), html: el.outerHTML });
  }

  function _getFileIcon(filename) {
    if (!filename) return 'fa-file';
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      js: 'fa-file-code', ts: 'fa-file-code', jsx: 'fa-file-code', tsx: 'fa-file-code',
      py: 'fa-file-code', java: 'fa-file-code', c: 'fa-file-code', cpp: 'fa-file-code',
      html: 'fa-file-code', css: 'fa-file-code', json: 'fa-file-code',
      md: 'fa-file-lines', txt: 'fa-file-lines', pdf: 'fa-file-pdf',
      doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel',
      ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint',
      png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', gif: 'fa-file-image', svg: 'fa-file-image',
      zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper',
      mp3: 'fa-file-audio', wav: 'fa-file-audio', mp4: 'fa-file-video', avi: 'fa-file-video',
    };
    return map[ext] || 'fa-file';
  }

  // 文件下载处理：App 直接下载，Remote 请求远端，WebUI 回传 blob
  function handleFileDownload(filePath, filename) {
    if (!filePath) return;
    // Remote 模式：文件在远端，发送请求让远端回传文件数据
    if (isRemoteMode && remoteWs && remoteWs.readyState === 1) {
      remoteWsSend({ type: 'requestFileDownload', path: filePath, filename: filename });
      return;
    }
    // 本地模式 / WebUI 点击转发：读取文件并下载
    window.api.readFileBase64(filePath).then(function(result) {
      if (!result.ok) { console.error('[FileDownload] 读取失败:', result.error); return; }
      // result.data 格式为 data URL: "data:mime;base64,xxxx"
      var dataUrl = result.data || '';
      var base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
      var mimeType = result.mime || 'application/octet-stream';
      // 如果是 WebUI 转发的点击（_applyingRemote 为 true），通过 WS 回传文件数据
      if (WebUIMirror._applyingRemote) {
        try {
          window.api.webControlMirrorUpdate({ type: 'file_download', filename: filename, data: base64, mimeType: mimeType });
        } catch (e) { console.error('[FileDownload] WebUI 回传失败:', e); }
        return;
      }
      // 本地 Electron：直接 blob 下载
      _triggerBlobDownload(base64, filename, mimeType);
    });
  }

  function _triggerBlobDownload(base64Data, filename, mimeType) {
    var binary = atob(base64Data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 子代理全屏宽度卡片：标题 + 状态 + 用时 + token + 工具调用次数，点击展开完整对话
