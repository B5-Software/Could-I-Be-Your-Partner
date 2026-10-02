/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/**
 * 无头运行时的 IPC 分发桥：把「window.api 方法调用」映射回主进程自己的 IPC handler。
 *
 * 配合 src/agent/preload-api.js 使用：preload 门面里的 ipcRenderer.invoke(channel, ...)
 * 落到这里的 invoke()，再经 ipcMain 路由器的 invokeLocal() 走完整流水线
 * （VM 工具路由 / 编辑器拦截 / 具体 handler）。
 *
 * 事件订阅（onXxx API）落到事件总线；send 语义落到 ipcMain.on 监听器（emitLocal）。
 */

/**
 * 本地发起调用用的合成 IPC 事件：handler 里用到 event.sender 的地方
 * （计数、销毁回调、回推进度）在这里给出无窗口但行为完整的替身。
 */
function createLocalIpcEvent({ publishEvent } = {}) {
  const sender = {
    id: -1,
    isDestroyed: () => false,
    isFrameDestroyed: () => false,
    getURL: () => 'file:///',
    once: () => sender,
    on: () => sender,
    removeListener: () => sender,
    // 进度回推等场景：没有窗口时改道事件总线，订阅者照常收到
    send: (channel, payload) => {
      if (typeof publishEvent === 'function') publishEvent(channel, payload);
    },
  };
  return {
    sender,
    senderFrame: { url: 'file:///', frameId: -1 },
    frameId: -1,
    reply: () => {},
  };
}

/**
 * @param {{
 *   ipcMain: { invokeLocal: Function, emitLocal: Function },
 *   publishEvent: (channel: string, payload: any) => void,
 *   subscribe: (channel: string, fn: (payload: any) => void) => () => void,
 * }} deps
 */
function createIpcDispatch({ ipcMain, publishEvent, subscribe }) {
  if (!ipcMain || typeof ipcMain.invokeLocal !== 'function') {
    throw new TypeError('createIpcDispatch: ipcMain.invokeLocal is required');
  }

  function makeEvent() {
    return createLocalIpcEvent({ publishEvent });
  }

  // ipcRenderer.on 的监听器签名是 (event, ...args)；事件总线按 (payload) 派发，
  // 这里补上合成事件并保持监听器身份，供 removeListener 精确卸载。
  const subscriptions = new Map(); // listener -> { wrapped, dispose }

  return {
    /** 与 ipcRenderer.invoke 同形：返回 handler 的结果（含 Promise）。 */
    invoke(channel, ...args) {
      return Promise.resolve(ipcMain.invokeLocal(channel, makeEvent(), ...args));
    },
    /** 与 ipcRenderer.send 同形：fire-and-forget，落到 ipcMain.on 监听器。 */
    send(channel, ...args) {
      try {
        return ipcMain.emitLocal(channel, makeEvent(), ...args);
      } catch (error) {
        console.warn(`[ipc-dispatch] send ${channel} failed:`, error.message);
        return false;
      }
    },
    /** 与 ipcRenderer.on 同形：事件订阅（返回卸载函数）。 */
    on(channel, listener) {
      const wrapped = (payload) => listener(makeEvent(), payload);
      const dispose = subscribe(channel, wrapped);
      const entry = { wrapped, dispose };
      subscriptions.set(listener, entry);
      return dispose;
    },
    off(channel, listener) {
      const entry = subscriptions.get(listener);
      if (!entry) return;
      entry.dispose();
      subscriptions.delete(listener);
    },
  };
}

module.exports = { createIpcDispatch, createLocalIpcEvent };
