/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgentRuntime } = require('../../src/main/agent-runtime');
const { createEventBus } = require('../../src/main/core/event-bus');
const { createBackendTransport } = require('../../src/main/services/backend-transport');
const { PluginHost } = require('../../src/main/ds-compat/plugin-host');
const { NativeSubagents } = require('../../src/main/services/native-subagents');
const { augmentRequest } = require('../../src/main/ds-compat/service-setup');
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail('Subagent condition timed out');
}
async function fixture(t, responder, quantService) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-native-agents-'));
  const histories = new Map(),
    calls = [],
    events = [],
    observations = [];
  const settings = {
    features: { quant: true },
    language: 'en',
    llm: {
      provider: 'openai',
      apiUrl: 'http://fixture',
      model: 'locked-model',
      streamResponses: false,
      maxContextLength: 32768,
    },
    tools: {},
    privacyProtection: { enabled: false },
    sessions: { maxConcurrent: 10 },
  };
  const handlers = new Map();
  let host, coordinator, runtime;
  const transport = createBackendTransport({
    getRuntime: () => runtime,
    publish() {},
    getSettings: () => settings,
    getSubagentConfig: (id) => coordinator?.config(id),
  });
  host = new PluginHost({ dataDir: dir, transport, getSettings: async () => settings });
  const sync = () =>
    host.agentsService.sync(
      runtime.listSessions().map((s) => ({
        key: runtime.sessions.get(s.key).agent.messagingId || s.key,
        runtimeKey: s.key,
        id: s.conversationId,
        status: s.status,
        mode: s.mode,
        cwd: s.workspacePath,
      })),
    );
  handlers.set('settings:get', () => settings);
  handlers.set('system:fullInfo', () => ({}));
  handlers.set('runtime:getLocation', () => ({ location: 'host' }));
  handlers.set('workspace:create', () => ({ ok: true, path: dir }));
  handlers.set('workspace:getFileTree', () => ({ ok: true, tree: '' }));
  handlers.set('workspace:resolve', (_, directory) => ({
    ok: true,
    path: directory || dir,
    hostPath: directory || dir,
  }));
  handlers.set('skills:list', () => []);
  handlers.set('tarot:draw', () => null);
  handlers.set('calc:evaluate', () => ({ ok: true, result: 2 }));
  handlers.set('history:save', (_, value) => {
    histories.set(value.id, structuredClone(value));
    return { ok: true };
  });
  handlers.set('history:get', (_, id) => histories.get(id));
  handlers.set('code:saveHistory', (_, _workspace, id, value) => {
    histories.set(id, structuredClone(value));
    return { ok: true };
  });
  handlers.set('code:loadHistory', (_, _workspace, id) => histories.get(id));
  handlers.set('automatic-memory:observe', (_, data) => observations.push(data));
  handlers.set('native-subagent:start', (_, key, args) => coordinator.start(key, args));
  handlers.set('native-subagent:control', (_, key, args) => coordinator.control(key, args));
  handlers.set('ds:turnStopping', (_, id) => host.agentsService.turnStopping(id));
  handlers.set('llm:chat', async (_, messages, options) => {
    if (!options.cibypAgentStep)
      return { ok: true, data: { choices: [{ message: { content: 'Task' } }] } };
    const admitted = await augmentRequest(host, messages, options);
    calls.push(admitted);
    const message = await responder(admitted.messages, admitted.options, { runtime, coordinator });
    return {
      ok: true,
      data: {
        choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
  });
  runtime = createAgentRuntime({
    ipcMain: { invokeLocal: (c, e, ...args) => handlers.get(c)?.(e, ...args), emitLocal() {} },
    eventBus: createEventBus(),
    getSettings: () => settings,
  });
  if (quantService) runtime.quantService = quantService;
  coordinator = new NativeSubagents({
    file: path.join(dir, 'native-subagents.json'),
    host,
    getRuntime: () => runtime,
    sync,
  });
  await host.init();
  runtime.onEvent((event) => {
    events.push(event);
    host.agentsService.consumeRuntimeEvent(event);
    coordinator.event(event);
  });
  t.after(async () => {
    for (const s of runtime.listSessions()) runtime.stop(s.key);
    await host.dispose();
    runtime.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await runtime.initialize({ key: 'parent', ...(quantService ? { profile: 'quant' } : {}) });
  await sync();
  return { runtime, coordinator, host, calls, histories, events, observations, sync, dir };
}

test('native runSubAgent uses the real SDK and shared loop, preserves model/tool scope, and cold-resumes', async (t) => {
  const f = await fixture(t, async () => ({ content: 'Investigation complete' }));
  f.runtime.sessions.get('parent').agent.llmOverride = {
    model: 'locked-model',
    provider: 'openai',
    apiKey: 'private-parent-fixture-key',
  };
  const answer = await f.runtime.sessions
    .get('parent')
    .agent.runSubAgent({ task: 'Investigate', tools: ['calculator', 'runTerminalCommand'] });
  assert.equal(answer.ok, true);
  assert.ok(answer.subAgentId);
  assert.equal(answer.result, 'Investigation complete');
  assert.ok(
    !JSON.stringify(f.histories.get(answer.subAgentId)).includes('private-parent-fixture-key'),
  );
  const call = f.calls.find((c) => c.options.sessionKey === answer.subAgentId);
  assert.equal(call.options.model, 'locked-model');
  assert.match(call.messages[0].content, /CIBYP subagent/);
  assert.ok(call.options.tools.some((t) => t.function.name === 'sendAgentMessage'));
  assert.ok(!call.options.tools.some((t) => t.function.name === 'deleteFile'));
  assert.equal(f.observations.length, 0);
  await until(() => !f.runtime.sessions.has(answer.subAgentId));
  const conversationId = f.runtime.sessions.get('parent').agent.conversationId;
  const identity = f.runtime.sessions.get('parent').agent.messagingId;
  await f.runtime.close('parent');
  f.runtime.createSession({ key: 'reopened-parent' });
  await f.runtime.openHistory('reopened-parent', conversationId);
  assert.equal(f.runtime.sessions.get('reopened-parent').agent.messagingId, identity);
  const receipt = await f.coordinator.control('reopened-parent', {
    action: 'send',
    targetId: answer.subAgentId,
    message: 'Check one more thing',
  });
  assert.ok(receipt.messageId);
  await until(() => f.calls.filter((c) => c.options.sessionKey === answer.subAgentId).length === 2);
  const next = f.calls.filter((c) => c.options.sessionKey === answer.subAgentId)[1];
  assert.equal(next.options.apiKey, 'private-parent-fixture-key');
  assert.ok(next.messages.some((m) => m.content === 'Investigation complete'));
  assert.ok(next.messages.some((m) => String(m.content).includes('Check one more thing')));
  await until(() => !f.runtime.sessions.has(answer.subAgentId));
});

test('quant native child uses isolated history, trusted identity and actual native signing limits after cold continuation', async (t) => {
  const { WalletService } = require('../../src/main/services/wallet');
  const { QuantService } = require('../../src/main/services/quant');
  const { keccak256 } = require('ethers');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-quant-child-signing-'));
  let nonce = 0,
    writes = 0;
  const walletService = new WalletService({
    directory,
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      let result;
      if (body.method === 'eth_sendRawTransaction') {
        writes++;
        nonce++;
        result = keccak256(body.params[0]);
      } else
        result = {
          eth_chainId: '0x2105',
          eth_getTransactionCount: '0x' + nonce.toString(16),
          eth_gasPrice: '0x989680',
          eth_maxPriorityFeePerGas: '0xf4240',
          eth_getBalance: '0x8ac7230489e80000',
          eth_estimateGas: '0x5208',
          eth_call: '0x' + '0'.repeat(64),
          eth_getTransactionReceipt: null,
          eth_getBlockByNumber: {
            number: '0x100',
            hash: '0x' + 'a'.repeat(64),
            timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
          },
        }[body.method];
      assert.notEqual(result, undefined, body.method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    },
  });
  t.after(async () => {
    await walletService.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const password = 'public-sdk-child-fixture-password';
  const wallet = await walletService.request('import', {
    kind: 'privateKey',
    secret: '0x' + '01'.padStart(64, '0'),
    password,
  });
  await walletService.request('unlock', { id: wallet.id, password, minutes: 0 });
  const c = await walletService.request('policy.challenge', { id: wallet.id, chains: [8453] });
  await walletService.request('policy.grant', {
    challengeId: c.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  const rootHistories = [],
    steps = new Map();
  const service = {
    getWallet: () => walletService,
    workspace: () => ({ market: { venue: 'base' } }),
    saveConversation: async (_id, payload) => rootHistories.push(payload),
    dispose() {},
    liveTransaction: QuantService.prototype.liveTransaction,
  };
  const f = await fixture(
    t,
    async (_messages, options) => {
      if (options.sessionKey === 'parent') return { content: 'Child report received' };
      const step = (steps.get(options.sessionKey) || 0) + 1;
      steps.set(options.sessionKey, step);
      if (step % 2 === 0) return { content: 'Checked result' };
      return {
        content: null,
        tool_calls: [
          {
            id: 'payment-' + step,
            type: 'function',
            function: {
              name: 'quant_live_transaction',
              arguments: JSON.stringify({
                walletId: wallet.id,
                operationId: 'transfer-' + step,
                to: '0x' + '2'.repeat(40),
                value: step === 1 ? '0.001' : '0.0005',
                agentScopeId: 'forged',
              }),
            },
          },
        ],
      };
    },
    service,
  );
  const a = f.runtime.sessions.get('parent').agent;
  assert.ok(
    a.getEnabledToolDefinitions().find((t) => t.name === 'runSubAgent').parameters.properties
      .walletScope,
  );
  const result = await a.executeTool('runSubAgent', {
    task: 'Transfer exactly once within delegated scope',
    tools: ['quant_live_transaction', 'quant_agent_scopes', 'runJavaScriptCode'],
    walletScope: {
      walletIds: [wallet.id],
      chains: [8453],
      limits: { maxTransactions: 1, maxTotalValueEth: '0.001' },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  await until(() => !f.runtime.sessions.has(result.subAgentId));
  const policy = f.coordinator.config(result.subAgentId);
  assert.equal(policy.quantContext.nodes.at(-1).subject, result.subAgentId);
  assert.equal(policy.tools.includes('runJavaScriptCode'), false);
  assert.ok(f.histories.has(result.subAgentId));
  assert.ok(rootHistories.every((h) => h.id !== result.subAgentId));
  await f.coordinator.control('parent', {
    action: 'send',
    targetId: result.subAgentId,
    message: 'Continue and report the remaining budget',
  });
  await until(
    () => steps.get(result.subAgentId) >= 4 && !f.runtime.sessions.has(result.subAgentId),
  );
  assert.equal(writes, 1);
  assert.match(
    f.histories
      .get(result.subAgentId)
      .messages.filter((m) => m.role === 'tool')
      .at(-1).content,
    /WALLET_AGENT_SCOPE_LIMIT/,
  );
  const scope = (await walletService.agentScopes.ensure(policy.quantContext, 8453)).snapshot;
  assert.equal(scope.usage.transactions, 1);
  assert.ok(
    f.calls
      .filter((call) => call.options.sessionKey === result.subAgentId)
      .every((call) =>
        call.options.tools.every((t) =>
          [
            'quant_live_transaction',
            'quant_agent_scopes',
            'sendAgentMessage',
            'listSubAgents',
            'interruptSubAgent',
          ].includes(t.function.name),
        ),
      ),
  );
});

test('stopping a parent parks late child settlement; explicit continuation resumes the mailbox', async (t) => {
  let release;
  const f = await fixture(t, async (_messages, options, { coordinator }) => {
    if (coordinator.config(options.sessionKey))
      await new Promise((r) => {
        release = r;
      });
    return { content: 'Finished after stop' };
  });
  const start = await f.coordinator.start('parent', { task: 'Wait', wait: false });
  await until(() => release);
  f.runtime.stop('parent');
  release();
  await until(() => !f.runtime.sessions.has(start.subAgentId));
  const parent = f.host.agentsService.get(f.runtime.sessions.get('parent').agent.messagingId);
  parent.followup(
    require('@deepseek-ai/dsh-llm').createUserMessage({
      content: [{ type: 'text', text: 'Late settlement' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'Late settlement',
        senderSessionId: start.subAgentId,
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(f.calls.filter((c) => c.options.sessionKey === 'parent').length, 0);
  assert.ok([...parent.inbox.nextTurn, ...parent.inbox.nextStep].length);
  parent.followup('Continue now');
  await until(() => f.calls.some((c) => c.options.sessionKey === 'parent'));
  await parent.whenIdle();
  assert.ok(
    f.calls
      .find((c) => c.options.sessionKey === 'parent')
      .messages.some((m) => String(m.content).includes('not human authorization')),
  );
});

test('native async child sends to parent; running steering persists beyond one model request', async (t) => {
  let release;
  const f = await fixture(t, async (messages, options, { coordinator, runtime }) => {
    if (!coordinator.config(options.sessionKey)) return { content: 'Parent received the finding' };
    const first = !messages.some((m) => m.role === 'tool');
    if (first) {
      await new Promise((r) => {
        release = r;
      });
      return {
        content: 'Found an issue',
        tool_calls: [
          {
            id: 'mail',
            type: 'function',
            function: {
              name: 'sendAgentMessage',
              arguments: JSON.stringify({
                targetId: runtime.sessions.get('parent').agent.messagingId,
                message: 'Important finding',
              }),
            },
          },
        ],
      };
    }
    return { content: 'Child finished' };
  });
  const started = await f.coordinator.start('parent', {
    task: 'Inspect',
    tools: ['calculator'],
    wait: false,
  });
  assert.ok(started.accepted && started.messageId);
  await until(() => release);
  const steered = await f.coordinator.control('parent', {
    action: 'send',
    targetId: started.subAgentId,
    message: 'Remember the new constraint',
  });
  assert.ok(steered.messageId);
  release();
  await until(() =>
    f.histories
      .get(started.subAgentId)
      ?.messages.some((m) => String(m.content).includes('Child finished')),
  );
  const childHistory = f.histories.get(started.subAgentId);
  assert.ok(
    childHistory.messages.some(
      (m) => m.metadata?.kind === 'agent-message' && String(m.content).includes('new constraint'),
    ),
  );
  assert.equal(f.observations.length, 0);
  assert.ok(f.events.some((e) => e.type === 'sub-agent-done'));
});

test('native iteration limit reports unfinished work as an error', async (t) => {
  const f = await fixture(t, async () => ({
    content: 'Still investigating',
    tool_calls: [
      {
        id: 'calc',
        type: 'function',
        function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
      },
    ],
  }));
  const result = await f.coordinator.start('parent', {
    task: 'Inspect',
    tools: ['calculator'],
    maxIterations: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /iteration limit/);
  assert.equal(result.iterations, 1);
});

test('cold continuation refuses a model pool entry repurposed for another provider', async (t) => {
  const f = await fixture(t, async () => ({ content: 'Done' }));
  const parent = f.runtime.sessions.get('parent').agent;
  parent.llmOverride = {
    model: 'locked-model',
    provider: 'openai',
    poolEntryId: 'delegated',
  };
  const result = await f.coordinator.start('parent', { task: 'Inspect' });
  await until(() => !f.runtime.sessions.has(result.subAgentId));
  parent.llmOverride = { model: 'another-model', provider: 'anthropic', poolEntryId: 'another' };
  parent.settings.llm.pool = [
    { id: 'delegated', model: 'locked-model', provider: 'anthropic', apiKey: 'wrong-provider-key' },
  ];
  f.runtime.createSession({ key: result.subAgentId, profile: 'subagent' });
  const policy = f.coordinator.config(result.subAgentId);
  assert.throws(
    () => f.runtime.configureNativeSubagent(result.subAgentId, policy),
    /delegated model route is unavailable/,
  );
  parent.settings.llm.pool[0] = {
    id: 'delegated',
    model: 'locked-model',
    provider: 'openai',
    apiKey: 'restored-route-key',
  };
  f.runtime.configureNativeSubagent(result.subAgentId, policy);
  assert.equal(
    f.runtime.sessions.get(result.subAgentId).agent._llmOptions().apiKey,
    'restored-route-key',
  );
});

test('Code child inherits its workspace and cannot execute tools outside delegation', async (t) => {
  let checked = false;
  const f = await fixture(t, async (_messages, options, { runtime, coordinator }) => {
    if (coordinator.config(options.sessionKey)) {
      const a = runtime.sessions.get(options.sessionKey).agent;
      assert.equal(a.mode, 'code');
      assert.equal(a.codeWorkspacePath, f.dir);
      assert.equal((await a.executeTool('deleteFile', { path: 'never.txt' })).ok, false);
      checked = true;
    }
    return { content: 'Workspace inspected' };
  });
  await f.runtime.initialize({
    key: 'code-parent',
    mode: 'code',
    workspacePath: f.dir,
    codeWorkspacePath: f.dir,
  });
  const result = await f.coordinator.start('code-parent', {
    task: 'Inspect this project',
    tools: ['calculator'],
  });
  assert.equal(result.ok, true);
  assert.equal(checked, true);
  assert.ok(f.histories.get(result.subAgentId));
  const catalog = JSON.parse(fs.readFileSync(path.join(f.dir, 'native-subagents.json'), 'utf8'));
  assert.ok(!JSON.stringify(catalog).includes('apiKey'));
  assert.equal(catalog.children[0].messages, undefined);
});

test('VM request bridge processes host messages and preserves guest plugin hooks', async (t) => {
  const { PluginManager } = require('../../src/main/ds-compat/plugin-manager');
  const guest = require('../../src/main/vm/plugin-runtime-client');
  const originalAugment = guest.augment,
    originalStopping = guest.turnStopping;
  t.after(() => {
    guest.augment = originalAugment;
    guest.turnStopping = originalStopping;
  });
  const order = [];
  const hostAgent = { id: 'parent' };
  const manager = Object.create(PluginManager.prototype);
  manager.getVmService = () => ({ runtime: { location: 'vm' } });
  manager.host = {
    agentsService: {
      get: () => hostAgent,
      beforeRequest: async (_agent, messages, options) => {
        order.push('host');
        return { messages: [...messages, { role: 'user', content: 'Host steering' }], options };
      },
      turnStopping: async () => ({ contexts: ['Host continuation'] }),
    },
  };
  guest.augment = async (_service, messages, options) => {
    order.push('guest');
    assert.ok(messages.some((m) => m.content === 'Host steering'));
    assert.equal(options.cibypHostInboxApplied, undefined);
    return { messages: [...messages, { role: 'user', content: 'Guest plugin' }], options };
  };
  guest.turnStopping = async () => ({ contexts: ['Guest continuation'] });
  const result = await manager.augmentRequest([{ role: 'user', content: 'Task' }], {
    sessionKey: 'parent',
    cibypAgentStep: true,
  });
  assert.deepEqual(order, ['host', 'guest']);
  assert.ok(result.messages.some((m) => m.content === 'Guest plugin'));
  assert.deepEqual((await manager.turnStopping('parent')).contexts, [
    'Host continuation',
    'Guest continuation',
  ]);
});

test('parallel child approvals are serialized in the parent and child interruption clears its decision', async (t) => {
  const decisions = [];
  const f = await fixture(t, async (_messages, options, { runtime, coordinator }) => {
    if (coordinator.config(options.sessionKey))
      decisions.push(
        await runtime.sessions
          .get(options.sessionKey)
          .agent.requestApproval('write', { file: options.sessionKey }),
      );
    return { content: 'Done' };
  });
  const one = await f.coordinator.start('parent', { task: 'One', wait: false });
  const two = await f.coordinator.start('parent', { task: 'Two', wait: false });
  await until(() => f.runtime.sessions.get('parent').pendingInteraction);
  const first = f.runtime.sessions.get('parent').pendingInteraction.payload.subAgentId;
  assert.ok([one.subAgentId, two.subAgentId].includes(first));
  await f.coordinator.control('parent', { action: 'interrupt', targetId: first });
  await until(
    () =>
      f.runtime.sessions.get('parent').pendingInteraction?.payload.subAgentId !== first &&
      f.runtime.sessions.get('parent').pendingInteraction,
  );
  f.runtime.respond('parent', true);
  await until(() => decisions.length === 2);
  assert.deepEqual(decisions, [false, true]);
});
