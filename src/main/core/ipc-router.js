/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/** A private IPC facade, so routing never replaces Electron's global methods. */
function createIpcRouter(
  nativeIpc,
  { validateSender, routeHandler = (_channel, handler) => handler },
) {
  const originalHandlers = new Map();
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
      handleDirect(channel, routeHandler(channel, handler));
      originalHandlers.set(channel, handler);
    },
    removeHandler: (channel) => nativeIpc.removeHandler(channel),
    on: (channel, handler) => listen(channel, handler, false),
    once: (channel, handler) => listen(channel, handler, true),
    removeListener,
    off: removeListener,
  };
  return router;
}

module.exports = { createIpcRouter };
