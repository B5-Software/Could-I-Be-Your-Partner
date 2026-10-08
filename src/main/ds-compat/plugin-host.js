/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * DeepSeek 插件宿主：Cordis 内核当 lib，Provider 全部自研。
 *
 * - 插件跑在真实的 @deepseek-ai/cordis Context 上（inject/effect/事件/HMR 语义原生可用）。
 * - `ctx.tools` 由 CIBYP 自己的 CibypToolsService 提供：register(defineTool(...)) 被捕获。
 * - SDK capability contracts are translated to CIBYP's services. CIBYP owns
 *   Agent driving, credentials, settings, history and frontend lifecycles.
 * - 插件 apply 异常被捕获记录为 compatIssues，不拖垮宿主。
 */

'use strict';

const { Context, Service, symbols } = require('@deepseek-ai/cordis');
const { pathToFileURL } = require('url');
const nodePath = require('path');
const fsp = require('fs/promises');
const { execution } = require('./execution-context');
const { validateArgs } = require('./shims/dsh-tools');
const { ToolRuntime } = require('@deepseek-ai/dsh-tools');
const { scopeOf } = require('@deepseek-ai/dsh-scope');

/** Schemastery Config（模块级导出）校验：Schema 可调用，失败抛 ValidationError。 */
async function validatePluginConfig(schema, config) {
  if (!schema) return config || {};
  if (typeof schema === 'function') return schema(config || {});
  if (schema && typeof schema['~standard']?.validate === 'function') {
    const res = await schema['~standard'].validate(config || {});
    if (res && Array.isArray(res.issues) && res.issues.length) {
      throw new Error(res.issues.map((i) => i.message || String(i)).join('; '));
    }
    return res && res.value !== undefined ? res.value : config || {};
  }
  return config || {};
}

// 当前正在挂载的插件身份（注册期同步标记，供 CibypToolsService.register 归属工具）
const hostContext = { pluginId: null, pluginName: null };
const PLUGIN_OWNER = Symbol.for('cibyp.plugin.owner');

class CibypToolsService extends ToolRuntime {
  constructor(ctx) {
    super(ctx, { mode: 'native' });
    this.tools = new Map();
    this.registrations = new Set();
    this.registrationDisposers = new Map();
    this.guards = new Map();
  }
  register(definition) {
    const owner = this.ctx[PLUGIN_OWNER] || hostContext;
    const registered = {
      ...definition,
      pluginId: owner.pluginId || null,
      pluginName: owner.pluginName || null,
      execute: (args, call) =>
        definition.execute(args, {
          ...call,
          cwd: execution.getStore()?.cwd,
          sessionKey: execution.getStore()?.agent?.id,
        }),
      output: {
        schema: {},
        render: (_, value) => [
          { type: 'text', text: typeof value === 'string' ? value : safeStringify(value) },
        ],
        ...definition.output,
      },
    };
    const dispose = super.register(registered);
    const scope = scopeOf(this.ctx);
    const remove = this.ctx.effect(() => {
      this.registrations.add(registered);
      if (!scope) this.tools.set(registered.name, registered);
      return () => {
        this.registrations.delete(registered);
        this.registrationDisposers.delete(registered);
        if (this.tools.get(registered.name) === registered) this.tools.delete(registered.name);
      };
    });
    const cleanup = () => {
      dispose();
      remove();
    };
    this.registrationDisposers.set(registered, cleanup);
    return cleanup;
  }
  clearPlugin(id) {
    for (const [def, dispose] of [...this.registrationDisposers])
      if (def.pluginId === id) dispose();
  }
  registerGuard(guard) {
    return this.guard(guard);
  }
}

class PluginHost {
  constructor(options = {}) {
    this.options = options;
    this.ctx = new Context();
    this.fibers = new Map(); // pluginId → fiber
    this.toolsService = null;
    this.initialized = false;
    this.issues = new Map(); // pluginId → [string]
    this._opLock = new Map(); // pluginId → 串行操作链（探测/启用/卸载不并发）
    this._activeTools = new Map();
  }

