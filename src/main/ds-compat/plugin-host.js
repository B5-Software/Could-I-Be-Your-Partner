/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * DeepSeek 插件宿主：Cordis 内核当 lib，Provider 全部自研。
 *
 * - 插件跑在真实的 @deepseek-ai/cordis Context 上（inject/effect/事件/HMR 语义原生可用）。
 * - `ctx.tools` 由 CIBYP 自己的 CibypToolsService 提供：register(defineTool(...)) 被捕获。
 * - 其余 seams（skills/settings/sandbox/llm/fs/shell/jobs/subagent）注册最小桥接，
 *   插件 inject 解析成功；未实现的能力在调用时给出明确错误（部分兼容）。
 * - 插件 apply 异常被捕获记录为 compatIssues，不拖垮宿主。
 */

'use strict';

const { Context, Service } = require('@deepseek-ai/cordis');
const { pathToFileURL } = require('url');
const sandboxRunner = require('../sandbox-runner');
const { validateArgs } = require('./shims/dsh-tools');

// 当前正在挂载的插件身份（注册期同步标记，供 CibypToolsService.register 归属工具）
const hostContext = { pluginId: null, pluginName: null };

class CibypToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.tools = new Map(); // name → definition
  }

  register(definition) {
    if (!definition || typeof definition.name !== 'string') {
      throw new Error('tool definition requires a name');
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`duplicate tool registration: ${definition.name}`);
    }
    definition.pluginId = hostContext.pluginId || null;
    definition.pluginName = hostContext.pluginName || null;
    this.tools.set(definition.name, definition);
    return () => { if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name); };
  }
}

class PluginHost {
  constructor() {
    this.ctx = new Context();
    this.fibers = new Map(); // pluginId → fiber
    this.toolsService = null;
    this.initialized = false;
    this.issues = new Map(); // pluginId → [string]
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.ctx.plugin(CibypToolsService);
    this.toolsService = this.ctx.tools;
    // 桥接 seams：skills / settings / sandbox 提供可用实现，其余 stub
    await this.ctx.plugin(class SkillsBridge extends Service {
      constructor(c) {
        super(c, 'skills');
        this.list = async () => [];
        this.get = async () => { throw new Error('skills 能力暂未在 CIBYP 桥接'); };
        this.register = () => () => {};
      }
    });
    await this.ctx.plugin(class SettingsBridge extends Service {
      constructor(c) {
        super(c, 'settings');
        this.get = async () => ({});
        this.update = async () => { throw new Error('settings 能力暂未在 CIBYP 桥接'); };
      }
    });
    await this.ctx.plugin(class SandboxBridge extends Service {
      constructor(c) {
        super(c, 'sandbox');
        this.confine = (argv, policy) => sandboxRunner.confine(argv, policy);
      }
    });
    for (const name of ['llm', 'fs', 'shell', 'subprocess', 'jobs', 'subagent', 'session', 'storage', 'compaction']) {
      const serviceKey = name;
      await this.ctx.plugin(class Bridge extends Service {
        constructor(c) {
          super(c, serviceKey);
        }
      });
    }
  }

  async _importEntry(entryPath) {
    try {
      return await import(pathToFileURL(entryPath).href);
    } catch (e) {
      // 回退 CJS require（部分插件发布为 commonjs）
      return require(entryPath);
    }
  }

  _toPlugin(mod, pluginId) {
    const isServiceClass = (fn) => fn && typeof fn === 'function' && fn.prototype instanceof Service;
    const attachMeta = (fn, name, inject) => {
      try {
        Object.defineProperty(fn, 'name', { value: name || pluginId, configurable: true });
        if (Array.isArray(inject)) Object.defineProperty(fn, 'inject', { value: inject, configurable: true });
      } catch { /* 元数据附加失败不影响加载 */ }
      return fn;
    };
    if (mod && typeof mod === 'object') {
      const def = mod.default;
      if (typeof def === 'function' && !isServiceClass(def)) {
        return attachMeta((ctx, config) => def(ctx, config), (mod && typeof mod.name === 'string' ? mod.name : def.name), mod.inject);
      }
      if (def && typeof def === 'object' && typeof def.apply === 'function') return def;
      if (isServiceClass(def)) return def;
      if (typeof mod.apply === 'function') {
        const plugin = mod.apply;
        if (typeof plugin !== 'function') return plugin;
        return attachMeta((ctx, config) => plugin(ctx, config), mod.name, mod.inject);
      }
      if (typeof def === 'object' && def && typeof def.apply === 'function') return def;
      if (typeof def === 'function' && isServiceClass(def)) return def;
    }
    if (typeof mod === 'function') return mod;
    throw new Error('无法识别插件入口（缺少 apply/default 导出）');
  }

