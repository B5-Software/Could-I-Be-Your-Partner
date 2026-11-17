/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { TuiApp } = require('../../src/tui/app');
const { stripAnsi } = require('../../src/tui/ansi');
const { setLanguage } = require('../../src/tui/text');
const evmNetworks = {
  items: [8453, 84532, 1337].map((id) => ({
    id,
    name: String(id),
    archived: false,
    capabilities: { autonomous: true, signType2: true },
  })),
};
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

for (const protocol of ['erc20', 'permit2']) {
  test(`TUI ${protocol} allowance review keeps the observed pair and opens manual intent approval`, async (t) => {
    setLanguage('en');
    const token = '0x' + '1'.repeat(40);
    const spender = '0x' + '2'.repeat(40);
    const { app, requests } = fixture((_method, action) => {
      if (action === 'allowance.inspect')
        return {
          token,
          spender,
          amount: '2.5',
          amountAtomic: '2500000',
          symbol: 'USDC',
          network: 'Base Sepolia',
          block: '123',
          observedAt: 0,
          commandId: 'review-allowance',
          ...(protocol === 'permit2'
            ? {
                permit2: {
                  tokenAllowance: '1.5',
                  tokenAllowanceAtomic: '1500000',
                  effectiveAmount: '1.5',
                  effectiveAmountAtomic: '1500000',
                  expiration: 1779000000,
                  nonce: '7',
                },
              }
            : {}),
        };
      if (action === 'allowance.revoke.prepare') return { id: 'revoke-intent' };
      if (action === 'intent.inspect')
        return {
          id: 'revoke-intent',
          status: 'approval-required',
          digest: 'fixture-digest',
          transaction: { to: token, data: '0x00' },
          description: {
            kind: protocol === 'permit2' ? 'permit2-lockdown' : 'approve',
            recipient: spender,
            rawTokenAmount: '0',
          },
        };
      throw new Error(action);
    });
    t.after(() => app.dispose());
    app.walletBrowser.allowances({ id: 'wallet', unlocked: true });
    await app._chooseModalOption(1);
    if (protocol === 'permit2') await app._chooseModalOption(3);
    await app._chooseModalOption(1);
    for (const value of [token, spender]) {
      app.state.modal.editor.setValue(value);
      await app.state.modal.onSubmit();
    }
    assert.match(app.state.modal.body, /2\.5 USDC/);
    assert.match(app.state.modal.body, /Observed block #123/);
    if (protocol === 'permit2')
      assert.match(app.state.modal.body, /Current allowance upper bound 1\.5 USDC/);
    await app._chooseModalOption(1);
    assert.deepEqual(
      requests.map(({ action }) => action),
      ['allowance.inspect', 'allowance.revoke.prepare', 'intent.inspect'],
    );
    assert.deepEqual(requests[1].input, {
      id: 'wallet',
      chain: 'base-sepolia',
      token,
      spender,
      commandId: 'review-allowance',
      ...(protocol === 'permit2' ? { protocol } : {}),
    });
    if (protocol === 'permit2') assert.match(app.state.modal.body, /previously signed/);
    assert.ok(app.state.modal.options.some((option) => option.value === 'approve'));
  });
}

for (const operation of ['ordered', 'signature']) {
  test(`TUI Permit2 ${operation} revocation preserves the observed nonce for manual review`, async (t) => {
    setLanguage('en');
    const token = '0x' + '1'.repeat(40),
      spender = '0x' + '2'.repeat(40);
    const { app, requests } = fixture((_method, action) => {
      if (action === 'allowance.inspect')
        return {
          token,
          spender,
          network: 'Base',
          amountAtomic: '0',
          block: '123',
          observedAt: 0,
          commandId: 'pair-read',
          permit2: {
            nonce: '7',
            nextNonce: '8',
            expiration: 1779000000,
            effectiveAmountAtomic: '0',
            tokenAllowanceAtomic: '0',
          },
        };
      if (action === 'permit2.signature.inspect')
        return {
          nonce: '511',
          unavailable: false,
          block: '123',
          network: 'Base',
          commandId: 'signature-read',
        };
      if (action === `permit2.${operation}.prepare`) return { id: 'review-nonce' };
      if (action === 'intent.inspect')
        return {
          id: 'review-nonce',
          status: 'approval-required',
          transaction: { to: token, data: '0x00' },
          description: {
            kind:
              operation === 'ordered'
                ? 'permit2-allowance-invalidate'
                : 'permit2-signature-invalidate',
            nextNonce: '8',
            permitNonce: '511',
          },
        };
      throw new Error(action);
    });
    t.after(() => app.dispose());
    const choose = async (value) =>
      app._chooseModalOption(app.state.modal.options.findIndex((option) => option.value === value));
    const input = async (value) => {
      app.state.modal.editor.setValue(value);
      await app.state.modal.onSubmit();
    };
    app.walletBrowser.allowances({ id: 'wallet', unlocked: true });
    await choose('base');
    await choose('switch');
    if (operation === 'ordered') {
      await choose('read');
      await input(token);
      await input(spender);
      assert.ok(!app.state.modal.options.some((option) => option.value === 'revoke'));
      await choose('ordered');
      assert.deepEqual(requests[1].input, {
        id: 'wallet',
        chain: 'base',
        token,
        spender,
        nonce: '7',
        commandId: 'pair-read:nonce',
      });
    } else {
      await choose('signature');
      await input('0x1ff');
      await choose('prepare');
      assert.deepEqual(requests[1].input, {
        id: 'wallet',
        chain: 'base',
        nonce: '511',
        commandId: 'signature-read',
      });
    }
    assert.ok(app.state.modal.options.some((option) => option.value === 'approve'));
    assert.ok(!requests.some(({ action }) => action === 'intent.approve'));
  });
}

test('TUI watch accounts expose holdings and token tracking without signing controls', async (t) => {
  setLanguage('en');
  const custom = '0x' + '3'.repeat(40);
  let tracked = [];
  const { app, requests } = fixture((_method, action, input) => {
    if (action === 'network.list')
      return {
        items: [
          { key: 'base', id: 8453, name: 'Base', nativeSymbol: 'ETH' },
          { key: 'base-sepolia', id: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH' },
        ],
      };
    if (action === 'assets')
      return {
        network: 'Base Sepolia',
        block: '123',
        trackedTokens: tracked,
        assets: [
          { symbol: 'ETH', amount: '1' },
          { symbol: null, address: custom, amountAtomic: '123', metadataError: 'missing decimals' },
        ],
      };
    if (action === 'asset.track') {
      tracked = [input.token];
      return {};
    }
    if (action === 'asset.untrack') {
      tracked = [];
      return {};
    }
    throw new Error(action);
  });
  t.after(() => app.dispose());
  const choose = async (value) =>
    app._chooseModalOption(app.state.modal.options.findIndex((option) => option.value === value));
  app.walletBrowser.account({
    id: 'watch',
    name: 'Public account',
    address: '0x' + '2'.repeat(40),
    kind: 'watch',
    unlocked: false,
    policy: { mode: 'manual', chains: [] },
  });
  assert.deepEqual(
    app.state.modal.options.map((option) => option.value),
    ['back', 'balance', 'allowances', 'watch-import', 'watch-remove'],
  );
  await choose('balance');
  await choose('base-sepolia');
  assert.match(app.state.modal.body, /ETH · 1/);
  assert.match(app.state.modal.body, /123 atomic units/);
  await choose('track');
  app.state.modal.editor.setValue(custom);
  await app.state.modal.onSubmit();
  assert.deepEqual(requests.find(({ action }) => action === 'asset.track').input, {
    id: 'watch',
    chain: 'base-sepolia',
    token: custom,
  });
  await choose(custom);
  assert.deepEqual(requests.find(({ action }) => action === 'asset.untrack').input, {
    id: 'watch',
    chain: 'base-sepolia',
    token: custom,
  });
});

test('TUI watch import binds the selected account and uses the masked credential flow', async (t) => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) => {
    if (action === 'watch.import') return { id: 'watch', kind: 'local' };
    if (action === 'list') return { wallets: [], intents: [] };
    throw new Error(action);
  });
  t.after(() => app.dispose());
  const choose = async (value) =>
    app._chooseModalOption(app.state.modal.options.findIndex((option) => option.value === value));
  const submit = async (value) => {
    app.state.modal.editor.setValue(value);
    await app.state.modal.onSubmit();
  };
  app.walletBrowser.account({
    id: 'watch',
    name: 'Original watch',
    address: '0x' + '2'.repeat(40),
    kind: 'watch',
    unlocked: false,
    policy: { mode: 'manual', chains: [] },
  });
  await choose('watch-import');
  assert.equal(app.state.modal.masked, true);
  await submit('test-watch-import-password');
  await choose('privateKey');
  assert.equal(app.state.modal.masked, true);
  await submit('public-fixture-placeholder');
  const request = requests.find(({ action }) => action === 'watch.import');
  assert.equal(request.input.id, 'watch');
  assert.equal(request.input.name, 'Original watch');
  assert.ok(!requests.some(({ action }) => action === 'unlock'));
});

