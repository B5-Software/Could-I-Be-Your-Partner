/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, dialog, clipboard, screen, shell, systemPreferences, Notification, Tray, Menu, nativeImage, protocol, net, safeStorage, crashReporter } = require('electron');
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

const path = require('path');
const fs = require('fs');
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

// ---- VM 工具路由：记录每个通道的原始处理器，并在**注册时就地包装** ----
// 运行位置=虚拟机时，所有文件类工具都要作用于虚拟机；宿主实现保留为回退路径。
// 就地包装（而不是事后统一覆盖）是为了兼容在 app.whenReady 里才注册的处理器（word/ppt/spreadsheet 等）。
const __ipcHandlers = new Map();
const __originalIpcHandle = ipcMain.handle.bind(ipcMain);
const { ROUTE_CHANNELS, createRoutedHandler } = require('./vm/vm-tools');
ipcMain.handle = (channel, fn) => {
  __ipcHandlers.set(channel, fn);
  if (ROUTE_CHANNELS.has(channel)) {
    const wrapped = createRoutedHandler(channel, fn, {
      getVmService: () => vmService,
      isLocationVm: () => vmLocationActive(),
    });
    return __originalIpcHandle(channel, wrapped);
  }
  return __originalIpcHandle(channel, fn);
};

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
  persistSettings: () => { try { saveJSON(settingsPath, settings); } catch (_) {} },
  aria2: aria2Manager,
});
/** 向 Splash 与主窗口广播 VM 事件（任一不存在则跳过） */
function broadcastVm(channel, payload) {
  for (const win of [typeof splashWindow !== 'undefined' ? splashWindow : null, typeof mainWindow !== 'undefined' ? mainWindow : null]) {
    try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch (_) {}
  }
}
vmService.on('state', (s) => broadcastVm('vm:state', s));
vmService.on('progress', (p) => broadcastVm('vm:progress', p));
vmService.on('serial', (t) => { try { if (t && String(t).trim()) broadcastVm('vm:serial', String(t).slice(-8192)); } catch (_) {} });
vmService.on('ready', () => { vmRuntimeGate.ready = true; vmRuntimeGate.failed = false; tryShowMainWindow(); });
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

[dataDir, imagesDir, skillsDir, historyDir, babeHistoryDir, workspacesBaseDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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

function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return def; } }
/**
 * Atomic JSON save: write to a temp file in the same directory, then rename.
 * rename() is atomic on most filesystems — prevents partial writes on crash
 * or disk-full. Falls back to direct write if rename fails (e.g. cross-device).
 */
function saveJSON(p, data, pretty = true) {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const dir = path.dirname(p);
  const base = path.basename(p);
  const tmp = path.join(dir, '.' + base + '.tmp');
  try {
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, p);
  } catch (e) {
    // If rename fails (cross-device / perms), try direct write as fallback.
    // Clean up tmp if it exists.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    // Only direct-write if the error is recoverable (e.g. EXDEV).
    // If ENOSPC (disk full), don't overwrite the existing valid file.
    if (e.code === 'ENOSPC') {
      console.error('saveJSON: disk full, keeping previous file:', p);
      throw e;
    }
    fs.writeFileSync(p, json, 'utf-8');
  }
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---- 预算周期：时区感知的日期计算 ----
// 返回指定时区下当前日期的 YYYY-MM-DD
function getTodayKeyTZ(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(new Date()); // "2026-08-01"
  } catch {
    return getTodayKey();
  }
}

// 返回指定时区下的 Date 对象（当天 00:00 本地时间）
function getDateAtMidnightTZ(timezone, date) {
  const ref = date || new Date();
  try {
    const todayKey = getTodayKeyTZ(timezone);
    // 构造当天 00:00 UTC 的 Date（近似），再用偏移校正到时区
    const [y, m, d] = todayKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  } catch {
    return new Date(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()));
  }
}

// 计算预算周期的 [startKey, endKey]
// period: 'daily' | 'weekly' | 'monthly'
// 返回 { startKey, endKey } (YYYY-MM-DD)
function getBudgetPeriodKeys(period, budget) {
  const tz = budget?.timezone || 'UTC';
  const weekMode = budget?.weekMode || 'natural';  // 'natural' | 'rolling'
  const monthMode = budget?.monthMode || 'natural'; // 'natural' | 'rolling'
  const todayKey = getTodayKeyTZ(tz);
  const now = new Date();

  if (period === 'daily') {
    return { startKey: todayKey, endKey: todayKey };
  }

  if (period === 'weekly') {
    if (weekMode === 'rolling') {
      // 滚动 7 天：从今天往前推 6 天
      const start = new Date(now.getTime() - 6 * 86400000);
      return { startKey: start.toISOString().slice(0, 10), endKey: todayKey };
    } else {
      // 自然周：找到本周一的 00:00（时区感知）
      // getDay(): 0=周日, 1=周一, ..., 6=周六
      // 我们要周一起算：offset = (day - 1 + 7) % 7
      const todayMidnight = getDateAtMidnightTZ(tz, now);
      const dow = now.getDay();
      const offset = dow === 0 ? 6 : dow - 1; // 周日=6天前, 周一=0, 周二=1...
      const monday = new Date(todayMidnight.getTime() - offset * 86400000);
      return { startKey: monday.toISOString().slice(0, 10), endKey: todayKey };
    }
  }

  if (period === 'monthly') {
    if (monthMode === 'rolling') {
      // 滚动 30 天
      const start = new Date(now.getTime() - 29 * 86400000);
      return { startKey: start.toISOString().slice(0, 10), endKey: todayKey };
    } else {
      // 自然月：当月 1 日
      const [y, m] = todayKey.split('-').map(Number);
      return { startKey: `${y}-${String(m).padStart(2, '0')}-01`, endKey: todayKey };
    }
  }

  return { startKey: todayKey, endKey: todayKey };
}

// 检查预算是否超限，返回 { exceeded, period, level, action, fallbackModel }
function checkBudgetExceeded(budget) {
  if (!budget) return { exceeded: false };
  const tz = budget.timezone || 'UTC';
  const todayKey = getTodayKeyTZ(tz);
  const warn = Number(budget.warningThreshold) || 0.8;
  const action = budget.overLimitAction || 'warn';

  const periods = [
    { name: 'daily', limit: Number(budget.dailyLimitUSD) || 0, keys: getBudgetPeriodKeys('daily', budget) },
    { name: 'weekly', limit: Number(budget.weeklyLimitUSD) || 0, keys: getBudgetPeriodKeys('weekly', budget) },
    { name: 'monthly', limit: Number(budget.monthlyLimitUSD) || 0, keys: getBudgetPeriodKeys('monthly', budget) },
  ];

  for (const p of periods) {
    if (p.limit <= 0) continue;
    const agg = aggregateUsage(p.keys.startKey, p.keys.endKey);
    const cost = agg.costUSD || 0;
    if (cost >= p.limit) {
      return { exceeded: true, period: p.name, cost, limit: p.limit, level: 'danger', action, fallbackModel: budget.fallbackModel || '' };
    }
    if (cost >= p.limit * warn) {
      return { exceeded: false, period: p.name, cost, limit: p.limit, level: 'warn', action, fallbackModel: budget.fallbackModel || '' };
    }
  }
  return { exceeded: false };
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + otherCount * 0.4);
}

/**
 * Record real token usage from API response into per-day history.
 * Stores: { [dateKey]: { totalTokens, promptTokens, completionTokens, requestCount, models, hours: { [0..23]: {...} } } }
 * 支持解析缓存命中 token（OpenAI: prompt_tokens_details.cached_tokens；Anthropic: cache_read_input_tokens + cache_creation_input_tokens）
 * 同时按 settings.budget 中的价格表计算金钱消耗（inputPerM/cacheReadPerM/outputPerM/cacheWritePerM），
 * 并应用峰谷时段倍率（peakHours）。
 */
function computeUsageCost(usage, model, ts) {
  // 返回 { inputCost, cacheReadCost, outputCost, cacheWriteCost, totalCost }
  if (!usage) return { inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0, totalCost: 0 };
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    || usage.cache_read_input_tokens
    || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const nonCachedPrompt = Math.max(0, pt - cachedTokens - cacheCreationTokens);

  const pricing = (settings.budget?.models || {})[model || ''] || null;
  if (!pricing) return { inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0, totalCost: 0 };

  // 峰谷时段倍率
  const ph = settings.budget?.peakHours || {};
  let isPeak = false;
  if (ph.enabled) {
    const hour = (ts ? new Date(ts) : new Date()).getHours();
    const s = Number(ph.start) ?? 0;
    const e = Number(ph.end) ?? 24;
    if (s <= e) isPeak = hour >= s && hour < e;
    else isPeak = hour >= s || hour < e; // 跨夜
  }
  const inMul = isPeak ? (Number(ph.inputMul) || 1) : 1;
  const crMul = isPeak ? (Number(ph.cacheReadMul) || 1) : 1;
  const outMul = isPeak ? (Number(ph.outputMul) || 1) : 1;
  const cwMul = isPeak ? (Number(ph.cacheWriteMul) || 1) : 1;

  const inputPerM = Number(pricing.inputPerM) || 0;
  const cacheReadPerM = Number(pricing.cacheReadPerM) || 0;
  const outputPerM = Number(pricing.outputPerM) || 0;
  const cacheWritePerM = pricing.hasCacheWrite ? (Number(pricing.cacheWritePerM) || 0) : 0;

  const inputCost = (nonCachedPrompt / 1e6) * inputPerM * inMul;
  const cacheReadCost = (cachedTokens / 1e6) * cacheReadPerM * crMul;
  const outputCost = (ct / 1e6) * outputPerM * outMul;
  const cacheWriteCost = (cacheCreationTokens / 1e6) * cacheWritePerM * cwMul;
  return {
    inputCost, cacheReadCost, outputCost, cacheWriteCost,
    totalCost: inputCost + cacheReadCost + outputCost + cacheWriteCost,
    isPeak
  };
}

function recordTokenUsage(usage, model) {
  if (!usage) return;
  // 使用时区感知的日期键，确保与预算周期计算一致
  const tz = settings.budget?.timezone || 'UTC';
  const today = getTodayKeyTZ(tz);
  if (!settings.llm.usageHistory) settings.llm.usageHistory = {};
  if (!settings.llm.usageHistory[today]) {
    settings.llm.usageHistory[today] = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requestCount: 0, models: {}, hours: {}, cachedTokens: 0, cacheCreationTokens: 0, costUSD: 0, inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0 };
  }
  const day = settings.llm.usageHistory[today];
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const tt = usage.total_tokens || (pt + ct);
  // 解析缓存命中 token：
  // - OpenAI: usage.prompt_tokens_details.cached_tokens（已命中的 prompt 缓存）
  // - Anthropic: usage.cache_read_input_tokens（已命中） + cache_creation_input_tokens（缓存写入，按 1.25x 计费）
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens
    || usage.cache_read_input_tokens
    || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  // 计算金钱消耗
  const cost = computeUsageCost(usage, model);
  day.totalTokens += tt;
  day.promptTokens += pt;
  day.completionTokens += ct;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cacheCreationTokens = (day.cacheCreationTokens || 0) + cacheCreationTokens;
  day.inputCost = (day.inputCost || 0) + cost.inputCost;
  day.cacheReadCost = (day.cacheReadCost || 0) + cost.cacheReadCost;
  day.outputCost = (day.outputCost || 0) + cost.outputCost;
  day.cacheWriteCost = (day.cacheWriteCost || 0) + cost.cacheWriteCost;
  day.costUSD = (day.costUSD || 0) + cost.totalCost;
  day.requestCount += 1;
  if (model) {
    if (!day.models[model]) day.models[model] = { total: 0, prompt: 0, completion: 0, count: 0, cached: 0, cacheCreation: 0, costUSD: 0, inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0 };
    day.models[model].total += tt;
    day.models[model].prompt += pt;
    day.models[model].completion += ct;
    day.models[model].cached = (day.models[model].cached || 0) + cachedTokens;
    day.models[model].cacheCreation = (day.models[model].cacheCreation || 0) + cacheCreationTokens;
    day.models[model].inputCost = (day.models[model].inputCost || 0) + cost.inputCost;
    day.models[model].cacheReadCost = (day.models[model].cacheReadCost || 0) + cost.cacheReadCost;
    day.models[model].outputCost = (day.models[model].outputCost || 0) + cost.outputCost;
    day.models[model].cacheWriteCost = (day.models[model].cacheWriteCost || 0) + cost.cacheWriteCost;
    day.models[model].costUSD = (day.models[model].costUSD || 0) + cost.totalCost;
    day.models[model].count += 1;
  }
  // 按小时统计（用于 daily 周期的按小时图表）
  const hour = new Date().getHours();
  if (!day.hours) day.hours = {};
  if (!day.hours[hour]) day.hours[hour] = { total: 0, prompt: 0, completion: 0, count: 0, cached: 0, cacheCreation: 0, costUSD: 0 };
  day.hours[hour].total += tt;
  day.hours[hour].prompt += pt;
  day.hours[hour].completion += ct;
  day.hours[hour].cached = (day.hours[hour].cached || 0) + cachedTokens;
  day.hours[hour].cacheCreation = (day.hours[hour].cacheCreation || 0) + cacheCreationTokens;
  day.hours[hour].costUSD = (day.hours[hour].costUSD || 0) + cost.totalCost;
  day.hours[hour].count += 1;
  // Prune entries older than 90 days to avoid unbounded growth.
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(settings.llm.usageHistory)) {
    if (k < cutoff) delete settings.llm.usageHistory[k];
  }
}

/**
 * Aggregate usage over a date range (inclusive of both ends).
 * Returns { totalTokens, promptTokens, completionTokens, requestCount, days: [{date, total, prompt, completion, count, costUSD}], models, cachedTokens, cacheCreationTokens, costUSD, inputCost, cacheReadCost, outputCost, cacheWriteCost }
 */
