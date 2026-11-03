/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { stripAnsi } = require('../../src/tui/ansi');
const { setLanguage } = require('../../src/tui/text');
function fixture(handler) {
  const requests = [];
  const app = new TuiApp({
    width: 110,
    height: 42,
    runtime: {
      getSettings: async () => ({ features: { quant: true } }),
      api: {
        backendRequest: async (method, action, input) => {
          requests.push({ method, action, input });
          return handler(method, action, input);
        },
      },
    },
  });
  return { app, requests };
}

test('TUI periodic budgets keep lifetime counters separate, show archived dates and preserve the schedule during a reviewed edit', async (t) => {
  setLanguage('en');
  const { nativeLimits, limits } = require('../../src/main/services/wallet/policy');
  const rules = nativeLimits(
    limits({ maxTransactions: 20, period: { seconds: 3600, maxTransactions: 3 } }),
  );
  const snapshot = {
    portfolio: {
      id: 'period-group',
      name: 'Shared budget',
      chainId: 8453,
      members: [{ walletId: 'wallet', address: '0x' + '1'.repeat(40) }],
      limits: rules,
      expiresAt: 0,
      maxFeeWei: '2000000000000000',
    },
    state: 'active',
    revision: 4,
    usage: { valueWei: '1000000000000000', feeWei: '21000', transactions: 7, tokens: {} },
    period: {
      identity: { kind: 'portfolio', id: 'period-group' },
      seconds: 3600,
      originMs: 1700000000000,
      startMs: 1700000000000,
      endMs: 1700003600000,
      limits: rules.period,
      usage: { valueWei: '0', feeWei: '21000', transactions: 2, tokens: {} },
    },
  };
  const archived = {
    startMs: 1699996400000,
    endMs: 1700000000000,
    limits: rules.period,
    usage: snapshot.period.usage,
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'portfolio.get') return snapshot;
    if (action === 'list') return { wallets: [{ id: 'wallet', name: 'One' }] };
    if (action === 'period.history') return { items: [archived], total: 1, next: null };
    if (action === 'portfolio.challenge') return { id: 'frozen-period-edit' };
    return { ok: true };
  });
  t.after(() => app.dispose());
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const panel = new TuiWalletPortfolios(app.walletBrowser);
  const choose = (value) => {
    const index = app.state.modal.options.findIndex((o) => o.value === value);
    assert.ok(index >= 0, 'Missing menu option: ' + value);
    return app._chooseModalOption(index);
  };
  await panel.detail('period-group');
  await choose('usage');
  assert.ok(app.state.modal.body.includes('7 / 20'));
  assert.ok(app.state.modal.body.includes('Next quota reset'));
  await choose('next');
  assert.ok(app.state.modal.body.includes('2 / 3'));
  await choose('history');
  assert.deepEqual(requests.at(-1).input, {
    kind: 'portfolio',
    id: 'period-group',
    offset: 0,
    limit: 2,
  });
  await choose(0);
  assert.ok(app.state.modal.body.includes(new Date(archived.startMs).toLocaleString('en')));
  assert.ok(!app.state.modal.body.includes('Next quota reset'));
  await panel.detail('period-group');
  await choose('edit');
  await choose('scope');
  await choose('period');
  assert.ok(!app.state.modal.options.some((o) => ['toggle', 'seconds'].includes(o.value)));
  await choose('maxTransactions');
  app.state.modal.editor.setValue('4');
  await app.state.modal.onSubmit();
  await choose('back');
  await choose('continue');
  await choose('review');
  assert.ok(app.state.modal.body.includes('0.002'));
  assert.ok(app.state.modal.body.includes('Keep current expiry'));
  assert.ok(app.state.modal.body.includes('3600 s'));
  assert.ok(!requests.some((r) => r.action === 'portfolio.challenge'));
  await choose(true);
  const proposal = requests.at(-1);
  assert.equal(proposal.action, 'portfolio.challenge');
  assert.equal(proposal.input.revision, 4);
  assert.equal(proposal.input.hours, undefined);
  assert.equal(proposal.input.limits.period.seconds, 3600);
  assert.equal(proposal.input.limits.period.maxTransactions, '4');
  assert.ok(!requests.some((r) => r.action === 'portfolio.confirm'));
  app.state.modal.editor.setValue('ALLOW PORTFOLIO');
  await app.state.modal.onSubmit();
  const confirmed = requests.find((r) => r.action === 'portfolio.confirm');
  assert.deepEqual(confirmed.input, {
    challengeId: 'frozen-period-edit',
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  assert.equal(
    snapshot.portfolio.limits.period.maxTransactions,
    3,
    'editing never mutates the current snapshot',
  );
});

