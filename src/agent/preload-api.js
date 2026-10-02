/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 从 src/preload/preload.js 派生 Node 侧的能力门面（与渲染进程 window.api 完全同形）。
 *
 * preload.js 是 window.api 的唯一定义处（含参数整形，如 memoryUpdate(id, data) →
 * invoke('memory:update', { id, data })）。无头运行时需要同一份调用面，于是这里在
 * 沙箱里加载 preload.js：把 `electron` 换成 stub，把 `ipcRenderer.invoke/send/on`
 * 指到调用方提供的 bridge，再捕获 `contextBridge.exposeInMainWorld('api', facade)`
 * 暴露出来的门面对象。这样参数整形与新增 API 自动保持一致，无需维护第二份映射表。
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
