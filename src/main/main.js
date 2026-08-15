/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, dialog, clipboard, screen, shell, systemPreferences, Notification, Tray, Menu, nativeImage, protocol, net } = require('electron');

// stdout/stderr 被关闭或管道截断（如 `npm start | head`）时，console.log 会抛
// EPIPE 未捕获异常直接崩溃主进程 —— 吞掉流错误，此后写操作变为无害 no-op。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { EmailService } = require('./email-service');
const { importSpreadsheetFile, exportSpreadsheetFile } = require('./spreadsheet-io');
const { WebControlService } = require('./web-control-service');
const { fetchLLMWithRetry, consumeSSEStream, abortAllRequests, abortRequests, DEFAULT_TIMEOUT_MS } = require('./llm-retry');
const LLMProviders = require('./llm-providers');
const ESLintService = require('./eslint-service');
const { BUNDLED_SKILLS } = require('../data/bundled-skills');
const { importKnowledgeFile } = require('./document-import');
const { createPresentation } = require('./ppt-maker');
const { extractWordText, createWordDocument, fillWordTemplate, getWordMetadata, listWordStyles } = require('./word-tools');
const mathTools = require('./math-tools');
const tarotTools = require('./tarot-tools');
const { decodeXmlEntities, encodeXmlEntities } = require('./xml-utils');
const { recognizeImageWithTesseract } = require('./ocr');
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

