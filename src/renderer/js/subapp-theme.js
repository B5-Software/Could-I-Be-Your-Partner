// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// 子应用（CAD/EDA/小游戏）共享的主题应用器 + i18n 初始化
// 自动检测 window.pcbAPI / window.cadAPI / window.gameAPI / window.sanguoshaAPI
// 在主题/语言变化时实时重新应用，无需子应用额外代码
(function () {
  'use strict';

  // 检测当前子应用的 API
  function detectAPI() {
    return window.pcbAPI || window.cadAPI || window.gameAPI || window.sanguoshaAPI || null;
  }

  // 计算亮度
  function luminance(hex) {
    if (!hex || hex.length < 7) return 1;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // 应用主题到 document（完整版，含强调色 6 变量 + 背景 4 变量）
  function applyThemeToDoc(theme, shouldUseDarkColors) {
    const doc = document.documentElement;
    if (!theme) return;
    const mode = theme.mode || 'system';
    let isDark;
    if (mode === 'dark') isDark = true;
    else if (mode === 'light') isDark = false;
    else isDark = shouldUseDarkColors !== undefined ? !!shouldUseDarkColors : true;
    doc.setAttribute('data-theme', isDark ? 'dark' : 'light');

    // 强调色（6 变量，与主窗口 ThemeManager.apply 对齐）
    const accent = theme.accentColor;
    if (accent) {
      const r = parseInt(accent.slice(1, 3), 16);
      const g = parseInt(accent.slice(3, 5), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      doc.style.setProperty('--accent', accent);
      doc.style.setProperty('--accent-light', `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`);
      doc.style.setProperty('--accent-dark', `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)})`);
      doc.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.08)`);
      doc.style.setProperty('--accent-bg-hover', `rgba(${r}, ${g}, ${b}, 0.14)`);
      doc.style.setProperty('--accent-rgb', `${r},${g},${b}`);
      // EDA 专用别名
      doc.style.setProperty('--pcb-accent', accent);
    }
    // 背景色（4 变量）
    const bg = theme.backgroundColor;
    if (bg) {
      doc.style.setProperty('--bg-primary', bg);
      const bgR = parseInt(bg.slice(1, 3), 16);
      const bgG = parseInt(bg.slice(3, 5), 16);
      const bgB = parseInt(bg.slice(5, 7), 16);
      const lum = (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255;
      const dark = lum < 0.5;
      if (dark) {
        doc.style.setProperty('--bg-secondary', `rgb(${Math.min(255, bgR + 20)}, ${Math.min(255, bgG + 20)}, ${Math.min(255, bgB + 20)})`);
        doc.style.setProperty('--bg-tertiary', `rgb(${Math.min(255, bgR + 30)}, ${Math.min(255, bgG + 30)}, ${Math.min(255, bgB + 30)})`);
        doc.style.setProperty('--bg-hover', `rgb(${Math.min(255, bgR + 40)}, ${Math.min(255, bgG + 40)}, ${Math.min(255, bgB + 40)})`);
      } else {
        doc.style.setProperty('--bg-secondary', `rgb(${Math.max(0, bgR - 10)}, ${Math.max(0, bgG - 10)}, ${Math.max(0, bgB - 10)})`);
        doc.style.setProperty('--bg-tertiary', `rgb(${Math.max(0, bgR - 20)}, ${Math.max(0, bgG - 20)}, ${Math.max(0, bgB - 20)})`);
        doc.style.setProperty('--bg-hover', `rgb(${Math.max(0, bgR - 5)}, ${Math.max(0, bgG - 5)}, ${Math.max(0, bgB - 5)})`);
      }
    }
  }

  const SubAppTheme = {
    _api: null,
    _themeApplyUnsub: null,
    _settingsUnsub: null,
    _lang: 'zh-CN',

    async init() {
      this._api = detectAPI();
      if (!this._api) { console.warn('[SubAppTheme] 未检测到子应用 API'); return; }
      // 初始读取设置并应用主题
      try {
        const settings = await this._api.getSettings();
        if (settings && settings.theme) {
          const sysDark = settings.theme.mode === 'dark' ? true : (settings.theme.mode === 'light' ? false : (await this._api.getTheme().then(t => t.shouldUseDarkColors)));
          applyThemeToDoc(settings.theme, sysDark);
        }
        // i18n 初始化
        if (typeof i18nInit === 'function') {
          this._lang = settings.language || 'zh-CN';
          i18nInit(this._lang);
          if (typeof i18nApplyToDOM === 'function') {
            i18nApplyToDOM();
            setTimeout(() => i18nApplyToDOM(), 300);
            setTimeout(() => i18nApplyToDOM(), 1000);
          }
        }
      } catch (e) { /* 使用默认主题 */ }

      // 注册实时主题变化回调
      if (this._api.onThemeApply) {
        this._themeApplyUnsub = this._api.onThemeApply((data) => {
          if (data && data.theme) applyThemeToDoc(data.theme, data.shouldUseDarkColors);
          // 通知子应用重绘（CAD/EDA 需要重绘 canvas）
          if (typeof window.onSubAppThemeChanged === 'function') window.onSubAppThemeChanged(data);
        });
      }
      if (this._api.onThemeChanged) {
        this._api.onThemeChanged((data) => {
          if (data && data.shouldUseDarkColors !== undefined) {
            this._api.getSettings().then(s => {
              if (s && s.theme) applyThemeToDoc(s.theme, data.shouldUseDarkColors);
            });
          }
        });
      }
      // 注册设置变化回调（语言切换时重新 i18n）
      if (this._api.onSettingsChanged) {
        this._settingsUnsub = this._api.onSettingsChanged((data) => {
          if (data && data.language && data.language !== this._lang) {
            this._lang = data.language;
            if (typeof i18nSetLanguage === 'function') {
              i18nSetLanguage(data.language);
              if (typeof i18nApplyToDOM === 'function') i18nApplyToDOM();
            }
          }
          if (data && data.theme) {
            this._api.getTheme().then(t => applyThemeToDoc(data.theme, t.shouldUseDarkColors));
          }
        });
      }
    }
  };

  window.SubAppTheme = SubAppTheme;
  // 自动初始化（DOMContentLoaded 或已加载时）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SubAppTheme.init());
  } else {
    SubAppTheme.init();
  }
})();
