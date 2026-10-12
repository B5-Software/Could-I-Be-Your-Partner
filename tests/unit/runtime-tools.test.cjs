const test = require('node:test'),
  assert = require('node:assert/strict');
const { ToolRegistry } = require('../../packages/remote');
const { decorateRuntimeTools } = require('../../src/main/services/runtime-tools');
test('hardware discovery bounds schema exposure and respects scope, minimal mode and unplugging', async () => {
  const tools = new ToolRegistry(),
    disposers = [];
  for (let i = 0; i < 20; i++)
    disposers.push(
      tools.register(
        {
          name: 'hardware_' + i,
          description: 'Fixture',
          version: '1',
          target: 'host',
          inputSchema: { type: 'object', properties: {} },
          execution: {},
        },
        () => null,
      ),
    );
  const agent = {
    sessionKey: 'fixture',
    getRuntimeToolSchemas: () => [],
    getEnabledToolDefinitions: () => [],
    executeTool: () => assert.fail('unknown tool'),
    contextManager: { setToolSchemaTokens: (tokens) => assert.ok(tokens >= 0) },
  };
  decorateRuntimeTools(agent, () => ({ tools }));
  assert.equal(agent.getRuntimeToolSchemas().length, 2);
  assert.equal((await agent.executeTool('listHardwareTools', { limit: 1 })).nextOffset, 1);
  for (let i = 0; i < 20; i++)
    await agent.executeTool('describeHardwareTool', { name: 'hardware_' + i });
  assert.equal(agent.getRuntimeToolSchemas().length, 18);
  assert.ok(!agent.getRuntimeToolSchemas().some((tool) => tool.function.name === 'hardware_0'));
  agent._toolScope = new Set(['hardware_19']);
  assert.equal((await agent.executeTool('listHardwareTools', {})).total, 1);
  await assert.rejects(
    agent.executeTool('describeHardwareTool', { name: 'hardware_0' }),
    (error) => error.data.reason === 'FORBIDDEN',
  );
  disposers[19]();
  assert.equal(agent.getRuntimeToolSchemas().length, 0);
  agent._toolScope = null;
  agent.minimalMode = true;
  assert.equal(agent.getRuntimeToolSchemas().length, 0);
  await assert.rejects(
    agent.executeTool('listHardwareTools', {}),
    (error) => error.data.reason === 'CAPABILITY_UNAVAILABLE',
  );
});
