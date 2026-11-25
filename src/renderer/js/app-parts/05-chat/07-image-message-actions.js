  async function readChatImage(imageUrl) {
    const localPath = localPathFromUrl(imageUrl);
    if (localPath) {
      const result = await window.api.readFileBase64(localPath);
      if (!result?.ok || !result.data) throw new Error(result?.error || t('ui.image.unavailable', '无法读取图片'));
      imageUrl = result.data;
    }
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(t('ui.image.unavailable', '无法读取图片'));
    return response.blob();
  }

  async function copyChatImage(imageUrl) {
    try {
      const blob = await readChatImage(imageUrl);
      const png = blob.type === 'image/png' ? blob : await (async () => {
        const bitmap = await createImageBitmap(blob);
        try {
          if (bitmap.width * bitmap.height > 24000000) throw new Error(t('ui.image.tooLarge', '图片尺寸过大'));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          return new Promise((resolve, reject) => canvas.toBlob(result =>
            result ? resolve(result) : reject(new Error(t('ui.image.unavailable', '无法读取图片'))), 'image/png'));
        } finally {
          bitmap.close();
        }
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast(t('ui.image.copied', '图片已复制到剪贴板'), 'success');
    } catch (err) {
      showToast(t('ui.image.copyFailed', '复制图片失败 · {error}', { error: err.message }), 'error');
    }
  }

  async function saveChatImage(imageUrl, originalPath) {
    try {
      const sourcePath = originalPath || localPathFromUrl(imageUrl);
      const blob = sourcePath ? null : await readChatImage(imageUrl);
      const extension = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' }[blob?.type] || 'png';
      const fileName = sourcePath ? sourcePath.split(/[\\/]/).pop() : 'image.' + extension;
      const result = await window.api.saveFileDialog({
        title: t('ui.image.saveTitle', '保存图片'),
        defaultPath: fileName,
        filters: [{ name: t('ui.image.filter', '图片'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'] }]
      });
      if (!result?.ok || !result.path) {
        if (result?.error) throw new Error(result.error);
        return;
      }
      const saved = sourcePath ? await window.api.copyFile(sourcePath, result.path)
        : await window.api.filePickerWrite(result.path, await blob.arrayBuffer());
      if (!saved?.ok) throw new Error(saved?.error || t('ui.image.unavailable', '无法读取图片'));
      showToast(t('ui.image.saved', '图片已保存到 {path}', { path: result.path }), 'success');
    } catch (err) {
      showToast(t('ui.image.saveFailed', '保存图片失败 · {error}', { error: err.message }), 'error');
    }
  }

  async function openImageInFolder(pathOrUrl) {
    const p = localPathFromUrl(pathOrUrl);
    try {
      if (!p) throw new Error(t('ui.image.noPath', '这张图片没有本地路径'));
      const result = await window.api.openFileExplorer(p);
      if (result?.ok === false) throw new Error(result.error);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  /** file:// URL 或本地路径 → 本地路径（不是本地文件时返回 null） */
  function localPathFromUrl(imageUrl) {
    const s = String(imageUrl || '');
    if (/^file:\/\//i.test(s)) {
      try {
        const url = new URL(s);
        const path = decodeURIComponent(url.pathname);
        return url.hostname ? '//' + url.hostname + path : path.replace(/^\/(?=[a-z]:\/)/i, '');
      } catch { return null; }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return null;
    return s || null;
  }

  // 生成图片气泡：现代卡片 + 悬浮工具栏（预览/下载/复制/打开位置）
  function addImageMessage(imageUrl, opts = {}) {
    if (imageUrl && typeof imageUrl === 'object') { opts = imageUrl; imageUrl = opts.url; }
    if (!imageUrl) return;
    const localPath = opts.path || localPathFromUrl(imageUrl) || '';
    const msg = document.createElement('div');
    msg.className = 'message assistant image-message';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    const imgId = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    msg.innerHTML = `
      <div class="message-avatar">${avatarHTML}</div>
      <div class="message-body">
        <div class="message-content chat-image-bubble">
          <div class="chat-image-wrap">
            <img id="${imgId}" class="chat-image" src="${escapeHtml(String(imageUrl))}" data-previewable="1" data-local-path="${escapeHtml(String(localPath))}" alt="${escapeHtml(t('ui.image.generated', 'AI 生成图片'))}" loading="lazy">
            <div class="chat-image-toolbar">
              <button class="chat-image-btn" data-act="preview" title="${escapeHtml(t('ui.image.preview', '图片预览'))}"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
              <button class="chat-image-btn" data-act="download" title="${escapeHtml(t('ui.image.saveTitle', '保存图片'))}"><i class="fa-solid fa-download"></i></button>
              <button class="chat-image-btn" data-act="copy" title="${escapeHtml(t('ui.image.copy', '复制图片'))}"><i class="fa-regular fa-copy"></i></button>
              <button class="chat-image-btn" data-act="folder" title="${escapeHtml(t('ui.image.openFolder', '打开所在文件夹'))}"><i class="fa-solid fa-folder-open"></i></button>
            </div>
          </div>
          <div class="chat-image-caption"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(t('ui.image.generated', 'AI 生成图片'))}</div>
        </div>
        <div class="message-time">${time}</div>
      </div>`;

    appendChatElement(msg);

    const imgEl = msg.querySelector('.chat-image');
    const open = () => openImageModal(imageUrl, { path: localPath });
    if (imgEl) {
      imgEl.addEventListener('click', open);
      imgEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showImageContextMenu(e, imageUrl, localPath);
      });
    }
    msg.querySelectorAll('.chat-image-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'preview') open();
        else if (act === 'download') saveChatImage(imageUrl, localPath);
        else if (act === 'copy') copyChatImage(imageUrl);
        else if (act === 'folder') openImageInFolder(localPath || imageUrl);
      });
    });

    requestAnimationFrame(() => {
            scrollElementIntoView(msg);
    });
  }

  // 显示塔罗牌阵卡片
  function addTarotSpreadToChat(tarotResult) {
    const spread = tarotResult.spread;
    const cards = tarotResult.cards || [];
    if (!spread || cards.length === 0) return;
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const avatarHTML = makeFramedAvatarHTML(agent.settings?.aiPersona?.avatar, true);
    const eSource = cards[0]?.entropySource || 'CSPRNG';
    const isTRNG = eSource.startsWith('TRNG');
    const trngBadge = isTRNG ? ' <span class="trng-badge" style="font-size:9px;padding:1px 6px"><i class="fa-solid fa-satellite-dish"></i> TRNG</span>' : '';

    const cardsHtml = cards.map(c => {
      const meaning = c.isReversed ? c.meaningOfReversed : c.meaningOfUpright;
      const position = c.position?.name || '';
      const posDesc = c.position?.description || '';
      const _lang2 = (typeof i18nGetLanguage === 'function' ? i18nGetLanguage() : 'zh-CN');
      const _isZh2 = (_lang2 === 'zh-CN');
      const _cardName2 = _isZh2 ? c.name : (c.nameEn || c.name);
      const _orientation2 = c.isReversed ? (_isZh2 ? '逆位' : 'Reversed') : (_isZh2 ? '正位' : 'Upright');
      const cardId=Number(c.id??c.cardIndex);
      const picture=Number.isInteger(cardId)&&cardId>=0&&cardId<78
        ? '<div class="card-artwork"><img src="../assets/tarot/'+String(cardId).padStart(2,'0')+'.webp" alt="'+escapeHtml(_cardName2)+'" width="512" height="768" loading="lazy" decoding="async"></div>' : '';
      return '<div class="tarot-spread-card' + (c.isReversed ? ' reversed' : '') + '">' +
        '<div class="card-position">' + escapeHtml(position) + '</div>' +
        picture +
        '<div class="card-name">' + escapeHtml(_cardName2) + '</div>' +
        '<div class="card-orientation">' + _orientation2 + '</div>' +
        '<div class="card-meaning">' + escapeHtml(meaning || '') + '</div>' +
      '</div>';
    }).join('');

    msg.innerHTML =
      '<div class="message-avatar">' + avatarHTML + '</div>' +
      '<div class="message-body">' +
        '<div class="message-content">' +
          '<div style="font-weight:600;margin-bottom:4px">' + escapeHtml(spread.name) + trngBadge + '</div>' +
          '<div style="font-size:0.85em;color:var(--text-secondary);margin-bottom:4px">' + escapeHtml(spread.description || '') + '</div>' +
          '<div class="tarot-spread-display">' + cardsHtml + '</div>' +
        '</div>' +
        '<div class="message-time">' + time + '</div>' +
      '</div>';
    appendChatElement(msg);
          scrollElementIntoView(msg);
  }

  // 显示图片右键菜单
