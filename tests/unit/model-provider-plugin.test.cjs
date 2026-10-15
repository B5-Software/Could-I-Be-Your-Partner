/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
const { PluginManager } = require('../../src/main/ds-compat/plugin-manager');
const { createPluginModels } = require('../../src/main/ds-compat/model-transport');
const { consumeSSEStream, abortRequests } = require('../../src/main/llm-retry');
const installDir = path.resolve(__dirname, '../fixtures/model-provider');
const entry = path.join(installDir, 'index.mjs');
async function fixture(t, config = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-model-plugin-'));
  const host = new PluginHost({ dataDir: folder });
  t.after(async () => {
    await host.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  await host.init();
  const loaded = await host.loadPlugin('provider-fixture', entry, { config });
  assert.deepEqual(loaded.issues, []);
  return { host, bridge: createPluginModels(() => host) };
}
test('DSH model bridge discovers providers, preserves reasoning/tools/usage and unregisters on unload', async (t) => {
  let request;
  const { host, bridge } = await fixture(t, {
    emitTool: true,
    onRequest: (value) => {
      request = value;
    },
  });
  assert.equal((await bridge.providers())[0].id, 'dsh:fixture');
  assert.equal((await bridge.models('dsh:fixture')).models[0].contextLength, 32768);
  const result = await bridge.fetch(
    {
      pluginProvider: 'dsh:fixture',
      model: 'fixture-model',
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'readFile',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      max_tokens: 1000,
    },
    { sessionKey: 'plugin-chat', requestId: 'fixture' },
  );
  const response = await consumeSSEStream(
    result.response.body,
    () => {},
    'fixture',
    'openai',
    5000,
    {},
  );
  assert.equal(response.content, 'Hello from the plugin');
  assert.equal(response.toolCalls[0].function.name, 'readFile');
  assert.equal(response.usage.prompt_tokens, 30);
  assert.equal(request.maxTokens, 1000);
  assert.ok(response.providerReasoning.items.some((i) => i.format === 'dsh-plugin'));
  assert.equal((await bridge.usage('dsh:fixture')).windows[0].usedPercent, 40);
  result.releaseController();
  await host.unloadPlugin('provider-fixture');
  assert.equal((await bridge.providers()).length, 0);
  await assert.rejects(bridge.models('dsh:fixture'), /Enable/);
});
test('stopping a CIBYP session aborts the native plugin model request', async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { bridge } = await fixture(t, { waitForAbort: true, onRequest: started });
  const result = await bridge.fetch(
    {
      pluginProvider: 'dsh:fixture',
      model: 'fixture-model',
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    },
    { sessionKey: 'plugin-stop' },
  );
  const pending = consumeSSEStream(
    result.response.body,
    () => {},
    'fixture-stop',
    'openai',
    5000,
    {},
  );
  await ready;
  assert.equal(abortRequests({ sessionKey: 'plugin-stop' }), 1);
  assert.match((await pending).error, /cancelled|aborted/i);
});
test('VM mode respects provider package host runtime and disabled plugins disappear', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cibyp-model-plugin-vm-'));
  const manager = new PluginManager(folder, {
    getVmService: () => ({ runtime: { location: 'vm' } }),
  }).init();
  t.after(async () => {
    await manager.dispose();
    await fs.rm(folder, { recursive: true, force: true });
  });
  manager.plugins.push({ id: 'host-fixture', entry, installDir, enabled: true, config: {} });
  assert.equal((await manager.refreshPlugin('host-fixture')).ok, true);
  assert.equal(manager.list()[0].runtime, 'host');
  const bridge = createPluginModels(() => manager.host);
  assert.ok((await bridge.providers()).some((p) => p.id === 'dsh:fixture'));
  await manager.setEnabled('host-fixture', false);
  assert.equal((await bridge.providers()).length, 0);
});
