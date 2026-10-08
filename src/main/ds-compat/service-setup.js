/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Service } = require('@deepseek-ai/cordis');
const {
  SystemPrompt,
  renderPrompt,
  joinContextSections,
} = require('@deepseek-ai/dsh-system-prompt');
const { SkillRegistry } = require('@deepseek-ai/dsh-skill');
const { Storage } = require('@deepseek-ai/dsh-storage');
const json = require('@deepseek-ai/dsh-storage-json');
const domain = require('@deepseek-ai/dsh-storage-domain');
const { LocalJobRegistry } = require('@deepseek-ai/dsh-jobs-local');
const { WebRuntime } = require('@deepseek-ai/dsh-web');
const { CommandRuntime } = require('@deepseek-ai/dsh-commands');
const { UserQuestionService } = require('@deepseek-ai/dsh-user-questions');
const { TerminalSessionService } = require('@deepseek-ai/dsh-terminal');
const { CibypFileSystem } = require('./filesystem');
const { CibypSubprocess, CibypShell } = require('./process');
const { CibypLlmService } = require('./llm');
const { CibypSettings } = require('./settings');
const { CibypAgentsService, CibypSessionsService } = require('./agents');
const { CibypSandboxPolicyService, CibypApprovalService } = require('./services');
const sandbox = require('../sandbox-runner');

