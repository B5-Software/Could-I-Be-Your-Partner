/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

'use strict';

const { app, BrowserWindow, ipcMain: electronIpcMain, nativeTheme, dialog, clipboard, screen, shell, Notification, Tray, Menu, nativeImage, protocol, net, safeStorage, crashReporter } = require('electron');
const appLog = require('./app-log');

// stdout/stderr 被关闭或管道截断（如 `npm start | head`）时，console.log 会抛
// EPIPE 未捕获异常直接崩溃主进程 —— 吞掉流错误，此后写操作变为无害 no-op。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// 主进程兜底：未捕获异常 / 未处理 rejection 记录日志而不是无声崩溃。
// 不主动退出——多数是单次任务级错误（某次 IPC / 网络请求 / 子窗口），保留应用可用性；
// 完整堆栈会写入日志，便于现场定位。
process.on('uncaughtException', (err) => {
  try { console.error('[main] Uncaught exception:', err); } catch { /* ignore */ }
  try {
    appLog.writeCrashRecord({
      source: 'uncaughtException',
      message: (err && err.message) || String(err),
      stack: (err && err.stack) || '',
    });
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[main] Unhandled rejection:', reason); } catch { /* ignore */ }
  try {
    appLog.writeCrashRecord({
      source: 'unhandledRejection',
      message: (reason && reason.message) || String(reason),
      stack: (reason && reason.stack) || '',
    });
  } catch { /* ignore */ }
});

const { dataPath } = require('./core/data-path');
const path = require('path');
const fs = require('fs');
const { loadJSON, saveJSON } = require('./core/json-store');
const { mergeSettings, loadSettings } = require('./settings/merge');
const { calculateTokenCost } = require('../shared/generated/pricing.cjs');
const os = require('os');
const { spawnSync } = require('child_process');
const { EmailService } = require('./email-service');
const { FediKittenService } = require('./fedikitten-service');
const { CibypImService } = require('./cibyp-im-service');
const { importSpreadsheetFile, exportSpreadsheetFile } = require('./spreadsheet-io');
const { WebControlService } = require('./web-control-service');
const { fetchLLMWithRetry, consumeSSEStream, abortAllRequests, abortRequests, DEFAULT_TIMEOUT_MS } = require('./llm-retry');
const LLMProviders = require('./llm-providers');
const ocHeaders = require('./opencode-headers');
const netProxy = require('./net-proxy');
const updateChecker = require('./update-checker');
const ESLintService = require('./eslint-service');
const { BUNDLED_SKILLS } = require('../data/bundled-skills');
const { importKnowledgeFile } = require('./document-import');
const { createPresentation } = require('./ppt-maker');
const { extractWordText, createWordDocument, fillWordTemplate, getWordMetadata, listWordStyles } = require('./word-tools');
const mathTools = require('./math-tools');
const tarotTools = require('./tarot-tools');
const { decodeXmlEntities, encodeXmlEntities } = require('./xml-utils');
const { recognizeImageWithTesseract, recognizeImageDetailed, disposeOcrEngines } = require('./ocr');
const sandboxRunner = require('./sandbox-runner');
const { PluginManager } = require('./ds-compat/plugin-manager');
const {
  requireAdmZip, readTextWithEncoding, normalizeEncodingName, detectEolFromBuffer,
  detectEncodingName, detectFileEncoding, inferEncodingForNewFile, inferEolForNewFile,
  writeTextFileWithEncoding
} = require('./file-encoding');
const registerTerminalIpc = require('./terminal-service');
const registerComputerUseIpc = require('./computer-use-service');
const registerMcpIpc = require('./mcp-service');
const registerPlaywrightIpc = require('./browser-service');
const { registerFfmpegIpc } = require('./ffmpeg-tools');
const { AutomationManager, normalizeAutomationSettings } = require('./automation/automation-manager');
const { getAutomationGuide } = require('./automation/guide');
const { registerGeogebraProtocol } = require('./geogebra-protocol');
const { VoiceModelManager } = require('./voice-model-manager');
const { VmService } = require('./vm/vm-service');
const { aria2Manager } = require('./aria2-manager');
const { DecisionService, DEFAULT_DECISION_SETTINGS, normalizeDecisionSettings } = require('./decision-service');
const { ts: logTs, maskUrl: maskLogUrl, snippet: logSnippet } = require('./req-log');

const { createIpcRouter } = require('./core/ipc-router');
const { createWindowSecurity } = require('./core/window-security');
const { ROUTE_CHANNELS, createRoutedHandler } = require('./vm/vm-tools');
let codeOSSService;
const pagesDirectory = path.join(__dirname, '../renderer/pages');
const windowSecurity = createWindowSecurity({
  pagesDirectory,
  pageNames: fs.readdirSync(pagesDirectory).filter(name => name.endsWith('.html')),
  preloadDirectory: path.join(__dirname, '../preload/generated'),
});
app.on('web-contents-created', (_event, contents) => windowSecurity.protectWebContents(contents));
const ipcMain = createIpcRouter(electronIpcMain, {
  validateSender: windowSecurity.validateSender,
  routeHandler: (channel, handler) => {
    const routed = ROUTE_CHANNELS.has(channel) ? createRoutedHandler(channel, handler, { getVmService: () => vmService, isLocationVm: () => vmLocationActive() }) : handler;
    return (event, ...args) => require('./vm/tool-location').withToolLocation(() => vmService, async () => {
      const editorResult = codeOSSService ? await codeOSSService.interceptFile(channel, args) : null;
      return editorResult === null ? routed(event, ...args) : editorResult;
    });
  },
});
const __ipcHandlers = ipcMain.originalHandlers;

// 无头模式：不起 GUI 窗口，仅运行主进程服务 + 一种无界面前端。
// CLI：
//   electron . --headless                        → WebUI（Web 服务直连 Agent 运行时）
//   electron . --tui [--mode=chat|babe|code] [--workspace=路径] [--web]
//                                                → 终端界面（类 Claude Code / OpenCode 的 TUI）
// 环境变量：CIBYP_WEB_PASSWORD / CIBYP_WEB_PORT / CIBYP_AUTO_APPROVE=1
const TUI = process.argv.includes('--tui');
const WEB_FORCED = process.argv.includes('--web');
const HEADLESS = process.argv.includes('--headless') || TUI;
// 无头模式下的 Agent 运行时（GUI 模式为 null：会话由渲染进程承载）
let agentRuntime = null;
let tuiHandle = null;

// 供无头前端（TUI/WebUI）与集成测试取用运行时实例
module.exports = {
  getAgentRuntime: () => agentRuntime,
  getTuiHandle: () => tuiHandle,
  isHeadless: () => HEADLESS,
};

// 事件总线：主进程向各前端（GUI 窗口 / WebUI / 无头运行时）推送的统一出口。
// 主窗口 sink 维持改造前的 GUI 行为；无窗口（--headless）时事件仍可被订阅者接收。
const { createEventBus } = require('./core/event-bus');
const eventBus = createEventBus();
const publishEvent = (channel, payload) => eventBus.publish(channel, payload);
const detachWindowSink = eventBus.addSink(
  eventBus.createWindowSink(() => mainWindow),
);

const emailService = new EmailService();
const fedikittenService = new FediKittenService();
const cibypImService = new CibypImService();
const webControlService = new WebControlService();
// 语音模型运行时下载管理器（不自动下载；aria2 优先，失败回退普通下载）
const voiceModelManager = new VoiceModelManager({ app, getSettings: () => settings });
voiceModelManager.on('progress', (p) => {
  try { mainWindow?.webContents.send('resources:voiceModels:progress', p); } catch (_) {}
});
voiceModelManager.on('done', (e) => {
  // 下载完成后热重载模型清单，语音功能无需重启即可用
  try { voiceIpc?.engine?.resolveModels?.(); } catch (_) {}
  try { mainWindow?.webContents.send('resources:voiceModels:progress', { modelId: e?.modelId, phase: 'done', percent: 100 }); } catch (_) {}
});
voiceModelManager.on('error', (e) => {
  try { mainWindow?.webContents.send('resources:voiceModels:progress', { modelId: e?.modelId, phase: 'error', error: e?.error || '下载失败' }); } catch (_) {}
});
// 虚拟机沙盒（CIBYP-VM-OS / QEMU）：资源按需下载（aria2），不进安装包
const vmService = new VmService({
  app,
  getSettings: () => settings,
  getSystemDark: () => nativeTheme.shouldUseDarkColors,
  persistSettings: () => { try { saveJSON(settingsPath, settings); } catch (_) {} },
  aria2: aria2Manager,
});
const toolDialog = require('./vm/vm-file-dialog').createVmFileDialog({ ipcMain, dialog, getVmService: () => vmService, getTheme: () => settings.theme, getMainWindow: () => mainWindow });
const toolFiles = require('./vm/tool-files').createToolFiles({ fs, getVmService: () => vmService });
fedikittenService.fileAccess = toolFiles;
cibypImService.fileAccess = toolFiles;
// App 工作区基目录也纳入宿主→VM 映射（用户自定义 vm.workspaceRoot 时二者会分离）

/** 向 Splash 与主窗口广播 VM 事件（任一不存在则跳过） */
function broadcastVm(channel, payload) {
  for (const win of [typeof splashWindow !== 'undefined' ? splashWindow : null, typeof mainWindow !== 'undefined' ? mainWindow : null]) {
    try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (_) {}
  }
}
vmService.on('state', (s) => broadcastVm('vm:state', s));
vmService.on('progress', (p) => broadcastVm('vm:progress', p));
vmService.on('serial', (t) => { try { if (t && String(t).trim()) broadcastVm('vm:serial', String(t).slice(-8192)); } catch (_) {} });
vmService.on('ready', () => {
  if (vmService.emergencyHost) return;
  vmRuntimeGate.ready = true;
  vmRuntimeGate.failed = false;
  tryShowMainWindow();
});
vmService.on('error', (e) => broadcastVm('vm:error', { message: e?.message || String(e) }));
vmService.on('sync-done', (r) => broadcastVm('vm:sync-done', r));
vmService.on('sync-warn', (w) => broadcastVm('vm:sync-warn', { message: String(w) }));
vmService.on('graphics-log', (l) => broadcastVm('vm:graphics-log', String(l)));
vmService.on('graphics-progress', (p) => broadcastVm('vm:graphics-progress', p));
vmService.on('forward-added', (f) => broadcastVm('vm:forward-added', f));
vmService.on('forward-removed', (f) => broadcastVm('vm:forward-removed', f));
// 决策模型（System One / Jev）服务
const decisionService = new DecisionService({
  getSettings: () => settings,
  getDayKey: () => getTodayKeyTZ(settings.budget?.timezone || 'UTC'),
  persistSettings: () => { try { saveJSON(settingsPath, settings); } catch (_) {} },
});
const APP_VERSION = app.getVersion();

// Single instance lock — quit immediately if another instance is already running
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// GeoGebra 离线包经自定义特权协议 ggb:// 提供（必须在 app ready 之前声明）。
// standard+secure 使 URL 解析/相对路径符合 Web 标准；supportFetchAPI 让 GWT 的
// deferredjs 分片通过 XHR/fetch 拉取；corsEnabled 允许 file:// 页面跨源读取。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ggb',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const userDataPath = app.getPath('userData');
const dataDir = path.join(userDataPath, 'data');
const imagesDir = path.join(userDataPath, 'images');
const skillsDir = path.join(userDataPath, 'skills');
const historyDir = path.join(dataDir, 'history');
const babeHistoryDir = path.join(dataDir, 'babe-history'); // Babe mode 独立历史目录
const workspacesBaseDir = path.join(app.getPath('documents'), 'Could-I-Be-Your-Partner');
vmService.addHostRoot(workspacesBaseDir);

[dataDir, imagesDir, skillsDir, historyDir, babeHistoryDir, workspacesBaseDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const todoService = new (require('./services/todo-service').TodoService)({
  file: path.join(dataDir, 'todos.json'),
  historyDirectories: [historyDir, babeHistoryDir],
  changed: state => { publishEvent('todo:state', state); }
});
ipcMain.handle('todo:get', () => todoService.get());
ipcMain.handle('todo:mutate', (_, args) => todoService.mutate(args));

// ---- 崩溃诊断基础设施：原生 minidump + 持久化日志 ----
// crashReporter 必须在 ready 之前启动，否则 Chromium 的 crashpad handler 不会连接，
// 只会打印 "not connected" 且不产生任何 dump。
const crashDumpsPath = path.join(userDataPath, 'Crashpad');
try { fs.mkdirSync(crashDumpsPath, { recursive: true }); } catch { /* ignore */ }
try { app.setPath('crashDumps', crashDumpsPath); } catch { /* ignore */ }
try {
  crashReporter.start({
    productName: 'Could I Be Your Partner',
    companyName: 'B5-Software',
    submitURL: 'https://localhost.invalid/crash-report',
    uploadToServer: false,
    compress: true,
  });
} catch (e) {
  try { console.warn('[crash] crashReporter start failed:', e && e.message); } catch { /* ignore */ }
}
appLog.initLogging({ logDir: path.join(userDataPath, 'logs'), crashDir: path.join(dataDir, 'crash') });

app.on('render-process-gone', (_event, webContents, details) => {
  try {
    appLog.writeCrashRecord({
      source: 'render-process-gone',
      message: `reason=${details && details.reason} exitCode=${details && details.exitCode}`,
      stack: '',
      extra: {
        url: webContents && !webContents.isDestroyed() ? webContents.getURL() : '',
        type: webContents ? webContents.getType() : '',
        details: details || null,
      },
    });
  } catch { /* ignore */ }
});

app.on('child-process-gone', (_event, details) => {
  try {
    appLog.writeCrashRecord({
      source: 'child-process-gone',
      message: `type=${details && details.type} reason=${details && details.reason} exitCode=${details && details.exitCode}`,
      stack: '',
      extra: details || null,
    });
  } catch { /* ignore */ }
});

// ---- 崩溃会话清扫：应用异常退出后，把残留"运行中"的历史标记为"异常退出" ----
// 用"上次优雅退出时间戳"做门闸：只检查该时刻之后修改过的历史文件，启动开销恒定很小。
const lastCleanExitPath = path.join(dataDir, '.last-clean-exit');
const ACTIVE_SESSION_STATUSES = new Set(['running', 'queued', 'waiting_approval', 'waiting_tool_auth']);
let _bootTime = Date.now(); // 本次启动时间（before-quit 清扫用：只查本次运行触碰过的文件）

function readLastCleanExit() {
  try { return Number(fs.readFileSync(lastCleanExitPath, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeLastCleanExit(ts) {
  try { fs.writeFileSync(lastCleanExitPath, String(ts), 'utf8'); } catch { /* ignore */ }
}

// 把 sinceMs 之后修改过、仍处于活动状态的历史标记为 crashed（sinceMs=0 表示全量）
function markActiveHistoriesCrashed(sinceMs) {
  const dirs = [historyDir, babeHistoryDir];
  // Code 模式历史在各工作区 .cibyp-code-history/ 下
  try {
    for (const ws of fs.readdirSync(workspacesBaseDir)) {
      const d = path.join(workspacesBaseDir, ws, '.cibyp-code-history');
      if (fs.existsSync(d)) dirs.push(d);
    }
  } catch { /* ignore */ }
  let fixed = 0;
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        if (sinceMs > 0 && fs.statSync(full).mtimeMs <= sinceMs) continue;
        const data = loadJSON(full, null);
        if (!data || typeof data !== 'object') continue;
        if (!ACTIVE_SESSION_STATUSES.has(data.status)) continue;
        data.status = 'crashed';
        data.lastError = data.lastError || '应用异常退出，会话被中断';
        saveJSON(full, data, false);
        fixed++;
      } catch { /* 单个文件损坏不阻断清扫 */ }
    }
  }
  return fixed;
}

const settingsPath = path.join(dataDir, 'settings.json');
const memoryPath = path.join(dataDir, 'memory.json');
// DeepSeek 插件 skills seam 的惰性 provider：把 CIBYP 内置 + 用户技能清单
// 桥接给插件（dsh-context-doctor 等运行时读取）。
const pluginSkillsProvider = () => {
  const list = [];
  for (const s of Object.values(BUNDLED_SKILLS || {})) {
    if (s && s.name) {
      list.push({ name: s.name, description: s.description || '', source: 'bundled', provider: 'bundled', content: s.prompt || '' });
    }
  }
  try {
    for (const f of fs.readdirSync(skillsDir).filter((x) => x.endsWith('.json'))) {
      const s = loadJSON(path.join(skillsDir, f), {});
      if (s && s.name) {
        list.push({ name: s.name, description: s.description || '', source: 'user', provider: 'user', content: s.prompt || s.content || '' });
      }
    }
  } catch { /* ignore */ }
  return {
    list: async () => list,
    get: async (name) => {
      const hit = list.find((s) => s.name === name);
      if (!hit) return undefined;
      return {
        content: hit.content || '',
        description: hit.description || '',
        source: hit.source,
        provider: hit.provider
      };
    }
  };
};
// DeepSeek 插件管理器（Cordis 内核 lib + CIBYP 自研 Provider）
// 服务翻译层 transport：agent 消息/授权请求经 IPC 往返渲染进程
const dsRequestPending = new Map();
const dsTransportSend = (channel, payload) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch { /* ignore */ }
};
const dsTransportRequest = (channel, payload, timeoutMs, signal) => {
  return new Promise((resolve, reject) => {
    const id = payload && (payload.id || payload.requestId);
    if (!id) { reject(new Error('transport 请求缺少 id')); return; }
    const settle = (outcome) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(outcome); };
    const onAbort = () => { dsRequestPending.delete(id); settle('cancelled'); };
    const timer = setTimeout(() => { dsRequestPending.delete(id); settle('cancelled'); }, timeoutMs || 300000);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    dsRequestPending.set(id, settle);
    dsTransportSend(channel, payload);
  });
};
// 供插件/自动化读取设置：剥离 CIBYP-IM 敏感 vault（token/私钥），防止渲染器侧插件外泄
function readSanitizedSettingsFile() {
  const s = loadJSON(settingsPath, {});
  if (s && s.cibypIm) {
    const { vault, active, identity, keys, sessions, groups, ...rest } = s.cibypIm;
    s.cibypIm = { ...rest, loggedIn: !!(active && active.token) };
  }
  return s;
}
const pluginManager = new PluginManager(dataDir, {
  getVmService: () => vmService,
  skills: pluginSkillsProvider,
  transport: { send: dsTransportSend, request: dsTransportRequest },
  getSettings: async () => readSanitizedSettingsFile()
}).init();
// 自动化任务管理器（定时 / 系统通知 / HTTP 信号服务器 → 新 Chat 会话）
const automationManager = new AutomationManager({
  dataDir,
  transport: { send: dsTransportSend, request: dsTransportRequest },
  getSettings: async () => readSanitizedSettingsFile()
});
const knowledgePath = path.join(dataDir, 'knowledge.json');
// 异常中断的会话（关闭App时正在工作）保存到此文件，下次启动时弹模态框询问是否继续
const pendingSessionPath = path.join(dataDir, '.cibyp-pending.json');
// 标志：渲染器已确认完成 pending 保存（防止 before-quit 在保存未完成时退出）
let pendingSaveDone = false;

const { getTodayKeyTZ, getBudgetPeriodKeys, checkBudgetExceeded, estimateTokens, recordTokenUsage, aggregateUsage, resetDailyUsageIfNeeded } = require('./services/budget')({
  calculateTokenCost,
  getSettings: () => settings
});

function normalizeMessagesForThinking(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (m && m.role === 'assistant' && (m.reasoning !== undefined && m.reasoning !== null)
        && m.reasoning_content === undefined) {
      changed = true;
      return { ...m, reasoning_content: m.reasoning, reasoning: undefined };
    }
    return m;
  });
  return changed ? out : messages;
}

// settings 持久化去抖：settings.json 可能较大（头像已外置后通常 <300KB），
// 高频调用（用量记账/设置页连续修改）合并为一次紧凑写盘；退出前 flush。
let _settingsPersistTimer = null;
function scheduleSettingsPersist(delay = 900) {
  if (_settingsPersistTimer) clearTimeout(_settingsPersistTimer);
  _settingsPersistTimer = setTimeout(() => {
    _settingsPersistTimer = null;
    try { saveJSON(settingsPath, settings, false); } catch { /* ignore */ }
  }, delay);
  if (_settingsPersistTimer.unref) _settingsPersistTimer.unref();
}
function flushSettingsPersist() {
  if (_settingsPersistTimer) {
    clearTimeout(_settingsPersistTimer);
    _settingsPersistTimer = null;
  }
  try { saveJSON(settingsPath, settings, false); } catch { /* ignore */ }
}
function persistSettings() {
  scheduleSettingsPersist();
}

// ---- CIBYP-IM 安全存储与状态持久化（模块顶层：启动/before-quit/IPC 共用）----
// 敏感状态（token/私钥/会话）用 safeStorage（OS 钥匙串）加密后存 settings.json；
// settings.cibypIm 只保留非敏感配置（ownerUsername 等）+ vault 密文。
const CIBYP_IM_SENSITIVE_KEYS = ['active', 'identity', 'keys', 'sessions', 'groups'];
let _cibypImSaveTimer = null;
let _cibypImPlainWarned = false;

function cibypImUnsealConfig(cfg) {
  const c = { ...(cfg || {}) };
  // 迁移旧版明文字段到内存（下次保存时会被密封并删除）
  const legacy = {};
  for (const k of CIBYP_IM_SENSITIVE_KEYS) {
    if (c[k] !== undefined) { legacy[k] = c[k]; delete c[k]; }
  }
  if (typeof c.vault === 'string' && c.vault) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const plain = safeStorage.decryptString(Buffer.from(c.vault, 'base64'));
        Object.assign(c, JSON.parse(plain));
      } else {
        console.error('[CIBYP-IM] safeStorage unavailable, cannot decrypt local key vault');
      }
    } catch (e) {
      console.error('[CIBYP-IM] vault decrypt failed:', e.message);
    }
  } else if (Object.keys(legacy).length) {
    Object.assign(c, legacy); // 明文迁移路径
  }
  return c;
}