test('TUI Agent scope separates inherited usage from actions and requires review before its human resume acknowledgement', async () => {
  setLanguage('en');
  const { nativeLimits, limits } = require('../../src/main/services/wallet/policy');
  const snapshot = {
    scope: {
      id: 'scope',
      subject: 'native-sub-test',
      label: 'Execution task',
      chainId: 8453,
      walletIds: ['wallet'],
      limits: nativeLimits(limits({ maxTransactions: 6 })),
      expiresAt: 0,
      parentId: 'root',
    },
    state: 'paused',
    revision: 2,
    ready: false,
    reason: 'WALLET_AGENT_SCOPE_PAUSED',
    usage: { valueWei: '0', feeWei: '0', transactions: 3, tokens: {} },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'scope.get' ? snapshot : action === 'scope.challenge' ? { id: 'frozen-review' } : {},
  );
  const { TuiWalletAgentScopes } = require('../../src/tui/wallet-agent-scopes');
  const panel = new TuiWalletAgentScopes(app.walletBrowser);
  await panel.detail('scope');
  assert.ok(app.state.modal.body.includes('native-sub-test'));
  assert.ok(app.state.modal.body.includes('paused'));
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'usage'));
  assert.ok(app.state.modal.body.includes('3 / 6'));
  await app._chooseModalOption(0);
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'active'));
  assert.equal(
    requests.some((r) => r.action === 'scope.challenge'),
    false,
  );
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === true));
  assert.equal(requests.at(-1).action, 'scope.challenge');
  assert.deepEqual(requests.at(-1).input, { id: 'scope', revision: 2, kind: 'active' });
  assert.ok(app.state.modal.title.includes('ALLOW AGENT SCOPE'));
  assert.equal(
    requests.some((r) => r.action === 'scope.confirm'),
    false,
  );
  app.dispose();
});

test('TUI can reconcile an interrupted signature while locked without requesting new authority', async () => {
  setLanguage('en');
  const intent = {
    id: 'interrupted',
    status: 'signing-unknown',
    transaction: { data: '0x' },
    description: { kind: 'native-transfer' },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'intent.inspect' ? intent : { ...intent, hash: '0x' + 'a'.repeat(64) },
  );
  await app.walletBrowser.inspect(intent.id, 0, () => {});
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('budget and nonce remain reserved'));
  const index = app.state.modal.options.findIndex((o) => o.value === 'reconcile');
  assert.ok(index >= 0);
  await app._chooseModalOption(index);
  assert.deepEqual(
    requests.map((r) => r.action),
    ['intent.inspect', 'intent.reconcile'],
  );
  assert.equal(requests.at(-1).input.id, intent.id);
  app.dispose();
});

test('TUI displays nonce replacement warning and sends the exact previous hash only on explicit approval', async () => {
  setLanguage('en');
  const intent = {
    id: 'replacement',
    status: 'approval-required',
    replacementOf: '0x' + 'b'.repeat(64),
    digest: 'exact-digest',
    transaction: { data: '0x' },
    description: { kind: 'native-transfer' },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'intent.inspect' ? intent : {},
  );
  await app.walletBrowser.inspect(intent.id, 0, () => {});
  assert.ok(app.state.modal.body.includes('This nonce already has a signed transaction'));
  const option = app.state.modal.options.findIndex((o) => o.value === 'approve');
  assert.ok(app.state.modal.options[option].label.includes('Confirm replacement'));
  await app._chooseModalOption(option);
  assert.deepEqual(requests.at(-1).input, {
    id: intent.id,
    digest: intent.digest,
    replacementOf: intent.replacementOf,
  });
  app.dispose();
});

