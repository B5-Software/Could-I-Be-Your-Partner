/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * VM 桌面窗口 preload：只暴露图形环境控制 + 日志，窄接口。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vmDesktop', {
  getStatus: () => ipcRenderer.invoke('vm:graphicsStatus'),
  start: async (opts) => {
    const r = await ipcRenderer.invoke('vm:graphicsStart', opts || {});
    if (r && !r.ok && r.detail) console.warn('[vm-desktop] 启动失败详情:', r.detail);
    return r;
  },
  stop: () => ipcRenderer.invoke('vm:graphicsStop'),
  startChromium: (opts) => ipcRenderer.invoke('vm:graphicsChromium', opts || {}),
  openExternal: (url) => ipcRenderer.invoke('vm:openExternal', url),
  onLog: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('vm:graphics-log', listener);
    return () => ipcRenderer.removeListener('vm:graphics-log', listener);
  },
  onProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('vm:graphics-progress', listener);
    return () => ipcRenderer.removeListener('vm:graphics-progress', listener);
  },
});
