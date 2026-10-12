/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Optional services reuse the desktop translators. No foreign Agent loop or UI.
const path = require('node:path');
function createNodeExtensions({
  dataDir,
  bind,
  bridge,
  eventBus,
  getRuntime,
  getSettings,
  publish,
  plugins = [],
}) {
  let host,
    native,
    initializing,
    syncTail = Promise.resolve();
  const transport = require('../main/services/backend-transport').createBackendTransport({
    getRuntime,
    getSettings,
    publish,
    getSubagentConfig: (id) => native?.config(id),
  });
  const sync = () =>
    (syncTail = syncTail
      .catch(() => {})
      .then(async () => {
        if (!host?.initialized || !getRuntime()) return;
        await host.agentsService.sync(
          getRuntime()
            .listSessions()
            .map((s) => ({
              key: getRuntime().sessions.get(s.key)?.agent.messagingId || s.key,
              runtimeKey: s.key,
              id: s.conversationId || s.key,
              mode: s.mode,
              title: s.title,
              cwd: s.workspacePath,
              status: s.status,
            })),
        );
      }));
  async function ensure() {
    if (initializing) return initializing;
    initializing = (async () => {
      host = new (require('../main/ds-compat/plugin-host').PluginHost)({
        dataDir,
        transport,
        invoke: (channel, ...args) => bridge.invoke(channel, ...args),
        subscribe: (channel, listener) => eventBus.subscribe(channel, listener),
        getSettings: async () => getSettings(),
      });
      await host.init();
      native = new (require('../main/services/native-subagents').NativeSubagents)({
        file: path.join(dataDir, 'native-subagents.json'),
        host,
        getRuntime,
        sync,
      });
      await sync();
      for (const plugin of plugins) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(plugin.id) || !path.isAbsolute(plugin.entry))
          throw new Error('Plugin entries require an explicit id and absolute path');
        await host.loadPlugin(plugin.id, plugin.entry, {
          name: plugin.id,
          config: plugin.config || {},
        });
      }
      return host;
    })();
    try {
      return await initializing;
    } catch (error) {
      await host?.dispose();
      host = null;
      initializing = null;
      throw error;
    }
  }
  bind('native-subagent:start', async (key, args) => {
    await ensure();
    return native.start(key, args);
  });
  bind('native-subagent:control', async (key, args) => {
    if (!host && args?.action === 'interrupt-all') return { ok: true };
    await ensure();
    return native.control(key, args);
  });
  bind('ds:toolCall', async (id, name, args, context) => {
    await ensure();
    return host.callTool(id, name, args, context);
  });
  bind('ds:listTools', async () => ({
    ok: true,
    plugins: host
      ? plugins.map((p) => ({
          id: p.id,
          name: p.id,
          enabled: true,
          tools: host.toolsForPlugin(p.id),
        }))
      : [],
  }));
  bind('ds:turnStopping', (key) =>
    host?.initialized ? host.agentsService.turnStopping(key) : { contexts: [] },
  );
  const automation = new (require('../main/automation/automation-manager').AutomationManager)({
    dataDir,
    transport,
    getSettings: async () => getSettings(),
  });
  bind('automation:list', () => ({
    ok: true,
    tasks: automation.list(),
    server: automation.serverInfo(),
  }));
  const changed = (value) => {
    publish('automation:changed', automation.list());
    return { ok: true, result: value };
  };
  bind('automation:save', (task) => changed(automation.upsert(task)));
  bind('automation:delete', (id) => changed(automation.remove(id)));
  bind('automation:setEnabled', (id, enabled) => changed(automation.setEnabled(id, enabled)));
  bind('automation:run', (id, params) => automation.run(id, params));
  bind('automation:test', (task, params) => automation.test(task, params));
  bind('automation:guide', (topic) =>
    require('../main/automation/guide').getAutomationGuide(topic),
  );
  const off = eventBus.subscribe('agent:session-event', (event) => {
    if (!host?.initialized) return;
    native?.event(event);
    host.agentsService.consumeRuntimeEvent(event);
    if (
      ['session-created', 'session-closed', 'status', 'title', 'view-changed'].includes(event.type)
    )
      sync().catch((error) => publish('host:error', { message: error.message }));
  });
  return {
    async start() {
      if (plugins.length) await ensure();
      automation.start();
    },
    async augment(messages, options) {
      return host?.initialized
        ? require('../main/ds-compat/service-setup').augmentRequest(host, messages, options)
        : { messages, options };
    },
    schemas(agent) {
      if (!host?.initialized) return [];
      return [...host.toolsService.registrations]
        .filter((def) => host.surfaceTool(`ds__${def.pluginId}__${def.name}`, agent.sessionKey))
        .map((def) => ({
          type: 'function',
          function: {
            name: `ds__${def.pluginId}__${def.name}`,
            description: def.description,
            parameters: def.parameters,
          },
        }));
    },
    async close() {
      automation.stop();
      off();
      await host?.dispose();
    },
  };
}
module.exports = { createNodeExtensions };