test('TUI portfolio holdings page totals and members from one snapshot and refresh only on request', async (t) => {
  setLanguage('en');
  let reads = 0;
  const { app, requests } = fixture((_method, action, input) => {
    assert.equal(action, 'portfolio.holdings');
    reads++;
    return {
      name: 'Shared portfolio',
      capital: { pendingCount: 2, approvalCount: 1, unknownCount: 1 },
      network: 'Base',
      block: String(100 + reads),
      complete: false,
      ...(input.valuation
        ? {
            valuation: {
              complete: false,
              knownValue: '2000',
              source: 'Chainlink',
              sequencer: { status: 'up' },
              prices: {
                eth: {
                  pair: 'ETH/USD',
                  status: 'available',
                  price: '2000',
                  address: '0x' + '7'.repeat(40),
                  updatedAt: 1793836800,
                  ageSeconds: 30,
                },
              },
            },
          }
        : {}),
      assets: Array.from({ length: 7 }, (_, index) => ({
        symbol: 'ASSET-' + index,
        complete: index !== 0,
        amount: index === 0 ? null : String(index),
        amountAtomic: index === 0 ? null : String(index),
        knownAmountAtomic: '1250',
        capital: {
          complete: false,
          reservedAtomic: '100',
          reserved: '0.1',
          availableAtomic: null,
          available: null,
          shortfallAtomic: null,
        },
      })),
      members: [
        {
          walletId: 'one',
          name: 'First wallet',
          capital: { pendingCount: 0, approvalCount: 0, unknownCount: 0 },
          address: '0x' + '1'.repeat(40),
          assets: [{ symbol: 'ETH', amount: '1', amountAtomic: '1000000000000000000' }],
        },
      ],
    };
  });
  t.after(() => app.dispose());
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const panel = new TuiWalletPortfolios(app.walletBrowser);
  const choose = (value) =>
    app._chooseModalOption(app.state.modal.options.findIndex((option) => option.value === value));
  await panel.holdings('portfolio');
  assert.match(app.state.modal.body, /Known amount 1250 atomic units/);
  assert.match(app.state.modal.body, /Known local reserve · 0\.1/);
  assert.match(app.state.modal.body, /After local reserves · Unknown/);
  assert.match(app.state.modal.body, /Unfinished operations · 2/);
  await choose('next');
  assert.match(app.state.modal.body, /ASSET-6/);
  await choose('members');
  await choose('one');
  assert.match(app.state.modal.body, /First wallet/);
  assert.match(app.state.modal.body, /Unfinished operations · 0/);
  assert.match(app.state.modal.body, /ETH · 1/);
  assert.equal(reads, 1);
  await choose('refresh');
  assert.match(app.state.modal.body, /#102/);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].input, { id: 'portfolio' });
  await choose('valuation');
  assert.deepEqual(requests.at(-1).input, { id: 'portfolio', valuation: true });
  assert.match(app.state.modal.body, /Known partial value · 2000 USD/);
  await choose('sources');
  assert.match(app.state.modal.body, /ETH\/USD · 2000 USD/);
  assert.match(app.state.modal.body, /Price age 30 s/);
  await choose('back');
  await choose('next');
  assert.equal(reads, 3);
  await choose('refresh');
  assert.deepEqual(requests.at(-1).input, { id: 'portfolio', valuation: true });
  assert.equal(reads, 4);
});

test('TUI discovers past approvals and checks the selected pair even with the wallet locked', async (t) => {
  setLanguage('en');
  const token = '0x' + '1'.repeat(40);
  const spender = '0x' + '2'.repeat(40);
  const { app, requests } = fixture((_method, action) => {
    if (action === 'allowance.discover')
      return {
        fromBlock: '101',
        toBlock: '120',
        total: 1,
        nextOffset: null,
        nextEndBlock: '100',
        items: [{ token, spender, block: '118', eventAmountAtomic: '9500' }],
      };
    if (action === 'allowance.inspect')
      return { token, spender, network: 'Base', block: '125', observedAt: 0, amountAtomic: '0' };
    throw new Error(action);
  });
  t.after(() => app.dispose());
  app.walletBrowser.allowances({ id: 'wallet', unlocked: false });
  await app._chooseModalOption(0);
  await app._chooseModalOption(2);
  for (const value of ['120', '20']) {
    app.state.modal.editor.setValue(value);
    await app.state.modal.onSubmit();
  }
  assert.match(app.state.modal.body, /101–120/);
  assert.deepEqual(requests[0].input, {
    id: 'wallet',
    chain: 'base',
    blocks: 20,
    limit: 8,
    endBlock: '120',
  });
  await app._chooseModalOption(1);
  assert.deepEqual(requests[1].input, { id: 'wallet', chain: 'base', token, spender });
  assert.match(app.state.modal.body, /0 atomic units/);
  assert.ok(!app.state.modal.options.some((option) => option.value === 'revoke'));
});

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
    if (action === 'execution.profile')
      return {
        id: 'a'.repeat(64),
        pool: '0x' + 'b'.repeat(40),
        finalizedBlock: 900,
        finalizedBlockHash: '0x' + 'c'.repeat(64),
        startTime: 1700000000,
        endTime: 1700000360,
        swapCount: 5,
        wethVolumeAtoms: ['1000000000000000000', '3000000000000000000'],
      };
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

test('TUI site network approval verifies an owner-entered RPC before enabling save', async (t) => {
  setLanguage('en');
  let pending = [
    {
      id: 'site-network',
      origin: 'https://dex.example',
      network: {
        id: 1337,
        name: 'Research chain',
        nativeSymbol: 'TEST',
        rpcOrigins: ['https://suggested.invalid'],
      },
    },
  ];
  const { app, requests } = fixture((_method, action) => {
    if (action === 'list') return { wallets: [], intents: [] };
    if (action === 'app.list') return { pending, connections: [] };
    if (action === 'app.probeNetwork')
      return {
        id: 'verified-node',
        profile: {
          ...pending[0].network,
          rpcOrigin: 'http://127.0.0.1:8545',
          genesisHash: '0x' + 'a'.repeat(64),
          additionalFeeNative: '0',
          capabilities: { signType2: true },
        },
      };
    if (action === 'app.addNetwork') {
      pending = [];
      return {};
    }
    throw Error(action);
  });
  t.after(() => app.dispose());
  await app.walletBrowser.open();
  await chooseLive(app, 'apps');
  await chooseLive(app, 'pending:site-network');
  assert.match(app.state.modal.body, /suggested\.invalid/);
  await chooseLive(app, true);
  assert.equal(app.state.modal.editor.value, '');
  app.state.modal.editor.setValue('http://127.0.0.1:8545');
  await app.state.modal.onSubmit();
  await app.state.modal.onSubmit();
  assert.match(app.state.modal.body, /127\.0\.0\.1:8545/);
  assert.equal(
    requests.some((r) => r.action === 'app.addNetwork'),
    false,
  );
  await chooseLive(app, true);
  assert.deepEqual(requests.find((r) => r.action === 'app.addNetwork').input, {
    id: 'site-network',
    reviewId: 'verified-node',
    confirmed: true,
  });
});

test('TUI wallet shows browser identity and binds a separate human pairing confirmation', async (t) => {
  setLanguage('en');
  const pending = {
    id: 'pair-fixture',
    name: 'Research Chromium',
    origin: 'chrome-extension://' + 'a'.repeat(32),
    fingerprint: 'f00d'.repeat(16),
    digest: 'frozen-pairing',
    expiresAt: Date.now() + 30000,
  };
  let waiting = [pending];
  const { app, requests } = fixture((_method, action) => {
    if (action === 'list') return { wallets: [], intents: [] };
    if (action === 'browser.status')
      return { state: 'listening', enabled: true, pending: waiting, clients: [] };
    if (action === 'browser.confirm') {
      waiting = [];
      return {};
    }
    throw Error(action);
  });
  t.after(() => app.dispose());
  await app.walletBrowser.open();
  await chooseLive(app, 'browser');
  await chooseLive(app, 'pending:pair-fixture');
  assert.match(app.state.modal.body, /Research Chromium/);
  assert.ok(app.state.modal.body.includes(pending.fingerprint));
  assert.equal(app.state.modal.options[0].value, false);
  assert.equal(
    requests.some((r) => r.action === 'browser.confirm'),
    false,
  );
  await chooseLive(app, true);
  assert.deepEqual(requests.find((r) => r.action === 'browser.confirm').input, {
    id: pending.id,
    digest: pending.digest,
    confirmed: true,
  });
});

test('TUI site connections select named account/network and require a separate origin review', async () => {
  setLanguage('en');
  const { TuiWalletApps } = require('../../src/tui/wallet-apps');
  let connected = false;
  const { app, requests } = fixture((_method, action) => {
    if (action === 'app.list')
      return {
        pending: connected ? [] : [{ id: 'request', origin: 'https://dex.example' }],
        connections: [],
      };
    if (action === 'list')
      return {
        wallets: [{ id: 'chosen-wallet', name: 'Trading wallet', address: '0x' + '1'.repeat(40) }],
      };
    if (action === 'network.list')
      return { items: [{ key: 'evm-1337', id: 1337, name: 'Local EVM' }] };
    if (action === 'app.allow') {
      connected = true;
      return { ok: true };
    }
    throw Error('Unexpected ' + action);
  });
  await new TuiWalletApps(app.walletBrowser).open();
  await chooseLive(app, 'pending:request');
  await chooseLive(app, 'chosen-wallet');
  await chooseLive(app, 'evm-1337');
  assert.ok(app.state.modal.body.includes('https://dex.example'));
  assert.ok(app.state.modal.body.includes('Trading wallet'));
  assert.equal(
    requests.some((r) => r.action === 'app.allow'),
    false,
  );
  assert.equal(app.state.modal.selected, 0);
  await chooseLive(app, true);
  assert.deepEqual(requests.find((r) => r.action === 'app.allow').input, {
    id: 'request',
    walletId: 'chosen-wallet',
    chain: 'evm-1337',
    confirmed: true,
  });
  assert.equal(
    requests.some((r) => r.action === 'intent.approve'),
    false,
  );
  app.dispose();
});
test('TUI message signing pages full content and requires a separate frozen confirmation with reject selected', async () => {
  setLanguage('en');
  const { TuiWalletMessages } = require('../../src/tui/wallet-messages');
  const message = {
    id: 'message',
    reviewDigest: 'frozen-message',
    status: 'approval-required',
    address: '0x' + '1'.repeat(40),
    expiresAt: Date.now() + 300000,
    digest: '0x' + 'a'.repeat(64),
    message: {
      kind: 'personal',
      origin: 'https://dex.example',
      chainId: 1337,
      payload: '0x' + '61'.repeat(2000),
    },
    preview: 'visible\u202e' + '.'.repeat(2200),
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'message.get') return structuredClone(message);
    if (action === 'message.list') return { items: [], total: 0, next: null };
    if (action === 'message.approve') return { ok: true };
    throw Error('Unexpected ' + action);
  });
  await new TuiWalletMessages(app.walletBrowser).inspect('message');
  assert.ok(app.state.modal.body.includes('https://dex.example'));
  assert.equal(app.state.modal.body.includes('\u202e'), false);
  await chooseLive(app, 'next');
  await chooseLive(app, 'approve');
  assert.equal(app.state.modal.selected, 0);
  assert.ok(app.state.modal.body.includes('https://dex.example'));
  assert.equal(
    requests.some((r) => r.action === 'message.approve'),
    false,
  );
  message.reviewDigest = 'changed-after-review';
  await chooseLive(app, true);
  assert.deepEqual(requests.find((r) => r.action === 'message.approve').input, {
    id: 'message',
    digest: 'frozen-message',
    confirmed: true,
  });
  app.dispose();
});

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
      : action === 'network.list'
        ? evmNetworks
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
test('TUI Base portfolio equity displays the configured floor and current assessed value', async () => {
  setLanguage('en');
  const { app, requests } = fixture((_method, action) => {
    if (action === 'list') return { wallets: [] };
    if (action === 'portfolio.get')
      return {
        state: 'active',
        revision: 1,
        usage: {},
        portfolio: {
          id: 'group',
          name: 'Base floor',
          chainId: 8453,
          equityFloorUsdAtomic: '50000000000',
          members: [],
          limits: {},
        },
      };
    if (action === 'portfolio.equity')
      return {
        status: 'below',
        availableUsd: '490',
        floorUsd: '500',
        block: '123',
        blockHash: '0x' + 'a'.repeat(64),
      };
    throw Error(action);
  });
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  await new TuiWalletPortfolios(app.walletBrowser).detail('group');
  const option = app.state.modal.options.findIndex((row) => row.value === 'equity');
  assert.ok(option >= 0);
  await app._chooseModalOption(option);
  assert.match(app.state.modal.body, /Below floor/);
  assert.match(app.state.modal.body, /490 USD/);
  assert.match(app.state.modal.body, /500 USD/);
  assert.deepEqual(requests.find((row) => row.action === 'portfolio.equity').input, {
    id: 'group',
  });
});
test('TUI portfolio allowance review rereads a locked wallet pair and keeps it read-only', async () => {
  setLanguage('en');
  const address = '0x' + '1'.repeat(40),
    token = '0x' + '2'.repeat(40),
    spender = '0x' + '3'.repeat(40);
  const pair = {
    walletId: 'one',
    walletName: 'Locked wallet',
    token,
    spender,
    protocol: 'permit2',
    status: 'active',
    symbol: 'USDC',
    spendable: { amount: '2' },
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'list')
      return { wallets: [{ id: 'one', name: 'Locked wallet', address, unlocked: false }] };
    if (action === 'portfolio.get')
      return {
        state: 'active',
        usage: {},
        portfolio: {
          id: 'group',
          name: 'Allowances',
          chainId: 8453,
          members: [{ walletId: 'one', address }],
          limits: {},
        },
      };
    if (action === 'portfolio.allowances.list')
      return { items: [{ reportId: 'snapshot', block: '123', observedAt: 1 }], next: null };
    if (action === 'portfolio.allowances.get')
      return {
        reportId: 'snapshot',
        block: '123',
        observedAt: 1,
        next: null,
        items: [pair],
        coverage: {
          tokens: [token],
          nextEndBlock: '100',
          scannedRanges: [{ fromBlock: '101', toBlock: '123' }],
        },
        totals: [
          {
            token,
            symbol: 'USDC',
            balance: { amount: '8' },
            measured: { amount: '2' },
            includingPermit2: { amount: '5' },
          },
        ],
      };
    if (action === 'allowance.inspect')
      return {
        token,
        spender,
        network: 'Base',
        amountAtomic: '2000000',
        amount: '2',
        symbol: 'USDC',
        block: '125',
        observedAt: 2,
      };
    throw Error(action);
  });
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const select = async (match) => {
    const index = app.state.modal.options.findIndex((row) => match(row.value));
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  await new TuiWalletPortfolios(app.walletBrowser).detail('group');
  for (const value of ['exposure', 'history', 'snapshot'])
    await select((option) => option === value);
  assert.match(app.state.modal.body, /Measured spendable amount 2/);
  await select((value) => value?.spender === spender);
  assert.deepEqual(requests.at(-1), {
    method: 'wallet:request',
    action: 'allowance.inspect',
    input: { id: 'one', chain: 'base', token, spender, protocol: 'permit2' },
  });
  assert.match(app.state.modal.body, /#125/);
  assert.ok(!app.state.modal.options.some((row) => row.value === 'revoke'));
  await select((value) => value === 'back');
  assert.match(app.state.modal.body, /#123/);
});
test('TUI continuous allowance monitoring uses the selected baseline and interval, and shows saved changes', async () => {
  setLanguage('en');
  const notice = {
    block: '9',
    blockHash: '0x' + 'a'.repeat(64),
    observedAt: 1,
    pairCount: 0,
    increaseCount: 1,
    pairs: [],
    increases: [
      { symbol: 'USDC', metric: 'measured', before: { amount: '2' }, after: { amount: '4' } },
    ],
  };
  let enabled = false,
    revision = 0;
  const { app, requests } = fixture((_method, action) => {
    if (action === 'portfolio.allowanceMonitor.get')
      return {
        revision,
        enabled,
        status: enabled ? 'watching' : 'off',
        lastBlock: enabled ? '9' : null,
        notices: enabled ? [notice] : [],
        next: null,
      };
    if (
      action === 'portfolio.allowanceMonitor.start' ||
      action === 'portfolio.allowanceMonitor.stop'
    ) {
      enabled = action.endsWith('.start');
      revision++;
      return {};
    }
    throw Error(action);
  });
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  await new TuiWalletPortfolios(app.walletBrowser).allowanceMonitor(
    'group',
    'base',
    { reportId: 'baseline', block: '8', coverage: { mode: 'recent' } },
    () => {},
  );
  const choose = async (value) => {
    const index = app.state.modal.options.findIndex((option) => option.value === value);
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  await choose('start');
  await choose(60);
  assert.deepEqual(
    requests.find((row) => row.action === 'portfolio.allowanceMonitor.start').input,
    {
      id: 'group',
      reportId: 'baseline',
      intervalSeconds: 60,
      expectedRevision: 0,
    },
  );
  await choose(notice);
  assert.match(app.state.modal.body, /USDC.*2 → 4/);
  await choose('back');
  await choose('stop');
  assert.match(app.state.modal.body, /Off/);
  assert.deepEqual(requests.find((row) => row.action === 'portfolio.allowanceMonitor.stop').input, {
    id: 'group',
    expectedRevision: 1,
  });
});
test('TUI performance keeps the same snapshot when paging and resets it when filtering by wallet', async () => {
  setLanguage('en');
  const value = (amount) => ({ amount });
  let priced = false;
  const { app, requests } = fixture((_method, action, input) => {
    if (action === 'portfolio.performance.priceFees') {
      priced = true;
      return { saved: 1, unavailable: 0, next: null };
    }
    assert.equal(action, 'portfolio.performance');
    return {
      snapshotId: 'performance-a',
      next: input.offset === 0 && !input.walletId ? 5 : null,
      items: [],
      totals: {
        realizedGrossUsdc: value('-8'),
        matchedWeth: value('2'),
        openWeth: value('1'),
        openCostUsdc: value('100'),
        unmatchedSaleWeth: value('3'),
        missingCount: 0,
        matchedSaleCount: 1,
        pricedSaleCount: priced ? 1 : 0,
        realizedAfterSwapFeesUsdc: priced ? value('-9') : null,
      },
      fees: {
        totalWei: null,
        l2GasWei: '1000000000000000',
        l1DataFeeWei: null,
        operatorFeeWei: null,
        l2Receipts: 1,
        l1Receipts: 0,
        operatorReceipts: 0,
        finalizedTransactions: 1,
      },
      historicalFees: { available: true, priced: priced ? 1 : 0, transactions: 1 },
    };
  });
  const { TuiWalletPortfolios } = require('../../src/tui/wallet-portfolios');
  const panel = new TuiWalletPortfolios(app.walletBrowser);
  await panel.performance(
    { id: 'group', members: [{ walletId: 'first', address: '0x1' }] },
    new Map([['first', 'Wallet one']]),
  );
  const choose = async (value) => {
    const index = app.state.modal.options.findIndex((option) => option.value === value);
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  assert.match(app.state.modal.body, /Realized gross P&L.*-8 USDC/);
  await choose('next');
  assert.equal(requests.at(-1).input.snapshotId, 'performance-a');
  assert.equal(requests.at(-1).input.offset, 5);
  await choose('wallet');
  await choose('first');
  assert.equal(requests.at(-1).input.walletId, 'first');
  assert.equal(requests.at(-1).input.snapshotId, undefined);
  assert.match(app.state.modal.body, /Wallet one/);
  await choose('price');
  assert.deepEqual(requests.find((row) => row.action === 'portfolio.performance.priceFees').input, {
    id: 'group',
    walletId: 'first',
    offset: 0,
    limit: 5,
  });
  assert.match(app.state.modal.body, /Realized P&L after matched swap fees.*-9 USDC/);
  await choose('fees');
  assert.match(app.state.modal.body, /L2 execution fee.*0.001 ETH.*1\/1/);
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
  const { app, requests } = fixture((_method, action) =>
    action === 'network.list'
      ? evmNetworks
      : {
          limits: { maxTotalValueWei: '0', maxTotalFeeWei: '0', maxTransactions: 5, tokens: [] },
          usage: { valueWei: '0', feeWei: '0', transactions: 2, tokens: {} },
        },
  );
  const browser = app.walletBrowser,
    limits = { tokens: [] };
  let returned = false;
  await browser.tokenScope(limits, () => {
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
  await chooseLive(app, 'chainId');
  await chooseLive(app, 1337);
  assert.equal(limits.tokens[0].chainId, 1337);
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
    ['network.list', 'policy.usage'],
  );
  app.dispose();
});
test('TUI live plans create paused drafts with exact decimal input and preserve identity after a lost ACK', async () => {
  setLanguage('en');
  const { app, browser, requests, fail } = liveFixture();
  await browser.editor('project');
  browser.draft.side = 'sell';
  browser.draft.totalInput = '0.123456789012345678';
  browser.draft.minimumTotalOutput = '99.123456';
  browser.draft.maxArrivalCostBps = '0';
  await chooseLive(app, 'leSchedule');
  await chooseLive(app, 'leFixed');
  fail();
  await chooseLive(app, 'leSave');
  assert.match(app.state.modal.body, /ACK lost/);
  await chooseLive(app, 'leSave');
  const creates = requests.filter((call) => call.action === 'execution.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].input.operationId, creates[1].input.operationId);
  assert.equal(creates[0].input.totalInput, '0.123456789012345678');
  assert.equal(creates[1].input.minimumTotalOutput, '99.123456');
  assert.equal(creates[1].input.maxArrivalCostBps, 0);
  assert.equal(creates[1].input.schedule, 'fixed-window');
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
test('TUI previews historical VWAP evidence and uses its archived ID when creating', async () => {
  setLanguage('en');
  const { app, browser, requests } = liveFixture();
  await browser.editor('project');
  await chooseLive(app, 'leSchedule');
  await chooseLive(app, 'leVwap');
  await chooseLive(app, 'leSave');
  assert.match(app.state.modal.body, /valid volume profile/);
  await chooseLive(app, 'leProfileCapture');
  assert.match(app.state.modal.body, /75% · 3 WETH/);
  assert.match(app.state.modal.body, /Finalized block · 900/);
  await chooseLive(app, 'leBack');
  await chooseLive(app, 'leSave');
  const capture = requests.find((r) => r.action === 'execution.profile');
  const create = requests.find((r) => r.action === 'execution.create');
  assert.deepEqual(capture.input, { id: 'project', slices: 2, intervalMs: 60000 });
  assert.equal(create.input.profileId, 'a'.repeat(64));
  assert.equal(create.input.schedule, 'vwap');
  app.dispose();
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
test('TUI native validation picks explicit revisions and opens the chosen training evidence', async () => {
  setLanguage('en');
  const stage = {
    revision: 1,
    tradeContribution: '1.25',
    quoteCurrency: 'USD',
    fees: '0.05',
    counts: { executions: 1 },
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'recording.get')
      return { name: 'Tape', status: 'complete', endedMonoNs: '3000000000' };
    if (action === 'native.strategy.list')
      return {
        items: [{ definition: { id: 'strategy', name: 'Maker', revision: 2 } }],
        next: null,
      };
    if (action === 'replay.validate') return { replayId: 'report' };
    if (action === 'replay.get')
      return {
        name: 'Experiment',
        status: 'complete',
        validationProgress: { completed: 3, total: 3 },
        validation: {
          folds: [
            {
              fold: 1,
              training: { startMs: 0, endMs: 1000 },
              test: { startMs: 1000, endMs: 1500 },
              result: stage,
              ranking: [stage],
            },
          ],
        },
      };
    if (action === 'replay.history') return { items: [], next: null };
    throw Error(action);
  });
  const { EventDataBrowser } = require('../../src/tui/quant-events');
  await new EventDataBrowser(app.quantBrowser).detail('project', 'recording', 'tape');
  const choose = async (value) => {
    const i = app.state.modal.options.findIndex((option) => option.value === value);
    assert.ok(i >= 0);
    await app._chooseModalOption(i);
  };
  await choose('qeValidation');
  await choose('strategy');
  for (const value of ['1, 2', '0', '1000', '500', '1']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  const { operationId, ...input } = requests.find(
    (request) => request.action === 'replay.validate',
  ).input;
  assert.ok(operationId);
  assert.deepEqual(input, {
    id: 'project',
    recordingId: 'tape',
    strategyId: 'strategy',
    revisions: [1, 2],
    startMs: 0,
    trainMs: 1000,
    testMs: 500,
    folds: 1,
  });
  await choose(1);
  assert.match(app.state.modal.body, /1\.25 USD/);
  await choose(1);
  await choose('qeExecutions');
  assert.deepEqual(requests.find((request) => request.action === 'replay.history').input, {
    id: 'project',
    replayId: 'report',
    kind: 'executions',
    fold: 1,
    trainingRevision: 1,
    offset: 0,
    limit: 15,
  });
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
    if (action === 'network.list') return evmNetworks;
    calls.push({ action, input });
    if (action === 'policy.challenge') return { id: 'challenge' };
    if (action === 'policy.grant') {
      assert.equal(input.ack, 'ALLOW LIVE');
      return { ok: true };
    }
    return { wallets: [], intents: [] };
  });
  await app.walletBrowser.authorization({
    id: 'one',
    name: 'Wallet',
    address: '0x' + '1'.repeat(40),
  });
  await app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value[0] === 1337));
  await app._chooseModalOption(0);
  app.state.modal.editor.setValue('0.01');
  await app._handleModalKey({ name: 'enter' });
  assert.ok(app.state.modal.body.includes('native coin limits cover transaction value'));
  await app._chooseModalOption(1);
  assert.match(app.state.modal.body, /continuous transfers/);
  assert.equal(calls.length, 0);
  assert.equal(app.state.modal.selected, 0, 'Cancel must be the default');
  await app._chooseModalOption(1);
  assert.equal(calls[0].action, 'policy.challenge');
  assert.deepEqual(calls[0].input.chains, [1337]);
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
test('TUI Base trade history pages exact amounts and continues the selected dataset', async () => {
  setLanguage('en');
  const source = {
    id: 'dataset-a',
    start: 1700000040,
    end: 1700000160,
    amm: { chainId: 8453, fee: 500, interval: 60, swapCount: 11 },
  };
  const project = {
    id: 'project',
    name: 'Base fixture',
    network: {
      id: 8453,
      historyWindow: { maxCount: 360, defaultCount: 15 },
      recorder: { phase: 'paused', canResume: true, datasetId: source.id },
    },
    market: { venue: 'base', product: 'WETH-USDC', interval: 60, poolFee: 500 },
    paper: { status: 'paused', cash: '10000', position: '0' },
    datasets: [source],
    preferences: { datasetId: source.id },
  };
  const { app, requests } = fixture((_method, action, input) => {
    if (action === 'workspace.get') return project;
    if (action === 'base.history.record.start') {
      project.network.recorder.phase = 'waiting';
      return project.network.recorder;
    }
    if (action === 'base.history.record.stop') {
      project.network.recorder.phase = 'paused';
      return project.network.recorder;
    }
    if (action === 'base.history.trades')
      return {
        total: 11,
        items: Array.from({ length: input.offset ? 1 : 10 }, (_, i) => ({
          block: 10 + input.offset + i,
          logIndex: 0,
          wethDeltaAtoms: '1000000000000000001',
          usdcDeltaAtoms: '-1000000',
        })),
      };
    if (action === 'run.amm')
      return { metrics: { fills: 1 }, ammReplay: { attempts: [{}], pendingAtEnd: null } };
    if (action === 'run.amm.scenario')
      return {
        ammScenario: {
          anchor: { block: 20 },
          totalSwapGas: '120000',
          legs: [
            {
              index: 1,
              side: 'sell',
              status: 'filled',
              amountOutAtoms: '1900000',
              deltaOutAtoms: '-100000',
            },
          ],
        },
      };
    assert.ok(['base.history.capture', 'base.history.series'].includes(action));
    return source;
  });
  const choose = async (value) => {
    const index = app.state.modal.options.findIndex((option) => option.value === value);
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  await app.quantBrowser.project(project.id);
  await choose('ammHistory');
  assert.match(app.state.modal.body, /\+1\.000000000000000001 \/ −1/);
  await choose(10);
  assert.match(app.state.modal.body, /#20\/0/);
  await choose('continue');
  app.state.modal.editor.setValue('4');
  await app._handleModalKey({ name: 'enter' });
  assert.deepEqual(requests.find((r) => r.action === 'base.history.capture').input, {
    id: project.id,
    count: 4,
    afterDatasetId: source.id,
    select: true,
  });
  await choose('record-resume');
  assert.equal(requests.find((r) => r.action === 'base.history.record.start').input.resume, true);
  await choose('record-stop');
  assert.equal(requests.find((r) => r.action === 'base.history.record.stop').input.id, project.id);
  await choose('series');
  app.state.modal.editor.setValue('240');
  await app._handleModalKey({ name: 'enter' });
  assert.deepEqual(requests.find((r) => r.action === 'base.history.series').input, {
    id: project.id,
    datasetId: source.id,
    windows: 240,
    select: true,
  });
  await choose('ammReplay');
  await choose('buy-hold');
  await choose('fixed');
  for (const value of ['100', '0.5', '2000', '2', '4', '80']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  const replay = requests.find((r) => r.action === 'run.amm').input;
  assert.equal(replay.datasetId, source.id);
  assert.equal(replay.config.fixedFeeUsdc, '0.5');
  assert.equal(replay.config.maxAdverseBps, 80);
  assert.match(app.state.modal.body, /"fills": 1/);
  await choose('back');
  await choose('ammReplay');
  await choose('buy-hold');
  await choose('historical');
  for (const value of ['100', '0.75', '0.025', '60000', '2000', '2', '4', '']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  const historical = requests.filter((r) => r.action === 'run.amm').at(-1).input.config;
  assert.equal(historical.networkFeeCapUsdc, '0.75');
  assert.equal(historical.tipGwei, '0.025');
  assert.equal(historical.routerOverheadGas, 60000);
  assert.equal(historical.fixedFeeUsdc, undefined);
  await choose('back');
  await choose('ammScenario');
  for (const value of ['1', '20']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  await choose('sell');
  for (const value of ['0.1', '1.5']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  await choose('run');
  const scenario = requests.find((r) => r.action === 'run.amm.scenario').input;
  assert.deepEqual(scenario, {
    id: project.id,
    datasetId: source.id,
    config: {
      initialWeth: '1',
      anchorBlock: 20,
      legs: [{ side: 'sell', amountIn: '0.1', minimumOut: '1.5' }],
    },
  });
  assert.match(app.state.modal.body, /#20.*120000/);
  assert.match(app.state.modal.body, /\+1\.9 USDC.*−0\.1/);
});
test('TUI walk-forward configures periods and opens saved holdout and paged training evidence', async () => {
  setLanguage('en');
  const project = {
    id: 'research',
    name: 'Walk fixture',
    market: { venue: 'base', product: 'WETH-USDC' },
    paper: { status: 'paused', cash: '10000', position: '0' },
    risk: { feeBps: 10, slippageBps: 5 },
    preferences: { datasetId: 'dataset' },
    datasets: [],
  };
  const metrics = { returnPct: 0.25, maxDrawdownPct: 0.1, fills: 2 };
  const fold = {
    index: 1,
    selected: { fast: 2, slow: 21 },
    metrics,
    training: { start: 60, end: 240 },
    testing: { start: 300, end: 360 },
    trainingScores: Array.from({ length: 7 }, (_, i) => ({ fast: i + 2, slow: 21, ...metrics })),
  };
  const run = {
    id: 'saved-run',
    createdAt: Date.now(),
    codeVersion: 'candle-walk-forward-1',
    metrics,
    walkForward: { windows: [fold], candidateCount: 7 },
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'workspace.get') return project;
    if (action === 'run.walk-forward' || action === 'run.get') return run;
    if (action === 'run.walk-forward.fold') return fold;
    if (action === 'history.list') return { items: [run], nextOffset: null };
    throw Error(action);
  });
  const choose = async (value) => {
    const index = app.state.modal.options.findIndex((option) => option.value === value);
    assert.ok(index >= 0);
    await app._chooseModalOption(index);
  };
  await app.quantBrowser.project(project.id);
  await choose('walkForward');
  for (const value of ['50', '5', '1', '2，3', '21,34', '5000', '10', '5', '1500']) {
    app.state.modal.editor.setValue(value);
    await app._handleModalKey({ name: 'enter' });
  }
  assert.deepEqual(requests.find(({ action }) => action === 'run.walk-forward').input, {
    id: 'research',
    datasetId: 'dataset',
    config: {
      trainBars: 50,
      testBars: 5,
      folds: 1,
      fastPeriods: [2, 3],
      slowPeriods: [21, 34],
      initialCash: '5000',
      feeBps: 10,
      slippageBps: 5,
      allocationBps: 1500,
    },
  });
  assert.match(app.state.modal.body, /0\.25%/);
  await choose(1);
  assert.match(app.state.modal.body, /Out-of-sample window/);
  await choose('next');
  assert.match(app.state.modal.body, /7\. 8 \/ 21/);
  await choose('back');
  await choose('back');
  await choose('runs');
  await choose('walk:saved-run');
  assert.equal(requests.find(({ action }) => action === 'run.get').input.runId, run.id);
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

test('TUI network setup freezes a named review and saves only after a separate confirmation', async (t) => {
  setLanguage('en');
  const profile = {
    key: 'evm-1337',
    id: 1337,
    name: 'Local fixture',
    nativeSymbol: 'TEST',
    rpcOrigin: 'https://rpc.example',
    genesisHash: '0x' + 'a'.repeat(64),
    capabilities: { signType2: true },
    revision: 0,
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'network.challenge') return { id: 'network-review', profile };
    if (action === 'network.confirm') return { ...profile, revision: 1 };
    if (action === 'network.list') return { items: [profile] };
    if (action === 'list') return { wallets: [], intents: [] };
    throw Error(action);
  });
  t.after(() => app.dispose());
  const { TuiWalletNetworks } = require('../../src/tui/wallet-networks');
  await new TuiWalletNetworks(app.walletBrowser).edit();
  for (const value of ['Local fixture', '1337', 'TEST', 'https://rpc.example', '0.0001']) {
    app.state.modal.editor.setValue(value);
    await app.state.modal.onSubmit();
  }
  assert.equal(requests.length, 0);
  const choose = (value) =>
    app._chooseModalOption(app.state.modal.options.findIndex((o) => o.value === value));
  await choose(true);
  assert.equal(requests[0].action, 'network.challenge');
  assert.equal(requests[0].input.id, 1337);
  assert.match(app.state.modal.body, /Local fixture · 1337 · TEST/);
  assert.equal(
    requests.some((r) => r.action === 'network.confirm'),
    false,
  );
  await choose(true);
  assert.deepEqual(requests.find((r) => r.action === 'network.confirm').input, {
    challengeId: 'network-review',
    ack: 'SAVE NETWORK',
    confirmed: true,
  });
});

test('TUI native transfer selects a registered network and opens exact manual approval without auto-signing', async (t) => {
  setLanguage('en');
  const intent = {
    id: 'network-intent',
    status: 'approval-required',
    chainId: 1337,
    network: 'Local EVM',
    nativeSymbol: 'TEST',
    valueEth: '0.1',
    digest: 'digest',
    description: { kind: 'native-transfer' },
    transaction: { to: '0x' + '2'.repeat(40), data: '0x', nonce: 0 },
    executionFeeMaxWei: '1',
    l1FeeEstimateWei: '0',
    additionalFeeReserveWei: '2',
  };
  const { app, requests } = fixture((_method, action) => {
    if (action === 'network.list')
      return {
        items: [
          {
            key: 'evm-1337',
            id: 1337,
            name: 'Local EVM',
            nativeSymbol: 'TEST',
            archived: false,
            capabilities: { signType2: true },
          },
        ],
      };
    if (action === 'transaction.prepare' || action === 'intent.inspect') return intent;
    throw Error(action);
  });
  t.after(() => app.dispose());
  const { TuiWalletNetworks } = require('../../src/tui/wallet-networks');
  await new TuiWalletNetworks(app.walletBrowser).send({
    id: 'wallet',
    name: 'Fixture wallet',
    unlocked: true,
  });
  await app._chooseModalOption(1);
  for (const value of ['0x' + '2'.repeat(40), '0.1']) {
    app.state.modal.editor.setValue(value);
    await app.state.modal.onSubmit();
  }
  assert.deepEqual(requests.find((r) => r.action === 'transaction.prepare').input, {
    id: 'wallet',
    chain: 'evm-1337',
    to: '0x' + '2'.repeat(40),
    value: '0.1',
  });
  assert.match(app.state.modal.body, /TEST/);
  assert.match(app.state.modal.body, /1337/);
  assert.ok(app.state.modal.options.some((o) => o.value === 'approve'));
  assert.equal(
    requests.some((r) => r.action === 'intent.approve'),
    false,
  );
  intent.networkBlocked = true;
  await app.walletBrowser.inspect(intent.id);
  assert.equal(
    app.state.modal.options.some((o) => o.value === 'approve'),
    false,
  );
});
