/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { decorateQuantTools } = require('../../src/main/services/quant/agent-tools');
test('live execution tools pin workspace/operation scope and cannot fabricate financial reports', async () => {
  const calls = [];
  const service = {
    request: async (action, input) => {
      calls.push({ action, input });
      return { ok: true };
    },
    saveConversation: async () => {},
  };
  const worker = agent(service);
  const input = {
    action: 'create',
    id: 'foreign',
    operationId: 'slice-plan',
    side: 'buy',
    totalInput: '10',
    walletId: 'wallet',
  };
  await worker.executeTool('quant_live_execution', input, { callId: 'first' });
  await worker.executeTool('quant_live_execution', input, { callId: 'retry' });
  assert.equal(calls[0].action, 'execution.create');
  assert.equal(calls[0].input.id, 'project-a');
  assert.equal(calls[0].input.operationId, calls[1].input.operationId);
  const rejected = await worker.executeTool('quant_live_execution', {
    action: 'report',
    runId: 'foreign',
  });
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 2);
});
test('event recording and replay commands preserve operation identity across Agent recovery and force the project scope', async () => {
  const calls = [];
  let saved;
  const service = {
    saveConversation: async (_id, payload) => {
      saved = payload;
    },
    request: async (action, input) => {
      calls.push({ action, input });
      return { ok: true };
    },
  };
  const first = agent(service),
    input = {
      action: 'replay_start',
      operationId: 'experiment',
      recordingId: 'tape',
      strategyId: 'strategy',
      revision: 2,
      id: 'foreign',
    };
  await first.executeTool('quant_event_data', input, { callId: 'a' });
  const second = agent(service);
  await second.loadFromHistory(saved);
  await second.executeTool('quant_event_data', input, { callId: 'b' });
  assert.equal(calls[0].input.operationId, calls[1].input.operationId);
  assert.ok(calls.every((c) => c.action === 'replay.start' && c.input.id === 'project-a'));
  assert.equal(second.allowedToolNames.has('replay.step'), false);
  assert.equal(second.allowedToolNames.has('native.control'), false);
});
function agent(service, options = {}) {
  const instance = {
    host: { api: { historySave: async (payload) => service.saveChildHistory?.(payload) } },
    stopped: false,
    executeTool: async () => {
      throw Error('unscoped fallback');
    },
    stop() {},
    sendMessage: async () => {},
    loadFromHistory: async () => {},
    _withGoalToolSchemas: (schemas) => schemas,
    getGoalSnapshot: () => ({ status: 'active', startedAt: 42 }),
    getGoalSteeringSection: () => '',
    contextManager: { setToolSchemaTokens() {} },
    saveToHistory: async () => instance.host.api.historySave({ messages: [] }),
  };
  decorateQuantTools(instance, () => service, 'project-a', options);
  return instance;
}

test('quant child logical operations retain identity across messages and cold history restore without saving over the parent', async () => {
  const { rootContext, deriveChild } = require('../../src/main/services/wallet/agent-scopes');
  const context = deriveChild(rootContext('project-a'), 'native-sub-stable'),
    calls = [];
  let saved;
  const service = {
    saveConversation: async () => assert.fail('Must not overwrite parent history'),
    saveChildHistory: async (payload) => (saved = payload),
    request: async (action, input) => {
      calls.push({ action, input });
      return {};
    },
  };
  const options = {
    agentContext: context,
    isSubagent: true,
    allowedTools: ['quant_live_execution'],
  };
  const one = agent(service, options),
    input = {
      action: 'create',
      operationId: 'same-request',
      walletId: 'wallet',
      side: 'buy',
      totalInput: '1',
    };
  await one.executeTool('quant_live_execution', input);
  await one.sendMessage('Continue checking the same operation');
  await one.executeTool('quant_live_execution', input);
  const two = agent(service, options);
  await two.loadFromHistory(saved);
  await two.sendMessage('Recover the result');
  await two.executeTool('quant_live_execution', input);
  assert.equal(new Set(calls.map((c) => c.input.operationId)).size, 1);
  assert.equal(two.allowedToolNames.has('runJavaScriptCode'), false);
});
test('Agent portfolio tool is paged/readable and can pause but cannot create, resume, release or clear fences', async () => {
  const calls = [],
    service = {
      saveConversation: async () => {},
      getWallet: () => ({
        request: async (action, input) => {
          calls.push({ action, input });
          return action === 'portfolio.list'
            ? {
                items: Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i })),
                total: 8,
                next: null,
              }
            : { state: 'active', revision: 3 };
        },
      }),
    };
  const worker = agent(service);
  const page = await worker.executeTool('quant_portfolios', { action: 'list' });
  assert.equal(page.items.length, 5);
  assert.equal(page.next, 5);
  await worker.executeTool('quant_portfolios', { action: 'pause', portfolioId: 'p1', revision: 3 });
  assert.equal(calls.at(-1).action, 'portfolio.pause');
  assert.equal(calls.at(-1).input.revision, 3);
  for (const action of ['create', 'active', 'removed', 'recover', 'confirm'])
    assert.equal((await worker.executeTool('quant_portfolios', { action })).ok, false);
  assert.ok(
    calls.every((c) => ['portfolio.list', 'portfolio.get', 'portfolio.pause'].includes(c.action)),
  );
});

