/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createWindowSecurity } = require('../main/core/window-security');
const { createVmDesktopWindow } = require('../main/services/vm-desktop-window');
const { REQUEST_CHANNELS, EVENT_CHANNELS } = require('./vm-desktop');

function startDesktopHost({ onWindow = () => {} } = {}) {
  if (!process.send) throw new Error('The VM desktop must be opened by the TUI');
  // A companion has its own Chromium cache, and never touches the App profile.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-vm-desktop-')));
  app.setName('CIBYP VM Desktop');
  const security = createWindowSecurity({
    pagesDirectory: path.join(__dirname, '../renderer/pages'),
    pageNames: ['vm-desktop.html'],
    preloadDirectory: path.join(__dirname, '../preload/generated'),
  });
  app.on('web-contents-created', (_event, contents) => security.protectWebContents(contents));
  let win,
    nextId = 0;
  const pending = new Map();
  for (const channel of REQUEST_CHANNELS)
    ipcMain.handle(channel, (event, ...args) => {
      if (!security.validateSender(event)) throw new Error('Untrusted desktop sender');
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        process.send({ type: 'request', id, channel, args }, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    });
  process.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    } else if (message.type === 'event' && EVENT_CHANNELS.includes(message.channel)) {
      if (win && !win.isDestroyed()) win.webContents.send(message.channel, message.payload);
    } else if (message.type === 'focus') {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    } else if (message.type === 'shutdown') {
      app.quit();
    } else if (message.type === 'init' && !win) {
      try {
        await app.whenReady();
        win = createVmDesktopWindow({
          BrowserWindow,
          theme: message.theme,
          systemDark: message.systemDark,
        });
        onWindow(win);
        await win.ready;
        win.show();
        process.send({ type: 'ready' });
      } catch (error) {
        process.send({ type: 'failed', error: error.message });
        app.quit();
      }
    }
  });
  process.once('disconnect', () => app.quit());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    for (const request of pending.values()) request.reject(new Error('VM desktop window closed'));
    pending.clear();
  });
}

module.exports = { startDesktopHost };
if (require.main === module) startDesktopHost();
