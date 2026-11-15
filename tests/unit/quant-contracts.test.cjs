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
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-contract-'));
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
  const { service, project, directory } = await fixture(t),
    abi = new Interface(['function metadata() view returns(string)']);
  const full = 'x'.repeat(15000);
  const methods = [];
  const block = { number: '0x12', hash: '0x' + 'a'.repeat(64), timestamp: '0x1' };
  service.market.rpc = async (_chain, _url, method, params) => {
    methods.push(method);
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber') return block;
    assert.equal(method, 'eth_call');
    assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true });
    return abi.encodeFunctionResult('metadata', [full]);
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
  const count = methods.length;
  const next = await service.request('contract', {
    id: project.id,
    action: 'result',
    ref: first.ref,
    offset: 10,
    maxChars: 20,
  });
  assert.equal(next.offset, 10);
  assert.equal(next.text.length, 20);
  assert.equal(
    (
      await service.request('contract', {
        id: project.id,
        action: 'result',
        ref: first.ref,
        maxChars: 0,
      })
    ).text,
    JSON.stringify([full]),
  );
  assert.equal(methods.length, count, 'Archived pages must not read a newer chain state');
  assert.equal(first.blockHash, block.hash);
  assert.equal(first.blockNumber, '18');
  assert.equal(first.abiVerified, false);
  await assert.rejects(
    service.request('contract', { ...input, abi: ['function metadata() returns(string)'] }),
    /VIEW_REQUIRED/,
  );
  service.market.rpc = async () => '0x1';
  await assert.rejects(service.request('contract', input), /CHAIN_ID_MISMATCH/);
  const other = await service.request('workspace.create', { venue: 'coinbase' });
  await assert.rejects(
    service.request('contract', { id: other.id, action: 'result', ref: first.ref }),
    /NOT_IN_WORKSPACE/,
  );
  service.dispose();
  const reopened = new QuantService({ directory });
  t.after(() => reopened.dispose());
  reopened.market.rpc = () => assert.fail('Recovery must not query any chain');
  reopened.workspace(project.id).market.venue = 'coinbase';
  assert.equal(
    (
      await reopened.request('contract', {
        id: project.id,
        action: 'result',
        ref: first.ref,
        maxChars: 0,
      })
    ).text,
    JSON.stringify([full]),
  );
  const file = path.join(directory, 'contract-results', first.ref + '.json');
  const altered = JSON.parse(fs.readFileSync(file));
  altered.text = 'Modified evidence';
  fs.writeFileSync(file, JSON.stringify(altered));
  await assert.rejects(
    reopened.request('contract', { id: project.id, action: 'result', ref: first.ref }),
    /HASH_MISMATCH/,
  );
});

