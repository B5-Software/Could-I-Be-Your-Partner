  // ---- 全局字体设置 ----
  const FONT_OPTIONS = {
    zh: [
      { value: 'Noto Sans SC', label: 'Noto Sans SC（思源黑体 · 无衬线）' },
      { value: 'LXGW WenKai', label: 'LXGW WenKai（霞鹜文楷 · 手写楷体）' },
      { value: 'Noto Serif SC', label: 'Noto Serif SC（思源宋体 · 衬线）' }
    ],
    en: [
      { value: 'Inter', label: 'Inter' },
      { value: 'Source Sans 3', label: 'Source Sans 3' },
      { value: 'Noto Sans', label: 'Noto Sans' }
    ],
    de: [
      { value: 'Inter', label: 'Inter' },
      { value: 'Source Sans 3', label: 'Source Sans 3' },
      { value: 'Noto Sans', label: 'Noto Sans' }
    ]
  };

  // 组装全局字体栈：拉丁字形优先 en → de，中文字形走 zh，最后回退系统栈。
  // 未配置任何字体时等于现有外观（--font-stack 的 CSS 默认值）。
  function applyFontSettings(settings) {
    const f = (settings && settings.fonts) || {};
    const systemStack = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const parts = [];
    for (const key of ['en', 'de', 'zh']) {
      const val = f[key];
      if (val && FONT_OPTIONS[key].some(o => o.value === val)) parts.push(`"${val}"`);
    }
    parts.push(systemStack);
    document.documentElement.style.setProperty('--font-stack', parts.join(', '));
  }

  function populateFontSelects(s) {
    const fonts = (s && s.fonts) || {};
    for (const key of ['zh', 'en', 'de']) {
      const sel = document.getElementById('setting-font-' + key);
      if (!sel) continue;
      sel.innerHTML = '<option value="">' + '系统默认' + '</option>'
        + FONT_OPTIONS[key].map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
      sel.value = fonts[key] || '';
    }
  }

  ['zh', 'en', 'de'].forEach(key => {
    document.getElementById('setting-font-' + key)?.addEventListener('change', async (e) => {
      const s = await window.api.getSettings();
      if (!s.fonts) s.fonts = {};
      s.fonts[key] = e.target.value || '';
      await saveSettings(s);
    });
  });

  // 启动时应用已保存的字体设置（默认即现有外观）
  try {
    const s = await window.api.getSettings();
    applyFontSettings(s);
  } catch { /* 字体设置加载失败不影响启动 */ }

  // Helper: push current theme CSS vars to web control