  /**
   * 加载插件：import 入口 → 挂载到 Cordis → 捕获其注册的工具。
   * @returns {{tools: Array<{name, description, schema, compatTier}>, issues: string[]}}
   */
  async loadPlugin(pluginId, entryPath, meta = {}) {
    await this.init();
    if (this.fibers.has(pluginId)) {
      throw new Error(`plugin "${pluginId}" is already loaded`);
    }
    this.issues.set(pluginId, []);
    let mod;
    try {
      mod = await this._importEntry(entryPath);
    } catch (e) {
      this.issues.get(pluginId).push(`入口加载失败: ${e.message}`);
      return { tools: [], issues: this.issues.get(pluginId).slice() };
    }
    const plugin = this._toPlugin(mod, pluginId);
    hostContext.pluginId = pluginId;
    hostContext.pluginName = meta.name || pluginId;
    const before = new Set(this.toolsService.tools.keys());
    try {
      const fiber = await this.ctx.plugin(plugin, meta.config || {});
      this.fibers.set(pluginId, fiber);
    } catch (e) {
      this.issues.get(pluginId).push(`apply 执行失败: ${e.message}`);
      hostContext.pluginId = null;
      hostContext.pluginName = null;
      return { tools: [], issues: this.issues.get(pluginId).slice() };
    } finally {
      hostContext.pluginId = null;
      hostContext.pluginName = null;
    }
    const tools = [];
    for (const [name, def] of this.toolsService.tools.entries()) {
      if (before.has(name) || def.pluginId !== pluginId) continue;
      tools.push({
        name,
        description: def.description,
        schema: def.parameters || { type: 'object', properties: {} },
        compatTier: 'native'
      });
    }
    return { tools, issues: this.issues.get(pluginId).slice() };
  }

  async unloadPlugin(pluginId) {
    const fiber = this.fibers.get(pluginId);
    if (!fiber) return false;
    await fiber.dispose();
    this.fibers.delete(pluginId);
    return true;
  }

  async dispose() {
    for (const fiber of this.fibers.values()) {
      try { await fiber.dispose(); } catch { /* ignore */ }
    }
    this.fibers.clear();
    try { await this.ctx.fiber.dispose(); } catch { /* ignore */ }
  }

  /**
   * 执行插件工具（CIBYP executeTool 的 ds__ 路由落点）。
   */
  async callTool(pluginId, toolName, args, execCtx = {}) {
    const def = this.toolsService && this.toolsService.tools.get(toolName);
    if (!def || def.pluginId !== pluginId) {
      return { ok: false, error: `插件 ${pluginId} 未提供工具 ${toolName}` };
    }
    const validated = validateArgs(def, args || {});
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(def.timeoutMs || 120000, 600000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const exec = {
      signal: controller.signal,
      token: `${pluginId}:${toolName}:${Date.now().toString(36)}`,
      callId: execCtx.callId || `${pluginId}:${toolName}:${Math.random().toString(36).slice(2, 10)}`,
      sessionId: execCtx.sessionId || null,
      cwd: execCtx.cwd || null,
      sandboxMode: execCtx.sandboxMode || 'danger-full-access',
      agent: {
        inject: async () => { throw new Error('agent.inject 暂未在 CIBYP 桥接'); }
      }
    };
    try {
      const value = await def.execute(validated, exec);
      let content = '';
      if (def.output && typeof def.output.render === 'function') {
        const blocks = def.output.render(validated, value);
        content = Array.isArray(blocks)
          ? blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
          : String(blocks || '');
      } else {
        content = typeof value === 'string' ? value : safeStringify(value);
      }
      return { ok: true, content, value, callId: exec.callId };
    } catch (e) {
      if (e && e.name === 'ToolArgsError') {
        return { ok: false, error: e.message, invalidArgs: true };
      }
      return { ok: false, error: e.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

module.exports = { PluginHost, CibypToolsService };
