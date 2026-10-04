/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function systemDark({ platform = process.platform, run = execute } = {}) {
  const options = { timeout: 2000, windowsHide: true, maxBuffer: 65536 };
  try {
    if (platform === 'win32') {
      const result = await run(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
          '/v',
          'AppsUseLightTheme',
        ],
        options,
      );
      return /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/i.test(result.stdout);
    }
    if (platform === 'darwin') {
      const result = await run('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle'], options);
      return result.stdout.trim().toLowerCase() === 'dark';
    }
    if (platform === 'linux') {
      const result = await run(
        'gsettings',
        ['get', 'org.gnome.desktop.interface', 'color-scheme'],
        options,
      );
      if (/prefer-dark/.test(result.stdout)) return true;
      if (/prefer-light/.test(result.stdout)) return false;
      const gtk = await run(
        'gsettings',
        ['get', 'org.gnome.desktop.interface', 'gtk-theme'],
        options,
      );
      return /dark/i.test(gtk.stdout);
    }
  } catch {
    // No desktop preference is available (including macOS' unset light default).
  }
  return false;
}

function createNativeTheme({ detect = systemDark } = {}) {
  const nativeTheme = new EventEmitter();
  let source = 'system',
    dark = false,
    refreshing = null;
  Object.defineProperties(nativeTheme, {
    themeSource: {
      get: () => source,
      set: (value) => {
        if (!['system', 'dark', 'light'].includes(value)) throw new Error('Invalid theme source');
        if (source !== value) {
          source = value;
          nativeTheme.emit('updated');
        }
      },
    },
    shouldUseDarkColors: { get: () => source === 'dark' || (source === 'system' && dark) },
  });
  nativeTheme.shouldUseHighContrastColors = false;
  nativeTheme.getHighContrastColors = () => ({ window: '', text: '' });
  nativeTheme.refresh = () => {
    if (refreshing) return refreshing;
    refreshing = Promise.resolve()
      .then(detect)
      .then((value) => {
        const changed = dark !== Boolean(value);
        dark = Boolean(value);
        if (changed && source === 'system') nativeTheme.emit('updated');
      })
      .catch(() => {})
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  nativeTheme.ready = nativeTheme.refresh();
  const timer = setInterval(() => {
    if (nativeTheme.listenerCount('updated')) nativeTheme.refresh();
  }, 30000);
  timer.unref();
  nativeTheme.dispose = () => clearInterval(timer);
  return nativeTheme;
}
module.exports = { systemDark, createNativeTheme };
