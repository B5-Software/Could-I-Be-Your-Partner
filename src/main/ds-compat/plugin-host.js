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

const { Context, Service, symbols } = require('@deepseek-ai/cordis');
const { pathToFileURL } = require('url');
const nodePath = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const sandboxRunner = require('../sandbox-runner');
const { validateArgs, validateJsonSchemaValue } = require('./shims/dsh-tools');
const {
  CibypAgentsService,
  CibypSessionsService,
  CibypLlmService,
  CibypSandboxPolicyService,
  CibypApprovalService
} = require('./services');

/** Schemastery Config（模块级导出）校验：Schema 可调用，失败抛 ValidationError。 */
async function validatePluginConfig(schema, config) {
  if (!schema) return config || {};
  if (typeof schema === 'function') return schema(config || {});
  if (schema && typeof schema['~standard']?.validate === 'function') {
    const res = await schema['~standard'].validate(config || {});
    if (res && Array.isArray(res.issues) && res.issues.length) {
      throw new Error(res.issues.map((i) => i.message || String(i)).join('; '));
    }
    return (res && res.value !== undefined) ? res.value : (config || {});
  }
  return config || {};
}

// 当前正在挂载的插件身份（注册期同步标记，供 CibypToolsService.register 归属工具）
const hostContext = { pluginId: null, pluginName: null };
const PLUGIN_OWNER = Symbol('cibyp.plugin.owner');

class CibypToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.tools = new Map(); // name → definition
    this.guards = new Map();
  }

  /** DSH 工具面板/审计插件读取工具面的形状（dsh-context-doctor 等会调用）。 */
  schemas() {
    const out = [];
    for (const def of this.tools.values()) {
      out.push({
        name: def.name,
        description: def.description || '',
        parameters: def.parameters || { type: 'object', properties: {} }
      });
    }
    return out;
  }

  register(definition) {
    if (!definition || typeof definition.name !== 'string') {
      throw new Error('tool definition requires a name');
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`duplicate tool registration: ${definition.name}`);
    }
    const owner = this.ctx[PLUGIN_OWNER] || hostContext;
    const registered = { ...definition, pluginId: owner.pluginId || null, pluginName: owner.pluginName || null };
    return this.ctx.effect(() => {
      this.tools.set(registered.name, registered);
      this.ctx.emit('tools/change');
      return () => {
        if (this.tools.get(registered.name) === registered) this.tools.delete(registered.name);
        this.ctx.emit('tools/change');
      };
    });
  }

  registerGuard(guard) {
    if (typeof guard !== 'function') throw new TypeError('tools.registerGuard requires a function');
    const owner = this.ctx[PLUGIN_OWNER] || hostContext;
    return this.ctx.effect(() => {
      this.guards.set(guard, owner.pluginId);
      return () => this.guards.delete(guard);
    });
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
    this._opLock.set(pluginId, next.then(() => {}, () => {}));
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
    await this.ctx.plugin(CibypToolsService);
    this.toolsService = this.ctx.tools;
    // 桥接 seams：skills / settings / sandbox 提供可用实现，其余 stub
    // skills 桥：由宿主注入真实技能清单 provider（惰性求值），
    // 未注入时返回空列表，保证插件可加载。
    const skillsProvider = this.options.skills || null;
    await this.ctx.plugin(class SkillsBridge extends Service {
      constructor(c) {
        super(c, 'skills');
        this.provider = skillsProvider;
        this.list = async (opts = {}) => {
          if (!this.provider) return [];
          try {
            const s = this.provider();
            return await s.list(opts || {});
          } catch { return []; }
        };
        this.get = async (name, opts = {}) => {
          if (!this.provider) throw new Error('skills 未在 CIBYP 桥接');
          return await this.provider().get(name, opts || {});
        };
        this.register = () => () => {};
      }
    });
    // 只读 fs seam：resolve/stat/readText/listDir/processPath（dsh-context-doctor、
    // dsh-test-runner 等插件运行时依赖）。插件本就在主进程内运行，可自行 require('fs')，
    // 这里提供 DSH 形状的便捷 API，行为等价、不额外扩大权限面。
    await this.ctx.plugin(class FsBridge extends Service {
      constructor(c) {
        super(c, 'fs');
      }
      assertNotAborted(signal) {
        if (signal && signal.aborted) throw new Error('aborted');
      }
      async resolve(target, opts = {}) {
        const p = String(target || '.');
        return nodePath.isAbsolute(p)
          ? nodePath.normalize(p)
          : nodePath.resolve(opts && opts.cwd ? opts.cwd : process.cwd(), p);
      }
      async stat(target, signal) {
        this.assertNotAborted(signal);
        const st = await fsp.stat(target);
        return {
          size: st.size,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          mtimeMs: st.mtimeMs
        };
      }
      async readText(target, signal) {
        this.assertNotAborted(signal);
        return await fsp.readFile(target, 'utf8');
      }
      async listDir(target, signal) {
        this.assertNotAborted(signal);
        const entries = await fsp.readdir(target, { withFileTypes: true });
        return entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other'
        }));
      }
      processPath(target) {
        const rel = nodePath.relative(process.cwd(), target);
        return rel && !rel.startsWith('..') && !nodePath.isAbsolute(rel) ? rel : target;
      }
    });
    // 一次性 shell seam：resolve(request) → run(spec)，供 dsh-test-runner 等
    // 结构化命令插件使用（带超时/取消/输出上限）。
    await this.ctx.plugin(class ShellBridge extends Service {
      constructor(c) {
        super(c, 'shell');
      }
      resolve(request) {
        const req = request || {};
        return {
          command: String(req.command || ''),
          cwd: req.workdir || process.cwd(),
          timeoutMs: Math.max(1000, Math.min(Number(req.timeoutMs) || 120000, 600000)),
          stdoutMaxBytes: Math.max(1024, Number(req.stdoutMaxBytes) || 1048576),
          signal: req.signal || null
        };
      }
      async run(spec) {
        const out = {
          exitCode: null,
          stdout: { text: '' },
          stderr: { text: '' },
          timedOut: false,
          aborted: false
        };
        const command = String(spec && spec.command ? spec.command : '');
        if (!command) return out;
        const cwd = (spec && spec.cwd) || process.cwd();
        const timeoutMs = Math.max(1000, Math.min(Number(spec && spec.timeoutMs) || 120000, 600000));
        const maxBytes = Math.max(1024, Number(spec && spec.stdoutMaxBytes) || 1048576);
        const signal = spec && spec.signal;
        const isWin = process.platform === 'win32';
        const child = spawn(isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let killed = false;
        const kill = () => {
          if (killed) return;
          killed = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        };
        const onAbort = () => {
          out.aborted = true;
          kill();
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const timer = setTimeout(() => {
          out.timedOut = true;
          kill();
        }, timeoutMs);
        try {
          await new Promise((resolvePromise) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (signal) signal.removeEventListener('abort', onAbort);
              resolvePromise();
            };
            child.stdout.on('data', (d) => {
              if (stdout.length < maxBytes) stdout += d.toString('utf8');
            });
            child.stderr.on('data', (d) => {
              if (stderr.length < maxBytes) stderr += d.toString('utf8');
            });
            child.on('error', (e) => {
              if (stderr.length < maxBytes) stderr += String(e.message || e);
              out.exitCode = 1;
              finish();
            });
            child.on('close', (code) => {
              out.exitCode = code;
              finish();
            });
          });
        } catch (e) {
          out.exitCode = 1;
          if (!out.stderr.text) out.stderr.text = String(e.message || e);
        }
        out.stdout.text = stdout.slice(0, maxBytes);
        out.stderr.text = stderr.slice(0, maxBytes);
        return out;
      }
    });
    await this.ctx.plugin(class SettingsBridge extends Service {
      constructor(c) {
        super(c, 'settings');
        this.get = async () => ({});
        this.update = async () => { throw new Error('settings 能力暂未在 CIBYP 桥接'); };
      }
    });
    // systemPrompt：收集插件追加的提示词节（尚未接入渲染层提示词装配，
    // 提供该 seam 使 dsh-monitor 等插件能正常加载；工具 schema 已含使用说明）。
    await this.ctx.plugin(class SystemPromptBridge extends Service {
      constructor(c) {
        super(c, 'systemPrompt');
        this.sections = [];
      }
      section(entry) {
        if (entry && typeof entry === 'object') this.sections.push(entry);
      }
    });
    // agents / sessions / llm / sandboxPolicy / approval：
    // DeepSeek 服务 API → CIBYP 功能翻译层（见 ./services.js）。
    const serviceConfig = {
      transport: this.options.transport || null,
      getSettings: this.options.getSettings || (async () => ({}))
    };
    await this.ctx.plugin(class AgentsBridge extends CibypAgentsService {
      constructor(c) { super(c, serviceConfig); }
    });
    this.agentsService = this.ctx.agents;
    const agentsServiceRef = this.agentsService;
    await this.ctx.plugin(class SessionsBridge extends CibypSessionsService {
      constructor(c) { super(c, { agents: agentsServiceRef }); }
    });
    await this.ctx.plugin(class LlmBridge extends CibypLlmService {
      constructor(c) { super(c, serviceConfig); }
    });
    await this.ctx.plugin(class SandboxPolicyBridge extends CibypSandboxPolicyService {
      constructor(c) { super(c, serviceConfig); }
    });
    await this.ctx.plugin(class ApprovalBridge extends CibypApprovalService {
      constructor(c) { super(c, serviceConfig); }
    });
    // webServer：插件自带 HTTP 面板暂不接入 CIBYP WebUI。
    await this.ctx.plugin(class WebServerBridge extends Service {
      constructor(c) {
        super(c, 'webServer');
        this.register = () => () => {};
      }
    });
    await this.ctx.plugin(class SandboxBridge extends Service {
      constructor(c) {
        super(c, 'sandbox');
        this.confine = (argv, policy) => sandboxRunner.confine(argv, policy);
      }
    });
    for (const name of ['subprocess', 'jobs', 'subagent', 'session', 'storage', 'compaction']) {
      const serviceKey = name;
      await this.ctx.plugin(class Bridge extends Service {
        constructor(c) {
          super(c, serviceKey);
        }
      });
    }
    this.initialized = true;
  }

  async _importEntry(entryPath) {
    const resolved = nodePath.resolve(entryPath);
    try {
      // ESM 模块缓存按 URL 缓存：插件更新后同一路径会命中旧模块。
      // 追加文件 mtime 作为 query，强制重新加载最新代码。
      let mtime = Date.now();
      try { mtime = (await fsp.stat(resolved)).mtimeMs; } catch { /* ignore */ }
      return await import(`${pathToFileURL(resolved).href}?t=${Math.floor(mtime)}`);
    } catch (e) {
      // 回退 CJS require（部分插件发布为 commonjs）
      try { delete require.cache[require.resolve(resolved)]; } catch { /* ignore */ }
      try { return require(resolved); }
      catch { throw e; }
    }
  }

  _toPlugin(mod, pluginId) {
    const isServiceClass = (fn) => fn && typeof fn === 'function' && fn.prototype instanceof Service;
    const attachMeta = (fn, name, inject) => {
      try {
        Object.defineProperty(fn, 'name', { value: name || pluginId, configurable: true });
        if (inject) Object.defineProperty(fn, 'inject', { value: inject, configurable: true });
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
  loadPlugin(pluginId, entryPath, meta = {}) {
    return this._serialize(pluginId, () => this._loadPlugin(pluginId, entryPath, meta));
  }

  async _loadPlugin(pluginId, entryPath, meta = {}) {
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
    let plugin;
    try { plugin = this._toPlugin(mod, pluginId); }
    catch (error) { this.issues.get(pluginId).push(error.message); return { tools: [], issues: this.issues.get(pluginId).slice() }; }
    // Context ownership survives delayed registration and dependency activation.
    // Do not mutate the plugin's definition or rely on a global async identity.
    const identity = { pluginId, pluginName: meta.name || pluginId };
    const original = plugin;
    if (typeof original === 'function' && original.prototype instanceof Service) {
      plugin = class extends original {
        constructor(ctx, config) { ctx[PLUGIN_OWNER] = identity; super(ctx, config); }
      };
    } else if (typeof original === 'function') {
      plugin = (ctx, config) => { ctx[PLUGIN_OWNER] = identity; return original(ctx, config); };
    } else {
      plugin = { ...original, apply(ctx, config) { ctx[PLUGIN_OWNER] = identity; return original.apply(ctx, config); } };
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
      plugin.inject = ['tools', 'skills', 'fs', 'shell', 'settings', 'agents', 'sessions',
        'llm', 'sandboxPolicy', 'approval', 'sandbox', 'webServer', 'jobs', 'storage', 'compaction']
        .filter(name => this.ctx.reflect._getImpl(name, true));
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
    hostContext.pluginId = pluginId;
    hostContext.pluginName = meta.name || pluginId;
    const before = new Set(this.toolsService.tools.keys());
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
      } catch { /* ignore */ }
      // apply 挂起保护：交互式 TUI 类插件（如 dsh-cc-tui）可能永不返回，
      // 超时后强制卸载纤维，避免阻塞启动/启用流程
      const applyTimeout = meta.applyTimeoutMs || this.options.applyTimeoutMs || 30000;
      let applyTimer;
      try {
        fiber = await Promise.race([
          this.ctx.plugin(plugin, config),
          new Promise((_, reject) => { applyTimer = setTimeout(() => reject(new Error('apply 挂起超时（可能为交互式 TUI 插件）')), applyTimeout); applyTimer.unref(); })
        ]);
      } finally { clearTimeout(applyTimer); }
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
      } catch { /* ignore */ }
      for (const f of candidates) {
        try {
          await Promise.race([
            f.dispose(),
            new Promise((r) => setTimeout(r, 1200).unref())
          ]);
        } catch { /* ignore */ }
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
        } catch { /* ignore */ }
      }
      // 失败后彻底移除该插件可能残留的工具注册
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
    const injectNames = Array.isArray(inject) ? inject : (inject && typeof inject === 'object' ? Object.keys(inject) : []);
    const missing = injectNames.filter((name) => !this.ctx.reflect._getImpl(name, true));
    if (missing.length) {
      this.issues.get(pluginId).push(`缺少宿主服务注入: ${missing.join(', ')}（插件保持休眠，未注册工具）`);
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

  unloadPlugin(pluginId) {
    return this._serialize(pluginId, async () => {
      for (const jobs of this._activeTools.values()) for (const job of jobs) if (job.pluginId === pluginId) job.controller.abort(new Error('Plugin unloaded'));
      const fiber = this.fibers.get(pluginId);
      if (fiber) {
        await Promise.race([
          fiber.dispose(),
          new Promise((r) => setTimeout(r, 1500).unref())
        ]);
        this.fibers.delete(pluginId);
      }
      // 清除该插件注册的工具：更新/重装后旧工具定义不得残留在工具注册表
      if (this.toolsService) {
        for (const [name, def] of [...this.toolsService.tools.entries()]) {
          if (def.pluginId === pluginId) this.toolsService.tools.delete(name);
        }
        for (const [guard, owner] of this.toolsService.guards) if (owner === pluginId) this.toolsService.guards.delete(guard);
      }
      return true;
    });
  }

  async dispose() {
    for (const jobs of this._activeTools.values()) for (const job of jobs) job.controller.abort(new Error('Plugin host disposed'));
    for (const fiber of this.fibers.values()) {
      try {
        await Promise.race([
          fiber.dispose(),
          new Promise((r) => setTimeout(r, 1500).unref())
        ]);
      } catch { /* ignore */ }
    }
    this.fibers.clear();
    try {
      await Promise.race([
        this.ctx.fiber.dispose(),
        new Promise((r) => setTimeout(r, 1500).unref())
      ]);
    } catch { /* ignore */ }
  }

  /**
   * 执行插件工具（CIBYP executeTool 的 ds__ 路由落点）。
   */
  async callTool(pluginId, toolName, args, execCtx = {}) {
    const def = this.toolsService?.tools.get(toolName);
    if (!def || def.pluginId !== pluginId) return { ok: false, error: 'Plugin tool unavailable: ' + toolName };
    const key = pluginId + ':' + toolName;
    const controller = new AbortController();
    const signal = execCtx.signal ? AbortSignal.any([controller.signal, execCtx.signal]) : controller.signal;
    const timeoutMs = Math.max(1, Math.min(def.timeoutMs || 120000, 600000));
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Plugin tool timed out'), { code: 'TIMEOUT' })), timeoutMs);
    const sessionKey = execCtx.sessionKey || execCtx.sessionId || null;
    const liveAgent = this.agentsService && sessionKey && this.agentsService.has(sessionKey) ? this.agentsService.get(sessionKey) : null;
    const exec = { signal };
    const identity = {
      name: toolName, arguments: args ?? {}, token: Symbol(key),
      callId: execCtx.callId || key + ':' + Math.random().toString(36).slice(2),
      sessionId: sessionKey, cwd: execCtx.cwd || null,
      sandboxMode: execCtx.sandboxMode || 'danger-full-access',
      agent: liveAgent || { inject: async () => { throw new Error('Agent session is not synchronized'); } },
    };
    for (const [name, value] of Object.entries(identity)) Object.defineProperty(exec, name, { value, enumerable: true });
    const failure = (error, code = error?.code || 'TOOL_ERROR') => ({
      isError: true, content: [{ type: 'text', text: error?.message || String(error) }],
      error: { code, message: error?.message || String(error) },
    });
    const render = async (value) => {
      if (def.output?.schema) {
        const errors = validateJsonSchemaValue(def.output.schema, value, 'output');
        if (errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'INVALID_OUTPUT' });
      }
      const content = def.output?.render ? await def.output.render(exec.arguments, value)
        : [{ type: 'text', text: typeof value === 'string' ? value : safeStringify(value) }];
      if (!Array.isArray(content)) throw new TypeError('Tool output.render must return content blocks');
      return content;
    };
    let outcome;
    try {
      signal.throwIfAborted();
      validateArgs(def, exec.arguments);
      if (this._activeTools.has(key) && !def.isConcurrencySafe?.(exec.arguments))
        throw Object.assign(new Error('The previous invocation is still running'), { code: 'TOOL_BUSY' });
      const task = (async () => {
        const decision = await this.ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
        if (!decision || !['allow', 'deny', 'cancel', 'ask'].includes(decision.kind)) throw new Error('Invalid tools/pre-execute decision');
        if (decision.kind === 'deny') return failure(new Error(decision.reason || 'Tool denied'), 'TOOL_DENIED');
        if (decision.kind === 'cancel') return failure(new Error('Tool cancelled'), 'CANCELLED');
        if (decision.kind === 'ask') {
          const answer = await this.ctx.approval.request({ ...decision, agent: exec.agent, toolName, callId: exec.callId, signal });
          if (answer !== true && answer?.approved !== true) return failure(new Error('Tool approval declined'), 'TOOL_DENIED');
        }
        for (const guard of this.toolsService.guards.keys()) {
          const reason = guard(exec);
          if (reason) return failure(new Error(String(reason)), 'TOOL_DENIED');
        }
        signal.throwIfAborted();
        let result = await this.ctx.waterfall('tools/execute', exec, async () => {
          try {
            const fusedSignal = AbortSignal.any([signal, exec.signal]);
            const value = await def.execute(exec.arguments, { ...exec, signal: fusedSignal });
            signal.throwIfAborted();
            return { isError: false, value, content: await render(value),
              ...(def.output?.presentationMeta ? { meta: await def.output.presentationMeta(exec.arguments, value) } : {}) };
          } catch (error) { return failure(error); }
        });
        if (!result || typeof result.isError !== 'boolean') throw new Error('Invalid tools/execute result');
        signal.throwIfAborted();
        const post = await this.ctx.waterfall('tools/post-execute', exec, Object.freeze(result), async () => ({ kind: 'accept' }));
        if (post?.kind === 'block') result = { isError: true, content: post.feedback || [], error: { code: 'TOOL_BLOCKED', message: 'Tool result blocked' } };
        else if (post?.kind === 'accept') {
          if ('value' in post && 'content' in post) throw new Error('Cannot replace both value and content');
          if ('value' in post) {
            if (result.isError) throw new Error('Cannot replace the value of a failed result');
            result = { ...result, value: post.value, content: await render(post.value) };
          } else if ('content' in post) result = { ...result, content: post.content };
          if (post.additionalContexts) result = { ...result, additionalContexts: post.additionalContexts };
        } else throw new Error('Invalid tools/post-execute decision');
        if (def.finalizeContent) {
          const content = await def.finalizeContent(Object.freeze({ ...exec, signal }), Object.freeze(result));
          if (content !== undefined) result = { ...result, content };
        }
        signal.throwIfAborted();
        return result;
      })();
      const job = { pluginId, controller };
      const jobs = this._activeTools.get(key) || new Set();
      jobs.add(job);
      this._activeTools.set(key, jobs);
      task.finally(() => { jobs.delete(job); if (!jobs.size) this._activeTools.delete(key); }).catch(() => {});
      outcome = await abortable(task, signal);
    } catch (error) { outcome = failure(error, signal.aborted ? signal.reason?.code || 'CANCELLED' : error?.code); }
    finally { clearTimeout(timer); }
    // Observers cannot turn a successful execution into a failure.
    try { await abortable(this.ctx.parallel('tools/result', Object.freeze({ ...exec, signal }), Object.freeze(outcome)), AbortSignal.timeout(1000)); }
    catch (error) { this.ctx.logger.warn('tools/result observer failed: ' + error.message); }
    const blocks = Array.isArray(outcome.content) ? outcome.content : [];
    return {
      ok: !outcome.isError, content: blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n'),
      contentBlocks: blocks, value: outcome.value, callId: exec.callId, meta: outcome.meta,
      ...(outcome.isError ? { error: outcome.error?.message || 'Plugin tool failed', code: outcome.error?.code,
        invalidArgs: outcome.error?.code === 'INVALID_ARGS' } : {}),
      ...(outcome.additionalContexts ? { additionalContexts: outcome.additionalContexts } : {}),
    };
  }
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Plugin tool cancelled'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

module.exports = { PluginHost, CibypToolsService };
