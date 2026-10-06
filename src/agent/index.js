/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Node 侧的 Agent 内核加载器（无头运行时 / 测试用）。
 *
 * Agent 内核（agent.js、tools-def.js 等）在页面上是经典 <script>：模块彼此以
 * "自由标识符" 引用（ContextManager / ToolExposure / getToolSchemas ...）。这里按
 * index.html 的脚本顺序 require 这些模块，并把它们补到 globalThis 上，使 agent.js
 * 的自由标识符在 Node 里同样解析得到（与页面行为一致）。
 *
 * 注意：全局只在缺失时补齐，测试注入的替身（如 global.ContextManager = TestCM）
 * 始终优先。
 */

'use strict';

const hostKit = require('./host.js');
const { loadPreloadApi } = require('./preload-api.js');
const { loadI18n } = require('./i18n-loader.js');

let cachedCore = null;

/** 按 index.html 的脚本顺序加载内核并接线全局标识符。 */
function loadAgentCore() {
  if (cachedCore) return cachedCore;

  const toolsDef = require('../renderer/js/tools-def.js');
  const { ToolExposure } = require('../renderer/js/tool-exposure.js');
  const PrivacyFilter = require('../renderer/js/privacy-filter.js');
  const goalState = require('../renderer/js/goal-state.js');
  const { ContextManager } = require('../renderer/js/context-manager.js');
  const titleUtils = require('../renderer/js/title-utils.js');
  const { BUNDLED_SKILLS } = require('../data/bundled-skills.js');
  const TokenUsage = require('../shared/token-usage.js');
  const TokenPolicy = require('../shared/token-policy.js');
  const AttachmentData = require('../shared/attachments.js');

  const globals = {
    ContextManager,
    ToolExposure,
    PrivacyFilter,
    GoalState: goalState,
    BUNDLED_SKILLS,
    TokenUsage,
    TokenPolicy,
    AttachmentData,
    titleUtils,
    // tools-def 的工具目录与注册函数（agent.js 以自由标识符调用）
    TOOL_DEFINITIONS: toolsDef.TOOL_DEFINITIONS,
    DANGEROUS_COMMANDS: toolsDef.DANGEROUS_COMMANDS,
    CODE_TOOLS: toolsDef.CODE_TOOLS,
    BABE_ALLOWED_TOOLS: toolsDef.BABE_ALLOWED_TOOLS,
    CATEGORY_META: toolsDef.CATEGORY_META,
    CHAT_ONLY_TOOLS: toolsDef.CHAT_ONLY_TOOLS,
    CONFIG_GATED_TOOLS: toolsDef.CONFIG_GATED_TOOLS,
    getToolSchemas: toolsDef.getToolSchemas,
    getAllToolDefinitions: toolsDef.getAllToolDefinitions,
    registerMcpTools: toolsDef.registerMcpTools,
    registerDsPluginTools: toolsDef.registerDsPluginTools,
    clearMcpDynamicTools: toolsDef.clearMcpDynamicTools,
    clearDsPluginTools: toolsDef.clearDsPluginTools,
    isToolAvailableForMode: toolsDef.isToolAvailableForMode,
    getToolAuthCategory: toolsDef.getToolAuthCategory,
    isConfigGatedTool: toolsDef.isConfigGatedTool,
    isConfigGatedToolAvailable: toolsDef.isConfigGatedToolAvailable,
    filterToolDefsByConfig: toolsDef.filterToolDefsByConfig,
    isToolEnabledForSettings: toolsDef.isToolEnabledForSettings,
    normalizeDecisionCriteria: toolsDef.normalizeDecisionCriteria,
    filterToolsByConfig: toolsDef.filterToolsByConfig,
    adaptReadImageFileSchema: toolsDef.adaptReadImageFileSchema,
  };
  for (const [name, value] of Object.entries(globals)) {
    if (value !== undefined && globalThis[name] === undefined) globalThis[name] = value;
  }

  // i18n：设置里的语言 → 系统提示/工具描述/工具回显的翻译（与 GUI 共用词典）
  const i18n = loadI18n();
  for (const [name, fn] of Object.entries(i18n)) {
    if (typeof fn === 'function' && globalThis[name] === undefined) globalThis[name] = fn;
  }
  // TUI 文案层共享同一套词典（ui.* 等键可复用 GUI 的翻译）
  try {
    require('../tui/text.js').setGlobalTranslator(i18n.t);
  } catch {
    /* TUI 未加载时不影响内核 */
  }

  const { Agent, BATCH_TOOL_SPECS } = require('../renderer/js/agent.js');

  cachedCore = {
    Agent,
    BATCH_TOOL_SPECS,
    ContextManager,
    ToolExposure,
    PrivacyFilter,
    GoalState: goalState,
    titleUtils,
    toolsDef,
    BUNDLED_SKILLS,
    i18n,
  };
  return cachedCore;
}

/**
 * 组装一个无头运行时宿主：api 门面来自 preload 定义（经 bridge 派发），
 * GUI 能力优雅失败，标题/待办等纯逻辑能力正常工作。
 */
function createRuntimeHost({ api, onInteractive, events, platform, todos } = {}) {
  return hostKit.createHeadlessHost({
    api: api || {},
    titleUtils: loadAgentCore().titleUtils,
    todos: todos || hostKit.createTodoStore(api || {}),
    onInteractive,
    events,
    platform,
  });
}

/**
 * 创建无头 Agent 实例（内核 + 宿主）。
 * @param {{ api?: object, host?: object, onInteractive?: Function }} options
 */
function createHeadlessAgent(options = {}) {
  const core = loadAgentCore();
  const host = options.host || createRuntimeHost(options);
  return new core.Agent({ host });
}

module.exports = {
  hostKit,
  loadAgentCore,
  loadPreloadApi,
  createRuntimeHost,
  createHeadlessAgent,
  createHeadlessHost: hostKit.createHeadlessHost,
  createRendererHost: hostKit.createRendererHost,
  createTodoStore: hostKit.createTodoStore,
  SESSION_STATUS: hostKit.SESSION_STATUS,
};
