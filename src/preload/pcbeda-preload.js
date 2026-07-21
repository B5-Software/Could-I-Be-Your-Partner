// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA preload bridge (exposed as window.pcbAPI)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcbAPI', {
  // Settings + theme
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),

  // Dialogs
  saveProjectDialog: () => ipcRenderer.invoke('pcbeda:saveProjectDialog'),
  loadProjectDialog: () => ipcRenderer.invoke('pcbeda:loadProjectDialog'),
  exportDirDialog: (defaultName) => ipcRenderer.invoke('pcbeda:exportDirDialog', defaultName),
  saveFileDialog: (defaultName, filterName) => ipcRenderer.invoke('pcbeda:saveFileDialog', defaultName, filterName),
  importFileDialog: () => ipcRenderer.invoke('pcbeda:importFileDialog'),

  // File operations (data pulled from renderer by main via pcbGetProjectJSON etc.)
  saveProject: (path, multi) => ipcRenderer.invoke('pcbeda:saveProject', path, multi),
  loadProject: (path) => ipcRenderer.invoke('pcbeda:loadProject', path),
  exportFiles: (dir, files, zipName) => ipcRenderer.invoke('pcbeda:exportFiles', dir, files, zipName),
  writeFile: (path, content) => ipcRenderer.invoke('pcbeda:writeFile', path, content),
  writeFileBase64: (path, b64) => ipcRenderer.invoke('pcbeda:writeFileBase64', path, b64),

  // Window controls
  closeWindow: () => ipcRenderer.invoke('pcbeda:close'),
  confirmClose: (action) => ipcRenderer.invoke('pcbeda:confirmClose', action),
  minimize: () => ipcRenderer.invoke('pcbeda:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('pcbeda:maximizeToggle'),
  isMaximized: () => ipcRenderer.invoke('pcbeda:isMaximized'),
  onMaximizeChange: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('pcbeda:maximizeChanged', listener);
    return () => ipcRenderer.removeListener('pcbeda:maximizeChanged', listener);
  },
  onCloseRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('pcbeda:close-requested', listener);
    return () => ipcRenderer.removeListener('pcbeda:close-requested', listener);
  }
});
