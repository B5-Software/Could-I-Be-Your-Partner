  const imagePreviewState = { scale: 1, fitScale: 1, tx: 0, ty: 0, fit: true, src: '', path: '' };
  let _imagePreviewBound = false;

  function _applyImageTransform() {
    const frame = document.getElementById('image-modal-frame');
    const label = document.getElementById('btn-img-zoom-reset');
    if (frame) frame.style.transform = `translate(${imagePreviewState.tx}px, ${imagePreviewState.ty}px) scale(${imagePreviewState.scale})`;
    if (label) label.textContent = Math.round(imagePreviewState.scale * 100) + '%';
  }

  function _fitImage() {
    const img = document.getElementById('image-preview-img');
    const viewport = document.getElementById('image-modal-viewport');
    if (!img || !viewport || !img.naturalWidth) return;
    const sx = (viewport.clientWidth - 40) / img.naturalWidth;
    const sy = (viewport.clientHeight - 40) / img.naturalHeight;
    imagePreviewState.fitScale = Math.max(0.05, Math.min(1, sx, sy));
    imagePreviewState.scale = imagePreviewState.fitScale;
    imagePreviewState.fit = true;
    imagePreviewState.tx = 0;
    imagePreviewState.ty = 0;
    _applyImageTransform();
  }

  function _actualSize() {
    imagePreviewState.scale = 1;
    imagePreviewState.fit = false;
    imagePreviewState.tx = 0;
    imagePreviewState.ty = 0;
    _applyImageTransform();
  }

  function _zoomTo(next, cx, cy) {
    const clamped = Math.max(0.05, Math.min(8, next));
    const viewport = document.getElementById('image-modal-viewport');
    if (viewport && cx != null && cy != null) {
      const rect = viewport.getBoundingClientRect();
      const px = cx - rect.left - rect.width / 2;
      const py = cy - rect.top - rect.height / 2;
      const k = clamped / imagePreviewState.scale;
      imagePreviewState.tx = px - (px - imagePreviewState.tx) * k;
      imagePreviewState.ty = py - (py - imagePreviewState.ty) * k;
    }
    imagePreviewState.scale = clamped;
    imagePreviewState.fit = false;
    _applyImageTransform();
  }

  function _bindImagePreviewOnce() {
    if (_imagePreviewBound) return;
    _imagePreviewBound = true;
    const viewport = document.getElementById('image-modal-viewport');
    document.getElementById('btn-img-zoom-in')?.addEventListener('click', () => _zoomTo(imagePreviewState.scale * 1.25));
    document.getElementById('btn-img-zoom-out')?.addEventListener('click', () => _zoomTo(imagePreviewState.scale / 1.25));
    document.getElementById('btn-img-zoom-reset')?.addEventListener('click', () => {
      if (imagePreviewState.fit) _actualSize(); else _fitImage();
    });
    document.getElementById('btn-img-download')?.addEventListener('click', () => { if (imagePreviewState.src) saveChatImage(imagePreviewState.src); });
    document.getElementById('btn-img-copy')?.addEventListener('click', () => { if (imagePreviewState.src) copyChatImage(imagePreviewState.src); });
    document.getElementById('btn-img-folder')?.addEventListener('click', () => openImageInFolder(imagePreviewState.path || imagePreviewState.src));
    // 滚轮缩放（以光标为锚点）
    viewport?.addEventListener('wheel', (e) => {
      e.preventDefault();
      _zoomTo(imagePreviewState.scale * (e.deltaY < 0 ? 1.12 : 0.9), e.clientX, e.clientY);
    }, { passive: false });
    // 拖拽平移
    let dragging = null;
    viewport?.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY, tx: imagePreviewState.tx, ty: imagePreviewState.ty };
      viewport.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      imagePreviewState.tx = dragging.tx + (e.clientX - dragging.x);
      imagePreviewState.ty = dragging.ty + (e.clientY - dragging.y);
      imagePreviewState.fit = false;
      _applyImageTransform();
    });
    window.addEventListener('mouseup', () => { dragging = null; viewport?.classList.remove('dragging'); });
    // 双击切换 适应窗口 / 100%
    document.getElementById('image-preview-img')?.addEventListener('dblclick', () => {
      if (imagePreviewState.fit) _actualSize(); else _fitImage();
    });
    // 键盘：Esc 关闭，+/- 缩放，0 适应窗口
    window.addEventListener('keydown', (e) => {
      if (imagePreviewModal.classList.contains('hidden')) return;
      if (e.key === 'Escape') fadeOutHide(imagePreviewModal);
      else if (e.key === '+' || e.key === '=') _zoomTo(imagePreviewState.scale * 1.25);
      else if (e.key === '-') _zoomTo(imagePreviewState.scale / 1.25);
      else if (e.key === '0') _fitImage();
      else if (e.key === '1') _actualSize();
    });
    window.addEventListener('resize', () => { if (!imagePreviewModal.classList.contains('hidden') && imagePreviewState.fit) _fitImage(); });
  }

  function openImageModal(src, opts = {}) {
    const img = document.getElementById('image-preview-img');
    const title = document.getElementById('image-preview-title');
    imagePreviewState.src = src;
    imagePreviewState.path = opts.path || localPathFromUrl(src) || '';
    if (img) { img.src = src; img.alt = '预览'; }
    if (title) {
      const name = imagePreviewState.path ? imagePreviewState.path.split(/[\\/]/).pop() : '';
      title.textContent = name ? `图片预览 · ${name}` : '图片预览';
    }
    _bindImagePreviewOnce();
    imagePreviewModal.classList.remove('hidden');
    const onload = () => _fitImage();
    if (img) { if (img.complete && img.naturalWidth) onload(); else img.onload = onload; }
  }

  function addToolCallToChat(displayName, toolName, args, callId) {
    // runSubAgent 工具调用不在此显示卡片 — 子代理有独立的卡片和详情模态框
    // 避免 args 中过长的任务描述和 result 撑爆聊天页面
    if (toolName === 'runSubAgent') return;

    const el = document.createElement('div');
    el.className = 'tool-call';
    el.id = `tool-${toolName}-${Date.now()}`;
    el.dataset.toolName = toolName;
    if (callId) el.dataset.toolCallId = callId;
    // 截断 args：字符串值限制 200 字符，对象 JSON 限制 500 字符
    const argsStr = Object.entries(args || {})
      .map(([k, v]) => {
        if (typeof v === 'string') return `${k}: ${v.substring(0, 200)}${v.length > 200 ? '…(已截断)' : ''}`;
        const json = JSON.stringify(v);
        return `${k}: ${json.length > 500 ? json.substring(0, 500) + '…(已截断)' : json}`;
      })
      .join('\n');
    el.innerHTML = `
      <div class="tool-call-header">
        <i class="fa-solid fa-gear fa-spin"></i>
        <span>调用工具: ${escapeHtml(displayName)}</span>
        <span class="trng-badge" style="display:none"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>
      </div>
      ${argsStr ? `<div class="tool-call-args">${escapeHtml(argsStr)}</div>` : ''}
      <div class="tool-call-result" style="display:none"></div>`;
    appendChatElement(el);
    // Ensure complete scroll to bottom
    scrollElementIntoView(el);
  }

  function updateToolCallResult(toolName, result, isError = false, callId = null) {
    let el = null;
    if (callId) {
      // 同一轮多个同名工具调用时，必须按 callId 精确匹配，
      // 否则多个结果会全部覆盖到最后一个卡片上。
      el = chatMessages.querySelector(`[data-tool-call-id="${cssEscape(callId)}"]`);
    }
    if (!el) {
      const els = chatMessages.querySelectorAll(`[data-tool-name="${toolName}"]`);
      el = els[els.length - 1];
    }
    if (!el) return;
    const header = el.querySelector('.tool-call-header i');
    const isFailure = isError || result?.ok === false;
    if (header) { header.className = `fa-solid ${isFailure ? 'fa-xmark' : 'fa-check'}`; }
    // Show TRNG badge if applicable
    if (result?.entropySource && result.entropySource.startsWith('TRNG')) {
      const badge = el.querySelector('.trng-badge');
      if (badge) badge.style.display = 'inline-flex';
    }
    const resultEl = el.querySelector('.tool-call-result');
    if (resultEl) {
      resultEl.style.display = 'block';
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      resultEl.textContent = text.substring(0, 500);
      if (isFailure) resultEl.classList.add('error');
    }
    // 增量推送：更新工具调用卡片的完整 outerHTML
    if (el.id) {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + el.id, html: el.outerHTML });
    }
  }
