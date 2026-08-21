/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('automationEditorAPI', {
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeApply: (cb) => subscribe('theme:apply', cb),
  onThemeChanged: (cb) => subscribe('theme:changed', cb),
  onOpenRequest: (cb) => subscribe('automation-editor:open-request', cb),
  closeWindow: () => ipcRenderer.invoke('automation-editor:close'),

  getTask: (id) => ipcRenderer.invoke('automation:get', id),
  saveTask: (task) => ipcRenderer.invoke('automation:save', task),
  runTask: (id, params) => ipcRenderer.invoke('automation:run', id, params),
  testTask: (task, params) => ipcRenderer.invoke('automation:test', task, params),
  getGuide: (topic) => ipcRenderer.invoke('automation:guide', topic)
});