  /** 按插件串行化加载/卸载，避免“探测与启用并发”造成的服务残留竞态。 */
  _serialize(pluginId, run) {
    const prev = this._opLock.get(pluginId) || Promise.resolve();
    const next = prev.then(run, run);
    this._opLock.set(
      pluginId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  async init() {
    if (this.initialized) return;
    if (this._initializing) return this._initializing;
    this._initializing = this._init().catch((error) => {
      this._initializing = null;
      this.initialized = false;
      throw error;
    });
    return this._initializing;
  }

  async _init() {
    await require('./service-setup').setupServices(this, CibypToolsService);
    this.initialized = true;
  }

  async _importEntry(entryPath) {
    const resolved = nodePath.resolve(entryPath);
    // ESM 模块缓存按 URL 缓存：插件更新后同一路径会命中旧模块。
    // 追加文件 mtime 作为 query，强制重新加载最新代码。
    let mtime = Date.now();
    try {
      mtime = (await fsp.stat(resolved)).mtimeMs;
    } catch {
      /* ignore */
    }
    // Node imports CommonJS directly. Never retry a failed import via require:
    // doing so would execute a throwing module's startup side effects twice.
    try {
      delete require.cache[require.resolve(resolved)];
    } catch {
      /* ignore */
    }
    return import(`${pathToFileURL(resolved).href}?t=${Math.floor(mtime)}`);
  }

  _toPlugin(mod, pluginId) {
    const isServiceClass = (fn) =>
      fn && typeof fn === 'function' && fn.prototype instanceof Service;
    const attachMeta = (fn, name, inject) => {
      try {
        Object.defineProperty(fn, 'name', { value: name || pluginId, configurable: true });
        if (inject) Object.defineProperty(fn, 'inject', { value: inject, configurable: true });
      } catch {
        /* 元数据附加失败不影响加载 */
      }
      return fn;
    };
    if (mod && typeof mod === 'object') {
      const def = mod.default;
      if (typeof def === 'function' && !isServiceClass(def)) {
        return attachMeta(
          (ctx, config) => def(ctx, config),
          mod && typeof mod.name === 'string' ? mod.name : def.name,
          mod.inject,
        );
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
  loadPlugin(pluginId, entryPath, meta = {}) {
    return this._serialize(pluginId, () => this._loadPlugin(pluginId, entryPath, meta));
  }

  async _loadPlugin(pluginId, entryPath, meta = {}) {
    await this.init();
    if (this.fibers.has(pluginId)) {
      throw new Error(`plugin "${pluginId}" is already loaded`);
    }
    this.issues.set(pluginId, []);
    const refusal = await require('./compatibility-policy').entryRefusal(entryPath, meta);
    if (refusal) {
      this.issues.get(pluginId).push(refusal);
      return { tools: [], issues: [refusal] };
    }
    let mod;
    try {
      mod = await this._importEntry(entryPath);
    } catch (e) {
      this.issues.get(pluginId).push(`入口加载失败: ${e.message}`);
      return { tools: [], issues: this.issues.get(pluginId).slice() };
    }
    let plugin;
    try {
      plugin = this._toPlugin(mod, pluginId);
    } catch (error) {
      this.issues.get(pluginId).push(error.message);
      return { tools: [], issues: this.issues.get(pluginId).slice() };
    }
    // Context ownership survives delayed registration and dependency activation.
    // Do not mutate the plugin's definition or rely on a global async identity.
    const identity = { pluginId, pluginName: meta.name || pluginId };
    const original = plugin;
    if (typeof original === 'function' && original.prototype instanceof Service) {
      plugin = class extends original {
        constructor(ctx, config) {
          ctx[PLUGIN_OWNER] = identity;
          super(ctx, config);
        }
      };
    } else if (typeof original === 'function') {
      plugin = (ctx, config) => {
        ctx[PLUGIN_OWNER] = identity;
        return original(ctx, config);
      };
    } else {
      plugin = {
        ...original,
        apply(ctx, config) {
          ctx[PLUGIN_OWNER] = identity;
          return original.apply(ctx, config);
        },
      };
    }
    const declaredInject = original.inject;
    if (Array.isArray(declaredInject)) plugin.inject = declaredInject;
    else if (declaredInject) {
      plugin.inject = {};
      for (const [name, config] of Object.entries(declaredInject)) {
        const optional = config === false || config?.required === false;
        if (optional && !this.ctx.reflect._getImpl(name, true)) continue;
        const intercept = config && typeof config === 'object' ? { ...config } : null;
        if (intercept) delete intercept.required;
        plugin.inject[name] = intercept;
      }
    } else {
      // Legacy plugins omitted inject and relied on direct service access.
      plugin.inject = [
        'tools',
        'skills',
        'fs',
        'shell',
        'settings',
        'agents',
        'sessions',
        'llm',
        'sandboxPolicy',
        'approval',
        'sandbox',
        'webServer',
        'jobs',
        'storage',
        'compaction',
      ].filter((name) => this.ctx.reflect._getImpl(name, true));
    }
    if (original.Config) plugin.Config = original.Config;
    // 模块级 Config（Schemastery）：真实 DSH 宿主在 apply 前完成校验并合并默认值，
    // Cordis 只对“插件对象自带 Config”做校验，函数式插件因此必须由我们处理。
    let config = meta.config || {};
    if (mod && typeof mod === 'object' && mod.Config) {
      try {
        config = await validatePluginConfig(mod.Config, config);
      } catch (e) {
        this.issues.get(pluginId).push(`配置校验失败: ${e.message}`);
        return { tools: [], issues: this.issues.get(pluginId).slice() };
      }
    }
    this.ctx.settings.registerPlugin(pluginId, mod.Config || original.Config, config);
    hostContext.pluginId = pluginId;
    hostContext.pluginName = meta.name || pluginId;
    let fiber = null;
    try {
      // 预清理：移除该插件历史纤维（disposed/error 态）残留的服务注册。
      // 挂起/失败的 apply 的 teardown 可能永远不会完成，这里按归属强制清除，
      // 从根上保证重载不会报 "service ... has been registered"。
      try {
        const runtime = this.ctx.registry && this.ctx.registry.get(plugin);
        if (runtime && runtime.fibers && runtime.fibers.map) {
          for (const f of runtime.fibers.map.values()) {
            if (!f || f.state === 2) continue; // 仅处理非活跃纤维
            for (const name of Object.keys(f.store || {})) {
              const impl = f.store[name];
              if (!impl || impl.fiber !== f) continue;
              const key = this.ctx.root[symbols.isolate] && this.ctx.root[symbols.isolate][name];
              if (key) delete this.ctx.reflect.store[key];
            }
          }
        }
      } catch {
        /* ignore */
      }
      // apply 挂起保护：交互式 TUI 类插件（如 dsh-cc-tui）可能永不返回，
      // 超时后强制卸载纤维，避免阻塞启动/启用流程
      const applyTimeout = meta.applyTimeoutMs || this.options.applyTimeoutMs || 30000;
      let applyTimer;
      try {
        fiber = await Promise.race([
          this.ctx.plugin(plugin, config),
          new Promise((_, reject) => {
            applyTimer = setTimeout(
              () => reject(new Error('apply 挂起超时（可能为交互式 TUI 插件）')),
              applyTimeout,
            );
            applyTimer.unref();
          }),
        ]);
      } finally {
        clearTimeout(applyTimer);
      }
      this.fibers.set(pluginId, fiber);
    } catch (e) {
      // 强制卸载可能已注册的纤维：挂起的 apply 不能被 await，否则会卡死宿主
      const candidates = [];
      if (fiber && typeof fiber.dispose === 'function') candidates.push(fiber);
      try {
        const runtime = this.ctx.registry && this.ctx.registry.get(plugin);
        if (runtime && runtime.fibers && runtime.fibers.map) {
          for (const f of runtime.fibers.map.values()) {
            if (f && typeof f.dispose === 'function' && !candidates.includes(f)) candidates.push(f);
          }
        }
      } catch {
        /* ignore */
      }
      for (const f of candidates) {
        try {
          await Promise.race([f.dispose(), new Promise((r) => setTimeout(r, 1200).unref())]);
        } catch {
          /* ignore */
        }
        // 挂起的 apply 会让 fiber.dispose() 永久等待 teardown，
        // 这里直接清空该纤维注册过的服务，避免下一次加载报
        // "service ... has been registered"。
        try {
          for (const name of Object.keys(f.store || {})) {
            const impl = f.store[name];
            if (!impl || impl.fiber !== f) continue; // 只清理该纤维自己提供的服务，不动注入的宿主服务
            const key = this.ctx.root[symbols.isolate] && this.ctx.root[symbols.isolate][name];
            if (key) delete this.ctx.reflect.store[key];
          }
        } catch {
          /* ignore */
        }
      }
      // 失败后彻底移除该插件可能残留的工具注册
      this.toolsService.clearPlugin(pluginId);
      for (const [name, def] of [...this.toolsService.tools.entries()]) {
        if (def.pluginId === pluginId) this.toolsService.tools.delete(name);
      }
      this.issues.get(pluginId).push(`apply 执行失败: ${e.message}`);
      hostContext.pluginId = null;
      hostContext.pluginName = null;
      return { tools: [], issues: this.issues.get(pluginId).slice() };
    } finally {
      hostContext.pluginId = null;
      hostContext.pluginName = null;
    }
    // 注入依赖缺口诊断：Cordis 对缺失服务不抛错，而是让插件纤维永远休眠
    // （表现为“零工具、零报错”）。这里把缺口显式记录为兼容问题。
    const inject = plugin.inject;
    const injectNames = Array.isArray(inject)
      ? inject
      : inject && typeof inject === 'object'
        ? Object.keys(inject)
        : [];
    const missing = injectNames.filter((name) => !this.ctx.reflect._getImpl(name, true));
    if (missing.length) {
      this.issues
        .get(pluginId)
        .push(`缺少宿主服务注入: ${missing.join(', ')}（插件保持休眠，未注册工具）`);
    }
    const tools = this.toolsForPlugin(pluginId);
    return { tools, issues: this.issues.get(pluginId).slice() };
  }

  unloadPlugin(pluginId) {
    return this._serialize(pluginId, async () => {
      for (const jobs of this._activeTools.values())
        for (const job of jobs)
          if (job.pluginId === pluginId) job.controller.abort(new Error('Plugin unloaded'));
      const fiber = this.fibers.get(pluginId);
      if (fiber) {
        await Promise.race([fiber.dispose(), new Promise((r) => setTimeout(r, 1500).unref())]);
        this.fibers.delete(pluginId);
      }
      // 清除该插件注册的工具：更新/重装后旧工具定义不得残留在工具注册表
      if (this.toolsService) {
        this.toolsService.clearPlugin(pluginId);
        for (const [name, def] of [...this.toolsService.tools.entries()]) {
          if (def.pluginId === pluginId) this.toolsService.tools.delete(name);
        }
        for (const [guard, owner] of this.toolsService.guards)
          if (owner === pluginId) this.toolsService.guards.delete(guard);
      }
      return true;
    });
  }

  toolsForPlugin(pluginId) {
    return [...this.toolsService.registrations]
      .filter((def) => def.pluginId === pluginId)
      .map((def) => ({
        name: def.name,
        description: def.description,
        schema: def.parameters,
        compatTier: 'native',
      }));
  }

  surfaceTool(wire, sessionKey) {
    const agent = this.agentsService.get(sessionKey);
    for (const def of this.toolsService.registrations) {
      if (
        `ds__${def.pluginId}__${def.name}` === wire &&
        this.toolsService.get(def.name, agent)?.pluginId === def.pluginId
      )
        return { pluginId: def.pluginId, name: def.name };
    }
  }

  callSurfaceTool(wire, args, context) {
    const tool = this.surfaceTool(wire, context?.sessionKey);
    return tool
      ? this.callTool(tool.pluginId, tool.name, args, context)
      : { ok: false, error: 'Plugin tool unavailable: ' + wire };
  }

  async dispose() {
    for (const jobs of this._activeTools.values())
      for (const job of jobs) job.controller.abort(new Error('Plugin host disposed'));
    for (const fiber of this.fibers.values()) {
      try {
        await Promise.race([fiber.dispose(), new Promise((r) => setTimeout(r, 1500).unref())]);
      } catch {
        /* ignore */
      }
    }
    this.fibers.clear();
    try {
      await Promise.race([
        this.ctx.fiber.dispose(),
        new Promise((r) => setTimeout(r, 1500).unref()),
      ]);
    } catch {
      /* ignore */
    }
  }

  /**
   * 执行插件工具（CIBYP executeTool 的 ds__ 路由落点）。
   */
  async callTool(pluginId, toolName, args, execCtx = {}) {
    const sessionKey = execCtx.sessionKey || execCtx.sessionId;
    const agent = sessionKey ? this.agentsService.get(sessionKey) : undefined;
    const def = this.toolsService?.get(toolName, agent);
    if (!def || def.pluginId !== pluginId)
      return { ok: false, error: 'Plugin tool unavailable: ' + toolName };
    const controller = new AbortController();
    const signal = execCtx.signal
      ? AbortSignal.any([controller.signal, execCtx.signal])
      : controller.signal;
    const key = pluginId + ':' + toolName;
    const timeoutMs = Math.max(1, Math.min(def.timeoutMs || 120000, 600000));
    const timer = setTimeout(
      () =>
        controller.abort(Object.assign(new Error('Plugin tool timed out'), { code: 'TIMEOUT' })),
      timeoutMs,
    );
    const callId = execCtx.callId || key + ':' + Math.random().toString(36).slice(2);
    const failure = (error) => ({
      isError: true,
      content: [{ type: 'text', text: error?.message || String(error) }],
      error: { code: error?.code || 'TOOL_ERROR', message: error?.message || String(error) },
    });
    let outcome;
    try {
      signal.throwIfAborted();
      validateArgs(def, args ?? {});
      if (this._activeTools.has(key) && !def.isConcurrencySafe?.(args ?? {}))
        throw Object.assign(new Error('The previous invocation is still running'), {
          code: 'TOOL_BUSY',
        });
      await this.ctx.sandboxPolicy.refresh();
      const task = execution.run(
        {
          ...execCtx,
          agent,
          cwd: execCtx.cwd || agent?.session.header.cwd,
          mode: agent?.mode,
          signal,
        },
        () =>
          this.toolsService.execute({
            name: toolName,
            arguments: args ?? {},
            callId,
            signal,
            ...(agent ? { agent } : {}),
          }),
      );
      const job = { pluginId, controller };
      const jobs = this._activeTools.get(key) || new Set();
      jobs.add(job);
      this._activeTools.set(key, jobs);
      task
        .finally(() => {
          jobs.delete(job);
          if (!jobs.size) this._activeTools.delete(key);
        })
        .catch(() => {});
      outcome = await abortable(task, signal);
    } catch (error) {
      outcome = failure(
        signal.aborted
          ? Object.assign(new Error(signal.reason?.message || 'Plugin tool cancelled'), {
              code: signal.reason?.code || 'CANCELLED',
            })
          : error,
      );
    } finally {
      clearTimeout(timer);
    }
    const blocks = Array.isArray(outcome.content) ? outcome.content : [];
    return {
      ok: !outcome.isError,
      content: blocks
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      contentBlocks: blocks,
      value: outcome.value,
      callId,
      meta: outcome.meta,
      ...(outcome.isError
        ? {
            error: outcome.error?.message || 'Plugin tool failed',
            code: outcome.error?.code || outcome.error?.info?.code || 'TOOL_ERROR',
            invalidArgs: (outcome.error?.code || outcome.error?.info?.code) === 'INVALID_ARGS',
          }
        : {}),
      ...(outcome.additionalContexts ? { additionalContexts: outcome.additionalContexts } : {}),
      ...(outcome.concludesTurn ? { concludesTurn: true } : {}),
    };
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Plugin tool cancelled'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

module.exports = { PluginHost, CibypToolsService };