test('TUI password rotation uses masked inputs and never submits mismatched confirmation', async () => {
  setLanguage('en');
  const wallet = {
    id: 'test-wallet',
    name: 'Test',
    address: '0x' + '1'.repeat(40),
    policy: { mode: 'manual' },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'list'
      ? { wallets: [wallet], intents: [], emergency: { halted: false } }
      : { ok: true },
  );
  app.walletBrowser.changePassword(wallet);
  for (const value of ['old-test-password', 'new-test-password', 'different-test-password']) {
    assert.equal(app.state.modal.masked, true);
    app.state.modal.editor.setValue(value);
    try {
      await app.state.modal.onSubmit();
    } catch (error) {
      assert.match(error.message, /match/);
    }
  }
  assert.ok(!requests.some((r) => r.action === 'password.change'));
  app.walletBrowser.changePassword(wallet);
  for (const value of ['old-test-password', 'new-test-password', 'new-test-password']) {
    assert.equal(app.state.modal.masked, true);
    app.state.modal.editor.setValue(value);
    await app.state.modal.onSubmit();
  }
  const changed = requests.find((r) => r.action === 'password.change');
  assert.equal(changed.input.password, 'old-test-password');
  assert.equal(changed.input.newPassword, 'new-test-password');
  assert.ok(!stripAnsi(app.frame().lines.join('\n')).includes('new-test-password'));
  app.dispose();
});

test('TUI global live stop is immediate while clearing requires a separate warning and exact second confirmation', async () => {
  setLanguage('en');
  const wallet = {
    id: 'stopped-wallet',
    name: 'Stopped wallet',
    address: '0x' + '1'.repeat(40),
    unlocked: false,
    policy: { mode: 'manual' },
  };
  const state = { halted: false, generation: 'initial', needsReconciliation: 0 };
  const { app, requests } = fixture((_method, action, input) => {
    if (action === 'list') return { wallets: [wallet], intents: [], emergency: { ...state } };
    if (action === 'emergency.halt') {
      assert.equal(input.expectedGeneration, 'initial');
      state.halted = true;
      state.generation = 'latch';
      return { ...state };
    }
    if (action === 'emergency.challenge') return { id: 'human:challenge' };
    if (action === 'emergency.reset') {
      assert.equal(input.challengeId, 'human:challenge');
      assert.equal(input.ack, 'RESET LIVE');
      assert.equal(input.confirmed, true);
      state.halted = false;
      state.generation = 'reset';
      return { ...state };
    }
    return { ok: true };
  });
  await app.walletBrowser.open();
  await chooseLive(app, 'emergency-stop');
  assert.equal(state.halted, true);
  await app._chooseModalOption(
    app.state.modal.options.findIndex((option) => option.value?.id === wallet.id),
  );
  assert.equal(
    app.state.modal.options.some((option) => ['unlock', 'automatic'].includes(option.value)),
    false,
  );
  await chooseLive(app, 'back');
  await chooseLive(app, 'emergency-reset');
  assert.equal(
    requests.some((call) => call.action === 'emergency.reset'),
    false,
  );
  await chooseLive(app, 'continue');
  assert.equal(
    requests.some((call) => call.action === 'emergency.reset'),
    false,
  );
  app.state.modal.editor.setValue('RESET LIVE');
  await app._handleModalKey({ name: 'enter' });
  assert.equal(state.halted, false);
  assert.equal(
    requests.some((call) => call.action === 'unlock' || call.action === 'policy.grant'),
    false,
  );
});

