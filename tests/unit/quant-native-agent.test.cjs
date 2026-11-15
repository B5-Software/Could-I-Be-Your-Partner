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
test('Base history passes only scoped read and recording arguments', async () => {
  const calls = [];
  const worker = agent({
    request: async (action, input, context) => {
      calls.push({ action, input, context });
      return { id: 'dataset-a' };
    },
  });
  await worker.executeTool('quant_base_history', {
    action: 'capture',
    count: 4,
    id: 'foreign',
    select: true,
  });
  await worker.executeTool('quant_base_history', {
    action: 'trades',
    datasetId: 'dataset-a',
    offset: 10,
    limit: 5,
  });
  await worker.executeTool('quant_base_history', {
    action: 'record_start',
    resume: true,
    id: 'foreign',
  });
  await worker.executeTool('quant_base_history', { action: 'record_status' });
  await worker.executeTool('quant_base_history', { action: 'record_stop' });
  await worker.executeTool('quant_base_history', {
    action: 'series',
    datasetId: 'dataset-a',
    windows: 300,
    id: 'foreign',
  });
  assert.deepEqual(
    calls.map(({ action, input }) => [action, input.id, input.select]),
    [
      ['base.history.capture', 'project-a', undefined],
      ['base.history.trades', 'project-a', undefined],
      ['base.history.record.start', 'project-a', undefined],
      ['base.history.record.status', 'project-a', undefined],
      ['base.history.record.stop', 'project-a', undefined],
      ['base.history.series', 'project-a', undefined],
    ],
  );
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.equal(calls[1].input.offset, 10);
  assert.equal(calls[2].input.resume, true);
  assert.equal(calls[5].input.windows, 300);
});
test('AMM replay tool pins its project and returns a compact report with paged evidence', async () => {
  const calls = [];
  const worker = agent({
    request: async (action, input, context) => {
      calls.push({ action, input, context });
      return action === 'run.amm'
        ? {
            id: 'amm-run',
            datasetId: 'dataset-a',
            metrics: { fills: 1 },
            ammReplay: {
              attempts: [{ amountInAtoms: '1' }],
              pendingAtEnd: null,
              networkFees: { mode: 'historical', usdcAtoms: '44' },
            },
          }
        : { items: [] };
    },
  });
  const run = await worker.executeTool('quant_amm_replay', {
    action: 'run',
    id: 'foreign',
    datasetId: 'dataset-a',
    initialCash: '100',
    delayBlocks: 3,
    feeMode: 'historical',
    tipGwei: '0.01',
    networkFeeCapUsdc: '0.5',
  });
  assert.equal(calls[0].input.id, 'project-a');
  assert.equal(calls[0].input.config.delayBlocks, 3);
  assert.equal(calls[0].input.config.tipGwei, '0.01');
  assert.equal(calls[0].input.config.networkFeeCapUsdc, '0.5');
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.equal(run.quotes, 1);
  assert.equal(run.networkFees.usdcAtoms, '44');
  assert.equal(run.ammReplay, undefined);
  await worker.executeTool('quant_amm_replay', {
    action: 'attempts',
    runId: 'amm-run',
    offset: 1,
    limit: 5,
  });
  assert.deepEqual(calls[1].input, { id: 'project-a', runId: 'amm-run', offset: 1, limit: 5 });
});
test('walk-forward Agent sees compact out-of-sample results and can read individual training rankings', async () => {
  const calls = [];
  const fold = {
    index: 1,
    selected: { fast: 5, slow: 21 },
    trainingScores: [{ fast: 5, slow: 21 }],
  };
  const worker = agent({
    request: async (action, input, context) => {
      calls.push({ action, input, context });
      return action === 'run.walk-forward'
        ? {
            id: 'walk-run',
            datasetId: 'tape',
            metrics: { bars: 30 },
            walkForward: { candidateCount: 2, windows: [fold] },
          }
        : fold;
    },
  });
  const run = await worker.executeTool('quant_walk_forward', {
    action: 'run',
    id: 'other',
    datasetId: 'tape',
    trainBars: 120,
  });
  assert.equal(calls[0].input.id, 'project-a');
  assert.equal(calls[0].input.datasetId, 'tape');
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.equal(run.candidateCount, 2);
  assert.equal(run.windows[0].trainingScores, undefined);
  assert.deepEqual(
    await worker.executeTool('quant_walk_forward', {
      action: 'fold',
      id: 'other',
      runId: run.id,
      fold: 1,
    }),
    fold,
  );
  assert.deepEqual(calls[1].input, { id: 'project-a', runId: 'walk-run', fold: 1 });
});
test('AMM scenario tool runs and reads evidence only in the current workspace', async () => {
  const calls = [];
  const report = { legs: [{ index: 1, status: 'filled', deltaOutAtoms: '0' }] };
  const worker = agent({
    request: async (action, input, context) => {
      calls.push({ action, input, context });
      return action === 'run.amm.scenario' ? { id: 'run-a', ammScenario: report } : report;
    },
  });
  const legs = [{ side: 'sell', amountIn: '0.25' }];
  const run = await worker.executeTool('quant_amm_scenario', {
    action: 'run',
    id: 'foreign',
    datasetId: 'tape-a',
    initialWeth: '1',
    anchorBlock: 123,
    legs,
  });
  assert.equal(calls[0].action, 'run.amm.scenario');
  assert.deepEqual(calls[0].input, {
    id: 'project-a',
    datasetId: 'tape-a',
    config: { initialWeth: '1', anchorBlock: 123, legs },
  });
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.deepEqual(run.legs, report.legs);
  const saved = await worker.executeTool('quant_amm_scenario', {
    action: 'get',
    id: 'foreign',
    runId: run.id,
  });
  assert.deepEqual(calls[1].input, { id: 'project-a', runId: 'run-a' });
  assert.equal(calls[1].action, 'run.amm.scenario.get');
  assert.deepEqual(saved, report);
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
  const validation = {
    ...input,
    action: 'replay_validate',
    operationId: 'validation',
    revisions: [1, 2],
    trainMs: 2000,
    testMs: 1000,
    folds: 2,
  };
  await first.executeTool('quant_event_data', validation, { callId: 'c' });
  await second.executeTool('quant_event_data', validation, { callId: 'd' });
  assert.equal(calls[2].action, 'replay.validate');
  assert.equal(calls[2].input.id, 'project-a');
  assert.equal(calls[2].input.operationId, calls[3].input.operationId);
  assert.notEqual(calls[2].input.operationId, calls[0].input.operationId);
  await second.executeTool('quant_event_data', {
    action: 'replay_history',
    id: 'foreign',
    replayId: 'report',
    kind: 'executions',
    fold: 2,
    trainingRevision: 1,
  });
  assert.equal(calls[4].input.id, 'project-a');
  assert.equal(calls[4].input.fold, 2);
  assert.equal(calls[4].input.trainingRevision, 1);
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
          if (action.startsWith('portfolio.allowances.'))
            return { items: [], block: '123', reportId: 'saved-report', next: null };
          if (action === 'portfolio.holdings')
            return {
              complete: true,
              assets: [{ symbol: 'ETH', amountAtomic: '1' }],
              members: [{ walletId: 'one' }, { walletId: 'two' }],
            };
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
  const totals = await worker.executeTool('quant_portfolios', {
    action: 'holdings',
    portfolioId: 'p1',
  });
  assert.equal(totals.memberCount, 2);
  assert.equal(totals.members, undefined);
  const details = await worker.executeTool('quant_portfolios', {
    action: 'holdings',
    portfolioId: 'p1',
    includeMembers: true,
    valuation: true,
  });
  assert.equal(details.members.length, 2);
  assert.deepEqual(calls.at(-1).input, { id: 'p1', valuation: true });
  const scanned = await worker.executeTool('quant_portfolios', {
    action: 'allowances_scan',
    portfolioId: 'p1',
    mode: 'older',
    previousReportId: 'prior',
    blocks: 20,
  });
  assert.equal(scanned.reportId, 'saved-report');
  assert.equal(calls.at(-1).action, 'portfolio.allowances.scan');
  assert.equal(calls.at(-1).input.previousReportId, 'prior');
  assert.equal(calls.at(-1).input.limit, 5);
  await worker.executeTool('quant_portfolios', {
    action: 'allowances_get',
    portfolioId: 'p1',
    reportId: scanned.reportId,
    filter: 'review',
    offset: 5,
  });
  assert.equal(calls.at(-1).action, 'portfolio.allowances.get');
  assert.equal(calls.at(-1).input.offset, 5);
  await worker.executeTool('quant_portfolios', { action: 'allowances_list', portfolioId: 'p1' });
  assert.equal(calls.at(-1).action, 'portfolio.allowances.list');
  await worker.executeTool('quant_portfolios', {
    action: 'allowance_monitor',
    portfolioId: 'p1',
    offset: 4,
  });
  assert.deepEqual(calls.at(-1), {
    action: 'portfolio.allowanceMonitor.get',
    input: { id: 'p1', offset: 4, limit: 5 },
  });
  await worker.executeTool('quant_portfolios', { action: 'pause', portfolioId: 'p1', revision: 3 });
  assert.equal(calls.at(-1).action, 'portfolio.pause');
  assert.equal(calls.at(-1).input.revision, 3);
  for (const action of [
    'create',
    'active',
    'removed',
    'recover',
    'confirm',
    'allowances_revoke',
    'allowance_monitor_stop',
  ])
    assert.equal((await worker.executeTool('quant_portfolios', { action })).ok, false);
  assert.ok(
    calls.every((c) =>
      [
        'portfolio.list',
        'portfolio.get',
        'portfolio.holdings',
        'portfolio.pause',
        'portfolio.allowances.scan',
        'portfolio.allowances.get',
        'portfolio.allowances.list',
        'portfolio.allowanceMonitor.get',
      ].includes(c.action),
    ),
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