const emailService = new EmailService();
const webControlService = new WebControlService();
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
const pluginManager = new PluginManager(dataDir, {
  skills: pluginSkillsProvider,
  transport: { send: dsTransportSend, request: dsTransportRequest },
  getSettings: async () => loadJSON(settingsPath, {})
}).init();
// 自动化任务管理器（定时 / 系统通知 / HTTP 信号服务器 → 新 Chat 会话）
const automationManager = new AutomationManager({
  dataDir,
  transport: { send: dsTransportSend, request: dsTransportRequest },
  getSettings: async () => loadJSON(settingsPath, {})
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

function persistSettings() {
  saveJSON(settingsPath, settings);
}




let settings = loadJSON(settingsPath, {
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
    reasoningEffort: 'off'
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
  imageGen: {
    apiUrl: 'https://api.siliconflow.cn/v1/images/generations',
    apiKey: '',
    model: 'Kwai-Kolors/Kolors',
    imageSize: '1024x1024',
    dailyMaxImages: 0,
    dailyImagesUsed: 0,
    dailyImageDate: ''
  },
  theme: { mode: 'system', accentColor: '#4f8cff', backgroundColor: '#f5f7fa' },
  // 界面动效：关闭后主标签页切换无动画（设置页「动效」开关）
  animations: true,
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
  webControl: { enabled: false, port: 3456, password: '', passwordHash: '', enable2FA: false, totpSecret: '' },
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
});
if (fs.existsSync(settingsPath)) {
  const saved = loadJSON(settingsPath, {});
  settings = { ...settings, ...saved, llm: { ...settings.llm, ...(saved.llm || {}) }, agent: { ...settings.agent, ...(saved.agent || {}) }, sessions: { ...settings.sessions, ...(saved.sessions || {}) }, imageGen: { ...settings.imageGen, ...(saved.imageGen || {}) }, theme: { ...settings.theme, ...(saved.theme || {}) }, aiPersona: { ...settings.aiPersona, ...(saved.aiPersona || {}) }, userProfile: { ...settings.userProfile, ...(saved.userProfile || {}) }, entropy: { ...settings.entropy, ...(saved.entropy || {}) }, proxy: { ...settings.proxy, ...(saved.proxy || {}) }, mcp: { ...settings.mcp, ...(saved.mcp || {}) }, email: { ...settings.email, ...(saved.email || {}) }, webControl: { ...settings.webControl, ...(saved.webControl || {}) }, budget: { ...settings.budget, ...(saved.budget || {}) }, terminal: { ...settings.terminal, ...(saved.terminal || {}) }, privacyProtection: { ...settings.privacyProtection, ...(saved.privacyProtection || {}) }, ime: { ...settings.ime, ...(saved.ime || {}) }, voice: { ...settings.voice, ...(saved.voice || {}) } };
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
// Migrate: per-day usage tracking (for token stats tab).
if (!settings.llm.usageHistory) settings.llm.usageHistory = {};
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
    }
    if (p.completionPerK != null && p.outputPerM == null) {
      p.outputPerM = (Number(p.completionPerK) || 0) * 1000;
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
if (!settings.budget) settings.budget = { models: {}, peakHours: { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 }, dailyLimitUSD: 0, monthlyLimitUSD: 0, warningThreshold: 0.8 };
// 工具首次使用授权状态迁移
if (!settings.toolAuthGranted) settings.toolAuthGranted = { playwright: false, computerUse: false };
else {
  if (typeof settings.toolAuthGranted.playwright !== 'boolean') settings.toolAuthGranted.playwright = false;
  if (typeof settings.toolAuthGranted.computerUse !== 'boolean') settings.toolAuthGranted.computerUse = false;
}
// 后台托盘模式设置迁移
if (!settings.closeToTray || !['ask', 'always', 'never', 'once'].includes(settings.closeToTray)) {
  settings.closeToTray = 'ask';
}
if (typeof settings.trayEnabled !== 'boolean') settings.trayEnabled = true;
if (!settings.budget.peakHours) settings.budget.peakHours = { enabled: false, start: 9, end: 18, inputMul: 1.5, cacheReadMul: 1.5, outputMul: 1.5, cacheWriteMul: 1.5 };
saveJSON(settingsPath, settings);

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

function createSplashWindow() {
  if (splashCreated || !mainWindow || mainWindow.isDestroyed()) return;
  splashCreated = true;
  splashWindow = new BrowserWindow({
    width: 420, height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
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
  const params = {
    dark: dark ? '1' : '0',
    accent: accent.slice(1),
    bg: bg.slice(1),
    version: app.getVersion(),
    gitHash: getGitShortHash(),
    font: fontFamily
  };
  splashWindow.loadFile(path.join(__dirname, '../renderer/pages/splash.html'), { query: params });
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
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏到托盘后仍需保持 LLM 流式/语音播报/Agent 后台运行，禁用节流
      backgroundThrottling: false
    }
  });
  mainWindowShownOnce = false;
  // 兜底：渲染器 boot 异常/超时时也必须显示窗口
  setTimeout(() => {
    if (!mainWindowShownOnce && mainWindow && !mainWindow.isDestroyed()) {
      mainWindowShownOnce = true;
      mainWindow.show();
    }
  }, MAIN_WINDOW_SHOW_FALLBACK_MS);
  registerRendererReadyListener();
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
  // 主窗口一旦显示（渲染器就绪或超时兜底）即关闭 Splash
  mainWindow.on('show', () => closeSplash());
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

// 渲染器预渲染完成 → 显示主窗口（sender 校验防止子窗口误触发；
// 模块级一次性注册，避免窗口重建时重复累积监听器）
let _rendererReadyListenerRegistered = false;
function registerRendererReadyListener() {
  if (_rendererReadyListenerRegistered) return;
  _rendererReadyListenerRegistered = true;
  ipcMain.on('app:renderer-ready', (event) => {
    if (!mainWindowShownOnce && mainWindow && !mainWindow.isDestroyed()
        && event.sender === mainWindow.webContents) {
      mainWindowShownOnce = true;
      mainWindow.show();
      mainWindow.focus();
    }
  });
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

// ===== 代理设置应用到 Electron session =====
// 让 settings.proxy 真正生效，影响渲染进程的网络请求（fetch/XHR/WebSocket）
// 主进程的 Node.js fetch（undici）不走 Electron 代理，aria2 通过 --all-proxy 单独配置
function applyProxySettings(proxy) {
  if (!proxy) return;
  const { session } = require('electron');

  let config = { mode: 'direct' };

  if (proxy.mode === 'none') {
    config = { mode: 'direct' };
  } else if (proxy.mode === 'system') {
    config = { mode: 'system' };
  } else if (proxy.mode === 'manual') {
    const proxyUrl = proxy.https || proxy.http;
    if (proxyUrl) {
      // Electron pacScript 格式：PROXY host:port
      let pacRules = '';
      const cleanUrl = proxyUrl.replace(/^https?:\/\//i, '').replace(/^socks5?:\/\//i, '');
      if (/^socks/i.test(proxyUrl)) {
        pacRules = `SOCKS5 ${cleanUrl}`;
      } else {
        pacRules = `PROXY ${cleanUrl}`;
      }
      // bypass 列表（逗号分隔）
      const bypassList = proxy.bypass || 'localhost,127.0.0.1';
      config = {
        mode: 'fixed_servers',
        proxyRules: pacRules,
        proxyBypassRules: bypassList.split(/[,;\s]+/).filter(Boolean).join(';')
      };
    } else {
      config = { mode: 'direct' };
    }
  }

  session.defaultSession.setProxy(config).catch((e) => {
    console.warn('[Proxy] 设置代理失败:', e.message);
  });
  console.log('[Proxy] 已应用代理设置:', config.mode);
}

// 代理设置变更时动态更新（由渲染进程 settings 保存后触发）
ipcMain.handle('proxy:apply', async (_, proxy) => {
  try {
    applyProxySettings(proxy);
    // 同时通知 aria2 重启以应用新代理
    if (aria2Manager.ready) {
      await aria2Manager.start(proxy);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  // 注册 GeoGebra 离线静态服务（ggb://app/... → assets/geogebra-app/GeoGebra/HTML5/5.0/...）
  registerGeogebraProtocol();
  // 启动时复制 OCR traineddata 文件到当前执行目录根，避免 GFW blocking
  const appPath = app.getAppPath();
  // 检测 .no-tarot 标志文件（由 build --no-tarot 脚本写入）：若存在则屏蔽所有塔罗牌元素/工具/UI
  const NO_TAROT_BUILD = fs.existsSync(path.join(appPath, '.no-tarot'));
  if (NO_TAROT_BUILD) {
    console.log('[CIBYP] .no-tarot 标志文件存在，塔罗牌功能已被屏蔽');
    // 强制覆盖设置中的 tarotVisible 为 false（即使用户之前保存过 true）
    settings.tarotVisible = false;
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
  }
  const srcOcrDir = path.join(appPath, 'assets', 'ocr');
  const destOcrDir = process.cwd();
  if (fs.existsSync(srcOcrDir)) {
    try {
      const files = fs.readdirSync(srcOcrDir);
      for (const file of files) {
        if (file.endsWith('.traineddata') || file.endsWith('.gz')) {
          const destPath = path.join(destOcrDir, file);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(path.join(srcOcrDir, file), destPath);
          }
        }
      }
    } catch (e) {
      console.error('Failed to copy OCR data:', e);
    }
  }
  // macOS: 通过 Electron systemPreferences 触发无障碍权限请求
  // 使用 AXIsProcessTrustedWithOptions（内部 kAXTrustedCheckOptionPrompt=true），
  // 在未授权时由系统弹出原生授权对话框；已授权则直接返回 true，不会重复弹窗。
  // 注意：osascript 调用 System Events 不需要无障碍权限，无法用 osascript 检测真实状态。
  if (process.platform === 'darwin') {
    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      if (!trusted) {
        // isTrustedAccessibilityClient(true) 只弹一次窗；若用户之前拒绝过则不会再弹，
        // 需主动打开系统设置引导用户手动授权
        console.warn('[Accessibility] Not trusted. Opening System Settings to guide user...');
        try {
          require('child_process').exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[Accessibility] Check failed:', e.message);
    }
    // macOS Sequoia 15+: 主动触发本地网络权限请求
    // 仅声明 NSLocalNetworkUsageDescription + NSBonjourServices 不会自动弹窗，
    // 必须发起一次 Bonjour/mDNS 浏览才会触发系统权限弹窗。
    // 普通局域网 TCP 连接不会触发本地网络权限（实测），必须用 Bonjour 浏览。
    // 通过 dns-sd -B 命令浏览 Bonjour 服务，触发权限请求后立即终止。
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
  // ===== 应用代理设置 =====
  // 让 settings.proxy 真正生效：配置 Electron session 的网络代理
  // 影响渲染进程的 fetch/XHR 请求；主进程的 fetch（Node undici）需另行配置
  applyProxySettings(settings.proxy);

  createWindow();
  // Splash 启动画面：主窗口预渲染完成前展示品牌画面（主窗口 show 时自动关闭）
  createSplashWindow();
  // 启动时即创建托盘图标（若启用）
  if (settings.trayEnabled) createAppTray();

  // ===== 语音子系统初始化（STT/TTS/唤醒，全本地 sherpa-onnx） =====
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
    // P2：worker 就绪后同步语音能力到 WebUI（浏览器麦克风按钮依赖）
    (async () => {
      try {
        if (voiceIpc && voiceIpc.engine && webControlService) {
          await voiceIpc.engine.ensureWorker().catch(() => {});
          const st = voiceIpc.getStatus ? voiceIpc.getStatus() : null;
          if (st) webControlService.setVoiceCapabilities(st);
        }
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
    console.error('[voice] 初始化失败:', e);
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
  settings = { ...settings, ...newSettings };
  saveJSON(settingsPath, settings);
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

function detectEnvTool(candidates) {
  for (const cmd of candidates) {
    let r;
    try {
      r = spawnSync(cmd, ['--version'], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch { continue; }
    if (r.error || r.status !== 0 || !r.stdout) continue;
    let exePath = null;
    try {
      const loc = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
        timeout: 6000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      if (loc.status === 0 && loc.stdout) exePath = loc.stdout.trim().split(/\r?\n/)[0];
    } catch { /* ignore */ }
    return { found: true, command: cmd, version: normalizeEnvVersion(r.stdout), path: exePath };
  }
  return { found: false, command: candidates[0] || null, version: null, path: null };
}

ipcMain.handle('env:detect', () => {
  try {
    const results = {
      python: detectEnvTool(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']),
      node: detectEnvTool(['node']),
      npm: detectEnvTool(['npm']),
      bun: detectEnvTool(['bun']),
      git: detectEnvTool(['git'])
    };
    return { ok: true, results, platform: process.platform };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Theme ----
ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, mode: settings.theme.mode }));
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
  getSettings: () => settings
});

// ---- FFmpeg / FFprobe 媒体工具集 ----
registerFfmpegIpc({ ipcMain });

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

ipcMain.handle('code:runJS', (_, code, cwd, sandboxMode) => {
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

// ---- IPC: Image Generation ----
ipcMain.handle('image:generate', async (_, prompt, workspacePath) => {
  try {
    const { net } = require('electron');
    const apiUrl = settings.imageGen.apiUrl;
    const apiKey = settings.imageGen.apiKey;
    const model = settings.imageGen.model;
    const imageSize = settings.imageGen.imageSize;
    if (!apiKey) return { ok: false, error: '请先配置生图API Key' };

    resetDailyUsageIfNeeded();
    const maxImages = settings.imageGen.dailyMaxImages || 0;
    if (maxImages > 0 && settings.imageGen.dailyImagesUsed >= maxImages) {
      return { ok: false, error: '已达到今日生图上限，请明天再试' };
    }

    const body = JSON.stringify({ model, prompt, image_size: imageSize, batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5 });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body
    });
    const data = await response.json();
    if (data.images && data.images[0] && data.images[0].url) {
      const imgUrl = data.images[0].url;
      const imgResponse = await fetch(imgUrl);
      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      
      // Save to workspace if provided, otherwise use imagesDir
      const saveDir = workspacePath || imagesDir;
      const imgPath = path.join(saveDir, `generated_${Date.now()}.png`);
      fs.writeFileSync(imgPath, buffer);
      
      settings.imageGen.dailyImagesUsed = (settings.imageGen.dailyImagesUsed || 0) + 1;
      persistSettings();
      
      // Return file:// URL for display
      const fileUrl = 'file://' + imgPath.replace(/\\/g, '/');
      return { ok: true, path: imgPath, url: fileUrl };
    }
    return { ok: false, error: '生图API未返回有效图片' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Web Search & Fetch ----
ipcMain.handle('web:search', async (_, query, workspacePath) => {
  if (!mainWindow) return { ok: false, error: '主窗口未就绪' };

  // 创建离屏隐藏窗口进行后台渲染
  const offscreenWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    await offscreenWindow.webContents.loadURL(url, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

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

    const image = await offscreenWindow.webContents.capturePage();
    // Code 模式：检测工作区下 .cibyp-code-history 目录是否存在，是则保存到其 assets/ 子目录
    // 否则保持原有行为（保存到工作区根目录或 imagesDir）
    let targetDir = imagesDir;
    if (workspacePath && fs.existsSync(workspacePath)) {
      const codeHistDir = path.join(workspacePath, '.cibyp-code-history');
      if (fs.existsSync(codeHistDir)) {
        const assetsDir = path.join(codeHistDir, 'assets');
        try { fs.mkdirSync(assetsDir, { recursive: true }); } catch {}
        targetDir = assetsDir;
      } else {
        targetDir = workspacePath;
      }
    }
    const imgPath = path.join(targetDir, `bing_${Date.now()}.png`);
    fs.writeFileSync(imgPath, image.toPNG());

    return {
      ok: true,
      query,
      url: result.url,
      title: result.title,
      results: result.results,
      html: result.html,
      screenshotPath: imgPath,
      screenshotUrl: `file://${imgPath}`
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) {
        offscreenWindow.close();
      }
    } catch { /* ignore */ }
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
  if (!targetUrl) return { ok: false, error: '缺少URL' };

  const offscreenWindow = new BrowserWindow({
    width: Number(options.width) || 1366,
    height: Number(options.height) || 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    await offscreenWindow.webContents.loadURL(targetUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

    const image = await offscreenWindow.webContents.capturePage();
    const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
    const imgPath = path.join(targetDir, `offscreen_${Date.now()}.png`);
    fs.writeFileSync(imgPath, image.toPNG());

    const ocrText = await recognizeImageWithTesseract(imgPath);
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
      screenshotPath: imgPath,
      screenshotUrl: `file://${imgPath}`,
      waitMs,
      ocrText: String(ocrText || '').slice(0, 100000),
      renderedText: String(pageMeta?.text || '').slice(0, 100000)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) offscreenWindow.close();
    } catch {}
  }
});

ipcMain.handle('web:offscreenRenderedContent', async (_, options = {}) => {
  const targetUrl = String(options.url || '').trim();
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 10000;
  const workspacePath = options.workspacePath;
  const captureScreenshot = options.captureScreenshot !== false;
  const includeHtml = options.includeHtml !== false;
  if (!targetUrl) return { ok: false, error: '缺少URL' };

  const offscreenWindow = new BrowserWindow({
    width: Number(options.width) || 1366,
    height: Number(options.height) || 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  try {
    await offscreenWindow.webContents.loadURL(targetUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
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
      const image = await offscreenWindow.webContents.capturePage();
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : imagesDir;
      screenshotPath = path.join(targetDir, `offscreen_content_${Date.now()}.png`);
      fs.writeFileSync(screenshotPath, image.toPNG());
      screenshotUrl = `file://${screenshotPath}`;
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
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try {
      if (!offscreenWindow.isDestroyed()) offscreenWindow.close();
    } catch {}
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

// ---- IPC: LLM API Call (with retry/backoff/timeout) ----
ipcMain.handle('llm:chat', async (event, messages, options = {}) => {
  try {
    const llm = settings.llm;
    if (llm.provider === 'opencode-zen') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先在设置中配置OpenCode Zen API Key和模型' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    // 预算控制：检查是否超限
    const budgetCheck = checkBudgetExceeded(settings.budget || {});
    if (budgetCheck.exceeded) {
      if (budgetCheck.action === 'stop') {
        return { ok: false, error: `预算超限（${budgetCheck.period}周期已用 $${budgetCheck.cost.toFixed(4)} / $${budgetCheck.limit.toFixed(2)}），已停止接受新请求` };
      }
      if (budgetCheck.action === 'fallback' && budgetCheck.fallbackModel) {
        // 临时切换到 fallback 模型
        options._budgetFallbackModel = budgetCheck.fallbackModel;
      }
    }

    // 预算 fallback：如果设置了 fallback 模型，使用副本覆盖
    const llmForRequest = options._budgetFallbackModel
      ? { ...llm, model: options._budgetFallbackModel }
      : llm;
    const req = LLMProviders.buildLLMRequest(llmForRequest, {
      messages: normalizeMessagesForThinking(messages),
      tools: options.tools,
      tool_choice: options.tool_choice,
      temperature: options.temperature ?? llm.temperature,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      response_format: options.response_format || null,
      reasoningEffort: options.reasoningEffort || null,
      stream: false
    });

    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      fallbackModel: llm.fallbackModel || null,
      requestId: options.requestId || null,
      sessionKey: options.sessionKey || null
    };
    const onRetry = (info) => {
      // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
      try { mainWindow?.webContents.send('llm:retry', { ...info, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    };

    const result = await fetchLLMWithRetry({
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body, options: retryOpts, onRetry
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
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(data.choices?.[0]?.message?.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llm.model);
    persistSettings();
    broadcastUsageChanged();
    // 游戏窗口/子窗口调用 LLM 时，把 usage 推送给主渲染器，让其累计到当前会话统计
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
      try { mainWindow.webContents.send('llm:external-usage', { usage, model: llm.model, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    }
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Streaming (with retry/backoff/timeout) ----
ipcMain.handle('llm:chatStream', async (_, messages, options = {}) => {
  try {
    const llm = settings.llm;
    if (llm.provider === 'opencode-zen') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先在设置中配置OpenCode Zen API Key和模型' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    resetDailyUsageIfNeeded();
    const maxTokensDaily = settings.llm.dailyMaxTokens || 0;
    if (maxTokensDaily > 0 && settings.llm.dailyTokensUsed >= maxTokensDaily) {
      return { ok: false, error: '已达到今日LLM Token上限，请明天再试' };
    }

    // 预算控制：检查是否超限
    const budgetCheck = checkBudgetExceeded(settings.budget || {});
    if (budgetCheck.exceeded && budgetCheck.action === 'stop') {
      return { ok: false, error: `预算超限（${budgetCheck.period}周期已用 $${budgetCheck.cost.toFixed(4)} / $${budgetCheck.limit.toFixed(2)}），已停止接受新请求` };
    }
    const llmForRequest = (budgetCheck.exceeded && budgetCheck.action === 'fallback' && budgetCheck.fallbackModel)
      ? { ...llm, model: budgetCheck.fallbackModel }
      : llm;

    const req = LLMProviders.buildLLMRequest(llmForRequest, {
      messages: normalizeMessagesForThinking(messages),
      tools: options.tools,
      tool_choice: options.tool_choice,
      temperature: options.temperature ?? llm.temperature,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      stream: true
    });

    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      fallbackModel: llm.fallbackModel || null,
      requestId: options.requestId || null,
      sessionKey: options.sessionKey || null
    };
    const onRetry = (info) => {
      // 带上 sessionKey，渲染进程各 Agent 据此过滤，避免其他会话的重试气泡串到当前会话
      try { mainWindow?.webContents.send('llm:retry', { ...info, sessionKey: options.sessionKey || null }); } catch { /* ignore */ }
    };

    const result = await fetchLLMWithRetry({
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body, options: retryOpts, onRetry
    });
    if (!result.ok) return { ok: false, error: result.error, kind: result.kind };

    let streamResult;
    let lastChunkKey = null;
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
      }, options.requestId, req.transport, 120000);
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
        total_tokens: estPrompt + estCompletion
      };
      estimated = true;
    }
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(streamResult.content || '');
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llm.model);
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
        usage: { ...usage, _estimated: estimated }
      }
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: LLM Summary (one-shot, no tools, for context compaction) ----
ipcMain.handle('llm:summarize', async (_, messages, options = {}) => {
  try {
    const llm = settings.llm;
    if (llm.provider === 'opencode-zen') {
      if (!llm.zenApiKey || !llm.model) return { ok: false, error: '请先配置OpenCode Zen' };
    } else if (!llm.apiUrl || !llm.model) {
      return { ok: false, error: '请先在设置中配置LLM API' };
    }

    const req = LLMProviders.buildLLMRequest(llm, {
      messages: normalizeMessagesForThinking(messages),
      temperature: options.temperature ?? 0.3,
      max_tokens: options.max_tokens ?? llm.maxResponseTokens ?? 8192,
      stream: false,
      // 上下文压缩的"会话回放"：携带与主请求一致的 tools，复用暖前缀缓存
      // （DeepSeek 按输入前缀逐字节匹配；tools 位于前缀内）。
      tools: Array.isArray(options.tools) && options.tools.length > 0 ? options.tools : undefined,
      // purpose 仅作归属标记（对应 dsh 的 x-deepseek-harness-compact 语义），
      // 不改动模型可见内容，各 provider 忽略即可。
      purpose: options.purpose || undefined
    });
    const retryOpts = {
      maxRetries: options.maxRetries ?? llm.maxRetries ?? undefined,
      timeoutMs: options.timeoutMs ?? llm.timeoutMs ?? undefined,
      fallbackModel: llm.fallbackModel || null,
      sessionKey: options.sessionKey || null
    };
    const result = await fetchLLMWithRetry({
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
    const usage = data.usage || {};
    const usageTokens = usage.total_tokens
      || estimateTokens(JSON.stringify(req.body)) + estimateTokens(content);
    settings.llm.dailyTokensUsed = (settings.llm.dailyTokensUsed || 0) + usageTokens;
    recordTokenUsage(usage, llm.model);
    persistSettings();
    broadcastUsageChanged();
    return { ok: true, content, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: OpenCode Zen models list ----
ipcMain.handle('zen:fetchModels', async () => {
  try {
    const apiKey = settings.llm.zenApiKey;
    // Zen /v1/models 端点无需认证即可访问
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    // 10 秒超时，避免网络挂起导致向导永远卡在"正在获取模型列表..."
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let resp;
    try {
      resp = await fetch('https://opencode.ai/zen/v1/models', { headers, signal: controller.signal });
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
    const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) });
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
// Avatar: pick image file and return base64 data URL
ipcMain.handle('avatar:pickAndEncode', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false };
    const fp = result.filePaths[0];
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64') };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Avatar: encode an existing file path to base64 data URL (for migration)
ipcMain.handle('avatar:encodeFile', async (_, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false };
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,` + buf.toString('base64') };
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
const pendingHistorySaves = new Map(); // key -> { timer, filePath, data }
const HISTORY_SAVE_DEBOUNCE_MS = 1200;

function queueHistorySave(key, filePath, data) {
  const existing = pendingHistorySaves.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingHistorySaves.delete(key);
    try { saveJSON(filePath, data, false); } catch (e) { console.error('queueHistorySave 写盘失败:', e); }
  }, HISTORY_SAVE_DEBOUNCE_MS);
  pendingHistorySaves.set(key, { timer, filePath, data });
}

function flushPendingHistorySaves() {
  if (pendingHistorySaves.size === 0) return;
  for (const [key, { timer, filePath, data }] of pendingHistorySaves) {
    clearTimeout(timer);
    try { saveJSON(filePath, data, false); } catch (e) { console.error('flushPendingHistorySaves 写盘失败:', e); }
    pendingHistorySaves.delete(key);
  }
}

ipcMain.handle('history:list', () => {
  try {
    flushPendingHistorySaves();
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json')).sort((a, b) => b.localeCompare(a));
    return files.map(f => {
      const data = loadJSON(path.join(historyDir, f), {});
      const meta = {
        id: data.id,
        title: data.title || '未命名对话',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        mode: data.mode || 'chat',
        status: data.status || 'idle',
        lastError: data.lastError || null,
        usage: data.usage || null,
        finishedAt: data.finishedAt || null
      };
      // 列表只需元数据：释放大数组引用，避免历史文件全量驻留内存
      delete data.messages;
      delete data.summaries;
      return meta;
    });
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
  return loadJSON(p, null);
});

ipcMain.handle('history:save', (_, conversation) => {
  if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  queueHistorySave('history:' + conversation.id, path.join(historyDir, `${conversation.id}.json`), conversation);
  return { ok: true, queued: true };
});

ipcMain.handle('history:delete', (_, id) => {
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(historyDir, `${id}.json`));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('history:rename', (_, id, title) => {
  flushPendingHistorySaves();
  const p = path.join(historyDir, `${id}.json`);
  const data = loadJSON(p, null);
  if (data) { data.title = title; data.updatedAt = new Date().toISOString(); saveJSON(p, data); return { ok: true }; }
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

// ---- IPC: Babe History (独立持久化，含好感度等会话属性) ----
ipcMain.handle('babeHistory:list', () => {
  flushPendingHistorySaves();
  try {
    const files = fs.readdirSync(babeHistoryDir).filter(f => f.endsWith('.json')).sort((a, b) => b.localeCompare(a));
    return files.map(f => {
      const data = loadJSON(path.join(babeHistoryDir, f), {});
      const meta = {
        id: data.id,
        title: data.title || '未命名对话',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        messageCount: (data.messages || []).length,
        affection: data.affection ?? 0,
        mode: data.mode || 'babe',
        status: data.status || 'idle',
        lastError: data.lastError || null,
        usage: data.usage || null
      };
      // 列表只需元数据：释放大数组引用
      delete data.messages;
      delete data.summaries;
      return meta;
    });
  } catch { return []; }
});

ipcMain.handle('babeHistory:get', (_, id) => {
  flushPendingHistorySaves();
  const p = path.join(babeHistoryDir, `${id}.json`);
  return loadJSON(p, null);
});

ipcMain.handle('babeHistory:save', (_, conversation) => {
  if (!conversation || !conversation.id) return { ok: false, error: 'invalid conversation' };
  conversation.updatedAt = new Date().toISOString();
  if (!conversation.createdAt) conversation.createdAt = new Date().toISOString();
  queueHistorySave('babe:' + conversation.id, path.join(babeHistoryDir, `${conversation.id}.json`), conversation);
  return { ok: true, queued: true };
});

ipcMain.handle('babeHistory:delete', (_, id) => {
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(babeHistoryDir, `${id}.json`));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('babeHistory:rename', (_, id, title) => {
  flushPendingHistorySaves();
  const p = path.join(babeHistoryDir, `${id}.json`);
  const data = loadJSON(p, null);
  if (data) { data.title = title; data.updatedAt = new Date().toISOString(); saveJSON(p, data); return { ok: true }; }
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
ipcMain.handle('workspace:create', () => {
  const ts = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(workspacesBaseDir, ts);
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true, path: dir };
});

ipcMain.handle('workspace:getBase', () => workspacesBaseDir);

ipcMain.handle('workspace:openInExplorer', (_, dirPath) => {
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

ipcMain.handle('code:listHistory', (_, workspacePath) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    const files = fs.readdirSync(histDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const filePath = path.join(histDir, f);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          // ts 缺失或非法时回退到文件修改时间，避免旧历史显示 1970 年
          let ts = Number(data.ts);
          if (!isFinite(ts) || ts <= 0) {
            try { ts = fs.statSync(filePath).mtimeMs; } catch { ts = 0; }
          }
          const meta = {
            id: f.replace('.json', ''),
            title: data.title || '未命名',
            ts,
            messageCount: (data.messages || []).length,
            mode: data.mode || 'code',
            status: data.status || 'idle',
            lastError: data.lastError || null,
            usage: data.usage || null
          };
          // 列表只需元数据：释放大数组引用
          delete data.messages;
          return meta;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.ts - a.ts);
    return { ok: true, history: files };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:loadHistory', (_, workspacePath, id) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    const data = JSON.parse(fs.readFileSync(path.join(histDir, id + '.json'), 'utf-8'));
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:saveHistory', (_, workspacePath, id, data) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    queueHistorySave('code:' + id, path.join(histDir, id + '.json'), data);
    return { ok: true, queued: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('code:deleteHistory', (_, workspacePath, id) => {
  const histDir = getCodeHistoryDir(workspacePath);
  if (!histDir) return { ok: false, error: 'no workspace' };
  try {
    flushPendingHistorySaves();
    fs.unlinkSync(path.join(histDir, id + '.json'));
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
const { aria2Manager } = require('./aria2-manager');

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
    if (llm.provider === 'opencode-zen') {
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
      apiUrl: req.url, apiKey: req.headers['x-api-key'] || llm.apiKey || llm.zenApiKey,
      headers: req.headers,
      body: req.body,
      options: {
        maxRetries: llm.maxRetries ?? undefined,
        timeoutMs: Math.min(llm.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60000),
        fallbackModel: llm.fallbackModel || null
      }
    });
    if (!result.ok) return { ok: true, action: 'auto' };
    const rawData = await result.response.json();
    if (rawData.error) return { ok: true, action: 'auto' };
    const data = LLMProviders.parseLLMResponse(rawData, req.transport);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: true, action: 'auto' };

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
  appVersion: APP_VERSION
});

// ---- Playwright 浏览器控制（实现已拆分到 ./browser-service.js）----
const pwService = registerPlaywrightIpc({
  ipcMain,
  getSettings: () => settings,
  getMainWindow: () => mainWindow,
  getImagesDir: () => imagesDir
});

// Auto-connect configured MCP servers on startup
app.whenReady().then(async () => {
  // 启动时全量重审 DeepSeek 插件（后台执行，不阻断启动：
  // 交互式插件探测可能耗时，await 会导致后续 IPC 注册延迟，
  // 渲染器早期调用如 webControl:getStatus 找不到 handler）
  pluginManager.refreshAll().catch(e => console.warn('[DS Plugins] 启动加载失败:', e.message));
  // 启动自动化任务调度循环（cron / 通知 / HTTP 信号服务器）
  try { automationManager.start(); } catch (e) { console.warn('[automation] 启动失败:', e.message); }

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

  // ---- Web Control IPC ----

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
      return result;
    } catch (e) {
      console.error('[WebControl] Start error:', e);
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webControl:stop', async () => {
    try {
      return await webControlService.stop();
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
  webControlService.onFileUploaded = (filePath, fileName, isImage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webControl:fileUploaded', { path: filePath, name: fileName, isImage });
    }
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
      }).catch(e => console.error('[WebControl] Auto-start failed:', e.message));
    } catch (e) {
      console.error('[WebControl] Auto-start config error:', e.message);
    }
  }
});

// Cleanup MCP servers, serial ports, and web control on app quit
// 若渲染器有正在工作的会话，先通知其保存 pending 状态，等待完成后再退出
app.on('before-quit', async (event) => {
  isQuitting = true; // 标记真正退出，避免 close 事件再次拦截
  closeSplash();
  // 将防抖队列中的历史保存立即落盘，避免退出时丢失
  flushPendingHistorySaves();
  await mcpService.stopAllMcpServers();
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