test('an Agent may inspect or stop global live execution but cannot invoke the human reset path', async () => {
  const calls = [];
  const instance = agent({
    getWallet: () => ({
      request: async (action, input) => {
        calls.push({ action, input });
        return { halted: action === 'emergency.halt', generation: 'observed' };
      },
    }),
  });
  await instance.executeTool('quant_live_control', { action: 'status' });
  await instance.executeTool('quant_live_control', {
    action: 'halt',
    expectedGeneration: 'observed',
  });
  const denied = await instance.executeTool('quant_live_control', {
    action: 'reset',
    ack: 'RESET LIVE',
    confirmed: true,
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(
    calls.map((c) => c.action),
    ['emergency.status', 'emergency.halt'],
  );
  assert.equal(calls[1].input.expectedGeneration, 'observed');
});

test('an Agent can durably repeat its scoped emergency stop but cannot forge a human reset', async () => {
  const calls = [];
  const instance = agent({
    saveConversation: async () => {},
    request: async (action, input) => {
      calls.push({ action, input });
      return { ok: true };
    },
  });
  for (const callId of ['a', 'b'])
    await instance.executeTool(
      'quant_native_paper',
      { action: 'halt', operationId: 'stop', id: 'foreign' },
      { callId },
    );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.id, 'project-a');
  assert.equal(calls[0].input.operationId, calls[1].input.operationId);
  assert.equal(calls[0].action, 'native.paper.halt');
  const reset = await instance.executeTool('quant_native_paper', {
    action: 'reset-halt',
    expectedHalt: 'known',
    confirmed: true,
  });
  assert.equal(reset.error, 'UNKNOWN_QUANT_ACTION');
  assert.equal(calls.length, 2);
});
test('native paper logical operation identity persists across tool retries and restored Agent histories', async () => {
  const requests = [];
  let saved;
  const service = {
    saveConversation: async (_id, payload) => {
      saved = payload;
    },
    request: async (action, input) => {
      requests.push({ action, input });
      return { ok: true };
    },
  };
  const first = agent(service),
    input = {
      action: 'submit',
      operationId: 'buy-one',
      product: 'ETH-USD',
      side: 'buy',
      price: '100',
      quantity: '0.123456789012345678',
      id: 'foreign',
    };
  await first.executeTool('quant_native_paper', input, { callId: 'call-1' });
  await first.executeTool('quant_native_paper', input, { callId: 'call-2' });
  const restored = agent(service);
  await restored.loadFromHistory(saved);
  await restored.executeTool('quant_native_paper', input, { callId: 'call-3' });
  assert.equal(new Set(requests.map((r) => r.input.operationId)).size, 1);
  assert.ok(
    requests.every(
      (r) =>
        r.action === 'native.paper.submit' &&
        r.input.id === 'project-a' &&
        r.input.quantity === input.quantity,
    ),
  );
  await restored.executeTool(
    'quant_native_paper',
    { ...input, operationId: 'distinct-buy' },
    { callId: 'call-4' },
  );
  assert.notEqual(requests[3].input.operationId, requests[0].input.operationId);
  assert.equal(first.allowedToolNames.has('bash'), false);
  assert.equal(first.allowedToolNames.has('native.control'), false);
});
test('unknown native submissions expose their reconciliation ID without expanding tools', async () => {
  const service = {
    saveConversation: async () => {},
    request: async () => {
      throw Object.assign(Error('NATIVE_OUTCOME_UNKNOWN'), { orderId: 'paper:known' });
    },
  };
  const result = await agent(service).executeTool('quant_native_paper', {
    action: 'submit',
    operationId: 'one',
  });
  assert.deepEqual(result, { ok: false, error: 'NATIVE_OUTCOME_UNKNOWN', orderId: 'paper:known' });
});
test('native Agent reads bounded books with authoritative eligibility and immutable source evidence', async () => {
  const service = {
    request: async (action) => {
      assert.equal(action, 'native.source.book');
      return {
        eligible: false,
        bids: Array.from({ length: 50 }, (_, i) => [String(100 - i), '1']),
        asks: Array.from({ length: 50 }, (_, i) => [String(101 + i), '1']),
        providerTimeNs: '123',
        coverage: { bidFloor: '1' },
      };
    },
  };
  const instance = agent(service);
  const book = await instance.executeTool('quant_native_paper', {
    action: 'book',
    product: 'ETH-USD',
    limit: 3,
  });
  assert.equal(book.bids.length, 3);
  assert.equal(book.eligible, false);
  assert.equal(book.providerTimeNs, '123');
  assert.equal(book.coverage.bidFloor, '1');
});
test('strategy starts preserve their logical identity across tool calls and reject context workspace overrides', async () => {
  const requests = [];
  const service = {
    saveConversation: async () => {},
    request: async (action, input) => {
      requests.push({ action, input });
      return { ok: true };
    },
  };
  const instance = agent(service),
    input = {
      action: 'start',
      strategyId: 'strategy:example',
      operationId: 'deploy',
      revision: 1,
      mode: 'shadow',
      id: 'foreign',
    };
  await instance.executeTool('quant_strategy', input, { callId: 'one' });
  await instance.executeTool('quant_strategy', input, { callId: 'two' });
  assert.equal(requests[0].action, 'native.strategy.start');
  assert.equal(requests[0].input.operationId, requests[1].input.operationId);
  assert.equal(requests[0].input.id, 'project-a');
});
