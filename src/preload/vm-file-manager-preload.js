/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { createChannelSubscriptions } = require('./channel-subscriptions');
const { subscribe } = createChannelSubscriptions(ipcRenderer);
contextBridge.exposeInMainWorld('vmFiles', {
  initial: () => ipcRenderer.invoke('vm-files:initial'),
  list: (side, path) => ipcRenderer.invoke('vm-files:list', { side, path }),
  mkdir: (side, path, name) => ipcRenderer.invoke('vm-files:mkdir', { side, path, name }),
  transfer: options => ipcRenderer.invoke('vm-files:transfer', options),
  cancel: () => ipcRenderer.invoke('vm-files:cancel'),
  window: action => ipcRenderer.invoke('vm-files:window', { action }),
  onProgress: callback => subscribe('vm-files:progress', callback),
  onTheme: callback => subscribe('theme:apply', callback),
  onSettings: callback => subscribe('settings:changed', callback),
});
