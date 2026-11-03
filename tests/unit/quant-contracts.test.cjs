/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Interface } = require('ethers');
const { QuantService } = require('../../src/main/services/quant');
const { decorateQuantTools } = require('../../src/main/services/quant/agent-tools');
const target = '0x1111111111111111111111111111111111111111';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-contract-'));
  const service = new QuantService({ directory });
  t.after(() => {
    service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = await service.request('workspace.create', { venue: 'base' });
  return { service, project, directory };
}
test('contract encoding is hash-bound, immutable, network-scoped and never signs or calls an RPC', async (t) => {
  const { service, project, directory } = await fixture(t);
  service.market.rpc = () => assert.fail('Encoding must not contact any node');
  const call = await service.request('contract', {
    id: project.id,
    action: 'encode',
    to: target,
    abi: ['function transfer(address,uint256) returns(bool)'],
    function: 'transfer',
    args: [target, '12345678901234567890'],
  });
  assert.equal(call.abiVerified, false);
  assert.equal(call.dataBytes, 68);
  const data = await service.request('contract', {
    id: project.id,
    action: 'get',
    callId: call.callId,
    maxChars: 0,
  });
  assert.match(data.text, /^0xa9059cbb/);
  assert.equal(data.nextOffset, null);
  const other = await service.request('workspace.create', { venue: 'base' });
  await assert.rejects(
    service.request('contract', { id: other.id, action: 'get', callId: call.callId }),
    /NOT_IN_WORKSPACE/,
  );
  await assert.rejects(
    service.liveTransaction(project.id, { callId: call.callId, to: target }, 'op'),
    /OVERRIDE/,
  );
  // Restored configurations and future adapter migrations cannot reuse a call
  // against a different chain while retaining the same workspace identity.
  service.workspace(project.id).market.venue = 'base-sepolia';
  await assert.rejects(
    service.liveTransaction(project.id, { callId: call.callId }, 'op'),
    /NETWORK_CHANGED/,
  );
  const file = path.join(directory, 'contract-calls', call.callId + '.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.to = '0x' + '2'.repeat(40);
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(
    service.request('contract', { id: project.id, action: 'get', callId: call.callId }),
    /HASH_MISMATCH/,
  );
});
test('contract views preserve integer precision and allow explicit paging/full reads without broadcasting', async (t) => {
  const { service, project } = await fixture(t),
    abi = new Interface(['function metadata() view returns(string)']);
  const full = 'x'.repeat(15000);
  const methods = [];
  service.market.rpc = async (_chain, _url, method) => {
    methods.push(method);
    return method === 'eth_chainId' ? '0x2105' : abi.encodeFunctionResult('metadata', [full]);
  };
  const input = {
    id: project.id,
    action: 'read',
    to: target,
    abi: ['function metadata() view returns(string)'],
    function: 'metadata',
  };
  const first = await service.request('contract', { ...input, maxChars: 10 });
  assert.equal(first.text.length, 10);
  assert.equal(first.nextOffset, 10);
  const next = await service.request('contract', { ...input, offset: 10, maxChars: 20 });
  assert.equal(next.offset, 10);
  assert.equal(next.text.length, 20);
  assert.equal(
    (await service.request('contract', { ...input, maxChars: 0 })).text,
    JSON.stringify([full]),
  );
  assert.ok(methods.every((m) => ['eth_chainId', 'eth_call'].includes(m)));
  await assert.rejects(
    service.request('contract', { ...input, abi: ['function metadata() returns(string)'] }),
    /VIEW_REQUIRED/,
  );
  service.market.rpc = async () => '0x1';
  await assert.rejects(service.request('contract', input), /CHAIN_ID_MISMATCH/);
});
function toolAgent(service, goal = null) {
  const agent = {
    host: { api: {} },
    stopped: false,
    contextManager: { setToolSchemaTokens() {} },
    executeTool: async () => ({}),
    stop() {
      this.stopped = true;
    },
    sendMessage: async () => {},
    loadFromHistory: async () => {},
    _withGoalToolSchemas: () => [],
    getGoalSnapshot: () => goal,
    getGoalSteeringSection: () => '',
    async saveToHistory() {
      await this.host.api.historySave({ id: 'chat' });
    },
  };
  decorateQuantTools(agent, () => service, 'workspace');
  return agent;
}
test('live operation identity survives a new tool-call ID, completion, reload and goal resume', async () => {
  const commands = [];
  let saved;
  const service = {
    saveConversation: (_id, payload) => {
      saved = structuredClone(payload);
    },
    liveTransaction: async (_id, _input, id) => {
      commands.push(id);
      return { id, status: 'submitted', transaction: { to: target, data: '0x' } };
    },
  };
  const goal = { status: 'active', startedAt: 123 };
  const agent = toolAgent(service, goal);
  const input = {
    operationId: 'one-requested-payment',
    walletId: 'wallet',
    to: target,
    value: '1',
  };
  await agent.executeTool('quant_live_transaction', input, { callId: 'one' });
  goal.status = 'complete';
  await agent.executeTool('quant_live_transaction', input, { callId: 'two' });
  assert.equal(commands[0], commands[1]);
  const restored = toolAgent(service, goal);
  await restored.loadFromHistory(saved);
  await restored.executeTool('quant_live_transaction', input, { callId: 'three' });
  assert.equal(commands[0], commands[2]);
  goal.status = 'active';
  await restored.sendMessage('/goal resume');
  await restored.executeTool('quant_live_transaction', input, { callId: 'four' });
  assert.equal(commands[0], commands[3]);
  assert.equal(
    (await restored.executeTool('quant_live_transaction', { ...input, operationId: undefined }))
      .error,
    'LIVE_OPERATION_ID_REQUIRED',
  );
});
test('distinct human requests get distinct namespaces while private keys and calldata stay out of tool results', async () => {
  const commands = [];
  const service = {
    saveConversation() {},
    liveTransaction: async (_id, _input, id) => {
      commands.push(id);
      return {
        id,
        status: 'submitted',
        transaction: { to: target, data: '0x' + 'a'.repeat(10000) },
        description: { kind: 'contract-call', calldata: '0x' + 'a'.repeat(10000) },
      };
    },
  };
  const agent = toolAgent(service),
    input = { operationId: 'payment', walletId: 'wallet', to: target, value: '1' };
  const result = await agent.executeTool('quant_live_transaction', input);
  assert.equal(result.dataBytes, 5000);
  assert.ok(JSON.stringify(result).length < 1000);
  await agent.sendMessage('Make a second distinct payment');
  await agent.executeTool('quant_live_transaction', input);
  assert.notEqual(commands[0], commands[1]);
});
