  function makeAvatarHTML(avatarData, isAI, style) {
    const sz = style || 'width:100%;height:100%;border-radius:50%;object-fit:cover';
    if (avatarData) {
      const src = avatarData.startsWith('data:') ? avatarData : 'file://' + avatarData.replace(/\\/g, '/');
      return `<img src="${src}" style="${sz}" alt="">`;
    }
    return isAI ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>';
  }

  // ---- 头像框系统 ----
  // 缓存已加载的 SVG 内容，避免重复 IPC 调用
  const _avatarFrameCache = {}; // id -> svg content
  // 当前生效的头像框 ID（由 settings 加载时填充）
  const _avatarFrameState = { ai: null, user: null, babe: null };
  // 用于在多实例插入时为 SVG id 添加唯一后缀，避免 ID 冲突
  let _avatarFrameUid = 0;

  // 异步加载 SVG 头像框内容并缓存
  async function loadAvatarFrameSVG(id) {
    if (!id) return '';
    if (_avatarFrameCache[id]) return _avatarFrameCache[id];
    try {
      const res = await window.api.avatarFramesGet(id);
      if (res?.ok && res.content) {
        _avatarFrameCache[id] = res.content;
        return res.content;
      }
    } catch (_) {}
    return '';
  }

  // 为 SVG 内容中的 id/url(#id) 添加唯一后缀
  function _uniqueSvgIds(svg) {
    if (!svg) return '';
    const suffix = '_f' + (++_avatarFrameUid);
    return svg
      .replace(/\bid="([^"]+)"/g, (m, id) => `id="${id}${suffix}"`)
      .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${id}${suffix})`);
  }

  // 生成头像框叠加层 HTML（不含外层 div）
  function makeFrameOverlayHTML(frameId) {
    const svg = frameId ? _avatarFrameCache[frameId] : null;
    if (!svg) return '';
    return `<div class="avatar-frame-overlay">${_uniqueSvgIds(svg)}</div>`;
  }

  // 包装聊天消息中的头像 HTML（含头像框叠加层）
  function makeFramedAvatarHTML(avatarData, isAI, style) {
    const frameId = isAI ? _avatarFrameState.ai : _avatarFrameState.user;
    const inner = makeAvatarHTML(avatarData, isAI, style);
    if (!frameId) return inner;
    const svg = _avatarFrameCache[frameId];
    if (!svg) return inner;
    return `<div class="avatar-framed-wrap">${inner}${makeFrameOverlayHTML(frameId)}</div>`;
  }

  // 生成 Babe 模式头像 HTML（含头像框叠加层）
  // role: 'babe' (TA) 或 'user' (用户)；Babe 用独立配置的头像/头像框，user 复用个人资料头像/头像框
  function makeBabeFramedAvatarHTML(avatarData, role, style) {
    const frameId = role === 'babe' ? _avatarFrameState.babe : _avatarFrameState.user;
    const sz = style || 'width:100%;height:100%;border-radius:50%;object-fit:cover';
    let inner;
    if (avatarData) {
      const src = avatarData.startsWith('data:') ? avatarData : 'file://' + avatarData.replace(/\\/g, '/');
      inner = `<img src="${src}" style="${sz}" alt="">`;
    } else {
      inner = role === 'babe' ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-solid fa-user"></i>';
    }
    if (!frameId) return inner;
    const svg = _avatarFrameCache[frameId];
    if (!svg) return inner;
    return `<div class="avatar-framed-wrap">${inner}${makeFrameOverlayHTML(frameId)}</div>`;
  }

  // 加载头像框列表并渲染设置中的三个 grid（AI / User / Babe）
  async function loadAvatarFrames() {
    try {
      const res = await window.api.avatarFramesList();
      if (!res?.ok || !Array.isArray(res.frames)) return;
      const aiGrid = document.getElementById('setting-ai-avatar-frame-grid');
      const userGrid = document.getElementById('setting-user-avatar-frame-grid');
      const babeGrid = document.getElementById('setting-babe-avatar-frame-grid');
      if (!aiGrid || !userGrid) return;

      // 构建 "无头像框" 项
      const buildNoneItem = (isSelected) => {
        const div = document.createElement('div');
        div.className = 'avatar-frame-item none-item' + (isSelected ? ' selected' : '');
        div.dataset.frameId = '';
        div.title = '无头像框';
        div.innerHTML = '<div class="frame-inner"><i class="fa-solid fa-ban"></i></div>';
        return div;
      };

      // 构建头像框项
      const buildFrameItem = (frame, isSelected) => {
        const div = document.createElement('div');
        div.className = 'avatar-frame-item' + (isSelected ? ' selected' : '');
        div.dataset.frameId = frame.id;
        div.title = frame.id;
        div.innerHTML = '<div class="frame-inner"><i class="fa-solid fa-user"></i></div>';
        // 异步加载并插入 SVG 缩略图
        loadAvatarFrameSVG(frame.id).then((svg) => {
          if (svg && div.isConnected) {
            div.insertAdjacentHTML('afterbegin', `<div class="frame-thumb">${_uniqueSvgIds(svg)}</div>`);
          }
        });
        return div;
      };

      // 渲染 AI grid
      aiGrid.innerHTML = '';
      aiGrid.appendChild(buildNoneItem(!_avatarFrameState.ai));
      res.frames.forEach((f) => aiGrid.appendChild(buildFrameItem(f, _avatarFrameState.ai === f.id)));

      // 渲染 User grid
      userGrid.innerHTML = '';
      userGrid.appendChild(buildNoneItem(!_avatarFrameState.user));
      res.frames.forEach((f) => userGrid.appendChild(buildFrameItem(f, _avatarFrameState.user === f.id)));

      // 渲染 Babe grid（Babe 模式独立头像框）
      if (babeGrid) {
        babeGrid.innerHTML = '';
        babeGrid.appendChild(buildNoneItem(!_avatarFrameState.babe));
        res.frames.forEach((f) => babeGrid.appendChild(buildFrameItem(f, _avatarFrameState.babe === f.id)));
      }

      // 绑定点击事件（事件委托）
      aiGrid.onclick = async (e) => {
        const item = e.target.closest('.avatar-frame-item');
        if (!item) return;
        const frameId = item.dataset.frameId || '';
        _avatarFrameState.ai = frameId || null;
        if (frameId) await loadAvatarFrameSVG(frameId);
        // 持久化到设置
        const s = await window.api.getSettings();
        if (!s.aiPersona) s.aiPersona = {};
        s.aiPersona.avatarFrame = frameId;
        await saveSettings(s);
        // 更新选中态
        aiGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
        // 更新设置预览叠加
        updateAvatarPreviewFrame('ai');
        // 更新 Hero 显示
        updatePersonaDisplay(s.aiPersona);
      };

      userGrid.onclick = async (e) => {
        const item = e.target.closest('.avatar-frame-item');
        if (!item) return;
        const frameId = item.dataset.frameId || '';
        _avatarFrameState.user = frameId || null;
        if (frameId) await loadAvatarFrameSVG(frameId);
        const s = await window.api.getSettings();
        if (!s.userProfile) s.userProfile = {};
        s.userProfile.avatarFrame = frameId;
        await saveSettings(s);
        userGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
        updateAvatarPreviewFrame('user');
      };

      // Babe grid 点击事件（Babe 模式独立头像框，存储到 settings.babe.avatarFrame）
      if (babeGrid) {
        babeGrid.onclick = async (e) => {
          const item = e.target.closest('.avatar-frame-item');
          if (!item) return;
          const frameId = item.dataset.frameId || '';
          _avatarFrameState.babe = frameId || null;
          if (frameId) await loadAvatarFrameSVG(frameId);
          const s = await window.api.getSettings();
          if (!s.babe) s.babe = {};
          s.babe.avatarFrame = frameId;
          await saveSettings(s);
          // 同步到 babeAgent.settings
          if (babeAgent?.settings) babeAgent.settings.babe = s.babe;
          babeGrid.querySelectorAll('.avatar-frame-item').forEach((i) => i.classList.toggle('selected', i === item));
          updateAvatarPreviewFrame('babe');
          // 更新 Babe Hero 显示
          updateBabePersonaDisplay(s.babe);
        };
      }
    } catch (e) {
      console.error('loadAvatarFrames failed:', e);
    }
  }

  // 更新设置中的头像预览叠加层
  function updateAvatarPreviewFrame(role) {
    const previewId = role === 'ai' ? 'setting-ai-avatar-preview'
      : role === 'babe' ? 'setting-babe-avatar-preview'
      : 'setting-user-avatar-preview';
    const preview = document.getElementById(previewId);
    if (!preview) return;
    // 移除现有叠加层
    const existing = preview.querySelector('.avatar-frame-overlay');
    if (existing) existing.remove();
    const frameId = role === 'ai' ? _avatarFrameState.ai
      : role === 'babe' ? _avatarFrameState.babe
      : _avatarFrameState.user;
    if (frameId && _avatarFrameCache[frameId]) {
      preview.insertAdjacentHTML('beforeend', makeFrameOverlayHTML(frameId));
    }
  }

  // WebUI 镜像开关：仅当 Web 控制服务运行时才推送（避免无谓的序列化/IPC）
