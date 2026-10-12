/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Node and Electron construct the same pure API facade from explicit transports.
 * The VM loader below is retained only for callers supplying a legacy preloadPath.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const DEFAULT_PRELOAD = path.resolve(__dirname, '../preload/preload.js');

/**
 * @param {{
 *   invoke: (channel: string, ...args: any[]) => any,
 *   send?: (channel: string, ...args: any[]) => void,
 *   on?: (channel: string, listener: (...args: any[]) => void) => void,
 *   off?: (channel: string, listener: (...args: any[]) => void) => void,
 * }} bridge  通道级桥接（invoke 走 IPC handler 注册表，on 走事件总线）
 * @param {{ preloadPath?: string }} [options]
 * @returns {Record<string, any>} 与 window.api 同形的门面
 */
function loadPreloadApi(bridge, options = {}) {
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new TypeError('loadPreloadApi: bridge.invoke is required');
  }
  if (!options.preloadPath) {
    return require('../preload/api-facade').createApiFacade({
      invoke: (channel, ...args) => bridge.invoke(channel, ...args),
      send: (channel, ...args) => bridge.send?.(channel, ...args),
      on: (channel, listener) => bridge.on?.(channel, listener),
      removeListener: (channel, listener) => bridge.off?.(channel, listener),
    }).api;
  }
  const preloadPath = options.preloadPath || DEFAULT_PRELOAD;
  const source = fs.readFileSync(preloadPath, 'utf8');

  let captured = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        if (name === 'api') captured = api;
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => bridge.invoke(channel, ...args),
      send: (channel, ...args) => (bridge.send ? bridge.send(channel, ...args) : undefined),
      on: (channel, listener) => (bridge.on ? bridge.on(channel, listener) : undefined),
      removeListener: (channel, listener) =>
        bridge.off ? bridge.off(channel, listener) : undefined,
      once: (channel, listener) => {
        if (!bridge.on) return;
        const wrapped = (...args) => {
          if (bridge.off) bridge.off(channel, wrapped);
          listener(...args);
        };
        bridge.on(channel, wrapped);
      },
      removeAllListeners: () => {},
    },
  };

  const localRequire = createRequire(preloadPath);
  const sandbox = {
    require: (request) => (request === 'electron' ? fakeElectron : localRequire(request)),
    module: { exports: {} },
    exports: {},
    // preload.js 顶层只用 window.addEventListener 卸载订阅
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    process,
    globalThis: undefined,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: preloadPath });

  if (!captured || typeof captured !== 'object') {
    throw new Error(
      `preload-api: ${preloadPath} 未通过 contextBridge.exposeInMainWorld('api', ...) 暴露门面`,
    );
  }
  return captured;
}

module.exports = { loadPreloadApi, DEFAULT_PRELOAD };
