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