function cibypImSealState(stateObj) {
  const sensitive = {};
  for (const k of CIBYP_IM_SENSITIVE_KEYS) sensitive[k] = stateObj ? stateObj[k] : null;
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return { vault: safeStorage.encryptString(JSON.stringify(sensitive)).toString('base64') };
    } catch (e) {
      console.error('[CIBYP-IM] vault encrypt failed:', e.message);
    }
  } else if (!_cibypImPlainWarned) {
    _cibypImPlainWarned = true;
    console.warn('[CIBYP-IM] safeStorage unavailable; key will be stored in plaintext in settings.json (not recommended)');
  }
  return sensitive; // 兜底：明文（功能优先，已警告）
}

function saveCibypImState(immediate = false) {
  if (!cibypImService) return;
  const apply = () => {
    _cibypImSaveTimer = null;
    try {
      const sealed = cibypImSealState(cibypImService.getExportedConfig());
      const next = { ...(settings.cibypIm || {}), ...sealed };
      for (const k of CIBYP_IM_SENSITIVE_KEYS) delete next[k]; // 清除旧明文
      settings.cibypIm = next;
      persistSettings();
    } catch (e) {
      console.error('[CIBYP-IM] state persist failed:', e.message);
    }
  };
  if (immediate) {
    if (_cibypImSaveTimer) { clearTimeout(_cibypImSaveTimer); _cibypImSaveTimer = null; }
    apply();
    return;
  }
  if (_cibypImSaveTimer) return;
  _cibypImSaveTimer = setTimeout(apply, 2000); // 防抖：高频工具调用不反复写盘
}

function cibypImConfigureFromSettings() {
  try {
    const cfg = settings.cibypIm || {};
    const hasLegacyPlaintext = CIBYP_IM_SENSITIVE_KEYS.some((k) => cfg[k] !== undefined);
    cibypImService.configure(cibypImUnsealConfig(cfg));
    // 旧版明文残留：立即密封落盘，缩短明文暴露窗口
    if (hasLegacyPlaintext) saveCibypImState(true);
  } catch (e) {
    console.error('[CIBYP-IM] init failed:', e.message);
  }
}




const { DEFAULT_SETTINGS } = require('./settings/defaults')({
  DEFAULT_DECISION_SETTINGS
});

let settings = loadSettings(DEFAULT_SETTINGS, loadJSON(settingsPath, {}));
// Migrate: if provider field missing, default to openai-compat (preserves existing config).
if (!settings.llm.provider) settings.llm.provider = 'openai-compat';
if (!settings.llm.reasoningEffort) settings.llm.reasoningEffort = 'off';
if (settings.llm.zenApiKey === undefined) settings.llm.zenApiKey = '';
// Migrate: 自定义请求头 / OpenCode 自动头 / UA 版本缓存
if (!Array.isArray(settings.llm.customHeaders)) settings.llm.customHeaders = [];
if (settings.llm.autoOpencodeHeaders === undefined) settings.llm.autoOpencodeHeaders = true;
if (settings.llm.opencodeVersion === undefined) settings.llm.opencodeVersion = null;
// Migrate: 模型池 + 决策模型配置
{
  settings.decision = normalizeDecisionSettings(settings.decision);
  if (!settings.llm.routing || typeof settings.llm.routing !== 'object') {
    settings.llm.routing = { modelStrategy: 'priority', effortStrategy: 'manual' };
  }
  if (!Array.isArray(settings.llm.pool)) settings.llm.pool = [];
  if (settings.llm.pool.length === 0 && (settings.llm.model || settings.llm.apiUrl || settings.llm.zenApiKey)) {
    const isZenGo = settings.llm.provider === 'opencode-zen' || settings.llm.provider === 'opencode-go';
    settings.llm.pool.push({
      id: 'pool-' + Date.now().toString(36),
      label: settings.llm.model || '默认模型',
      provider: settings.llm.provider || 'openai-compat',
      apiUrl: settings.llm.apiUrl || '',
      apiKey: isZenGo ? (settings.llm.zenApiKey || settings.llm.apiKey || '') : (settings.llm.apiKey || ''),
      model: settings.llm.model || '',
      effort: settings.llm.reasoningEffort || 'off',
      intelligence: 50,
      priority: 0,
      vision: settings.llm.forceVision === true,
      contextLength: settings.llm.maxContextLength || 131072,
      enabled: true,
    });
  }
  if (!settings.llm.activeEntryId || !settings.llm.pool.some(e => e && e.id === settings.llm.activeEntryId)) {
    settings.llm.activeEntryId = (settings.llm.pool[0] && settings.llm.pool[0].id) || '';
  }
  projectActivePoolEntry();
}

/**
 * 把当前默认模型池条目投影到旧的 settings.llm.* 字段：
 * 旧路径（游戏/标题/生图描述、主进程校验、非 Agent 调用）继续可用。
 */
function projectActivePoolEntry() {
  try {
    const llm = settings.llm || (settings.llm = {});
    const pool = Array.isArray(llm.pool) ? llm.pool : (llm.pool = []);
    // 运行时兜底：通过引导页/设置直接写入单模型配置时，自动补一条池条目
    if (pool.length === 0 && (llm.model || llm.apiUrl || llm.zenApiKey)) {
      const isZenGo = llm.provider === 'opencode-zen' || llm.provider === 'opencode-go';
      pool.push({
        id: 'pool-' + Date.now().toString(36),
        label: llm.model || '默认模型',
        provider: llm.provider || 'openai-compat',
        apiUrl: llm.apiUrl || '',
        apiKey: isZenGo ? (llm.zenApiKey || llm.apiKey || '') : (llm.apiKey || ''),
        model: llm.model || '',
        effort: llm.reasoningEffort || 'off',
        intelligence: 50,
        priority: 0,
        vision: llm.forceVision === true,
        contextLength: llm.maxContextLength || 131072,
        enabled: true,
      });
      llm.activeEntryId = pool[0].id;
    }
    const entry = pool.find(e => e && e.id === llm.activeEntryId) || pool.find(e => e && e.enabled !== false) || pool[0];
    if (!entry) return;
    llm.activeEntryId = entry.id;
    if (entry.provider) llm.provider = entry.provider;
    llm.apiUrl = entry.apiUrl || '';
    llm.model = entry.model || '';
    if (entry.provider === 'opencode-zen' || entry.provider === 'opencode-go') llm.zenApiKey = entry.apiKey || '';
    else llm.apiKey = entry.apiKey || '';
    if (entry.effort) llm.reasoningEffort = entry.effort;
    // 容量属于模型池条目；显式编辑由 syncActiveEntry 仅同步到当前默认条目。
    if (entry.contextLength) llm.maxContextLength = entry.contextLength;
  } catch (e) {
    console.warn('[llm] model pool projection failed:', e.message);
  }
}
if (!Array.isArray(settings.imageGen.customHeaders)) settings.imageGen.customHeaders = [];
// Migrate: 生图多厂商配置（旧版无 provider → 有 URL 视为 siliconflow，否则 openai）
settings.imageGen = require('./image-gen').normalizeImageGenConfig(settings.imageGen);
// 迁移写入标记：只有确实发生迁移才写盘（避免每次启动无条件重写大文件）
let needsSettingsWrite = false;
// Migrate: 资源下载设置（镜像 / 模型目录）
if (!settings.resources || typeof settings.resources !== 'object') { settings.resources = { mirror: 'cn', voiceModelDir: '' }; needsSettingsWrite = true; }
if (settings.resources.mirror !== 'official') settings.resources.mirror = 'cn';
if (typeof settings.resources.voiceModelDir !== 'string') { settings.resources.voiceModelDir = ''; needsSettingsWrite = true; }
// Migrate: per-day usage tracking (for token stats tab).
if (!settings.llm.usageHistory) { settings.llm.usageHistory = {}; needsSettingsWrite = true; }
// Migrate: automation 旧版 serverToken 字符串 → tokens 列表；补齐 allowNoToken/tokens 默认结构。
{
  const normAuto = normalizeAutomationSettings(settings.automation);
  const legacy = !!(settings.automation && typeof settings.automation.serverToken === 'string');
  settings.automation = normAuto;
  if (legacy) {
    try { saveJSON(settingsPath, settings); } catch { /* ignore */ }
  }
}
// Migrate: 旧 budget.models[model].promptPerK/completionPerK（每1K tokens）
// 转换为新格式 inputPerM/outputPerM（每1M tokens，乘以1000）。
// 同时根据模型名是否包含 claude 自动设置 hasCacheWrite。
if (settings.budget && settings.budget.models) {
  for (const [mid, p] of Object.entries(settings.budget.models)) {
    if (!p) continue;
    if (p.promptPerK != null && p.inputPerM == null) {
      p.inputPerM = (Number(p.promptPerK) || 0) * 1000;
      needsSettingsWrite = true;
    }
    if (p.completionPerK != null && p.outputPerM == null) {
      p.outputPerM = (Number(p.completionPerK) || 0) * 1000;
      needsSettingsWrite = true;
    }
    if (p.cacheReadPerM == null && p.inputPerM != null) {
      // 缓存读取默认按输入价格的 0.1 倍计费
      p.cacheReadPerM = (Number(p.inputPerM) || 0) * 0.1;
    }
    if (p.cacheWritePerM == null && p.inputPerM != null) {
      // 缓存写入默认按输入价格的 1.25 倍计费（仅 Claude 系）
      p.cacheWritePerM = (Number(p.inputPerM) || 0) * 1.25;
    }
    if (p.hasCacheWrite == null) p.hasCacheWrite = /claude/i.test(mid);
    // 保留旧字段以兼容旧版本回滚（不删除）
  }
}
if (!settings.budget) { settings.budget = { models: {}, peakHours: { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 }, dailyLimitUSD: 0, monthlyLimitUSD: 0, warningThreshold: 0.8 }; needsSettingsWrite = true; }
// 工具首次使用授权状态迁移
if (!settings.toolAuthGranted) { settings.toolAuthGranted = { playwright: false, computerUse: false }; needsSettingsWrite = true; }
else {
  if (typeof settings.toolAuthGranted.playwright !== 'boolean') { settings.toolAuthGranted.playwright = false; needsSettingsWrite = true; }
  if (typeof settings.toolAuthGranted.computerUse !== 'boolean') { settings.toolAuthGranted.computerUse = false; needsSettingsWrite = true; }
}
// 后台托盘模式设置迁移
if (!settings.closeToTray || !['ask', 'always', 'never', 'once'].includes(settings.closeToTray)) {
  settings.closeToTray = 'ask';
  needsSettingsWrite = true;
}
if (typeof settings.trayEnabled !== 'boolean') { settings.trayEnabled = true; needsSettingsWrite = true; }
if (!settings.budget.peakHours) { settings.budget.peakHours = { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 }; needsSettingsWrite = true; }
if (needsSettingsWrite || !fs.existsSync(settingsPath)) {
  try { saveJSON(settingsPath, settings, false); } catch (e) { console.warn('[settings] initial write failed:', e && e.message); }
}

let memory = loadJSON(memoryPath, []);
let knowledge = loadJSON(knowledgePath, []);

let mainWindow;
codeOSSService = new (require('./services/codeoss-service').CodeOSSService)({
  getMainWindow: () => mainWindow,
  getSettings: () => settings,
  getVmService: () => vmService,
  dataDirectory: dataDir,
  onWorkspaceChanged: (target) => {
    settings.codeMode = { ...settings.codeMode, lastWorkspace: target.path || null };
    saveJSON(settingsPath, settings, false);
  },
});
ipcMain.handle('codeoss:open', (_, directory) => codeOSSService.open(directory));
ipcMain.handle('codeoss:layout', (_, layout) => codeOSSService.setLayout(layout));
ipcMain.handle('codeoss:command', (_, command) => codeOSSService.request('ide.command', { command }));
ipcMain.handle('codeoss:agent-response', (_, response) => codeOSSService.agentResponse(response));
ipcMain.handle('codeoss:context', () => codeOSSService.request('ide.context', {}));
ipcMain.handle('codeoss:language', (_, params, workspace) => {
  const target = codeOSSService.target;
  const normalize = value => {
    if (target.location === 'vm') return path.posix.resolve(String(value || '/'));
    const absolute = path.resolve(String(value || '.'));
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  if (!workspace || normalize(workspace) !== normalize(target.path)) throw new Error('The Agent workspace does not match the active Code-OSS workspace.');
  return codeOSSService.request('ide.language', params);
});
ipcMain.handle('codeoss:version', () => require('../../integrations/codeoss/runtime-lock.json').vscodeVersion);
ipcMain.handle('codeoss:changes', (_, action = 'list', id) => codeOSSService.request('ide.changes', { action, id }));
let appTray = null;
let skillEditorWindow = null;
let automationEditorWindow = null;
let isQuitting = false;
// 语音子系统句柄（voice-ipc.js initVoice 返回值，app ready 后赋值）
let voiceIpc = null;
// 用户在"关闭时询问"模态框中的 pending Promise resolver
let _pendingCloseToTrayResolve = null;

// 主窗口"预渲染完成后再显示"：渲染器 boot 完成（主题/设置/字体/i18n 等
// 全部就绪）后经 IPC 通知再 show；超时兜底避免窗口永久隐藏。
let mainWindowShownOnce = false;
const MAIN_WINDOW_SHOW_FALLBACK_MS = 6000;

// ---- Splash 启动画面 ----
// 主窗口就绪前展示品牌画面（预渲染 ~2s），避免"无窗口"空白等待；
// 主窗口 show 时自动关闭。独立小窗口，不影响主窗口渲染流程。
let splashWindow = null;
let splashCreated = false;

// Splash 顶部 git 哈希：优先读 build-info.json（dev=仓库根 / 打包=asar 根，由 build-info.js 生成），
// 缺失或为空时回退实时 git rev-parse，仍失败返回 ''。
function getGitShortHash() {
  try {
    const candidates = [
      path.join(__dirname, '..', 'build-info.json'),
      path.join(app.getAppPath(), 'build-info.json')
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const info = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (info && typeof info.gitHash === 'string' && info.gitHash) return info.gitHash;
    }
  } catch { /* ignore */ }
  try {
    const { execSync } = require('child_process');
    return String(execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
  } catch { return ''; }
}

// ---- 运行位置门控：location=vm 时主窗口必须等 VM 就绪（或紧急回退/超时）----
// 设计约束：门控与判据全部在主进程、零 VM 依赖 —— VM 挂了也一定能进主界面。
const vmRuntimeGate = { required: false, ready: true, failed: false, reason: null };
let mainRendererReady = false;
const startupRuntimeWaiters = new Set();
ipcMain.handle('app:startup-runtime', () => {
  if (!vmRuntimeGate.required || vmRuntimeGate.ready) return { location: vmService.emergencyHost ? 'host' : settings.runtime.location };
  return new Promise(resolve => startupRuntimeWaiters.add(resolve));
});

/** 尝试显示主窗口；VM 门控未放行时返回 false（调用方无需处理） */
function tryShowMainWindow() {
  if (!vmRuntimeGate.required || vmRuntimeGate.ready) {
    for (const resolve of startupRuntimeWaiters) resolve({ location: vmService.emergencyHost ? 'host' : settings.runtime.location });
    startupRuntimeWaiters.clear();
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindowShownOnce) return false;
  if (!mainRendererReady) return false;
  if (vmRuntimeGate.required && !vmRuntimeGate.ready) return false;
  mainWindowShownOnce = true;
  mainWindow.show();
  try { mainWindow.focus(); } catch { /* ignore */ }
  console.log('[vm] Main window shown' + (vmRuntimeGate.required ? ' (VM startup gate released)' : ''));
  return true;
}

/**
 * location=vm 的启动编排：
 *   VM 就绪 → 放行主窗口；
 *   启动失败 → Splash 展示故障信息（含串口尾部）+ 紧急按钮，超时后自动回退本机模式。
 */
async function startVmBootForSplash() {
  try {
    vmService.emergencyHost = false;
    console.log('[vm] Starting virtual machine (splash startup gate active)');
    broadcastVm('vm:boot-begin', { status: vmService.status() });
    await vmService.start();
    if (vmService.emergencyHost) return;
    vmRuntimeGate.ready = true;
    vmRuntimeGate.failed = false;
    console.log('[vm] Virtual machine ready: ' + JSON.stringify({
      accel: vmService.status().inst?.accel,
      detail: 'Virtual machine ready',
    }));
    broadcastVm('vm:boot-ready', { status: vmService.status() });
    tryShowMainWindow();
  } catch (e) {
    if (vmService.emergencyHost) return;
    vmRuntimeGate.failed = true;
    vmRuntimeGate.reason = e.message;
    console.error('[vm] Virtual machine startup failed: ' + e.message);
    broadcastVm('vm:boot-failed', {
      message: e.message,
      code: e.code || null,
      serialTail: String((vmService.status().inst || {}).serialTail || '').slice(-8192)
    });
    const delay = Math.max(5000, Number(settings.runtime?.vm?.autoFallbackMs) || 20000);
    setTimeout(() => {
      if (!mainWindowShownOnce) {
        vmService.emergencyHostMode();
        vmRuntimeGate.ready = true;
        tryShowMainWindow();
      }
    }, delay);
  }
}

function createSplashWindow() {
  if (splashCreated || !mainWindow || mainWindow.isDestroyed()) return;
  splashCreated = true;
  const vmMode = !!(settings.runtime && settings.runtime.location === 'vm');
  splashWindow = new BrowserWindow({
    width: vmMode ? 540 : 420,
    height: vmMode ? 440 : 300,
    frame: false,
    transparent: false,
    backgroundColor: '#17181d',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/generated/splash-preload.js')
    }
  });
  // Splash 跟随主题：深浅色 + 强调色 + 背景色 + 版本号
  const th = settings.theme || {};
  const mode = th.mode || 'system';
  const dark = mode === 'dark' ? true : mode === 'light' ? false : nativeTheme.shouldUseDarkColors;
  const accent = /^#[0-9a-fA-F]{6}$/.test(th.accentColor || '') ? th.accentColor : '#4f8cff';
  const bg = /^#[0-9a-fA-F]{6}$/.test(th.backgroundColor || '') ? th.backgroundColor : (dark ? '#17181d' : '#f5f7fa');
  // Splash 跟随自定义字体：settings.fonts[lang]（与 01-app-init 的 FONT_OPTIONS 同表）
  const SPLASH_FONT_WHITELIST = ['Noto Sans SC', 'LXGW WenKai', 'Noto Serif SC', 'Inter', 'Source Sans 3', 'Noto Sans'];
  const lang = String(settings.language || 'zh');
  const fonts = (settings.fonts || {});
  const fontFamily = SPLASH_FONT_WHITELIST.includes(fonts[lang]) ? fonts[lang]
    : SPLASH_FONT_WHITELIST.includes(fonts.zh) ? fonts.zh : '';
  try { splashWindow.setBackgroundColor(bg); } catch { /* ignore */ }
  const params = {
    dark: dark ? '1' : '0',
    accent: accent.slice(1),
    bg: bg.slice(1),
    version: app.getVersion(),
    gitHash: getGitShortHash(),
    // 启动画面不加载体积巨大的自定义字体，避免与主窗口重复解析（主窗口仍正常应用）
    font: ''
  };
  splashWindow.loadFile(path.join(__dirname, '../renderer/pages/splash.html'), { query: params });
  splashWindow.webContents.once('did-finish-load', () => {
    try {
      splashWindow.webContents.send('vm:init', { vmMode, status: vmService.status() });
    } catch { /* ignore */ }
  });
  splashWindow.once('ready-to-show', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.center();
    splashWindow.show();
  });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 600,
    title: 'Could I Be Your Partner',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    show: false,
    backgroundColor: '#1e1e1e',
    // Initialize and paint the App behind Splash while the VM starts in parallel.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/generated/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  mainWindowShownOnce = false;
  mainRendererReady = false;
  // 兜底：渲染器 boot 异常/超时时也必须显示窗口。
  // 运行位置=虚拟机时，兜底时间放宽到「VM 启动超时 + 15s」，避免抢在 VM 就绪前弹出空界面。
  const vmMode = settings.runtime && settings.runtime.location === 'vm';
  const fallbackMs = vmMode
    ? Math.max(MAIN_WINDOW_SHOW_FALLBACK_MS, (Number(settings.runtime?.vm?.bootTimeoutMs) || 180000) + 15000)
    : MAIN_WINDOW_SHOW_FALLBACK_MS;
  setTimeout(() => {
    if (!mainWindowShownOnce && mainWindow && !mainWindow.isDestroyed()) {
      if (vmRuntimeGate.required && !vmRuntimeGate.ready) {
        vmService.emergencyHostMode();
        vmRuntimeGate.required = false;
        vmRuntimeGate.ready = true;
        tryShowMainWindow();
        return; // Initialize host workspace before revealing the App.
      }
      mainRendererReady = true;
      tryShowMainWindow();
    }
  }, fallbackMs);
  registerRendererReadyListener();
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
  // 主窗口一旦显示（渲染器就绪或超时兜底）即关闭 Splash，并解除后台节流
  mainWindow.on('show', () => {
    closeSplash();
    try { mainWindow.webContents.setBackgroundThrottling(false); } catch { /* ignore */ }
  });
  // Resize the built-in browser (BrowserView) when the main window resizes.

  // 关闭拦截：根据 settings.closeToTray 决定是否最小化到托盘
  mainWindow.on('close', async (event) => {
    if (isQuitting) return; // 真正退出时放行
    const mode = settings.closeToTray || 'ask';
    if (mode === 'never') return; // 直接退出
    if (mode === 'always' || mode === 'once') {
      event.preventDefault();
      hideWindowToTray();
      return;
    }
    // mode === 'ask'：首次关闭弹模态框询问
    event.preventDefault();
    try {
      const decision = await askCloseToTrayDecision();
      // decision: 'always' | 'once' | 'never' | null(cancel)
      if (decision === 'always' || decision === 'once') {
        hideWindowToTray();
      } else if (decision === 'never') {
        // 用户选择"不再后台运行"→ 真正退出
        // 直接调用 app.quit() 跳过 close 事件循环；并标记 pendingSaveDone
        // 避免触发 before-quit 中等待渲染器保存 pending 状态的逻辑
        isQuitting = true;
        pendingSaveDone = true;
        try { app.quit(); } catch {}
      } else {
        // 用户取消模态框（cancel / dismiss）→ 保持窗口打开，不关闭也不隐藏
        // （避免误把"取消"当作"总是隐藏到托盘"）
      }
    } catch {
      // 询问失败时降级为保持窗口打开（不强制隐藏到托盘）
    }
  });
}