function aggregateUsage(startDate, endDate) {
  const result = {
    totalTokens: 0, promptTokens: 0, completionTokens: 0, requestCount: 0, days: [], models: {},
    cachedTokens: 0, cacheCreationTokens: 0,
    costUSD: 0, inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0
  };
  const hist = settings.llm.usageHistory || {};
  const d = new Date(startDate);
  while (d.toISOString().slice(0, 10) <= endDate) {
    const key = d.toISOString().slice(0, 10);
    const entry = hist[key];
    result.days.push({
      date: key, total: entry?.totalTokens || 0, prompt: entry?.promptTokens || 0,
      completion: entry?.completionTokens || 0, count: entry?.requestCount || 0,
      cached: entry?.cachedTokens || 0, cacheCreation: entry?.cacheCreationTokens || 0,
      costUSD: entry?.costUSD || 0
    });
    if (entry) {
      result.totalTokens += entry.totalTokens || 0;
      result.promptTokens += entry.promptTokens || 0;
      result.completionTokens += entry.completionTokens || 0;
      result.requestCount += entry.requestCount || 0;
      result.cachedTokens += entry.cachedTokens || 0;
      result.cacheCreationTokens += entry.cacheCreationTokens || 0;
      result.costUSD += entry.costUSD || 0;
      result.inputCost += entry.inputCost || 0;
      result.cacheReadCost += entry.cacheReadCost || 0;
      result.outputCost += entry.outputCost || 0;
      result.cacheWriteCost += entry.cacheWriteCost || 0;
      for (const [model, m] of Object.entries(entry.models || {})) {
        if (!result.models[model]) result.models[model] = { total: 0, prompt: 0, completion: 0, count: 0, cached: 0, cacheCreation: 0, costUSD: 0, inputCost: 0, cacheReadCost: 0, outputCost: 0, cacheWriteCost: 0 };
        result.models[model].total += m.total || 0;
        result.models[model].prompt += m.prompt || 0;
        result.models[model].completion += m.completion || 0;
        result.models[model].cached += m.cached || 0;
        result.models[model].cacheCreation += m.cacheCreation || 0;
        result.models[model].costUSD += m.costUSD || 0;
        result.models[model].inputCost += m.inputCost || 0;
        result.models[model].cacheReadCost += m.cacheReadCost || 0;
        result.models[model].outputCost += m.outputCost || 0;
        result.models[model].cacheWriteCost += m.cacheWriteCost || 0;
        result.models[model].count += m.count || 0;
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return result;
}

function resetDailyUsageIfNeeded() {
  const tz = settings.budget?.timezone || 'UTC';
  const today = getTodayKeyTZ(tz);
  if (settings.llm.dailyTokenDate !== today) {
    settings.llm.dailyTokenDate = today;
    settings.llm.dailyTokensUsed = 0;
  }
  if (settings.imageGen.dailyImageDate !== today) {
    settings.imageGen.dailyImageDate = today;
    settings.imageGen.dailyImagesUsed = 0;
  }
}

/**
 * 规范化发送给 LLM 的消息，适配 thinking/推理模型。
 * DeepSeek 等思考模型开启 thinking 模式后，要求历史中的 assistant 消息回传其
 * reasoning 内容，字段名为 `reasoning_content`。
 * 本函数在【请求构造】阶段将内部使用的自定义 `reasoning` 字段映射为 API 期望的
 * `reasoning_content`，并 deep-copy，避免修改调用方（contextManager）里用于
 * 展示/持久化的原始消息——聊天记录不被破坏。
 * 若某条 assistant 消息已经带了 reasoning_content 则保留原样。
 */
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




const DEFAULT_SETTINGS = {
  llm: {
    provider: 'openai-compat',
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxContextLength: 131072,
    maxResponseTokens: 8192,
    dailyMaxTokens: 0,
    dailyTokensUsed: 0,
    dailyTokenDate: '',
    maxRetries: 10,
    timeoutMs: 300000,
    fallbackModel: '',
    streamResponses: true,
    zenApiKey: '',
    reasoningEffort: 'off',
    // 自定义请求头（所有文本/VLM 请求生效）：[{ name, value, enabled }]
    customHeaders: [],
    // URL 命中 opencode.ai 时自动附加官方请求头（免费模型 UA 门控 / Go 会话头）
    autoOpencodeHeaders: true,
    // OpenCode UA 版本缓存（refreshOpenCodeVersion 写入 { version, fetchedAt }）
    opencodeVersion: null,
    // ---- 模型池（单层：每条自带 provider/URL/Key，可自由组合 Zen/Go/OpenAI 兼容等）----
    // entry: { id,label,provider,apiUrl,apiKey,model,effort,intelligence,priority,vision,contextLength,enabled }
    pool: [],
    // 路由策略：模型选择（priority=手动优先级 / intelligence=Jev 智慧分数）；
    // Reasoning Effort（manual=条目手动值 / jev=会话创建时由 Jev 决策一次）
    routing: { modelStrategy: 'priority', effortStrategy: 'manual' },
    // 默认条目（非 Agent 调用如游戏/标题使用的全局投影来源）
    activeEntryId: ''
  },
  agent: {
    maxIterations: 50,
    autoCompactMaxFailures: 3
  },
  // 上下文压缩（水位线策略，借鉴 DeepSeek Harness compaction-basic）
  // - enabled           : 自动压缩总开关
  // - thresholdRatio    : 输入包络（system+tools+messages+输出预留）超过窗口该比例触发
  // - retainRatio       : 最近保留尾巴占窗口比例（token 预算制）
  // - compactionRetries : 摘要不收敛时的额外重试次数
  // - summarizeMaxTokens: 摘要请求最大输出 token
  contextCompaction: {
    enabled: true,
    thresholdRatio: 0.80,
    retainRatio: 0.16,
    compactionRetries: 1,
    summarizeMaxTokens: 2048
  },
  // 沙箱（借鉴 DeepSeek Harness：read-only / workspace-write / danger-full-access）
  // - defaultMode    : 全局默认；受限模式后端不可用时 fail-closed（拒绝执行，不静默放行）
  // - modeOverrides  : 按 chat/code/babe 覆盖
  // - requireApproval: 被拦截/后端不可用时，是否弹窗确认后以完全权限重试
  sandbox: {
    defaultMode: 'danger-full-access',
    modeOverrides: { chat: null, code: null, babe: null },
    requireApproval: true
  },
  // 运行位置：本机 / 虚拟机（CIBYP-VM-OS，基于 Debian 的隔离环境，资源按需下载）
  // - location     : 'host' | 'vm'；切换需重启应用（终端/工作区路径语义随之改变）
  // - workspaceMode: 'shared'（宿主为准 + 增量双向同步）| 'isolated'（VM 内为准，按需导出）
  // - vm.*         : QEMU 运行参数与资源目录（assetsDir 为空 = userData/vm）
  runtime: {
    location: 'host',
    workspaceMode: 'shared',
    vm: {
      variant: 'base',
      imageVersion: null,
      assetsDir: '',
      mirror: 'cn',
      accel: 'auto',
      allowTcg: true,
      smp: 4,
      memMB: 4096,
      netMode: 'nat',
      shutdownOnExit: true
    }
  },
  // 自动化触发（HTTP 信号服务器）
  // - enabled     : 总开关（默认禁用，需用户在设置 → 自动化 中主动开启）
  // - allowNoToken: 无任何 token 也允许启动（不安全，UI 有警告）
  // - serverPort  : 监听端口（仅绑定 127.0.0.1）
  // - tokens      : token 列表，每项 { id, name, value, scope('all'|任务id数组), allowParams, expiresAt }
  automation: {
    enabled: false,
    allowNoToken: false,
    serverPort: 8765,
    tokens: []
  },
  sessions: {
    maxConcurrent: 10
  },
  // macOS 系统权限提示的一次性标记（无论允许/拒绝，之后都不再自动弹窗）
  permissions: {
    accessibilityPromptShown: false,
    localNetworkPromptShown: false
  },
  imageGen: {
    // 厂商预设：openai / siliconflow / ark / gemini / imagen / stability / custom
    provider: 'openai',
    apiUrl: '',
    apiKey: '',
    model: '',
    imageSize: '1024x1024',
    // 高级参数（按厂商预设生效，留空用厂商默认）
    n: 1,
    quality: '',
    background: '',
    outputFormat: '',
    negativePrompt: '',
    seed: '',
    steps: '',
    guidance: '',
    style: '',
    watermark: false,
    bodyTemplate: '',
    dailyMaxImages: 0,
    dailyImagesUsed: 0,
    dailyImageDate: '',
    // 自定义请求头（生图 API 生效）：[{ name, value, enabled }]
    customHeaders: []
  },
  // 资源下载（语音模型等大文件不随安装包分发，由用户手动下载）：
  //   mirror        : 'cn'(hf-mirror.com) | 'official'(huggingface.co)
  //   voiceModelDir : 自定义模型下载目录（空 = userData/voice-models）
  resources: {
    mirror: 'cn',
    voiceModelDir: ''
  },
  // 决策模型（System One / Jev）：OpenCode Zen 免费 Jev / TypeSafe 直连
  decision: { ...DEFAULT_DECISION_SETTINGS },
  theme: { mode: 'system', accentColor: '#4f8cff', backgroundColor: '#f5f7fa' },
  // 界面动效：关闭后主标签页切换无动画（设置页「动效」开关）
  animations: true,
  // 模态框动效：关闭后模态框打开/关闭为瞬时切换（设置页「动效」开关）
  modalAnimations: true,
  language: 'zh-CN',
  tools: {},
  autoApproveSensitive: false,
  autoOptimizeToolSelection: false,
  // 隐私信息保护：在工具调用过程中过滤隐私信息（手机号/证件号/SSN/API Key/SSH 私钥/.env/Tor/git key/配置密码）
  // - enabled           : 总开关（默认启用）
  // - filterResults     : 工具返回内容注入 AI 上下文前过滤（默认开）
  // - filterArgs        : 工具参数写入上下文时敏感键值脱敏（默认开）
  // - filterTerminal    : 终端命令/脚本文本全文隐私扫描（默认开）
  // - filterAttachments : 上传附件的 OCR/提取文本过滤（默认开）
  // - categories        : 可单独关闭的过滤类别（默认全开）
  privacyProtection: {
    enabled: true,
    filterResults: true,
    filterArgs: true,
    filterTerminal: true,
    filterAttachments: true,
    categories: {
      phone: true,
      idCard: true,
      ssn: true,
      apiKey: true,
      sshKey: true,
      env: true,
      tor: true,
      gitKey: true,
      configPassword: true,
      evasion: false
    }
  },
  // 工具首次使用授权状态（持久化，跨会话生效）
  // - playwright: 内置浏览器工具集（browserNavigate/browserClick/browserType/...）
  // - computerUse: Computer Use 工具（computer，控制桌面鼠标键盘）
  // 用户首次调用相应工具时弹出授权模态框，同意后置为 true，拒绝则禁用工具
  toolAuthGranted: { playwright: false, computerUse: false },
  // 后台托盘模式：关闭窗口时的行为
  // - 'ask'     : 首次关闭时弹模态框询问，用户选择后记住
  // - 'always'  : 始终最小化到托盘（不退出）
  // - 'never'   : 始终直接退出（不显示托盘）
  // - 'once'    : 本次会话最小化到托盘，下次启动再次询问
  closeToTray: 'ask',
  trayEnabled: true,
  aiPersona: { name: 'Partner', avatar: '', avatarFrame: '', bio: '你的全能AI伙伴~', pronouns: 'Ta', personality: '活泼可爱、热情友善', customPrompt: '' },
  tarotVisible: true,
  userProfile: { name: '', avatar: '', avatarFrame: '', bio: '' },
  entropy: { source: 'csprng', trngMode: 'network', trngSerialPort: '', trngSerialBaud: 115200, trngNetworkHost: '192.168.4.1', trngNetworkPort: 80 },
  proxy: { mode: 'system', http: '', https: '', bypass: 'localhost,127.0.0.1' },
  mcp: { servers: [] },
  email: { enabled: false, mode: 'send-receive', smtpHost: '', smtpPort: 587, smtpSecure: true, imapHost: '', imapPort: 993, imapTls: true, emailUser: '', emailPass: '', ownerAddress: '', totpSecret: '', pollInterval: 30, approvalResendMinutes: 5, maxResends: 3, resendIntervalMinutes: 30, allowedSenders: [] },
  fedikitten: { active: { url: '', username: '', accessToken: '' }, clients: {} },
  cibypIm: { active: null, identity: null, keys: [], sessions: [], groups: [] },
  webControl: { enabled: false, port: 3456, password: '', passwordHash: '', enable2FA: false, totpSecret: '' },
  // 系统桌面通知分类开关（渲染器按分类判断是否弹窗；updateAvailable 供更新检查模块消费）
  notifications: {
    enabled: true,
    approval: true,
    sessionDone: true,
    question: true,
    present: true,
    babeProactive: false,
    updateAvailable: true
  },
  // GitHub Releases 自动更新检查
  // - autoCheckEnabled : 启动延迟 + 定时自动检查（发现新版本弹系统通知）
  // - intervalHours    : 自动检查间隔（小时）
  // - channel          : 更新通道 'stable'（仅正式版）| 'all'（含预发布版），默认仅稳定版
  // - lastCheckedAt    : 上次成功检查时间（ISO）
  // - lastResult       : 上次检查结果快照（渲染器设置页展示）
  updates: {
    autoCheckEnabled: true,
    intervalHours: 6,
    channel: 'stable',
    lastCheckedAt: '',
    lastResult: null
  },
  // 预算控制：每模型单价表（每 1M tokens 多少美元）+ 峰谷时段 + 限额
  budget: {
    models: {},                                  // { [modelId]: { inputPerM, cacheReadPerM, outputPerM, cacheWritePerM, hasCacheWrite } }
    peakHours: { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 },
    dailyLimitUSD: 0,                            // 0 表示不限制
    weeklyLimitUSD: 0,
    monthlyLimitUSD: 0,
    warningThreshold: 0.8,
    overLimitAction: 'warn',                     // 'warn' | 'fallback' | 'stop'
    fallbackModel: '',
    timezone: 'Asia/Shanghai',
    weekMode: 'natural',                         // 'natural' (周一起) | 'rolling' (滚动7天)
    monthMode: 'natural'                         // 'natural' (1日起) | 'rolling' (滚动30天)
  },
  // 终端设置：
  //   abortStrategy: Abort 聊天时对运行中终端的处理策略
  //     'kill'   - 直接掐断整个运行中的终端（默认）
  //     'clearC' - 传入 Ctrl+C（保留终端，仅中止当前进程）
  //     'none'   - 不管，让终端继续运行
  //   shell: 手动选择 Shell
  //     'auto'       - 自动检测（默认）
  //     'pwsh'       - PowerShell 7+ (pwsh)
  //     'powershell' - Windows PowerShell 5
  //     'cmd'        - CMD
  //     'bash' / 'zsh' - POSIX shell
  //     'custom'     - 使用 customShellPath 指定的自定义 Shell
  terminal: { abortStrategy: 'kill', shell: 'auto', customShellPath: '' },
  // 屏幕软键盘 / 输入法（OSK+IME）：
  //   enabled:       应用启动时是否自动打开屏幕键盘（可在输入框工具栏手动开关）
  //   mode:          默认输入模式 'zh' | 'en' | 'de'
  //   candidateCount:候选词数量
  ime: { enabled: false, mode: 'zh', candidateCount: 9 },
  // 语音子系统（完全本地化：sherpa-onnx，CPU 推理，无需任何外部配置）
  // - sttEnabled/ttsEnabled : 语音输入/输出总开关
  // - ttsAutoSpeak          : AI 流式回复时实时朗读（句级流水线，合成与输出并行）
  // - ttsLang               : 朗读语言 'auto' | 'zh' | 'en' | 'de'（auto 按句自动检测）
  // - ttsVoices             : 各语言音色（zh/en 为 Kokoro 音色名，de 为 Piper thorsten）
  // - wakeEnabled           : 后台语音唤醒（隐藏窗口常驻采集 + KWS 关键词检测）
  // - wakeWords             : 唤醒词表，action: 'voicebar'（弹置顶语音条）| 'mainwindow'（弹出主窗口）
  // - kws                   : 检测灵敏度（score 越大越易触发，threshold 越小越易触发）
  // - hotkey/pushToTalk     : 全局热键切换听写
  voice: {
    sttEnabled: true,
    ttsEnabled: true,
    ttsAutoSpeak: false,
    ttsLang: 'auto',
    ttsVoices: { zh: 'zf_xiaoxiao', en: 'af_heart', de: 'thorsten' },
    ttsSpeed: 1.0,
    ttsVolume: 1.0,
    // 长文本自动分块合成（防 OOM）：ttsAutoChunk 控制开关，ttsChunkChars=每块最大字数
    ttsAutoChunk: true,
    ttsChunkChars: 120,
    sttModel: 'base',
    // 听写结尾说这些词任一个 → 自动发送该条消息（默认关闭，空数组关闭该功能）
    sttSendKeywords: [],
    wakeEnabled: false,
    wakeWords: [
      { phrase: '伙伴伙伴', action: 'voicebar', enabled: true },
      { phrase: 'hey partner', action: 'voicebar', enabled: true },
      { phrase: '打开主页面', action: 'mainwindow', enabled: true }
    ],
    kws: { score: 1.0, threshold: 0.25 },
    hotkey: 'Control+Shift+Space',
    pushToTalk: true
  }
};
// 注意：loadJSON 不与默认值合并（settings.json 存在时原样返回），必须显式以 DEFAULT_SETTINGS 为基，
// 否则老用户的配置文件会缺新版本新增的键（曾导致读取 settings.runtime.vm 直接崩溃）
let settings = { ...DEFAULT_SETTINGS, ...loadJSON(settingsPath, {}) };
if (fs.existsSync(settingsPath)) {
  const saved = loadJSON(settingsPath, {});
  settings = { ...settings, ...saved, llm: { ...settings.llm, ...(saved.llm || {}) }, agent: { ...settings.agent, ...(saved.agent || {}) }, sessions: { ...settings.sessions, ...(saved.sessions || {}) }, permissions: { ...settings.permissions, ...(saved.permissions || {}) }, imageGen: { ...settings.imageGen, ...(saved.imageGen || {}) }, resources: { ...settings.resources, ...(saved.resources || {}) }, runtime: (() => { const d = settings.runtime || {}; const s = saved.runtime || {}; return { ...d, ...s, vm: { ...(d.vm || {}), ...(s.vm || {}) } }; })(), decision: { ...settings.decision, ...(saved.decision || {}) }, theme: { ...settings.theme, ...(saved.theme || {}) }, aiPersona: { ...settings.aiPersona, ...(saved.aiPersona || {}) }, userProfile: { ...settings.userProfile, ...(saved.userProfile || {}) }, entropy: { ...settings.entropy, ...(saved.entropy || {}) }, proxy: { ...settings.proxy, ...(saved.proxy || {}) }, mcp: { ...settings.mcp, ...(saved.mcp || {}) }, email: { ...settings.email, ...(saved.email || {}) }, fedikitten: { ...settings.fedikitten, ...(saved.fedikitten || {}) }, cibypIm: { ...settings.cibypIm, ...(saved.cibypIm || {}) }, webControl: { ...settings.webControl, ...(saved.webControl || {}) }, budget: { ...settings.budget, ...(saved.budget || {}) }, terminal: { ...settings.terminal, ...(saved.terminal || {}) }, privacyProtection: { ...settings.privacyProtection, ...(saved.privacyProtection || {}) }, ime: { ...settings.ime, ...(saved.ime || {}) }, voice: { ...settings.voice, ...(saved.voice || {}) }, notifications: { ...settings.notifications, ...(saved.notifications || {}) }, updates: { ...settings.updates, ...(saved.updates || {}) } };
  // 生图设置去品牌化迁移：旧版本内置的默认端点/模型清空，改为用户显式配置
  if (settings.imageGen.apiUrl === 'https://api.siliconflow.cn/v1/images/generations') settings.imageGen.apiUrl = '';
  if (settings.imageGen.model === 'Kwai-Kolors/Kolors') settings.imageGen.model = '';
  // voice 子对象深合并（ttsVoices / kws）
  if (saved.voice) {
    settings.voice.ttsVoices = { zh: 'zf_xiaoxiao', en: 'af_heart', de: 'thorsten', ...(saved.voice.ttsVoices || {}) };
    settings.voice.kws = { score: 1.0, threshold: 0.25, ...(saved.voice.kws || {}) };
  }
  if (saved.budget) {
    settings.budget.models = { ...(settings.budget.models || {}), ...(saved.budget.models || {}) };
    settings.budget.peakHours = { ...(settings.budget.peakHours || {}), ...(saved.budget.peakHours || {}) };
  }
}
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
    // 上下文长度：用户在设置里手动填写过（maxContextLengthExplicit=true）时以用户值为准，
    // 同步写入池条目，避免被条目默认值或模型元数据再次覆盖。
    if (llm.maxContextLengthExplicit && Number(llm.maxContextLength) > 0) {
      entry.contextLength = Number(llm.maxContextLength);
    }
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

/** 尝试显示主窗口；VM 门控未放行时返回 false（调用方无需处理） */
function tryShowMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindowShownOnce) return false;
  if (vmRuntimeGate.required && !vmRuntimeGate.ready) return false;
  mainWindowShownOnce = true;
  mainWindow.show();
  try { mainWindow.focus(); } catch { /* ignore */ }
  console.log('[vm] 主窗口已显示' + (vmRuntimeGate.required ? '（虚拟机门控已放行）' : ''));
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
    console.log('[vm] 开始虚拟机启动编排（Splash 门控生效）');
    broadcastVm('vm:boot-begin', { status: vmService.status() });
    await vmService.start();
    vmRuntimeGate.ready = true;
    vmRuntimeGate.failed = false;
    console.log('[vm] 虚拟机就绪: ' + JSON.stringify({
      accel: vmService.status().inst?.accel,
      detail: vmService.status().inst?.detail,
    }));
    broadcastVm('vm:boot-ready', { status: vmService.status() });
    tryShowMainWindow();
  } catch (e) {
    vmRuntimeGate.failed = true;
    vmRuntimeGate.reason = e.message;
    console.error('[vm] 虚拟机启动失败: ' + e.message);
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
      preload: path.join(__dirname, '../preload/splash-preload.js')
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
    // 启动阶段不绘制隐藏窗口，减少 Windows 首屏竞争；show 后正常绘制
    paintWhenInitiallyHidden: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 启动阶段允许节流；首次 show 后关闭节流（隐藏到托盘仍需后台运行 Agent/语音）
      backgroundThrottling: true
    }
  });
  mainWindowShownOnce = false;
  // 兜底：渲染器 boot 异常/超时时也必须显示窗口。
  // 运行位置=虚拟机时，兜底时间放宽到「VM 启动超时 + 15s」，避免抢在 VM 就绪前弹出空界面。
  const vmMode = settings.runtime && settings.runtime.location === 'vm';
  const fallbackMs = vmMode
    ? Math.max(MAIN_WINDOW_SHOW_FALLBACK_MS, (Number(settings.runtime?.vm?.bootTimeoutMs) || 180000) + 15000)
    : MAIN_WINDOW_SHOW_FALLBACK_MS;
  setTimeout(() => {
    if (!mainWindowShownOnce && mainWindow && !mainWindow.isDestroyed()) {
      vmRuntimeGate.ready = true; // 超时兜底：强制放行，绝不让用户卡在 Splash
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
    width: 880, height: 700, minWidth: 680, minHeight: 480,
    title: 'Crash Report',
    frame: false,
    show: false,
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(__dirname, '../preload/crash-report-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
ipcMain.handle('crash:close', () => { closeCrashReportWindow(); });
ipcMain.handle('crash:dismiss', () => {
  appLog.clearCrashRecords();
  pendingCrashReport = null;
  closeCrashReportWindow();
  return { ok: true };
});
ipcMain.handle('crash:openDumpsDir', () => {
  try { shell.showItemInFolder(crashDumpsPath); } catch { /* ignore */ }
  return { ok: true, dir: crashDumpsPath };
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
      preload: path.join(__dirname, '../preload/vm-desktop-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
  }
  // macOS：通过 Electron systemPreferences 触发无障碍权限请求。
  // 只在「有生以来第一次」弹出系统授权框（settings.permissions.accessibilityPromptShown 持久化标记）：
  // 无论用户允许还是拒绝，此后每次启动都只做静默检测，绝不再自动弹窗、也不再自动跳转系统设置。
  // 未授权但功能需要时，由具体功能入口给出提示并引导用户手动开启。
  // 注意：osascript 调用 System Events 不需要无障碍权限，无法用 osascript 检测真实状态。
  if (process.platform === 'darwin') {
    try {
      if (!settings.permissions) settings.permissions = {};
      let trusted = false;
      if (!settings.permissions.accessibilityPromptShown) {
        try {
          trusted = systemPreferences.isTrustedAccessibilityClient(true);
        } catch { /* 首次弹窗失败视为未授权，继续打标记 */ }
        settings.permissions.accessibilityPromptShown = true;
        try { persistSettings(); } catch { /* ignore */ }
      } else {
        // 已弹过：静默检测，绝不再次触发系统弹窗
        try {
          trusted = systemPreferences.isTrustedAccessibilityClient(false);
        } catch { /* ignore */ }
      }
      if (!trusted) {
        console.warn('[Accessibility] Not trusted. To use desktop control/automation, enable it manually in System Settings > Privacy & Security > Accessibility.');
      }
    } catch (e) {
      console.warn('[Accessibility] Check failed:', e.message);
    }
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

  createWindow();
  // Splash 启动画面：主窗口预渲染完成前展示品牌画面（主窗口 show 时自动关闭）
  createSplashWindow();
  // 运行位置=虚拟机：Splash 阶段完成 VM 启动编排（就绪后才放行主窗口）
  if (settings.runtime && settings.runtime.location === 'vm') {
    vmRuntimeGate.required = true;
    vmRuntimeGate.ready = false;
    startVmBootForSplash().catch((e) => { console.warn('[vm] boot failed:', e.message); });
  }
  // 启动时即创建托盘图标（若启用）
  if (settings.trayEnabled) createAppTray();
  // 上轮异常退出 → 独立崩溃报告窗口（延后到主窗口开始加载后，避免抢占启动）
  if (pendingCrashReport) setTimeout(() => { try { openCrashReportWindow(); } catch { /* ignore */ } }, 1200);
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
  const prevVoice = settings.voice ? JSON.parse(JSON.stringify(settings.voice)) : null;
  const prevProxyJson = JSON.stringify(settings.proxy || null);
  settings = { ...settings, ...newSettings };
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
      preload: path.join(__dirname, '../preload/automation-editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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

// ---- 环境检测（Python / Node+npm / Bun / Git）----
function normalizeEnvVersion(output) {
  const text = String(output || '').trim();
  const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (m) return m[1];
  return text.split(/\r?\n/)[0].slice(0, 80);
}

// macOS 打包后的 GUI 应用继承的是 launchd 的最小 PATH（/usr/bin:/bin:...），
// 看不到用户 shell 里 Homebrew/nvm 等安装的工具（node/npm/git/python）。
// 这里用用户的登录 shell 读回真实 PATH（zsh/bash/fish 通用），并附上常见安装位置兜底。
let _cachedLoginPath = null;
function getLoginPathEnv() {
  if (_cachedLoginPath) return _cachedLoginPath;
  const parts = [];
  try {
    const shellPath = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    const base = path.basename(shellPath).toLowerCase();
    const cmd = base === 'fish' ? 'string join : $PATH' : "printf '%s' \"$PATH\"";
    const r = spawnSync(shellPath, ['-lic', cmd], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env }
    });
    if (!r.error && r.status === 0 && r.stdout) parts.push(String(r.stdout).trim());
  } catch { /* ignore */ }
  // 兜底：Homebrew 两个前缀 + 系统默认路径 + nvm 通用目录
  parts.push('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  _cachedLoginPath = parts.join(':');
  return _cachedLoginPath;
}

function detectEnvTool(candidates, pathEnv) {
  for (const cmd of candidates) {
    const env = pathEnv ? { ...process.env, PATH: pathEnv } : process.env;
    let r;
    try {
      r = spawnSync(cmd, ['--version'], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } catch { continue; }
    if (r.error || r.status !== 0 || !r.stdout) continue;
    let exePath = null;
    try {
      const loc = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
      if (loc.status === 0 && loc.stdout) exePath = loc.stdout.trim().split(/\r?\n/)[0];
    } catch { /* ignore */ }
    return { found: true, command: cmd, version: normalizeEnvVersion(r.stdout), path: exePath };
  }
  return { found: false, command: candidates[0] || null, version: null, path: null };
}

ipcMain.handle('env:detect', () => {
  try {
    const pathEnv = process.platform === 'darwin' ? getLoginPathEnv() : process.env.PATH;
    const results = {
      python: detectEnvTool(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'], pathEnv),
      node: detectEnvTool(['node'], pathEnv),
      npm: detectEnvTool(['npm'], pathEnv),
      bun: detectEnvTool(['bun'], pathEnv),
      git: detectEnvTool(['git'], pathEnv)
    };
    return { ok: true, results, platform: process.platform };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Theme ----
ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode, theme: settings.theme }));
// 广播主题变化到所有 BrowserWindow（含子窗口 CAD/EDA/小游戏）
function broadcastThemeChanged() {
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

// ---- IPC: File Operations ----
ipcMain.handle('fs:readFile', (_, filePath, encoding) => {
  try {
    if (encoding) {
      const iconv = require('iconv-lite');
      const buf = fs.readFileSync(filePath);
      const encName = normalizeEncodingName(encoding);
      if (iconv.encodingExists(encName)) {
        return { ok: true, content: iconv.decode(buf, encName), encoding: encName, eol: detectEolFromBuffer(buf) };
      }
      return { ok: true, content: buf.toString('utf-8'), encoding: 'utf-8', eol: detectEolFromBuffer(buf) };
    }
    // 自动检测编码 + 换行模式
    const info = detectFileEncoding(filePath);
    const iconv = require('iconv-lite');
    return { ok: true, content: iconv.decode(info.buf, info.encoding), encoding: info.encoding, eol: info.eol };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:writeFile', (_, filePath, content, options = {}) => {
  try {
    const meta = writeTextFileWithEncoding(filePath, content, options);
    return { ok: true, encoding: meta.encoding, eol: meta.eol };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:createFile', (_, filePath, content, options = {}) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const meta = writeTextFileWithEncoding(filePath, content || '', options);
    return { ok: true, encoding: meta.encoding, eol: meta.eol };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 获取文件编码与换行模式
ipcMain.handle('fs:getFileInfo', (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const stat = fs.statSync(filePath);
    const info = detectFileEncoding(filePath);
    return { ok: true, encoding: info.encoding, eol: info.eol, size: stat.size, exists: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 转换文件编码与换行模式（至少指定 encoding 或 eol 之一）
ipcMain.handle('fs:convertFileEncoding', (_, filePath, options = {}) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const encoding = options && options.encoding ? String(options.encoding) : '';
    const eol = options && options.eol ? String(options.eol).toLowerCase() : '';
    if (!encoding && !eol) return { ok: false, error: '至少需要指定 encoding 或 eol 之一' };
    const info = detectFileEncoding(filePath);
    const iconv = require('iconv-lite');
    const content = iconv.decode(info.buf, info.encoding);
    const meta = writeTextFileWithEncoding(filePath, content, {
      encoding: encoding || info.encoding,
      eol: eol || info.eol
    });
    return { ok: true, from: { encoding: info.encoding, eol: info.eol }, to: { encoding: meta.encoding, eol: meta.eol } };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteFile', (_, filePath) => {
  try { fs.unlinkSync(filePath); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:moveFile', (_, src, dest) => {
  try { fs.renameSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:copyFile', (_, src, dest) => {
  try { fs.copyFileSync(src, dest); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:listDirectory', (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return { ok: true, entries: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:makeDirectory', (_, dirPath) => {
  try { fs.mkdirSync(dirPath, { recursive: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:deleteDirectory', (_, dirPath) => {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:localSearch', async (_, dirPath, pattern, options = {}) => {
  return new Promise((resolve) => {
    const results = [];
    const {
      ignoreCase = true,
      maxResults = 200,
      fileOnly = false,
      dirOnly = false,
      regex = false,
      depth = -1 // -1 means unlimited
    } = options;

    let searchRegex;
    if (regex) {
      try {
        searchRegex = new RegExp(pattern, ignoreCase ? 'i' : '');
      } catch (e) {
        resolve({ ok: false, error: `Invalid regex pattern: ${e.message}` });
        return;
      }
    } else {
      // Convert glob pattern (*.img, *.*, test?.txt) to regex
      // Escape regex special chars except * and ?
      const globToRegex = (glob) => glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      try {
        searchRegex = new RegExp('^' + globToRegex(pattern) + '$', ignoreCase ? 'i' : '');
      } catch (e) {
        resolve({ ok: false, error: `Invalid pattern: ${e.message}` });
        return;
      }
    }

    function matches(name) {
      return searchRegex.test(name);
    }

    function walk(dir, currentDepth = 0) {
      if (results.length >= maxResults) return;
      if (depth >= 0 && currentDepth > depth) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxResults) break;

          const full = path.join(dir, e.name);
          const isDir = e.isDirectory();

          // Apply file/dir filters
          if (fileOnly && isDir) continue;
          if (dirOnly && !isDir) continue;

          // Check if matches pattern
          if (matches(e.name)) {
            results.push(full);
          }

          // Recurse into directories
          if (isDir) {
            walk(full, currentDepth + 1);
          }
        }
      } catch { /* skip inaccessible */ }
    }

    // Run search asynchronously
    setImmediate(() => {
      try {
        walk(dirPath);
        resolve({ ok: true, results, count: results.length });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
});

// ---- IPC: searchInFiles (grep-style content search) ----
// Searches file CONTENTS (not filenames). Supports multi-file/dir input,
// filename glob filters, regex/text search, encoding specification,
// and returns structured results with line/column/context info.
ipcMain.handle('fs:searchInFiles', async (_, paths, pattern, options = {}) => {
  return new Promise((resolve) => {
    try {
      if (!Array.isArray(paths) || paths.length === 0) {
        resolve({ ok: false, error: 'paths 参数必须是非空数组' });
        return;
      }
      if (!pattern || typeof pattern !== 'string') {
        resolve({ ok: false, error: 'pattern 参数必须是非空字符串' });
        return;
      }

      const {
        isRegex = false,
        ignoreCase = true,
        include = '',
        exclude = '',
        encoding = '',
        maxResults = 500,
        contextLines = 0,
        multiline = false
      } = options;

      // Build regex
      let regex;
      try {
        const flags = (ignoreCase ? 'i' : '') + (multiline ? 'gm' : 'g');
        const patternStr = isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(patternStr, flags);
      } catch (e) {
        resolve({ ok: false, error: `Invalid regex pattern: ${e.message}` });
        return;
      }

      // Parse include/exclude globs
      const includeGlobs = include ? include.split(',').map(s => s.trim()).filter(Boolean) : [];
      const excludeGlobs = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [];

      // Helper: convert glob to regex (* -> .*, ? -> .)
      function globToRegex(glob) {
        const s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp('^' + s + '$', 'i');
      }
      function matchGlob(name, globs) {
        if (globs.length === 0) return false;
        return globs.some(g => globToRegex(g).test(name));
      }

      // Read file content with encoding (auto-detect via chardet, or specified)
      function readFileContent(filePath) {
        try {
          if (encoding) {
            const iconv = require('iconv-lite');
            const buf = fs.readFileSync(filePath);
            const encName = normalizeEncodingName(encoding);
            if (iconv.encodingExists(encName)) return iconv.decode(buf, encName);
            return buf.toString('utf-8');
          }
          return readTextWithEncoding(filePath);
        } catch { return null; }
      }

      // Binary file extensions to skip
      const binaryExts = new Set([
        'png','jpg','jpeg','gif','bmp','ico','webp','tiff','tif','heic','avif',
        'pdf','zip','gz','tar','bz2','7z','rar','xz','cab','iso','dmg','pkg',
        'exe','dll','so','dylib','bin','obj','lib','class','jar','war','ear','o','a',
        'mp3','mp4','avi','mov','mkv','flv','wav','flac','ogg','aac','webm','m4a','m4v',
        'docx','xlsx','pptx','doc','xls','ppt','odt','ods','odp','db','sqlite','sqlite3','mdb','accdb',
        'ttf','otf','woff','woff2','eot','pfb','psd','ai','eps','indd','sketch','fig',
        'node','wasm','pyc','pyo','class','swf','pak','dat','npy','npz','pickle','pkl'
      ]);

      const results = [];
      let totalMatches = 0;
      let filesScanned = 0;
      let filesWithMatches = 0;
      let truncated = false;

      function searchInFile(filePath) {
        if (truncated) return;
        const ext = path.extname(filePath).slice(1).toLowerCase();
        if (binaryExts.has(ext)) return;

        const baseName = path.basename(filePath);
        if (includeGlobs.length > 0 && !matchGlob(baseName, includeGlobs)) return;
        if (excludeGlobs.length > 0 && matchGlob(baseName, excludeGlobs)) return;

        filesScanned++;
        const rawContent = readFileContent(filePath);
        if (rawContent === null || rawContent === undefined) return;

        // 自动识别换行模式并统一为 \n（CRLF / 旧 Mac CR / LF），
        // 避免行尾残留 \r 导致行号偏移或正则（$、^、跨行）匹配失败；
        // 同时剥离 UTF-8/UTF-16 BOM，防止 \uFEFF 干扰锚点匹配。
        let content = rawContent;
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
        content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (content.length === 0) return;

        const lines = content.split('\n');
        const fileMatches = [];

        if (multiline) {
          regex.lastIndex = 0;
          let m;
          while ((m = regex.exec(content)) !== null) {
            if (totalMatches >= maxResults) { truncated = true; break; }
            const before = content.slice(0, m.index);
            const lineNum = before.split('\n').length;
            const lineStart = before.lastIndexOf('\n') + 1;
            const lineEndIdx = content.indexOf('\n', m.index + m[0].length);
            const lineText = content.slice(lineStart, lineEndIdx === -1 ? content.length : lineEndIdx);
            fileMatches.push({
              line: lineNum,
              column: m.index - lineStart + 1,
              text: lineText.length > 500 ? lineText.slice(0, 500) + '…' : lineText,
              matchStart: m.index - lineStart,
              matchEnd: m.index - lineStart + m[0].length,
              contextBefore: contextLines > 0 ? lines.slice(Math.max(0, lineNum - 1 - contextLines), lineNum - 1) : [],
              contextAfter: contextLines > 0 ? lines.slice(lineNum, lineNum + contextLines) : []
            });
            totalMatches++;
            if (m.index === regex.lastIndex) regex.lastIndex++;
          }
        } else {
          for (let i = 0; i < lines.length; i++) {
            if (totalMatches >= maxResults) { truncated = true; break; }
            const line = lines[i];
            regex.lastIndex = 0;
            const m = regex.exec(line);
            if (m) {
              fileMatches.push({
                line: i + 1,
                column: m.index + 1,
                text: line.length > 500 ? line.slice(0, 500) + '…' : line,
                matchStart: m.index,
                matchEnd: m.index + m[0].length,
                contextBefore: contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : [],
                contextAfter: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines) : []
              });
              totalMatches++;
            }
          }
        }

        if (fileMatches.length > 0) {
          filesWithMatches++;
          results.push({ file: filePath, matches: fileMatches });
        }
      }

      function walk(dir) {
        if (truncated) return;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (truncated) break;
            if (excludeGlobs.length > 0 && matchGlob(e.name, excludeGlobs)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile()) searchInFile(full);
          }
        } catch { /* skip */ }
      }

      setImmediate(() => {
        try {
          for (const p of paths) {
            if (truncated) break;
            if (!p || typeof p !== 'string') continue;
            try {
              const stat = fs.statSync(p);
              if (stat.isDirectory()) walk(p);
              else if (stat.isFile()) searchInFile(p);
            } catch { /* skip invalid path */ }
          }
          resolve({
            ok: true,
            matches: results,
            totalMatches,
            filesScanned,
            filesWithMatches,
            truncated,
            message: `找到 ${totalMatches} 处匹配（${filesWithMatches} 个文件，扫描 ${filesScanned} 个文件）${truncated ? '（已截断）' : ''}`
          });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
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
ipcMain.handle('clipboard:read', () => {
  try {
    return { ok: true, content: clipboard.readText() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('clipboard:write', (_, text) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Computer Use / 截图 / 系统信息 / shell 打开（实现已拆分）----
registerComputerUseIpc({
  ipcMain,
  getImagesDir: () => imagesDir
});

// ===== ESLint 集成 =====
// 检测工作区是否为 ESLint 支持的项目（前端用于决定是否显示 ESLint 状态面板）
ipcMain.handle('eslint:isLintable', (_, workspacePath) => {
  try {
    return { ok: true, lintable: ESLintService.isProjectLintable(workspacePath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 对工作区执行 ESLint 检测（全量扫描或指定文件列表）
// 参数：(_, workspacePath, opts?)，opts = { files?: string[], maxFiles?: number }
ipcMain.handle('eslint:lint', async (_, workspacePath, opts) => {
  return await ESLintService.lintWorkspace(workspacePath, opts || {});
});

// 检测单个文件（编辑器实时显示）
ipcMain.handle('eslint:lintFile', async (_, filePath) => {
  // 运行位置=虚拟机：先确保宿主镜像是 VM 的最新状态，再对镜像 lint，并把结果路径回映为 VM 路径
  try {
    if ((settings.runtime || {}).location === 'vm') {
      await vmService.syncWorkspace({ direction: 'pull', reason: 'eslint' }).catch(() => {});
      const hostPath = vmService.toHostPath(filePath) || filePath;
      const r = await ESLintService.lintFile(hostPath);
      return remapVmToolResult(r, hostPath, filePath);
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return ESLintService.lintFile(filePath);
  return await ESLintService.lintSingleFile(filePath);
});

// 清除缓存（工作区切换 / 配置变更时）
ipcMain.handle('eslint:clearCache', (_, workspacePath) => {
  ESLintService.clearCache(workspacePath);
  return { ok: true };
});

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

/** eslint 等宿主库结果里的宿主路径 → VM 路径回映（VM 模式） */

function remapVmToolResult(result, hostPath, vmPath) {

  if (!result || typeof result !== 'object') return result;

  const fix = (v) => (typeof v === 'string' && hostPath && v.startsWith(hostPath)) ? vmPath + v.slice(hostPath.length) : v;

  const walk = (v) => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : fix(v));

  return walk(result);

}

// ---- 运行位置=虚拟机：脚本类工具路由到 VM 内执行 ----
// 语义变化（工具描述已注明）：VM 模式下 runShell/runPython/runNodeJS/runJS 在隔离环境内执行，
// 只有 guest 里存在的运行时（bash/python3/node）可用，宿主 API 不可用。
function qemuRuntimeVersionSafe(exe) {
  try { return require('./vm/qemu-runtime').qemuVersion(exe); } catch { return null; }
}
function vmLocationActive() {
  try {
    const r = settings.runtime || {};
    return r.location === 'vm' && !vmService.emergencyHost;
  } catch { return false; }
}

/** 宿主 cwd → VM 内路径（shared 模式下由工作区同步器给出真实映射） */
function vmCwdFor(cwd) {
  try { return vmService.toVmPath(cwd); } catch { return '/workspace'; }
}

/**
 * 在 VM 内执行脚本：写临时文件 → 解释器执行 → 收集输出。
 * shared 模式：执行前推送宿主改动（让 VM 看到最新文件），执行后拉回 VM 改动。
 * @param {'shell'|'python'|'node'} interpreter
 */
async function runScriptInVm(script, cwd, interpreter) {
  try {
    const inst = vmService.instance || await vmService.start();
    if (!inst || inst.state !== 'ready') return { ok: false, error: '虚拟机未就绪', location: 'vm' };
    const shared = (settings.runtime || {}).workspaceMode !== 'isolated';
    let syncNote = '';
    if (shared) {
      try {
        const pre = await vmService.syncWorkspace({ direction: 'push', reason: 'pre-tool' });
        if (pre && !pre.ok && pre.error) syncNote += `[工作区同步] ${pre.error}\n`;
      } catch (e) { syncNote += `[工作区同步] ${e.message}\n`; }
    }
    const ext = interpreter === 'python' ? 'py' : interpreter === 'node' ? 'js' : 'sh';
    const remote = `/tmp/cibyp-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const sftp = await inst.sftp();
    await sftp.writeFile(remote, String(script));
    const vmCwd = vmCwdFor(cwd);
    const runner = interpreter === 'python' ? 'python3 -u' : interpreter === 'node' ? 'node' : 'bash';
    // 统一 UTF-8（否则 guest 内工具会把中文名写成乱码）
    const cmd = `export LANG=C.UTF-8 LC_ALL=C.UTF-8; cd ${JSON.stringify(vmCwd)} 2>/dev/null || cd /workspace; ${runner} ${remote}; rc=$?; rm -f ${remote}; exit $rc`;
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
ipcMain.handle('code:runShell', (_, script, cwd, sandboxMode) => {
  if (vmLocationActive()) return runScriptInVm(script, cwd, 'shell');
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const tmpFile = path.join(os.tmpdir(), `script_${Date.now()}${process.platform === 'win32' ? '.ps1' : '.sh'}`);
    fs.writeFileSync(tmpFile, script, 'utf-8');
    let shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    let args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-File', tmpFile] : [tmpFile];
    let confined = null;
    const wrapped = sandboxConfineFor(sandboxMode, cwd, [shell, ...args]);
    if (wrapped.error) {
      try { fs.unlinkSync(tmpFile); } catch {}
      return resolve({ ok: false, error: wrapped.error.message, code: wrapped.error.code, sandboxUnavailable: true });
    }
    shell = wrapped.argv[0];
    args = wrapped.argv.slice(1);
    confined = wrapped;
    const execOpts = { timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
    if (cwd && typeof cwd === 'string' && fs.existsSync(cwd)) execOpts.cwd = cwd;
    execFile(shell, args, execOpts, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) {
        resolve({ ok: false, error: err.message, stderr, sandboxDenied: sandboxRunner.isSandboxDenial(confined?.confined, stderr) });
      } else {
        resolve({ ok: true, output: stdout, stderr, sandboxed: !!confined?.confined });
      }
    });
  });
});

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
    const saveDir = workspacePath || imagesDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const stamp = Date.now();
    const paths = [];
    parsed.images.forEach((img, i) => {
      const ext = imageGen.extForMime(img.mime);
      const name = parsed.images.length > 1 ? `generated_${stamp}_${i + 1}.${ext}` : `generated_${stamp}.${ext}`;
      const imgPath = path.join(saveDir, name);
      fs.writeFileSync(imgPath, img.buffer);
      paths.push(imgPath);
    });
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

// ---- IPC: Resources（资源下载：语音模型等）----
// ---- 运行位置（本机 / 虚拟机）+ 虚拟机沙盒（CIBYP-VM-OS）----
ipcMain.handle('runtime:getLocation', () => {
  const r = settings.runtime || {};
  const st = vmService.status();
  return {
    ok: true,
    location: r.location === 'vm' ? 'vm' : 'host',
    workspaceMode: r.workspaceMode === 'isolated' ? 'isolated' : 'shared',
    vmState: (st.inst || {}).state || 'idle',
    vmReady: (st.inst || {}).state === 'ready',
    emergencyHost: !!vmService.emergencyHost,
  };
});
ipcMain.handle('runtime:setLocation', (_, location) => {
  const loc = location === 'vm' ? 'vm' : 'host';
  settings.runtime = settings.runtime || {};
  settings.runtime.location = loc;
  try { saveJSON(settingsPath, settings); } catch (_) {}
  return { ok: true, location: loc, requiresRestart: true };
});
ipcMain.handle('runtime:setWorkspaceMode', (_, mode) => {
  const m = mode === 'isolated' ? 'isolated' : 'shared';
  settings.runtime = settings.runtime || {};
  settings.runtime.workspaceMode = m;
  try { saveJSON(settingsPath, settings); } catch (_) {}
  return { ok: true, workspaceMode: m, requiresRestart: true };
});
ipcMain.handle('runtime:relaunch', () => {
  setTimeout(() => {
    try { app.relaunch(); } catch (_) {}
    try { app.exit(0); } catch (_) {}
  }, 200);
  return { ok: true };
});

ipcMain.handle('vm:status', () => ({ ok: true, ...vmService.status() }));
ipcMain.handle('vm:start', async () => {
  try {
    const st = await vmService.start();
    vmRuntimeGate.required = false;
    vmRuntimeGate.ready = true;
    return { ok: true, status: st };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null };
  }
});
// ---- 工作区同步（shared 模式）----
ipcMain.handle('vm:sync', async (_, opts) => {
  try {
    const r = await vmService.syncWorkspace({ direction: (opts && opts.direction) || 'both', reason: 'manual' });
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:syncStatus', () => ({ ok: true, ...vmService.syncStats(), workspaceRoot: vmService.workspaceRoot, workspaceMode: vmService.runtime.workspaceMode }));
ipcMain.handle('vm:chooseWorkspaceRoot', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: vmService.workspaceRoot || undefined,
      title: '选择工作区根目录（宿主侧权威副本）'
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    settings.runtime = settings.runtime || {};
    settings.runtime.vm = Object.assign({}, settings.runtime.vm, { workspaceRoot: r.filePaths[0] });
    try { saveJSON(settingsPath, settings); } catch (_) {}
    return { ok: true, dir: r.filePaths[0], requiresRestart: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:stop', async () => {
  try { await vmService.stop(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:reset', async () => {
  try { await vmService.reset(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:probe', async () => {
  try { return { ok: true, ...(await vmService.probe()) }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:logs', () => ({ ok: true, ...vmService.status() }));
ipcMain.handle('vm:variants', () => ({ ok: true, current: vmService.variant, variants: vmService.variants() }));
ipcMain.handle('vm:assetsStatus', (_, variant) => ({ ok: true, ...vmService.assetsStatus(variant) }));
ipcMain.handle('vm:manifest', async (_, opts) => {
  try { return await vmService.manifest(opts || {}); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:download', async (_, opts) => vmService.downloadAll(opts || {}));
ipcMain.handle('vm:downloadCancel', () => vmService.cancelDownload());
ipcMain.handle('vm:qemuPackStatus', () => {
  try {
    const info = vmService.qemuPackInstalled();
    if (!info) return { ok: true, installed: false };
    return { ok: true, installed: true, dir: info.dir, version: qemuRuntimeVersionSafe(info.exe), source: info.source };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 端口预览：把 VM 内服务映射到宿主 loopback
ipcMain.handle('vm:forwardPort', async (_, guestPort) => {
  try {
    const inst = vmService.instance;
    if (!inst || inst.state !== 'ready') return { ok: false, error: '虚拟机未就绪' };
    return { ok: true, ...(await vmService.forwardPort(Number(guestPort))) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:unforwardPort', (_, hostPort) => {
  try { return { ok: true, ...vmService.unforwardPort(Number(hostPort)) }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:listForwards', () => ({ ok: true, forwards: vmService.listForwards() }));
// 一键开启 Windows Hypervisor Platform（需要管理员，会弹 UAC）
ipcMain.handle('vm:enableWhpx', async () => {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 需要该操作' };
  try {
    const { spawn } = require('child_process');
    const ps = [
      '-NoProfile', '-Command',
      'Start-Process -FilePath dism.exe -ArgumentList "/Online","/Enable-Feature","/FeatureName:HypervisorPlatform","/All","/NoRestart" -Verb RunAs -Wait; ' +
      'Start-Process -FilePath dism.exe -ArgumentList "/Online","/Enable-Feature","/FeatureName:VirtualMachinePlatform","/All","/NoRestart" -Verb RunAs -Wait',
    ];
    await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ps, { windowsHide: true });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('DISM 退出码 ' + code))));
      p.on('error', reject);
    });
    return { ok: true, note: '功能已申请开启（若刚开启则需重启一次才能使用 WHPX 加速）' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('vm:setVariant', (_, variant) => vmService.setVariant(variant));
ipcMain.handle('vm:chooseAssetsDir', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: vmService.assetsDir,
      title: '选择虚拟机资源目录（QEMU / 镜像 / 实例数据）'
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    settings.runtime = settings.runtime || {};
    settings.runtime.vm = Object.assign({}, settings.runtime.vm, { assetsDir: r.filePaths[0] });
    try { saveJSON(settingsPath, settings); } catch (_) {}
    return { ok: true, dir: r.filePaths[0] };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:openAssetsDir', async () => {
  try {
    fs.mkdirSync(vmService.assetsDir, { recursive: true });
    await shell.openPath(vmService.assetsDir);
    return { ok: true, dir: vmService.assetsDir };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 紧急切回本机：本次运行生效（不写设置），Splash/主界面均可调用
ipcMain.handle('vm:emergencyHostMode', () => {
  vmService.emergencyHostMode();
  vmRuntimeGate.required = false;
  vmRuntimeGate.ready = true;
  tryShowMainWindow();
  return { ok: true };
});

// ---- VM 桌面（P4：Xvfb + x11vnc + noVNC / Chromium CDP）----
ipcMain.handle('vm:graphicsStatus', () => ({ ok: true, ...vmService.graphicsStatus() }));
ipcMain.handle('vm:graphicsStart', async (_, opts) => {
  try {
    // 打开 VM 桌面时如果虚拟机没在跑，自动启动（用户不需要先手动点"启动"）
    const inst = vmService.instance;
    if (!inst || inst.state !== 'ready') {
      console.log('[vm] VM 桌面：虚拟机未就绪，先启动虚拟机…');
      await vmService.start();
    }
    return await vmService.graphicsStart(opts || {});
  } catch (e) { return { ok: false, error: e.message, detail: e.stack ? String(e.stack).slice(0, 800) : null }; }
});
ipcMain.handle('vm:graphicsStop', async () => {
  try { return await vmService.graphicsStop(); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:graphicsChromium', async (_, opts) => {
  try { return await vmService.graphicsChromium(opts || {}); } catch (e) { return { ok: false, error: e.message }; }
});
// 虚拟机内文件下载（宿主 aria2 下载 → 推入 VM；支持 GitHub 加速镜像）
ipcMain.handle('vm:downloadFile', async (_, payload) => {
  try {
    const p = payload || {};
    if (!p.url) return { ok: false, error: '请填写下载链接' };
    const inst = vmService.instance;
    if (!inst || inst.state !== 'ready') return { ok: false, error: '请先启动虚拟机（运行位置=虚拟机时会自动启动）' };
    return await vmService.downloadFileToVm(p);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:mirrors', () => {
  try {
    const images = require('./vm/vm-images');
    return {
      ok: true,
      current: vmService.runtime.vm.mirror || 'official',
      mirrors: Object.entries(images.MIRROR_PREFIXES).map(([id, prefix]) => ({ id, prefix })),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:openExternal', async (_, url) => {  try { await shell.openExternal(String(url)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vm:openDesktop', () => {
  openVmDesktopWindow();
  return { ok: true };
});

ipcMain.handle('resources:voiceModels:status', () => {
  try { return { ok: true, ...voiceModelManager.status() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('resources:voiceModels:download', async (_, id) => {
  return voiceModelManager.download(String(id || ''));
});
ipcMain.handle('resources:voiceModels:cancel', (_, id) => voiceModelManager.cancel(String(id || '')));
ipcMain.handle('resources:voiceModels:delete', (_, id) => voiceModelManager.deleteModel(String(id || '')));
ipcMain.handle('resources:voiceModels:chooseDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择语音模型下载目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: voiceModelManager.dir
  });
  if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
  settings.resources.voiceModelDir = res.filePaths[0];
  persistSettings();
  try { voiceIpc?.engine?.resolveModels?.(); } catch (_) {}
  return { ok: true, dir: res.filePaths[0] };
});
ipcMain.handle('resources:voiceModels:openDir', async (_, dir) => {
  const target = String(dir || voiceModelManager.dir);
  try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('resources:voiceModels:setMirror', (_, mirror) => {
  settings.resources.mirror = mirror === 'official' ? 'official' : 'cn';
  persistSettings();
  return { ok: true, mirror: settings.resources.mirror };
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
  const stamp = new Date().toISOString().slice(0, 10);
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
  saveJSON(path.join(skillsDir, `${skill.id}.json`), skill);
  broadcastSkillsChanged();
  return skill;
});
ipcMain.handle('skills:delete', (_, id) => {
  try {
    fs.unlinkSync(path.join(skillsDir, `${id}.json`));
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
      preload: path.join(__dirname, '../preload/skill-editor-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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

// ---- 模型能力/元数据缓存 + 变体解析（Anthropic /v1/models + models.dev） ----
const modelCapabilityCache = new Map(); // key -> { capabilities, metadata, ts }
const MODEL_CAPABILITY_TTL = 10 * 60 * 1000;
const modelsDevCache = { data: null, fetchedAt: 0 };
const MODELS_DEV_TTL = 24 * 60 * 60 * 1000;

function modelsDevCacheFile() {
  return path.join(dataDir, 'models-dev.json');
}

async function fetchModelsDevData(force = false) {
  if (!force && modelsDevCache.data && Date.now() - modelsDevCache.fetchedAt < MODELS_DEV_TTL) {
    return modelsDevCache.data;
  }
  if (!force) {
    const cached = loadJSON(modelsDevCacheFile(), null);
    if (cached && cached.fetchedAt && cached.data && Date.now() - cached.fetchedAt < MODELS_DEV_TTL) {
      modelsDevCache.data = cached.data;
      modelsDevCache.fetchedAt = cached.fetchedAt;
      return cached.data;
    }
  }
  try {
    const resp = await fetch('https://models.dev/api.json', {
      headers: { 'User-Agent': 'cibyp/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return modelsDevCache.data || null;
    const data = await resp.json();
    modelsDevCache.data = data;
    modelsDevCache.fetchedAt = Date.now();
    try { fs.writeFileSync(modelsDevCacheFile(), JSON.stringify({ fetchedAt: modelsDevCache.fetchedAt, data }), 'utf8'); } catch { /* ignore */ }
    return data;
  } catch {
    return modelsDevCache.data || null;
  }
}

function lookupModelsDevModel(data, modelId, provider) {
  if (!data || typeof data !== 'object') return null;
  const wanted = String(modelId || '').toLowerCase();
  if (!wanted) return null;
  const providerKeys = provider === 'opencode-go' ? ['opencode-go', 'opencode'] : ['opencode', 'opencode-go'];
  for (const pk of providerKeys) {
    const prov = data[pk];
    const models = prov && (prov.models || null);
    if (!models || typeof models !== 'object') continue;
    if (models[wanted]) return { providerKey: pk, model: models[wanted] };
  }
  for (const [pk, prov] of Object.entries(data)) {
    const models = prov && prov.models;
    if (!models || typeof models !== 'object') continue;
    if (models[wanted]) return { providerKey: pk, model: models[wanted] };
  }
  return null;
}

function normalizeAnthropicThinkingCapability(raw) {
  if (!raw) return null;
  const t = raw.thinking || raw.extended_thinking || raw.extendedThinking || null;
  if (!t) return null;
  const out = {};
  if (typeof t.supported === 'boolean') out.supported = t.supported;
  if (t.adaptive === true || t.type === 'adaptive' || (Array.isArray(t.supported_types) && t.supported_types.includes('adaptive'))) {
    out.adaptive = true;
    out.type = 'adaptive';
  } else if (t.type === 'legacy' || t.budgetTokens === true || t.budget_tokens === true) {
    out.type = 'legacy';
  }
  return out;
}

// 解析 Anthropic /v1/models capabilities.effort（新版官方字段），兼容多种形状
function normalizeAnthropicEffortCapability(raw) {
  if (!raw) return null;
  const e = raw.effort || raw.reasoning_effort || raw.reasoningEffort || null;
  if (!e) return null;
  const values = Array.isArray(e) ? e
    : Array.isArray(e.values) ? e.values
    : Array.isArray(e.supported) ? e.supported
    : Array.isArray(e.supported_values) ? e.supported_values
    : Array.isArray(e.types) ? e.types
    : null;
  if (!values || !values.length) return null;
  return { type: 'effort', values };
}

/**
 * 拉取模型元数据（models.dev + Anthropic /models），返回 { capabilities, metadata }。
 * 非 Anthropic 端点主要依赖 models.dev；两者都拿不到时返回 null（走硬编码表）。
 */
async function fetchModelMetadata(provider, model, apiUrl, apiKey) {
  const out = { capabilities: null, metadata: null };
  // 1) models.dev（覆盖 Zen/Go 与常见模型生态）：
  //    有缓存直接用；无缓存最多等 1.5s，其余在后台完成并落盘，避免阻塞设置页
  try {
    let dev = modelsDevCache.data;
    if (!dev) {
      dev = await Promise.race([
        fetchModelsDevData(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
    }
    const entry = lookupModelsDevModel(dev, model, provider);
    if (entry) {
      const m = entry.model || {};
      out.metadata = {
        reasoning: m.reasoning,
        reasoningOptions: m.reasoning_options || m.reasoningOptions || null,
        contextLength: (m.limit && (m.limit.context || m.limit.input)) || m.context_length || null,
        maxOutput: (m.limit && m.limit.output) || null,
        source: `models.dev:${entry.providerKey}`,
      };
    }
  } catch { /* ignore */ }
  // 2) Anthropic /v1/models：thinking 模式 + effort 档位 + 上下文长度
  if (provider === 'anthropic-compat' && apiUrl) {
    try {
      const base = String(apiUrl).replace(/\/messages\/?$/, '').replace(/\/$/, '');
      const modelsUrl = `${base}/models`;
      const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (apiKey) headers['x-api-key'] = apiKey;
      const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = await resp.json();
        const list = data.data || data.models || data || [];
        const entry = (Array.isArray(list) ? list : []).find(x => String(x.id) === String(model))
          || (Array.isArray(list) ? list[0] : null);
        if (entry && entry.capabilities) {
          const thinking = normalizeAnthropicThinkingCapability(entry.capabilities);
          if (thinking) out.capabilities = { thinking };
          const effort = normalizeAnthropicEffortCapability(entry.capabilities);
          out.metadata = out.metadata || {};
          if (effort) out.metadata.reasoningOptions = effort;
          const ctx = (entry.limit && entry.limit.context) || entry.context_length || null;
          if (ctx && !out.metadata.contextLength) out.metadata.contextLength = ctx;
          if (!out.metadata.source) out.metadata.source = 'anthropic:/models';
        }
      }
    } catch { /* ignore */ }
  }
  if (!out.capabilities && !out.metadata) return null;
  return out;
}

function getCachedModelMetadata(model, provider, apiUrl, apiKey) {
  const key = `${provider}|${model}|${apiUrl}`;
  const hit = modelCapabilityCache.get(key);
  if (hit && Date.now() - hit.ts < MODEL_CAPABILITY_TTL) return hit;
  // 不阻塞请求：异步预热缓存；首次请求先用模型名推断/硬编码兜底
  fetchModelMetadata(provider, model, apiUrl, apiKey)
    .then((res) => {
      modelCapabilityCache.set(key, { capabilities: res ? res.capabilities : null, metadata: res ? res.metadata : null, ts: Date.now() });
    })
    .catch(() => {});
  return null;
}

// ---- IPC: 模型变体能力查询（设置页/命令面板用） ----
ipcMain.handle('llm:capabilities', async (_, provider, model, apiUrl, apiKey) => {
  try {
    const effectiveProvider = provider || settings.llm.provider || 'openai-compat';
    const effectiveModel = model || settings.llm.model || '';
    const effectiveUrl = apiUrl || settings.llm.apiUrl || '';
    const effectiveKey = apiKey !== undefined ? apiKey
      : (effectiveProvider === 'opencode-zen' ? settings.llm.zenApiKey : settings.llm.apiKey);
    const key = `${effectiveProvider}|${effectiveModel}|${effectiveUrl}`;
    let hit = modelCapabilityCache.get(key);
    if (!hit || Date.now() - hit.ts >= MODEL_CAPABILITY_TTL) {
      const res = await fetchModelMetadata(effectiveProvider, effectiveModel, effectiveUrl, effectiveKey);
      hit = {
        capabilities: res ? res.capabilities : null,
        metadata: res ? res.metadata : null,
        ts: Date.now(),
      };
      modelCapabilityCache.set(key, hit);
    }
    const table = LLMProviders.resolveReasoningVariants(effectiveModel, effectiveProvider, hit.capabilities, hit.metadata);
    return {
      ok: true,
      model: effectiveModel,
      provider: effectiveProvider,
      capabilities: hit.capabilities || null,
      metadata: hit.metadata || null,
      contextLength: (hit.metadata && hit.metadata.contextLength) || null,
      variants: table.variants,
      defaultId: table.defaultId,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: 外置视觉（纯文本模型的眼睛）----
// 当主模型不支持多模态时，通过独立配置的 VLM API 描述图片，结果作为文本返回给 Agent。
// usage 走 recordTokenUsage → 价格表/预算控制/上下文模态框自动纳入。
ipcMain.handle('vision:describeImage', async (_, { dataUrl, prompt }) => {
  try {
    const ev = settings.llm?.externalVision;
    if (!ev || !ev.apiUrl || !ev.model) return { ok: false, error: '外置视觉未配置（需要在 LLM 设置中填写 API URL 和模型名）' };
    if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, error: '缺少图片数据' };
    const userText = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : '详细描述这张图片的全部内容（界面元素、文字、图表、物体、布局），供无法直接看图的文本模型使用。';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }];
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ev.apiKey || ''}` };
    const body = JSON.stringify({ model: ev.model, messages, max_tokens: 4096 });
    // 智能拼接：如果 apiUrl 已含 /chat/completions 则直接用，否则追加
    let url = ev.apiUrl.replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) url += '/chat/completions';
    console.log(`[VLM ${logTs()}] → POST ${maskLogUrl(url)} model=${ev.model} img:${Math.round(dataUrl.length / 1024)}KB prompt:"${logSnippet(userText, 80)}"`);
    const vlmStartedAt = Date.now();
    const resp = await fetch(url, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const preview = errText.startsWith('<') ? `[HTML ${resp.status}]` : errText.slice(0, 200);
      console.error(`[VLM ${logTs()}] ✗ ${resp.status} (${Date.now() - vlmStartedAt}ms) model=${ev.model}: ${preview}`);
      return { ok: false, error: `VLM API ${resp.status}: ${preview}` };
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || null;
    if (usage) recordTokenUsage(usage, ev.model);
    console.log(`[VLM ${logTs()}] ✓ ${resp.status} (${Date.now() - vlmStartedAt}ms) model=${ev.model} → ${content.length}chars tokens:${usage?.prompt_tokens || '?'}+${usage?.completion_tokens || '?'}=${usage?.total_tokens || '?'}`);
    return { ok: true, description: content, usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null };
  } catch (e) {
    console.error(`[VLM ${logTs()}] ✗ request failed:`, e.message);
    return { ok: false, error: e.message };
  }
});

// ---- IPC: LLM API Call (with retry/backoff/timeout) ----
// 会话级模型覆盖：模型池条目在会话创建时锁定，随每次请求携带 provider/apiUrl/apiKey
function applySessionModelOverrides(baseLlm, options) {
  if (!options || typeof options !== 'object') return baseLlm;
  const out = { ...baseLlm };
  if (options.provider) out.provider = options.provider;
  if (options.apiUrl) out.apiUrl = options.apiUrl;
  if (options.apiKey !== undefined && options.apiKey !== null && options.apiKey !== '') {
    out.apiKey = options.apiKey;
    if (out.provider === 'opencode-zen' || out.provider === 'opencode-go') out.zenApiKey = options.apiKey;
  }
  return out;
}

ipcMain.handle('llm:chat', async (event, messages, options = {}) => {
  try {
    const llm = applySessionModelOverrides(settings.llm, options);
    if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先在设置中配置OpenCode API Key和模型' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    // 预算控制：检查是否超限（已移除自动降级模型：会话锁定后不自动切换，保护提示词缓存）
    const budgetCheck = checkBudgetExceeded(settings.budget || {});
    if (budgetCheck.exceeded) {
      if (budgetCheck.action === 'stop' || budgetCheck.action === 'fallback') {
        return { ok: false, error: `预算超限（${budgetCheck.period}周期已用 $${budgetCheck.cost.toFixed(4)} / $${budgetCheck.limit.toFixed(2)}），已停止接受新请求` };
      }
    }

    // 会话级覆盖优先：/model 或会话锁定的模型池条目（options.model/provider/apiUrl/apiKey）
    const requestModel = options.model || llm.model;
    const requestEffort = options.reasoningEffort !== undefined ? options.reasoningEffort
      : (llm.reasoningEffort || 'off');
    const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
    const variantCheck = LLMProviders.validateReasoningEffort(requestEffort, requestModel, llm.provider, capabilities, modelMeta ? modelMeta.metadata : null);
    const llmForRequest = { ...llm, model: requestModel, capabilities };
    const req = LLMProviders.buildLLMRequest(llmForRequest, {
      messages: normalizeMessagesForThinking(messages),
      tools: options.tools,
      tool_choice: options.tool_choice,
      temperature: options.temperature ?? llm.temperature,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      response_format: options.response_format || null,
      reasoningEffort: variantCheck.resolved,
      stream: false,
      // OpenCode 官方头组（x-opencode-session/request）所需的会话与请求标识
      sessionKey: options.sessionKey || null,
      requestId: options.requestId || null
    });

    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      requestId: options.requestId || null,
      sessionKey: options.sessionKey || null
    };
    const onRetry = (info) => {
      // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
      try { mainWindow?.webContents.send('llm:retry', { ...info, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    };

    const result = await fetchLLMWithRetry({
      label: 'LLM:chat',
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body, options: retryOpts, onRetry
    });
    if (!result.ok) {
      console.error(`[LLM:chat ${logTs()}] ✗ ${llmForRequest.model} ← ${maskLogUrl(req.url)}: ${result.error}`);
      return { ok: false, error: result.error, kind: result.kind };
    }

    try {
      rawData = await result.response.json();
    } finally {
      if (typeof result.releaseController === 'function') result.releaseController();
    }
    if (rawData.error) {
      console.error(`[LLM] ${llmForRequest.model} API error:`, JSON.stringify(rawData.error).slice(0, 200));
      return { ok: false, error: rawData.error.message || JSON.stringify(rawData.error) };
    }
    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    let usage = data.usage || {};
    // API 未返回 usage 时估算并标记（前端用 ~ 前缀显示）
    if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
      const estPrompt = estimateTokens(JSON.stringify(req.body));
      const estCompletion = estimateTokens(data.choices?.[0]?.message?.content || '');
      usage = {
        prompt_tokens: estPrompt,
        completion_tokens: estCompletion,
        total_tokens: estPrompt + estCompletion,
        _estimated: true
      };
      data.usage = usage;
    }
    // 终端日志：请求摘要 + 结果截断 + token 用量
    {
      const content = data.choices?.[0]?.message?.content || '';
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      const reasoning = data.choices?.[0]?.message?.reasoning || data.choices?.[0]?.message?.reasoning_content || '';
      const preview = typeof content === 'string' ? content.slice(0, 120) : JSON.stringify(content || '').slice(0, 120);
      const suffix = content.length > 120 ? `…[${content.length} 字符]` : '';
      console.log(`[LLM:chat ${logTs()}] ✓ ${llmForRequest.model} finish=${data.choices?.[0]?.finish_reason || '-'} tokens:${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}${usage._estimated ? '(est)' : ''} reasoning=${reasoning.length}chars → "${preview}${suffix}"${toolCalls ? ` | tool_calls:${toolCalls.length}` : ''}`);
    }
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(data.choices?.[0]?.message?.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    // 按实际请求模型归属（含会话级覆盖 / 预算 fallback）
    recordTokenUsage(usage, llmForRequest.model);
    persistSettings();
    broadcastUsageChanged();
    // 游戏窗口/子窗口调用 LLM 时，把 usage 推送给主渲染器，让其累计到当前会话统计
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
      try { mainWindow.webContents.send('llm:external-usage', { usage, model: llmForRequest.model, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    }
    // 回填实际模型/变体，供渲染层按模型累计会话统计
    data._meta = {
      model: llmForRequest.model,
      reasoningEffort: variantCheck.resolved,
      variantChanged: variantCheck.changed
    };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Streaming (with retry/backoff/timeout) ----
ipcMain.handle('llm:chatStream', async (_, messages, options = {}) => {
  try {
    const llm = applySessionModelOverrides(settings.llm, options);
    if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先在设置中配置OpenCode API Key和模型' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    // 预算控制：检查是否超限（已移除自动降级；会话锁定模型不自动切换）
    const budgetCheck = checkBudgetExceeded(settings.budget || {});
    if (budgetCheck.exceeded && (budgetCheck.action === 'stop' || budgetCheck.action === 'fallback')) {
      return { ok: false, error: `预算超限（${budgetCheck.period}周期已用 $${budgetCheck.cost.toFixed(4)} / $${budgetCheck.limit.toFixed(2)}），已停止接受新请求` };
    }
    // 会话级覆盖优先：/model 或会话锁定的模型池条目
    const requestModel = options.model || llm.model;
    const requestEffort = options.reasoningEffort !== undefined ? options.reasoningEffort
      : (llm.reasoningEffort || 'off');
    const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
    const variantCheck = LLMProviders.validateReasoningEffort(requestEffort, requestModel, llm.provider, capabilities, modelMeta ? modelMeta.metadata : null);
    const llmForRequest = { ...llm, model: requestModel, capabilities };

    const req = LLMProviders.buildLLMRequest(llmForRequest, {
      messages: normalizeMessagesForThinking(messages),
      tools: options.tools,
      tool_choice: options.tool_choice,
      temperature: options.temperature ?? llm.temperature,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      reasoningEffort: variantCheck.resolved,
      stream: true,
      // OpenCode 官方头组（x-opencode-session/request）所需的会话与请求标识
      sessionKey: options.sessionKey || null,
      requestId: options.requestId || null
    });

    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      requestId: options.requestId || null,
      sessionKey: options.sessionKey || null
    };
    const onRetry = (info) => {
      // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
      try { mainWindow?.webContents.send('llm:retry', { ...info, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    };

    const result = await fetchLLMWithRetry({
      label: 'LLM:stream',
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body, options: retryOpts, onRetry
    });
    if (!result.ok) return { ok: false, error: result.error, kind: result.kind };

    let streamResult;
    let lastChunkKey = null;
    const streamStartedAt = Date.now();
    try {
      streamResult = await consumeSSEStream(result.response.body, (chunk) => {
        try {
          if (chunk.content || chunk.reasoning) {
            const chunkKey = String(chunk.content || '') + '\u0000' + String(chunk.reasoning || '');
            // 丢弃与上一 chunk 完全相同的连续重复（防御流式传输双发导致的逐字/逐词重复）
            if (chunkKey === lastChunkKey) return;
            lastChunkKey = chunkKey;
            mainWindow?.webContents.send('llm:stream-chunk', {
              content: chunk.content || '',
              reasoning: chunk.reasoning || '',
              streamTimeout: chunk.streamTimeout || false,
              requestId: options.requestId
            });
          }
        } catch { /* ignore */ }
      }, options.requestId, req.transport, 120000, {
        label: 'LLM:stream',
        model: llmForRequest.model
      });
    } finally {
      // 流读取结束（正常完成或被 abort）后释放 controller
      if (typeof result.releaseController === 'function') result.releaseController();
    }

    mainWindow?.webContents.send('llm:stream-end', { requestId: options.requestId });
    let usage = streamResult.usage || {};
    let estimated = false;
    // API 未返回 usage 时估算并标记
    if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
      const estPrompt = estimateTokens(JSON.stringify(req.body));
      const estCompletion = estimateTokens(streamResult.content || '');
      usage = {
        prompt_tokens: estPrompt,
        completion_tokens: estCompletion,
        total_tokens: estPrompt + estCompletion,
        _estimated: true
      };
      estimated = true;
    }
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(streamResult.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llmForRequest.model);
    persistSettings();
    broadcastUsageChanged();
    return {
      ok: true,
      data: {
        choices: [{
          message: {
            role: 'assistant',
            content: streamResult.content,
            reasoning: streamResult.reasoning || undefined,
            tool_calls: streamResult.toolCalls
          },
          finish_reason: streamResult.finishReason
        }],
        usage: { ...usage, _estimated: estimated },
        _meta: {
          model: llmForRequest.model,
          reasoningEffort: variantCheck.resolved,
          variantChanged: variantCheck.changed
        }
      }
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Summary (one-shot, no tools, for context compaction) ----
ipcMain.handle('llm:summarize', async (_, messages, options = {}) => {
  try {
    const llm = applySessionModelOverrides(settings.llm, options);
    if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先配置OpenCode' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    // 会话级覆盖：压缩摘要与主请求同模型/同变体，复用暖前缀缓存
    const requestModel = options.model || llm.model;
    const requestEffort = options.reasoningEffort !== undefined ? options.reasoningEffort
      : (llm.reasoningEffort || 'off');
    const modelMeta = getCachedModelMetadata(requestModel, llm.provider, llm.apiUrl, llm.apiKey);
      const capabilities = modelMeta ? modelMeta.capabilities : null;
    const variantCheck = LLMProviders.validateReasoningEffort(requestEffort, requestModel, llm.provider, capabilities, modelMeta ? modelMeta.metadata : null);
    const llmForRequest = { ...llm, model: requestModel, capabilities };
    const req = LLMProviders.buildLLMRequest(llmForRequest, {
      messages: normalizeMessagesForThinking(messages),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      stream: false,
      // 上下文压缩的"会话回放"：携带与主请求一致的 tools，复用暖前缀缓存
      // （DeepSeek 按输入前缀逐字节匹配；tools 位于前缀内）。
      tools: Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : undefined,
      // purpose 仅作归属标记（对应 dsh 的 x-deepseek-harness-compact 语义），
      // 不改动模型可见内容，各 provider 忽略即可。
      purpose: options.purpose || undefined,
      reasoningEffort: variantCheck.resolved,
      // OpenCode 官方头组所需的会话与请求标识
      sessionKey: options.sessionKey || null,
      requestId: options.requestId || null
    });
    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      sessionKey: options.sessionKey || null
    };
    const result = await fetchLLMWithRetry({
      label: 'LLM:summarize',
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body, options: retryOpts
    });
    if (!result.ok) return { ok: false, error: result.error, kind: result.kind };
    let rawData;
    try {
      rawData = await result.response.json();
    } finally {
      if (typeof result.releaseController === 'function') result.releaseController();
    }
    if (rawData.error) return { ok: false, error: rawData.error.message || JSON.stringify(rawData.error) };
    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const content = data.choices?.[0]?.message?.content || '';
    let usage = data.usage || {};
    if (!usage.total_tokens && !usage.prompt_tokens && !usage.completion_tokens) {
      const estPrompt = estimateTokens(JSON.stringify(req.body));
      const estCompletion = estimateTokens(content);
      usage = { prompt_tokens: estPrompt, completion_tokens: estCompletion, total_tokens: estPrompt + estCompletion, _estimated: true };
    }
    console.log(`[LLM:summarize ${logTs()}] ✓ ${llmForRequest.model} tokens:${usage.prompt_tokens || 0}+${usage.completion_tokens || 0}=${usage.total_tokens || 0}${usage._estimated ? '(est)' : ''} summary=${content.length}chars`);
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(content);
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llmForRequest.model);
    persistSettings();
    broadcastUsageChanged();
    data._meta = {
      model: llmForRequest.model,
      reasoningEffort: variantCheck.resolved,
      variantChanged: variantCheck.changed
    };
    return { ok: true, content, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: 精确 token 计数（Tier1，Anthropic messages 协议支持 count_tokens）----
const _countTokensUnsupported = new Set();
ipcMain.handle('llm:countTokens', async (_, payload = {}) => {
  try {
    const llm = settings.llm || {};
    const provider = llm.provider || '';
    const model = payload.model || llm.model || '';
    const apiUrl = payload.apiUrl || llm.apiUrl || '';
    if (!apiUrl || !model) return { ok: false, unsupported: true, error: 'missing apiUrl/model' };
    const isMessagesEndpoint = /\/messages(\?|$)/.test(apiUrl);
    const looksAnthropic = isMessagesEndpoint || provider === 'anthropic-compat' || provider === 'opencode-zen' || provider === 'opencode-go';
    if (!looksAnthropic) return { ok: false, unsupported: true, error: 'count_tokens unsupported for this provider' };
    let countUrl;
    if (isMessagesEndpoint) countUrl = apiUrl.replace(/\/messages(\?.*)?$/, '/messages/count_tokens');
    else if (/\/chat\/completions(\?|$)/.test(apiUrl)) countUrl = apiUrl.replace(/\/chat\/completions(\?.*)?$/, '/messages/count_tokens');
    else countUrl = apiUrl.replace(/\/+$/, '') + '/messages/count_tokens';
    if (_countTokensUnsupported.has(countUrl)) return { ok: false, unsupported: true, error: 'cached unsupported' };
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    const apiKey = payload.apiKey || llm.apiKey || llm.zenApiKey || '';
    if (provider === 'opencode-zen' || provider === 'opencode-go') headers['Authorization'] = `Bearer ${apiKey || 'public'}`;
    else if (apiKey) headers['x-api-key'] = apiKey;
    const finalHeaders = ocHeaders.applyProviderHeaders({
      url: countUrl,
      headers,
      llm: { ...llm, customHeaders: llm.customHeaders || [] },
      sessionKey: payload.sessionKey || 'count',
    });
    const body = { model, messages: Array.isArray(payload.messages) ? payload.messages : [] };
    if (payload.system) body.system = String(payload.system);
    if (Array.isArray(payload.tools) && payload.tools.length) body.tools = payload.tools;
    const resp = await fetch(countUrl, {
      method: 'POST',
      headers: finalHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 404 || resp.status === 400 || resp.status === 405 || resp.status === 501) {
      _countTokensUnsupported.add(countUrl);
      return { ok: false, unsupported: true, error: `HTTP ${resp.status}` };
    }
    const data = await resp.json().catch(() => null);
    const tokens = data && (data.input_tokens ?? data.tokens ?? data.total_tokens);
    if (!resp.ok || !Number.isFinite(Number(tokens))) {
      return { ok: false, error: (data && data.error && data.error.message) || `HTTP ${resp.status}` };
    }
    return { ok: true, tokens: Number(tokens), model };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: OpenCode models list（mode: 'zen'（默认）| 'go'）----
ipcMain.handle('zen:fetchModels', async (_, mode) => {
  try {
    const isGo = mode === 'go' || mode === 'opencode-go';
    const base = isGo ? LLMProviders.OC_GO_BASE : LLMProviders.ZEN_BASE;
    const modelsUrl = `${base}/models`;
    const apiKey = settings.llm.zenApiKey;
    const baseHeaders = { 'Content-Type': 'application/json' };
    if (apiKey) baseHeaders['Authorization'] = `Bearer ${apiKey}`;
    // 自动附加 OpenCode 官方头组 + 用户自定义头
    const headers = ocHeaders.applyProviderHeaders({
      url: modelsUrl,
      headers: baseHeaders,
      llm: settings.llm
    });
    // 10 秒超时，避免网络挂起导致向导永远卡在"正在获取模型列表..."
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let resp;
    try {
      resp = await fetch(modelsUrl, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, models: data.data || data.models || data };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: '请求超时（10s），请检查网络连接' };
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Generic LLM models list (OpenAI/Anthropic compatible) ----
ipcMain.handle('llm:fetchModels', async (_, provider, apiUrl, apiKey) => {
  try {
    if (!provider || !apiUrl) return { ok: false, error: '缺少 provider 或 apiUrl' };
    let modelsUrl = '';
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic-compat') {
      // Anthropic: 从 /v1/messages 推导 /v1/models
      const base = apiUrl.replace(/\/messages\/?$/, '');
      modelsUrl = base.replace(/\/$/, '') + '/models';
      headers['x-api-key'] = apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider === 'openai-responses') {
      // OpenAI Responses API: 从 /v1/responses 推导 /v1/models
      let base = apiUrl;
      base = base.replace(/\/responses\/?$/, '');
      if (!/\/v\d+\/?$/.test(base)) base = base.replace(/\/$/, '') + '/v1';
      modelsUrl = base.replace(/\/$/, '') + '/models';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      // OpenAI 兼容: 从 /chat/completions 推导 /models
      let base = apiUrl;
      // 去掉 /chat/completions 后缀
      base = base.replace(/\/chat\/completions\/?$/, '');
      base = base.replace(/\/completions\/?$/, '');
      // 如果没有 /v1 后缀，加上
      if (!/\/v\d+\/?$/.test(base)) base = base.replace(/\/$/, '') + '/v1';
      modelsUrl = base.replace(/\/$/, '') + '/models';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // 统一套用：用户自定义请求头 + URL 命中 opencode.ai 时自动官方头组
    const finalHeaders = ocHeaders.applyProviderHeaders({
      url: modelsUrl,
      headers,
      llm: settings.llm
    });
    const resp = await fetch(modelsUrl, { headers: finalHeaders, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, models: data.data || data.models || data };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { ok: false, error: '请求超时（10s），请检查网络或 API URL' };
    return { ok: false, error: e.message };
  }
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
  return result;
});

// ---- IPC: Budget check (预算检查，供 LLM 请求前调用) ----
ipcMain.handle('budget:check', () => {
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
    const result = await dialog.showOpenDialog(mainWindow, {
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
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters
    });
    return { ok: !result.canceled, path: result.filePath || '' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Chat History ----
// ---- 历史保存防抖队列 ----
// agentLoop 每轮迭代都会全量保存历史（1~2 次），一次对话可达数十次。
// 防抖合并：仅保留最后一次数据写盘（紧凑 JSON），大幅降低 JSON 序列化
// 与磁盘 I/O 的峰值压力；退出前 flush 保证数据不丢失。
// ---- History v2：图片外置 + 元数据索引 ----
// 1) 会话消息里的 base64 图片（image_url part）落盘到 images/history/<id>/，历史 JSON 只存文件引用；
//    恢复会话（用于上下文/LLM 请求）时再 rehydrate 回 data URL。
// 2) 列表元数据维护在 *-index.json，history:list/code:listHistory 不再解析全部历史文件。
const historyImagesDir = path.join(imagesDir, 'history');
const HISTORY_INDEX_VERSION = 2;

function _historyIndexFile(kind, dir) {
  if (kind === 'chat') return path.join(dataDir, 'history-index.json');
  if (kind === 'babe') return path.join(dataDir, 'babe-history-index.json');
  return path.join(dir, 'index.json');
}

function _loadHistoryIndex(indexFile) {
  const data = loadJSON(indexFile, null);
  if (data && data.version === HISTORY_INDEX_VERSION && data.entries && typeof data.entries === 'object') {
    return data.entries;
  }
  return null;
}

function _saveHistoryIndex(indexFile, entries) {
  // 统一记录运行位置：跨模式继续会话时做同步护栏（见 code:loadHistory）
  try {
    const loc = (settings.runtime && settings.runtime.location) === 'vm' ? 'vm' : 'host';
    if (entries && typeof entries === 'object') {
      for (const k of Object.keys(entries)) {
        if (entries[k] && typeof entries[k] === 'object') entries[k].runtimeLocation = loc;
      }
    }
  } catch { /* ignore */ }

  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ version: HISTORY_INDEX_VERSION, entries }), 'utf8');
  } catch { /* ignore */ }
}

function _historyJsonFiles(dir, indexFile) {
  try {
    const indexName = indexFile ? path.basename(indexFile) : '';
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== indexName);
  } catch {
    return [];
  }
}

function _rebuildHistoryIndex(dir, indexFile, metaBuilder) {
  const entries = {};
  for (const f of _historyJsonFiles(dir, indexFile)) {
    try {
      const filePath = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const meta = metaBuilder(f.replace(/\.json$/, ''), data, filePath);
      if (meta) entries[meta.id] = meta;
    } catch { /* 单个损坏文件跳过 */ }
  }
  _saveHistoryIndex(indexFile, entries);
  return entries;
}

function _getHistoryIndex(dir, indexFile, metaBuilder) {
  let entries = _loadHistoryIndex(indexFile);
  const fileCount = _historyJsonFiles(dir, indexFile).length;
  if (!entries || Object.keys(entries).length !== fileCount) {
    entries = _rebuildHistoryIndex(dir, indexFile, metaBuilder);
  }
  return entries;
}

function _putHistoryIndexEntry(indexFile, id, meta) {
  const entries = _loadHistoryIndex(indexFile) || {};
  entries[id] = meta;
  _saveHistoryIndex(indexFile, entries);
}

function _removeHistoryIndexEntry(indexFile, id) {
  const entries = _loadHistoryIndex(indexFile);
  if (!entries) return;
  delete entries[id];
  _saveHistoryIndex(indexFile, entries);
}

function _historyImageExt(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'bin';
}

function _externalizeHistoryImages(conversation) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const dir = path.join(historyImagesDir, String(conversation.id || 'unknown'));
  let counter = 0;
  for (const msg of conversation.messages) {
    if (!Array.isArray(msg && msg.content)) continue;
    for (const part of msg.content) {
      const url = part && part.image_url && part.image_url.url;
      if (typeof url !== 'string' || !url.startsWith('data:')) continue;
      try {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        if (!m) continue;
        const file = path.join(dir, `img-${Date.now()}-${counter++}.${_historyImageExt(m[1])}`);
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        const { pathToFileURL } = require('url');
        part.image_url = { url: pathToFileURL(file).href, _cibypHistoryFile: true };
      } catch { /* 失败保留原始数据 */ }
    }
  }
  return conversation;
}

function _rehydrateHistoryImages(conversation) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const { fileURLToPath } = require('url');
  for (const msg of conversation.messages) {
    if (!Array.isArray(msg && msg.content)) continue;
    for (const part of msg.content) {
      const iu = part && part.image_url;
      if (!iu || !iu._cibypHistoryFile || typeof iu.url !== 'string') continue;
      try {
        const p = fileURLToPath(iu.url);
        if (!fs.existsSync(p)) continue;
        const ext = path.extname(p).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'application/octet-stream';
        part.image_url = { url: `data:${mime};base64,` + fs.readFileSync(p).toString('base64') };
      } catch { /* ignore */ }
    }
  }
  return conversation;
}

function _deleteHistoryImages(conversationId) {
  try {
    fs.rmSync(path.join(historyImagesDir, String(conversationId)), { recursive: true, force: true });
  } catch { /* ignore */ }
}

// 一次性迁移：把现存历史里的 base64 图片外置（备份原目录，只执行一次）
async function migrateHistoryV2() {
  if (settings.performance?.historyV2Migrated) return;
  try {
    const jobs = [
      { dir: historyDir, indexFile: _historyIndexFile('chat', historyDir) },
      { dir: babeHistoryDir, indexFile: _historyIndexFile('babe', babeHistoryDir) },
    ];
    // 迁移前整目录备份一次（只备份 >1MB 的文件以控制磁盘占用）
    const backupRoot = path.join(dataDir, 'history-v1-backup');
    try { fs.mkdirSync(backupRoot, { recursive: true }); } catch { /* ignore */ }
    let migrated = 0;
    for (const { dir, indexFile } of jobs) {
      const files = _historyJsonFiles(dir, indexFile);
      for (let i = 0; i < files.length; i++) {
        if (i % 5 === 0) await new Promise((r) => setImmediate(r));
        const filePath = path.join(dir, files[i]);
        try {
          if (fs.statSync(filePath).size < 256 * 1024) continue;
          const raw = fs.readFileSync(filePath, 'utf8');
          if (!raw.includes('"data:')) continue;
          const data = JSON.parse(raw);
          _externalizeHistoryImages(data);
          try { fs.copyFileSync(filePath, path.join(backupRoot, path.basename(dir) + '-' + files[i])); } catch { /* ignore */ }
          saveJSON(filePath, data, false);
          migrated++;
        } catch { /* 单个失败不影响其余 */ }
      }
    }
    settings.performance = settings.performance || {};
    settings.performance.historyV2Migrated = true;
    scheduleSettingsPersist();
    if (migrated > 0) console.log(`[history] v2 migration externalized images in ${migrated} file(s)`);
  } catch (e) {
    console.warn('[history] v2 migration failed:', e && e.message);
  }
}

const pendingHistorySaves = new Map(); // key -> { timer, filePath, data }
const HISTORY_SAVE_DEBOUNCE_MS = 1200;

function queueHistorySave(key, filePath, data) {
  const existing = pendingHistorySaves.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingHistorySaves.delete(key);
    try { saveJSON(filePath, data, false); } catch (e) { console.error('queueHistorySave write failed:', e); }
  }, HISTORY_SAVE_DEBOUNCE_MS);
  pendingHistorySaves.set(key, { timer, filePath, data });
}

function flushPendingHistorySaves() {
  if (pendingHistorySaves.size === 0) return;
  for (const [key, { timer, filePath, data }] of pendingHistorySaves) {
    clearTimeout(timer);
    try { saveJSON(filePath, data, false); } catch (e) { console.error('flushPendingHistorySaves write failed:', e); }
    pendingHistorySaves.delete(key);
  }
}

function _chatHistoryMeta(id, data) {
  return {
    id: data.id || id,
    title: data.title || '未命名对话',
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    mode: data.mode || 'chat',
    status: data.status || 'idle',
    lastError: data.lastError || null,
    usage: data.usage || null,
    finishedAt: data.finishedAt || null,
    workingMs: Number(data.workingMs) || 0
  };
}

ipcMain.handle('history:list', () => {
  try {
    flushPendingHistorySaves();
    const indexFile = _historyIndexFile('chat', historyDir);
    const entries = _getHistoryIndex(historyDir, indexFile, _chatHistoryMeta);
    return Object.values(entries)
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  } catch { return []; }
});

// ---- 历史搜索（标题/内容）----
// field='title' 只匹配标题；field='content' 扫描各会话消息内容并生成关键词上下文片段。
// 按时间新→旧排序，offset/limit 分页返回，避免把全部历史内容一次灌给渲染器。
function _extractHistorySearchText(msg) {
  if (!msg) return '';
  if (msg.role === 'tool') return `${msg.name || ''} ${msg.content || ''}`;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(p => (p && p.text) ? p.text : '').join(' ');
  }
  return '';
}

function _makeSearchSnippet(text, idx, len, radius = 40) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  return {
    pre: (start > 0 ? '…' : '') + text.slice(start, idx),
    hit: text.slice(idx, idx + len),
    post: text.slice(idx + len, end) + (end < text.length ? '…' : '')
  };
}

ipcMain.handle('history:search', async (_, opts = {}) => {
  const mode = opts.mode || 'chat';
  const field = opts.field === 'content' ? 'content' : 'title';
  const query = String(opts.query || '').trim().toLowerCase();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
  if (!query) return { ok: true, total: 0, results: [], hasMore: false };

  let dir;
  if (mode === 'code') {
    dir = getCodeHistoryDir(opts.workspacePath || settings.codeMode?.lastWorkspace || null);
    if (!dir) return { ok: false, error: '未打开 Code 工作区' };
  } else if (mode === 'babe') {
    dir = babeHistoryDir;
  } else {
    dir = historyDir;
  }

  try {
    flushPendingHistorySaves();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const matches = [];
    const SNIPPET_CAP = 30;
    const MSG_SCAN_CAP = 800;
    const MSG_LEN_CAP = 30000;
    for (let fi = 0; fi < files.length; fi++) {
      // 定期让出事件循环，避免扫描大量历史时阻塞主进程
      if (fi % 8 === 0) await new Promise(r => setImmediate(r));
      try {
        const filePath = path.join(dir, files[fi]);
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
        const id = files[fi].replace(/\.json$/, '');
        const title = data.title || '未命名';
        const updatedAt = data.updatedAt || data.ts || null;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        if (field === 'title') {
          if (!String(title).toLowerCase().includes(query)) continue;
          matches.push({
            id, title, updatedAt, messageCount: messages.length,
            workspacePath: data.workspacePath || null, affection: data.affection ?? 0,
            snippets: [], snippetTotal: 0
          });
        } else {
          const snippets = [];
          const scanLimit = Math.min(messages.length, MSG_SCAN_CAP);
          for (let mi = 0; mi < scanLimit && snippets.length < SNIPPET_CAP; mi++) {
            const text = _extractHistorySearchText(messages[mi]).slice(0, MSG_LEN_CAP);
            if (!text) continue;
            const lower = text.toLowerCase();
            let idx = 0;
            while (snippets.length < SNIPPET_CAP) {
              idx = lower.indexOf(query, idx);
              if (idx === -1) break;
              snippets.push(_makeSearchSnippet(text, idx, query.length));
              idx += Math.max(1, query.length);
            }
          }
          if (!snippets.length) continue;
          matches.push({
            id, title, updatedAt, messageCount: messages.length,
            workspacePath: data.workspacePath || null, affection: data.affection ?? 0,
            snippets, snippetTotal: snippets.length
          });
        }
      } catch { /* 单个历史文件损坏时跳过 */ }
    }
    matches.sort((a, b) => {
      const ta = typeof a.updatedAt === 'number' ? a.updatedAt : (Date.parse(a.updatedAt) || 0);
      const tb = typeof b.updatedAt === 'number' ? b.updatedAt : (Date.parse(b.updatedAt) || 0);
      return tb - ta;
    });
    const total = matches.length;
    const results = matches.slice(offset, offset + limit);
    return { ok: true, total, hasMore: offset + limit < total, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('history:get', (_, id) => {
  flushPendingHistorySaves();
  const p = path.join(historyDir, `${id}.json`);
  return _rehydrateHistoryImages(loadJSON(p, null));
});

ipcMain.handle('history:save', (_, conversation) => {
  if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  _externalizeHistoryImages(conversation);
  queueHistorySave('history:' + conversation.id, path.join(historyDir, `${conversation.id}.json`), conversation);
  _putHistoryIndexEntry(_historyIndexFile('chat', historyDir), conversation.id, _chatHistoryMeta(conversation.id, conversation));
  return { ok: true, queued: true };
});

ipcMain.handle('history:delete', (_, id) => {
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(historyDir, `${id}.json`));
    _removeHistoryIndexEntry(_historyIndexFile('chat', historyDir), id);
    _deleteHistoryImages(id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:rename', (_, id, title) => {
  flushPendingHistorySaves();
  const p = path.join(historyDir, `${id}.json`);
  const data = loadJSON(p, null);
  if (data) {
    data.title = title;
    data.updatedAt = new Date().toISOString();
    saveJSON(p, data, false);
    _putHistoryIndexEntry(_historyIndexFile('chat', historyDir), id, _chatHistoryMeta(id, data));
    return { ok: true };
  }
  return { ok: false };
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
  const p = path.join(babeHistoryDir, `${id}.json`);
  return _rehydrateHistoryImages(loadJSON(p, null));
});

ipcMain.handle('babeHistory:save', (_, conversation) => {
  if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  _externalizeHistoryImages(conversation);
  queueHistorySave('babe:' + conversation.id, path.join(babeHistoryDir, `${conversation.id}.json`), conversation);
  _putHistoryIndexEntry(_historyIndexFile('babe', babeHistoryDir), conversation.id, _babeHistoryMeta(conversation.id, conversation));
  return { ok: true, queued: true };
});

ipcMain.handle('babeHistory:delete', (_, id) => {
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(babeHistoryDir, `${id}.json`));
    _removeHistoryIndexEntry(_historyIndexFile('babe', babeHistoryDir), id);
    _deleteHistoryImages(id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('babeHistory:rename', (_, id, title) => {
  flushPendingHistorySaves();
  const p = path.join(babeHistoryDir, `${id}.json`);
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

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('firmware:export', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: '用户取消' };
    const destDir = path.join(result.filePaths[0], 'CIBYP-TRNG');
    const srcDir = path.join(app.getAppPath(), 'IoT-Firmware', 'CIBYP-TRNG');
    
    // 创建目标目录
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    
    // 复制所有文件
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const entries = fs.readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, destPath);
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }
    
    copyDir(srcDir, destDir);
    return { ok: true, path: destDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Workspace (Agent Working Directory) ----
ipcMain.handle('workspace:create', async (_, options = {}) => {
  const inVm = (settings.runtime && settings.runtime.location) === 'vm';
  const vmWorkspaceExists = async (hostPath) => {
    // VM 模式：宿主机存在不代表 VM 里有（Agent 实际工作在 VM 内）
    try {
      const { VmFs } = require('./vm/vm-fs');
      return await new VmFs({ vmService }).exists(hostPath);
    } catch { return false; }
  };
  try {
    // 复用最近一次工作区，避免每次启动都新建目录（历史上已堆积大量空目录）
    // 注意：VM 模式下必须确认"VM 内也有该目录"，否则会一直复用一个 VM 里并不存在的旧目录
    // 复用仅在调用方显式要求时发生（历史遗留的"堆空目录"担忧由调用方决定；
    // 渲染层新会话传 fresh:true，恢复会话则由历史自带 workspacePath，不再调用本接口）
    if (options && options.reuse === true) {
      const last = settings.workspace?.lastWorkspace;
      if (last && fs.existsSync(last) && (!inVm || await vmWorkspaceExists(last))) return { ok: true, path: last, reused: true };
      let latest = '';
      let latestMtime = -1;
      try {
        for (const entry of fs.readdirSync(workspacesBaseDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue; // 跳过 .cibyp-conflicts 等非会话目录
          try {
            const m = fs.statSync(path.join(workspacesBaseDir, entry.name)).mtimeMs;
            if (m > latestMtime) { latestMtime = m; latest = path.join(workspacesBaseDir, entry.name); }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (latest) {
        settings.workspace = { ...(settings.workspace || {}), lastWorkspace: latest };
        scheduleSettingsPersist();
        return { ok: true, path: latest, reused: true };
      }
    }
  } catch { /* fall through to create */ }
  const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(workspacesBaseDir, ts);
  fs.mkdirSync(dir, { recursive: true });
  // VM 模式：同时在虚拟机内建同名目录（Agent 的 fs/终端都作用于 VM）
  if (inVm) {
    try {
      const { VmFs } = require('./vm/vm-fs');
      await new VmFs({ vmService }).makeDirectory(dir);
    } catch (e) { console.warn('[vm] 新工作区在 VM 内创建失败:', e.message); }
  }
  settings.workspace = { ...(settings.workspace || {}), lastWorkspace: dir };
  scheduleSettingsPersist();
  return { ok: true, path: dir, createdInVm: inVm };
});

ipcMain.handle('workspace:getBase', () => workspacesBaseDir);

ipcMain.handle('workspace:openInExplorer', async (_, dirPath) => {
  try {

    const isVm = (settings.runtime && settings.runtime.location) === 'vm';

    if (isVm) {

      const r = await vmService.syncWorkspace({ direction: 'pull', reason: 'open-workspace' }).catch((e) => ({ ok: false, error: e.message }));

      if (!r || !r.ok) console.warn('[vm] 打开工作目录前同步失败:', (r && r.error) || 'unknown');

    }

  } catch { /* ignore */ }

  shell.openPath(dirPath || workspacesBaseDir);
  return { ok: true };
});

ipcMain.handle('workspace:getFileTree', (_, dirPath) => {
  try {
    const tree = generateFileTree(dirPath, '', 0, 3); // 最多3层
    return { ok: true, tree };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function generateFileTree(dir, prefix, depth, maxDepth) {
  if (depth >= maxDepth) return '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let result = '';
    entries.forEach((entry, i) => {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      result += prefix + connector + entry.name + (entry.isDirectory() ? '/\n' : '\n');
      if (entry.isDirectory() && depth < maxDepth - 1) {
        result += generateFileTree(path.join(dir, entry.name), newPrefix, depth + 1, maxDepth);
      }
    });
    return result;
  } catch {
    return '';
  }
}

// Structured file tree for Code mode UI (returns array of {name, path, type, children?})
function generateFileTreeStructured(dir, depth, maxDepth) {
  if (depth >= maxDepth) return [];
  const result = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
  // Skip hidden/node_modules/.git folders
  entries = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.git');
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const node = { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'directory' : 'file' };
    if (entry.isDirectory() && depth < maxDepth - 1) {
      node.children = generateFileTreeStructured(fullPath, depth + 1, maxDepth);
    }
    result.push(node);
  }
  return result;
}

// ---- IPC: Code Mode (workspace + per-workspace history) ----
// Code mode history is stored per-workspace to prevent cross-contamination.
function getCodeHistoryDir(workspacePath) {
  if (!workspacePath) return null;
  // Store history inside the workspace itself in a .cibyp-code-history folder
  const histDir = path.join(workspacePath, '.cibyp-code-history');
  try { fs.mkdirSync(histDir, { recursive: true }); } catch { /* ignore */ }
  return histDir;
}

ipcMain.handle('code:openWorkspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择 Code 模式工作区文件夹'
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const wsPath = result.filePaths[0];
  // Save as last opened workspace
  settings.codeMode = settings.codeMode || {};
  settings.codeMode.lastWorkspace = wsPath;
  persistSettings();
  return { ok: true, path: wsPath };
});

ipcMain.handle('code:getLastWorkspace', () => {
  return settings.codeMode?.lastWorkspace || null;
});

ipcMain.handle('code:setLastWorkspace', (_, wsPath) => {
  if (!wsPath || typeof wsPath !== 'string') return { ok: false };
  settings.codeMode = settings.codeMode || {};
  settings.codeMode.lastWorkspace = wsPath;
  persistSettings();
  return { ok: true };
});

function _codeHistoryMeta(id, data, filePath) {
  let ts = Number(data.ts);
  if (!isFinite(ts) || ts <= 0) {
    try { ts = fs.statSync(filePath).mtimeMs; } catch { ts = 0; }
  }
  return {
    id,
    title: data.title || '未命名',
    ts,
    messageCount: (data.messages || []).length,
    mode: data.mode || 'code',
    status: data.status || 'idle',
    lastError: data.lastError || null,
    usage: data.usage || null,
    workingMs: Number(data.workingMs) || 0
  };
}

ipcMain.handle('code:listHistory', (_, workspacePath) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    const indexFile = _historyIndexFile('code', histDir);
    const entries = _getHistoryIndex(histDir, indexFile, _codeHistoryMeta);
    const files = Object.values(entries).filter(Boolean).sort((a, b) => b.ts - a.ts);
    return { ok: true, history: files };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:loadHistory', async (_, workspacePath, id) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    const data = _rehydrateHistoryImages(JSON.parse(fs.readFileSync(path.join(histDir, id + '.json'), 'utf-8')));
    // 运行位置护栏：会话属于另一种模式时，必须先完成一次成功的双向同步，否则拒绝加载（避免工作目录错乱）
    const cur = (settings.runtime && settings.runtime.location) === 'vm' ? 'vm' : 'host';
    const own = data && data.__runtimeLocation;
    if (own && own !== cur) {
      const sync = await vmService.syncWorkspace({ direction: 'both', reason: 'cross-mode-history' }).catch((e) => ({ ok: false, error: e.message }));
      if (!sync || !sync.ok) {
        return { ok: false, locationMismatch: true, ownLocation: own, error: `该会话在「${own === 'vm' ? '虚拟机' : '本机'}」模式下创建，切换前必须完成工作区同步（失败：${(sync && sync.error) || '未知原因'}）；请先在设置 → 运行位置 点「立即同步」后重试` };
      }
      data.__runtimeLocation = cur;
      try { fs.writeFileSync(path.join(histDir, id + '.json'), JSON.stringify(data)); } catch { /* ignore */ }
    }
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:saveHistory', (_, workspacePath, id, data) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    if (data && typeof data === 'object') {
      // 记录创建时的运行位置（主机/虚拟机），供跨模式继续会话时做同步护栏
      data.__runtimeLocation = (settings.runtime && settings.runtime.location) === 'vm' ? 'vm' : 'host';
      _externalizeHistoryImages(data);
    }
    queueHistorySave('code:' + id, path.join(histDir, id + '.json'), data);
    if (data && typeof data === 'object') {
      _putHistoryIndexEntry(_historyIndexFile('code', histDir), id, _codeHistoryMeta(id, data, path.join(histDir, id + '.json')));
    }
    return { ok: true, queued: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:deleteHistory', (_, workspacePath, id) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(histDir, id + '.json'));
    _removeHistoryIndexEntry(_historyIndexFile('code', histDir), id);
    _deleteHistoryImages(id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:getFileTree', (_, dirPath) => {
  try {
    const tree = generateFileTreeStructured(dirPath, 0, 4); // 4 levels for code mode UI
    return { ok: true, tree };
  } catch (e) { return { ok: false, error: e.message }; }
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

// ---- IPC: GeoGebra ----
// GeoGebra now runs in the main window, not a separate window.
// 完整离线：web3d/webSimple/web 编译产物由构建期下载的 Math Apps Bundle 提供，
// 经 ggb:// 协议（src/main/geogebra-protocol.js）从本地文件系统加载，全程不访问 www.geogebra.org。

function callGeogebraInMainWindow(fnName, ...args) {
  const safe = args.map(a => JSON.stringify(a));
  const code = `window.${fnName}(${safe.join(',')})`;
  return mainWindow.webContents.executeJavaScript(code);
}

ipcMain.handle('geogebra:init', async (_, options) => {
  try {
    const opts = options && typeof options === 'object' ? options : {};
    const result = await callGeogebraInMainWindow('initGeoGebra', opts);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:evalCommand', async (_, cmd) => {
  try {
    // 使用 JSON.stringify 安全转义命令字符串（避免注入 / 换行破坏语法）
    const safe = JSON.stringify(String(cmd || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.evalGeoGebraCommand(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getAllObjects', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getAllGeoGebraObjects()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:deleteObject', async (_, name) => {
  try {
    const safe = JSON.stringify(String(name || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.deleteGeoGebraObject(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:exportPNG', async (_, workspacePath) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.exportGeoGebraPNG()');
    if (result.ok && result.data) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      const imgPath = path.join(targetDir, `geogebra_${Date.now()}.png`);
      // GGB getPNGBase64 返回 "data:image/png;base64,...." 完整 data URI；
      // Buffer.from(.., 'base64') 不能解析带前缀的字符串，需要先剥离前缀。
      let b64 = String(result.data);
      const commaIdx = b64.indexOf(',');
      if (commaIdx > 0 && b64.slice(0, commaIdx).includes('base64')) {
        b64 = b64.slice(commaIdx + 1);
      }
      fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
      return { ok: true, path: imgPath, url: `file://${imgPath}` };
    }
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:evalCAS', async (_, cmd) => {
  try {
    const safe = JSON.stringify(String(cmd || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.evalGeoGebraCAS(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getObject', async (_, name) => {
  try {
    const safe = JSON.stringify(String(name || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.getGeoGebraObject(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getXML', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getGeoGebraXML()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:setXML', async (_, xml) => {
  try {
    const safe = JSON.stringify(String(xml || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.setGeoGebraXML(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:setStyle', async (_, name, style) => {
  try {
    const safeName = JSON.stringify(String(name || ''));
    const safeStyle = JSON.stringify(style && typeof style === 'object' ? style : {});
    const result = await mainWindow.webContents.executeJavaScript(`window.setGeoGebraStyle(${safeName}, ${safeStyle})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getError', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getGeoGebraError()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:getPNGBase64', async () => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getGeoGebraPNGBase64()');
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:save', async (_, workspacePath, fileName) => {
  try {
    const result = await mainWindow.webContents.executeJavaScript('window.getGeoGebraBase64()');
    if (!result || !result.ok || !result.base64) return result || { ok: false, error: 'GeoGebra 未返回数据' };
    const dir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    const name = (fileName && String(fileName).trim()) || `geogebra_${Date.now()}.ggb`;
    const target = path.join(dir, name.endsWith('.ggb') ? name : `${name}.ggb`);
    fs.writeFileSync(target, Buffer.from(result.base64, 'base64'));
    return { ok: true, path: target, url: `file://${target}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:load', async (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const b64 = fs.readFileSync(filePath).toString('base64');
    const safe = JSON.stringify(b64);
    const result = await mainWindow.webContents.executeJavaScript(`window.setGeoGebraBase64(${safe})`);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('geogebra:guide', async (_, category) => {
  try {
    const safe = JSON.stringify(String(category || ''));
    const result = await mainWindow.webContents.executeJavaScript(`window.getGeoGebraGuide(${safe})`);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Skills Update ----
ipcMain.handle('skills:update', (_, id, data) => {
  const p = path.join(skillsDir, `${id}.json`);
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
// ---- IPC: Download Manager (aria2) ----
// 替换旧的同步 file:download：现在使用 aria2 异步下载，返回 gid 立即继续工作
// （aria2Manager 已在文件头部 require，供 VM 资源下载复用同一实例）

// 启动 aria2（首次下载时自动触发，也可在打开下载管理器时预热）
// 自动同步 settings.proxy 代理设置
ipcMain.handle('aria2:start', async () => {
  try {
    await aria2Manager.start(settings.proxy);
    return { ok: true, port: aria2Manager.port, proxy: aria2Manager.currentProxy };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 获取 aria2 状态（是否就绪、端口）
ipcMain.handle('aria2:status', async () => {
  return {
    ok: true,
    ready: aria2Manager.ready,
    port: aria2Manager.port,
    binPath: aria2Manager.binPath
  };
});

// 添加下载任务（异步，立即返回 gid）
// dir 可选：未指定时使用 aria2 默认目录（userData/aria2），由上层（Agent）传入工作目录
ipcMain.handle('aria2:add-uri', async (_, url, opts = {}) => {
  try {
    const gid = await aria2Manager.addUri(url, opts);
    return { ok: true, gid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 查询单个下载状态
ipcMain.handle('aria2:tell-status', async (_, gid) => {
  try {
    const status = await aria2Manager.tellStatus(gid);
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 列出所有下载（active + waiting + stopped）
ipcMain.handle('aria2:list-all', async () => {
  try {
    const result = await aria2Manager.listAll();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 暂停下载
ipcMain.handle('aria2:pause', async (_, gid, force = false) => {
  try {
    await aria2Manager.pause(gid, force);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 恢复下载
ipcMain.handle('aria2:unpause', async (_, gid) => {
  try {
    await aria2Manager.unpause(gid);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 取消下载
ipcMain.handle('aria2:cancel', async (_, gid, force = false) => {
  try {
    await aria2Manager.cancel(gid, force);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除下载记录（已停止的任务）
ipcMain.handle('aria2:remove-result', async (_, gid) => {
  try {
    await aria2Manager.removeDownloadResult(gid);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 兼容旧版 downloadFile 调用：用 aria2 异步下载后等待完成再返回
// （仅用于不关心进度的旧调用方；Agent 新工具走 aria2:add-uri 异步路径）
ipcMain.handle('file:download', async (_, url, filename, workspacePath) => {
  try {
    if (!workspacePath) {
      return { ok: false, error: '未设置工作区路径' };
    }
    const { URL } = require('url');
    const parsedUrl = new URL(url);
    let targetFilename = filename;
    if (!targetFilename) {
      targetFilename = path.basename(parsedUrl.pathname) || 'download';
    }
    const gid = await aria2Manager.addUri(url, { dir: workspacePath, out: targetFilename });
    // 轮询等待完成（最长 10 分钟）
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const st = await aria2Manager.tellStatus(gid);
      if (st.status === 'complete') {
        const filePath = st.files?.[0]?.path || path.join(workspacePath, targetFilename);
        return { ok: true, path: filePath, size: parseInt(st.completedLength || '0', 10), gid };
      }
      if (st.status === 'error' || st.status === 'removed') {
        return { ok: false, error: st.errorMessage || `下载${st.status}`, gid };
      }
    }
    return { ok: false, error: '下载超时（10 分钟）', gid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Network Tools ----
ipcMain.handle('net:httpRequest', async (_, opts) => {
  try {
    const { URL } = require('url');
    const url = String(opts.url || '').trim();
    if (!url) return { ok: false, error: '缺少url' };
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    const timeout = Number(opts.timeout) || 30000;
    const followRedirects = opts.followRedirects !== false;
    const encoding = opts.encoding || 'utf8';
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    }
    const fetchOpts = { method, headers, redirect: followRedirects ? 'follow' : 'manual', signal: AbortSignal.timeout(timeout) };
    if (opts.body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = opts.body;
    const resp = await fetch(url, fetchOpts);
    const buf = Buffer.from(await resp.arrayBuffer());
    const bodyStr = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8').substring(0, 500000);
    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { ok: true, status: resp.status, statusText: resp.statusText, headers: respHeaders, body: bodyStr };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:httpFormPost', async (_, opts) => {
  try {
    const url = String(opts.url || '').trim();
    if (!url) return { ok: false, error: '缺少url' };
    const fields = opts.fields || {};
    const files = opts.files || [];
    const extraHeaders = opts.headers || {};
    if (files.length > 0) {
      // multipart/form-data
      const { Readable } = require('stream');
      const boundary = '----CIBYPFormBoundary' + Date.now().toString(36);
      const parts = [];
      for (const [k, v] of Object.entries(fields)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
      }
      for (const f of files) {
        const fname = f.fileName || path.basename(f.filePath);
        const content = fs.readFileSync(f.filePath);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.fieldName}"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        parts.push(content);
      }
      const tail = `\r\n--${boundary}--\r\n`;
      const bodyParts = [];
      for (const p of parts) bodyParts.push(Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'));
      bodyParts.push(Buffer.from(tail, 'utf8'));
      const body = Buffer.concat(bodyParts);
      const resp = await fetch(url, {
        method: 'POST', body,
        headers: { ...extraHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      });
      const text = await resp.text();
      return { ok: true, status: resp.status, body: text.substring(0, 500000) };
    } else {
      const body = new URLSearchParams(fields).toString();
      const resp = await fetch(url, {
        method: 'POST', body,
        headers: { ...extraHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const text = await resp.text();
      return { ok: true, status: resp.status, body: text.substring(0, 500000) };
    }
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:dnsLookup', async (_, hostname, rrtype) => {
  try {
    const dns = require('dns');
    const { promisify } = require('util');
    const rr = (rrtype || 'A').toUpperCase();
    if (rr === 'A' || rr === 'AAAA') {
      const lookup = promisify(dns.resolve4.bind(dns));
      const lookup6 = promisify(dns.resolve6.bind(dns));
      const records = await (rr === 'AAAA' ? lookup6 : lookup)(hostname);
      return { ok: true, hostname, rrtype: rr, records };
    }
    const resolve = promisify(dns.resolve.bind(dns));
    const records = await resolve(hostname, rr);
    return { ok: true, hostname, rrtype: rr, records };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:ping', async (_, host, count) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const n = Math.min(Math.max(Number(count) || 4, 1), 20);
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-n', String(n), host] : ['-c', String(n), host];
    const { stdout, stderr } = await execFileAsync(isWin ? 'ping' : '/bin/ping', args, { timeout: n * 5000 + 5000 });
    return { ok: true, host, output: (stdout || stderr || '').substring(0, 10000) };
  } catch (e) {
    return { ok: true, host, output: (e.stdout || e.stderr || e.message || '').substring(0, 10000), timedOut: e.killed };
  }
});

ipcMain.handle('net:urlShorten', async (_, url) => {
  try {
    const chain = [url];
    let current = url;
    for (let i = 0; i < 10; i++) {
      const resp = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      const loc = resp.headers.get('location');
      if (!loc || (resp.status !== 301 && resp.status !== 302 && resp.status !== 303 && resp.status !== 307 && resp.status !== 308)) break;
      const next = new URL(loc, current).href;
      chain.push(next);
      current = next;
    }
    return { ok: true, originalUrl: url, finalUrl: current, redirectChain: chain };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:urlEncodeDecode', async (_, input, operation) => {
  try {
    let result;
    switch (operation) {
      case 'urlEncode': result = encodeURIComponent(input); break;
      case 'urlDecode': result = decodeURIComponent(input); break;
      case 'base64Encode': result = Buffer.from(input, 'utf8').toString('base64'); break;
      case 'base64Decode': result = Buffer.from(input, 'base64').toString('utf8'); break;
      default: return { ok: false, error: `未知操作: ${operation}` };
    }
    return { ok: true, operation, input, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:checkSSLCert', async (_, hostname, port) => {
  try {
    const tls = require('tls');
    const p = Number(port) || 443;
    return new Promise((resolve) => {
      const sock = tls.connect({ host: hostname, port: p, servername: hostname, rejectUnauthorized: false, timeout: 10000 }, () => {
        const cert = sock.getPeerCertificate(true);
        sock.destroy();
        if (!cert || !cert.subject) return resolve({ ok: false, error: '无法获取证书' });
        resolve({
          ok: true, hostname, port: p,
          subject: cert.subject, issuer: cert.issuer,
          validFrom: cert.valid_from, validTo: cert.valid_to,
          serialNumber: cert.serialNumber,
          fingerprint: cert.fingerprint,
          fingerprint256: cert.fingerprint256,
          subjectAltName: cert.subjectaltname,
          bits: cert.bits,
          protocol: sock.getProtocol && sock.getProtocol()
        });
      });
      sock.on('error', (err) => { sock.destroy(); resolve({ ok: false, error: err.message }); });
      sock.setTimeout(10000, () => { sock.destroy(); resolve({ ok: false, error: '连接超时' }); });
    });
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('net:traceroute', async (_, host) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tracert' : 'traceroute';
    const args = isWin ? ['-d', '-w', '2000', host] : ['-n', '-w', '2', host];
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 60000 });
    return { ok: true, host, output: (stdout || stderr || '').substring(0, 30000) };
  } catch (e) {
    return { ok: true, host, output: (e.stdout || e.stderr || e.message || '').substring(0, 30000), timedOut: e.killed };
  }
});

ipcMain.handle('net:portScan', async (_, host, portsStr, timeout) => {
  try {
    const net = require('net');
    const perTimeout = Math.min(Math.max(Number(timeout) || 2000, 200), 10000);
    // 解析端口: 80,443,8000-8100
    const ports = [];
    for (const part of String(portsStr).split(',')) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [a, b] = trimmed.split('-').map(Number);
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), Math.min(a, b) + 1000); i++) ports.push(i);
        }
      } else {
        const p = Number(trimmed);
        if (!isNaN(p) && p > 0 && p <= 65535) ports.push(p);
      }
    }
    if (ports.length === 0) return { ok: false, error: '无效端口范围' };
    if (ports.length > 1024) return { ok: false, error: '端口范围过大(最大1024个)' };
    const scanPort = (p) => new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(perTimeout);
      sock.once('connect', () => { sock.destroy(); resolve({ port: p, open: true }); });
      sock.once('timeout', () => { sock.destroy(); resolve({ port: p, open: false }); });
      sock.once('error', () => { sock.destroy(); resolve({ port: p, open: false }); });
      sock.connect(p, host);
    });
    // 并发扫描，每批 50
    const openPorts = [];
    for (let i = 0; i < ports.length; i += 50) {
      const batch = ports.slice(i, i + 50);
      const results = await Promise.all(batch.map(scanPort));
      for (const r of results) if (r.open) openPorts.push(r.port);
    }
    return { ok: true, host, scannedCount: ports.length, openPorts };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Sanguosha Game Window ----
let sanguoshaWindow = null;
let sanguoshaConfig = { aiCount: 3 };

ipcMain.handle('sanguosha:open', async (_, aiCount) => {
  try {
    sanguoshaConfig.aiCount = aiCount || 3;
    if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) {
      sanguoshaWindow.focus();
      return { ok: true };
    }
    sanguoshaWindow = new BrowserWindow({
      width: 1100, height: 750, minWidth: 900, minHeight: 650,
      title: '三国杀',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/sanguosha-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    sanguoshaWindow.loadFile(path.join(__dirname, '../renderer/pages/sanguosha.html'));
    sanguoshaWindow.on('closed', () => { sanguoshaWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sanguosha:getConfig', () => sanguoshaConfig);
ipcMain.handle('sanguosha:close', () => {
  if (sanguoshaWindow && !sanguoshaWindow.isDestroyed()) sanguoshaWindow.close();
});

ipcMain.handle('sanguosha:aiDecision', async (_, gameState, playerInfo) => {
  // Use LLM for AI decision making — reuses fetchLLMWithRetry for reliability.
  try {
    const llm = settings.llm;
    if (llm.provider === 'opencode-zen' || llm.provider === 'opencode-go') {
      if (!llm.zenApiKey || !llm.model) return { ok: true, action: 'auto' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: true, action: 'auto' };
    }

    const req = LLMProviders.buildLLMRequest(llm, {
      messages: [
        { role: 'system', content: gameState.systemPrompt || '你是三国杀AI玩家' },
        { role: 'user', content: gameState.userPrompt || JSON.stringify(playerInfo) }
      ],
      temperature: 0.7,
      max_tokens: 300,
      stream: false
    });
    const result = await fetchLLMWithRetry({
      label: 'LLM:sanguosha',
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body,
      options: {
        maxRetries: llm.maxRetries ?? undefined,
        timeoutMs: Math.min(llm.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60000),

      }
    });
    if (!result.ok) return { ok: true, action: 'auto' };
    const rawData = await result.response.json();
    if (rawData.error) return { ok: true, action: 'auto' };
    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: true, action: 'auto' };
    console.log(`[LLM:sanguosha ${logTs()}] ✓ ${llm.model} → "${String(content).replace(/\s+/g, ' ').slice(0, 120)}"`);

    const usage = data.usage || {};
    const usageTokens = usage.total_tokens || estimateTokens(JSON.stringify(req.body)) + estimateTokens(content);
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llm.model);
    persistSettings();
    broadcastUsageChanged();

    return { ok: true, action: 'llm', content };
  } catch (e) {
    return { ok: true, action: 'auto' };
  }
});

// ---- Flying Flower Game Window ----
let flyingflowerWindow = null;
let flyingflowerConfig = { aiCount: 3 };

ipcMain.handle('flyingflower:open', async (_, aiCount) => {
  try {
    flyingflowerConfig.aiCount = aiCount || 3;
    if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) {
      flyingflowerWindow.focus();
      return { ok: true };
    }
    flyingflowerWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '飞花令',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/flyingflower-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    flyingflowerWindow.loadFile(path.join(__dirname, '../renderer/pages/flyingflower.html'));
    flyingflowerWindow.on('closed', () => { flyingflowerWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('flyingflower:getConfig', () => flyingflowerConfig);
ipcMain.handle('flyingflower:close', () => {
  if (flyingflowerWindow && !flyingflowerWindow.isDestroyed()) flyingflowerWindow.close();
});

// ---- Undercover Game Window ----
let undercoverWindow = null;
let undercoverConfig = { aiCount: 4 };

ipcMain.handle('undercover:open', async (_, aiCount) => {
  try {
    undercoverConfig.aiCount = aiCount || 4;
    if (undercoverWindow && !undercoverWindow.isDestroyed()) {
      undercoverWindow.focus();
      return { ok: true };
    }
    undercoverWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '谁是卧底',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/undercover-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    undercoverWindow.loadFile(path.join(__dirname, '../renderer/pages/undercover.html'));
    undercoverWindow.on('closed', () => { undercoverWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('undercover:getConfig', () => undercoverConfig);
ipcMain.handle('undercover:close', () => {
  if (undercoverWindow && !undercoverWindow.isDestroyed()) undercoverWindow.close();
});

// ---- Idiom Chain Game Window ----
let idiomWindow = null;
let idiomConfig = { aiCount: 3 };

ipcMain.handle('idiom:open', async (_, aiCount) => {
  try {
    idiomConfig.aiCount = aiCount || 3;
    if (idiomWindow && !idiomWindow.isDestroyed()) {
      idiomWindow.focus();
      return { ok: true };
    }
    idiomWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '成语接龙',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/idiom-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    idiomWindow.loadFile(path.join(__dirname, '../renderer/pages/idiom.html'));
    idiomWindow.on('closed', () => { idiomWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('idiom:getConfig', () => idiomConfig);
ipcMain.handle('idiom:close', () => {
  if (idiomWindow && !idiomWindow.isDestroyed()) idiomWindow.close();
});

// ---- Guess Character Game Window ----
let guessCharacterWindow = null;
let guessCharacterConfig = { aiCount: 1, category: 'mixed' };

ipcMain.handle('guesscharacter:open', async (_, aiCount, category) => {
  try {
    guessCharacterConfig.aiCount = aiCount || 1;
    guessCharacterConfig.category = category || 'mixed';
    if (guessCharacterWindow && !guessCharacterWindow.isDestroyed()) {
      guessCharacterWindow.focus();
      return { ok: true };
    }
    guessCharacterWindow = new BrowserWindow({
      width: 900, height: 700, minWidth: 700, minHeight: 550,
      title: '是否猜人物',
      frame: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/guesscharacter-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    guessCharacterWindow.loadFile(path.join(__dirname, '../renderer/pages/guesscharacter.html'));
    guessCharacterWindow.on('closed', () => { guessCharacterWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('guesscharacter:getConfig', () => guessCharacterConfig);
ipcMain.handle('guesscharacter:close', () => {
  if (guessCharacterWindow && !guessCharacterWindow.isDestroyed()) guessCharacterWindow.close();
});

// ===========================================================================
// CIPYP-CAD - 2D Drafting CAD sub-application
// ===========================================================================
let cipypCadWindow = null;

ipcMain.handle('cipypcad:open', async () => {
  try {
    if (cipypCadWindow && !cipypCadWindow.isDestroyed()) {
      cipypCadWindow.focus();
      return { ok: true };
    }
    cipypCadWindow = new BrowserWindow({
      width: 1280, height: 800, minWidth: 900, minHeight: 600,
      title: 'CIPYP-CAD',
      frame: false,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/cipypcad-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    cipypCadWindow.loadFile(path.join(__dirname, '../renderer/pages/cipypcad.html'));
    // 关闭拦截：若工程有未保存改动，由渲染进程通过 cipypcad:requestClose 询问用户
    cipypCadWindow.on('close', (event) => {
      if (cipypCadWindow && !cipypCadWindow.isDestroyed()) {
        event.preventDefault();
        cipypCadWindow.webContents.send('cipypcad:close-requested');
      }
    });
    // 最大化状态变化时通知渲染进程（更新标题栏按钮图标）
    cipypCadWindow.on('maximize', () => {
      try { cipypCadWindow.webContents.send('cipypcad:maximizeChanged'); } catch {}
    });
    cipypCadWindow.on('unmaximize', () => {
      try { cipypCadWindow.webContents.send('cipypcad:maximizeChanged'); } catch {}
    });
    cipypCadWindow.on('closed', () => { cipypCadWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 渲染进程在用户确认后（保存/不保存/取消）调用此 handler 真正关闭窗口
ipcMain.handle('cipypcad:confirmClose', (_, action) => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false };
  if (action === 'close') {
    // 解除 close 拦截：先移除 listener，再 destroy
    cipypCadWindow.removeAllListeners('close');
    cipypCadWindow.destroy();
    cipypCadWindow = null;
  }
  return { ok: true };
});

// 窗口控制器：最小化/最大化/关闭（自实现标题栏按钮调用）
ipcMain.handle('cipypcad:minimize', () => {
  if (cipypCadWindow && !cipypCadWindow.isDestroyed()) cipypCadWindow.minimize();
  return { ok: true };
});
ipcMain.handle('cipypcad:maximizeToggle', () => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false };
  if (cipypCadWindow.isMaximized()) cipypCadWindow.unmaximize();
  else cipypCadWindow.maximize();
  return { ok: true, maximized: cipypCadWindow.isMaximized() };
});
ipcMain.handle('cipypcad:isMaximized', () => {
  return { ok: true, maximized: !!(cipypCadWindow && !cipypCadWindow.isDestroyed() && cipypCadWindow.isMaximized()) };
});

ipcMain.handle('cipypcad:close', () => {
  if (cipypCadWindow && !cipypCadWindow.isDestroyed()) cipypCadWindow.close();
  return { ok: true };
});

// Agent 触发的关闭：默认自动保存后直接销毁，不弹询问框（Agent 无法回答）
let _cadLastPath = null;
ipcMain.handle('cipypcad:agentClose', async () => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: true };
  try {
    const st = await _cadExec('window.cadGetState()');
    if (st && st.ok && st.state && st.state.modified) {
      const res = await _cadExec('window.cadGetProjectJSON()');
      if (res && res.ok) {
        // 优先级：state.filePath（渲染进程最新保存路径）→ _cadLastPath（IPC 缓存）→ recovery/ 兜底
        let target = (st.state.filePath) || _cadLastPath;
        if (!target) {
          const dir = path.join(app.getPath('userData'), 'recovery');
          fs.mkdirSync(dir, { recursive: true });
          target = path.join(dir, 'cipypcad-' + Date.now() + '.cipyproj');
        }
        fs.writeFileSync(target, JSON.stringify(res.data, null, 2), 'utf-8');
      }
    }
  } catch (e) { /* best-effort save */ }
  cipypCadWindow.removeAllListeners('close');
  cipypCadWindow.destroy();
  cipypCadWindow = null;
  _cadLastPath = null;
  return { ok: true };
});

// Helper: safely execute JS in CAD window and return result
async function _cadExec(script) {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) {
    return { ok: false, error: 'CIPYP-CAD 窗口未打开，请先调用 initCipypCad' };
  }
  try {
    // Wait for the CAD engine to be ready (window.cadExecuteCommand defined)
    // Try up to 5 seconds
    for (let i = 0; i < 50; i++) {
      const ready = await cipypCadWindow.webContents.executeJavaScript('typeof window.cadExecuteCommand === "function"');
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const result = await cipypCadWindow.webContents.executeJavaScript(script);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('cipypcad:runCommand', async (_, cmd) => {
  const safe = JSON.stringify(String(cmd || ''));
  return await _cadExec(`window.cadExecuteCommand(${safe})`);
});

ipcMain.handle('cipypcad:runCommands', async (_, cmds) => {
  if (!Array.isArray(cmds)) return { ok: false, error: 'commands must be array' };
  const safe = JSON.stringify(cmds.map(c => String(c || '')));
  return await _cadExec(`window.cadExecuteCommands(${safe})`);
});

ipcMain.handle('cipypcad:getState', async () => {
  return await _cadExec(`window.cadGetState()`);
});

ipcMain.handle('cipypcad:getObjectList', async () => {
  return await _cadExec(`window.cadGetObjectList()`);
});

ipcMain.handle('cipypcad:saveProjectDialog', async () => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false, error: 'CAD 窗口未打开' };
  const result = await dialog.showSaveDialog(cipypCadWindow, {
    title: '保存 CIPYP-CAD 工程',
    defaultPath: 'project.cipyproj',
    filters: [
      { name: 'CIPYP-CAD Project', extensions: ['cipyproj'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return { ok: true, path: result.filePath };
});

ipcMain.handle('cipypcad:loadProjectDialog', async () => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false, error: 'CAD 窗口未打开' };
  const result = await dialog.showOpenDialog(cipypCadWindow, {
    title: '加载 CIPYP-CAD 工程',
    properties: ['openFile'],
    filters: [
      { name: 'CIPYP-CAD Project', extensions: ['cipyproj'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('cipypcad:saveImageDialog', async (_, defaultName, filter) => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false, error: 'CAD 窗口未打开' };
  let filters;
  if (filter === 'DXF') {
    filters = [{ name: 'AutoCAD DXF', extensions: ['dxf'] }, { name: 'All Files', extensions: ['*'] }];
  } else if (filter === 'SVG') {
    filters = [{ name: 'SVG Image', extensions: ['svg'] }, { name: 'All Files', extensions: ['*'] }];
  } else {
    filters = [{ name: 'PNG Image', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }];
  }
  const result = await dialog.showSaveDialog(cipypCadWindow, {
    title: '导出',
    defaultPath: defaultName || 'export.png',
    filters
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return { ok: true, path: result.filePath };
});

ipcMain.handle('cipypcad:saveProject', async (_, filePath) => {
  try {
    const res = await _cadExec(`window.cadGetProjectJSON()`);
    if (!res.ok) return res;
    const json = JSON.stringify(res.data, null, 2);
    fs.writeFileSync(filePath, json, 'utf-8');
    _cadLastPath = filePath;  // 缓存最近保存路径，供 agentClose 兜底使用
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:loadProject', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    const safe = JSON.stringify(data);
    const safePath = JSON.stringify(filePath);
    const r = await _cadExec(`window.cadLoadProjectJSON(${safe}, ${safePath})`);
    if (r && r.ok) _cadLastPath = filePath;  // 缓存最近加载路径
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:exportDxf', async (_, filePath) => {
  try {
    const res = await _cadExec(`window.cadGetDxfString()`);
    if (!res.ok) return res;
    fs.writeFileSync(filePath, res.dxf, 'utf-8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:importDxfDialog', async () => {
  if (!cipypCadWindow || cipypCadWindow.isDestroyed()) return { ok: false, error: 'CAD 窗口未打开' };
  const result = await dialog.showOpenDialog(cipypCadWindow, {
    title: '导入 DXF 文件',
    properties: ['openFile'],
    filters: [
      { name: 'AutoCAD DXF', extensions: ['dxf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const safeContent = JSON.stringify(content);
    const safePath = JSON.stringify(filePath);
    const r = await _cadExec(`window.cadImportDxfString(${safeContent}, ${safePath})`);
    if (r && r.ok) _cadLastPath = filePath;
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:getHatchPatterns', async () => {
  try {
    return await _cadExec(`window.cadGetHatchPatterns()`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:exportImage', async (_, filePath, format) => {
  try {
    const fmt = (format || 'png').toLowerCase();
    if (fmt === 'png') {
      const res = await _cadExec(`window.cadGetPNGDataUrl(1920, 1080)`);
      if (!res.ok) return res;
      // Strip "data:image/png;base64," prefix
      const b64 = res.dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(filePath, buf);
    } else if (fmt === 'svg') {
      const res = await _cadExec(`window.cadGetSVGString()`);
      if (!res.ok) return res;
      fs.writeFileSync(filePath, res.svg, 'utf-8');
    } else {
      return { ok: false, error: 'unsupported format: ' + fmt };
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cipypcad:writeFile', async (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===========================================================================
// CIBYP-PCB-EDA - PCB design sub-application (schematic + layout + Gerber)
// ===========================================================================
let pcbEdaWindow = null;

ipcMain.handle('pcbeda:open', async () => {
  try {
    if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
      pcbEdaWindow.focus();
      return { ok: true };
    }
    pcbEdaWindow = new BrowserWindow({
      width: 1380, height: 860, minWidth: 1000, minHeight: 640,
      title: 'CIBYP-PCB-EDA',
      frame: false,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/pcbeda-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    pcbEdaWindow.loadFile(path.join(__dirname, '../renderer/pages/pcbeda.html'));
    // 关闭拦截：由渲染进程检查未保存改动并决定
    pcbEdaWindow.on('close', (event) => {
      if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
        event.preventDefault();
        pcbEdaWindow.webContents.send('pcbeda:close-requested');
      }
    });
    pcbEdaWindow.on('maximize', () => {
      try { pcbEdaWindow.webContents.send('pcbeda:maximizeChanged'); } catch {}
    });
    pcbEdaWindow.on('unmaximize', () => {
      try { pcbEdaWindow.webContents.send('pcbeda:maximizeChanged'); } catch {}
    });
    pcbEdaWindow.on('closed', () => { pcbEdaWindow = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pcbeda:confirmClose', (_, action) => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false };
  if (action === 'close') {
    pcbEdaWindow.removeAllListeners('close');
    pcbEdaWindow.destroy();
    pcbEdaWindow = null;
  }
  return { ok: true };
});

ipcMain.handle('pcbeda:minimize', () => {
  if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) pcbEdaWindow.minimize();
  return { ok: true };
});
ipcMain.handle('pcbeda:maximizeToggle', () => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false };
  if (pcbEdaWindow.isMaximized()) pcbEdaWindow.unmaximize();
  else pcbEdaWindow.maximize();
  return { ok: true, maximized: pcbEdaWindow.isMaximized() };
});
ipcMain.handle('pcbeda:isMaximized', () => {
  return { ok: true, maximized: !!(pcbEdaWindow && !pcbEdaWindow.isDestroyed() && pcbEdaWindow.isMaximized()) };
});
ipcMain.handle('pcbeda:close', () => {
  if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) pcbEdaWindow.close();
  return { ok: true };
});

// Agent 触发的关闭：默认自动保存后直接销毁，不弹询问框（Agent 无法回答）
let _pcbLastPath = null;
ipcMain.handle('pcbeda:agentClose', async () => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: true };
  try {
    const st = await _pcbExec(`window.pcbGetState()`);
    if (st && st.ok && st.state && st.state.modified) {
      // 优先级：state.filePath（渲染进程最新保存路径）→ _pcbLastPath（IPC 缓存）→ recovery/ 兜底
      let target = (st.state.filePath) || _pcbLastPath;
      let isMulti = false;
      if (!target) {
        const dir = path.join(app.getPath('userData'), 'recovery');
        fs.mkdirSync(dir, { recursive: true });
        target = path.join(dir, 'pcbeda-' + Date.now() + '.cipypcb');
      } else {
        isMulti = String(target).toLowerCase().endsWith('.cibypcbproj');
      }
      if (isMulti) {
        const base = path.basename(target).replace(/\.cibypcbproj$/i, '');
        const res = await _pcbExec(`window.pcbGetMultiFiles(${JSON.stringify(base)})`);
        if (res && res.ok) {
          const dir = path.dirname(target);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, JSON.stringify(res.data.manifest, null, 2), 'utf-8');
          for (const f of res.data.files) {
            fs.writeFileSync(path.join(dir, path.basename(f.name)), JSON.stringify(f.data, null, 2), 'utf-8');
          }
        }
      } else {
        const res = await _pcbExec(`window.pcbGetProjectJSON()`);
        if (res && res.ok) {
          fs.writeFileSync(target, JSON.stringify(res.data, null, 2), 'utf-8');
        }
      }
    }
  } catch (e) { /* best-effort save */ }
  if (pcbEdaWindow && !pcbEdaWindow.isDestroyed()) {
    pcbEdaWindow.removeAllListeners('close');
    pcbEdaWindow.destroy();
  }
  pcbEdaWindow = null;
  _pcbLastPath = null;
  return { ok: true };
});

// Helper: safely execute JS in PCB-EDA window (waits for engine bridge)
async function _pcbExec(script) {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) {
    return { ok: false, error: 'CIBYP-PCB-EDA 窗口未打开，请先调用 initPcbEda' };
  }
  try {
    for (let i = 0; i < 50; i++) {
      const ready = await pcbEdaWindow.webContents.executeJavaScript('typeof window.pcbExecuteCommand === "function"');
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return await pcbEdaWindow.webContents.executeJavaScript(script);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('pcbeda:runCommand', async (_, cmd) => {
  const safe = JSON.stringify(String(cmd || ''));
  return await _pcbExec(`window.pcbExecuteCommand(${safe})`);
});
ipcMain.handle('pcbeda:runCommands', async (_, cmds) => {
  if (!Array.isArray(cmds)) return { ok: false, error: 'commands must be array' };
  const safe = JSON.stringify(cmds.map(c => String(c || '')));
  return await _pcbExec(`window.pcbExecuteCommands(${safe})`);
});
ipcMain.handle('pcbeda:getState', async () => {
  return await _pcbExec(`window.pcbGetState()`);
});

// ---- dialogs ----
ipcMain.handle('pcbeda:saveProjectDialog', async () => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false, error: 'PCB-EDA 窗口未打开' };
  const result = await dialog.showSaveDialog(pcbEdaWindow, {
    title: '保存 PCB 工程',
    defaultPath: 'project.cipypcb',
    filters: [
      { name: 'CIBYP PCB 工程 (单文件)', extensions: ['cipypcb'] },
      { name: 'CIBYP PCB 多文件工程 (清单)', extensions: ['cibypcbproj'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return { ok: true, path: result.filePath };
});

ipcMain.handle('pcbeda:loadProjectDialog', async () => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false, error: 'PCB-EDA 窗口未打开' };
  const result = await dialog.showOpenDialog(pcbEdaWindow, {
    title: '打开 PCB 工程 / 导入 EDA 文件',
    properties: ['openFile'],
    filters: [
      { name: '所有支持的格式', extensions: ['cipypcb', 'cibypcbproj', 'json', 'kicad_pcb', 'net', 'kicad_net', 'csv', 'txt'] },
      { name: 'CIBYP PCB 工程', extensions: ['cipypcb', 'cibypcbproj', 'json'] },
      { name: 'KiCad 工程/网表', extensions: ['kicad_pcb', 'net', 'kicad_net'] },
      { name: 'CSV 网表', extensions: ['csv', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('pcbeda:exportDirDialog', async (_, defaultName) => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false, error: 'PCB-EDA 窗口未打开' };
  const result = await dialog.showOpenDialog(pcbEdaWindow, {
    title: '选择导出目录',
    defaultPath: defaultName || 'gerber',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('pcbeda:saveFileDialog', async (_, defaultName, filterName) => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false, error: 'PCB-EDA 窗口未打开' };
  const ext = (defaultName || 'export').split('.').pop();
  const result = await dialog.showSaveDialog(pcbEdaWindow, {
    title: '导出文件',
    defaultPath: defaultName || 'export',
    filters: [
      { name: filterName || 'File', extensions: [ext || '*'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return { ok: true, path: result.filePath };
});

ipcMain.handle('pcbeda:importFileDialog', async () => {
  if (!pcbEdaWindow || pcbEdaWindow.isDestroyed()) return { ok: false, error: 'PCB-EDA 窗口未打开' };
  const result = await dialog.showOpenDialog(pcbEdaWindow, {
    title: '导入网表 / 其他 EDA 文件',
    properties: ['openFile'],
    filters: [
      { name: '所有支持的格式', extensions: ['kicad_pcb', 'net', 'kicad_net', 'csv', 'txt', 'cipypcb', 'json'] },
      { name: 'KiCad 工程/网表', extensions: ['kicad_pcb', 'net', 'kicad_net'] },
      { name: 'CSV 网表', extensions: ['csv', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  const p = result.filePaths[0];
  try {
    const content = fs.readFileSync(p, 'utf-8');
    return { ok: true, path: p, name: path.basename(p), content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- file save/load ----
ipcMain.handle('pcbeda:saveProject', async (_, filePath, multi) => {
  try {
    if (multi) {
      const base = path.basename(filePath).replace(/\.cibypcbproj$/i, '');
      const res = await _pcbExec(`window.pcbGetMultiFiles(${JSON.stringify(base)})`);
      if (!res.ok) return res;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(res.data.manifest, null, 2), 'utf-8');
      for (const f of res.data.files) {
        fs.writeFileSync(path.join(dir, path.basename(f.name)), JSON.stringify(f.data, null, 2), 'utf-8');
      }
      _pcbLastPath = filePath;  // 缓存最近保存路径，供 agentClose 兜底使用
      return { ok: true, path: filePath, files: res.data.files.length + 1 };
    }
    const res = await _pcbExec(`window.pcbGetProjectJSON()`);
    if (!res.ok) return res;
    fs.writeFileSync(filePath, JSON.stringify(res.data, null, 2), 'utf-8');
    _pcbLastPath = filePath;  // 缓存最近保存路径，供 agentClose 兜底使用
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pcbeda:loadProject', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    const lower = filePath.toLowerCase();
    let r;
    if (lower.endsWith('.cibypcbproj')) {
      const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const dir = path.dirname(filePath);
      const contents = {};
      for (const ent of (manifest.files || [])) {
        const fp = path.join(dir, ent.file);
        if (fs.existsSync(fp)) contents[ent.file] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      }
      r = await _pcbExec(`window.pcbLoadMultiFiles(${JSON.stringify(manifest)}, ${JSON.stringify(contents)})`);
    } else if (lower.endsWith('.kicad_pcb') || lower.endsWith('.net') || lower.endsWith('.kicad_net') ||
        lower.endsWith('.csv') || lower.endsWith('.txt')) {
      const content = fs.readFileSync(filePath, 'utf-8');
      r = await _pcbExec(`window.pcbImportData(${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(content)})`);
    } else {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      r = await _pcbExec(`window.pcbLoadProjectJSON(${JSON.stringify(data)})`);
    }
    if (r && r.ok) _pcbLastPath = filePath;  // 缓存最近加载路径
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 批量导出文件（Gerber 套装等），可选打 zip 包
ipcMain.handle('pcbeda:exportFiles', async (_, dirPath, files, zipName) => {
  try {
    if (!dirPath) return { ok: false, error: '未指定导出目录' };
    if (!Array.isArray(files)) return { ok: false, error: 'files must be array' };
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const written = [];
    for (const f of files) {
      const p = path.join(dirPath, path.basename(f.name || 'unnamed'));
      if (f.base64) fs.writeFileSync(p, Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'));
      else fs.writeFileSync(p, f.content == null ? '' : String(f.content), 'utf-8');
      written.push(p);
    }
    let zipPath = null;
    if (zipName) {
      const AdmZip = requireAdmZip();
      if (!AdmZip) return { ok: false, error: 'adm-zip 不可用，无法打包' };
      const zip = new AdmZip();
      for (const f of files) {
        const name = path.basename(f.name || 'unnamed');
        if (f.base64) zip.addFile(name, Buffer.from(String(f.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'));
        else zip.addFile(name, Buffer.from(f.content == null ? '' : String(f.content), 'utf-8'));
      }
      zipPath = path.join(dirPath, path.basename(zipName));
      zip.writeZip(zipPath);
    }
    return { ok: true, paths: written, zipPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pcbeda:writeFile', async (_, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content == null ? '' : String(content), 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pcbeda:writeFileBase64', async (_, filePath, b64) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(String(b64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Agent 驱动的一站式导出：Gerber 套装（可选 zip）
ipcMain.handle('pcbeda:exportGerber', async (_, dirPath, baseName, options, zipName) => {
  try {
    if (!dirPath) return { ok: false, error: '未指定导出目录' };
    const res = await _pcbExec(`window.pcbGetGerberFiles(${JSON.stringify(baseName || 'pcb')}, ${JSON.stringify(options || {})})`);
    if (!res || !res.ok) return res || { ok: false, error: 'Gerber 生成失败' };
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const written = [];
    for (const f of res.files) {
      const p = path.join(dirPath, path.basename(f.name));
      fs.writeFileSync(p, f.content == null ? '' : String(f.content), 'utf-8');
      written.push(p);
    }
    let zipPath = null;
    if (zipName) {
      const AdmZip = requireAdmZip();
      if (!AdmZip) return { ok: false, error: 'adm-zip 不可用，无法打包' };
      const zip = new AdmZip();
      for (const f of res.files) {
        zip.addFile(path.basename(f.name), Buffer.from(f.content == null ? '' : String(f.content), 'utf-8'));
      }
      zipPath = path.join(dirPath, path.basename(zipName));
      zip.writeZip(zipPath);
    }
    return { ok: true, count: res.files.length, paths: written, zipPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Agent 驱动的单文件导出（kicad/netlist/svg/png/obj/pnp/bom）
ipcMain.handle('pcbeda:exportTextFile', async (_, kind, filePath, baseName) => {
  try {
    let script = null, isBase64 = false, extra = null;
    switch (kind) {
      case 'kicad': script = 'window.pcbGetKicadPcb()'; break;
      case 'netlist-kicad': script = 'window.pcbGetNetlist("kicad")'; break;
      case 'netlist-csv': script = 'window.pcbGetNetlist("csv")'; break;
      case 'svg-pcb': script = 'window.pcbGetSVGString("pcb")'; break;
      case 'svg-sch': script = 'window.pcbGetSVGString("sch")'; break;
      case 'png-pcb': script = 'window.pcbGetPNGDataUrl("pcb", 1920)'; isBase64 = true; break;
      case 'png-3d': script = 'window.pcbGetPNGDataUrl("3d", 1920)'; isBase64 = true; break;
      case 'pnp': script = 'window.pcbGetAuxExport("pnp")'; break;
      case 'bom': script = 'window.pcbGetAuxExport("bom")'; break;
      case 'obj': script = `window.pcbGet3DOBJ(${JSON.stringify((baseName || 'pcb').replace(/\.obj$/i, ''))})`; extra = 'obj'; break;
      default: return { ok: false, error: '未知导出类型: ' + kind };
    }
    const res = await _pcbExec(script);
    if (!res || !res.ok) return res || { ok: false, error: '导出失败' };
    if (extra === 'obj') {
      fs.writeFileSync(filePath, res.data.obj, 'utf-8');
      const mtlPath = filePath.replace(/\.obj$/i, '.mtl');
      fs.writeFileSync(mtlPath, res.data.mtl, 'utf-8');
      return { ok: true, path: filePath, extra: mtlPath };
    }
    if (isBase64) {
      const b64 = String(res.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
    } else {
      fs.writeFileSync(filePath, res.content != null ? res.content : (res.svg || ''), 'utf-8');
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Agent 驱动的外部 EDA 文件导入
ipcMain.handle('pcbeda:importFile', async (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    const content = fs.readFileSync(filePath, 'utf-8');
    return await _pcbExec(`window.pcbImportData(${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(content)})`);
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  getSettings: () => settings,
  persist: () => persistSettings(),
  appVersion: APP_VERSION,
  // MCP 状态/工具变化 → 广播给渲染器刷新动态工具注册
  notifyRenderer: (payload) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:servers-changed', payload || {});
      }
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

  // ---- Serial Port Agent Tools ----
  const agentSerialPorts = new Map(); // path → { port, buffer }

  ipcMain.handle('serial:listPorts', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return { ok: true, ports };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:openPort', async (_, portPath, options) => {
    try {
      if (agentSerialPorts.has(portPath)) {
        return { ok: false, error: `串口 ${portPath} 已打开` };
      }
      const { SerialPort } = require('serialport');
      const opts = {
        path: portPath,
        baudRate: options?.baudRate || 9600,
        dataBits: options?.dataBits || 8,
        stopBits: options?.stopBits || 1,
        parity: options?.parity || 'none',
      };
      const port = new SerialPort(opts);
      const entry = { port, buffer: '' };
      port.on('data', (chunk) => { entry.buffer += chunk.toString('utf8'); });
      port.on('error', (e) => { console.error(`[Serial ${portPath}] error:`, e.message); });
      agentSerialPorts.set(portPath, entry);
      return new Promise((resolve) => {
        port.once('open', () => resolve({ ok: true, message: `串口 ${portPath} 已打开 (${opts.baudRate}bps)` }));
        port.once('error', (e) => { agentSerialPorts.delete(portPath); resolve({ ok: false, error: e.message }); });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:writePort', async (_, portPath, data, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const enc = encoding || 'utf8';
      const buf = Buffer.from(data, enc);
      return new Promise((resolve) => {
        entry.port.write(buf, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          entry.port.drain((e2) => {
            if (e2) return resolve({ ok: false, error: e2.message });
            resolve({ ok: true, bytesWritten: buf.length });
          });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:readPort', async (_, portPath, timeout, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const ms = timeout || 1000;
      // Wait for data up to timeout
      if (!entry.buffer) {
        await new Promise((r) => setTimeout(r, ms));
      }
      const data = entry.buffer;
      entry.buffer = '';
      if (encoding === 'hex') {
        return { ok: true, data: Buffer.from(data, 'utf8').toString('hex'), length: data.length };
      }
      if (encoding === 'base64') {
        return { ok: true, data: Buffer.from(data, 'utf8').toString('base64'), length: data.length };
      }
      return { ok: true, data, length: data.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:closePort', async (_, portPath) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.close((err) => {
          agentSerialPorts.delete(portPath);
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, message: `串口 ${portPath} 已关闭` });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:setSignals', async (_, portPath, signals) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.set(signals, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, signals });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  function resolveWordDocTarget(pathOrDir) {
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const AdmZip = require('adm-zip');
    const input = String(pathOrDir || '').trim();
    if (!input) throw new Error('缺少pathOrDir参数');
    if (!fsLocal.existsSync(input)) throw new Error('路径不存在: ' + input);

    const stat = fsLocal.statSync(input);
    let dir = input;
    let type = '';
    let sourcePath = input;

    if (stat.isFile()) {
      const ext = pathLocal.extname(input).toLowerCase();
      if (!['.docx', '.odt'].includes(ext)) throw new Error('仅支持 .docx/.odt');
      const parsed = pathLocal.parse(input);
      dir = pathLocal.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(input);
      zip.extractAllTo(dir, true);
      fsLocal.writeFileSync(pathLocal.join(dir, '.__office_ext__'), ext);
      sourcePath = input;
    } else {
      sourcePath = dir;
    }

    if (fsLocal.existsSync(pathLocal.join(dir, 'word', 'document.xml'))) type = 'docx';
    else if (fsLocal.existsSync(pathLocal.join(dir, 'content.xml'))) type = 'odt';
    else throw new Error('不是可识别的Word文档目录（缺少word/document.xml或content.xml）');

    const mainFile = type === 'docx'
      ? pathLocal.join(dir, 'word', 'document.xml')
      : pathLocal.join(dir, 'content.xml');
    const stylesFile = type === 'docx'
      ? pathLocal.join(dir, 'word', 'styles.xml')
      : pathLocal.join(dir, 'styles.xml');

    return { dir, type, mainFile, stylesFile, sourcePath };
  }

  function extractDocxRuns(content, includeEmpty) {
    const paragraphs = content.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
    const items = [];
    let index = 0;
    for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
      const pXml = paragraphs[pIndex];
      const pStyle = ((pXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
      const runs = pXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) || [];
      for (let rIndex = 0; rIndex < runs.length; rIndex++) {
        const rXml = runs[rIndex];
        const tMatches = [...rXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
        if (!tMatches.length) continue;
        const rawText = tMatches.map(m => m[1]).join('');
        const text = decodeXmlEntities(rawText);
        if (!includeEmpty && !text.trim()) {
          index++;
          continue;
        }
        const color = ((rXml.match(/<w:color\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
        const sizeHalfPoint = ((rXml.match(/<w:sz\b[^>]*w:val="([^"]+)"/) || [])[1]) || '';
        items.push({
          index,
          paragraphIndex: pIndex,
          runIndex: rIndex,
          text,
          style: {
            paragraphStyle: pStyle,
            bold: /<w:b(?:\s[^>]*)?\/>|<w:b(?:\s[^>]*)?><\/w:b>/.test(rXml),
            italic: /<w:i(?:\s[^>]*)?\/>|<w:i(?:\s[^>]*)?><\/w:i>/.test(rXml),
            underline: /<w:u\b/.test(rXml),
            color,
            fontSizePt: sizeHalfPoint ? Number(sizeHalfPoint) / 2 : null
          }
        });
        index++;
      }
    }
    return items;
  }

  function applyDocxRunUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (m, attrs) => {
      const replaceTo = updatesMap.get(index);
      const currentIndex = index;
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `<w:t${attrs || ''}>${encodeXmlEntities(String(replaceTo))}</w:t>`;
    });
    return { content: next, updated };
  }

  function extractOdtTextNodes(content, includeEmpty) {
    const items = [];
    let index = 0;
    let pIndex = 0;
    content.replace(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g, (pMatch, pInner) => {
      pInner.replace(/>([^<>]*)</g, (m, text) => {
        const value = decodeXmlEntities(text || '');
        if (!includeEmpty && !value.trim()) {
          index++;
          return m;
        }
        items.push({ index, paragraphIndex: pIndex, runIndex: null, text: value, style: {} });
        index++;
        return m;
      });
      pIndex++;
      return pMatch;
    });
    return items;
  }

  function applyOdtTextUpdates(content, updatesMap) {
    let index = 0;
    let updated = 0;
    const next = content.replace(/>([^<>]*)</g, (m, text) => {
      const replaceTo = updatesMap.get(index);
      index++;
      if (replaceTo === undefined) return m;
      updated++;
      return `>${encodeXmlEntities(String(replaceTo))}<`;
    });
    return { content: next, updated };
  }

  function parseDocxStyles(stylesXml) {
    const styles = [];
    const blocks = stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) || [];
    for (const block of blocks) {
      const id = ((block.match(/w:styleId="([^"]+)"/) || [])[1]) || '';
      const type = ((block.match(/w:type="([^"]+)"/) || [])[1]) || '';
      const name = ((block.match(/<w:name\b[^>]*w:val="([^"]+)"/) || [])[1]) || id;
      styles.push({ id, name, type });
    }
    return styles;
  }

  function parseOdtStyles(stylesXml) {
    const styles = [];
    const matches = stylesXml.match(/<style:style\b[^>]*>/g) || [];
    for (const tag of matches) {
      const id = ((tag.match(/style:name="([^"]+)"/) || [])[1]) || '';
      const family = ((tag.match(/style:family="([^"]+)"/) || [])[1]) || '';
      styles.push({ id, name: id, type: family });
    }
    return styles;
  }

  function replaceWordPlaceholders(content, replacements) {
    let updated = 0;
    let next = content;
    const entries = Object.entries(replacements || {});
    for (const [key, value] of entries) {
      const safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const val = encodeXmlEntities(String(value ?? ''));
      const patterns = [
        new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g'),
        new RegExp(`\\$\\{\\s*${safeKey}\\s*\\}`, 'g'),
        new RegExp(`<<\\s*${safeKey}\\s*>>`, 'g')
      ];
      for (const re of patterns) {
        const count = (next.match(re) || []).length;
        if (count > 0) {
          next = next.replace(re, val);
          updated += count;
        }
      }
    }
    return { content: next, updated };
  }

  // ---- Office ZIP Tools ----
  ipcMain.handle('office:unpack', async (_, filePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const parsed = path.parse(filePath);
      const outDir = path.join(parsed.dir, parsed.name + '_unpacked');
      const zip = new AdmZip(filePath);
      zip.extractAllTo(outDir, true);
      // Save original extension for repack
      fs.writeFileSync(path.join(outDir, '.__office_ext__'), parsed.ext);
      return { ok: true, dir: outDir, message: `已解压到 ${outDir}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:listContents', async (_, dir) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const result = [];
      function walk(d, rel) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const rp = rel ? rel + '/' + f : f;
          const stat = fs.statSync(fp);
          if (stat.isDirectory()) { result.push({ path: rp + '/', size: 0 }); walk(fp, rp); }
          else result.push({ path: rp, size: stat.size });
        }
      }
      walk(dir, '');
      return { ok: true, files: result, count: result.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:repack', async (_, dir, outputPath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const AdmZip = require('adm-zip');
      if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在: ' + dir };
      let ext = '.docx';
      const extFile = path.join(dir, '.__office_ext__');
      if (fs.existsSync(extFile)) ext = fs.readFileSync(extFile, 'utf8').trim();
      const out = outputPath || dir.replace(/_unpacked$/, '') + ext;
      const zip = new AdmZip();
      function addDir(d, zipPath) {
        for (const f of fs.readdirSync(d)) {
          if (f === '.__office_ext__') continue;
          const fp = path.join(d, f);
          const zp = zipPath ? zipPath + '/' + f : f;
          if (fs.statSync(fp).isDirectory()) { addDir(fp, zp); }
          else { zip.addFile(zp, fs.readFileSync(fp)); }
        }
      }
      addDir(dir, '');
      zip.writeZip(out);
      return { ok: true, path: out, message: `已打包为 ${out}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Office Text Helpers (for translation workflow) ----
  ipcMain.handle('office:getSlideTexts', async (_, dir, slideFile) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      const content = fs.readFileSync(filePath, 'utf8');
      const texts = [];
      let index = 0;
      content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        if (text.trim()) texts.push({ index, text });
        index++;
        return match;
      });
      return { ok: true, slideFile, count: texts.length, texts };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:setSlideTexts', async (_, dir, slideFile, translations) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(dir, slideFile.replace(/\//g, path.sep));
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
      let content = fs.readFileSync(filePath, 'utf8');
      const map = {};
      for (const t of (translations || [])) map[t.index] = t.text;
      let index = 0;
      let count = 0;
      content = content.replace(/<a:t>([^<]*)<\/a:t>/g, (match, text) => {
        const idx = index++;
        if (idx in map) { count++; return `<a:t>${map[idx]}</a:t>`; }
        return match;
      });
      fs.writeFileSync(filePath, content, 'utf8');
      return { ok: true, slideFile, updated: count, message: `已更新 ${count} 处文字` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordExtract', async (_, pathOrDir, options = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const includeEmpty = !!options.includeEmpty;
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const items = target.type === 'docx'
        ? extractDocxRuns(xml, includeEmpty)
        : extractOdtTextNodes(xml, includeEmpty);
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        count: items.length,
        items
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordApplyTexts', async (_, pathOrDir, updates = []) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const updatesMap = new Map();
      for (const item of updates || []) {
        const idx = Number(item?.index);
        if (!Number.isInteger(idx) || idx < 0) continue;
        updatesMap.set(idx, String(item?.text ?? ''));
      }
      if (updatesMap.size === 0) return { ok: false, error: '缺少有效updates' };

      const applied = target.type === 'docx'
        ? applyDocxRunUpdates(xml, updatesMap)
        : applyOdtTextUpdates(xml, updatesMap);
      fsLocal.writeFileSync(target.mainFile, applied.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        updated: applied.updated
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordGetStyles', async (_, pathOrDir) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      if (!fsLocal.existsSync(target.stylesFile)) {
        return { ok: true, type: target.type, styles: [], count: 0 };
      }
      const stylesXml = fsLocal.readFileSync(target.stylesFile, 'utf8');
      const styles = target.type === 'docx' ? parseDocxStyles(stylesXml) : parseOdtStyles(stylesXml);
      return { ok: true, type: target.type, styles, count: styles.length, stylesFile: target.stylesFile };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('office:wordFillTemplate', async (_, pathOrDir, replacements = {}) => {
    try {
      const fsLocal = require('fs');
      const target = resolveWordDocTarget(pathOrDir);
      const xml = fsLocal.readFileSync(target.mainFile, 'utf8');
      const replaced = replaceWordPlaceholders(xml, replacements || {});
      fsLocal.writeFileSync(target.mainFile, replaced.content, 'utf8');
      return {
        ok: true,
        type: target.type,
        dir: target.dir,
        mainFile: target.mainFile,
        replaced: replaced.updated
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Office-Word 工具（正规库驱动）----
  ipcMain.handle('word:extractText', async (_, filePath, format) => {
    try { return await extractWordText(filePath, format); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('word:create', async (_, spec, workspacePath) => {
    try { return await createWordDocument(spec || {}, workspacePath); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('word:fillTemplate', async (_, templatePath, outputPath, data, workspacePath) => {
    try { return fillWordTemplate(templatePath, outputPath, data || {}, workspacePath); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('word:getMetadata', async (_, filePath) => {
    try { return await getWordMetadata(filePath); } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('word:listStyles', async (_, filePath) => {
    try { return listWordStyles(filePath); } catch (e) { return { ok: false, error: e.message }; }
  });

  // ---- PPT Maker ----
  // 生成视觉化 .pptx（封面/目录/章节/内容/图文/表格/图表/KPI/引用/对比/时间线/结束页），
  // 配色与深浅模式跟随主窗口主题。
  ipcMain.handle('ppt:create', async (_, spec, workspacePath) => {
    try {
      if (!spec || typeof spec !== 'object') return { ok: false, error: '缺少演示文稿定义' };
      if (!workspacePath || !fs.existsSync(workspacePath)) {
        return { ok: false, error: '工作区不存在，无法保存演示文稿' };
      }
      return await createPresentation(spec, {
        workspacePath,
        appTheme: settings.theme || {},
        nativeDark: nativeTheme.shouldUseDarkColors
      });
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // ---- Spreadsheet File I/O ----
  ipcMain.handle('spreadsheet:importFile', async (_, filePath) => {
    try {
      return importSpreadsheetFile(filePath);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('spreadsheet:exportFile', async (_, filePath, cells, sheetName) => {
    try {
      return exportSpreadsheetFile(filePath, cells, sheetName);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Email Service IPC ----
  ipcMain.handle('email:generateTOTP', async () => {
    try {
      return { ok: true, ...(await emailService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:saveTOTPSecret', async (_, secret) => {
    try {
      settings.email.totpSecret = secret;
      persistSettings();
      emailService.configure(settings.email);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:verifyTOTP', async (_, code) => {
    try {
      emailService.configure(settings.email);
      const valid = emailService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:connect', async () => {
    try {
      emailService.configure(settings.email);
      const mode = settings.email.mode || 'send-receive';
      let smtpMsg = '跳过', imapMsg = '跳过';
      if (mode === 'send-only' || mode === 'send-receive') {
        const smtp = await emailService.initSMTP();
        smtpMsg = smtp.message;
        console.log('[Email] SMTP connected');
      }
      if (mode === 'receive-only' || mode === 'send-receive') {
        const imap = await emailService.connectIMAP();
        imapMsg = imap.message;
        console.log('[Email] IMAP connected');
      }
      emailService.enabled = true;
      return { ok: true, smtp: smtpMsg, imap: imapMsg };
    } catch (e) {
      console.error('[Email] Connect error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:disconnect', async () => {
    try {
      await emailService.disconnect();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:send', async (_, to, subject, html, text) => {
    try {
      return await emailService.sendEmail(to, subject, html, text);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:fetchNew', async () => {
    try {
      const emails = await emailService.fetchNewEmails();
      return { ok: true, emails };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:startPolling', async () => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        if (mode === 'send-only' || mode === 'send-receive') {
          await emailService.initSMTP();
          console.log('[Email] SMTP connected for polling start');
        }
        if (mode === 'receive-only' || mode === 'send-receive') {
          await emailService.connectIMAP();
          console.log('[Email] IMAP connected for polling start');
        }
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        return { ok: true, message: '只发模式，无需轮询' };
      }
      emailService.onEmailReceived = (email) => {
        console.log('[Email] Received email from:', email.from, 'subject:', email.subject);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('email:received', email);
        }
      };
      emailService.startPolling();
      return { ok: true, message: '邮件轮询已启动' };
    } catch (e) {
      console.error('[Email] Start polling error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:stopPolling', async () => {
    try {
      emailService.stopPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:requestApproval', async (_, toolName, args, chatMarkdown) => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send approval request in receive-only mode, rejecting');
        return { ok: false, approved: false, reason: '邮件模式为只收，无法发送审批请求，已拒绝' };
      }
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        await emailService.initSMTP();
        if (mode === 'send-receive') await emailService.connectIMAP();
        emailService.enabled = true;
      }
      if (mode === 'send-only') {
        // Can send but cannot receive reply => auto-reject
        console.log('[Email] Send-only mode cannot receive approval reply, rejecting tool');
        return { ok: false, approved: false, reason: '邮件模式为只发，无法接收审批回复，已拒绝' };
      }
      return await emailService.requestApprovalViaEmail(toolName, args, chatMarkdown);
    } catch (e) {
      console.error('[Email] Request approval error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('email:sendConversation', async (_, messages, title) => {
    try {
      const mode = settings.email.mode || 'send-receive';
      if (mode === 'receive-only') {
        console.log('[Email] Cannot send conversation in receive-only mode');
        return { ok: false, error: '邮件模式为只收，无法发送对话摘要' };
      }
      if (!emailService.enabled) {
        emailService.configure(settings.email);
        await emailService.initSMTP();
        emailService.enabled = true;
      }
      return await emailService.sendConversationSummary(messages, title);
    } catch (e) {
      console.error('[Email] Send conversation error:', e);
      return { ok: false, error: e.message };
    }
  });

  // ---- FediKitten Service IPC ----
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
      if (a.savePath && !cibypImPathAllowed(a.savePath)) {
        return { ok: false, error: 'savePath 不在允许的目录内（工作区/用户数据目录）' };
      }
      if (CIBYP_IM_UPLOAD_TOOLS.has(toolName) && a.filePath && !cibypImReadAllowed(a.filePath)) {
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

  // ---- Web Control IPC ----
  // 通知渲染层 Web 控制是否运行：渲染层据此彻底跳过镜像序列化/IPC
  function broadcastWebControlRunning() {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webControl:running', !!webControlService.running);
      }
    } catch { /* ignore */ }
  }

  ipcMain.handle('webControl:start', async () => {
    try {
      webControlService.configure(settings.webControl);
      webControlService.workDir = workspacesBaseDir; // fallback; renderer will update when agent workspace is created
      // Wire callbacks
      webControlService.onGetHistory = async () => {
        const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
          const data = loadJSON(path.join(historyDir, f), {});
          return { id: data.id || f.replace('.json', ''), title: data.title || '未命名', date: data.updatedAt || data.createdAt || '' };
        }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      };
      webControlService.onGetConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      };
      webControlService.onNewChat = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:newChat');
        }
        return Date.now().toString();
      };
      webControlService.onSendMessage = async (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:sendMessage', message);
        }
      };
      webControlService.onStopAgent = async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:stopAgent');
        }
      };
      webControlService.onApprovalResponse = (approved) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:approvalResponse', approved);
        }
      };
      webControlService.onLoadConversation = (id) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('webControl:loadConversation', id);
        }
      };
      const result = await webControlService.start();
      broadcastWebControlRunning();
      return result;
    } catch (e) {
      console.error('[WebControl] Start error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:stop', async () => {
    try {
      const result = await webControlService.stop();
      broadcastWebControlRunning();
      return result;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 运行中热更新配置（改密码后无需 stop/start，bcrypt.compare 每次读 this.config）
  ipcMain.handle('webControl:reconfigure', async () => {
    try {
      if (webControlService.running) {
        webControlService.configure(settings.webControl);
        return { ok: true };
      }
      return { ok: true, message: '服务未运行' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:getStatus', () => {
    return { ok: true, running: webControlService.running, port: webControlService.port };
  });

  ipcMain.handle('webControl:hashPassword', async (_, password) => {
    try {
      const hash = await webControlService.hashPassword(password);
      return { ok: true, hash };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:generateTOTP', async () => {
    try {
      return { ok: true, ...(await webControlService.generateTOTPSecret()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:verifyTOTP', (_, code) => {
    try {
      webControlService.configure(settings.webControl);
      const valid = webControlService.verifyTOTP(code);
      return { ok: true, valid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Forward renderer events to web control
  ipcMain.on('webControl:pushMessage', (_, role, content, extra) => {
    if (webControlService.running) webControlService.pushMessage(role, content, extra);
  });
  ipcMain.on('webControl:pushStatus', (_, status) => {
    if (webControlService.running) webControlService.pushStatus(status);
  });
  ipcMain.on('webControl:pushApproval', (_, toolName, args) => {
    if (webControlService.running) webControlService.pushApproval(toolName, args);
  });
  ipcMain.on('webControl:clearApproval', () => {
    if (webControlService.running) webControlService.clearApproval();
  });
  ipcMain.on('webControl:pushToolCall', (_, toolName, args, status, result) => {
    if (webControlService.running) webControlService.pushToolCall(toolName, args, status, result);
  });
  ipcMain.on('webControl:pushConversationSwitch', (_, conversationId) => {
    if (webControlService.running) webControlService.pushConversationSwitch(conversationId);
  });
  ipcMain.on('webControl:pushHistoryMessages', (_, messages) => {
    if (webControlService.running) webControlService.pushHistoryMessages(messages);
  });
  ipcMain.on('webControl:pushTheme', (_, vars) => {
    if (webControlService.running) webControlService.pushTheme(vars);
  });
  ipcMain.on('webControl:pushTarot', (_, card) => {
    if (webControlService.running) webControlService.pushTarot(card);
  });
  ipcMain.on('webControl:pushTitle', (_, title) => {
    if (webControlService.running) webControlService.pushTitle(title);
  });
  ipcMain.on('webControl:setWorkDir', (_, dir) => {
    if (dir) webControlService.workDir = dir;
    console.log('[WebControl] workDir updated to agent workspace:', dir);
  });
  ipcMain.on('webControl:setAvatars', (_, avatars) => {
    webControlService._currentAvatars = avatars;
    if (webControlService.running) webControlService.pushAvatars(avatars);
  });
  // 渲染器模式切换 → 广播到 WebUI
  ipcMain.on('webControl:pushModeSwitch', (_, mode) => {
    if (webControlService.running && typeof webControlService.pushModeSwitch === 'function') {
      webControlService.pushModeSwitch(mode);
    }
  });
  // 渲染器上下文进度 → 广播到 WebUI（圆扇形指示器）
  ipcMain.on('webControl:pushContextProgress', (_, data) => {
    if (webControlService.running && typeof webControlService.pushContextProgress === 'function') {
      webControlService.pushContextProgress(data);
    }
  });
  // 渲染器重新优化按钮可见性 → 广播到 WebUI
  ipcMain.on('webControl:pushReoptimizeState', (_, visible) => {
    if (webControlService.running && typeof webControlService.pushReoptimizeState === 'function') {
      webControlService.pushReoptimizeState(visible);
    }
  });
  // 渲染器屏幕软键盘状态 → 广播到 WebUI
  ipcMain.on('webControl:pushOskState', (_, state) => {
    if (webControlService.running && typeof webControlService.pushOskState === 'function') {
      webControlService.pushOskState(state);
    }
  });
  // WebUI → 渲染器：模式切换
  if (typeof webControlService.onSwitchMode !== 'undefined') {
    webControlService.onSwitchMode = (mode) => {
      mainWindow?.webContents?.send('webControl:switchMode', mode);
    };
  }
  // WebUI → 渲染器：重新优化工具
  if (typeof webControlService.onReoptimizeTools !== 'undefined') {
    webControlService.onReoptimizeTools = () => {
      mainWindow?.webContents?.send('webControl:reoptimizeTools');
    };
  }
  // WebUI → 渲染器：切换屏幕软键盘
  if (typeof webControlService.onToggleOsk !== 'undefined') {
    webControlService.onToggleOsk = () => {
      mainWindow?.webContents?.send('webControl:toggleOsk');
    };
  }
  // ---- DOM Mirror bridge ----
  // WS 客户端连接后：通知渲染器推送完整 mirror_head + mirror_body 快照
  webControlService.onMirrorInit = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webControl:mirrorInit');
    }
  };
  // WebUI UI 事件 → 渲染器：转发到渲染器以触发对应元素操作
  webControlService.onUiEvent = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webControl:uiEvent', data);
    }
  };
  // WebUI 上传文件后通知渲染器刷新附件列表
  // 运行位置=虚拟机：WebUI 上传的文件送进 VM（返回 VM 路径作为附件路径）

  try {

    webControlService.vmUploader = async (hostPath, name) => {

      if ((settings.runtime || {}).location !== 'vm' || !vmService.instance || vmService.instance.state !== 'ready') return { ok: false };

      const { VmFs } = require('./vm/vm-fs');

      const vmFs = new VmFs({ vmService });

      const dir = /.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(name || '') ? '/workspace/_images' : '/workspace/_uploads';

      const vmPath = await vmFs.pushFromHost(hostPath, dir + '/' + Date.now() + '_' + String(name || 'upload.bin').replace(/[\\/]/g, '_'));

      return { ok: true, vmPath };

    };

  } catch (e) { console.warn('[vm] WebUI 上传 hook 注入失败:', e.message); }

  webControlService.onFileUploaded = (filePath, fileName, isImage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webControl:fileUploaded', { path: filePath, name: fileName, isImage });
    }
  };
  // WebUI 本地图片代理：允许用户数据目录 / 工作区基目录 / 当前 Agent 工作区内的图片
  webControlService.resolveLocalImage = (requested) => {
    try {
      const raw = String(requested).replace(/^file:\/\/\/?/i, '');
      let target = decodeURIComponent(raw);
      if (process.platform === 'win32') target = target.replace(/\//g, '\\');
      const real = fs.realpathSync(path.resolve(target));
      const roots = [userDataPath, imagesDir, workspacesBaseDir, webControlService.workDir]
        .filter(Boolean)
        .map((r) => { try { return fs.realpathSync(r); } catch (_) { return path.resolve(r); } });
      const allowed = roots.some((r) => real === r || real.startsWith(r + path.sep));
      if (!allowed) return null;
      const ext = path.extname(real).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(WebControlService.MIME_BY_EXT, ext)) return null;
      return real;
    } catch (_) { return null; }
  };
  // 渲染器 → WS 广播：DOM 镜像更新（mirror_head / mirror_body）
  ipcMain.on('webControl:mirrorUpdate', (_, data) => {
    if (webControlService.running) webControlService.pushMirrorUpdate(data);
  });

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
  if (settings.webControl.autoStartOnOpen && settings.webControl.passwordHash) {
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
        const fp = path.join(historyDir, id + '.json');
        if (!fs.existsSync(fp)) return null;
        return loadJSON(fp, null);
      };
      webControlService.onDeleteConversation = async (id) => {
        const fp = path.join(historyDir, id + '.json');
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
  // VM 模式：系统信息类工具报虚拟机（否则 Agent 会以为自己在宿主上跑）
  try {
    const vmSystemInfo = async (full) => {
      const inst = vmService.instance;
      if (!inst || inst.state !== 'ready') return null;
      const cmd = [
        'uname -m', 'nproc',
        "grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release | tr '\n' '|'",
        'head -1 /proc/meminfo',
        'df -m / | tail -1',
        'uname -r',
      ].join('; echo "\n---"; ');
      const r = await inst.exec(cmd, { timeoutMs: 20000 });
      const [arch, cpus, osRel, memLine, dfLine, kernel] = r.stdout.split('---').map((x) => x.trim());
      const memKB = parseInt(((memLine || '').match(/(\d+)/) || [])[1], 10) || 0;
      const memMB = Math.round(memKB / 1024);
      const diskMB = parseInt(((dfLine || '').trim().split(/\s+/)[1] || '0'), 10) || 0;
      const pretty = (osRel || '').split('|').filter(Boolean)[0] || 'CIBYP-VM-OS';
      const base = {
        location: 'vm',
        platform: 'linux',
        arch: arch || 'x86_64',
        cpus: parseInt(cpus, 10) || 0,
        totalMemory: (parseInt(memMB, 10) || 0) * 1024 * 1024,
        osRelease: kernel || '',
        distro: pretty,
      };
      if (!full) return base;
      return { ...base, hostname: 'cibyp-vmos', diskMB: parseInt(diskMB, 10) || 0, shell: '/bin/bash', note: '运行位置=虚拟机（信息来自 VM 内）' };
    };
    for (const ch of ['system:info', 'system:fullInfo']) {
      const orig = __ipcHandlers.get(ch);
      if (!orig) continue;
      ipcMain.removeHandler(ch);
      __originalIpcHandle(ch, async (e, ...args) => {
        try {
          if ((settings.runtime || {}).location === 'vm') {
            const info = await vmSystemInfo(ch === 'system:fullInfo');
            if (info) return ch === 'system:fullInfo' ? { ...(orig(e, ...args) || {}), ...info } : info;
          }
        } catch { /* 回退宿主 */ }
        return orig(e, ...args);
      });
      console.log('[vm] ' + ch + ' 已接入 VM 探测');
    }
  } catch (e) { console.warn('[vm] system:info 接入失败:', e.message); }
  try {
    const probe = ['fs:readFile', 'word:create', 'ppt:create', 'spreadsheet:exportFile', 'image:generate', 'file:download', 'ffmpeg:invoke'];
    const missing = probe.filter((ch) => !__ipcHandlers.has(ch));
    console.log(`[vm] 工具路由就绪（已记录 ${__ipcHandlers.size} 个通道；路由通道 ${ROUTE_CHANNELS.size} 个；缺: ${missing.length ? missing.join(',') : '无'}）`);
  } catch (e) {
    console.error('[vm] 工具路由自检失败（不影响本机模式）:', e.message);
  }
}
setTimeout(logVmRoutingSelfCheck, 3000);

// VM 模式：ffmpeg:available 改为报虚拟机内可用性（宿主实现作为回退）
try {
  const __origFfmpegAvail = __ipcHandlers.get('ffmpeg:available');
  if (__origFfmpegAvail) {
    ipcMain.removeHandler('ffmpeg:available');
    __originalIpcHandle('ffmpeg:available', async (e, ...args) => {
      try {
        const inVm = (settings.runtime || {}).location === 'vm' && vmService.instance && vmService.instance.state === 'ready';
        if (inVm) {
          const r = await vmService.instance.exec('command -v ffmpeg >/dev/null && (ffmpeg -version | head -1) || echo absent', { timeoutMs: 15000 });
          const out = (r.stdout || '').trim();
          const absent = /absent/.test(out);
          return { ok: !absent, location: 'vm', version: out, hint: absent ? '虚拟机内没有 ffmpeg：可在 VM 内执行 sudo apt-get install -y ffmpeg（或改用 full 变体镜像）' : '' };
        }
      } catch { /* 回退宿主 */ }
      return __origFfmpegAvail(e, ...args);
    });
    console.log('[vm] ffmpeg:available 已接入 VM 探测');


  }
} catch (e) { console.warn('[vm] ffmpeg:available 接入失败:', e.message); }

app.on('before-quit', async (event) => {
  isQuitting = true; // 标记真正退出，避免 close 事件再次拦截
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
  await mcpService.stopAllMcpServers();
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
    event.preventDefault();
    try {
      mainWindow.webContents.send('agent:save-pending');
    } catch { /* 窗口可能已销毁 */ }
    // 等待渲染器响应（最多 3 秒），然后强制退出
    const startWait = Date.now();
    const checkInterval = 100;
    while (!pendingSaveDone && Date.now() - startWait < 3000) {
      await new Promise(r => setTimeout(r, checkInterval));
    }
    // 保存完成或超时，触发真正的退出
    pendingSaveDone = true;
    app.quit();
  }
});
