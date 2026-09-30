/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('filePicker', {
  config: () => ipcRenderer.invoke('vmFileDialog:config'),
  browse: (directory) => ipcRenderer.invoke('vmFileDialog:browse', directory),
  mkdir: (directory) => ipcRenderer.invoke('vmFileDialog:mkdir', directory),
  choose: (file, overwrite) => ipcRenderer.invoke('vmFileDialog:choose', file, overwrite),
  cancel: () => ipcRenderer.invoke('vmFileDialog:cancel'),
});
