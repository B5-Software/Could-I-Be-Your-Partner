/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const path = require('node:path');

/** The same sandboxed noVNC window in the GUI and the TUI companion process. */
function createVmDesktopWindow({ BrowserWindow, theme = {}, systemDark = true }) {
  const dark = theme.mode === 'dark' || (theme.mode !== 'light' && systemDark);
  const accent = /^#[0-9a-f]{6}$/i.test(theme.accentColor || '') ? theme.accentColor : '#4f8cff';
  const background = /^#[0-9a-f]{6}$/i.test(theme.backgroundColor || '')
    ? theme.backgroundColor
    : dark
      ? '#17181d'
      : '#f5f7fa';
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    title: 'VM Desktop | CIBYP',
    icon: path.join(__dirname, '../../../assets/icons/icon.png'),
    backgroundColor: background,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../../preload/generated/vm-desktop-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.ready = win.loadFile(path.join(__dirname, '../../renderer/pages/vm-desktop.html'), {
    query: { dark: dark ? '1' : '0', accent: accent.slice(1), bg: background.slice(1) },
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  return win;
}

module.exports = { createVmDesktopWindow };