function liveFixture() {
  const wallet = {
    id: 'wallet:one',
    name: 'Named local wallet',
    address: '0x' + 'a'.repeat(40),
    unlocked: true,
    policy: { mode: 'manual', chains: [8453] },
  };
  const run = {
    plan: {
      id: 'execution:one',
      wallet: wallet.id,
      chain_id: 8453,
      side: 'buy',
      total_input_atoms: '100000000',
      slices: 2,
      interval_ms: 60000,
      slippage_bps: 50,
    },
    phase: 'paused',
    pending: null,
    completed_slices: 0,
    allocated_input_atoms: '0',
  };
  let failCreate = false;
  const result = fixture((method, action) => {
    if (method === 'wallet:request') return { wallets: [wallet] };
    if (action === 'workspace.get') return { market: { venue: 'base' } };
    if (action === 'execution.list') return { items: [run], next: null, total: 1 };
    if (action === 'execution.commands') return { items: [], next: null, total: 0 };
    if (action === 'execution.create') {
      if (failCreate) {
        failCreate = false;
        throw Error('fixture ACK lost');
      }
      return run;
    }
    if (action === 'execution.start') run.phase = 'running';
    if (action === 'execution.stop') run.phase = 'stopped';
    return {
      run,
      feeUsage: { reservedEstimateWei: '0', budgetWei: '10000000000000000' },
      lastError: null,
    };
  });
  const { LiveExecutionBrowser } = require('../../src/tui/quant-execution');
  return {
    ...result,
    wallet,
    run,
    browser: new LiveExecutionBrowser(result.app.quantBrowser),
    fail: () => {
      failCreate = true;
    },
  };
}
async function chooseLive(app, value) {
  const index = app.state.modal.options.findIndex((option) => option.value === value);
  assert.ok(index >= 0, value);
  await app._chooseModalOption(index);
}
test('TUI portfolio creation selects named wallets and uses the shared scope plus a separate human confirmation', async () => {
  setLanguage('en');
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const wallets = [
    { id: 'one', name: 'Research', address: '0x' + '1'.repeat(40) },
    { id: 'two', name: 'Execution', address: '0x' + '2'.repeat(40) },
  ];
  const { app, requests } = fixture((_method, action) =>
    action === 'list'
      ? { wallets, intents: [] }
      : action === 'portfolio.challenge'
        ? { id: 'challenge' }
        : action === 'portfolio.list'
          ? { items: [], total: 0, next: null }
          : {},
  );
  const browser = new TuiWalletPortfolios(app.walletBrowser);
  await browser.create();
  app.state.modal.editor.setValue('Shared portfolio');
  await app.state.modal.onSubmit();
  await chooseLive(app, 8453);
  await chooseLive(app, 'one');
  await chooseLive(app, 'two');
  await chooseLive(app, 'next');
  await chooseLive(app, 24);
  app.state.modal.editor.setValue('0.01');
  await app.state.modal.onSubmit();
  await chooseLive(app, 'continue');
  assert.ok(app.state.modal.body.includes('Research · Execution'));
  assert.equal(
    requests.some((r) => r.action === 'portfolio.confirm'),
    false,
  );
  await chooseLive(app, true);
  app.state.modal.editor.setValue('ALLOW PORTFOLIO');
  await app.state.modal.onSubmit();
  const challenge = requests.find((r) => r.action === 'portfolio.challenge');
  assert.deepEqual(challenge.input.walletIds, ['one', 'two']);
  assert.equal(challenge.input.chainId, 8453);
  assert.equal(requests.find((r) => r.action === 'portfolio.confirm').input.ack, 'ALLOW PORTFOLIO');
  assert.ok(!requests.some((r) => ['unlock', 'policy.grant', 'intent.approve'].includes(r.action)));
  app.dispose();
});
test('TUI portfolio detail separates scope and paged usage while a paused group cannot offer another pause', async () => {
  setLanguage('en');
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const policy = require('../../src/main/services/wallet/policy');
  const limits = policy.nativeLimits(
    policy.limits({
      maxTransactions: 6,
      tokens: [
        {
          chainId: 8453,
          address: '0x' + '3'.repeat(40),
          symbol: 'USDC',
          decimals: 6,
          maxSignedAmount: '100',
        },
      ],
    }),
  );
  const snapshot = {
    portfolio: {
      id: 'group',
      name: 'Shared',
      chainId: 8453,
      members: [{ walletId: 'one', address: '0x' + '1'.repeat(40) }],
      limits,
    },
    state: 'paused',
    revision: 2,
    usage: { valueWei: '0', feeWei: '0', transactions: 3, tokens: {} },
  };
  const { app } = fixture((_method, action) =>
    action === 'portfolio.get'
      ? snapshot
      : { wallets: [{ id: 'one', name: 'Research' }], intents: [] },
  );
  const browser = new TuiWalletPortfolios(app.walletBrowser);
  await browser.detail('group');
  assert.ok(app.state.modal.body.includes('Paused'));
  assert.ok(app.state.modal.body.includes('Research'));
  assert.ok(!app.state.modal.options.some((o) => o.value === 'pause'));
  await chooseLive(app, 'usage');
  assert.ok(app.state.modal.body.includes('3 / 6'));
  await chooseLive(app, 'next');
  assert.ok(app.state.modal.body.includes('Transfers / swap inputs'));
  await chooseLive(app, 'back');
  await chooseLive(app, 'scope');
  assert.ok(app.state.modal.body.includes('Maximum signatures'));
  app.dispose();
});
test('TUI token editor uses named preset and amount fields, and native usage remains readable while locked', async () => {
  setLanguage('en');
  const { app, requests } = fixture(() => ({
    limits: { maxTotalValueWei: '0', maxTotalFeeWei: '0', maxTransactions: 5, tokens: [] },
    usage: { valueWei: '0', feeWei: '0', transactions: 2, tokens: {} },
  }));
  const browser = app.walletBrowser,
    limits = { tokens: [] };
  let returned = false;
  browser.tokenScope(limits, () => {
    returned = true;
  });
  await chooseLive(app, 'add');
  await chooseLive(app, 0);
  await chooseLive(app, 'maxSignedAmount');
  app.state.modal.editor.setValue('12.000001');
  await app.state.modal.onSubmit();
  assert.equal(limits.tokens[0].symbol, 'USDC');
  assert.equal(limits.tokens[0].decimals, 6);
  assert.equal(limits.tokens[0].maxSignedAmount, '12.000001');
  await chooseLive(app, 'back');
  await chooseLive(app, 'back');
  assert.equal(returned, true);
  browser.account({
    id: 'fixture',
    name: 'Fixture',
    unlocked: false,
    policy: { mode: 'autonomous', chains: [8453] },
  });
  await chooseLive(app, 'usage');
  assert.ok(app.state.modal.body.includes('2 / 5'));
  assert.deepEqual(
    requests.map((r) => r.action),
    ['policy.usage'],
  );
  app.dispose();
});
test('TUI live plans create paused drafts with exact decimal input and preserve identity after a lost ACK', async () => {
  setLanguage('en');
  const { app, browser, requests, fail } = liveFixture();
  await browser.editor('project');
  browser.draft.side = 'sell';
  browser.draft.totalInput = '0.123456789012345678';
  fail();
  await chooseLive(app, 'leSave');
  assert.match(app.state.modal.body, /ACK lost/);
  await chooseLive(app, 'leSave');
  const creates = requests.filter((call) => call.action === 'execution.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].input.operationId, creates[1].input.operationId);
  assert.equal(creates[0].input.totalInput, '0.123456789012345678');
  assert.equal(creates[0].input.walletId, 'wallet:one');
  assert.equal(creates[0].input.id, 'project');
  assert.equal(
    requests.some((call) => call.action === 'execution.start'),
    false,
  );
  assert.equal(
    app.state.modal.options.some((option) => option.value === 'leStart'),
    false,
  );
});
test('TUI live start respects wallet authority and stop targets the displayed scoped plan', async () => {
  setLanguage('en');
  const { app, browser, requests, wallet } = liveFixture();
  await browser.detail('project', 'execution:one');
  assert.equal(
    app.state.modal.options.some((option) => option.value === 'leStart'),
    false,
  );
  wallet.policy.mode = 'autonomous';
  await browser.detail('project', 'execution:one');
  await chooseLive(app, 'leStart');
  assert.ok(app.state.modal.options.some((option) => option.value === 'leStop'));
  await chooseLive(app, 'leStop');
  for (const action of ['execution.start', 'execution.stop']) {
    const request = requests.find((call) => call.action === action);
    assert.equal(request.input.runId, 'execution:one');
    assert.equal(request.input.id, 'project');
  }
});
test('live progress formatting preserves onchain integer precision and handles zero-decimal assets', () => {
  const { executionAmount, executionPercent } = require('../../src/shared/quant-execution-format');
  assert.equal(executionAmount('1000000000000000001', 18), '1.000000000000000001');
  assert.equal(executionAmount('9007199254740993', 0), '9007199254740993');
  assert.equal(executionAmount('1', -1), '—');
  assert.equal(executionPercent('1', '3'), 33.33);
  assert.equal(executionPercent('999', '10'), 100);
});
test('TUI recorded-event replay selects a named strategy and explicit revision through shared project-scoped controls', async () => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) =>
    action === 'native.strategy.list'
      ? { items: [{ definition: { id: 'strategy:one', name: 'Maker', revision: 3 } }], next: null }
      : action === 'replay.start'
        ? { replayId: 'result' }
        : action === 'replay.get'
          ? { name: 'Experiment', status: 'running', processed: 2, planHash: 'hash' }
          : { items: [], next: null },
  );
  const { EventDataBrowser } = require('../../src/tui/quant-events');
  const browser = new EventDataBrowser(app.quantBrowser);
  await browser.replay('project', 'recording');
  await app._chooseModalOption(
    app.state.modal.options.findIndex((o) => o.value === 'strategy:one'),
  );
  app.state.modal.editor.setValue('2');
  await app._handleModalKey({ name: 'enter' });
  const call = requests.find((r) => r.action === 'replay.start');
  assert.equal(call.input.id, 'project');
  assert.equal(call.input.revision, 2);
  assert.equal(call.input.recordingId, 'recording');
  assert.ok(call.input.operationId);
  assert.match(app.state.modal.title, /Experiment/);
});
test('TUI native paper orders use human menus, preserve decimal text and route through the scoped shared backend', async () => {
  setLanguage('en');
  const account = {
    id: 'paper:one',
    name: 'Shared paper',
    active: true,
    assets: { USD: { total: '1000', reserved: '0' } },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'native.paper.status' ? { connected: true, account, sources: [] } : { ok: true },
  );
  await app.quantBrowser.nativePaper('project');
  const choose = async (value) => {
    const index = app.state.modal.options.findIndex((o) => o.value === value);
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  assert.match(app.state.modal.body, /Shared paper/);
  await choose('submit');
  await choose('ETH-USD');
  await choose('buy');
  app.state.modal.editor.setValue('100.5');
  await app._handleModalKey({ name: 'enter' });
  app.state.modal.editor.setValue('0.123456789012345678');
  await app._handleModalKey({ name: 'enter' });
  const submitted = requests.find((r) => r.action === 'native.paper.submit');
  assert.equal(submitted.input.id, 'project');
  assert.equal(submitted.input.price, '100.5');
  assert.equal(submitted.input.quantity, '0.123456789012345678');
  assert.equal(
    requests.some((r) => r.action === 'native.control'),
    false,
  );
});
test('TUI unresolved native orders require an explicit reconciliation action before another order', async () => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) =>
    action === 'native.paper.status'
      ? {
          connected: true,
          account: { name: 'Paper', active: true, assets: {} },
          pendingOrder: { orderId: 'paper:unknown' },
        }
      : { state: 'found' },
  );
  await app.quantBrowser.nativePaper('project');
  assert.equal(
    app.state.modal.options.some((o) => o.value === 'submit'),
    false,
  );
  assert.equal(
    requests.some((r) => r.action === 'native.paper.reconcile'),
    false,
  );
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'reconcile'));
  assert.equal(requests.filter((r) => r.action === 'native.paper.reconcile').length, 1);
});
test('TUI strategy controls show pinned revisions and start shadow runs through the scoped backend', async () => {
  setLanguage('en');
  const definition = { id: 'strategy:test', name: 'Maker', revision: 3, maker: {} };
  const { app, requests } = fixture((_method, action) =>
    action === 'native.strategy.get'
      ? { definition, hash: 'abc' }
      : action === 'native.strategy.runs'
        ? { items: [], next: null }
        : action === 'native.strategy.list'
          ? { connected: true, items: [{ definition, hash: 'abc' }], next: null }
          : { ok: true },
  );
  await app.quantBrowser.strategiesBrowser.open('project');
  await app._chooseModalOption(
    app.state.modal.options.findIndex((o) => o.value === 'strategy:test'),
  );
  assert.match(app.state.modal.title, /v3/);
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'nsShadow'));
  const call = requests.find((r) => r.action === 'native.strategy.start');
  assert.equal(call.input.id, 'project');
  assert.equal(call.input.revision, 3);
  assert.equal(call.input.mode, 'shadow');
  assert.ok(call.input.operationId);
});
test('TUI wallet secrets use masked input, never become chat messages, and clear on cancel', async () => {
  setLanguage('en');
  const wallet = {
    id: 'one',
    name: 'My wallet',
    address: '0x' + '1'.repeat(40),
    unlocked: false,
    policy: { mode: 'manual' },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'list' ? { wallets: [wallet], intents: [] } : { ok: true },
  );
  await app.walletBrowser.open();
  await app._chooseModalOption(1);
  await app._chooseModalOption(1);
  await app._chooseModalOption(0);
  assert.equal(app.state.modal.masked, true);
  const editor = app.state.modal.editor;
  editor.setValue('THIS-IS-A-PRIVATE-PASSWORD');
  const text = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(!text.includes('THIS-IS-A-PRIVATE-PASSWORD'));
  assert.ok(!JSON.stringify(app.state.messages).includes('PRIVATE-PASSWORD'));
  app._cancelModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editor.value, '');
  assert.equal(requests.filter((r) => r.action === 'unlock').length, 0);
});
test('TUI scope settings use editable named fields and keep automatic replacement behind human review', async () => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) =>
    action === 'policy.challenge' ? { id: 'challenge' } : { wallets: [], intents: [] },
  );
  app.walletBrowser.policyScope({ id: 'test' }, (limits) =>
    app.walletBrowser.call('policy.challenge', { id: 'test', chains: [8453], limits }),
  );
  const choose = (value) =>
    app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === value));
  await choose('maxTotalValueEth');
  app.state.modal.editor.setValue('0.2');
  await app._handleModalKey({ name: 'enter' });
  await choose('allowReplacement');
  assert.equal(requests.length, 0);
  await choose('continue');
  assert.equal(requests[0].input.limits.maxTotalValueEth, '0.2');
  assert.equal(requests[0].input.limits.allowReplacement, true);
  assert.ok(!requests.some((r) => r.action === 'policy.grant'));
  app.dispose();
});

