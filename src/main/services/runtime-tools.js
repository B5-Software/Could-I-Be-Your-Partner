/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { RemoteError } = require('../../../packages/remote');
function decorateRuntimeTools(agent, getService, profile) {
  if (profile === 'settings-assistant') return;
  const permitted = (name) => !agent._toolScope || agent._toolScope.has(name);
  const selected = new Set();
  const discovery = [
    {
      name: 'listHardwareTools',
      description: 'List authorized external hardware tools. Describe a tool before using it.',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 32 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'describeHardwareTool',
      description:
        'Read one authorized hardware tool schema and enable it for this Agent. At most 16 external tools are loaded at a time.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
  const available = () =>
    [...(getService()?.tools.entries.values() || [])]
      .map(({ manifest }) => manifest)
      .filter((tool) => permitted(tool.name));
  const definitions = () =>
    agent.minimalMode ? [] : available().filter((tool) => selected.has(tool.name));
  const discoverable = () => (!agent.minimalMode && available().length ? discovery : []);
  const schemas = agent.getRuntimeToolSchemas.bind(agent),
    enabled = agent.getEnabledToolDefinitions.bind(agent),
    execute = agent.executeTool.bind(agent);
  agent.getEnabledToolDefinitions = () => [
    ...enabled(),
    ...discoverable(),
    ...definitions().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  ];
  agent.getRuntimeToolSchemas = () => {
    const tools = [
      ...schemas(),
      ...discoverable().map((tool) => ({ type: 'function', function: tool })),
      ...definitions().map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    ];
    agent.contextManager?.setToolSchemaTokens(Math.ceil(JSON.stringify(tools).length / 4));
    return tools;
  };
  agent.executeTool = async (name, input, invocation) => {
    if (name === 'listHardwareTools' || name === 'describeHardwareTool') {
      if (agent.minimalMode || !getService()) throw new RemoteError('CAPABILITY_UNAVAILABLE');
      if (name === 'listHardwareTools') {
        const offset = input.offset ?? 0,
          limit = input.limit ?? 20,
          all = available();
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 32
        )
          throw new RemoteError('INVALID_PARAMS');
        return {
          items: all
            .slice(offset, offset + limit)
            .map(({ inputSchema: _schema, ...summary }) => summary),
          total: all.length,
          nextOffset: offset + limit < all.length ? offset + limit : null,
        };
      }
      const tool = available().find((entry) => entry.name === input.name);
      if (!tool) throw new RemoteError('FORBIDDEN', 'Tool was not delegated to this Agent');
      selected.delete(tool.name);
      selected.add(tool.name);
      if (selected.size > 16) selected.delete(selected.values().next().value);
      return tool;
    }
    const service = getService(),
      entry = service?.tools.entries.get(name);
    if (!entry) return execute(name, input, invocation);
    if (!permitted(name))
      throw new RemoteError('FORBIDDEN', 'Tool was not delegated to this Agent');
    const principal = { id: 'agent:' + agent.sessionKey, scopes: ['tools.invoke'] };
    const operationId = invocation?.callId
      ? createHash('sha256')
          .update(agent.sessionKey + '\0' + invocation.callId)
          .digest('hex')
      : randomUUID();
    return service.operations.run(
      principal.id,
      operationId,
      'tool.invoke',
      { name, input },
      async () => {
        let lease;
        if (entry.manifest.execution?.requiresLease) {
          if (agent._sandboxMode() === 'read-only' || !(await agent.requestApproval(name, input)))
            throw new RemoteError('FORBIDDEN', 'Hardware action declined');
          lease = service.tools.acquire(input.resource, principal, 30000);
        }
        try {
          return await service.tools.invoke({ name, input, operationId, ...lease }, principal);
        } finally {
          if (lease) service.tools.release(input.resource, lease.leaseId, principal);
        }
      },
    );
  };
}
module.exports = { decorateRuntimeTools };
