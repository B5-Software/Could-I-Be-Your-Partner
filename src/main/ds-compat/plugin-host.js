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
const { validateArgs } = require('./shims/dsh-tools');
const {
  CibypAgentsService,
  CibypSessionsService,
  CibypLlmService,
  CibypSandboxPolicyService,
  CibypApprovalService
} = require('./services');

/** Schemastery Config（模块级导出）校验：Schema 可调用，失败抛 ValidationError。 */
function validatePluginConfig(schema, config) {
  if (!schema) return config || {};
  if (typeof schema === 'function') return schema(config || {});
  if (schema && typeof schema['~standard']?.validate === 'function') {
    const res = schema['~standard'].validate(config || {});
    if (res && Array.isArray(res.issues) && res.issues.length) {
      throw new Error(res.issues.map((i) => i.message || String(i)).join('; '));
    }
    return (res && res.value !== undefined) ? res.value : (config || {});
  }
  return config || {};
}

// 当前正在挂载的插件身份（注册期同步标记，供 CibypToolsService.register 归属工具）
const hostContext = { pluginId: null, pluginName: null };

class CibypToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.tools = new Map(); // name → definition
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
    definition.pluginId = hostContext.pluginId || null;
    definition.pluginName = hostContext.pluginName || null;
    this.tools.set(definition.name, definition);
    return () => { if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name); };
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
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
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
        const child = spawn('/bin/sh', ['-c', command], {
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
    // 模块级 Config（Schemastery）：真实 DSH 宿主在 apply 前完成校验并合并默认值，
    // Cordis 只对“插件对象自带 Config”做校验，函数式插件因此必须由我们处理。
    let config = meta.config || {};
    if (mod && typeof mod === 'object' && typeof mod.Config === 'function') {
      try {
        config = validatePluginConfig(mod.Config, config);
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
      // apply 挂起保护：交互式 TUI 类插件（如 dsh-cc-tui）可能永不返回，
      // 超时后强制卸载纤维，避免阻塞启动/启用流程
      fiber = await Promise.race([
        this.ctx.plugin(plugin, config),
        new Promise((_, reject) => setTimeout(() => reject(new Error('apply 挂起超时（可能为交互式 TUI 插件）')), this.options.applyTimeoutMs || 30000).unref())
      ]);
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
    const injectNames = Array.isArray(inject)
      ? inject
      : (inject && typeof inject === 'object' ? Object.keys(inject) : []);
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

  async unloadPlugin(pluginId) {
    const fiber = this.fibers.get(pluginId);
    if (!fiber) return false;
    await fiber.dispose();
    this.fibers.delete(pluginId);
    return true;
  }

  async dispose() {
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
    const def = this.toolsService && this.toolsService.tools.get(toolName);
    if (!def || def.pluginId !== pluginId) {
      return { ok: false, error: `插件 ${pluginId} 未提供工具 ${toolName}` };
    }
    const validated = validateArgs(def, args || {});
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(def.timeoutMs || 120000, 600000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sessionKey = execCtx.sessionKey || execCtx.sessionId || null;
    // 真实 agent 代理：由渲染进程同步会话元数据，followup/inject 经 IPC 送进对应会话
    const liveAgent = (this.agentsService && sessionKey && this.agentsService.has(sessionKey))
      ? this.agentsService.get(sessionKey)
      : null;
    const exec = {
      signal: controller.signal,
      token: `${pluginId}:${toolName}:${Date.now().toString(36)}`,
      callId: execCtx.callId || `${pluginId}:${toolName}:${Math.random().toString(36).slice(2, 10)}`,
      sessionId: sessionKey,
      cwd: execCtx.cwd || null,
      sandboxMode: execCtx.sandboxMode || 'danger-full-access',
      agent: liveAgent || {
        inject: async () => { throw new Error('agent.inject 暂未在 CIBYP 桥接（缺少会话同步）'); }
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
