  // Serialize edits so rapid color changes cannot restore an older snapshot.
  let appearanceQueue = Promise.resolve();
  function updateAppearance(change) {
    const operation = appearanceQueue.catch(() => {}).then(async () => {
      const current = await readSettings();
      const theme = { ...current.theme };
      if (typeof change === 'function') await change(theme);
      else Object.assign(theme, change);
      await saveSettings({ theme });
      ThemeManager.apply(theme);
      return theme;
    });
    appearanceQueue = operation;
    return operation;
  }

  document.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('.theme-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      await updateAppearance(async theme => {
        const oldDark = await ThemeManager.getCurrentDarkMode(theme.mode);
        const newDark = await ThemeManager.getCurrentDarkMode(mode);
        theme.mode = mode;
        if (oldDark !== newDark || ThemeManager.isBackgroundDark(theme.backgroundColor) !== newDark) {
          const scheme = ThemeManager.getRandomScheme(newDark);
          theme.accentColor = scheme.accent;
          theme.backgroundColor = scheme.bg;
          document.getElementById('setting-accent-color').value = scheme.accent;
          document.getElementById('setting-bg-color').value = scheme.bg;
        }
      });
      updateColorSchemeVisibility();
    });
  });

  for (const [id, presets, field] of [
    ['setting-accent-color', 'accent-presets', 'accentColor'],
    ['setting-bg-color', 'bg-presets', 'backgroundColor'],
  ]) {
    document.getElementById(id).addEventListener('input', e => {
      const color = e.target.value;
      updateAppearance({ [field]: color }).catch(error => console.error('Appearance:', error));
    });
    document.querySelectorAll('#' + presets + ' .color-dot').forEach(dot => {
      dot.addEventListener('click', async () => {
        document.getElementById(id).value = dot.dataset.color;
        await updateAppearance({ [field]: dot.dataset.color });
      });
    });
  }

  // 界面动效开关（主标签页切换动画）
  document.getElementById('setting-ui-animations').addEventListener('change', async (e) => {
    const s = await readSettings();
    s.animations = e.target.checked;
    document.documentElement.setAttribute('data-animations', s.animations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // 模态框动效开关（打开/关闭渐显渐隐）
  document.getElementById('setting-ui-modal-animations').addEventListener('change', async (e) => {
    const s = await readSettings();
    s.modalAnimations = e.target.checked;
    document.documentElement.setAttribute('data-modal-animations', s.modalAnimations === false ? 'off' : 'on');
    await saveSettings(s);
  });

  // Color schemes
  async function updateColorSchemeVisibility() {
    const s = await readSettings();
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
      await updateAppearance({ accentColor: accent, backgroundColor: bg });
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
