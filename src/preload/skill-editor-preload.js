/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('skillEditorAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeApply: (cb) => subscribe('theme:apply', cb),
  onThemeChanged: (cb) => subscribe('theme:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  onOpenRequest: (cb) => subscribe('skill-editor:open-request', cb),

  closeWindow: () => ipcRenderer.invoke('skill-editor:close'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (id) => ipcRenderer.invoke('skill-editor:getSkill', id),
  createSkill: (skill) => ipcRenderer.invoke('skills:create', skill),
  updateSkill: (id, data) => ipcRenderer.invoke('skills:update', id, data),
  deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),

  runJS: (code) => ipcRenderer.invoke('code:runJS', code),
  runNodeJS: (code) => ipcRenderer.invoke('code:runNodeJS', code),
  runShell: (script) => ipcRenderer.invoke('code:runShell', script),
  runPython: (code) => ipcRenderer.invoke('code:runPython', code),

  readFile: (p, encoding) => ipcRenderer.invoke('fs:readFile', p, encoding),
  writeFile: (p, content, opts) => ipcRenderer.invoke('fs:writeFile', p, content, opts),
  listDirectory: (p) => ipcRenderer.invoke('fs:listDirectory', p),
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  confirmSensitive: (message) => ipcRenderer.invoke('dialog:confirm', message)
});
