/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  // Theme
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_, data) => cb(data)),

  // Window Controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Memory
  memorySearch: (q) => ipcRenderer.invoke('memory:search', q),
  memoryAdd: (item) => ipcRenderer.invoke('memory:add', item),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryUpdate: (id, data) => ipcRenderer.invoke('memory:update', { id, data }),

  // Knowledge Base
  knowledgeSearch: (q) => ipcRenderer.invoke('knowledge:search', q),
  knowledgeAdd: (item) => ipcRenderer.invoke('knowledge:add', item),
  knowledgeDelete: (id) => ipcRenderer.invoke('knowledge:delete', id),
  knowledgeUpdate: (id, data) => ipcRenderer.invoke('knowledge:update', { id, data }),
  knowledgeImportFile: (p, workspacePath) => ipcRenderer.invoke('knowledge:importFile', p, workspacePath),

  // File System
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  createFile: (p, c) => ipcRenderer.invoke('fs:createFile', p, c),
  deleteFile: (p) => ipcRenderer.invoke('fs:deleteFile', p),
  moveFile: (s, d) => ipcRenderer.invoke('fs:moveFile', s, d),
  copyFile: (s, d) => ipcRenderer.invoke('fs:copyFile', s, d),
  listDirectory: (p) => ipcRenderer.invoke('fs:listDirectory', p),
  makeDirectory: (p) => ipcRenderer.invoke('fs:makeDirectory', p),
  deleteDirectory: (p) => ipcRenderer.invoke('fs:deleteDirectory', p),
  localSearch: (dir, pattern, options) => ipcRenderer.invoke('fs:localSearch', dir, pattern, options),
  readFileBase64: (p) => ipcRenderer.invoke('fs:readFileBase64', p),
  saveUploadedFile: (name, data) => ipcRenderer.invoke('fs:saveUploadedFile', name, data),

  // Terminal
  makeTerminal: () => ipcRenderer.invoke('terminal:make'),
  runTerminalCommand: (id, cmd) => ipcRenderer.invoke('terminal:run', id, cmd),
  awaitTerminalCommand: (id, cmd) => ipcRenderer.invoke('terminal:await', id, cmd),
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),

  // Clipboard
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (t) => ipcRenderer.invoke('clipboard:write', t),

  // Screenshot
  takeScreenshot: (workspacePath) => ipcRenderer.invoke('screenshot:take', workspacePath),

  // System
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getFullSystemInfo: () => ipcRenderer.invoke('system:fullInfo'),
  getNetworkStatus: () => ipcRenderer.invoke('system:network'),

  // Shell
  openBrowser: (url) => ipcRenderer.invoke('shell:openBrowser', url),
  openFileExplorer: (p) => ipcRenderer.invoke('shell:openFileExplorer', p),

  // Code Execution
  runJS: (code) => ipcRenderer.invoke('code:runJS', code),
  runNodeJS: (code) => ipcRenderer.invoke('code:runNodeJS', code),
  runShell: (script) => ipcRenderer.invoke('code:runShell', script),

  // Image Generation
  generateImage: (prompt, workspacePath) => ipcRenderer.invoke('image:generate', prompt, workspacePath),

  // Web
  webSearch: (q, workspacePath) => ipcRenderer.invoke('web:search', q, workspacePath),
  webFetch: (url) => ipcRenderer.invoke('web:fetch', url),

  // Tarot
  drawTarot: () => ipcRenderer.invoke('tarot:draw'),

  // TRNG
  trngListPorts: () => ipcRenderer.invoke('trng:listPorts'),
  trngTest: () => ipcRenderer.invoke('trng:test'),

  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  createSkill: (s) => ipcRenderer.invoke('skills:create', s),
  deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),
  updateSkill: (id, data) => ipcRenderer.invoke('skills:update', id, data),

  // LLM
  chatLLM: (messages, options) => ipcRenderer.invoke('llm:chat', messages, options),
  chatLLMStream: (messages, options) => ipcRenderer.invoke('llm:chatStream', messages, options),
  onStreamChunk: (cb) => ipcRenderer.on('llm:stream-chunk', (_, data) => cb(data)),
  onStreamEnd: (cb) => ipcRenderer.on('llm:stream-end', (_, data) => cb(data)),

  // Paths
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),

  // Dialog
  confirmSensitive: (msg) => ipcRenderer.invoke('dialog:confirm', msg),
  openFileDialog: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),

  // Chat History
  historyList: () => ipcRenderer.invoke('history:list'),
  historyGet: (id) => ipcRenderer.invoke('history:get', id),
  historySave: (conv) => ipcRenderer.invoke('history:save', conv),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyRename: (id, title) => ipcRenderer.invoke('history:rename', id, title),

  // Workspace
  workspaceCreate: () => ipcRenderer.invoke('workspace:create'),
  workspaceGetBase: () => ipcRenderer.invoke('workspace:getBase'),
  workspaceOpenInExplorer: (p) => ipcRenderer.invoke('workspace:openInExplorer', p),
  workspaceGetFileTree: (p) => ipcRenderer.invoke('workspace:getFileTree', p),

  // GeoGebra
  geogebraInit: () => ipcRenderer.invoke('geogebra:init'),
  geogebraEvalCommand: (cmd) => ipcRenderer.invoke('geogebra:evalCommand', cmd),
  geogebraGetAllObjects: () => ipcRenderer.invoke('geogebra:getAllObjects'),
  geogebraDeleteObject: (name) => ipcRenderer.invoke('geogebra:deleteObject', name),
  geogebraExportPNG: (workspacePath) => ipcRenderer.invoke('geogebra:exportPNG', workspacePath),

  // OCR
  ocrRecognize: (imagePath) => ipcRenderer.invoke('ocr:recognize', imagePath),

  // Download
  downloadFile: (url, filename, workspacePath) => ipcRenderer.invoke('file:download', url, filename, workspacePath),
  
  // Firmware
  firmwareExport: () => ipcRenderer.invoke('firmware:export'),
  
  // Dialog Events (for in-app modals)
  onShowConfirmDialog: (cb) => ipcRenderer.on('show-confirm-dialog', (_, data) => cb(data)),
  sendConfirmDialogResponse: (response) => ipcRenderer.send('confirm-dialog-response', response),
  // File picker dialog uses system dialog now
});