test('TUI autonomous permission requires warning, a dedicated challenge and exact second confirmation', async () => {
  const calls = [];
  const { app } = fixture((_method, action, input) => {
    calls.push({ action, input });
    if (action === 'policy.challenge') return { id: 'challenge' };
    if (action === 'policy.grant') {
      assert.equal(input.ack, 'ALLOW LIVE');
      return { ok: true };
    }
    return { wallets: [], intents: [] };
  });
  app.walletBrowser.authorization({ id: 'one', name: 'Wallet', address: '0x' + '1'.repeat(40) });
  await app._chooseModalOption(0);
  await app._chooseModalOption(0);
  app.state.modal.editor.setValue('0.01');
  await app._handleModalKey({ name: 'enter' });
  assert.ok(app.state.modal.body.includes('ETH limits cover transaction value'));
  await app._chooseModalOption(1);
  assert.match(app.state.modal.body, /continuous transfers/);
  assert.equal(calls.length, 0);
  assert.equal(app.state.modal.selected, 0, 'Cancel must be the default');
  await app._chooseModalOption(1);
  assert.equal(calls[0].action, 'policy.challenge');
  assert.equal(calls.filter((c) => c.action === 'policy.grant').length, 0);
  app.state.modal.editor.setValue('ALLOW LIVE');
  await app._handleModalKey({ name: 'enter' });
  assert.equal(calls.filter((c) => c.action === 'policy.grant').length, 1);
});
test('TUI live approval shows exact intent details and uses the immutable approval digest', async () => {
  const intent = {
    id: 'intent',
    digest: 'exact-reviewed-digest',
    status: 'approval-required',
    network: 'Base',
    address: 'from',
    valueEth: '0.01',
    executionFeeMaxWei: '1000',
    l1FeeEstimateWei: '10',
    description: { kind: 'contract-call', calldata: '0x1234' },
    transaction: { to: '0x' + '2'.repeat(40), data: '0x1234' },
  };
  const { app, requests } = fixture((_method, action) =>
    action === 'intent.inspect' ? intent : { ok: true },
  );
  await app.walletBrowser.inspect('intent', 0, () => {});
  assert.match(app.state.modal.body, /0\.01/);
  assert.ok(app.state.modal.body.includes(intent.transaction.to));
  await app._chooseModalOption(3);
  const approval = requests.find((r) => r.action === 'intent.approve');
  assert.equal(approval.input.digest, intent.digest);
  assert.ok(!app.state.messages.some((m) => String(m.text).includes('exact-reviewed-digest')));
});
test('TUI quant project names select the shared research session and refresh proxy state before attaching', async () => {
  let attached,
    refreshed = false;
  const project = { id: 'id-one', name: 'My Base project', venue: 'base', paperStatus: 'paused' };
  const { app } = fixture((_method, action) => {
    if (action === 'workspace.list') return [project];
    if (action === 'workspace.get')
      return {
        ...project,
        market: { venue: 'base', product: 'WETH-USDC' },
        paper: { status: 'paused', cash: '10000', position: '0' },
      };
    if (action === 'chat.open') return { key: 'quant:id-one' };
  });
  app.runtime.refresh = async () => {
    refreshed = true;
  };
  app._switchSession = async (key) => {
    assert.equal(refreshed, true);
    attached = key;
  };
  await app.quantBrowser.open();
  const projectIndex = app.state.modal.options.findIndex((option) => option.value === project.id);
  assert.ok(
    projectIndex >= 0 && app.state.modal.options[projectIndex].label.includes('My Base project'),
  );
  await app._chooseModalOption(projectIndex);
  const chatIndex = app.state.modal.options.findIndex((option) => option.value === 'chat');
  assert.ok(chatIndex >= 0);
  await app._chooseModalOption(chatIndex);
  assert.equal(attached, 'quant:id-one');
});
test('TUI wallet notices do not reopen an authorization dialog or approve anything automatically', async () => {
  const { app, requests } = fixture(() => ({
    wallets: [],
    intents: [{ id: 'pending', status: 'approval-required' }],
  }));
  await app.walletBrowser.changed();
  assert.match(app.state.toast.text, /\/wallet/);
  assert.equal(app.state.modal, null);
  assert.ok(!requests.some((r) => r.action.includes('approve') || r.action.includes('grant')));
});
test('TUI research history offers named sources and reads archived pages without raw settings or trading actions', async () => {
  setLanguage('en');
  const evidenceId = 'a'.repeat(64);
  const { app, requests } = fixture((_method, action, input) =>
    action === 'history.list'
      ? {
          items: [{ title: 'Original announcement', evidenceId }],
          nextOffset: null,
        }
      : action === 'research.read'
        ? {
            title: 'Original announcement',
            retrievedAt: '2026-10-26T00:00:00Z',
            publishedAtReported: null,
            kind: 'article',
            archiveCompleteDocument: false,
            content: input.offset ? 'Later source text' : 'First source text',
            nextOffset: input.offset ? null : 4000,
          }
        : {},
  );
  await app.quantBrowser.history('project', 'research');
  const index = app.state.modal.options.findIndex(
    (option) => option.value === 'source:' + evidenceId,
  );
  assert.ok(index >= 0);
  await app._chooseModalOption(index);
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('First source text'));
  const next = app.state.modal.options.findIndex((option) => option.value === 'next');
  await app._chooseModalOption(next);
  assert.equal(requests.at(-1).input.offset, 4000);
  assert.ok(stripAnsi(app.frame().lines.join('\n')).includes('Later source text'));
  assert.ok(
    requests.every((request) => ['history.list', 'research.read'].includes(request.action)),
  );
});
test('TUI continuous books use the shared source service and a human-readable menu without enabling execution', async () => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) =>
    action === 'native.status'
      ? { available: true, state: 'connected' }
      : action === 'native.source.status'
        ? {
            products: ['ETH-USD'],
            sources: [
              {
                product: 'ETH-USD',
                instrument: 'source',
                phase: 'ready',
                desired: true,
                assumptions: { feeBps: 10 },
              },
            ],
          }
        : action === 'native.source.book'
          ? {
              eligible: true,
              assumptions: { feeBps: 10, quoteCurrency: 'USD' },
              source: { clock: null },
              bids: [['99', '10']],
              asks: [['101', '5']],
            }
          : {},
  );
  await app.quantBrowser.native();
  await app._chooseModalOption(
    app.state.modal.options.findIndex((option) => option.value === 'sources'),
  );
  await app._chooseModalOption(
    app.state.modal.options.findIndex((option) => option.value === 'ETH-USD'),
  );
  await app._chooseModalOption(
    app.state.modal.options.findIndex((option) => option.value === 'book'),
  );
  const view = stripAnsi(app.frame().lines.join('\n'));
  assert.ok(view.includes('Bids'));
  assert.ok(view.includes('99'));
  assert.ok(view.includes('Asks'));
  assert.ok(
    requests.every((request) =>
      ['native.status', 'native.source.status', 'native.source.book'].includes(request.action),
    ),
  );
});
test('TUI exposes native process start and stop as a human menu while an Agent is running', async () => {
  let state = 'stopped';
  const { app, requests } = fixture((_method, action) => {
    if (action === 'workspace.list') return [];
    if (action === 'native.start') state = 'connected';
    if (action === 'native.stop') state = 'stopped';
    if (action.startsWith('native.'))
      return { available: true, state, mode: 'paper', liveExecution: false };
  });
  app.state.running = true;
  await app._runCommand('quant', '');
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'native'));
  assert.ok(app.state.modal.body.includes(app.quantBrowser.text('nativeStopped')));
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'start'));
  assert.ok(app.state.modal.body.includes(app.quantBrowser.text('nativeReady')));
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === 'stop'));
  assert.ok(app.state.modal.body.includes(app.quantBrowser.text('nativeStopped')));
  assert.ok(!requests.some((r) => r.action === 'native.control'));
});
