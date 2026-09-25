  async function copyChatImage(imageUrl) {
    try {
      // file:// 无法直接用 fetch；本地路径优先走主进程读取 base64
      let blob;
      const localPath = localPathFromUrl(imageUrl);
      if (localPath && window.api?.readFileBase64) {
        const r = await window.api.readFileBase64(localPath);
        if (r?.ok && r.dataUrl) blob = await (await fetch(r.dataUrl)).blob();
      }
      if (!blob) blob = await (await fetch(imageUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      addSystemMessage('图片已复制到剪贴板');
    } catch (err) {
      addSystemMessage(`复制失败: ${err.message}`);
    }
  }

  async function saveChatImage(imageUrl) {
    try {
      const sourcePath = localPathFromUrl(imageUrl);
      if (!sourcePath) throw new Error('无法解析本地图片路径');
      const fileName = sourcePath.split(/[\\/]/).pop() || 'image.png';
      const result = await window.api.saveFileDialog({
        title: '保存图片',
        defaultPath: fileName,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }]
      });
      if (result.ok && result.path) {
        await window.api.copyFile(sourcePath, result.path);
        addSystemMessage(`图片已保存到: ${result.path}`);
      }
    } catch (err) {
      addSystemMessage(`保存失败: ${err.message}`);
    }
  }

  function openImageInFolder(pathOrUrl) {
    const p = localPathFromUrl(pathOrUrl);
    if (!p) return addSystemMessage('无法解析本地图片路径');
    try { window.api.openFileExplorer(p); } catch (_) {}
  }

  /** file:// URL 或本地路径 → 本地路径（不是本地文件时返回 null） */
  function localPathFromUrl(imageUrl) {
    const s = String(imageUrl || '');
    if (/^file:\/\//i.test(s)) {
      try { return decodeURIComponent(s.replace(/^file:\/\/\/?/i, '').replace(/^([a-zA-Z]:)/, '$1')); }
      catch (_) { return s.replace(/^file:\/\/\/?/i, ''); }
    }
    if (/^data:|^https?:/i.test(s)) return null;
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
            <img id="${imgId}" class="chat-image" src="${String(imageUrl).replace(/"/g, '&quot;')}" data-previewable="1" data-local-path="${String(localPath).replace(/"/g, '&quot;')}" alt="AI 生成的图片" loading="lazy">
            <div class="chat-image-toolbar">
              <button class="chat-image-btn" data-act="preview" title="预览"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
              <button class="chat-image-btn" data-act="download" title="下载"><i class="fa-solid fa-download"></i></button>
              <button class="chat-image-btn" data-act="copy" title="复制"><i class="fa-regular fa-copy"></i></button>
              <button class="chat-image-btn" data-act="folder" title="打开所在文件夹"><i class="fa-solid fa-folder-open"></i></button>
            </div>
          </div>
          <div class="chat-image-caption"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成图片</div>
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
        showImageContextMenu(e, imageUrl);
      });
    }
    msg.querySelectorAll('.chat-image-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'preview') open();
        else if (act === 'download') saveChatImage(imageUrl);
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
      return '<div class="tarot-spread-card' + (c.isReversed ? ' reversed' : '') + '">' +
        '<div class="card-position">' + escapeHtml(position) + '</div>' +
        '<div class="card-icon"><i class="fa-solid ' + (c.icon || 'fa-star') + '"></i></div>' +
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
