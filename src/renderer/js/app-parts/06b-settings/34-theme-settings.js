  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const s = await window.api.getSettings();
      const oldMode = s.theme.mode;
      s.theme.mode = btn.dataset.mode;

      // 检测是否切换了深浅色模式
      const oldDark = await ThemeManager.getCurrentDarkMode(oldMode);
      const newDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
      const currentBgDark = ThemeManager.isBackgroundDark(s.theme.backgroundColor);

      // 如果深浅色模式改变，或者当前配色与目标模式不符，随机应用目标色系的配色
      if (oldDark !== newDark || currentBgDark !== newDark) {
        const scheme = ThemeManager.getRandomScheme(newDark);
        s.theme.accentColor = scheme.accent;
        s.theme.backgroundColor = scheme.bg;
        document.getElementById('setting-accent-color').value = scheme.accent;
        document.getElementById('setting-bg-color').value = scheme.bg;
      }

      await saveSettings(s);
      ThemeManager.apply(s.theme);
      updateColorSchemeVisibility();
    });
  });

  // Accent color
  document.getElementById('setting-accent-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.accentColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#accent-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-accent-color').value = color;
      const s = await window.api.getSettings();
      s.theme.accentColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Background color
  document.getElementById('setting-bg-color').addEventListener('input', async (e) => {
    const s = await window.api.getSettings();
    s.theme.backgroundColor = e.target.value;
    await saveSettings(s);
    ThemeManager.apply(s.theme);
  });

  document.querySelectorAll('#bg-presets .color-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const color = dot.dataset.color;
      document.getElementById('setting-bg-color').value = color;
      const s = await window.api.getSettings();
      s.theme.backgroundColor = color;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // 界面动效开关（主标签页切换动画）
  document.getElementById('setting-ui-animations').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.animations = e.target.checked;
    document.documentElement.setAttribute('data-animations', s.animations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // 模态框动效开关（打开/关闭渐显渐隐）
  document.getElementById('setting-ui-modal-animations').addEventListener('change', async (e) => {
    const s = await window.api.getSettings();
    s.modalAnimations = e.target.checked;
    document.documentElement.setAttribute('data-modal-animations', s.modalAnimations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // Color schemes
  async function updateColorSchemeVisibility() {
    const s = await window.api.getSettings();
    const isDark = await ThemeManager.getCurrentDarkMode(s.theme.mode);
    document.querySelectorAll('.scheme-btn').forEach(btn => {
      const bgColor = btn.dataset.bg;
      const btnIsDark = ThemeManager.isBackgroundDark(bgColor);
      // 只显示当前深浅色系的配色
      if (btnIsDark === isDark) {
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    });
  }

  document.querySelectorAll('.scheme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const accent = btn.dataset.accent;
      const bg = btn.dataset.bg;
      document.getElementById('setting-accent-color').value = accent;
      document.getElementById('setting-bg-color').value = bg;
      const s = await window.api.getSettings();
      s.theme.accentColor = accent;
      s.theme.backgroundColor = bg;
      await saveSettings(s);
      ThemeManager.apply(s.theme);
    });
  });

  // Password toggle
  document.querySelectorAll('.btn-toggle-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target.type === 'password') {
        target.type = 'text';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
      } else {
        target.type = 'password';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
      }
    });
  });

  // Auto-approve toggle
