  function updateBabePersonaDisplay(babeOverride) {
    const babe = babeOverride || babeAgent?.settings?.babe;
    if (!babe) return;
    const nameEl = document.getElementById('babe-name-display');
    if (nameEl) nameEl.textContent = babe.name || 'Babe';
    // 增量推送：Babe 名称更新同步到 WebUI
    if (nameEl) WebUIMirror.pushDomEvent({ type: 'dom_text', selector: '#babe-name-display', text: babe.name || 'Babe' });
    // Hero 头像（含头像框叠加层）
    const avatarEl = document.getElementById('babe-avatar');
    if (avatarEl) {
      const frameId = _avatarFrameState.babe;
      const hasFrame = !!(frameId && _avatarFrameCache[frameId]);
      // 有头像框时不设置 inline 尺寸，让 CSS .has-frame > img 控制
      const avatarSize = hasFrame
        ? 'border-radius:50%;object-fit:cover'
        : 'width:100%;height:100%;border-radius:50%;object-fit:cover';
      // 使用 makeAvatarHTML（直接子元素 img/i），与 AI Hero 头像结构一致
      // Babe 无头像时使用心形图标作为默认
      let inner;
      if (babe.avatar) {
        inner = makeAvatarHTML(babe.avatar, true, avatarSize);
      } else {
        inner = '<i class="fa-solid fa-heart" style="' + avatarSize + '"></i>';
      }
      avatarEl.innerHTML = inner;
      if (hasFrame) {
        avatarEl.classList.add('has-frame');
        avatarEl.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
      } else {
        avatarEl.classList.remove('has-frame');
      }
      // 增量推送：Babe Hero 头像更新同步到 WebUI
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#babe-avatar', html: avatarEl.innerHTML, attr: 'class', value: avatarEl.className });
    }
  }
