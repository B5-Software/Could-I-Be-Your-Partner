  async function _avatarMirrorData(value) {
    if (!value) return '';
    if (value.startsWith('data:') || value.startsWith('http')) return value;
    try {
      const enc = await window.api.avatarEncodeFile(value);
      return enc && enc.ok ? enc.dataUrl : '';
    } catch { return ''; }
  }

  function updateAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-ai-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('ai');
  }

  function updateUserAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-user-avatar-preview');
    if (!preview) return;
    preview.innerHTML = makeAvatarHTML(avatarData, false, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    updateAvatarPreviewFrame('user');
  }

  function updateBabeAvatarPreview(avatarData) {
    const preview = document.getElementById('setting-babe-avatar-preview');
    if (!preview) return;
    // Babe 默认头像：无图时使用心形图标
    if (avatarData) {
      preview.innerHTML = makeAvatarHTML(avatarData, true, 'width:100%;height:100%;border-radius:50%;object-fit:cover');
    } else {
      preview.innerHTML = '<i class="fa-solid fa-heart"></i>';
    }
    updateAvatarPreviewFrame('babe');
  }
