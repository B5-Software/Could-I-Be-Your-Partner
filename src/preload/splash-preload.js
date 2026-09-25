/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Splash 专用 preload：只暴露"虚拟机启动进度 + 紧急回退"这一条通路。
 * 刻意不暴露主应用 API —— Splash 的职责只有等待与回退，越窄越安全。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['vm:init', 'vm:state', 'vm:progress', 'vm:serial', 'vm:boot-begin', 'vm:boot-ready', 'vm:boot-failed', 'vm:error'];

contextBridge.exposeInMainWorld('vmSplash', {
  /** 订阅 VM 启动相关事件；返回取消订阅函数 */
  onEvent: (cb) => {
    const listeners = CHANNELS.map((ch) => {
      const fn = (_e, data) => cb({ channel: ch, data });
      ipcRenderer.on(ch, fn);
      return [ch, fn];
    });
    return () => listeners.forEach(([ch, fn]) => ipcRenderer.removeListener(ch, fn));
  },
  /** 紧急切回本机（本次运行生效） */
  emergencyHostMode: () => ipcRenderer.invoke('vm:emergencyHostMode'),
  /** 读取当前运行位置与 VM 状态 */
  getRuntime: () => ipcRenderer.invoke('runtime:getLocation'),
});
