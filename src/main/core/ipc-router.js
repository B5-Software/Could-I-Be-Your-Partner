/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/** A private IPC facade, so routing never replaces Electron's global methods. */
function createIpcRouter(
  nativeIpc,
  { validateSender, routeHandler = (_channel, handler) => handler },
) {
  const originalHandlers = new Map();
  const routedHandlers = new Map();
  const listeners = new Map();
  function handleDirect(channel, handler) {
    nativeIpc.handle(channel, (event, ...args) => {
      if (!validateSender(event)) throw new Error(`Untrusted IPC sender: ${channel}`);
      return handler(event, ...args);
    });
  }
  function listen(channel, handler, once) {
    const wrapped = (event, ...args) => {
      if (!validateSender(event)) return;
      if (once) removeListener(channel, handler);
      handler(event, ...args);
    };
    if (!listeners.has(channel)) listeners.set(channel, new Map());
    listeners.get(channel).set(handler, wrapped);
    nativeIpc.on(channel, wrapped);
    return router;
  }
  function removeListener(channel, handler) {
    const entries = listeners.get(channel);
    const wrapped = entries?.get(handler);
    if (wrapped) nativeIpc.removeListener(channel, wrapped);
    entries?.delete(handler);
    if (entries?.size === 0) listeners.delete(channel);
    return router;
  }
  const router = {
    originalHandlers,
    handleDirect,
    handle(channel, handler) {
      const routed = routeHandler(channel, handler);
      handleDirect(channel, routed);
      originalHandlers.set(channel, handler);
      routedHandlers.set(channel, routed);
    },
    removeHandler: (channel) => {
      routedHandlers.delete(channel);
      return nativeIpc.removeHandler(channel);
    },
    /**
     * 本地直调：与 IPC 进来的调用走同一条流水线（VM 路由 / 编辑器拦截），
     * 但不经过发件人校验（无头运行时与测试自己发起的调用）。
     */
    invokeLocal(channel, event, ...args) {
      const handler = routedHandlers.get(channel);
      if (!handler) throw new Error(`No IPC handler registered for channel: ${channel}`);
      return handler(event, ...args);
    },
    /** 本地广播到 ipcMain.on 监听器（无头运行时发起的 send 语义）。 */
    emitLocal(channel, event, ...args) {
      const entries = listeners.get(channel);
      if (!entries || entries.size === 0) return false;
      for (const [handler] of [...entries]) handler(event, ...args);
      return true;
    },
    on: (channel, handler) => listen(channel, handler, false),
    once: (channel, handler) => listen(channel, handler, true),
    removeListener,
    off: removeListener,
  };
  return router;
}

module.exports = { createIpcRouter };
