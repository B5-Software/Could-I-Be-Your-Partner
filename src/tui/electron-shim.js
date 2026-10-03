/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Electron API shim（纯 Node 运行时用）。
 *
 * 目的：让 src/main 的服务装配（settings / LLM / 历史 / 文件 / 终端 / 网络 / …）
 * 在没有 Electron 的进程里照常启动，从而让 TUI 以纯 Node 方式运行
 * （node bin/cibyp-tui.js）。原生模块（node-pty / sherpa-onnx / sharp …）都是
 * N-API，Node 与 Electron 共用同一份编译产物，无需重建。
 *
 * 设计：permissive Proxy —— 未特判的 API 返回无害桩（函数返回桩、属性继续代理），
 * 少数有真实语义的 API 显式实现（app.getPath / ipcMain.handle / whenReady …）。
 * GUI 专属能力（BrowserWindow / dialog / Tray …）在无界面下按"不可用"降级。
 */

'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

/** 无害桩：属性/调用/构造都继续返回桩，`then` 保持非 thenable */
function permissive(name) {
  const fn = function shimStub() {
    return permissive(name + '()');
  };
  return new Proxy(fn, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then' || key === Symbol.toStringTag) return undefined;
      if (key === Symbol.toPrimitive) return () => `[shim:${name}]`;
      if (key === 'toString') return () => `[shim:${name}]`;
      if (key === Symbol.iterator) return function* () {};
      if (typeof key === 'symbol') return undefined;
      return permissive(name + '.' + String(key));
    },
    apply() {
      return permissive(name + '()');
    },
    construct() {
      return permissive(name + '.new');
    },
  });
}

function createImageStub() {
  return {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    getAspectRatio: () => 1,
    resize: () => createImageStub(),
    crop: () => createImageStub(),
    toPNG: () => Buffer.alloc(0),
    toJPEG: () => Buffer.alloc(0),
    toDataURL: () => '',
    toBitmap: () => Buffer.alloc(0),
    setTemplateImage: () => {},
    isTemplateImage: () => false,
  };
}