test('custom contract reads validate genesis, requested height, configuration revision and canonical block', async (t) => {
  const { service, project, directory } = await fixture(t);
  const profile = {
    id: 1337,
    key: 'evm-1337',
    name: 'Local',
    genesisHash: '0x' + 'a'.repeat(64),
    revision: 1,
  };
  let wrongGenesis = true,
    changeRevision = false,
    reorg = false,
    afterCall = false,
    calls = 0;
  const abi = new Interface(['function count() view returns(uint256)']);
  service.market.resolveChain = () => ({ ...profile });
  service.getWallet = () => ({ networks: { profile: () => ({ ...profile }) } });
  service.evmContext = () => ({
    market: service.market,
    chain: { ...profile },
    config: { venue: profile.key },
  });
  service.market.rpc = async (_chain, _url, method, params) => {
    if (method === 'eth_chainId') return '0x539';
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x0') return { hash: '0x' + (wrongGenesis ? 'c' : 'a').repeat(64) };
      const selected = params[0] !== 'latest';
      return {
        number: selected ? '0x10' : '0x12',
        timestamp: '0x1',
        hash: '0x' + (reorg && afterCall ? 'd' : selected ? 'b' : 'e').repeat(64),
      };
    }
    assert.equal(method, 'eth_call');
    calls++;
    afterCall = true;
    assert.deepEqual(params[1], { blockHash: '0x' + 'b'.repeat(64), requireCanonical: true });
    if (changeRevision) profile.revision++;
    return abi.encodeFunctionResult('count', [42n]);
  };
  const input = {
    id: project.id,
    action: 'read',
    chainId: 1337,
    to: target,
    abi: ['function count() view returns(uint256)'],
    function: 'count',
    block: 'safe',
  };
  await assert.rejects(service.request('contract', input), /WALLET_NETWORK_GENESIS/);
  assert.equal(calls, 0);
  wrongGenesis = false;
  changeRevision = true;
  await assert.rejects(service.request('contract', input), /WALLET_NETWORK_CHANGED/);
  assert.equal(fs.existsSync(path.join(directory, 'contract-results')), false);
  changeRevision = false;
  reorg = true;
  afterCall = false;
  await assert.rejects(service.request('contract', input), /BLOCK_REORG/);
  reorg = false;
  await assert.rejects(service.request('contract', { ...input, block: '0xf' }), /CONTRACT_BLOCK/);
  const read = await service.request('contract', { ...input, block: '0x10', maxChars: 0 });
  assert.equal(read.text, '["42"]');
  assert.equal(read.blockNumber, '16');
  assert.equal(read.genesisHash, profile.genesisHash);
});

test('stopping the actual contract tool aborts its pending node request and creates no result archive', async (t) => {
  const { service, project, directory } = await fixture(t),
    entered = Promise.withResolvers();
  let cancelled = false;
  service.market.rpc = async (_chain, _url, method, _params, options) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber')
      return { number: '0x12', hash: '0x' + 'a'.repeat(64), timestamp: '0x1' };
    assert.equal(method, 'eth_call');
    entered.resolve();
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(options.signal.reason);
        },
        { once: true },
      ),
    );
  };
  const agent = toolAgent(service, null, project.id);
  const pending = agent.executeTool('quant_contract', {
    action: 'read',
    to: target,
    abi: ['function count() view returns(uint256)'],
    function: 'count',
  });
  await Promise.race([
    entered.promise,
    pending.then(() => {
      throw Error('Contract read did not reach RPC');
    }),
  ]);
  agent.stop();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /abort|cancel/i);
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(path.join(directory, 'contract-results')), false);
});

test('contract result quotas reject new archives without silently deleting existing observations', async (t) => {
  const { service, project, directory } = await fixture(t);
  const archive = path.join(directory, 'contract-results');
  fs.mkdirSync(archive);
  for (let i = 0; i < 512; i++)
    fs.writeFileSync(path.join(archive, i.toString(16).padStart(64, '0') + '.json'), '{}');
  const abi = new Interface(['function count() view returns(uint256)']);
  service.market.rpc = async (_chain, _url, method) => {
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getBlockByNumber')
      return { number: '0x12', hash: '0x' + 'a'.repeat(64), timestamp: '0x1' };
    assert.equal(method, 'eth_call');
    return abi.encodeFunctionResult('count', [42n]);
  };
  await assert.rejects(
    service.request('contract', {
      id: project.id,
      action: 'read',
      to: target,
      abi: ['function count() view returns(uint256)'],
      function: 'count',
    }),
    /CONTRACT_ARCHIVE_LIMIT/,
  );
  assert.equal(fs.readdirSync(archive).length, 512);
  assert.equal(fs.readFileSync(path.join(archive, '0'.repeat(64) + '.json'), 'utf8'), '{}');
  await assert.rejects(
    service.request('contract', { id: project.id, action: 'result', ref: '../state' }),
    /CONTRACT_RESULT_REF/,
  );
  await assert.rejects(
    service.request('contract', { id: project.id, action: 'result', ref: 'f'.repeat(64) }),
    /CONTRACT_RESULT_NOT_FOUND/,
  );
});

function toolAgent(service, goal = null, workspaceId = 'workspace') {
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
  decorateQuantTools(agent, () => service, workspaceId);
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