// ---- 崩溃报告窗口：上轮异常退出时本次启动自动弹出 ----
let crashReportWindow = null;
let pendingCrashReport = null;

function detectPendingCrashReport(previousCleanExit, crashedSessionCount) {
  try {
    const since = previousCleanExit || (Date.now() - 24 * 3600 * 1000);
    const records = appLog.readCrashRecords(since);
    const dumps = appLog.listDumpFiles(crashDumpsPath).filter((d) => !previousCleanExit || d.mtimeMs > previousCleanExit);
    if (crashedSessionCount > 0 || records.length > 0 || dumps.length > 0) {
      pendingCrashReport = {
        previousCleanExit: previousCleanExit || 0,
        crashedSessionCount: crashedSessionCount || 0,
        records,
        dumps,
        detectedAt: Date.now(),
      };
      console.warn(`[crash] previous run ended abnormally: sessions=${crashedSessionCount} records=${records.length} dumps=${dumps.length}`);
    }
  } catch (e) {
    console.warn('[crash] detection failed:', e && e.message);
  }
}

function buildSettingsSummary() {
  const s = settings || {};
  const llm = s.llm || {};
  const decision = s.decision || {};
  return {
    llm: {
      provider: llm.provider || '',
      model: llm.model || '',
      apiUrl: llm.apiUrl || '',
      hasApiKey: !!(llm.apiKey || llm.zenApiKey),
    },
    decision: {
      enabled: !!decision.enabled,
      provider: decision.provider || '',
      model: decision.model || '',
      usages: decision.usages || {},
    },
    voice: {
      enabled: !!(s.voice && s.voice.enabled),
      wakeEnabled: !!(s.voice && s.voice.wakeEnabled),
    },
    proxy: {
      mode: s.proxy ? s.proxy.mode : '',
      hasRules: !!(s.proxy && s.proxy.proxyRules),
    },
    enabledToolCount: s.tools ? Object.keys(s.tools).length : 0,
  };
}

function buildCrashInfo() {
  const info = pendingCrashReport || { previousCleanExit: 0, crashedSessionCount: 0, records: [], dumps: [], detectedAt: Date.now() };
  let appMetrics = [];
  try { appMetrics = app.getAppMetrics(); } catch { /* ignore */ }
  let mem = null;
  try { mem = process.memoryUsage(); } catch { /* ignore */ }
  return {
    meta: {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    },
    detectedAt: info.detectedAt,
    previousCleanExit: info.previousCleanExit,
    crashedSessionCount: info.crashedSessionCount,
    records: info.records,
    dumps: (info.dumps || []).map((d) => ({ name: path.basename(d.path), path: d.path, size: d.size, mtimeMs: d.mtimeMs })),
    logPath: appLog.currentLogPath(),
    logTail: appLog.tailLines(300),
    logDir: appLog.getLogDir(),
    crashDir: appLog.getCrashDir(),
    dumpsDir: crashDumpsPath,
    currentMemory: mem ? { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external } : null,
    appMetrics: appMetrics.map((m) => ({ pid: m.pid, type: m.type, name: m.name, cpu: m.cpu, memory: m.memory })),
  };
}

