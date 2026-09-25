  let webControlMirrorEnabled = false;
  async function refreshWebControlMirrorEnabled() {
    try {
      const st = await window.api.webControlGetStatus();
      webControlMirrorEnabled = !!(st && st.running);
    } catch {
      webControlMirrorEnabled = false;
    }
    return webControlMirrorEnabled;
  }
  // 头像路径 → 小尺寸 data URL（远程浏览器无法读取宿主 file://）
  async function mirrorAvatarData(value) {
    if (!value) return '';
    if (value.startsWith('data:') || value.startsWith('http')) return value;
    try {
      const enc = await window.api.avatarEncodeFile(value);
      return enc && enc.ok ? enc.dataUrl : '';
    } catch { return ''; }
  }
  async function pushAvatarsToWeb() {
    if (!webControlMirrorEnabled) return;
    const s = await window.api.getSettings();
    window.api.webControlSetAvatars({
      ai: await mirrorAvatarData(s.aiPersona?.avatar || ''),
      user: await mirrorAvatarData(s.userProfile?.avatar || ''),
    });
  }

  // Intercept ThemeManager.apply so every theme change is auto-pushed
  const _origApply = ThemeManager.apply.bind(ThemeManager);
  ThemeManager.apply = function(theme) {
    _origApply(theme);
    // Defer slightly to allow applyThemeMode (which sets data-theme) to settle
    setTimeout(pushThemeToWebControl, 50);
    // Monaco 主题跟随
    setTimeout(() => {
      if (monacoEditor) {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
      }
    }, 50);
  };
  // Push initial theme (ThemeManager.init already ran with the original apply)
  setTimeout(pushThemeToWebControl, 200);
  setTimeout(pushAvatarsToWeb, 250);

  // Sync app version from package metadata (main process)
