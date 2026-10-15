/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { atomic, read, record, RemoteError, ToolRegistry } = require('../../packages/remote');
const { createEventBus } = require('../main/core/event-bus');
const { createApiFacade } = require('../preload/api-facade');
const { createAgentRuntime } = require('../main/agent-runtime');
const { createBackendDispatch } = require('../main/core/backend-dispatch');
const { BackendServer } = require('../main/core/backend-server');

function merge(base, patch) {
  if (!record(patch)) throw new TypeError('Settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new TypeError('Invalid settings key');
    base[key] = record(value)
      ? merge(record(base[key]) ? base[key] : {}, value)
      : structuredClone(value);
  }
  return base;
}
function confinePath(root, value) {
  const canonical = (target) => {
    let existing = path.resolve(target),
      suffix = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new RemoteError('FORBIDDEN');
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
    return path.resolve(fs.realpathSync(existing), ...suffix);
  };
  const base = canonical(root),
    target = canonical(path.resolve(root, value));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new RemoteError('FORBIDDEN', 'Path is outside the session workspace');
  return target;
}

/** A real Node host. No Electron import, fake BrowserWindow, or desktop main entry. */
async function createNodeRuntime({
  dataDir,
  workspaceRoot,
  settings: initial = {},
  product,
  plugins = [],
  updateAdapter,
  lock = true,
} = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const ownership = lock
    ? await require('../main/core/instance-lock').acquireInstanceLock(dataDir, 'mini')
    : null;
  if (ownership && !ownership.acquired)
    throw new Error('This profile is already running; connect to its existing backend');
  try {
    let server, runtime, dispatch, disposeFacade, unpublish;
    const eventBus = createEventBus();
    const publish = (channel, value) => eventBus.publish(channel, value);
    const handlers = new Map(),
      subscriptions = new Map();
    const registry = {
      handle(channel, handler) {
        if (handlers.has(channel)) throw new Error('Duplicate host capability: ' + channel);
        handlers.set(channel, handler);
      },
    };
    const bind = (channel, fn) => registry.handle(channel, (_, ...args) => fn(...args));
    const bridge = {
      async invoke(channel, ...args) {
        const handler = handlers.get(channel);
        if (!handler)
          throw new RemoteError('CAPABILITY_UNAVAILABLE', 'Unavailable on this host: ' + channel);
        return handler({ sender: null }, ...args);
      },
      send(channel, ...args) {
        bridge
          .invoke(channel, ...args)
          .catch((error) => publish('host:error', { channel, message: error.message }));
      },
      on(channel, fn) {
        const off = eventBus.subscribe(channel, (payload) => fn({}, payload));
        subscriptions.set(fn, off);
      },
      off(_channel, fn) {
        subscriptions.get(fn)?.();
        subscriptions.delete(fn);
      },
      removeListener(channel, fn) {
        this.off(channel, fn);
      },
    };
    const file = (name) => path.join(dataDir, name + '.json');
    const defaults = require('../main/settings/defaults')({
      DEFAULT_DECISION_SETTINGS: require('../main/decision-service').DEFAULT_DECISION_SETTINGS,
    }).DEFAULT_SETTINGS;
    let settings = merge(merge(defaults, read(file('settings'), {})), initial);
    settings.runtime = { ...settings.runtime, location: 'host' };
    if (!initial.sessions?.maxConcurrent && !read(file('settings'), {}).sessions?.maxConcurrent)
      settings.sessions = { ...settings.sessions, maxConcurrent: 1 };
    const getSettings = () => settings;
    const extensions = require('./node-extensions').createNodeExtensions({
      dataDir,
      bind,
      bridge,
      eventBus,
      getRuntime: () => runtime,
      getSettings,
      publish,
      plugins,
    });
    const persistSettings = () => atomic(file('settings'), settings);
    const saveJSON = (name, value) => atomic(name, value);
    const loadJSON = (name, fallback) => read(name, fallback);
    const workspaceBase = path.resolve(workspaceRoot || path.join(dataDir, 'workspaces'));
    fs.mkdirSync(workspaceBase, { recursive: true });
    const historyDir = path.join(dataDir, 'history'),
      babeHistoryDir = path.join(dataDir, 'babe-history'),
      imagesDir = path.join(dataDir, 'images');
    for (const directory of [historyDir, babeHistoryDir, imagesDir])
      fs.mkdirSync(directory, { recursive: true });
    let getCodeHistoryDir;
    const history = require('../main/services/history')({
      path,
      fs,
      dataDir,
      imagesDir,
      historyDir,
      babeHistoryDir,
      loadJSON,
      saveJSON,
      getSettings,
      scheduleSettingsPersist: persistSettings,
      ipcMain: registry,
      getCodeHistoryDir: (...args) => getCodeHistoryDir(...args),
    });
    // Register the shared workspace/history services with explicit platform capabilities.
    ({ getCodeHistoryDir } = require('../main/ipc/workspaces')({
      ipcMain: registry,
      path,
      fs,
      getSettings,
      workspacesBaseDir: workspaceBase,
      app: { getPath: () => workspaceBase },
      vmService: { runtime: { location: 'host' } },
      dialog: {
        showOpenDialog: async () => {
          throw new RemoteError('CAPABILITY_UNAVAILABLE', 'Use workspace.bind on a remote client');
        },
      },
      getMainWindow: () => null,
      shell: {
        openPath: async () => {
          throw new RemoteError('CAPABILITY_UNAVAILABLE');
        },
      },
      hasDesktop: () => false,
      openDirectory: async () => ({ ok: false, error: 'No graphical environment' }),
      scheduleSettingsPersist: persistSettings,
      persistSettings,
      saveJSON,
      ...history,
    }));
    for (const action of ['list', 'get', 'save', 'delete', 'rename']) {
      bind('babeHistory:' + action, (...args) => {
        const id = action === 'save' ? args[0]?.id : args[0];
        const target = id
          ? require('../main/core/data-path').dataPath(babeHistoryDir, id, '.json')
          : null;
        if (action === 'list')
          return fs
            .readdirSync(babeHistoryDir)
            .filter((v) => v.endsWith('.json'))
            .map((v) => {
              const value = read(path.join(babeHistoryDir, v), {});
              return { id: v.slice(0, -5), title: value.title, updatedAt: value.updatedAt };
            });
        if (action === 'get') return read(target, null);
        if (action === 'save') atomic(target, args[0]);
        if (action === 'delete') fs.rmSync(target, { force: true });
        if (action === 'rename') {
          const value = read(target, null);
          if (value) atomic(target, { ...value, title: args[1] });
        }
        return { ok: true };
      });
    }
    const encoding = require('../main/file-encoding');
    require('../main/ipc/files')({ ipcMain: registry, fs, path, ...encoding });
    bind('fs:saveUploadedFile', (name, data) => {
      name = path.basename(String(name || '')).replace(/[\x00-\x1f:*?"<>|]/g, '_');
      if (!name || name === '.' || name === '..' || name.length > 240)
        throw new RemoteError('INVALID_PARAMS');
      let bytes;
      if (typeof data === 'string') {
        const match = /^data:[^;]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
        if (!match || match[1].length > 12 * 1024 * 1024) throw new RemoteError('INVALID_PARAMS');
        bytes = Buffer.from(match[1], 'base64');
      } else bytes = Buffer.from(data);
      if (bytes.length > 8 * 1024 * 1024) throw new RemoteError('PAYLOAD_TOO_LARGE');
      const directory = path.join(dataDir, 'attachments');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, crypto.randomUUID() + '_' + name);
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return { ok: true, path: target, name, isImage: /\.(png|jpe?g|gif|webp|avif)$/i.test(name) };
    });
    bind('filePicker:download', async (target) => {
      const stat = await fs.promises.stat(target);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new RemoteError('PAYLOAD_TOO_LARGE');
      return { ok: true, name: path.basename(target), bytes: await fs.promises.readFile(target) };
    });
    bind('settings:get', () => structuredClone(settings));
    bind('settings:set', (changes) => {
      const next = merge(structuredClone(settings), changes);
      if (next.runtime?.location !== 'host')
        throw new RemoteError('CAPABILITY_UNAVAILABLE', 'Mini executes on its host');
      atomic(file('settings'), next);
      settings = next;
      publish('settings:changed', settings);
      return { ok: true };
    });
    bind('theme:get', () => settings.theme);
    const frames =
      typeof CIBYP_AVATAR_FRAMES === 'undefined'
        ? Object.fromEntries(
            fs
              .readdirSync(path.join(__dirname, '../renderer/assets/avatar-frames'))
              .filter((name) => name.endsWith('.svg'))
              .map((name) => [
                path.basename(name, '.svg'),
                fs.readFileSync(
                  path.join(__dirname, '../renderer/assets/avatar-frames', name),
                  'utf8',
                ),
              ]),
          )
        : CIBYP_AVATAR_FRAMES;
    bind('avatar-frames:list', () => ({
      ok: true,
      frames: Object.keys(frames).map((id) => ({ id, file: id + '.svg' })),
    }));
    bind('avatar-frames:get', (id) =>
      typeof id === 'string' && Object.hasOwn(frames, id)
        ? { ok: true, content: frames[id] }
        : { ok: false },
    );
    bind('avatar:encodeFile', (source) => {
      try {
        if (typeof source !== 'string') return { ok: false };
        if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(source))
          return source.length <= 512 * 1024 ? { ok: true, dataUrl: source } : { ok: false };
        const target = confinePath(path.join(dataDir, 'avatars'), source);
        const stat = fs.statSync(target),
          mime = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
          }[path.extname(target).toLowerCase()];
        if (!mime || !stat.isFile() || stat.size > 384 * 1024) return { ok: false };
        return {
          ok: true,
          dataUrl: `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`,
        };
      } catch {
        return { ok: false };
      }
    });
    for (const [channel, action] of [
      ['status', 'status'],
      ['check', 'check'],
      ['start', 'download'],
      ['install', 'install'],
    ])
      bind('updates:' + channel, () => {
        if (!updateAdapter?.[action])
          throw new RemoteError(
            'CAPABILITY_UNAVAILABLE',
            'Updates are not configured for this host',
          );
        return updateAdapter[action]((value) => publish('updates:state', value));
      });
    bind('runtime:getLocation', () => ({ location: 'host' }));
    bind('app:startup-runtime', () => ({ ok: true, location: 'host' }));
    bind('app:is-no-tarot-build', () => false);
    bind('system:fullInfo', () => ({
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
    }));
    bind('system:info', () => ({ platform: process.platform, arch: process.arch }));
    bind('webControl:setWorkDir', () => null);
    const skills = require('../main/services/skill-store').createSkillStore({
      directory: path.join(dataDir, 'skills'),
      load: read,
      save: atomic,
      changed: () => publish('skills:changed', {}),
    });
    bind('skills:list', () => skills.list());
    bind('skills:create', (value) => skills.create(value));
    bind('skills:update', (id, value) => skills.update(id, value));
    bind('skills:delete', (id) => skills.remove(id));
    bind('tarot:draw', () => require('../main/tarot-tools').drawTarotCSPRNG());
    const todo = new (require('../main/services/todo-service').TodoService)({
      file: file('todos'),
      changed: (value) => publish('todo:state', value),
    });
    await todo.ready;
    bind('todo:get', () => todo.get());
    bind('todo:mutate', (args) => todo.mutate(args));
    const babe = new (require('../main/services/babe-relationship').BabeRelationship)({
      file: file('babe-relationship'),
      getSettings,
      publish,
    });
    for (const action of ['get', 'context', 'begin', 'complete', 'edit'])
      bind('babe-relationship:' + action, (...args) =>
        babe[action === 'get' ? 'snapshot' : action](...args),
      );
    const budget = require('../main/services/budget')({
      getSettings,
      calculateTokenCost: require('../shared/generated/pricing.cjs').calculateTokenCost,
    });
    const {
      DecisionService,
      normalizeDecisionSettings,
      DEFAULT_MODEL,
    } = require('../main/decision-service');
    const decision = new DecisionService({ getSettings, persistSettings });
    bind('decision:call', (p = {}) => {
      if (p.usage && !decision.enabledFor(p.usage)) return { ok: false, error: 'Usage disabled' };
      return decision.call(p.state, p.questions, { sessionKey: p.sessionKey });
    });
    for (const action of ['noul', 'choice', 'score'])
      bind('decision:' + action, (p) => {
        if (p.usage && !decision.enabledFor(p.usage))
          return { value: null, error: 'System One usage is disabled' };
        return action === 'noul'
          ? decision.noul(p.state, p.instructions, p)
          : decision[action](p.state, p.instructions, p.criteria, p);
      });
    bind('decision:models', () => decision.models());
    bind('decision:test', () => decision.test());
    bind('decision:status', () => {
      const config = normalizeDecisionSettings(settings.decision);
      return {
        ok: true,
        enabled: config.enabled,
        provider: config.provider,
        model: config.model || DEFAULT_MODEL[config.provider] || '',
        capabilities: config.capabilities,
        usages: config.usages,
        dailyMaxCalls: config.dailyMaxCalls,
      };
    });
    const llmRetry = require('../main/llm-retry'),
      reqLog = require('../main/req-log');
    const accounts = new (require('../main/services/chatgpt-accounts').ChatGPTAccounts)({
      file: file('accounts'),
      openExternal: async (url) => publish('account:login-url', { url }),
      onChange: (value) => publish('account:changed', value),
    });
    const claudeAccounts = require('../main/ipc/claude')({
      ipcMain: registry,
      dataDir,
      publishEvent: publish,
    });
    bind('llm:pluginProviders', async () => ({
      ok: true,
      providers: await extensions.models.providers(),
    }));
    const subscriptionUsage = require('../main/services/subscription-usage');
    const goUsage = new subscriptionUsage.GoUsage();
    bind('subscription:usage', async (options = {}) => {
      const settings = getSettings();
      const entry = settings.llm.pool?.find((e) => e.id === options.poolEntryId) || settings.llm;
      const provider = options.provider || entry.provider;
      const mode = subscriptionUsage.MODES.includes(settings.budget?.subscriptionDisplay)
        ? settings.budget.subscriptionDisplay
        : 'urgent';
      let result;
      const plugin = provider?.startsWith('dsh:')
        ? (await extensions.models.providers()).find((p) => p.id === provider)
        : null;
      const isSubscription =
        ['claude-subscription', 'chatgpt-codex', 'opencode-go'].includes(provider) ||
        plugin?.billingMode === 'subscription';
      if (!isSubscription) result = { ok: true, subscription: false, windows: [] };
      else if (mode === 'api-equivalent' && !options.includeWindows)
        result = { ok: true, windows: [] };
      else if (provider?.startsWith('dsh:'))
        result = await extensions.models.usage(provider, { force: options.force === true });
      else if (provider === 'claude-subscription') result = claudeAccounts.limits();
      else if (provider === 'chatgpt-codex')
        result = subscriptionUsage.normalizeCodex(await accounts.limits(options.force === true));
      else if (provider === 'opencode-go')
        result = await goUsage.read(entry.apiKey || '', options.force === true);
      else result = { ok: true, subscription: false, windows: [] };
      const value = {
        ...result,
        provider,
        mode,
        subscription: result.subscription !== false,
        selected: subscriptionUsage.selectWindow(result.windows || [], mode),
      };
      return {
        ...value,
        indicator: require('../shared/usage-indicator').formatUsage(value, settings.language),
      };
    });
    for (const [action, handler] of Object.entries({
      status: () => accounts.status(),
      login: (id) => accounts.login(id),
      cancel: () => {
        accounts.cancelLogin();
        return { ok: true };
      },
      switch: (id) => accounts.switchAccount(id),
      logout: (id) => accounts.logout(id),
      models: () => accounts.models(),
      limits: () => accounts.limits(),
    }))
      bind('chatgpt:' + action, handler);
    require('../main/ipc/llm')({
      path,
      fs,
      dataDir,
      loadJSON,
      ipcMain: registry,
      getSettings,
      LLMProviders: require('../main/llm-providers'),
      logTs: reqLog.ts,
      maskLogUrl: reqLog.maskUrl,
      logSnippet: reqLog.snippet,
      ...budget,
      normalizeMessagesForThinking: (messages) =>
        messages.map(({ metadata, ...message }) =>
          message.reasoning != null && message.reasoning_content === undefined
            ? { ...message, reasoning_content: message.reasoning, reasoning: undefined }
            : message,
        ),
      getMainWindow: () => null,
      publishEvent: publish,
      ...llmRetry,
      persistSettings,
      augmentRequest: (messages, options) => extensions.augment(messages, options),
      broadcastUsageChanged: () => publish('usage:changed', {}),
      ocHeaders: require('../main/opencode-headers'),
      chatGPTAccounts: accounts,
      claudeAccounts,
      pluginModels: extensions.models,
    });
    const memory = new (require('../main/services/automatic-memory').AutomaticMemory)({
      file: file('automatic-memory'),
      getSettings,
      publish,
      chat: (messages, options) => bridge.invoke('llm:chat', messages, options),
    });
    for (const action of ['list', 'edit', 'remove', 'recall', 'observe'])
      bind('automatic-memory:' + action, (...args) =>
        memory[action === 'list' ? 'snapshot' : action](...args),
      );
    const jobs = new (require('../main/services/shell-jobs').ShellJobs)({
      isVmOperation: () => false,
      getVmService: () => null,
      confine: (mode, cwd, argv) =>
        require('../main/sandbox-runner').confine(argv, { mode, workspaceRoot: cwd }),
    });
    bind('code:runShell', (...args) => jobs.run(...args));
    const mcp = require('../main/mcp-service')({
      ipcMain: registry,
      getSettings,
      persist: persistSettings,
      appVersion: product?.version || '0.1.0',
      getVmService: () => null,
      notifyRenderer: (value) => publish('mcp:servers-changed', value),
    });
    const terminals = require('../main/terminal-service')({
      ipcMain: registry,
      getMainWindow: () => null,
      getSettings,
      getVmService: () => null,
      publishEvent: publish,
      selectShellBinary: async () => {
        throw new RemoteError('CAPABILITY_UNAVAILABLE', 'Set terminal.customShellPath explicitly');
      },
    });
    const { api, dispose } = createApiFacade(bridge);
    disposeFacade = dispose;
    const supported = new Set([
      'bash',
      'str_replace_editor',
      'read',
      'edit',
      'readFile',
      'editFile',
      'multiEditFile',
      'createFile',
      'getFileEncodingInfo',
      'convertFileEncoding',
      'deleteFile',
      'moveFile',
      'copyFile',
      'listDirectory',
      'makeDirectory',
      'deleteDirectory',
      'runShellScriptCode',
      'makeTerminal',
      'runTerminalCommand',
      'awaitTerminalCommand',
      'killTerminal',
      'readTerminalOutput',
      'sendTerminalText',
      'pressTerminalKey',
      'askQuestions',
      'goalSet',
      'goalStatus',
      'goalComplete',
      'sleep',
    ]);
    for (const name of require('./node-tools').registerNodeTools({ bind, getSettings }))
      supported.add(name);
    for (const name of ['runSubAgent', 'sendAgentMessage', 'listSubAgents', 'interruptSubAgent'])
      supported.add(name);
    for (const name of [
      'listSkills',
      'makeSkill',
      'updateSkill',
      'deleteSkill',
      'activateSkill',
      'deactivateSkill',
      'automationList',
      'automationGetGuide',
      'automationCreate',
      'automationToggle',
      'automationRun',
      'automationTest',
      'automationDelete',
      'decisionModel',
    ])
      supported.add(name);
    runtime = createAgentRuntime({
      api,
      eventBus,
      getSettings,
      decorateAgent(agent) {
        agent.usesToolDiscovery = () => false;
        const schemas = agent.getRuntimeToolSchemas.bind(agent),
          execute = agent.executeTool.bind(agent);
        agent.getRuntimeToolSchemas = () => {
          return [
            ...schemas().filter(
              (t) => supported.has(t.function.name) || t.function.name.startsWith('mcp__'),
            ),
            ...extensions.schemas(agent),
          ];
        };
        agent.executeTool = async (name, args, invocation) => {
          if (!supported.has(name) && !/^(mcp__|ds__)/.test(name))
            return Promise.resolve({ ok: false, error: 'Capability unavailable on Mini: ' + name });
          if (/^(mcp__|ds__)/.test(name) && !(await agent.requestApproval(name, args)))
            return { ok: false, error: 'Extension action declined' };
          if (agent._sandboxMode() !== 'danger-full-access') {
            const readOnly =
              ['readFile', 'read', 'listDirectory', 'getFileEncodingInfo'].includes(name) ||
              (name === 'str_replace_editor' && args.command === 'view');
            if (
              agent._sandboxMode() === 'read-only' &&
              !readOnly &&
              /File|Directory|str_replace_editor|^edit$/.test(name)
            )
              return { ok: false, error: 'Read-only session' };
            const inspect = (value) => {
              if (!record(value)) return;
              for (const [key, item] of Object.entries(value)) {
                if (
                  ['path', 'source', 'destination', 'filePath'].includes(key) &&
                  typeof item === 'string'
                )
                  confinePath(agent.workspacePath, item);
                else if (Array.isArray(item)) item.forEach(inspect);
                else if (record(item)) inspect(item);
              }
            };
            try {
              inspect(args);
            } catch (error) {
              return { ok: false, error: error.message };
            }
          }
          return execute(name, args, invocation);
        };
      },
    });
    dispatch = createBackendDispatch({
      runtime,
      bridge,
      eventBus,
      storageDir: dataDir,
      shutdown: () => {
        setTimeout(() => publish('host:shutdown', {}), 100);
        return { ok: true };
      },
      product: product || { name: 'CIBYP Mini', version: '0.1.0-alpha.1' },
      bootState: () => ({ ready: true }),
    });
    dispatch.remote.register(
      'system.stop',
      'system.manage',
      () => {
        if (runtime.listSessions().some((s) => s.busy) || dispatch.remote.tools.active > 0)
          throw new RemoteError('RESOURCE_BUSY', 'Wait for active tasks before stopping Mini');
        setTimeout(() => publish('host:shutdown', {}), 100);
        return { ok: true };
      },
      { write: true },
    );
    bind('remote:invoke', async (method, params) => {
      const result = await dispatch.remote.handle(
        { jsonrpc: '2.0', id: crypto.randomUUID(), method, params },
        { id: 'local-owner', scopes: ['*'] },
      );
      return result.error
        ? { ok: false, error: result.error.message, reason: result.error.data?.reason }
        : { ok: true, result: result.result };
    });
    let mcpRevision = 0;
    const refreshMcp = async () => {
      const revision = ++mcpRevision;
      const result = await bridge.invoke('mcp:listTools');
      if (revision === mcpRevision)
        require('./index')
          .loadAgentCore()
          .toolsDef.registerMcpTools(result.tools || []);
    };
    const offMcp = eventBus.subscribe('mcp:servers-changed', () =>
      refreshMcp().catch((error) => publish('host:error', { message: error.message })),
    );
    const connections = (settings.mcp?.servers || [])
      .filter((s) => s.autoConnect)
      .map(async (s) => {
        const result = await mcp.startMcpServer(s);
        if (result?.ok === false) publish('host:error', { message: result.error });
      });
    Promise.allSettled(connections)
      .then(refreshMcp)
      .catch((error) => publish('host:error', { message: error.message }));
    let closing;
    function close() {
      return (closing ||= (async () => {
        await server?.stop();
        dispatch.remote.close();
        llmRetry.abortAllRequests();
        await extensions.close();
        clearTimeout(decision._persistTimer);
        persistSettings();
        accounts.dispose();
        claudeAccounts.dispose();
        terminals.abortTerminalsForSession('', true);
        offMcp();
        await mcp.stopAllMcpServers();
        for (const session of runtime.listSessions()) await runtime.close(session.key);
        await jobs.dispose();
        await memory.drain();
        history.flushPendingHistorySaves();
        disposeFacade?.();
        unpublish?.();
        ownership?.release();
      })());
    }
    return {
      runtime,
      api,
      eventBus,
      dispatch,
      tools: dispatch.remote.tools,
      devices: dispatch.remote.devices,
      dataDir,
      getSettings,
      async start({ host = '127.0.0.1', port = 12000, token, config = {} } = {}) {
        if (server) return server.address;
        if (!token || token.length < 32)
          throw new Error('A random access token of at least 32 characters is required');
        if (!['127.0.0.1', '::1', 'localhost'].includes(host))
          throw new Error('Bind to loopback; use an authenticated TLS or Tor reverse proxy');
        await extensions.start();
        server = new BackendServer({ dispatch, eventBus, token, config, ui: false });
        const address = await server.start({ host, port });
        unpublish = require('../main/core/backend-discovery').publishBackend(
          dataDir,
          address,
          token,
        );
        return address;
      },
      close,
    };
  } catch (error) {
    ownership?.release();
    throw error;
  }
}
module.exports = { createNodeRuntime, merge, confinePath };