function mount(ctx, Implementation, options) {
  class Bridge extends Implementation {
    constructor(c) {
      super(c, options);
    }
  }
  return ctx.plugin(Bridge);
}
async function setupServices(host, ToolsService) {
  const ctx = host.ctx;
  const temporary =
    !host.options.dataDir && fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-plugin-host-'));
  const options = { ...host.options, dataDir: host.options.dataDir || temporary };
  if (temporary)
    ctx.effect(() => () => fs.promises.rm(temporary, { recursive: true, force: true }));
  await mount(ctx, CibypFileSystem, options);
  await mount(ctx, CibypSubprocess, options);
  await mount(ctx, CibypShell, options);
  await ctx.plugin(require('@deepseek-ai/dsh-shell-env').ShellEnvRegistry, {
    dshHome: path.join(options.dataDir, 'plugin-home'),
  });
  await mount(ctx, CibypSettings, options);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolsService);
  host.toolsService = ctx.tools;
  await ctx.plugin(SkillRegistry, {});
  if (options.skills)
    ctx.skills.registerProvider(() => ({
      name: 'cibyp',
      async list(lookup) {
        lookup.signal?.throwIfAborted();
        return (await options.skills().list(lookup)).map((skill) => ({
          ...skill,
          invocation: skill.invocation || { modelInvocable: true, userInvocable: true },
          provider: 'cibyp',
          rank: 100,
          locator: skill.name,
        }));
      },
      async get(candidate, lookup) {
        lookup.signal?.throwIfAborted();
        const skill = await options.skills().get(candidate.locator, lookup);
        return skill
          ? { ...candidate, ...skill, invocation: candidate.invocation, provider: 'cibyp' }
          : undefined;
      },
    }));
  await mount(ctx, CibypAgentsService, options);
  host.agentsService = ctx.agents;
  await mount(ctx, require('./persistence').CibypPersistence, options);
  await mount(ctx, CibypSessionsService, { ...options, agents: host.agentsService });
  await ctx.plugin(require('@deepseek-ai/dsh-session-projection').SessionProjectionRegistry);
  require('./projections').setupProjections(ctx);
  await ctx.plugin(require('./session-query').CibypSessionQuery);
  await mount(ctx, CibypLlmService, options);
  await ctx.llm.refreshRoutes();
  await ctx.plugin(require('@deepseek-ai/dsh-token-meter').default, {});
  await ctx.plugin(require('@deepseek-ai/dsh-attachment-local').default, {
    dshHome: path.join(options.dataDir, 'plugin-home'),
  });
  await mount(ctx, require('./language').CibypLanguage, options);
  await mount(ctx, CibypSandboxPolicyService, options);
  await ctx.sandboxPolicy.refresh();
  await mount(ctx, CibypApprovalService, options);
  await ctx.plugin(Storage);
  await ctx.plugin(json, { root: path.join(options.dataDir, 'plugin-storage') });
  await ctx.plugin(domain, { backend: 'json', routes: {} });
  await ctx.plugin(require('@deepseek-ai/dsh-workspace').default);
  await ctx.plugin(LocalJobRegistry, {});
  // CIBYP itself offers background-job control; no foreign tool panel is required.
  ctx.jobs.attachController('cibyp');
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(TerminalSessionService);
  await ctx.plugin(UserQuestionService);
  ctx.on('user-questions/request', async (request) => {
    if (!options.transport?.request) throw new Error('CIBYP question backend is unavailable');
    const result = await options.transport.request(
      'ds:questionsRequest',
      {
        sessionKey: request.agent?.id,
        questions: request.questions.map((question) => ({
          ...question,
          multiple: question.multi_select,
        })),
        callId: request.callId,
      },
      undefined,
      request.signal,
    );
    const answers = result?.answers || [];
    return {
      answers: request.questions.map((question, index) => {
        const value = answers.find((answer) => answer?.id === question.id) || answers[index];
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Array.isArray(value.selected)
        )
          return value;
        const labels = question.options?.map((option) => option.label) || [];
        const selected = (Array.isArray(value) ? value : [value]).filter((value) =>
          labels.includes(value),
        );
        const custom = (Array.isArray(value) ? value : [value])
          .filter((value) => typeof value === 'string' && !labels.includes(value))
          .join('\n');
        return { id: question.id, selected, ...(custom ? { custom } : {}) };
      }),
    };
  });
  await ctx.plugin(WebRuntime, { searchProvider: 'cibyp', fetchProvider: 'cibyp' });
  ctx.web.registerSearchProvider({
    id: 'cibyp',
    available: () => !!options.invoke,
    async search(request, signal) {
      signal?.throwIfAborted();
      const result = await options.invoke('web:search', { ...request, limit: request.maxResults });
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.error);
      return {
        content: result.content || result.text,
        sources: result.results || result.sources || [],
        truncated: result.truncated === true,
      };
    },
  });
  ctx.web.registerFetchProvider({
    id: 'cibyp',
    available: () => !!options.invoke,
    async fetch(request, signal) {
      signal?.throwIfAborted();
      const result = await options.invoke('web:fetch', request);
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.error);
      return {
        url: result.url || request.url,
        statusCode: result.statusCode || result.status || 200,
        body: { kind: 'text', content: result.content || result.text || '' },
        truncated: result.truncated === true,
      };
    },
  });
  await ctx.plugin(
    class SandboxBridge extends Service {
      constructor(c) {
        super(c, 'sandbox');
        this.confine = (argv, policy) => sandbox.confine(argv, policy);
      }
    },
  );
  // Register additional capability translators, never a foreign agent loop or UI.
  await require('./auxiliary-services').setupAuxiliaryServices(host, options);
  const { BashTerminalBackend, Config } = require('@deepseek-ai/dsh-terminal-bash');
  ctx.terminals.registerBackend({
    type: 'shell',
    async spawn(spec) {
      const shell = require('../core/terminal-shell').resolveHostShell(
        (await options.getSettings?.()) || {},
      );
      const pwsh = /(?:powershell|pwsh)(?:\.exe)?$/i.test(shell.file);
      if (!pwsh && !/(?:bash|zsh|sh)(?:\.exe)?$/i.test(shell.file))
        throw new Error('Persistent DS terminals require a Bash-compatible shell or PowerShell');
      const config = Config({
        shellPath: shell.file,
        shellArgs: shell.args.length ? shell.args : pwsh ? ['-NoLogo', '-NoProfile'] : ['-i'],
        shellDialect: pwsh ? 'pwsh' : 'bash',
      });
      return new BashTerminalBackend(ctx, config).spawn(spec);
    },
  });
}
async function augmentRequest(host, messages, options = {}) {
  if (!host.initialized || options.cibypPluginPromptApplied) return { messages, options };
  const agent = host.agentsService.get(options.sessionKey);
  // Titles, tool selection and other auxiliary model calls must not open an
  // Agent turn or consume its plugin inbox. Only the real loop marks steps.
  if (agent && !options.cibypAgentStep) return { messages, options };
  const admitted = agent
    ? await host.agentsService.beforeRequest(agent, messages, options)
    : { messages, options };
  messages = admitted.messages;
  options = admitted.options;
  const assembly = await require('./execution-context').bounded(
    host.ctx.systemPrompt.assemble({ agent, scope: agent }),
    options.signal,
    'Plugin prompt assembly',
  );
  const prompt = renderPrompt(assembly),
    context = joinContextSections(assembly.contexts);
  const out = messages.map((m) => ({ ...m }));
  if (prompt) {
    const leading = out.find((m) => m.role === 'system');
    if (leading)
      leading.content =
        typeof leading.content === 'string'
          ? leading.content + '\n\n' + prompt
          : [...leading.content, { type: 'text', text: prompt }];
    else out.unshift({ role: 'system', content: prompt });
  }
  // Dynamic contributions are request-only; they never replace chat history.
  if (context) out.push({ role: 'user', content: context });
  const allowed = new Set((options.tools || []).map((tool) => tool.function?.name));
  const allowedPlugins = new Set(
    [...host.ctx.tools.registrations]
      .filter((def) => allowed.has(`ds__${def.pluginId}__${def.name}`))
      .map((def) => def.pluginId),
  );
  const toolSchemas = assembly.tools.filter((tool) => {
    const def = host.ctx.tools.get(tool.name, agent);
    return (
      def?.pluginId &&
      (allowed.has(`ds__${def.pluginId}__${tool.name}`) ||
        (allowedPlugins.has(def.pluginId) && !host.ctx.tools.tools.has(tool.name)))
    );
  });
  const aliases = toolSchemas.map((tool) => [
    tool.name,
    `ds__${host.ctx.tools.get(tool.name, agent).pluginId}__${tool.name}`,
  ]);
  // Namespace at the model boundary; preserve SDK names inside plugins.
  const tools = Array.isArray(options.tools)
    ? [
        ...options.tools.filter((tool) => !tool.function?.name?.startsWith('ds__')),
        ...toolSchemas.map((tool, i) => ({
          type: 'function',
          function: { ...tool, name: aliases[i][1] },
        })),
      ]
    : options.tools;
  if (aliases.length && Array.isArray(options.tools))
    out.push({
      role: 'system',
      content:
        'Plugin tool names in instructions map to these callable names:\n' +
        aliases.map(([original, wire]) => `${original} → ${wire}`).join('\n'),
    });
  return { messages: out, options: { ...options, tools, cibypPluginPromptApplied: true } };
}
module.exports = { setupServices, augmentRequest };
