/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * AgentHost —— Agent 内核与前端运行时之间的边界。
 *
 * Agent 内核（src/renderer/js/agent.js 等）只依赖本文件描述的能力，不再直接触碰
 * `window.api` 或任何 `window.*` 全局单例。这样同一份内核可以跑在：
 *   - 渲染进程（GUI 桌面前端）        → createRendererHost()
 *   - 主进程无头运行（--headless）    → createHeadlessHost()
 *   - 测试沙箱                        → createHeadlessHost({ api: stub })
 *
 * host 形状：
 *   {
 *     kind: 'renderer' | 'headless',
 *     api,      // 与 preload 暴露的 window.api 完全同形的能力门面（工具/LLM/存储/订阅）
 *     gui,      // 仅图形界面可用的能力（画布/表格/游戏/语音/标题/待办/会话装饰）
 *     events,   // on(type, handler) / emit(type, detail)  与 AppEventBus 同契约
 *     env,      // { isHeadless, platform, sessionKey }
 *     notify()  // 向宿主发送通知（toast / 标题 / 状态），headless 下可被 WebUI 订阅
 *   }
 */

'use strict';

const GUI_UNAVAILABLE =
  '该功能仅在桌面图形界面（Electron 窗口）中可用；当前为无头/WebUI 运行环境，无法执行此操作。';

/** 与 src/renderer/js/session-manager.js 的 SessionStatus 保持一致（勿单侧修改）。 */
const SESSION_STATUS = Object.freeze({
  IDLE: 'idle',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  WAITING_TOOL_AUTH: 'waiting_tool_auth',
  DONE: 'done',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
  STOPPED: 'stopped',
  CRASHED: 'crashed',
});