function createAppPaths() {
  const home = os.homedir();
  const userData = process.env.CIBYP_USER_DATA || path.join(home, '.cibyp');
  return {
    home,
    userData,
    appData: path.join(home, '.config'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    desktop: path.join(home, 'Desktop'),
    temp: os.tmpdir(),
    logs: path.join(userData, 'logs'),
    crashDumps: path.join(userData, 'crash-dumps'),
    sessionData: path.join(userData, 'session'),
  };
}

function createElectronShim() {
  const paths = createAppPaths();
  for (const dir of Object.values(paths)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 只读环境忽略 */
    }
  }

  const appEmitter = new EventEmitter();
  const app = Object.assign(appEmitter, {
    name: 'could-i-be-your-partner',
    version: (() => {
      try {
        return require('../../package.json').version;
      } catch {
        return '0.0.0';
      }
    })(),
    isPackaged: false,
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (name) => paths[name] || permissive('app.getPath(' + name + ')'),
    setPath: (name, value) => {
      paths[name] = value;
    },
    getName: () => 'could-i-be-your-partner',
    getVersion: () => app.version,
    getAppPath: () => path.resolve(__dirname, '../..'),
    getLocale: () => 'zh-CN',
    getSystemLocale: () => 'zh-CN',
    quit: () => process.exit(0),
    exit: (code) => process.exit(code || 0),
    relaunch: () => {},
    releaseSingleInstanceLock: () => true,
    requestSingleInstanceLock: () => true,
    hide: () => {},
    show: () => {},
    focus: () => {},
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {}, appendArgument: () => {} },
    dock: permissive('app.dock'),
  });

  // ipcMain：真实语义（handler 注册表是无头运行时的通道分发基础）
  const handlers = new Map();
  const ipcEmitter = new EventEmitter();
  const ipcMain = Object.assign(ipcEmitter, {
    handle(channel, handler) {
      if (handlers.has(channel))
        throw new Error('Attempted to register a second handler for ' + channel);
      handlers.set(channel, handler);
    },
    handleOnce(channel, handler) {
      handlers.set(channel, (...args) => {
        handlers.delete(channel);
        return handler(...args);
      });
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  });

  class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.id = -1;
      this.webContents = permissive('BrowserWindow.webContents');
      this.destroyed = true; // 无界面：视为不可用，调用方的 isDestroyed() 守卫会跳过推送
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    static getAllWindows() {
      return [];
    }
    static getFocusedWindow() {
      return null;
    }
    static fromId() {
      return null;
    }
    static fromWebContents() {
      return null;
    }
  }

  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showOpenDialogSync: () => [],
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showSaveDialogSync: () => undefined,
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    showMessageBoxSync: () => 0,
    showErrorBox: () => {},
  };

  const shell = {
    openPath: async () => '',
    openExternal: async () => {},
    showItemInFolder: () => {},
    beep: () => {},
    moveItemToTrash: () => true,
    writeShortcutLink: () => true,
    readShortcutLink: () => ({}),
  };

  const nativeTheme = Object.assign(new EventEmitter(), {
    shouldUseDarkColors: true,
    shouldUseHighContrastColors: false,
    themeSource: 'dark',
    getHighContrastColors: () => ({ window: '', text: '' }),
  });

  const permissiveSession = () => {
    const ses = permissive('session');
    return Object.assign(ses, {
      webRequest: {
        onBeforeSendHeaders: () => {},
        onBeforeRequest: () => {},
        onHeadersReceived: () => {},
        onCompleted: () => {},
        onErrorOccurred: () => {},
      },
      setProxy: async () => {},
      clearCache: async () => {},
      clearStorageData: async () => {},
      getCacheSize: async () => 0,
      protocol: {
        handle: () => true,
        unhandle: () => {},
        interceptFileProtocol: () => {},
        interceptStringProtocol: () => {},
      },
    });
  };

  const session = {
    defaultSession: permissiveSession(),
    fromPartition: () => permissiveSession(),
  };

  const screen = {
    getPrimaryDisplay: () => ({
      id: 1,
      label: 'shim',
      size: { width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      workAreaSize: { width: 1920, height: 1040 },
      scaleFactor: 1,
      rotation: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [screen.getPrimaryDisplay()],
    getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
    getDisplayMatching: () => screen.getPrimaryDisplay(),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  };

  class Notification extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
    }
    show() {}
    close() {}
    static isSupported() {
      return false;
    }
  }

  class Tray extends EventEmitter {
    constructor() {
      super();
    }
    setToolTip() {}
    setContextMenu() {}
    setImage() {}
    setTitle() {}
    destroy() {}
    isDestroyed() {
      return true;
    }
  }

  const Menu = {
    buildFromTemplate: (template) => ({
      items: template || [],
      popup: () => {},
    }),
    setApplicationMenu: () => {},
    getApplicationMenu: () => null,
    sendActionToFirstResponder: () => {},
  };

  const nativeImage = {
    createFromPath: () => createImageStub(),
    createFromBuffer: () => createImageStub(),
    createFromDataURL: () => createImageStub(),
    createEmpty: () => createImageStub(),
  };

  const safeStorage = {
    isEncryptionAvailable: () => false,
    isEncryptionAvailableSync: () => false,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (buffer) => String(buffer),
    setUseStrongEncryption: () => {},
  };

  const clipboard = {
    readText: () => '',
    writeText: () => {},
    readHTML: () => '',
    writeHTML: () => {},
    readImage: () => createImageStub(),
    writeImage: () => {},
    availableFormats: () => [],
    clear: () => {},
  };

  const crashReporter = {
    start: () => {},
    getLastCrashReport: () => null,
    getUploadedReports: () => [],
  };

  const globalShortcut = {
    register: () => true,
    unregister: () => {},
    unregisterAll: () => {},
    isRegistered: () => false,
  };

  const powerMonitor = Object.assign(new EventEmitter(), {
    getSystemIdleTime: () => 0,
    getSystemIdleState: () => 'active',
    isOnBatteryPower: () => false,
  });

  const protocol = {
    registerFileProtocol: () => {},
    registerHttpProtocol: () => {},
    registerStringProtocol: () => {},
    registerBufferProtocol: () => {},
    interceptFileProtocol: () => {},
    unregisterProtocol: () => {},
    isProtocolHandled: () => false,
    handle: () => true,
    unhandle: () => {},
    registerSchemesAsPrivileged: () => {},
  };

  return {
    app,
    ipcMain,
    BrowserWindow,
    WebContents: permissive('WebContents'),
    webContents: { getAllWebContents: () => [], fromId: () => null },
    dialog,
    shell,
    nativeTheme,
    session,
    screen,
    Notification,
    Tray,
    Menu,
    MenuItem: permissive('MenuItem'),
    nativeImage,
    safeStorage,
    clipboard,
    crashReporter,
    globalShortcut,
    powerMonitor,
    protocol,
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: {
      isDarkMode: () => true,
      isSwipeTrackingFromScrollEventsEnabled: () => false,
      getUserDefault: () => undefined,
      askForMediaAccess: async () => true,
      getMediaAccessStatus: () => 'granted',
    },
    contentTracing: permissive('contentTracing'),
    autoUpdater: permissive('autoUpdater'),
    net: permissive('net'),
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        if (globalThis.__cibypShimBridge) globalThis.__cibypShimBridge(name, api);
      },
    },
    MessageChannelMain: permissive('MessageChannelMain'),
    utilityProcess: permissive('utilityProcess'),
  };
}

/**
 * 安装 shim：拦截 require('electron')，让 src/main 的模块拿到桩实现。
 * 只应在纯 Node 入口调用（Electron 进程里不要用）。
 */
function installElectronShim() {
  const shim = createElectronShim();
  const Module = require('node:module');
  if (!Module.__cibypElectronShimInstalled) {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return shim;
      return originalLoad.apply(this, arguments);
    };
    Module.__cibypElectronShimInstalled = true;
    Module.__cibypElectronShim = shim;
  }
  return Module.__cibypElectronShim || shim;
}

module.exports = { createElectronShim, installElectronShim, createAppPaths };