function openCrashReportWindow() {
  if (!pendingCrashReport) return;
  if (crashReportWindow && !crashReportWindow.isDestroyed()) {
    crashReportWindow.focus();
    return;
  }
  crashReportWindow = new BrowserWindow({
    width: 940, height: 760, minWidth: 660, minHeight: 540,
    title: 'Crash Report',
    frame: false,
    show: false,
    backgroundColor: settings.theme.backgroundColor || (nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#f5f7fa'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/generated/crash-report-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  crashReportWindow.loadFile(path.join(__dirname, '../renderer/pages/crash-report.html'));
  crashReportWindow.once('ready-to-show', () => crashReportWindow.show());
  crashReportWindow.on('closed', () => { crashReportWindow = null; });
}

function closeCrashReportWindow() {
  if (crashReportWindow && !crashReportWindow.isDestroyed()) crashReportWindow.close();
}

ipcMain.handle('crash:info', () => buildCrashInfo());
ipcMain.handle('crash:copy', () => {
  const info = buildCrashInfo();
  clipboard.writeText(JSON.stringify({ meta: info.meta, detectedAt: info.detectedAt, previousCleanExit: info.previousCleanExit, crashedSessionCount: info.crashedSessionCount, records: info.records, dumps: info.dumps, logTail: info.logTail }, null, 2));
  return { ok: true };
});
ipcMain.handle('crash:openLogsDir', async () => {
  const error = await shell.openPath(appLog.getLogDir());
  return error ? { ok: false, error } : { ok: true };
});
ipcMain.handle('crash:close', () => { closeCrashReportWindow(); });
ipcMain.handle('crash:dismiss', () => {
  appLog.clearCrashRecords();
  pendingCrashReport = null;
  closeCrashReportWindow();
  return { ok: true };
});
ipcMain.handle('crash:openDumpsDir', async () => {
  const error = await shell.openPath(crashDumpsPath);
  return error ? { ok: false, error } : { ok: true, dir: crashDumpsPath };
});
ipcMain.handle('crash:exportBundle', async () => {
  try {
    const AdmZip = require('adm-zip');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defPath = path.join(app.getPath('documents'), `cibyp-crash-${ts}.zip`);
    const parent = crashReportWindow && !crashReportWindow.isDestroyed() ? crashReportWindow : mainWindow;
    const dialogOptions = {
      title: 'Export crash diagnostics',
      defaultPath: defPath,
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    };
    const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const zip = new AdmZip();
    const info = buildCrashInfo();
    zip.addFile('report.json', Buffer.from(JSON.stringify({ ...info, logTail: undefined }, null, 2), 'utf8'));
    zip.addFile('settings-summary.json', Buffer.from(JSON.stringify(buildSettingsSummary(), null, 2), 'utf8'));
    if (info.logTail) zip.addFile('logs/main-tail.log', Buffer.from(info.logTail, 'utf8'));
    const logPath = appLog.currentLogPath();
    if (logPath && fs.existsSync(logPath)) {
      try { zip.addLocalFile(logPath, 'logs'); } catch { /* ignore */ }
    }
    for (const d of info.dumps) {
      try { if (fs.existsSync(d.path)) zip.addLocalFile(d.path, 'dumps'); } catch { /* ignore */ }
    }
    zip.writeZip(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('crash:heapSnapshot', async () => {
  try {
    const v8 = require('v8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const defPath = path.join(app.getPath('documents'), `heap-${ts}.heapsnapshot`);
    const parent = crashReportWindow && !crashReportWindow.isDestroyed() ? crashReportWindow : mainWindow;
    const dialogOptions = {
      title: 'Export heap snapshot',
      defaultPath: defPath,
      filters: [{ name: 'Heap snapshot', extensions: ['heapsnapshot'] }],
    };
    const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const out = v8.writeHeapSnapshot(result.filePath);
    let size = 0;
    try { size = fs.statSync(out).size; } catch { /* ignore */ }
    return { ok: true, path: out, size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 渲染器预渲染完成 → 显示主窗口（sender 校验防止子窗口误触发；
// 模块级一次性注册，避免窗口重建时重复累积监听器）
let _rendererReadyListenerRegistered = false;
function registerRendererReadyListener() {
  if (_rendererReadyListenerRegistered) return;
  _rendererReadyListenerRegistered = true;
  ipcMain.on('app:renderer-ready', (event) => {
    if (!mainWindowShownOnce && mainWindow && !mainWindow.isDestroyed()
        && event.sender === mainWindow.webContents) {
      mainRendererReady = true;
      broadcastVm('app:startup-ready', {});
      // 运行位置=虚拟机时，渲染器就绪不代表可以进主界面 —— 还要等 VM 门控放行
      tryShowMainWindow();
    }
  });
}

/**
 * VM 桌面窗口（P4）：内嵌 noVNC 显示虚拟机里的 X 会话。
 * 连接信息由 vm-desktop-preload 经 IPC 取得；VNC 仅监听 guest loopback。
 */
let vmDesktopWindow = null;
function openVmDesktopWindow() {
  if (vmDesktopWindow && !vmDesktopWindow.isDestroyed()) {
    vmDesktopWindow.show();
    vmDesktopWindow.focus();
    return vmDesktopWindow;
  }
  vmDesktopWindow = new BrowserWindow({
    width: 1180, height: 800, minWidth: 820, minHeight: 560,
    title: 'VM 桌面 · CIBYP-VM-OS',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    backgroundColor: '#14161b',
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/generated/vm-desktop-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  {
    const th = settings.theme || {};
    const mode = th.mode || 'system';
    const dark = mode === 'dark' ? true : mode === 'light' ? false : nativeTheme.shouldUseDarkColors;
    const accent = /^#[0-9a-fA-F]{6}$/.test(th.accentColor || '') ? th.accentColor : '#4f8cff';
    const bg = /^#[0-9a-fA-F]{6}$/.test(th.backgroundColor || '') ? th.backgroundColor : (dark ? '#17181d' : '#f5f7fa');
    try { vmDesktopWindow.setBackgroundColor(bg); } catch { /* ignore */ }
    vmDesktopWindow.loadFile(path.join(__dirname, '../renderer/pages/vm-desktop.html'), { query: { dark: dark ? '1' : '0', accent: accent.slice(1), bg: bg.slice(1) } });
  }
  vmDesktopWindow.once('ready-to-show', () => { try { vmDesktopWindow.show(); } catch { /* ignore */ } });
  vmDesktopWindow.on('closed', () => { vmDesktopWindow = null; });
  return vmDesktopWindow;
}

/**
 * 隐藏主窗口到托盘（不退出）。
 * 在 macOS 上调用 app.dock.hide() 隐藏 dock 图标；
 * 在 Windows/Linux 上仅 hide()。
 */
function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (process.platform === 'darwin') {
    try { app.dock.hide(); } catch {}
  }
  // 确保托盘已创建
  if (!appTray) createAppTray();
}

/**
 * 显示主窗口（从托盘恢复）。
 */
function showWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 窗口可能被销毁（异常退出到托盘后）→ 重建，避免三入口全部静默失效
    if (isQuitting) return;
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    try { app.dock.show(); } catch {}
  }
}

/**
 * 创建应用托盘图标（仅在 trayEnabled=true 时）。
 * 单击托盘图标：显示/隐藏主窗口
 * 右键菜单：显示主窗口 / 退出
 */
function createAppTray() {
  if (appTray) return;
  if (!settings.trayEnabled) return;
  // 托盘图标：按 Electron/macOS 官方规范处理尺寸。
  // macOS 菜单栏图标必须是 Template Image：纯 alpha 通道（黑+透明），系统按深浅色自动着色。
  // 直接用全彩 icon.png 缩小再做模板，会得到"白色圆角方块"（颜色被忽略只剩不透明矩形）。
  // 因此 macOS 使用专用模板资产 trayHeartTemplate.png(16x16@1x/32x32@2x，命名以 Template 结尾，
  // Electron/macOS 自动匹配 @2x 与模板反色)。
  // Windows/Linux 托盘图标标准尺寸 16x16，使用彩色 icon.png 缩放。
  let trayIcon;
  try {
    if (process.platform === 'darwin') {
      const iconPath = path.join(__dirname, '../../assets/icons/icons/trayHeartTemplate.png');
      trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
      if (!trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
      else {
        // 模板资产缺失时回退到彩色图标（保持托盘可用），告警日志提示
        const fallback = path.join(__dirname, '../../assets/icons/icon.png');
        trayIcon = fs.existsSync(fallback) ? nativeImage.createFromPath(fallback) : nativeImage.createEmpty();
        if (!trayIcon.isEmpty()) {
          try { trayIcon = trayIcon.resize({ width: 22, height: 22 }); } catch {}
          trayIcon.setTemplateImage(true);
        }
      }
    } else {
      const iconPath = path.join(__dirname, '../../assets/icons/icon.png');
      if (fs.existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
        if (!trayIcon.isEmpty()) {
          // Windows/Linux 托盘图标标准尺寸 16x16
          try { trayIcon = trayIcon.resize({ width: 16, height: 16 }); } catch {}
        }
      }
    }
  } catch (e) { /* 图标加载失败时使用空图标，Tray 仍可创建 */ }
  if (!trayIcon || trayIcon.isEmpty()) {
    appTray = new Tray(nativeImage.createEmpty());
  } else {
    appTray = new Tray(trayIcon);
  }
  appTray.setToolTip('Could I Be Your Partner');

  appTray.setContextMenu(buildTrayMenu());

  // 单击托盘图标：切换窗口可见性
  appTray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      hideWindowToTray();
    } else {
      showWindowFromTray();
    }
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindowFromTray() },
    {
      label: '语音唤醒',
      type: 'checkbox',
      checked: !!(settings.voice && settings.voice.wakeEnabled),
      click: (item) => {
        if (voiceIpc) {
          voiceIpc.setWakeEnabled(item.checked).catch(() => {});
        } else if (settings.voice) {
          settings.voice.wakeEnabled = item.checked;
          try { saveJSON(settingsPath, settings); } catch {}
        }
        // 联动：广播设置变化到渲染器（设置页语音唤醒开关回显）
        broadcastSettingsChanged();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function rebuildTrayMenu() {
  if (appTray) {
    try { appTray.setContextMenu(buildTrayMenu()); } catch (_) {}
  }
}

/**
 * 通过渲染器弹模态框询问"关闭时最小化到托盘"的决策。
 * 返回 Promise<'always' | 'once' | 'never' | null>
 * null 表示用户取消（关闭模态框未做选择）
 */
function askCloseToTrayDecision() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(null);
      return;
    }
    // 清理上一个 pending resolver（防御性）
    if (_pendingCloseToTrayResolve) {
      try { _pendingCloseToTrayResolve(null); } catch {}
    }
    _pendingCloseToTrayResolve = resolve;
    try {
      mainWindow.webContents.send('tray:ask-close-decision');
    } catch {
      _pendingCloseToTrayResolve = null;
      resolve(null);
    }
  });
}

function resolveCloseToTrayDecision(decision) {
  if (_pendingCloseToTrayResolve) {
    _pendingCloseToTrayResolve(decision);
    _pendingCloseToTrayResolve = null;
  }
}

// ===== 代理设置应用 =====
// settings.proxy 真正生效的四个层面：
// 1) Electron session（渲染进程 fetch/XHR/WebSocket、net.fetch、离线窗口）；
// 2) 主进程 Node fetch（undici）→ net-proxy.js 注入全局 dispatcher；
// 3) 子进程环境变量（npm/curl/MCP/终端/插件）；
// 4) aria2 通过 --all-proxy 单独配置（由调用方触发重启）。
// 注意：修复旧实现的语法错误 —— Electron proxyRules 语法为 [<scheme>=]<proxyURI>，
// proxyBypassRules 为逗号分隔（旧代码用 PAC 式 "PROXY host:port" 与 ";" 连接均无效）。
async function applyProxySettings(proxy) {
  if (!proxy) return;
  const { session } = require('electron');

  let config = { mode: 'direct' };

  if (proxy.mode === 'none') {
    config = { mode: 'direct' };
  } else if (proxy.mode === 'system') {
    config = { mode: 'system' };
  } else if (proxy.mode === 'manual') {
    const httpUrl = netProxy.normalizeProxyUrl(proxy.http);
    const httpsUrl = netProxy.normalizeProxyUrl(proxy.https);
    if (httpUrl || httpsUrl) {
      // 两个地址不同 → 按 scheme 分流；只有一个（或相同）→ 裸值适用于所有协议
      let proxyRules;
      if (httpUrl && httpsUrl && httpUrl !== httpsUrl) {
        proxyRules = `http=${httpUrl};https=${httpsUrl}`;
      } else {
        proxyRules = (httpUrl || httpsUrl);
      }
      // bypass 列表（逗号分隔；显式补充 loopback，Chromium 默认也会绕过）
      const bypassList = ['localhost', '127.0.0.1', '::1']
        .concat(String(proxy.bypass || '').split(/[,;\s]+/).filter(Boolean));
      config = {
        mode: 'fixed_servers',
        proxyRules,
        proxyBypassRules: bypassList.join(',')
      };
    } else {
      config = { mode: 'direct' };
    }
  }

  try {
    await session.defaultSession.setProxy(config);
    // 关闭基于旧代理配置的连接池 socket，避免动态切换后复用旧连接
    try { await session.defaultSession.closeAllConnections(); } catch { /* ignore */ }
  } catch (e) {
    console.warn('[Proxy] failed to set Electron session proxy:', e.message);
  }
  // 主进程 fetch dispatcher + 子进程 env
  try {
    await netProxy.setConfig(proxy);
  } catch (e) {
    console.warn('[Proxy] failed to apply main-process proxy:', e.message);
  }
  console.log('[Proxy] proxy settings applied:', config.mode, config.mode === 'fixed_servers' ? config.proxyRules : '');
}

// 代理设置变更时动态更新（由渲染进程 settings 保存后触发）
ipcMain.handle('proxy:apply', async (_, proxy) => {
  try {
    await applyProxySettings(proxy);
    // 同时通知 aria2 重启以应用新代理
    if (aria2Manager.ready) {
      await aria2Manager.start(proxy);
    }
    // 同步 FediKitten 服务代理（主进程 fetch 需要独立 dispatcher）
    try { await fedikittenService.refreshProxy(proxy); } catch (e) { console.warn('[Proxy] failed to refresh FediKitten proxy:', e.message); }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  // 崩溃会话清扫：上次运行异常退出时残留的"运行中"历史 → 标记"异常退出"
  const previousCleanExit = readLastCleanExit();
  let crashedSessionCount = 0;
  try {
    crashedSessionCount = markActiveHistoriesCrashed(previousCleanExit);
    if (crashedSessionCount > 0) console.log(`[history] marked ${crashedSessionCount} session(s) as crashed`);
  } catch (e) { console.error('[history] crash sweep failed:', e.message); }
  _bootTime = Date.now();
  writeLastCleanExit(_bootTime);
  // 崩溃检测：上轮异常退出 / 原生 minidump / 未捕获异常记录 → 本次启动展示独立报告窗口
  detectPendingCrashReport(previousCleanExit, crashedSessionCount);
  // 头像迁移：历史版本把 10MB+ base64 头像存在 settings.json 里，首次启动迁到文件（保留备份）
  try { _migrateAvatarsToFiles(); } catch (e) { console.warn('[avatars] migration failed:', e && e.message); }
  // CIBYP-IM：ready 后解封 vault（safeStorage 需要 ready），服务状态常驻内存
  cibypImConfigureFromSettings();
  // 注册 GeoGebra 离线静态服务（ggb://app/... → assets/geogebra-app/GeoGebra/HTML5/5.0/...）
  registerGeogebraProtocol();
  const appPath = app.getAppPath();
  // 检测 .no-tarot 标志文件（由 build --no-tarot 脚本写入）：若存在则屏蔽所有塔罗牌元素/工具/UI
  const NO_TAROT_BUILD = fs.existsSync(path.join(appPath, '.no-tarot'));
  if (NO_TAROT_BUILD) {
    console.log('[CIBYP] .no-tarot flag present, tarot features disabled');
    // 强制覆盖设置中的 tarotVisible 为 false（即使用户之前保存过 true）
    settings.tarotVisible = false;
    try { saveJSON(settingsPath, settings); } catch {}
  }
  // Desktop permissions are requested only from the explicit Computer Use setup UI.
  // Startup and tool calls must never trigger TCC prompts or open System Settings.
  if (process.platform === 'darwin') {
    // macOS Sequoia 15+: 主动触发本地网络权限请求（仅第一次，之后不再自动触发）
    // 仅声明 NSLocalNetworkUsageDescription + NSBonjourServices 不会自动弹窗，
    // 必须发起一次 Bonjour/mDNS 浏览才会触发系统权限弹窗。
    // 普通局域网 TCP 连接不会触发本地网络权限（实测），必须用 Bonjour 浏览。
    // 通过 dns-sd -B 命令浏览 Bonjour 服务，触发权限请求后立即终止。
    if (!settings.permissions.localNetworkPromptShown) {
      settings.permissions.localNetworkPromptShown = true;
      try { persistSettings(); } catch { /* ignore */ }
      try {
        const { spawn } = require('child_process');
        const bonjourProbe = spawn('dns-sd', ['-B', '_http._tcp', 'local.'], {
          stdio: 'ignore',
          detached: true
        });
        // 浏览 3 秒后终止，足够触发权限请求
        setTimeout(() => { try { bonjourProbe.kill(); } catch {} }, 3000);
        bonjourProbe.on('error', () => {});
        console.log('[LocalNetwork] Triggered Bonjour browse to request permission');
      } catch (e) {
        console.warn('[LocalNetwork] Bonjour trigger failed:', e.message);
      }
    }
  }
  // ===== 应用代理设置 =====
  // 让 settings.proxy 真正生效：Electron session + 主进程 fetch dispatcher + 子进程 env
  netProxy.install();
  applyProxySettings(settings.proxy).catch((e) => {
    console.warn('[Proxy] failed to start app proxy:', e.message);
  });
  // 同步 FediKitten 服务代理（主进程 fetch 使用 undici dispatcher）
  try { fedikittenService.refreshProxy(settings.proxy); } catch (e) { /* 直连回退 */ }
  // OpenCode UA 版本：注入 settings 缓存读写器并后台刷新（走代理，失败静默）
  ocHeaders.setOpenCodeVersionStore({
    loadFn: async () => {
      const v = settings.llm.opencodeVersion;
      return (v && v.version) ? { version: v.version, fetchedAt: v.fetchedAt } : null;
    },
    saveFn: async (version, fetchedAt) => {
      settings.llm.opencodeVersion = { version, fetchedAt };
      persistSettings();
    }
  });
  ocHeaders.refreshOpenCodeVersion().catch(() => {});

  // Establish the VM gate before renderer loading can report readiness.
  vmRuntimeGate.required = settings.runtime?.location === 'vm';
  vmRuntimeGate.ready = !vmRuntimeGate.required;
  // 无头模式（--headless）：不起窗口/启动画面，仅运行服务与 WebUI（见下方 headless 启动块）
  if (!HEADLESS) createWindow();
  // Splash 启动画面：主窗口预渲染完成前展示品牌画面（主窗口 show 时自动关闭）
  if (!HEADLESS) createSplashWindow();
  // 运行位置=虚拟机：Splash 阶段完成 VM 启动编排（就绪后才放行主窗口）
  if (settings.runtime && settings.runtime.location === 'vm') {
    vmRuntimeGate.required = true;
    vmRuntimeGate.ready = false;
    startVmBootForSplash().catch((e) => { console.warn('[vm] boot failed:', e.message); });
  }
  // 启动时即创建托盘图标（若启用；无头模式无窗口，不需要托盘）
  if (settings.trayEnabled && !HEADLESS) createAppTray();
  // 上轮异常退出 → 独立崩溃报告窗口（延后到主窗口开始加载后，避免抢占启动）
  if (pendingCrashReport && !HEADLESS) setTimeout(() => { try { openCrashReportWindow(); } catch { /* ignore */ } }, 1200);
  // History v2 迁移：启动稳定后空闲执行（图片外置 + 备份），只跑一次
  setTimeout(() => { migrateHistoryV2().catch(() => {}); }, 6000);
  // 模型元数据（models.dev）后台预热：24h 磁盘缓存，失败静默走硬编码兜底
  setTimeout(() => { fetchModelsDevData().catch(() => {}); }, 8000);

  // ===== 语音子系统初始化（STT/TTS/唤醒，全本地 sherpa-onnx） =====
  // 启动审计：对应模型未下载时自动关闭语音开关（模型由用户手动下载，不自动拉取）
  try {
    const voiceModels = require('./voice-models');
    const audit = voiceModels.auditVoiceSettings(settings, voiceModels.searchRoots(app, settings));
    if (audit.changed) {
      console.warn('[voice] models missing, voice toggles disabled:', audit.disabled.join(', '));
      persistSettings();
    }
  } catch (e) {
    console.warn('[voice] model audit failed:', e.message);
  }
  try {
    const { initVoice } = require('./voice-ipc');
    voiceIpc = initVoice({
      ipcMain,
      app,
      getSettings: () => settings,
      persistSettings: () => { try { saveJSON(settingsPath, settings); } catch {} },
      getMainWindow: () => mainWindow,
      showWindowFromTray,
      onVoiceEvent: (channel, payload) => {
        // P2：转发到 WebUI（web-control-service 注册回调）
        try { if (webControlService && typeof webControlService.pushVoiceEvent === 'function') webControlService.pushVoiceEvent(channel, payload); } catch {}
      },
    });
    // P2：同步语音能力到 WebUI（浏览器麦克风按钮依赖）。
    // worker 仅在语音确实启用时预热：sherpa 原生推理库未使用时加载会白白占用内存，
    // 且原生模块故障会直接杀死主进程。
    (async () => {
      try {
        if (!voiceIpc || !voiceIpc.engine) return;
        const voiceWanted = !!(settings.voice && (settings.voice.sttEnabled || settings.voice.ttsEnabled || settings.voice.wakeEnabled));
        if (voiceWanted) await voiceIpc.engine.ensureWorker().catch(() => {});
        const st = voiceIpc.getStatus ? voiceIpc.getStatus() : null;
        if (st && webControlService) webControlService.setVoiceCapabilities(st);
      } catch {}
    })();
    // WebUI → 引擎反向桥（Web 端采集的音频 → STT 引擎）
    if (webControlService) {
      webControlService.onVoiceAudio = (sessionId, buf) => {
        try { if (voiceIpc && voiceIpc.engine) voiceIpc.engine.feedStt(sessionId, buf); } catch {}
      };
      webControlService.onVoiceSttControl = (msg) => {
        try {
          if (!voiceIpc || !voiceIpc.engine) return;
          if (msg.action === 'start') voiceIpc.engine.startStt(msg.sessionId, {}).catch(() => {});
          else if (msg.action === 'stop') voiceIpc.engine.stopStt(msg.sessionId);
          else if (msg.action === 'cancel') voiceIpc.engine.cancelStt(msg.sessionId);
        } catch {}
      };
    }
  } catch (e) {
    console.error('[voice] init failed:', e);
  }
});
// 关闭所有窗口时：若启用了托盘模式且非真正退出，不退出应用（保留托盘）
app.on('window-all-closed', (event) => {
  if (isQuitting) {
    // 真正退出：放行默认行为
    return;
  }
  // 托盘模式启用时：保持应用运行
  if (settings.trayEnabled && settings.closeToTray !== 'never') {
    event.preventDefault();
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  // 无头模式没有可恢复的窗口
  if (HEADLESS) return;
  // macOS dock 点击：如果窗口被隐藏，重新显示
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    showWindowFromTray();
  }
});

// ---- IPC: Window Controls ----
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('window:maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return mainWindow.isMaximized(); } });
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('window:isMaximized', () => mainWindow ? mainWindow.isMaximized() : false);

// ---- IPC: Tray Mode ----
// 渲染器响应"关闭时询问"模态框的决策
ipcMain.on('tray:respond-close-decision', (_, decision) => {
  // decision: 'always' | 'once' | 'never' | 'cancel'
  if (decision === 'always' || decision === 'once' || decision === 'never') {
    // 'always' / 'never' 持久化到设置；'once' 仅本次会话生效
    if (decision === 'always' || decision === 'never') {
      settings.closeToTray = decision;
      try { saveJSON(settingsPath, settings); } catch {}
    } else if (decision === 'once') {
      // 'once' 仅修改内存中的设置（不持久化），下次启动会再次询问
      settings.closeToTray = 'once';
    }
  }
  resolveCloseToTrayDecision(decision === 'cancel' ? null : decision);
});

// 修改托盘设置（从设置页调用）
ipcMain.handle('tray:set-close-to-tray', async (_, mode) => {
  if (!['ask', 'always', 'never', 'once'].includes(mode)) {
    return { ok: false, error: 'Invalid mode' };
  }
  settings.closeToTray = mode;
  try { saveJSON(settingsPath, settings); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, settings };
});

ipcMain.handle('tray:set-enabled', async (_, enabled) => {
  settings.trayEnabled = !!enabled;
  try { saveJSON(settingsPath, settings); } catch (e) { return { ok: false, error: e.message }; }
  // 实时创建/销毁托盘
  if (settings.trayEnabled && !appTray) {
    createAppTray();
  } else if (!settings.trayEnabled && appTray) {
    try { appTray.destroy(); } catch {}
    appTray = null;
  }
  return { ok: true, settings };
});

// 手动隐藏到托盘（设置页"立即测试"按钮）
ipcMain.handle('tray:hide-to-tray', () => {
  hideWindowToTray();
  return { ok: true };
});

// 手动从托盘显示窗口
ipcMain.handle('tray:show-window', () => {
  showWindowFromTray();
  return { ok: true };
});

// ---- IPC: Settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, newSettings) => {
  const previousLocation = settings.runtime?.location;
  const prevVoice = settings.voice ? JSON.parse(JSON.stringify(settings.voice)) : null;
  const prevProxyJson = JSON.stringify(settings.proxy || null);
  const tokenPolicy = require('../shared/token-policy');
  const patch = tokenPolicy.migratePatch(newSettings);
  settings = tokenPolicy.normalize(mergeSettings(settings, patch));
  tokenPolicy.syncActiveEntry(settings, patch);
  if (settings.runtime?.location !== previousLocation) {
    require('./vm/tool-location').withRuntimeLocation(() => vmService, () => pluginManager.refreshAll()).catch(error => console.warn('[DS Plugins] location change:', error.message));
  }
  // 模型池 → 旧 llm.* 字段投影（游戏/标题等非 Agent 调用继续可用）
  try { projectActivePoolEntry(); } catch (_) {}
  // 决策模型配置变更时清空决策缓存
  try { if (newSettings && newSettings.decision) decisionService.clearCache(); } catch (_) {}
  scheduleSettingsPersist();
  // 代理设置变化时自动重应用（含导入/其他页面保存，无需依赖 proxy:apply IPC）
  const newProxyJson = JSON.stringify(settings.proxy || null);
  if (newProxyJson !== prevProxyJson) {
    applyProxySettings(settings.proxy).then(() => {
      try { fedikittenService.refreshProxy(settings.proxy); } catch { /* ignore */ }
      if (aria2Manager.ready) return aria2Manager.start(settings.proxy);
      return null;
    }).catch((e) => console.warn('[Proxy] failed to apply proxy after settings change:', e.message));
  }
  // 广播主题/语言变化到所有窗口（主窗口 + 子窗口 CAD/EDA/小游戏）
  broadcastThemeChanged();
  broadcastSettingsChanged();
  // 语音设置热应用（唤醒开关/词表/热键）
  if (voiceIpc && newSettings && newSettings.voice) {
    voiceIpc.onSettingsChanged(prevVoice).catch((e) => console.warn('[voice] onSettingsChanged:', e.message));
  }
  // 托盘菜单勾选状态与设置保持联动（语音唤醒开关）
  rebuildTrayMenu();
  // P2：语音能力状态同步到 WebUI
  try {
    if (voiceIpc && webControlService) {
      const st = voiceIpc.getStatus ? voiceIpc.getStatus() : null;
      if (st) webControlService.setVoiceCapabilities(st);
    }
  } catch {}
  return settings;
});

// ---- IPC: DeepSeek 插件管理 ----
const broadcastPluginsChanged = () => {
  try { mainWindow?.webContents?.send('plugins:changed'); } catch { /* ignore */ }
};
ipcMain.handle('plugins:list', () => ({ ok: true, plugins: pluginManager.list() }));
ipcMain.handle('plugins:installLocal', async (event, dirPath) => {
  try {
    const plugin = await pluginManager.install({ type: 'local', ref: dirPath }, {
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('plugins:installProgress', p); }
    });
    broadcastPluginsChanged();
    return { ok: true, plugin };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('plugins:installNpm', async (event, name) => {
  try {
    const plugin = await pluginManager.install({ type: 'npm', ref: name }, {
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('plugins:installProgress', p); }
    });
    broadcastPluginsChanged();
    return { ok: true, plugin };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('plugins:installGithub', async (event, repo) => {
  try {
    const plugin = await pluginManager.install({ type: 'github', ref: repo }, {
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('plugins:installProgress', p); }
    });
    broadcastPluginsChanged();
    return { ok: true, plugin };
  } catch (e) { return { ok: false, error: e.message, catalog: Array.isArray(e.catalog) ? e.catalog : null, catalogKind: e.catalogKind || null }; }
});
ipcMain.handle('plugins:installTgz', async (event, filePath) => {
  try {
    const plugin = await pluginManager.install({ type: 'tgz', ref: filePath }, {
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('plugins:installProgress', p); }
    });
    broadcastPluginsChanged();
    return { ok: true, plugin };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('plugins:update', async (event, id, ref) => {
  try {
    const res = await pluginManager.update(id, {
      ref: ref || null,
      onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('plugins:installProgress', p); }
    });
    broadcastPluginsChanged();
    return res;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('plugins:setEnabled', async (_, id, enabled) => {
  const r = await pluginManager.setEnabled(id, !!enabled);
  broadcastPluginsChanged();
  return r;
});
ipcMain.handle('plugins:uninstall', async (_, id) => {
  const r = await pluginManager.uninstall(id);
  broadcastPluginsChanged();
  return r;
});
ipcMain.handle('plugins:setConfig', async (_, id, patch) => {
  const r = await pluginManager.setConfig(id, patch);
  broadcastPluginsChanged();
  return r;
});
ipcMain.handle('ds:toolCall', async (_, pluginId, toolName, args, execCtx = {}) => {
  try {
    if (vmLocationActive()) {
      const record = pluginManager.plugins.find((plugin) => plugin.id === pluginId && plugin.enabled);
      if (!record) return { ok: false, error: '插件未启用', location: 'vm' };
      return await require('./vm/vm-tool-runtime').runGuestPlugin(vmService, record, toolName, args || {}, execCtx);
    }
    return await pluginManager.callTool(pluginId, toolName, args, execCtx);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('ds:listTools', () => ({
  ok: true,
  plugins: pluginManager.list().filter(p => p.enabled && p.toolCount > 0)
}));

// 渲染进程会话注册表同步 → 插件宿主的 agents/sessions seam
ipcMain.handle('ds:agentsSync', async (_, entries) => {
  try {
    await pluginManager.syncAgents(entries);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 渲染进程授权/问卷模态框的裁决回传
ipcMain.handle('ds:approvalRespond', (_, id, outcome) => {
  const settle = dsRequestPending.get(id);
  if (!settle) return { ok: false, error: 'approval 请求不存在或已超时' };
  dsRequestPending.delete(id);
  settle(outcome);
  return { ok: true };
});

// ---- 自动化任务 IPC ----
ipcMain.handle('automation:list', () => ({ ok: true, tasks: automationManager.list(), server: automationManager.serverInfo() }));
// 自动化触发设置（设置 → 自动化）：校验 + 持久化 + 热应用（fail-closed）
ipcMain.handle('automation:updateSettings', async (_, cfg) => {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '参数无效' };
  const crypto = require('crypto');
  try {
    const cur = normalizeAutomationSettings(settings.automation);
    if (typeof cfg.enabled === 'boolean') cur.enabled = cfg.enabled;
    if (typeof cfg.allowNoToken === 'boolean') cur.allowNoToken = cfg.allowNoToken;
    if (cfg.serverPort !== undefined) {
      const p = Number(cfg.serverPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: '端口需在 1-65535' };
      cur.serverPort = p;
    }
    if (cfg.tokens !== undefined) {
      if (!Array.isArray(cfg.tokens)) return { ok: false, error: 'tokens 需为数组' };
      const knownTaskIds = new Set(automationManager.list().map(t => t.id));
      const next = [];
      for (const t of cfg.tokens) {
        if (!t || typeof t !== 'object') continue;
        let value = String(t.value || '').trim();
        if (!value) {
          value = crypto.randomBytes(24).toString('base64url'); // 空值自动生成
        }
        if (value.length > 128) return { ok: false, error: 'token 值过长（≤128）' };
        const name = String(t.name || '').trim().slice(0, 64) || '未命名';
        const expiresAt = (Number.isFinite(Number(t.expiresAt)) && Number(t.expiresAt) > 0)
          ? Math.floor(Number(t.expiresAt)) : 0;
        let scope = 'all';
        if (Array.isArray(t.scope)) {
          // 过滤已被删除的任务 id；空数组保持为空（该 token 无法触发任何任务，最安全）
          scope = [...new Set(t.scope.map(s => String(s)).filter(id => knownTaskIds.has(id)))];
        }
        next.push({
          id: String(t.id || '').trim() || 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          name,
          value,
          scope,
          allowParams: t.allowParams !== false,
          expiresAt,
          createdAt: (Number.isFinite(Number(t.createdAt)) && Number(t.createdAt) > 0)
            ? Math.floor(Number(t.createdAt)) : Date.now()
        });
      }
      cur.tokens = next;
    }
    settings = { ...settings, automation: cur };
    saveJSON(settingsPath, settings);
    broadcastSettingsChanged();
    await automationManager.refreshServer();
    return { ok: true, settings: settings.automation, server: automationManager.serverInfo() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// 生成一个新的随机 token 值（不落盘，由 updateSettings 保存）
ipcMain.handle('automation:generateTokenValue', async () => {
  const crypto = require('crypto');
  return { ok: true, value: crypto.randomBytes(24).toString('base64url') };
});
ipcMain.handle('automation:get', (_, id) => {
  const task = automationManager.list().find(t => t.id === id);
  return task ? { ok: true, task } : { ok: false, error: '任务不存在' };
});
ipcMain.handle('automation:guide', (_, topic) => {
  try { return { ok: true, guide: getAutomationGuide(topic) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation:save', (_, task) => {
  try { return { ok: true, task: automationManager.upsert(task) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation:delete', (_, id) => ({ ok: automationManager.remove(id) }));
ipcMain.handle('automation:setEnabled', (_, id, enabled) => {
  const task = automationManager.setEnabled(id, !!enabled);
  return task ? { ok: true, task } : { ok: false, error: '任务不存在' };
});
ipcMain.handle('automation:run', async (_, id, params) => {
  try {
    const result = await automationManager.run(id, { kind: 'manual', params: params || {}, time: new Date().toISOString() });
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('automation:test', async (_, task, params) => {
  try {
    const result = await automationManager.test(task, params || {});
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on('automation:dispatched', (event, requestId, payload) => {
  const settle = dsRequestPending.get(requestId);
  if (!settle) return;
  dsRequestPending.delete(requestId);
  settle(payload || {});
});
ipcMain.on('ds:agentCreateResult', (event, requestId, payload) => {
  const settle = dsRequestPending.get(requestId);
  if (!settle) return;
  dsRequestPending.delete(requestId);
  settle(payload || {});
});
ipcMain.on('ds:agentResumeResult', (event, requestId, payload) => {
  const settle = dsRequestPending.get(requestId);
  if (!settle) return;
  dsRequestPending.delete(requestId);
  settle(payload || {});
});

// ---- 自动化编辑器独立窗口 ----
ipcMain.handle('automation-editor:open', (_, payload = {}) => {
  if (automationEditorWindow && !automationEditorWindow.isDestroyed()) {
    automationEditorWindow.webContents.send('automation-editor:open-request', payload);
    automationEditorWindow.focus();
    return { ok: true };
  }
  automationEditorWindow = new BrowserWindow({
    width: 1240, height: 860, minWidth: 960, minHeight: 660,
    title: '自动化任务编辑器',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: settings.theme?.backgroundColor || '#f5f7fa',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/generated/automation-editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const query = {};
  if (payload?.id) query.id = String(payload.id);
  automationEditorWindow.loadFile(path.join(__dirname, '../renderer/pages/automation-editor.html'), { query });
  automationEditorWindow.on('closed', () => { automationEditorWindow = null; });
  return { ok: true };
});
ipcMain.handle('automation-editor:close', () => {
  if (automationEditorWindow && !automationEditorWindow.isDestroyed()) automationEditorWindow.close();
  return { ok: true };
});

// environment: explicit dependencies; mutable app state is read through getters.
require('./ipc/environment')({
  fs,
  path,
  spawnSync,
  ipcMain,
  getSettings: () => settings,
  vmService
});

// ---- IPC: Theme ----
ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode, theme: settings.theme }));
// 广播主题变化到所有 BrowserWindow（含子窗口 CAD/EDA/小游戏）
function broadcastThemeChanged() {
  codeOSSService.syncPersonalization();
  vmService.syncAppearance().catch((error) => console.warn('[vm] Appearance synchronization failed:', error.message));
  const payload = { shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('theme:changed', payload);
      // 子窗口还需要完整主题（accent/bg）以应用强调色
      win.webContents.send('theme:apply', { theme: settings.theme, shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
    }
  }
}
function broadcastSettingsChanged() {
  codeOSSService.syncPersonalization();
  const payload = { language: settings.language, theme: settings.theme, ime: settings.ime, voice: settings.voice };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', payload);
  }
}
let _usageBroadcastTimer = null;
function broadcastUsageChanged() {
  if (_usageBroadcastTimer) clearTimeout(_usageBroadcastTimer);
  _usageBroadcastTimer = setTimeout(() => {
    _usageBroadcastTimer = null;
    const todayKey = getTodayKeyTZ(settings.budget?.timezone || 'UTC');
    const dayData = (settings.llm.usageHistory || {})[todayKey] || null;
    const payload = {
      dailyTokensUsed: settings.llm.dailyTokensUsed || 0,
      today: dayData ? {
        totalTokens: dayData.totalTokens || 0,
        promptTokens: dayData.promptTokens || 0,
        completionTokens: dayData.completionTokens || 0,
        requestCount: dayData.requestCount || 0,
        costUSD: dayData.costUSD || 0
      } : null
    };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('usage:changed', payload);
    }
  }, 250);
}
nativeTheme.on('updated', () => broadcastThemeChanged());

// ---- IPC: Memory ----
ipcMain.handle('memory:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return memory.filter(m => (m.content || '').toLowerCase().includes(q) || (m.tags || []).some(t => t.toLowerCase().includes(q)));
});
ipcMain.handle('memory:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  memory.push(item);
  saveJSON(memoryPath, memory);
  return item;
});
ipcMain.handle('memory:delete', (_, id) => {
  memory = memory.filter(m => m.id !== id);
  saveJSON(memoryPath, memory);
  return true;
});
ipcMain.handle('memory:update', (_, { id, data }) => {
  const idx = memory.findIndex(m => m.id === id);
  if (idx >= 0) { memory[idx] = { ...memory[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(memoryPath, memory); return memory[idx]; }
  return null;
});

// ---- IPC: Knowledge Base ----
ipcMain.handle('knowledge:search', (_, query) => {
  const q = (query || '').toLowerCase();
  return knowledge.filter(k => (k.content || '').toLowerCase().includes(q) || (k.title || '').toLowerCase().includes(q));
});
ipcMain.handle('knowledge:add', (_, item) => {
  item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  item.createdAt = new Date().toISOString();
  knowledge.push(item);
  saveJSON(knowledgePath, knowledge);
  return item;
});
ipcMain.handle('knowledge:delete', (_, id) => {
  knowledge = knowledge.filter(k => k.id !== id);
  saveJSON(knowledgePath, knowledge);
  return true;
});
ipcMain.handle('knowledge:update', (_, { id, data }) => {
  const idx = knowledge.findIndex(k => k.id === id);
  if (idx >= 0) { knowledge[idx] = { ...knowledge[idx], ...data, updatedAt: new Date().toISOString() }; saveJSON(knowledgePath, knowledge); return knowledge[idx]; }
  return null;
});

// files: explicit dependencies; mutable app state is read through getters.
require('./ipc/files')({
  ipcMain,
  fs,
  normalizeEncodingName,
  detectEolFromBuffer,
  detectFileEncoding,
  writeTextFileWithEncoding,
  path,
  readTextWithEncoding
});

// ---- IPC: Terminal Management ----
// 终端架构：
//   - agentBuffer: 破坏性读取（Agent 通过 buffer() 消费后清空）
//   - fullHistory: 追加式历史（用于 xterm.js 显示，上限 100KB 防止内存膨胀）
//   - 实时通过 terminal:data / terminal:exit 事件推送到渲染器，让 xterm 即时显示
//   - 元数据（cwd、createdAt、lastCommand）用于终端标签页展示
// 实现已拆分到 ./terminal-service.js，这里注入窗口与设置访问器。
registerTerminalIpc({
  ipcMain,
  getMainWindow: () => mainWindow,
  getSettings: () => settings,
  // 运行位置=虚拟机时，终端改由 VM 内 PTY 承载（vm-pty 适配器）
  getVmService: () => vmService
});

// ---- FFmpeg / FFprobe 媒体工具集 ----
registerFfmpegIpc({ ipcMain, getVmService: () => vmService });

// ---- IPC: Clipboard ----
// VM 模式：剪贴板必须作用于虚拟机（X11 selection via xclip），不能落到宿主机剪贴板
ipcMain.handle('clipboard:read', async () => {
  try {
    if (vmLocationActive()) {
      try {
        const r = await vmService.graphicsController().clipboardGet();
        return { ok: true, content: r.text || '', location: 'vm' };
      } catch (e) {
        return { ok: false, error: '虚拟机剪贴板不可用: ' + e.message + '（需要图形栈：设置页可一键准备）' };
      }
    }
    return { ok: true, content: clipboard.readText(), location: 'host' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('clipboard:write', async (_, text) => {
  try {
    if (vmLocationActive()) {
      try {
        await vmService.graphicsController().clipboardSet(text);
        return { ok: true, location: 'vm' };
      } catch (e) {
        return { ok: false, error: '虚拟机剪贴板不可用: ' + e.message + '（需要图形栈：设置页可一键准备）' };
      }
    }
    clipboard.writeText(text);
    return { ok: true, location: 'host' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Computer Use / 截图 / 系统信息 / shell 打开（实现已拆分）----
registerComputerUseIpc({
  ipcMain,
  getSettings: () => settings,
  persistSettings,
  getImagesDir: () => imagesDir,
  getVmService: () => vmService
});

// Host handlers; VM routing executes the same service inside the Linux guest.
ipcMain.handle('eslint:isLintable', (_, workspacePath) => ({ok:true,lintable:ESLintService.isProjectLintable(workspacePath)}));
ipcMain.handle('eslint:lint', (_, workspacePath, options) => ESLintService.lintWorkspace(workspacePath,options));
ipcMain.handle('eslint:lintFile', (_, filePath) => ESLintService.lintSingleFile(filePath));
ipcMain.handle('eslint:clearCache', (_, workspacePath) => { ESLintService.clearCache(workspacePath); return {ok:true}; });

ipcMain.handle('calc:evaluate', async (_, expression) => {
  try {
    const result = mathTools.evaluateCalcExpression(expression);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:factorInteger', async (_, value) => {
  try {
    return { ok: true, ...mathTools.factorInteger(value) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:gcdLcm', async (_, values) => {
  try {
    return { ok: true, ...mathTools.calcGcdLcm(values) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:baseConvert', async (_, value, fromBase, toBase) => {
  try {
    return { ok: true, ...mathTools.convertBase(value, fromBase, toBase) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:factorial', async (_, n) => {
  try {
    return { ok: true, ...mathTools.calcFactorial(Number(n)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:complexMath', async (_, operation, a, b, exponent) => {
  try {
    return { ok: true, ...mathTools.complexMath(operation, a, b, exponent) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:matrixMath', async (_, operation, A, B) => {
  try {
    return { ok: true, ...mathTools.matrixMath(operation, A, B) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:vectorMath', async (_, operation, a, b, c) => {
  try {
    return { ok: true, ...mathTools.vectorMath(operation, a, b, c) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solveInequality', async (_, coefficients, relation, variable) => {
  try {
    return { ok: true, ...mathTools.solveInequality(coefficients, relation, variable) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solveLinearSystem', async (_, A, b) => {
  try {
    return { ok: true, ...mathTools.solveLinearSystem(A, b) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:solvePolynomial', async (_, coefficients) => {
  try {
    return { ok: true, ...mathTools.solvePolynomial(coefficients) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:distributionCalc', async (_, distribution, operation, params, x) => {
  try {
    return { ok: true, ...mathTools.distributionCalc(distribution, operation, params || {}, x) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:combinatorics', async (_, operation, n, r, repetition) => {
  try {
    return { ok: true, ...mathTools.combinatorics(operation, n, r, repetition) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('calc:fractionBaseConvert', async (_, value, fromBase, toBase, precision) => {
  try {
    return { ok: true, ...mathTools.fractionBaseConvert(value, fromBase, toBase, precision) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: 沙箱状态/自检 ----
ipcMain.handle('sandbox:getStatus', () => {
  const backend = sandboxRunner.detectBackend();
  return {
    ok: true,
    config: settings.sandbox || {},
    backend: backend.backend,
    backendAvailable: backend.available,
    enforcement: backend.enforcement,
    detail: backend.detail,
    platform: process.platform
  };
});

ipcMain.handle('sandbox:probe', () => {
  const backend = sandboxRunner.detectBackend();
  if (!backend.available) {
    return { ok: false, error: backend.detail, backend: backend.backend, available: false };
  }
  try {
    // 只读模式自检：受限子进程应能运行（读/执行不受限），但写入被拒绝
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-sb-probe-'));
    const tmpFile = path.join(probeDir, 'probe.txt');
    const probeArgv = process.platform === 'win32'
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
         `Set-Content -LiteralPath '${tmpFile}' -Value 'x'`]
      : ['/bin/sh', '-c', `echo ok > ${tmpFile}`];
    const wrapped = sandboxRunner.confine(probeArgv, {
      mode: 'read-only',
      workspaceRoot: probeDir
    });
    const { spawnSync } = require('child_process');
    const r = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const denied = fs.existsSync(tmpFile) === false;
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
    return {
      ok: true,
      backend: backend.backend,
      available: true,
      enforcement: wrapped.enforcement,
      readOnlyWriteDenied: denied,
      exitCode: r.status
    };
  } catch (e) {
    return { ok: false, error: e.message, backend: backend.backend, available: backend.available };
  }
});

// ---- 沙箱辅助：把 spawn argv 包装进受限执行；受限模式后端不可用时 fail-closed ----
function sandboxConfineFor(sandboxMode, workspacePath, argv) {
  if (!sandboxMode || sandboxMode === 'danger-full-access') return { argv };
  try {
    return sandboxRunner.confine(argv, { mode: sandboxMode, workspaceRoot: workspacePath });
  } catch (e) {
    return { error: e };
  }
}

// ---- IPC: Run JS Code (sandboxed) ----
// Windows 受限执行（ACL 后端）：node 的 IPC 通道无法穿越中间进程（已知限制，
// 经 cmd.exe / C 启动器实测均不投递消息），改用"代码文件 + stdout JSON"方案。
function runJSConfinedWin32(runnerPath, code, cwd, sandboxMode, workspacePath) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const codeFile = path.join(os.tmpdir(), `cibyp-js-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`);
    try {
      fs.writeFileSync(codeFile, code, 'utf-8');
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const wrapped = sandboxConfineFor(sandboxMode, workspacePath, [process.execPath, runnerPath, codeFile]);
    if (wrapped.error) {
      try { fs.unlinkSync(codeFile); } catch {}
      return resolve({ ok: false, error: wrapped.error.message, code: wrapped.error.code, sandboxUnavailable: true });
    }
    const execOpts = { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
    if (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) execOpts.cwd = cwd;
    execFile(wrapped.argv[0], wrapped.argv.slice(1), execOpts, (err, stdout, stderr) => {
      try { fs.unlinkSync(codeFile); } catch {}
      if (err) {
        resolve({ ok: false, error: err.message, stderr: stderr || '', sandboxDenied: sandboxRunner.isSandboxDenial(true, stderr) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.error
          ? { ok: false, error: parsed.error, sandboxed: true }
          : { ok: true, output: parsed.output, result: parsed.result, sandboxed: true });
      } catch {
        resolve({ ok: false, error: stderr || stdout || 'runner 输出解析失败' });
      }
    });
  });
}

// ---- 运行位置=虚拟机：脚本类工具路由到 VM 内执行 ----
// 语义变化（工具描述已注明）：VM 模式下 runShell/runPython/runNodeJS/runJS 在隔离环境内执行，
// 只有 guest 里存在的运行时（bash/python3/node）可用，宿主 API 不可用。
function qemuRuntimeVersionSafe(exe) {
  try { return require('./vm/qemu-runtime').qemuVersion(exe); } catch { return null; }
}
function vmLocationActive() {
  return require('./vm/tool-location').isVmOperation(() => vmService);
}

/**
 * 在 VM 内执行脚本：写临时文件 → 解释器执行 → 收集输出。
 * shared 模式：执行前推送宿主改动（让 VM 看到最新文件），执行后拉回 VM 改动。
 * @param {'shell'|'python'|'node'} interpreter
 */
async function runScriptInVm(script, cwd, interpreter) {
  try {
    if (!vmService.instance || vmService.instance.state !== 'ready') await vmService.start();
    const inst = vmService.instance;
    if (!inst || inst.state !== 'ready') return { ok: false, error: '虚拟机未就绪', location: 'vm' };
    const shared = (settings.runtime || {}).workspaceMode !== 'isolated';
    let syncNote = '';
    const ext = interpreter === 'python' ? 'py' : interpreter === 'node' ? 'js' : 'sh';
    const remote = `/tmp/cibyp-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const sftp = await inst.sftp();
    await sftp.writeFile(remote, String(script));
    const vmCwd = await vmService.prepareTerminalDirectory(cwd);
    const runner = interpreter === 'python' ? 'python3 -u' : interpreter === 'node' ? 'node' : 'bash';
    // 统一 UTF-8（否则 guest 内工具会把中文名写成乱码）
    const cmd = `export LANG=C.UTF-8 LC_ALL=C.UTF-8; cd ${require('./vm/vm-paths').shellQuote(vmCwd)} && ${runner} ${remote}; rc=$?; rm -f ${remote}; exit $rc`;
    const r = await inst.exec(cmd, { timeoutMs: 120000 });
    if (shared) {
      try {
        const post = await vmService.syncWorkspace({ direction: 'pull', reason: 'post-tool' });
        if (post && !post.ok && post.error) syncNote += `[工作区同步] ${post.error}\n`;
      } catch (e) { syncNote += `[工作区同步] ${e.message}\n`; }
    }
    const stderr = (syncNote + (r.stderr || '')).trim();
    if (r.ok) return { ok: true, output: r.stdout, stderr, location: 'vm', sandboxed: true };
    return {
      ok: false,
      error: stderr || `进程退出码 ${r.code}`,
      stderr,
      output: r.stdout,
      code: r.code,
      location: 'vm',
      sandboxed: true,
    };
  } catch (e) {
    return { ok: false, error: e.message, location: 'vm' };
  }
}

ipcMain.handle('code:runJS', (_, code, cwd, sandboxMode) => {
  if (vmLocationActive()) return runScriptInVm(code, cwd, 'node');
  const restrictedWin32 = process.platform === 'win32' && sandboxMode && sandboxMode !== 'danger-full-access';
  if (restrictedWin32) {
    return runJSConfinedWin32(path.join(__dirname, '../tools/js-runner.js'), code, cwd, sandboxMode, cwd);
  }
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const forkOpts = { silent: true, timeout: 30000 };
    if (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) forkOpts.cwd = cwd;
    const runnerPath = path.join(__dirname, '../tools/js-runner.js');
    const wrapped = sandboxConfineFor(sandboxMode, cwd, [process.execPath, runnerPath]);
    if (wrapped.error) {
      return resolve({ ok: false, error: wrapped.error.message, code: wrapped.error.code, sandboxUnavailable: true });
    }
    if (wrapped.argv.length > 2) {
      // 受限模式：execPath=包装器（sandbox-exec/bwrap），execArgv=包装参数，modulePath 由 fork 追加
      forkOpts.execPath = wrapped.argv[0];
      forkOpts.execArgv = wrapped.argv.slice(1, -1);
    }
    const runner = fork(runnerPath, [], forkOpts);
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run JS Code (Node.js enabled) ----
ipcMain.handle('code:runNodeJS', (_, code, cwd, sandboxMode) => {
  if (vmLocationActive()) return runScriptInVm(code, cwd, 'node');
  const restrictedWin32 = process.platform === 'win32' && sandboxMode && sandboxMode !== 'danger-full-access';
  if (restrictedWin32) {
    return runJSConfinedWin32(path.join(__dirname, '../tools/js-runner-node.js'), code, cwd, sandboxMode, cwd);
  }
  return new Promise((resolve) => {
    const { fork } = require('child_process');
    const forkOpts = { silent: true, timeout: 30000 };
    if (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) forkOpts.cwd = cwd;
    const runnerPath = path.join(__dirname, '../tools/js-runner-node.js');
    const wrapped = sandboxConfineFor(sandboxMode, cwd, [process.execPath, runnerPath]);
    if (wrapped.error) {
      return resolve({ ok: false, error: wrapped.error.message, code: wrapped.error.code, sandboxUnavailable: true });
    }
    if (wrapped.argv.length > 2) {
      forkOpts.execPath = wrapped.argv[0];
      forkOpts.execArgv = wrapped.argv.slice(1, -1);
    }
    const runner = fork(runnerPath, [], forkOpts);
    let output = '';
    let error = '';
    runner.stdout.on('data', d => { output += d.toString(); });
    runner.stderr.on('data', d => { error += d.toString(); });
    runner.on('message', msg => { resolve({ ok: true, result: msg }); });
    runner.on('exit', code => {
      if (code !== 0) resolve({ ok: false, error: error || `Process exited with code ${code}` });
      else resolve({ ok: true, output });
    });
    runner.send({ code });
    setTimeout(() => { try { runner.kill(); } catch {} resolve({ ok: false, error: '执行超时' }); }, 30000);
  });
});

// ---- IPC: Run Shell Script ----
const shellJobs = new (require('./services/shell-jobs').ShellJobs)({
  getVmService: () => vmService,
  isVmOperation: vmLocationActive,
  confine: sandboxConfineFor,
  isSandboxDenial: (confined, stderr) => sandboxRunner.isSandboxDenial(confined, stderr),
});
const shellJobWindows = new WeakSet();
ipcMain.handle('code:runShell', (event, script, cwd, sandboxMode, options) => {
  const owner = options?.sessionKey || 'window:' + event.sender.id;
  if (!options?.sessionKey && !shellJobWindows.has(event.sender)) {
    shellJobWindows.add(event.sender);
    event.sender.once('destroyed', () => { shellJobs.releaseOwner(owner).catch(() => {}); });
  }
  return shellJobs.run(script, cwd, sandboxMode, { ...options, sessionKey: owner });
});
app.on('will-quit', () => { shellJobs.dispose().catch(() => {}); });

// ---- IPC: Run Python Script ----
ipcMain.handle('code:runPython', (_, script, cwd, sandboxMode) => {
  if (vmLocationActive()) return runScriptInVm(script, cwd, 'python');
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const tmpFile = path.join(os.tmpdir(), `skill_py_${Date.now()}.py`);
    let settled = false;
    const cleanup = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };
    try {
      fs.writeFileSync(tmpFile, script, 'utf-8');
    } catch (e) {
      return finish({ ok: false, error: e.message });
    }

    const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    let idx = 0;
    const attempt = () => {
      if (idx >= candidates.length) {
        finish({ ok: false, error: '未找到 Python，请安装 python3 后重试' });
        return;
      }
      const bin = candidates[idx++];
      const execOpts = { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
      if (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) execOpts.cwd = cwd;
      let execBin = bin;
      let execArgs = ['-u', tmpFile];
      let confined = null;
      const wrapped = sandboxConfineFor(sandboxMode, cwd, [execBin, ...execArgs]);
      if (wrapped.error) {
        finish({ ok: false, error: wrapped.error.message, code: wrapped.error.code, sandboxUnavailable: true });
        return;
      }
      execBin = wrapped.argv[0];
      execArgs = wrapped.argv.slice(1);
      confined = wrapped;
      execFile(execBin, execArgs, execOpts, (err, stdout, stderr) => {
        if (err && idx < candidates.length && (err.code === 'ENOENT' || /not found|找不到|No such file/i.test(err.message))) {
          attempt();
          return;
        }
        if (err) finish({ ok: false, error: err.message, stderr: stderr || '', sandboxDenied: sandboxRunner.isSandboxDenial(confined?.confined, stderr) });
        else finish({ ok: true, output: stdout || '', stderr: stderr || '', sandboxed: !!confined?.confined });
      });
    };
    attempt();
  });
});

// ---- IPC: Image Generation（多厂商适配见 image-gen.js）----
ipcMain.handle('image:generate', async (_, prompt, workspacePath) => {
  try {
    const imageGen = require('./image-gen');
    const g = imageGen.normalizeImageGenConfig(settings.imageGen);
    if (!g.apiUrl) return { ok: false, error: '请先在设置中配置生图 API URL' };
    if (!g.model) return { ok: false, error: '请先在设置中配置生图模型名称' };

    resetDailyUsageIfNeeded();
    const maxImages = g.dailyMaxImages || 0;
    if (maxImages > 0 && g.dailyImagesUsed >= maxImages) {
      return { ok: false, error: '已达到今日生图上限，请明天再试' };
    }

    let req;
    try {
      req = imageGen.buildImageRequest(g, prompt);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    // 请求头：厂商鉴权 + 用户自定义头 + URL 命中 opencode.ai 时自动附加官方头组
    req.headers = ocHeaders.applyProviderHeaders({
      url: req.url,
      headers: req.headers,
      llm: settings.imageGen
    });
    console.log(`[IMG ${logTs()}] → POST ${maskLogUrl(req.url)} provider=${g.provider} model=${g.model} size=${g.imageSize} n=${g.n} prompt="${logSnippet(prompt, 80)}"`);

    const imgStartedAt = Date.now();
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(imageGen.DEFAULT_TIMEOUT_MS)
    });
    const parsed = await imageGen.extractImages(req.kind, response, g);
    if (!parsed.images || parsed.images.length === 0) {
      console.error(`[IMG ${logTs()}] ✗ ${response.status} (${Date.now() - imgStartedAt}ms) provider=${g.provider} model=${g.model}: ${parsed.error || 'no valid image returned'}`);
      return { ok: false, error: parsed.error || '生图APIno valid image returned' };
    }

    // Save to workspace if provided, otherwise use imagesDir
    const saveDir = workspacePath || (toolFiles.active() ? '/workspace/_images' : imagesDir);
    await toolFiles.mkdir(saveDir);
    const stamp = Date.now();
    const paths = [];
    for (const [i, img] of parsed.images.entries()) {
      const ext = imageGen.extForMime(img.mime);
      const name = parsed.images.length > 1 ? `generated_${stamp}_${i + 1}.${ext}` : `generated_${stamp}.${ext}`;
      const imgPath = toolFiles.join(saveDir, name);
      await toolFiles.write(imgPath, img.buffer);
      paths.push(imgPath);
    }
    settings.imageGen.dailyImagesUsed = (settings.imageGen.dailyImagesUsed || 0) + paths.length;
    persistSettings();
    console.log(`[IMG ${logTs()}] ✓ ${response.status} (${Date.now() - imgStartedAt}ms) model=${g.model} images=${paths.length} → ${paths.map(p => path.basename(p)).join(', ')}`);

    // file:// URL 需转义空格/中文/# 等字符，否则渲染进程/WebUI 无法加载
    const toFileUrl = (p) => 'file://' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
    return { ok: true, path: paths[0], url: toFileUrl(paths[0]), paths, urls: paths.map(toFileUrl) };
  } catch (e) {
    console.error(`[IMG ${logTs()}] ✗ request failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Image providers（生图厂商预设，供设置页 UI 展示）----
ipcMain.handle('image:providers', () => {
  try {
    const imageGen = require('./image-gen');
    return {
      ok: true,
      current: settings.imageGen.provider,
      providers: Object.values(imageGen.PROVIDERS).map(p => ({
        id: p.id, label: p.label, hint: p.hint, defaultUrl: p.defaultUrl,
        models: p.models || [], sizes: p.sizes || [], auth: p.auth,
      })),
    };
  } catch (e) { return { ok: false, error: e.message, providers: [] }; }
});

require('./ipc/resources')({
  ipcMain,
  getSettings: () => settings,
  vmService,
  saveJSON,
  settingsPath,
  app,
  vmRuntimeGate,
  dialog,
  getMainWindow: () => mainWindow,
  qemuRuntimeVersionSafe,
  fs,
  shell,
  tryShowMainWindow,
  openVmDesktopWindow,
  voiceModelManager,
  persistSettings,
  getVoiceIpc: () => voiceIpc
});

// ---- IPC: 决策模型（Jev / System One）----
ipcMain.handle('decision:call', async (_, payload = {}) => {
  try {
    if (payload.usage && !decisionService.enabledFor(payload.usage)) return { ok: false, error: '该用途未启用' };
    return await decisionService.call(payload.state, payload.questions, { sessionKey: payload.sessionKey });
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('decision:noul', async (_, payload = {}) => {
  try {
    if (payload.usage && !decisionService.enabledFor(payload.usage)) return { value: null, error: '该用途未启用' };
    return await decisionService.noul(payload.state, payload.instructions, payload);
  } catch (e) { return { value: null, error: e.message }; }
});
ipcMain.handle('decision:choice', async (_, payload = {}) => {
  try {
    if (payload.usage && !decisionService.enabledFor(payload.usage)) return { value: null, error: '该用途未启用' };
    return await decisionService.choice(payload.state, payload.instructions, payload.criteria, payload);
  } catch (e) { return { value: null, error: e.message }; }
});
ipcMain.handle('decision:score', async (_, payload = {}) => {
  try {
    if (payload.usage && !decisionService.enabledFor(payload.usage)) return { value: null, error: '该用途未启用' };
    return await decisionService.score(payload.state, payload.instructions, payload.criteria, payload);
  } catch (e) { return { value: null, error: e.message }; }
});
ipcMain.handle('decision:test', async () => {
  try { return await decisionService.test(); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('decision:status', () => {
  const cfg = normalizeDecisionSettings(settings.decision);
  const stamp = getTodayKeyTZ(settings.budget?.timezone || 'UTC');
  const usage = cfg.usage || { date: '', calls: 0 };
  return {
    ok: true,
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model || (cfg.provider === 'typesafe' ? 'jev-latest' : 'jev-1.13-free'),
    usages: cfg.usages,
    callsToday: usage.date === stamp ? usage.calls : 0,
    dailyMaxCalls: cfg.dailyMaxCalls,
  };
});

// ---- Offscreen 渲染公共设施：串行 + 崩溃防护 ----
const OFFSCREEN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let offscreenQueue = Promise.resolve();

function createOffscreenWindow(options) {
  const win = new BrowserWindow(options);
  try { win.webContents.setAudioMuted(true); } catch { /* ignore */ }
  try {
    win.webContents.on('render-process-gone', (_e, details) => {
      try {
        appLog.writeCrashRecord({
          source: 'offscreen-window-gone',
          message: `reason=${details && details.reason} exitCode=${details && details.exitCode}`,
          stack: '',
          extra: { url: (() => { try { return win.webContents.getURL(); } catch { return ''; } })(), details: details || null },
        });
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  return win;
}

function withOffscreenWindow(options, worker) {
  const run = async () => {
    const win = createOffscreenWindow(options);
    try {
      return await worker(win);
    } finally {
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    }
  };
  const next = offscreenQueue.then(run, run);
  offscreenQueue = next.then(() => {}, () => {});
  return next;
}

function saveOffscreenShot(win, prepareTargetDir, prefix) {
  try {
    const wc = win.webContents;
    if (win.isDestroyed() || wc.isDestroyed()) return '';
    let targetDir = imagesDir;
    if (typeof prepareTargetDir === 'function') {
      const t = prepareTargetDir();
      if (t) targetDir = t;
    }
    return wc.capturePage().then((image) => {
      if (!image || image.isEmpty()) return '';
      const imgPath = path.join(targetDir, `${prefix}_${Date.now()}.png`);
      fs.writeFileSync(imgPath, image.toPNG());
      return imgPath;
    }).catch(() => '');
  } catch {
    return Promise.resolve('');
  }
}

// ---- IPC: Web Search & Fetch ----
ipcMain.handle('web:search', async (_, query, workspacePath) => {
  if (vmLocationActive()) {
    try { return { ok: true, query, ...await pwService.renderVm({ url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, workspacePath, waitMs: 2000 }) }; }
    catch (error) { return { ok: false, location: 'vm', error: error.message }; }
  }
  if (!mainWindow) return { ok: false, error: 'main window not ready' };
  try {
    return await withOffscreenWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    }, async (offscreenWindow) => {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      await offscreenWindow.webContents.loadURL(url, { userAgent: OFFSCREEN_UA });

      // 等待渲染稳定
      await new Promise(r => setTimeout(r, 2000));

      const result = await offscreenWindow.webContents.executeJavaScript(`(() => {
        const items = [];
        const nodes = document.querySelectorAll('li.b_algo');
        for (let i = 0; i < nodes.length && items.length < 15; i++) {
          const li = nodes[i];
          const a = li.querySelector('h2 a');
          const p = li.querySelector('p, .b_caption p');
          items.push({
            title: a ? a.textContent.trim() : '',
            url: a ? a.href : '',
            snippet: p ? p.textContent.trim() : '',
            id: li.id || ''
          });
        }
        return {
          title: document.title,
          url: location.href,
          results: items,
          html: document.documentElement.outerHTML.slice(0, 150000)
        };
      })()`);

      // Code 模式：检测工作区下 .cibyp-code-history 目录是否存在，是则保存到其 assets/ 子目录
      // 否则保持原有行为（保存到工作区根目录或 imagesDir）
      const imgPath = await saveOffscreenShot(offscreenWindow, () => {
        if (workspacePath && fs.existsSync(workspacePath)) {
          const codeHistDir = path.join(workspacePath, '.cibyp-code-history');
          if (fs.existsSync(codeHistDir)) {
            const assetsDir = path.join(codeHistDir, 'assets');
            try { fs.mkdirSync(assetsDir, { recursive: true }); } catch {}
            return assetsDir;
          }
          return workspacePath;
        }
        return imagesDir;
      }, 'bing');

      return {
        ok: true,
        query,
        url: result.url,
        title: result.title,
        results: result.results,
        html: result.html,
        screenshotPath: imgPath || '',
        screenshotUrl: imgPath ? `file://${imgPath}` : ''
      };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('web:fetch', async (_, url) => {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const text = await resp.text();
    return { ok: true, content: text.substring(0, 200000) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('web:offscreenSnapshotOCR', async (_, options = {}) => {
  if (vmLocationActive()) {
    try {
      const page = await pwService.renderVm(options);
      const { runGuestTool } = require('./vm/vm-tool-runtime');
      const ocr = await runGuestTool(vmService, 'ocr:recognize', [page.screenshotPath], { read: [0] });
      if (!ocr.ok) return ocr;
      return { ok: true, ...page, requestedUrl: options.url, finalUrl: page.url, renderedText: page.text, ocrText: ocr.text };
    } catch (error) { return { ok: false, location: 'vm', error: error.message }; }
  }
  const targetUrl = String(options.url || '').trim();
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 10000;
  const workspacePath = options.workspacePath;
  if (!targetUrl) return { ok: false, error: 'missing url' };

  try {
    return await withOffscreenWindow({
      width: Number(options.width) || 1366,
      height: Number(options.height) || 900,
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    }, async (offscreenWindow) => {
      await offscreenWindow.webContents.loadURL(targetUrl, { userAgent: OFFSCREEN_UA });
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = await saveOffscreenShot(offscreenWindow, () => targetDir, 'offscreen');

      const ocrText = imgPath ? await recognizeImageWithTesseract(imgPath) : '';
      const pageMeta = await offscreenWindow.webContents.executeJavaScript(`({
        title: document.title || '',
        url: location.href || '',
        text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 50000)
      })`);

      return {
        ok: true,
        requestedUrl: targetUrl,
        finalUrl: pageMeta?.url || targetUrl,
        title: pageMeta?.title || '',
        screenshotPath: imgPath || '',
        screenshotUrl: imgPath ? `file://${imgPath}` : '',
        waitMs,
        ocrText: String(ocrText || '').slice(0, 100000),
        renderedText: String(pageMeta?.text || '').slice(0, 100000)
      };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('web:offscreenRenderedContent', async (_, options = {}) => {
  if (vmLocationActive()) {
    try { const page = await pwService.renderVm(options); return { ok: true, ...page, requestedUrl: options.url, finalUrl: page.url, renderedText: page.text, renderedHtml: options.includeHtml === false ? '' : page.html }; }
    catch (error) { return { ok: false, location: 'vm', error: error.message }; }
  }
  const targetUrl = String(options.url || '').trim();
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 10000;
  const workspacePath = options.workspacePath;
  const captureScreenshot = options.captureScreenshot !== false;
  const includeHtml = options.includeHtml !== false;
  if (!targetUrl) return { ok: false, error: 'missing url' };

  try {
    return await withOffscreenWindow({
      width: Number(options.width) || 1366,
      height: Number(options.height) || 900,
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    }, async (offscreenWindow) => {
      await offscreenWindow.webContents.loadURL(targetUrl, { userAgent: OFFSCREEN_UA });
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      const pageMeta = await offscreenWindow.webContents.executeJavaScript(`({
        title: document.title || '',
        url: location.href || '',
        text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 150000),
        html: (document.documentElement && document.documentElement.outerHTML ? document.documentElement.outerHTML : '').slice(0, 500000)
      })`);

      let screenshotPath = '';
      let screenshotUrl = '';
      if (captureScreenshot) {
        const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
        screenshotPath = await saveOffscreenShot(offscreenWindow, () => targetDir, 'offscreen_content');
        screenshotUrl = screenshotPath ? `file://${screenshotPath}` : '';
      }

      return {
        ok: true,
        requestedUrl: targetUrl,
        finalUrl: pageMeta?.url || targetUrl,
        title: pageMeta?.title || '',
        waitMs,
        screenshotPath,
        screenshotUrl,
        renderedText: String(pageMeta?.text || '').slice(0, 150000),
        renderedHtml: includeHtml ? String(pageMeta?.html || '').slice(0, 500000) : ''
      };
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Tarot ----

ipcMain.handle('app:is-no-tarot-build', () => {
  try {
    const appPath = app.getAppPath();
    return { ok: true, noTarot: fs.existsSync(path.join(appPath, '.no-tarot')) };
  } catch (e) {
    return { ok: false, noTarot: false, error: e.message };
  }
});

ipcMain.handle('tarot:draw', async (_, options) => {
  // .no-tarot 构建版本：拒绝抽牌调用
  try {
    const appPath = app.getAppPath();
    if (fs.existsSync(path.join(appPath, '.no-tarot'))) {
      return { ok: false, error: '塔罗牌功能在此版本中已被禁用' };
    }
  } catch {}
  try {
    // Support both old single-card (no args) and new spread (options.spread)
    const spreadId = (options && typeof options === 'object') ? (options.spread || 'single') : 'single';
    const spread = tarotTools.tarotSpreads.find(s => s.id === spreadId) || tarotTools.tarotSpreads[0];
    const count = spread.cardCount;
    const source = settings.entropy?.source || 'csprng';
    let cards;
    if (source === 'trng') {
      cards = await tarotTools.drawTarotSpreadTRNG(count, settings.entropy || {});
    } else {
      cards = tarotTools.drawTarotSpreadCSPRNG(count);
    }
    // For backward compatibility: single card returns the card directly (not array)
    if (count === 1) {
      return cards[0];
    }
    // For multi-card spreads, return array with spread metadata
    return {
      spread: { id: spread.id, name: spread.name, nameEn: spread.nameEn, description: spread.description, cardCount: spread.cardCount },
      cards: cards.map((card, i) => ({
        ...card,
        position: spread.positions[i] || { name: `位置${i + 1}`, nameEn: `Position ${i + 1}`, description: '' }
      }))
    };
  } catch (e) {
    console.error('TRNG failed, falling back to CSPRNG:', e.message);
    const spreadId = (options && typeof options === 'object') ? (options.spread || 'single') : 'single';
    const spread = tarotTools.tarotSpreads.find(s => s.id === spreadId) || tarotTools.tarotSpreads[0];
    const cards = tarotTools.drawTarotSpreadCSPRNG(spread.cardCount);
    cards.forEach(c => { c.entropySource = 'CSPRNG (TRNG fallback: ' + e.message + ')'; });
    if (spread.cardCount === 1) return cards[0];
    return {
      spread: { id: spread.id, name: spread.name, nameEn: spread.nameEn, description: spread.description, cardCount: spread.cardCount },
      cards: cards.map((card, i) => ({
        ...card,
        position: spread.positions[i] || { name: `位置${i + 1}`, nameEn: `Position ${i + 1}`, description: '' }
      }))
    };
  }
});

// ---- IPC: TRNG Serial Port List ----
ipcMain.handle('trng:listPorts', async () => {
  try {
    const { SerialPort } = require('serialport');
    const ports = await SerialPort.list();
    return { ok: true, ports };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('trng:test', async () => {
  try {
    const source = settings.entropy?.source || 'csprng';
    if (source === 'trng') {
      const result = await tarotTools.drawTarotTRNG(settings.entropy || {});
      return { ok: true, result };
    }
    return { ok: true, result: tarotTools.drawTarotCSPRNG() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Game TRNG Seed ----
// Games (sanguosha / flyingflower / undercover) call this at game-start to get
// a hardware-quality uint32 seed for their seeded PRNG.
// Returns { ok, seed, entropySource } with automatic CSPRNG fallback.
ipcMain.handle('game:trngGetSeed', async () => {
  const source = settings.entropy?.source || 'csprng';
  const crypto = require('crypto');
  if (source === 'trng') {
    try {
      const raw = await tarotTools.getTrngDraw(settings.entropy || {});
      // Combine TRNG bits (8 bits: 7 from cardIndex + 1 from isReversed)
      // with 24 bits of CSPRNG to produce a full 32-bit seed.
      const cspNoise = crypto.randomBytes(3);
      const trngByte = ((raw.cardIndex & 0x7F) | ((raw.isReversed ? 1 : 0) << 7)) & 0xFF;
      const seed = ((trngByte << 24) | (cspNoise[0] << 16) | (cspNoise[1] << 8) | cspNoise[2]) >>> 0;
      return { ok: true, seed, entropySource: 'TRNG' };
    } catch (e) {
      console.warn('[TRNG] game:trngGetSeed fallback to CSPRNG:', e.message);
      const seed = crypto.randomBytes(4).readUInt32BE(0);
      return { ok: true, seed, entropySource: 'CSPRNG (TRNG fallback: ' + e.message + ')' };
    }
  }
  const seed = crypto.randomBytes(4).readUInt32BE(0);
  return { ok: true, seed, entropySource: 'CSPRNG' };
});

// ---- IPC: Skills ----
function broadcastSkillsChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('skills:changed');
  }
}

ipcMain.handle('skills:list', () => {
  try {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.json'));
    return files.map(f => loadJSON(path.join(skillsDir, f), {}));
  } catch { return []; }
});
ipcMain.handle('skills:create', (_, skill) => {
  skill.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  skill.createdAt = new Date().toISOString();
  saveJSON(dataPath(skillsDir, skill.id, '.json'), skill);
  broadcastSkillsChanged();
  return skill;
});
ipcMain.handle('skills:delete', (_, id) => {
  try {
    fs.unlinkSync(dataPath(skillsDir, id, '.json'));
    broadcastSkillsChanged();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('skill-editor:open', (_, payload = {}) => {
  if (skillEditorWindow && !skillEditorWindow.isDestroyed()) {
    skillEditorWindow.webContents.send('skill-editor:open-request', payload);
    skillEditorWindow.focus();
    return { ok: true };
  }
  skillEditorWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 880, minHeight: 620,
    title: 'Skill 编辑器',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: settings.theme?.backgroundColor || '#f5f7fa',
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/generated/skill-editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const query = {};
  if (payload?.id) query.id = String(payload.id);
  if (payload?.readonly) query.readonly = '1';
  skillEditorWindow.loadFile(path.join(__dirname, '../renderer/pages/skill-editor.html'), { query });
  skillEditorWindow.on('closed', () => { skillEditorWindow = null; });
  return { ok: true };
});

ipcMain.handle('skill-editor:close', () => {
  if (skillEditorWindow && !skillEditorWindow.isDestroyed()) skillEditorWindow.close();
  return { ok: true };
});

ipcMain.handle('skill-editor:getSkill', (_, id) => {
  const safeId = String(id || '');
  if (!safeId || !/^[A-Za-z0-9_-]+$/.test(safeId)) {
    return { ok: false, error: '非法技能ID' };
  }
  const userSkill = loadJSON(path.join(skillsDir, `${safeId}.json`), null);
  if (userSkill) return { ok: true, skill: userSkill, readonly: false };
  const bundled = BUNDLED_SKILLS.find(s => String(s?.id) === safeId);
  if (bundled) return { ok: true, skill: bundled, readonly: true };
  return { ok: false, error: '技能不存在' };
});

// llm: explicit dependencies; mutable app state is read through getters.
const { fetchModelsDevData } = require('./ipc/llm')({
  path,
  dataDir,
  loadJSON,
  fs,
  ipcMain,
  getSettings: () => settings,
  LLMProviders,
  logTs,
  maskLogUrl,
  logSnippet,
  recordTokenUsage,
  resetDailyUsageIfNeeded,
  checkBudgetExceeded,
  normalizeMessagesForThinking,
  getMainWindow: () => mainWindow,
  publishEvent,
  fetchLLMWithRetry,
  estimateTokens,
  persistSettings,
  broadcastUsageChanged,
  consumeSSEStream,
  ocHeaders
});

// ---- IPC: Token usage stats ----
ipcMain.handle('usage:getRange', (_, period) => {
  const b = settings.budget || {};
  const tz = b.timezone || 'UTC';
  const todayKey = getTodayKeyTZ(tz);
  if (period === 'daily') {
    // 按日周期时返回按小时统计，而非单根柱子
    const agg = aggregateUsage(todayKey, todayKey);
    const dayData = (settings.llm.usageHistory || {})[todayKey];
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const hd = dayData?.hours?.[h];
      hours.push({ hour: h, total: hd?.total || 0, prompt: hd?.prompt || 0, completion: hd?.completion || 0, count: hd?.count || 0, costUSD: hd?.costUSD || 0 });
    }
    return { ok: true, ...agg, hours, isHourly: true };
  }
  if (period === 'weekly') {
    const keys = getBudgetPeriodKeys('weekly', b);
    return { ok: true, ...aggregateUsage(keys.startKey, keys.endKey) };
  }
  if (period === 'monthly') {
    const keys = getBudgetPeriodKeys('monthly', b);
    return { ok: true, ...aggregateUsage(keys.startKey, keys.endKey) };
  }
  return { ok: false, error: 'invalid period' };
});

// ---- IPC: Budget (预算控制) ----
// 返回当前预算状态：日/周/月已花费、限额、占比、是否告警
ipcMain.handle('budget:getStatus', () => {
  resetDailyUsageIfNeeded();
  const b = settings.budget || {};
  const warn = Number(b.warningThreshold) || 0.8;

  const periods = [
    { name: 'daily', limit: Number(b.dailyLimitUSD) || 0, keys: getBudgetPeriodKeys('daily', b) },
    { name: 'weekly', limit: Number(b.weeklyLimitUSD) || 0, keys: getBudgetPeriodKeys('weekly', b) },
    { name: 'monthly', limit: Number(b.monthlyLimitUSD) || 0, keys: getBudgetPeriodKeys('monthly', b) },
  ];

  const result = { ok: true, warningThreshold: warn, peakHours: b.peakHours || { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 } };
  for (const p of periods) {
    const agg = aggregateUsage(p.keys.startKey, p.keys.endKey);
    const cost = agg.costUSD || 0;
    result[p.name] = {
      costUSD: cost,
      inputCost: agg.inputCost || 0,
      cacheReadCost: agg.cacheReadCost || 0,
      outputCost: agg.outputCost || 0,
      cacheWriteCost: agg.cacheWriteCost || 0,
      limitUSD: p.limit,
      pct: p.limit > 0 ? Math.min(100, (cost / p.limit) * 100) : 0,
      level: p.limit > 0 ? (cost >= p.limit ? 'danger' : (cost >= p.limit * warn ? 'warn' : 'normal')) : 'normal',
      startKey: p.keys.startKey,
      endKey: p.keys.endKey
    };
  }
  result.daily.tokensUsed = settings.llm.dailyTokensUsed || 0;
  result.daily.tokenLimit = b.dailyTokenLimit || 0;
  result.daily.imagesUsed = settings.imageGen.dailyImagesUsed || 0;
  result.daily.imageLimit = settings.imageGen.dailyMaxImages || 0;
  return result;
});

// ---- IPC: Budget check (预算检查，供 LLM 请求前调用) ----
ipcMain.handle('budget:check', () => {
  resetDailyUsageIfNeeded();
  return checkBudgetExceeded(settings.budget || {});
});

// ---- IPC: Paths ----
ipcMain.handle('app:getPath', (_, name) => {
  if (name === 'images') return imagesDir;
  if (name === 'data') return dataDir;
  if (name === 'skills') return skillsDir;
  if (name === 'userData') return userDataPath;
  return app.getPath(name);
});
ipcMain.handle('app:getVersion', () => APP_VERSION);

// ---- IPC: Dialog (系统对话框) ----
ipcMain.handle('dialog:confirm', async (_, message) => {
  // 发送请求到renderer进程显示确认对话框
  mainWindow.webContents.send('show-confirm-dialog', message);

  // 等待renderer的响应
  return new Promise((resolve) => {
    ipcMain.once('confirm-dialog-response', (_, response) => {
      resolve(response);
    });
  });
});

// ---- IPC: Dialog File Picker (系统对话框) ----
// 头像统一存为 userData/avatars 下的缩略图文件（settings 只保存路径），
// 避免 base64 头像（可达 10MB+）写爆 settings.json 并进入每条消息 DOM。
const avatarsDir = path.join(userDataPath, 'avatars');
try { fs.mkdirSync(avatarsDir, { recursive: true }); } catch { /* ignore */ }
const AVATAR_MAX_SIZE = 256;

function _avatarSafeId(id) {
  return String(id || 'avatar').replace(/[^a-z0-9_-]/gi, '') || 'avatar';
}

function _resizeAvatarImage(image, maxSize = AVATAR_MAX_SIZE) {
  const size = image.getSize();
  if (!size.width || !size.height) return image;
  if (size.width <= maxSize && size.height <= maxSize) return image;
  const ratio = Math.min(maxSize / size.width, maxSize / size.height);
  return image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'better' });
}

function _saveAvatarDataUrl(slot, dataUrl) {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (!image || image.isEmpty()) return '';
  const resized = _resizeAvatarImage(image);
  const file = path.join(avatarsDir, `${_avatarSafeId(slot)}-${Date.now()}.png`);
  fs.writeFileSync(file, resized.toPNG());
  return file;
}

function _avatarFileToDataUrl(filePath, maxSize = AVATAR_MAX_SIZE) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const image = nativeImage.createFromPath(filePath);
    if (!image || image.isEmpty()) {
      // SVG 等 nativeImage 不支持的格式：原样返回（一般体积很小）
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,` + buf.toString('base64');
    }
    const resized = _resizeAvatarImage(image, maxSize);
    return resized.toDataURL();
  } catch {
    return '';
  }
}

function _migrateAvatarsToFiles() {
  const slots = [['aiPersona', 'avatar'], ['userProfile', 'avatar'], ['babe', 'avatar']];
  let changed = false;
  for (const [objKey, field] of slots) {
    const obj = settings && settings[objKey];
    if (!obj || typeof obj[field] !== 'string') continue;
    const value = obj[field];
    if (!value.startsWith('data:')) continue;
    try {
      const saved = _saveAvatarDataUrl(objKey, value);
      if (saved) { obj[field] = saved; changed = true; }
    } catch { /* ignore */ }
  }
  if (changed) {
    try {
      if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.bak-avatars');
      saveJSON(settingsPath, settings, false);
      console.log('[avatars] migrated inline avatars to files');
    } catch (e) {
      console.warn('[avatars] migration persist failed:', e && e.message);
    }
  }
  return changed;
}

ipcMain.handle('avatar:pickAndEncode', async (_, slot) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const fp = result.filePaths[0];
    const image = nativeImage.createFromPath(fp);
    let file = '';
    let dataUrl = '';
    if (image && !image.isEmpty()) {
      const resized = _resizeAvatarImage(image);
      file = path.join(avatarsDir, `${_avatarSafeId(slot)}-${Date.now()}.png`);
      fs.writeFileSync(file, resized.toPNG());
      dataUrl = resized.toDataURL();
    } else {
      const buf = fs.readFileSync(fp);
      const ext = path.extname(fp).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
      dataUrl = `data:${mime};base64,` + buf.toString('base64');
    }
    return { ok: true, path: file, dataUrl };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 头像文件 → 缩略 data URL（用于 WebUI 镜像/即时预览，不写回 settings）
ipcMain.handle('avatar:encodeFile', async (_, filePath) => {
  try {
    if (!filePath) return { ok: false };
    if (String(filePath).startsWith('data:')) return { ok: true, dataUrl: filePath };
    if (!fs.existsSync(filePath)) return { ok: false };
    const dataUrl = _avatarFileToDataUrl(filePath);
    if (!dataUrl) return { ok: false };
    return { ok: true, dataUrl };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:openFile', async (_, options = {}) => {
  try {
    const properties = ['openFile'];
    if (options.multiple) properties.push('multiSelections');
    if (options.directory) properties.push('openDirectory');
    const result = await toolDialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件',
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties
    });
    return { ok: !result.canceled, paths: result.filePaths || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dialog:saveFile', async (_, options = {}) => {
  try {
    const result = await toolDialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters
    });
    return { ok: !result.canceled, path: result.filePath || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

const { _historyIndexFile, _getHistoryIndex, _putHistoryIndexEntry, _removeHistoryIndexEntry, _externalizeHistoryImages, _rehydrateHistoryImages, _deleteHistoryImages, migrateHistoryV2, queueHistorySave, flushPendingHistorySaves } = require('./services/history')({
  path,
  imagesDir,
  dataDir,
  loadJSON,
  getSettings: () => settings,
  fs,
  saveJSON,
  historyDir,
  babeHistoryDir,
  scheduleSettingsPersist,
  ipcMain,
  getCodeHistoryDir: (...args) => getCodeHistoryDir(...args)
});

// ---- IPC: Pending Session (App 异常中断时保存正在工作的会话) ----
// 保存：渲染器在收到 agent:save-pending 事件后调用，将当前会话信息写入 pending 文件
ipcMain.handle('agent:save-pending-session', (_, payload) => {
  try {
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [payload];
    const data = {
      savedAt: new Date().toISOString(),
      sessions,
      count: sessions.length
    };
    saveJSON(pendingSessionPath, data);
    pendingSaveDone = true;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 标记无需保存（如当前没有正在运行的会话）
ipcMain.handle('agent:skip-pending', () => {
  pendingSaveDone = true;
  return { ok: true };
});

// 读取 pending 会话（App 启动时调用以决定是否弹模态框）
ipcMain.handle('agent:get-pending-session', () => {
  try {
    if (!fs.existsSync(pendingSessionPath)) return null;
    const data = loadJSON(pendingSessionPath, null);
    return data;
  } catch { return null; }
});

// 清除 pending 文件（用户选择继续后或忽略后调用）
ipcMain.handle('agent:clear-pending-session', () => {
  try { if (fs.existsSync(pendingSessionPath)) fs.unlinkSync(pendingSessionPath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: 系统桌面通知 ----
// 渲染器在关键事件点（敏感操作审批、会话完成、askQuestions、presentFile 等）调用此接口
// opts: { title, body, category?, onClickFocus?: bool }
// category 用于未来按用户设置过滤；目前仅做日志记录
ipcMain.handle('notifications:send', (event, opts) => {
  try {
    if (!opts || !opts.title) return { ok: false, error: 'missing title' };
    if (!Notification.isSupported()) return { ok: false, error: 'notifications not supported' };
    // 自动化触发器：系统通知事件
    try {
      automationManager.onSystemNotification({
        kind: opts.category || 'other',
        title: opts.title,
        body: opts.body || ''
      });
    } catch { /* ignore */ }

    const notif = new Notification({
      title: String(opts.title),
      body: String(opts.body || ''),
      silent: false
    });

    // 用户点击通知 → 通知主窗口并聚焦
    notif.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('notifications:click', {
            title: opts.title,
            body: opts.body || '',
            category: opts.category || null,
            sessionKey: opts.sessionKey || null,
            mode: opts.mode || null
          });
        }
      } catch {}
      try { notif.close(); } catch {}
    });

    notif.show();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: GitHub Releases 更新检查 ----
// 返回 { ok, current, latest?, updateAvailable?, error? }
// 失败时仅 error 字段（自动检查静默，手动检查由渲染器展示内联错误，不弹 toast）
async function performUpdateCheck() {
  const current = app.getVersion();
  const channel = ((settings.updates || {}).channel === 'all') ? 'all' : 'stable';
  const res = await updateChecker.fetchLatestRelease(channel);
  if (!res.ok || !res.latest) {
    settings.updates.lastCheckedAt = new Date().toISOString();
    persistSettings();
    return { ok: false, current, error: (res && res.error) || '检查失败' };
  }
  const updateAvailable = updateChecker.compareVersions(res.latest.version, current) > 0;
  settings.updates.lastCheckedAt = new Date().toISOString();
  settings.updates.lastResult = { ...res.latest, updateAvailable };
  persistSettings();
  return { ok: true, current, latest: res.latest, updateAvailable };
}

ipcMain.handle('updates:check', async () => {
  const result = await performUpdateCheck();
  // 手动检查不重复弹通知
  return result;
});

ipcMain.handle('updates:save', (_, cfg = {}) => {
  const u = settings.updates || {};
  if (typeof cfg.autoCheckEnabled === 'boolean') u.autoCheckEnabled = cfg.autoCheckEnabled;
  if ([6, 12, 24].includes(Number(cfg.intervalHours))) u.intervalHours = Number(cfg.intervalHours);
  if (cfg.channel === 'stable' || cfg.channel === 'all') u.channel = cfg.channel;
  settings.updates = u;
  persistSettings();
  scheduleAutoUpdateCheck();
  return { ok: true, updates: settings.updates };
});

ipcMain.handle('updates:openRelease', (_, url) => {
  try {
    const target = String(url || settings.updates?.lastResult?.htmlUrl || '');
    // 仅允许 http/https，防止渲染器被注入后借 shell.openExternal 打开 file:/smb: 等本地/危险协议
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '仅允许打开 http/https 链接' };
    if (target) shell.openExternal(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 更新通知是否允许弹窗（受「更新」开关 + 「通知」设置双重控制）
function shouldNotifyUpdate() {
  const n = settings.notifications || {};
  const u = settings.updates || {};
  return u.autoCheckEnabled !== false && n.enabled !== false && n.updateAvailable !== false;
}

// 自动检查调度：reschedule 语义下先清旧定时器
let _updateCheckTimer = null;
function scheduleAutoUpdateCheck() {
  if (_updateCheckTimer) {
    clearInterval(_updateCheckTimer);
    _updateCheckTimer = null;
  }
  const u = settings.updates || {};
  if (u.autoCheckEnabled === false) return;
  const hours = [6, 12, 24].includes(Number(u.intervalHours)) ? Number(u.intervalHours) : 6;
  _updateCheckTimer = setInterval(() => runAutoUpdateCheck(), hours * 3600 * 1000);
}

// 自动检查：失败完全静默；发现新版且允许通知时弹系统通知（点击打开 Releases 页）
async function runAutoUpdateCheck() {
  try {
    const res = await performUpdateCheck();
    if (!res.ok || !res.updateAvailable) return;
    if (!shouldNotifyUpdate() || !Notification.isSupported()) return;
    const latest = res.latest;
    const notif = new Notification({
      title: `发现新版本 ${latest.version.replace(/^v/i, '')}`,
      body: `当前 ${res.current.replace(/^v/i, '')}，点击查看更新内容并下载`
    });
    notif.on('click', () => {
      try {
        if (latest.htmlUrl) shell.openExternal(latest.htmlUrl);
      } catch { /* ignore */ }
      try { notif.close(); } catch { /* ignore */ }
    });
    notif.show();
  } catch { /* 自动检查失败完全静默 */ }
}

// ---- IPC: Babe History (独立持久化，含好感度等会话属性) ----
function _babeHistoryMeta(id, data) {
  return {
    id: data.id || id,
    title: data.title || '未命名对话',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: (data.messages || []).length,
    affection: data.affection ?? 0,
    mode: data.mode || 'babe',
    status: data.status || 'idle',
    lastError: data.lastError || null,
    usage: data.usage || null,
    workingMs: Number(data.workingMs) || 0
  };
}

ipcMain.handle('babeHistory:list', () => {
  flushPendingHistorySaves();
  try {
    const indexFile = _historyIndexFile('babe', babeHistoryDir);
    const entries = _getHistoryIndex(babeHistoryDir, indexFile, _babeHistoryMeta);
    return Object.values(entries)
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  } catch { return []; }
});

ipcMain.handle('babeHistory:get', (_, id) => {
  flushPendingHistorySaves();
  const p = dataPath(babeHistoryDir, id, '.json');
  return _rehydrateHistoryImages(loadJSON(p, null));
});

ipcMain.handle('babeHistory:save', (_, conversation) => {
  if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  _externalizeHistoryImages(conversation);
  queueHistorySave('babe:' + conversation.id, dataPath(babeHistoryDir, conversation.id, '.json'), conversation);
  _putHistoryIndexEntry(_historyIndexFile('babe', babeHistoryDir), conversation.id, _babeHistoryMeta(conversation.id, conversation));
  return { ok: true, queued: true };
});

ipcMain.handle('babeHistory:delete', (_, id) => {
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(dataPath(babeHistoryDir, id, '.json'));
    _removeHistoryIndexEntry(_historyIndexFile('babe', babeHistoryDir), id);
    _deleteHistoryImages(id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('babeHistory:rename', (_, id, title) => {
  flushPendingHistorySaves();
  const p = dataPath(babeHistoryDir, id, '.json');
  const data = loadJSON(p, null);
  if (data) {
    data.title = title;
    data.updatedAt = new Date().toISOString();
    saveJSON(p, data, false);
    _putHistoryIndexEntry(_historyIndexFile('babe', babeHistoryDir), id, _babeHistoryMeta(id, data));
    return { ok: true };
  }
  return { ok: false };
});

const { getCodeHistoryDir } = require('./ipc/workspaces')({
  ipcMain,
  dialog,
  getMainWindow: () => mainWindow,
  path,
  app,
  fs,
  getSettings: () => settings,
  vmService,
  workspacesBaseDir,
  scheduleSettingsPersist,
  shell,
  persistSettings,
  flushPendingHistorySaves,
  _historyIndexFile,
  _getHistoryIndex,
  _rehydrateHistoryImages,
  saveJSON,
  _externalizeHistoryImages,
  queueHistorySave,
  _putHistoryIndexEntry,
  _removeHistoryIndexEntry,
  _deleteHistoryImages
});

// ---- IPC: Playwright (built-in browser) ----
// Uses the official Playwright npm package for full browser automation.
// Workspace isolation: each workspacePath gets its own browser context.

// ---- IPC: System Info (Enhanced) ----
ipcMain.handle('system:fullInfo', () => ({
  platform: process.platform,
  arch: process.arch,
  hostname: os.hostname(),
  username: os.userInfo().username,
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  documentsDir: app.getPath('documents'),
  desktopDir: app.getPath('desktop'),
  downloadsDir: app.getPath('downloads'),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  freeMemory: os.freemem(),
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron,
  osRelease: os.release(),
  osType: os.type(),
  systemDrive: process.platform === 'win32' ? process.env.SystemDrive || 'C:' : '/',
  pathSep: path.sep
}));

// ---- IPC: File Import for Knowledge Base ----
// 统一走 document-import.js 的专用解析器：文本类带编码检测，
// 办公文档/PDF 使用对应库，二进制与旧版 Office 明确拒绝。
ipcMain.handle('knowledge:importFile', async (_, filePath, workspacePath) => {
  try {
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    return await importKnowledgeFile(filePath, { readText: readTextWithEncoding, targetDir });
  } catch (e) { return { ok: false, error: e.message }; }
});


// ---- IPC: Read file as base64 (for images) ----
ipcMain.handle('fs:readFileBase64', (_, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return { ok: true, data: `data:${mime};base64,${buf.toString('base64')}`, mime };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Save uploaded file ----
ipcMain.handle('fs:saveUploadedFile', (_, fileName, data) => {
  try {
    const ext = path.extname(fileName).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
    const targetDir = isImage ? imagesDir : path.join(userDataPath, 'uploads');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${Date.now()}_${fileName}`);
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
    } else {
      const base64 = data.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(base64, 'base64');
    }
    fs.writeFileSync(targetPath, buffer);
    return { ok: true, path: targetPath, isImage };
  } catch (e) { return { ok: false, error: e.message }; }
});

// geogebra: explicit dependencies; mutable app state is read through getters.
require('./ipc/geogebra')({
  getMainWindow: () => mainWindow,
  ipcMain,
  fs,
  imagesDir,
  path,
  getVmService: () => vmService
});

// ---- IPC: Skills Update ----
ipcMain.handle('skills:update', (_, id, data) => {
  const p = dataPath(skillsDir, id, '.json');
  const skill = loadJSON(p, null);
  if (skill) {
    const updated = { ...skill, ...data, updatedAt: new Date().toISOString() };
    saveJSON(p, updated);
    broadcastSkillsChanged();
    return { ok: true, skill: updated };
  }
  return { ok: false, error: '技能不存在' };
});

// ---- IPC: OCR (tesseract.js) ----
ipcMain.handle('ocr:recognize', async (_, imagePath) => {
  try {
    const text = await recognizeImageWithTesseract(imagePath);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: QR Code Scan ----
ipcMain.handle('qr:scan', async (_, imagePath) => {
  try {
    const jsQR = require('jsqr');
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    if (img.isEmpty()) return { ok: false, error: '无法加载图片，请确认文件路径和格式' };
    const { width, height } = img.getSize();
    const bitmap = img.toBitmap(); // BGRA on Windows/Linux
    // Convert BGRA -> RGBA for jsQR
    const rgba = new Uint8ClampedArray(bitmap.length);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4 + 0] = bitmap[i * 4 + 2]; // R
      rgba[i * 4 + 1] = bitmap[i * 4 + 1]; // G
      rgba[i * 4 + 2] = bitmap[i * 4 + 0]; // B
      rgba[i * 4 + 3] = bitmap[i * 4 + 3]; // A
    }
    const code = jsQR(rgba, width, height);
    if (!code) return { ok: false, error: '未识别到二维码' };
    return { ok: true, data: code.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ---- IPC: QR Code Generate ----
ipcMain.handle('qr:generate', async (_, text, workspacePath, filename) => {
  try {
    const QRCode = require('qrcode');
    const fname = filename || ('qrcode_' + Date.now() + '.png');
    const outputPath = path.join(workspacePath || workspacesBaseDir, fname);
    await QRCode.toFile(outputPath, text, { width: 400, margin: 2 });
    return { ok: true, path: outputPath, filename: fname };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// downloads: explicit dependencies; mutable app state is read through getters.
require('./ipc/downloads')({
  ipcMain,
  aria2Manager,
  getSettings: () => settings,
  path,
  getVmService: () => vmService
});

// network: explicit dependencies; mutable app state is read through getters.
require('./ipc/network')({
  ipcMain,
  path,
  fs,
  getVmService: () => vmService
});

// games: explicit dependencies; mutable app state is read through getters.
require('./ipc/games')({
  ipcMain,
  BrowserWindow,
  path,
  getSettings: () => settings,
  LLMProviders,
  fetchLLMWithRetry,
  DEFAULT_TIMEOUT_MS,
  logTs,
  estimateTokens,
  recordTokenUsage,
  persistSettings,
  broadcastUsageChanged
});

// cad: explicit dependencies; mutable app state is read through getters.
require('./ipc/cad')({
  ipcMain,
  BrowserWindow,
  path,
  app,
  fs,
  dialog: toolDialog,
  getVmService: () => vmService
});

// pcb: explicit dependencies; mutable app state is read through getters.
require('./ipc/pcb')({
  ipcMain,
  BrowserWindow,
  path,
  app,
  fs,
  dialog: toolDialog,
  requireAdmZip,
  getVmService: () => vmService
});

// ---- Game Result Reporting ----
ipcMain.on('game:result', (_, data) => {
  console.log('[Game] Result received:', data.game, data.result);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game:finished', data);
  }
});

// ---- MCP 客户端与 IPC（实现已拆分到 ./mcp-service.js）----
const mcpService = registerMcpIpc({
  ipcMain,
  getVmService: () => vmService,
  getSettings: () => settings,
  persist: () => persistSettings(),
  appVersion: APP_VERSION,
  // MCP 状态/工具变化 → 广播给渲染器刷新动态工具注册
  notifyRenderer: (payload) => {
    try {
      publishEvent('mcp:servers-changed', payload || {});
    } catch { /* ignore */ }
  }
});

// ---- Playwright 浏览器控制（实现已拆分到 ./browser-service.js）----
const pwService = registerPlaywrightIpc({
  getVmService: () => vmService,   // 运行位置=虚拟机时，Playwright 通过 CDP 接管 VM 内 Chromium
  ipcMain,
  getSettings: () => settings,
  getMainWindow: () => mainWindow,
  getImagesDir: () => imagesDir,
  getUserDataPath: () => app.getPath('userData')
});

// Auto-connect configured MCP servers on startup
app.whenReady().then(async () => {
  // 启动时全量重审 DeepSeek 插件（后台执行，不阻断启动：
  // 交互式插件探测可能耗时，await 会导致后续 IPC 注册延迟，
  // 渲染器早期调用如 webControl:getStatus 找不到 handler）
  // 延后到首屏后再重审插件，避免与窗口初始化/渲染器启动争 I/O
  setTimeout(() => {
    pluginManager.refreshAll().catch(e => console.warn('[DS Plugins] startup load failed:', e.message));
  }, 3000);
  // 启动自动化任务调度循环（cron / 通知 / HTTP 信号服务器）
  try { automationManager.start(); } catch (e) { console.warn('[automation] startup failed:', e.message); }

  // serial: explicit dependencies; mutable app state is read through getters.
  require('./ipc/serial')({
    ipcMain
  });

  // documents: explicit dependencies; mutable app state is read through getters.
  require('./ipc/documents')({
    decodeXmlEntities,
    encodeXmlEntities,
    ipcMain,
    extractWordText,
    createWordDocument,
    fillWordTemplate,
    getWordMetadata,
    listWordStyles,
    fs,
    createPresentation,
    getSettings: () => settings,
    nativeTheme,
    importSpreadsheetFile,
    exportSpreadsheetFile
  });

  require('./ipc/email')({
    ipcMain,
    emailService,
    getSettings: () => settings,
    persistSettings,
    getMainWindow: () => mainWindow
  });

  ipcMain.handle('fedikitten:getState', async () => {
    try {
      await fedikittenService.refreshProxy(settings.proxy);
      fedikittenService.configure(settings.fedikitten, settings.proxy);
      return fedikittenService.getState();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fedikitten:login', async (_, url, username, password) => {
    try {
      await fedikittenService.refreshProxy(settings.proxy);
      fedikittenService.configure(settings.fedikitten, settings.proxy);
      const result = await fedikittenService.login({ url, username, password });
      settings.fedikitten = {
        ...(settings.fedikitten || {}),
        clients: fedikittenService.clients,
        active: fedikittenService.active,
      };
      persistSettings();
      return result;
    } catch (e) {
      console.error('[FediKitten] Login error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fedikitten:logout', async () => {
    try {
      await fedikittenService.refreshProxy(settings.proxy);
      fedikittenService.configure(settings.fedikitten, settings.proxy);
      const result = await fedikittenService.logout();
      settings.fedikitten = {
        ...(settings.fedikitten || {}),
        clients: fedikittenService.clients,
        active: { url: '', username: '', accessToken: '' },
      };
      persistSettings();
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fedikitten:call', async (_, toolName, args) => {
    try {
      await fedikittenService.refreshProxy(settings.proxy);
      fedikittenService.configure(settings.fedikitten, settings.proxy);
      const result = await fedikittenService.call(toolName, args || {});
      if (result && result.ok === false && typeof result.error === 'string' && result.error.includes('登录已失效')) {
        settings.fedikitten = { ...(settings.fedikitten || {}), active: { url: '', username: '', accessToken: '' } };
        persistSettings();
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- CIBYP-IM Service IPC ----
  // （辅助函数在模块顶层定义，供启动/before-quit/IPC 共用）

  ipcMain.handle('cibypIm:getState', async () => {
    try {
      const s = cibypImService.getState();
      const cfg = settings.cibypIm || {};
      return { ...s, owner: { ownerUsername: cfg.ownerUsername || '', ownerMode: cfg.ownerMode || 'none', pollIntervalSec: cfg.pollIntervalSec || 300 } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cibypIm:login', async (_, url, username, password, forceTakeover) => {
    try {
      const result = await cibypImService.login({ url, username, password, forceTakeover: !!forceTakeover });
      saveCibypImState(true);
      return result;
    } catch (e) {
      saveCibypImState(true); // 登录失败也可能回滚了 active，落盘一次
      return { ok: false, error: e.message, code: e.code || undefined };
    }
  });

  ipcMain.handle('cibypIm:logout', async () => {
    try {
      const result = await cibypImService.logout();
      // 保留身份密钥与会话（重登后可继续解密），仅清除登录态
      saveCibypImState(true);
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('cibypIm:saveConfig', async (_, patch) => {
    try {
      const p = patch && typeof patch === 'object' ? patch : {};
      const cur = settings.cibypIm || {};
      const next = { ...cur };
      if ('ownerUsername' in p) next.ownerUsername = String(p.ownerUsername || '').slice(0, 64);
      if ('ownerMode' in p) next.ownerMode = ['none', 'create', 'continue'].includes(p.ownerMode) ? p.ownerMode : (cur.ownerMode || 'none');
      if ('pollIntervalSec' in p) next.pollIntervalSec = Math.max(10, Math.min(Number(p.pollIntervalSec) || 300, 3600));
      settings.cibypIm = next;
      persistSettings();
      return { ok: true, owner: { ownerUsername: next.ownerUsername || '', ownerMode: next.ownerMode || 'none', pollIntervalSec: next.pollIntervalSec || 300 } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 路径沙箱：downloadMedia 的 savePath 必须位于可信目录下，防渲染器任意写盘
  function cibypImPathAllowed(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const candidates = [app.getPath('userData'), os.tmpdir(), app.getPath('home')];
    const wd = webControlService && webControlService.workDir;
    if (wd) candidates.push(wd);
    const resolved = path.resolve(p);
    return candidates.some((base) => {
      try {
        const rel = path.relative(path.resolve(base), resolved);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      } catch { return false; }
    });
  }

  // 上传类工具的读取路径沙箱：防止提示注入让 AI 把任意本地文件发出去
  // （下载的 savePath 沙箱已存在；这里对读路径单独收紧：工作区/下载/临时/用户数据目录）
  const CIBYP_IM_UPLOAD_TOOLS = new Set(['cibypimUploadMedia', 'cibypimSendFile', 'cibypimSendVoiceMessage']);
  function cibypImReadAllowed(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const candidates = [os.tmpdir(), app.getPath('downloads'), app.getPath('userData')];
    if (workspacesBaseDir) candidates.push(workspacesBaseDir);
    const wd = webControlService && webControlService.workDir;
    if (wd) candidates.push(wd);
    const resolved = path.resolve(p);
    return candidates.some((base) => {
      try {
        const rel = path.relative(path.resolve(base), resolved);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      } catch { return false; }
    });
  }

  ipcMain.handle('cibypIm:call', async (_, toolName, args) => {
    try {
      const a = { ...(args || {}) };
      if (a.savePath && !toolFiles.active() && !cibypImPathAllowed(a.savePath)) {
        return { ok: false, error: 'savePath 不在允许的目录内（工作区/用户数据目录）' };
      }
      if (CIBYP_IM_UPLOAD_TOOLS.has(toolName) && a.filePath && !toolFiles.active() && !cibypImReadAllowed(a.filePath)) {
        return { ok: false, error: 'filePath 不在允许的读取目录内（工作区/下载/临时目录）' };
      }
      const result = await cibypImService.call(toolName, a);
      if (result && result.ok === false && typeof result.error === 'string' && result.error.includes('登录已失效')) {
        // service.api 已清除 active；落盘一次即可
        saveCibypImState(true);
      }
      saveCibypImState(); // 防抖持久化（ratchet 状态/OPK 消耗可能已变化）
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- CIBYP-IM 主人来信轮询（设置中配置 ownerUsername + ownerMode 后启用）----
  // 心跳每 10s 检查一次，距上次实际轮询 ≥ pollIntervalSec（默认 300）才拉取；
  // 首轮只建立 seq 基线（不触发），避免应用重启后重放历史消息。
  let imPollTimer = null;
  let imLastPollAt = 0;
  let imBaselineReady = false;
  const imSeqCursor = new Map(); // convId → 已处理的最后消息 seq

  function buildImIncomingPrompt(owner, convId, msg) {
    const text = (msg && typeof msg.text === 'string' ? msg.text : '').slice(0, 4000);
    const mediaNote = msg && Array.isArray(msg.media) && msg.media.length > 0 ? `（含 ${msg.media.length} 个附件）` : '';
    return [
      '[IM 来信] 主人通过 CIBYP-IM 私聊发来消息：',
      `主人（IM 用户名）：@${owner}`,
      `消息内容：${text}${mediaNote}`,
      '',
      '处理要求：',
      '1. 先用 cibypimSendMessage 向主人回复一条简短的确认消息（如“收到，正在处理”），表示已收到来信。',
      '2. 然后认真完成主人交代的任务。',
      '3. 工作完成后，用 cibypimSendMessage 将结果文本交付给主人；如有需要交付的文件，用 cibypimSendFile 发送。',
      '4. 交付完成后可简单说明处理结果。'
    ].join('\n');
  }

  async function imHandleOwnerMessage(mode, owner, convId, msg) {
    const prompt = buildImIncomingPrompt(owner, convId, msg);
    if (mode === 'create') {
      const res = await dsTransportRequest('ds:agentCreate', {
        requestId: `im-create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        instructions: prompt
      }, 30000);
      if (res && res.error) console.error('[CIBYP-IM] master-message create session failed:', res.error);
      return;
    }
    // continue：优先继续当前活跃且非空的 Chat 会话；否则退回新建
    let target = null;
    try {
      const agentsSvc = pluginManager && pluginManager.agentsService;
      if (agentsSvc && agentsSvc.store) {
        const chatEntries = [...agentsSvc.store.values()].filter(e => e && e.mode === 'chat');
        const activeChat = chatEntries.find(e => e.active);
        if (activeChat && (activeChat.messageCount || 0) > 0) {
          target = activeChat;
        } else {
          target = chatEntries.find(e => e.status !== 'running' && e.status !== 'queued' && (e.messageCount || 0) > 0) || null;
        }
      }
    } catch { /* ignore */ }
    if (target) {
      try {
        await dsTransportRequest('ds:agentResume', {
          requestId: `im-resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId: target.key
        }, 30000);
      } catch { /* ignore */ }
      dsTransportSend('ds:pluginAgentMessage', { sessionKey: target.key, kind: 'followup', text: prompt });
    } else {
      const res = await dsTransportRequest('ds:agentCreate', {
        requestId: `im-create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        instructions: prompt
      }, 30000);
      if (res && res.error) console.error('[CIBYP-IM] master-message create session failed:', res.error);
    }
  }

  async function imPollTick() {
    const cfg = (settings && settings.cibypIm) || {};
    const owner = String(cfg.ownerUsername || '').trim();
    const mode = cfg.ownerMode || 'none';
    if (!cibypImService || !cibypImService.active || !owner || mode === 'none') return;
    const intervalMs = (Number(cfg.pollIntervalSec) || 300) * 1000;
    if (Date.now() - imLastPollAt < intervalMs) return;
    imLastPollAt = Date.now();
    try {
      const r = await cibypImService.getChatLog({ peer: owner, tail: 20, markRead: true });
      if (!r || !r.ok || !Array.isArray(r.messages)) return;
      const myId = cibypImService.identity && cibypImService.identity.id;
      if (!myId) return;
      let processed = 0;
      for (const m of r.messages) {
        if (!m || m.senderId === myId) continue;
        const seq = Number(m.seq) || 0;
        if (seq <= (imSeqCursor.get(r.conversationId) || 0)) continue;
        if (!imBaselineReady) { imSeqCursor.set(r.conversationId, seq); continue; } // 首轮仅建基线，不触发
        try {
          await imHandleOwnerMessage(mode, owner, r.conversationId, m);
          imSeqCursor.set(r.conversationId, seq); // 处理成功才推进游标，失败的下次轮询重试
          processed++;
        } catch (e) {
          console.error('[CIBYP-IM] master-message handling failed:', e && e.message ? e.message : e);
        }
      }
      imBaselineReady = true; // 首轮基线建立完成，此后新消息触发处理
      // 轮询可能创建 responder 会话/消耗 OPK/推进 ratchet —— 持久化（防抖）
      saveCibypImState();
    } catch (e) {
      console.error('[CIBYP-IM] master-message polling error:', e && e.message ? e.message : e);
    }
  }

  function startImOwnerPolling() {
    if (imPollTimer) return;
    imPollTimer = setInterval(() => { imPollTick().catch(() => {}); }, 10000);
    imPollTick().catch(() => {}); // 首轮建基线
  }
  startImOwnerPolling();

  const { broadcastWebControlRunning } = require('./ipc/web-control')({
    getMainWindow: () => mainWindow,
    webControlService,
    ipcMain,
    getSettings: () => settings,
    workspacesBaseDir,
    fs,
    historyDir,
    loadJSON,
    path,
    vmService,
    userDataPath,
    imagesDir,
    WebControlService
  });

  // ===== 无头运行时启动：Agent 内核在主进程承载，WebUI 直连运行时 =====
  // 与 GUI 模式的区别：WebUI 的命令不再转发给某个窗口，而是直接驱动 Agent 会话；
  // 会话事件回流成 WebUI 既有 push 协议，历史/设置等仍共用同一套数据。
  if (HEADLESS) {
    try {
      const { createAgentRuntime, INTERACTION_POLICY } = require('./agent-runtime');
      agentRuntime = createAgentRuntime({
        ipcMain,
        eventBus,
        getSettings: () => settings,
        interactionPolicy:
          process.env.CIBYP_AUTO_APPROVE === '1'
            ? INTERACTION_POLICY.AUTO_APPROVE
            : INTERACTION_POLICY.PROMPT,
      });
      console.log('[headless] agent runtime ready');

      // WebUI：无头默认自启；TUI 模式下需显式 --web 才同时提供 Web 服务。
      const wantWeb = !TUI || WEB_FORCED;
      if (wantWeb) {
        const { attachWebUiAgentDriver } = require('./webui-agent-driver');
        attachWebUiAgentDriver({ webControlService, agentRuntime });
        // WebUI 自动启动：密码/端口优先取环境变量（便于容器/自动化），否则用设置里的 Web 控制配置
        const webCfg = { ...(settings.webControl || {}) };
        if (process.env.CIBYP_WEB_PASSWORD) webCfg.password = process.env.CIBYP_WEB_PASSWORD;
        if (process.env.CIBYP_WEB_PORT) webCfg.port = process.env.CIBYP_WEB_PORT;
        if (!webCfg.password && !webCfg.passwordHash) {
          console.log('[headless] WebUI 未启动：未配置访问密码（设置 Web 控制密码或 CIBYP_WEB_PASSWORD）');
        } else {
          webControlService.configure(webCfg);
          webControlService.workDir = workspacesBaseDir;
          const started = await webControlService.start();
          console.log(
            '[headless] WebUI',
            started && started.ok !== false
              ? `listening on port ${webControlService.port}`
              : `failed: ${started && started.error}`,
          );
        }
      }

      // TUI：终端界面（stdin/stdout 为 TTY 时进入交互界面，否则渲染一帧供自动化读取）
      if (TUI) {
        const { startTui } = require('./tui/launch.js');
        tuiHandle = startTui({
          runtime: agentRuntime,
          argv: process.argv,
          onExit: (code) => {
            try {
              app.exit(code || 0);
            } catch {
              /* ignore */
            }
          },
        });
        console.log('[headless] TUI ready');
      }
    } catch (e) {
      console.error('[headless] startup failed:', e);
    }
  }

  // Auto-start email if configured
  if (settings.email.enabled && settings.email.emailUser && settings.email.totpSecret) {
    try {
      const emailMode = settings.email.mode || 'send-receive';
      emailService.configure(settings.email);
      const initChain = async () => {
        if (emailMode === 'send-only' || emailMode === 'send-receive') {
          await emailService.initSMTP();
          console.log('[Email] Auto-start: SMTP connected');
        }
        if (emailMode === 'receive-only' || emailMode === 'send-receive') {
          await emailService.connectIMAP();
          console.log('[Email] Auto-start: IMAP connected');
        }
        emailService.enabled = true;
        if (emailMode !== 'send-only') {
          emailService.onEmailReceived = (email) => {
            console.log('[Email] Auto-poll received:', email.from, email.subject);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('email:received', email);
            }
          };
          emailService.startPolling();
        }
        console.log('[Email] Auto-started email service, mode:', emailMode);
      };
      initChain().catch(e => console.error('[Email] Auto-start failed:', e.message));
    } catch (e) {
      console.error('[Email] Auto-start config error:', e.message);
    }
  }

  // ---- MCP Auto-Connect ----
  try {
    const mcpSettings = mcpService.getMcpSettings();
    for (const serverConfig of mcpSettings.servers) {
      if (serverConfig.autoConnect) {
        console.log(`[MCP] Auto-connecting to ${serverConfig.name}...`);
        try {
          await mcpService.startMcpServer(serverConfig);
        } catch (e) {
          console.error(`[MCP] Failed to auto-connect ${serverConfig.name}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error('[MCP] Auto-connect error:', e.message);
  }

  // ---- Web Control Auto-Start ----
  // 无头/TUI 模式由启动块直连 Agent 运行时（webui-agent-driver），此处不得覆盖其回调
  if (!HEADLESS && settings.webControl.autoStartOnOpen && settings.webControl.passwordHash) {
    try {
      // Manually trigger the start via IPC-like path
      webControlService.configure(settings.webControl);
      webControlService.onGetHistory = async () => {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
          const data = loadJSON(path.join(historyDir, f), {});
          return { id: data.id || f.replace('.json', ''), title: data.title || '未命名', date: data.updatedAt || data.createdAt || '' };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      };
      webControlService.onGetConversation = async (id) => {
        const fp = dataPath(historyDir, id, '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = dataPath(historyDir, id, '.json');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      };
      webControlService.onNewChat = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:newChat');
        return Date.now().toString();
      };
      webControlService.onSendMessage = async (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:sendMessage', message);
      };
      webControlService.onStopAgent = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:stopAgent');
      };
      webControlService.onApprovalResponse = (approved) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:approvalResponse', approved);
      };
      webControlService.onLoadConversation = (id) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('webControl:loadConversation', id);
      };
      webControlService.start().then(r => {
        console.log('[WebControl] Auto-started:', r.message);
        broadcastWebControlRunning();
      }).catch(e => console.error('[WebControl] Auto-start failed:', e.message));
    } catch (e) {
      console.error('[WebControl] Auto-start config error:', e.message);
    }
  }

  // ---- GitHub Releases 自动更新检查 ----
  // 启动延迟 8s 首次检查（给渲染器留出初始化时间），之后按设置间隔定时
  if ((settings.updates || {}).autoCheckEnabled !== false) {
    setTimeout(() => { runAutoUpdateCheck().catch(() => {}); }, 8000);
  }
  scheduleAutoUpdateCheck();
});

// Cleanup MCP servers, serial ports, and web control on app quit
// 若渲染器有正在工作的会话，先通知其保存 pending 状态，等待完成后再退出
// ---- VM 工具路由：已由 ipcMain.handle 包装就地安装（见文件头部）----
// 自检放在 whenReady 之后（word/ppt/spreadsheet 等处理器在 whenReady 里注册）。
function logVmRoutingSelfCheck() {
  try {
    const probe = ['fs:readFile', 'word:create', 'ppt:create', 'spreadsheet:exportFile', 'image:generate', 'file:download', 'ffmpeg:invoke'];
    const missing = probe.filter((ch) => !__ipcHandlers.has(ch));
    console.log(`[vm] Tool routing ready (${__ipcHandlers.size} registered channels; ${ROUTE_CHANNELS.size} routed channels; missing: ${missing.length ? missing.join(',') : 'none'})`);
  } catch (e) {
    console.error('[vm] Tool routing self-check failed (host mode remains available):', e.message);
  }
}
setTimeout(logVmRoutingSelfCheck, 3000);

// Electron does not await async event listeners. Hold the first quit synchronously,
// finish CIBYP cleanup once, then let Code-OSS close its windows and databases.
let quitPreparation = null;
let quitPrepared = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (quitPrepared) return;
  event.preventDefault();
  if (quitPreparation) return;
  quitPreparation = (async () => {
    closeSplash();
    // 将防抖队列中的历史保存立即落盘，避免退出时丢失
    flushPendingHistorySaves();
    // 优雅退出时仍在运行的会话：Agent 随进程终止，标记"异常退出"（本次运行触碰过的文件）
    try {
      const fixed = markActiveHistoriesCrashed(_bootTime);
      if (fixed > 0) console.log(`[history] ${fixed} running session(s) marked crashed on quit`);
    } catch { /* ignore */ }
    // 记录优雅退出时间戳：下次启动只清扫该时刻之后变动的历史
    writeLastCleanExit(Date.now());
    try { appLog.flush(); } catch { /* ignore */ }
    try { decisionService.flushPersist(); } catch { /* ignore */ }
    try { flushSettingsPersist(); } catch { /* ignore */ }
    try { await disposeOcrEngines(); } catch { /* ignore */ }
    // CIBYP-IM：退出前立即落盘加密状态（ratchet/OPK 变更不丢）
    try { saveCibypImState(true); } catch { /* ignore */ }
    try { await shellJobs.dispose(); } catch (error) { console.error('[shell] Exit cleanup failed:', error); }
    try { await mcpService.stopAllMcpServers(); } catch (error) { console.error('[mcp] Exit cleanup failed:', error); }
    // 虚拟机沙盒：退出时优雅关机（默认开启；上限 10s 避免拖住退出）
    try {
      const vmCfg = (settings.runtime || {}).vm || {};
      if (vmService.instance && vmCfg.shutdownOnExit !== false) {
        await vmService.instance.stop({ timeoutMs: 10000 }).catch(() => {});
      }
    } catch { /* ignore */ }
    if (webControlService.running) {
      webControlService.stop().catch(() => {});
    }
    // 清理 Playwright 横幅窗口
    pwService._hidePwBanner();
    // 关闭 aria2 子进程（保存会话以便下次恢复未完成下载）
    try { await aria2Manager.shutdown(); } catch {}
    // 清理托盘图标
    if (appTray) {
      try { appTray.destroy(); } catch {}
      appTray = null;
    }
    // 语音子系统（注销全局热键、关闭隐藏采集窗/语音条、终止推理 worker）
    if (voiceIpc) {
      try { await voiceIpc.dispose(); } catch {}
      voiceIpc = null;
    }
    // 如果主窗口还存在且尚未确认 pending 保存完成，先阻止退出，请求渲染器保存
    if (mainWindow && !mainWindow.isDestroyed() && !pendingSaveDone) {
      try {
        mainWindow.webContents.send('agent:save-pending');
      } catch { /* 窗口可能已销毁 */ }
      // 等待渲染器响应（最多 3 秒），然后继续 Electron 正常退出
      const startWait = Date.now();
      const checkInterval = 100;
      while (!pendingSaveDone && Date.now() - startWait < 3000) {
        await new Promise(r => setTimeout(r, checkInterval));
      }
      // 保存完成或超时，允许下一次退出
      pendingSaveDone = true;
    }
  })().catch((error) => {
    console.error('[main] Exit preparation failed:', error);
  }).finally(() => {
    quitPrepared = true;
    app.quit();
  });
});