/** 与 AppEventBus 同契约（handler 收到 { type, detail }）。Node 19+ 自带 EventTarget。 */
class HostEventBus extends EventTarget {
  on(type, handler) {
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * 待办存储适配器：与 src/renderer/core/todo-store.ts 的 TodoStore 同形
 * （todoItems / todoIdCounter / handleTodo），但为纯 JS，供无头运行时使用。
 */
function createTodoStore(api, changed = () => {}) {
  const state = { revision: -1, counter: 0, items: [] };
  const accept = (next) => {
    if (!next || next.revision <= state.revision) return;
    state.revision = next.revision;
    state.counter = next.counter;
    state.items = next.items;
    changed();
  };
  if (api && typeof api.onTodoState === 'function') api.onTodoState(accept);
  return {
    get todoItems() {
      return state.items;
    },
    set todoItems(items) {
      state.items = Array.isArray(items) ? items : [];
    },
    get todoIdCounter() {
      return state.counter;
    },
    set todoIdCounter(counter) {
      state.counter = Number(counter) || 0;
    },
    async load() {
      if (!api || typeof api.todoGet !== 'function') return;
      accept(await api.todoGet());
    },
    async handleTodo(args = {}) {
      if (!api || typeof api.todoMutate !== 'function') {
        return { ok: false, error: GUI_UNAVAILABLE };
      }
      const result = await api.todoMutate(args);
      if (result && result.state) accept(result.state);
      return result;
    },
  };
}

/** 无头环境的会话装饰层：不存在会话面板时保持“无过滤/无状态更新”的空实现。 */
function createHeadlessSessions() {
  return {
    getByAgent: () => null,
    getActive: () => null,
    setStatus: () => {},
    setAttention: () => {},
  };
}

function unavailable(feature) {
  return () => ({ ok: false, error: `${feature}：${GUI_UNAVAILABLE}` });
}

/** 无头 GUI 能力：画布/表格/游戏等在无界面环境下优雅失败（与既有兜底返回值同形）。 */
function createHeadlessGui({ todos = null, titleUtils = null, onInteractive = null } = {}) {
  const guiUnavailable = (feature) => unavailable(feature)();
  return {
    todos,
    sessions: createHeadlessSessions(),
    sessionStatus: SESSION_STATUS,
    toast: () => {},
    voice: null,
    titleUtils,
    downloads: null,
    askQuestions: async (questions) => {
      if (typeof onInteractive === 'function') {
        return onInteractive('askQuestions', { questions });
      }
      return { ok: false, error: `askQuestions：${GUI_UNAVAILABLE}` };
    },
    showGameInvitation: async () => ({ accepted: false, agentCount: 0, error: GUI_UNAVAILABLE }),
    canvas: {
      init: () => guiUnavailable('initCanvas'),
      clear: () => guiUnavailable('clearCanvas'),
      add: () => guiUnavailable('addCanvasObject'),
      update: () => guiUnavailable('updateCanvasObject'),
      remove: () => guiUnavailable('deleteCanvasObject'),
      exportSVG: () => guiUnavailable('exportCanvasSVG'),
    },
    spreadsheet: {
      init: () => guiUnavailable('initSpreadsheet'),
      setCells: () => guiUnavailable('spreadsheetSetCells'),
      getCells: () => guiUnavailable('spreadsheetGetCells'),
      setCellFormat: () => guiUnavailable('spreadsheetSetCellFormat'),
      setRangeFormat: () => guiUnavailable('spreadsheetSetRangeFormat'),
      clearCells: () => guiUnavailable('spreadsheetClearCells'),
      insertRows: () => guiUnavailable('spreadsheetInsertRows'),
      deleteRows: () => guiUnavailable('spreadsheetDeleteRows'),
      insertCols: () => guiUnavailable('spreadsheetInsertCols'),
      deleteCols: () => guiUnavailable('spreadsheetDeleteCols'),
      sortRange: () => guiUnavailable('spreadsheetSortRange'),
      getData: () => guiUnavailable('spreadsheetGetData'),
      exportCSV: () => guiUnavailable('spreadsheetExportCSV'),
      importCSV: () => guiUnavailable('spreadsheetImportCSV'),
      importFile: () => guiUnavailable('spreadsheetImportFile'),
      exportFile: () => guiUnavailable('spreadsheetExportFile'),
    },
  };
}

/**
 * 能力门面的惰性转发代理：把对 `getSource()` 的方法调用原样转发（含 this 绑定），
 * 嵌套对象（api.runtime / api.vm / api.aria2）递归包装；底层没有的成员返回 undefined，
 * 从而保持改造前 `typeof window.api?.onX === 'function'` 的判断语义。
 */
function wrapFacade(getSource) {
  const nested = new Map();
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        const source = getSource();
        if (!source) return undefined;
        const value = source[name];
        if (typeof value === 'function') return (...args) => value.apply(source, args);
        if (value && typeof value === 'object') {
          if (!nested.has(name)) {
            nested.set(
              name,
              wrapFacade(() => {
                const live = getSource();
                return live ? live[name] : undefined;
              }),
            );
          }
          return nested.get(name);
        }
        return value;
      },
      has: (_target, name) => {
        const source = getSource();
        return Boolean(source && name in source);
      },
      ownKeys: () => {
        const source = getSource();
        return source ? Reflect.ownKeys(source) : [];
      },
      getOwnPropertyDescriptor: (_target, name) => {
        const source = getSource();
        if (!source || !(name in source)) return undefined;
        return { configurable: true, enumerable: true, value: source[name] };
      },
    },
  );
}

/**
 * 渲染进程（GUI）宿主：能力按需从 `window` 动态取值，因此 preload 与各 app-part
 * 在任意时机安装的 API / 单例都能被正确看到（与改造前 `window.X` 的语义一致）。
 */
