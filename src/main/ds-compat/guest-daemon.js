/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const os = require('node:os');
const path = require('node:path');
const { RpcPeer } = require('./rpc-peer');
const { PluginHost } = require('./plugin-host');
async function serve(input, output, initial = {}) {
  let settings = {},
    host,
    shuttingDown;
  const listeners = new Map(),
    versions = new Map();
  const peer = new RpcPeer(input, output, {
    event(name, value) {
      if (name === 'settings') settings = value;
      else if (name === 'agents') return host?.agentsService.sync(value);
      else if (name === 'runtime') host?.agentsService.consumeRuntimeEvent(value);
      else for (const listener of listeners.get(name) || []) listener(value);
    },
    async request(method, args, signal) {
      if (method === 'init') {
        if (host) throw new Error('Plugin runtime already initialized');
        settings = args.settings || {};
        host = new PluginHost({
          dataDir:
            initial.dataDir ||
            args.dataDir ||
            path.join(os.homedir(), '.local/share/cibyp/plugin-runtime'),
          getSettings: () => settings,
          invoke: (channel, values, options) =>
            peer.ask('invoke', [channel, values, options && { ...options, signal: undefined }], {
              signal: options?.signal || require('./execution-context').currentExecution().signal,
              timeoutMs: 0,
            }),
          subscribe: (name, listener) => {
            const set = listeners.get(name) || new Set();
            set.add(listener);
            listeners.set(name, set);
            return () => set.delete(listener);
          },
          cancelRequest: (filter) => {
            peer.ask('cancelRequest', filter).catch(() => {});
          },
          skills: () => ({
            list: (options) => peer.ask('skills:list', { ...options, signal: undefined }),
            get: (name, options) =>
              peer.ask('skills:get', { name, options: { ...options, signal: undefined } }),
          }),
          setPluginConfig: (id, value) => peer.ask('plugin:config', { id, value }),
          transport: {
            request: (channel, payload, timeoutMs, signal) =>
              peer.ask(
                'backend:request',
                { channel, payload },
                { signal, timeoutMs: timeoutMs ?? 0 },
              ),
            send: (channel, payload) =>
              peer.ask('backend:send', { channel, payload }, { timeoutMs: 0 }),
          },
        });
        await host.init();
        await host.agentsService.sync(args.agents || []);
        return { ok: true };
      }
      if (!host) throw new Error('Plugin runtime not initialized');
      if (method === 'call') {
        const { plugin, name, arguments: values, context = {}, version } = args;
        settings = args.settings || settings;
        // Metadata arrives before dispatch so tool consumers get the exact live scope.
        await host.agentsService.sync(args.agents || []);
        if (versions.get(plugin.id) !== version) {
          await host.unloadPlugin(plugin.id);
          const loaded = await host.loadPlugin(plugin.id, plugin.entry, {
            name: plugin.name,
            config: plugin.config,
          });
          if (loaded.issues.length)
            return { ok: false, error: loaded.issues.join('; '), ...loaded };
          versions.set(plugin.id, version);
        }
        if (name === null) return { ok: true, tools: host.toolsForPlugin(plugin.id), issues: [] };
        return host.callTool(plugin.id, name, values, { ...context, signal });
      }
      if (method === 'unload') {
        versions.delete(args);
        await host.unloadPlugin(args);
        return { ok: true };
      }
      if (method === 'surface-call')
        return host.callSurfaceTool(args.wire, args.arguments, { ...args.context, signal });
      if (method === 'surface-tool') return host.surfaceTool(args.wire, args.sessionKey) || null;
      if (method === 'plugin-busy')
        return [...host._activeTools.values()].some((jobs) =>
          [...jobs].some((job) => job.pluginId === args),
        );
      if (method === 'augment') {
        const result = await require('./service-setup').augmentRequest(host, args.messages, {
          ...args.options,
          signal,
        });
        return { ...result, options: { ...result.options, signal: undefined } };
      }
      if (method === 'turn-stopping') return host.agentsService.turnStopping(args);
      if (method === 'dispose') {
        await shutdown();
        return { ok: true };
      }
      throw new Error('Unsupported plugin runtime operation: ' + method);
    },
    close: () => {
      void shutdown();
    },
  });
  function shutdown() {
    return (shuttingDown ||= host?.dispose() || Promise.resolve());
  }
  return {
    peer,
    close: async () => {
      await shutdown();
      peer.close();
    },
  };
}
module.exports = { serve };
