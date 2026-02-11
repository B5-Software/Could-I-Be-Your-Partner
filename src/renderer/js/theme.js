/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

// Theme Manager
const ThemeManager = {
  // 浅色系配色方案
  lightSchemes: [
    { accent: '#4f8cff', bg: '#f5f7fa', name: '清新蓝' },
    { accent: '#00b894', bg: '#f0fff4', name: '自然绿' },
    { accent: '#0984e3', bg: '#f0f5ff', name: '海洋' },
    { accent: '#e17055', bg: '#fff5f5', name: '珊瑚' },
    { accent: '#00cec9', bg: '#f0fffe', name: '青碧' },
    { accent: '#6c5ce7', bg: '#f4f1ff', name: '紫雾' },
    { accent: '#fd79a8', bg: '#fff0f6', name: '粉黛' },
    { accent: '#e84393', bg: '#fff0f8', name: '玫瑰' },
    { accent: '#2d98da', bg: '#f1f8ff', name: '浅海' },
    { accent: '#20bf6b', bg: '#f1fff7', name: '薄荷' },
    { accent: '#f7b731', bg: '#fff9e6', name: '柔金' },
    { accent: '#eb3b5a', bg: '#fff1f2', name: '石榴' },
    { accent: '#0fb9b1', bg: '#f0fffc', name: '湖光' },
    { accent: '#3867d6', bg: '#f0f5ff', name: '蔚蓝' },
    { accent: '#8854d0', bg: '#f6f0ff', name: '薰衣' },
    { accent: '#fa8231', bg: '#fff3e6', name: '暖橙' },
    { accent: '#26de81', bg: '#effff5', name: '清绿' },
    { accent: '#45aaf2', bg: '#eef7ff', name: '晴空' },
    { accent: '#a55eea', bg: '#f7f0ff', name: '淡紫' },
    { accent: '#2bcbba', bg: '#eefdfc', name: '薄荷冰' },
    { accent: '#fed330', bg: '#fffbe6', name: '柠檬' },
    { accent: '#fd9644', bg: '#fff2e6', name: '杏橙' },
    { accent: '#4b7bec', bg: '#edf2ff', name: '清澈蓝' },
    { accent: '#fc5c65', bg: '#fff0f1', name: '樱红' },
    { accent: '#2ecc71', bg: '#f2fff7', name: '嫩绿' },
    { accent: '#9b59b6', bg: '#f9f1ff', name: '紫晶' },
    { accent: '#16a085', bg: '#eefdf8', name: '青松' },
    { accent: '#e67e22', bg: '#fff3e9', name: '焦糖' },
    { accent: '#e74c3c', bg: '#fff0ed', name: '赤霞' },
    { accent: '#1abc9c', bg: '#f0fffb', name: '海风' },
    { accent: '#34495e', bg: '#f4f6f8', name: '冷灰' }
  ],
  
  // 深色系配色方案
  darkSchemes: [
    { accent: '#e84393', bg: '#16213e', name: '暗夜玫瑰' },
    { accent: '#00cec9', bg: '#0f1c1c', name: '深湖' },
    { accent: '#6c5ce7', bg: '#1b1433', name: '深紫' },
    { accent: '#fd79a8', bg: '#2a0f1f', name: '莓夜' },
    { accent: '#0984e3', bg: '#0b1b2e', name: '深海蓝' },
    { accent: '#00b894', bg: '#0f2621', name: '松夜' },
    { accent: '#f7b731', bg: '#2a2312', name: '暗金' },
    { accent: '#eb3b5a', bg: '#2a1015', name: '赤夜' },
    { accent: '#2d98da', bg: '#101b24', name: '夜航' },
    { accent: '#20bf6b', bg: '#0f2419', name: '深林' },
    { accent: '#fa8231', bg: '#2b1a0b', name: '暖夜' },
    { accent: '#8854d0', bg: '#1a1230', name: '夜紫' },
    { accent: '#a55eea', bg: '#1d0f2e', name: '夜绯' },
    { accent: '#3867d6', bg: '#0f1626', name: '深蓝' },
    { accent: '#2bcbba', bg: '#0f1c1a', name: '墨青' },
    { accent: '#fed330', bg: '#2a2212', name: '深柠' },
    { accent: '#fd9644', bg: '#2b1c12', name: '炉火' },
    { accent: '#4b7bec', bg: '#121a2b', name: '午夜蓝' },
    { accent: '#fc5c65', bg: '#2b1315', name: '暗樱' },
    { accent: '#1abc9c', bg: '#0f1f1c', name: '深绿松' },
    { accent: '#2ecc71', bg: '#0f2015', name: '翠夜' },
    { accent: '#9b59b6', bg: '#1b1026', name: '夜晶' },
    { accent: '#16a085', bg: '#0d1f1b', name: '深松' },
    { accent: '#e67e22', bg: '#2b1b10', name: '暗橙' },
    { accent: '#e74c3c', bg: '#2a1210', name: '暗红' },
    { accent: '#34495e', bg: '#11161c', name: '夜石' },
    { accent: '#7f8c8d', bg: '#151a1b', name: '深灰' },
    { accent: '#f39c12', bg: '#2a1f0f', name: '琥珀夜' },
    { accent: '#c0392b', bg: '#220d0a', name: '绯红夜' },
    { accent: '#2980b9', bg: '#0d1720', name: '极夜蓝' },
    { accent: '#27ae60', bg: '#0c1b12', name: '深绿' },
    { accent: '#8e44ad', bg: '#170f24', name: '夜紫罗' }
  ],

  async init() {
    const settings = await window.api.getSettings();
    
    // 首次启动检测：如果配色是默认值，随机应用一套配色
    const isFirstRun = settings.theme.accentColor === '#4f8cff' && settings.theme.backgroundColor === '#f5f7fa';
    if (isFirstRun) {
      const isDark = await this.getCurrentDarkMode(settings.theme.mode);
      const scheme = this.getRandomScheme(isDark);
      settings.theme.accentColor = scheme.accent;
      settings.theme.backgroundColor = scheme.bg;
      await window.api.setSettings(settings);
    }
    
    this.apply(settings.theme);
    window.api.onThemeChanged(({ shouldUseDarkColors }) => {
      window.api.getSettings().then(s => {
        if (s.theme.mode === 'system') {
          this.applyThemeMode(shouldUseDarkColors ? 'dark' : 'light');
        }
      });
    });
  },

  async getCurrentDarkMode(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    const { shouldUseDarkColors } = await window.api.getTheme();
    return shouldUseDarkColors;
  },

  isBackgroundDark(bgColor) {
    const r = parseInt(bgColor.slice(1, 3), 16);
    const g = parseInt(bgColor.slice(3, 5), 16);
    const b = parseInt(bgColor.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5;
  },

  getRandomScheme(isDark) {
    const schemes = isDark ? this.darkSchemes : this.lightSchemes;
    return schemes[Math.floor(Math.random() * schemes.length)];
  },

  applyThemeMode(mode) {
    document.documentElement.setAttribute('data-theme', mode);
  },

  apply(theme) {
    const { mode, accentColor, backgroundColor } = theme;
    
    // Set theme mode
    if (mode === 'system') {
      window.api.getTheme().then(({ shouldUseDarkColors }) => {
        this.applyThemeMode(shouldUseDarkColors ? 'dark' : 'light');
      });
    } else {
      this.applyThemeMode(mode);
    }
    
    // Set custom accent color
    if (accentColor) {
      const r = parseInt(accentColor.slice(1, 3), 16);
      const g = parseInt(accentColor.slice(3, 5), 16);
      const b = parseInt(accentColor.slice(5, 7), 16);
      
      document.documentElement.style.setProperty('--accent', accentColor);
      document.documentElement.style.setProperty('--accent-light', `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`);
      document.documentElement.style.setProperty('--accent-dark', `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)})`);
      document.documentElement.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.08)`);
      document.documentElement.style.setProperty('--accent-bg-hover', `rgba(${r}, ${g}, ${b}, 0.14)`);
      document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
    }
    
    // Set custom background color
    if (backgroundColor) {
      document.documentElement.style.setProperty('--bg-primary', backgroundColor);
      
      // Compute secondary and tertiary backgrounds based on primary
      const bgR = parseInt(backgroundColor.slice(1, 3), 16);
      const bgG = parseInt(backgroundColor.slice(3, 5), 16);
      const bgB = parseInt(backgroundColor.slice(5, 7), 16);
      
      // Determine if background is light or dark
      const luminance = (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255;
      const isDark = luminance < 0.5;
      
      if (isDark) {
        // Dark background: lighten for secondary/tertiary
        document.documentElement.style.setProperty('--bg-secondary', `rgb(${Math.min(255, bgR + 20)}, ${Math.min(255, bgG + 20)}, ${Math.min(255, bgB + 20)})`);
        document.documentElement.style.setProperty('--bg-tertiary', `rgb(${Math.min(255, bgR + 30)}, ${Math.min(255, bgG + 30)}, ${Math.min(255, bgB + 30)})`);
        document.documentElement.style.setProperty('--bg-hover', `rgb(${Math.min(255, bgR + 40)}, ${Math.min(255, bgG + 40)}, ${Math.min(255, bgB + 40)})`);
      } else {
        // Light background: darken for secondary/tertiary
        document.documentElement.style.setProperty('--bg-secondary', `rgb(${Math.max(0, bgR - 10)}, ${Math.max(0, bgG - 10)}, ${Math.max(0, bgB - 10)})`);
        document.documentElement.style.setProperty('--bg-tertiary', `rgb(${Math.max(0, bgR - 20)}, ${Math.max(0, bgG - 20)}, ${Math.max(0, bgB - 20)})`);
        document.documentElement.style.setProperty('--bg-hover', `rgb(${Math.max(0, bgR - 5)}, ${Math.max(0, bgG - 5)}, ${Math.max(0, bgB - 5)})`);
      }
    }
  }
};