function createRendererHost(options = {}) {
  const root = options.root || (typeof window !== 'undefined' ? window : globalThis);
  const bus = options.events || new HostEventBus();
  const listeners = new Set();

  // api 门面：转发到 root.api（window.api），保持 `typeof x?.onY === 'function'` 语义
  // ——底层方法不存在时返回 undefined 而不是一个恒真的包装函数。嵌套门面
  // （api.runtime / api.vm / api.aria2）同样按需转发，行为与直接访问 window.api 一致。
  const api = wrapFacade(() => root.api);

  return {
    kind: 'renderer',
    api,
    events: bus,
    env: {
      get isHeadless() {
        return false;
      },
      platform: typeof process !== 'undefined' ? process.platform : 'browser',
    },
    notify(type, payload) {
      for (const listener of [...listeners]) {
        try {
          listener(type, payload);
        } catch {
          /* 宿主通知失败不影响内核 */
        }
      }
    },
    onNotify(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    gui: {
      get todos() {
        return root.CibypTodos || null;
      },
      get sessions() {
        return root.__sessionManager || createHeadlessSessions();
      },
      sessionStatus: SESSION_STATUS,
      toast(msg, type, ms) {
        if (typeof root.showToast === 'function') root.showToast(msg, type, ms);
      },
      get voice() {
        return root.VoiceUI || null;
      },
      get titleUtils() {
        return root.CIBYPTitleUtils || null;
      },
      get downloads() {
        return root.DownloadManager || null;
      },
      askQuestions(questions, agent) {
        if (typeof root.askQuestions !== 'function') {
          return Promise.resolve({ ok: false, error: GUI_UNAVAILABLE });
        }
        return root.askQuestions(questions, agent);
      },
      showGameInvitation(game, message, suggestedAgents, agent) {
        if (typeof root.showGameInvitation !== 'function') {
          return Promise.resolve({ accepted: false, agentCount: 0, error: GUI_UNAVAILABLE });
        }
        return root.showGameInvitation(game, message, suggestedAgents, agent);
      },
      canvas: {
        init: () => (root.initCanvas ? root.initCanvas() : unavailable('initCanvas')()),
        clear: () => (root.clearCanvas ? root.clearCanvas() : unavailable('clearCanvas')()),
        add: (type, id, attributes) =>
          root.addCanvasObject
            ? root.addCanvasObject(type, id, attributes)
            : unavailable('addCanvasObject')(),
        update: (id, attributes) =>
          root.updateCanvasObject
            ? root.updateCanvasObject(id, attributes)
            : unavailable('updateCanvasObject')(),
        remove: (id) =>
          root.deleteCanvasObject
            ? root.deleteCanvasObject(id)
            : unavailable('deleteCanvasObject')(),
        exportSVG: (filename, workspacePath) =>
          root.exportCanvasSVG
            ? root.exportCanvasSVG(filename, workspacePath)
            : unavailable('exportCanvasSVG')(),
      },
      spreadsheet: {
        init: (title) =>
          root.initSpreadsheet ? root.initSpreadsheet(title) : unavailable('initSpreadsheet')(),
        setCells: (entries) =>
          root.spreadsheetSetCells
            ? root.spreadsheetSetCells(entries)
            : unavailable('spreadsheetSetCells')(),
        getCells: (range) =>
          root.spreadsheetGetCells
            ? root.spreadsheetGetCells(range)
            : unavailable('spreadsheetGetCells')(),
        setCellFormat: (addr, format) =>
          root.spreadsheetSetCellFormat
            ? root.spreadsheetSetCellFormat(addr, format)
            : unavailable('spreadsheetSetCellFormat')(),
        setRangeFormat: (range, format) =>
          root.spreadsheetSetRangeFormat
            ? root.spreadsheetSetRangeFormat(range, format)
            : unavailable('spreadsheetSetRangeFormat')(),
        clearCells: (range) =>
          root.spreadsheetClearCells
            ? root.spreadsheetClearCells(range)
            : unavailable('spreadsheetClearCells')(),
        insertRows: (rowNum, count) =>
          root.spreadsheetInsertRows
            ? root.spreadsheetInsertRows(rowNum, count)
            : unavailable('spreadsheetInsertRows')(),
        deleteRows: (rowNum, count) =>
          root.spreadsheetDeleteRows
            ? root.spreadsheetDeleteRows(rowNum, count)
            : unavailable('spreadsheetDeleteRows')(),
        insertCols: (colLetter, count) =>
          root.spreadsheetInsertCols
            ? root.spreadsheetInsertCols(colLetter, count)
            : unavailable('spreadsheetInsertCols')(),
        deleteCols: (colLetter, count) =>
          root.spreadsheetDeleteCols
            ? root.spreadsheetDeleteCols(colLetter, count)
            : unavailable('spreadsheetDeleteCols')(),
        sortRange: (range, colLetter, ascending) =>
          root.spreadsheetSortRange
            ? root.spreadsheetSortRange(range, colLetter, ascending)
            : unavailable('spreadsheetSortRange')(),
        getData: () =>
          root.spreadsheetGetData ? root.spreadsheetGetData() : unavailable('spreadsheetGetData')(),
        exportCSV: () =>
          root.spreadsheetExportCSV
            ? root.spreadsheetExportCSV()
            : unavailable('spreadsheetExportCSV')(),
        importCSV: (csv, startAddr) =>
          root.spreadsheetImportCSV
            ? root.spreadsheetImportCSV(csv, startAddr)
            : unavailable('spreadsheetImportCSV')(),
        importFile: (filePath) =>
          root.spreadsheetImportFile
            ? root.spreadsheetImportFile(filePath)
            : unavailable('spreadsheetImportFile')(),
        exportFile: (filePath) =>
          root.spreadsheetExportFile
            ? root.spreadsheetExportFile(filePath)
            : unavailable('spreadsheetExportFile')(),
      },
    },
  };
}

/**
 * 无头宿主：主进程 / 测试用。api 由调用方提供（见 src/agent/preload-api.js 与
 * tests 里的 stub），GUI 能力返回优雅失败。
 */
function createHeadlessHost(options = {}) {
  const bus = options.events || new HostEventBus();
  const listeners = new Set();
  const api = options.api || {};
  return {
    kind: 'headless',
    api,
    events: bus,
    env: {
      get isHeadless() {
        return true;
      },
      platform: options.platform || (typeof process !== 'undefined' ? process.platform : 'unknown'),
    },
    notify(type, payload) {
      for (const listener of [...listeners]) {
        try {
          listener(type, payload);
        } catch {
          /* ignore */
        }
      }
    },
    onNotify(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    gui: createHeadlessGui({
      todos: options.todos || (options.api ? createTodoStore(options.api) : null),
      titleUtils: options.titleUtils || null,
      onInteractive: options.onInteractive || null,
    }),
  };
}

let headlessDefaultHost = null;
/** 按宿主根对象（window）缓存：同一页/同一沙箱共享同一宿主与事件总线。 */
const hostCache = new WeakMap();

/**
 * `new Agent()` 的默认宿主。
 * - 传入 root（渲染进程的 window / 测试沙箱的 window）→ 取该根对象上的门面；
 *   同一 root 复用同一宿主实例（跨 realm 安全：root 由调用方解析，不在本模块内找 window）。
 * - 不传 root（Node 主进程）→ 取 setDefaultHost() 注册的无头宿主，否则新建空门面宿主。
 */
function getDefaultHost(root) {
  if (root && typeof root === 'object') {
    const cached = hostCache.get(root);
    if (cached) return cached;
    const created = createRendererHost({ root });
    hostCache.set(root, created);
    return created;
  }
  if (headlessDefaultHost) return headlessDefaultHost;
  headlessDefaultHost = createHeadlessHost();
  return headlessDefaultHost;
}

function setDefaultHost(host) {
  headlessDefaultHost = host || null;
  return headlessDefaultHost;
}

const AgentHostKit = {
  GUI_UNAVAILABLE,
  SESSION_STATUS,
  HostEventBus,
  createTodoStore,
  createRendererHost,
  createHeadlessHost,
  createHeadlessGui,
  getDefaultHost,
  setDefaultHost,
};

// 双环境导出：Node 走 module.exports；页面以 <script> 加载时挂到 globalThis，
// 供 agent.js 以自由标识符 AgentHostKit 解析（与 PrivacyFilter 等模块同约定）。
if (typeof globalThis !== 'undefined') globalThis.AgentHostKit = AgentHostKit;
if (typeof module !== 'undefined' && module.exports) module.exports = AgentHostKit;
