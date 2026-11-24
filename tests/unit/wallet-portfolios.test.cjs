/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { WalletService } = require('../../src/main/services/wallet');
const key = '0x' + '01'.padStart(64, '0'),
  password = 'public-portfolio-fixture-password';
async function fixture(t, { allowWrites = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-portfolio-backend-')),
    writes = [];
  const fetcher = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (allowWrites && request.method === 'eth_sendRawTransaction') {
      writes.push(request.method);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: require('ethers').keccak256(request.params[0]),
        }),
      );
    }
    assert.notEqual(
      request.method,
      'eth_sendRawTransaction',
      'A paused portfolio must never dispatch a transaction',
    );
    writes.push(request.method);
    const value = {
      eth_chainId: '0x2105',
      eth_getTransactionCount: '0x0',
      eth_gasPrice: '0x989680',
      eth_maxPriorityFeePerGas: '0xf4240',
      eth_getBalance: '0x8ac7230489e80000',
      eth_estimateGas: '0x5208',
      eth_getBlockByNumber: {
        number: '0x100',
        hash: '0x' + 'a'.repeat(64),
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
      },
      eth_call: '0x' + '0'.repeat(64),
    }[request.method];
    assert.notEqual(value, undefined, request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }));
  };
  let service = new WalletService({ directory, fetcher });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = await service.request('import', {
    name: 'Public test wallet',
    kind: 'privateKey',
    secret: key,
    password,
  });
  const groupInput = {
    operation: 'create',
    name: 'Shared fixture budget',
    chainId: 8453,
    walletIds: [wallet.id],
    limits: { maxTotalValueEth: '0.01', maxTransactions: 4 },
  };
  return {
    get service() {
      return service;
    },
    wallet,
    writes,
    groupInput,
    directory,
    async reopen() {
      await service.dispose();
      service = new WalletService({ directory, fetcher });
      return service;
    },
  };
}
async function create(service, input) {
  const c = await service.request('portfolio.challenge', input);
  return service.request('portfolio.confirm', {
    challengeId: c.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
}

test('native rolling signature capacity follows a portfolio across wallets, edits and restarts', async (t) => {
  const f = await fixture(t, { allowWrites: true }),
    service = f.service;
  const other = await service.request('import', {
    name: 'Second public wallet',
    kind: 'privateKey',
    secret: '0x' + '09'.padStart(64, '0'),
    password,
  });
  const { portfolio } = await create(service, {
    ...f.groupInput,
    walletIds: [f.wallet.id, other.id],
  });
  const input = (walletId, commandId) => ({
    walletId,
    commandId,
    to: '0x' + '2'.repeat(40),
    value: '0.001',
  });
  const prepare = async (host, walletId, commandId) => {
    const intent = await host.prepare({ venue: 'base' }, input(walletId, commandId));
    await host.decide(intent.id, true, intent.digest);
    return intent;
  };
  const transfers = () => f.writes.filter((method) => method === 'eth_sendRawTransaction').length;
  await service.request('unlock', { id: f.wallet.id, password, minutes: 0 });
  const first = await prepare(service, f.wallet.id, 'before-rate-enabled');
  assert.equal((await service.broadcast(first.id)).status, 'submitted');
  const id = portfolio.id;
  const revision = (await service.request('portfolio.get', { id })).revision;
  const edit = { operation: 'edit', id, revision, limits: f.groupInput.limits };
  await assert.rejects(
    create(service, { ...edit, signatureRate: { windowSeconds: 301, maxSignatures: 1 } }),
    /PORTFOLIO_RATE_INVALID/,
  );
  const challenge = await service.request('portfolio.challenge', {
    ...edit,
    signatureRate: { windowSeconds: 120, maxSignatures: 1 },
  });
  assert.deepEqual(challenge.portfolio.signatureRate, { windowSeconds: 120, maxSignatures: 1 });
  await service.request('portfolio.confirm', {
    challengeId: challenge.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  const capped = await service.request('portfolio.get', { id });
  assert.equal(capped.signatureRate.used, 1);
  assert.equal(capped.signatureRate.status, 'limited');
  assert.ok(capped.signatureRate.nextEligibleAt > Date.now());

  const restarted = await f.reopen();
  assert.equal(
    (await restarted.request('portfolio.get', { id })).signatureRate.nextEligibleAt,
    capped.signatureRate.nextEligibleAt,
  );
  await restarted.request('unlock', { id: other.id, password, minutes: 0 });
  const denied = await prepare(restarted, other.id, 'other-wallet-same-window');
  const result = await restarted.broadcast(denied.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WALLET_PORTFOLIO_RATE_LIMIT');
  assert.equal(result.nativeSignatureAbsent, true);
  assert.equal(result.submissionMayHaveOccurred, false);
  const row = restarted.state.intents.find((item) => item.id === denied.id);
  const receipt = await restarted.signer('receipt.get', {
    id: other.id,
    operationId: denied.id,
    storeId: row.nativeSigning.storeId,
  });
  assert.equal(receipt.found, false);
  assert.equal(transfers(), 1);

  const { waitPeriod } = require('../../src/main/services/wallet/budget-wait');
  const { rootContext } = require('../../src/main/services/wallet/agent-scopes');
  const context = rootContext('rate-fixture');
  const wait = { kind: 'portfolio-rate', id, maxWaitMs: 80 };
  const parked = await waitPeriod(restarted, context, wait, new AbortController().signal);
  assert.equal(parked.timedOut, true);
  assert.equal(parked.signatureRate.status, 'limited');
  await create(restarted, {
    ...edit,
    revision: capped.revision,
    signatureRate: { windowSeconds: 120, maxSignatures: 2 },
  });
  assert.equal((await waitPeriod(restarted, context, wait)).ready, true);
  assert.equal((await restarted.request('portfolio.get', { id })).signatureRate.remaining, 1);
  const second = await prepare(restarted, other.id, 'other-wallet-after-human-budget-edit');
  assert.equal((await restarted.broadcast(second.id)).status, 'submitted');
  const settlement = await restarted.request('portfolio.get', { id });
  assert.equal(settlement.usage.transactions, 2);
  assert.equal(settlement.signatureRate.status, 'limited');
  assert.equal(transfers(), 2);
  const controller = new AbortController();
  const stopped = waitPeriod(restarted, context, { ...wait, maxWaitMs: 5000 }, controller.signal);
  controller.abort(Error('stopped rolling wait'));
  await assert.rejects(stopped, /stopped rolling wait/);
  assert.equal(restarted.budgetWake.size, 0);

  await create(restarted, {
    ...edit,
    revision: settlement.revision,
    signatureRate: { windowSeconds: 2, maxSignatures: 1 },
  });
  const timed = await waitPeriod(restarted, context, { ...wait, maxWaitMs: 6000 });
  assert.equal(timed.ready, true);
  assert.equal(timed.signatureRate.used, 0);
  assert.equal(transfers(), 2, 'waiting for capacity never submits an intent');
});
test('a portfolio revision change during a holdings read rejects the stale scope snapshot', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const group = await create(s, f.groupInput);
  const cancelled = new AbortController();
  cancelled.abort(Error('fixture stopped holdings query'));
  await assert.rejects(
    s.request('portfolio.holdings', { id: group.portfolio.id }, { signal: cancelled.signal }),
    /fixture stopped holdings query/,
  );
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  s.market.portfolioHoldings = async (config, input) => {
    assert.equal(config.venue, 'base');
    assert.equal(input.members[0].address.toLowerCase(), f.wallet.address.toLowerCase());
    entered();
    await gate;
    return { complete: true, assets: [], members: [] };
  };
  const pending = s.request('portfolio.holdings', { id: group.portfolio.id });
  const rejected = assert.rejects(pending, /WALLET_PORTFOLIO_CHANGED/);
  await started;
  await s.request('portfolio.pause', { id: group.portfolio.id, revision: group.revision });
  release();
  await rejected;
  assert.ok(!f.writes.includes('eth_sendRawTransaction'));
});
test('portfolio controls require their own frozen human challenge; direct private commands are not public', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const child = s.child;
  for (const id of [undefined, null, 10, {}, 'bad space', 'a'.repeat(81)])
    await assert.rejects(s.request('portfolio.get', { id }), /PORTFOLIO_INVALID/);
  await assert.rejects(s.request('portfolio.pause', { revision: 1 }), /PORTFOLIO_INVALID/);
  await s.signer('receipt.status', { id: f.wallet.id });
  assert.equal(
    s.child,
    child,
    'Malformed public portfolio IDs must not terminate the signing process',
  );
  for (const action of ['portfolio.create', 'portfolio.state'])
    await assert.rejects(s.request(action, f.groupInput), /UNKNOWN_WALLET_ACTION/);
  const c = await s.request('portfolio.challenge', f.groupInput);
  f.groupInput.limits.maxTotalValueEth = '999';
  const group = await s.request('portfolio.confirm', {
    challengeId: c.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  assert.equal(group.portfolio.limits.maxTotalValueWei, '10000000000000000');
  await assert.rejects(create(s, f.groupInput), /PORTFOLIO_MEMBER_BUSY/);
  assert.equal(
    (await s.request('list')).wallets[0].portfolioBlocked,
    false,
    'A confirmed invalid create must not leave a new permanent fence',
  );
  assert.equal(s.isUnlocked(f.wallet.id), false);
  await assert.rejects(
    s.request('portfolio.confirm', { challengeId: c.id, ack: 'ALLOW PORTFOLIO', confirmed: true }),
    /CONFIRMATION_REQUIRED/,
  );
  await s.request('portfolio.pause', { id: group.portfolio.id, revision: 1 });
  await assert.rejects(
    s.request('portfolio.pause', { id: group.portfolio.id, revision: 1 }),
    /PORTFOLIO_CHANGED/,
  );
  assert.equal((await s.request('list')).wallets[0].portfolioBlocked, true);
  const recovery = await s.request('portfolio.challenge', {
    operation: 'recover',
    walletIds: [f.wallet.id],
  });
  await s.request('portfolio.confirm', {
    challengeId: recovery.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  assert.equal((await s.request('list')).wallets[0].portfolioBlocked, false);
  assert.equal((await s.request('portfolio.get', { id: group.portfolio.id })).state, 'paused');
});

test('a concurrent member transaction change rejects the old capital snapshot even when the portfolio revision is unchanged', async (t) => {
  const f = await fixture(t),
    s = f.service,
    group = await create(s, f.groupInput);
  let entered, release;
  const started = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  s.market.portfolioHoldings = async () => {
    entered();
    await gate;
    return { chainId: 8453, assets: [], members: [] };
  };
  const pending = s.request('portfolio.holdings', { id: group.portfolio.id });
  const rejected = assert.rejects(pending, /WALLET_CAPITAL_CHANGED/);
  await started;
  await s.mutate((state) => {
    state.intents.push({
      id: 'capital-change-fixture',
      walletId: f.wallet.id,
      chainId: 8453,
      status: 'expired',
    });
  });
  release();
  await rejected;
  assert.ok(!f.writes.includes('eth_sendRawTransaction'));
});

test('human budget edits retain lifetime and periodic consumption, freeze the proposal and preserve revision history after restart', async (t) => {
  for (const configured of [false, true])
    await t.test(configured ? 'existing window' : 'new window', async (t) => {
      const f = await fixture(t, { allowWrites: true });
      if (configured) f.groupInput.limits.period = { seconds: 3600, maxTransactions: 2 };
      const group = await create(f.service, f.groupInput),
        id = group.portfolio.id;
      await f.service.request('unlock', { id: f.wallet.id, password, minutes: 0 });
      const intent = await f.service.prepare(
        { venue: 'base' },
        {
          walletId: f.wallet.id,
          commandId: 'signed-before-edit',
          to: '0x' + '2'.repeat(40),
          value: '0.001',
        },
      );
      await f.service.decide(intent.id, true, intent.digest);
      assert.equal((await f.service.broadcast(intent.id)).status, 'submitted');
      const before = await f.service.request('portfolio.get', { id }),
        original = f.service.state.intents.find((i) => i.id === intent.id);
      const { walletScopeValues } = require('../../src/shared/wallet-budget');
      const limits = {
        ...walletScopeValues(before.portfolio.limits),
        maxTotalValueEth: '0.0015',
        maxTransactions: 5,
        period: { seconds: 3600, maxTransactions: 3 },
      };
      const challenge = await f.service.request('portfolio.challenge', {
        operation: 'edit',
        id,
        revision: before.revision,
        name: 'Edited budget',
        maxFeeEth: '0.02',
        limits,
      });
      limits.maxTotalValueEth = '999';
      await f.service.request('portfolio.confirm', {
        challengeId: challenge.id,
        ack: 'ALLOW PORTFOLIO',
        confirmed: true,
      });
      const after = await f.service.request('portfolio.get', { id });
      assert.equal(after.usage.transactions, 1);
      assert.equal(after.usage.valueWei, '1000000000000000');
      assert.equal(after.portfolio.limits.maxTotalValueWei, '1500000000000000');
      assert.equal(after.period.usage.transactions, configured ? 1 : 0);
      if (configured) assert.equal(after.period.originMs, before.period.originMs);
      await assert.rejects(
        f.service.signer('sign', {
          id: f.wallet.id,
          operationId: intent.id,
          transaction: original.transaction,
          storeId: original.nativeSigning.storeId,
          expiresAt: original.expiresAt,
          feeReserveWei: original.feeReserveWei,
        }),
        /PORTFOLIO_OLD_SIGNATURE/,
      );
      await assert.rejects(
        create(f.service, {
          operation: 'edit',
          id,
          revision: after.revision,
          limits: {
            ...walletScopeValues(after.portfolio.limits),
            period: { seconds: 7200, maxTransactions: 3 },
          },
        }),
        /PERIOD_SCHEDULE_CHANGED/,
      );
      assert.equal((await f.service.request('list')).wallets[0].portfolioBlocked, false);
      const revisions = await f.service.request('portfolio.revisions', { id });
      assert.equal(revisions.total, 2);
      const first = await f.service.request('portfolio.revision', { id, revision: 1 });
      assert.equal(first.portfolio.limits.maxTotalValueWei, '10000000000000000');
      await f.reopen();
      assert.equal((await f.service.request('portfolio.get', { id })).usage.transactions, 1);
      assert.equal((await f.service.request('portfolio.revisions', { id })).total, 2);
    });
});
test('failed portfolio persistence keeps a durable signing fence across restart until explicit recovery', async (t) => {
  const f = await fixture(t);
  let s = f.service;
  const original = s.signer.bind(s);
  s.signer = (action, input) =>
    action === 'portfolio.create'
      ? Promise.reject(Error('WALLET_RECEIPT_STORE_FAILED'))
      : original(action, input);
  await assert.rejects(create(s, f.groupInput), /RECEIPT_STORE_FAILED/);
  s.signer = (action, input) =>
    action === 'portfolio.create'
      ? Promise.reject(Error('WALLET_PORTFOLIO_MEMBER_BUSY'))
      : original(action, input);
  await assert.rejects(create(s, f.groupInput), /PORTFOLIO_MEMBER_BUSY/);
  assert.equal(
    (await s.request('list')).wallets[0].portfolioBlocked,
    true,
    'A later create rejection cannot clear an earlier unknown mutation fence',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.directory, 'portfolio-fences.json'))).version,
    1,
  );
  s = await f.reopen();
  assert.equal((await s.request('list')).wallets[0].portfolioBlocked, true);
  await assert.rejects(
    s.prepare(
      { venue: 'base' },
      { walletId: f.wallet.id, commandId: 'blocked', to: '0x' + '2'.repeat(40), value: '0.001' },
    ),
    /PORTFOLIO_FENCED/,
  );
  assert.equal(f.writes.length, 0);
  const denied = await s.request('portfolio.challenge', {
    operation: 'recover',
    walletIds: [f.wallet.id],
  });
  await assert.rejects(
    s.request('portfolio.confirm', { challengeId: denied.id, ack: 'ALLOW LIVE', confirmed: true }),
    /CONFIRMATION_REQUIRED/,
  );
  const c = await s.request('portfolio.challenge', {
    operation: 'recover',
    walletIds: [f.wallet.id],
  });
  await s.request('portfolio.confirm', {
    challengeId: c.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  assert.equal((await s.request('list')).wallets[0].portfolioBlocked, false);
  assert.equal(s.isUnlocked(f.wallet.id), false);
  assert.equal((await s.request('portfolio.list')).total, 0);
});
test('portfolio pause blocks a late real signature before RPC and keeps native usage after restart', async (t) => {
  const f = await fixture(t),
    s = f.service;
  await s.request('unlock', { id: f.wallet.id, password, minutes: 0 });
  const c = await s.request('policy.challenge', { id: f.wallet.id, chains: [8453] });
  await s.request('policy.grant', { challengeId: c.id, ack: 'ALLOW LIVE', confirmed: true });
  const group = await create(s, f.groupInput),
    original = s.signer.bind(s);
  let ready, release;
  const signing = new Promise((r) => (ready = r)),
    hold = new Promise((r) => (release = r));
  s.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') {
      ready();
      await hold;
    }
    return result;
  };
  const transaction = s.transact(
    { venue: 'base' },
    {
      walletId: f.wallet.id,
      commandId: 'late-signature',
      to: '0x' + '2'.repeat(40),
      value: '0.001',
    },
    { actor: 'agent' },
  );
  let deadline;
  t.after(() => release());
  try {
    await Promise.race([
      signing,
      transaction.then(() => {
        throw Error('Transaction settled before the fixture held its native signature');
      }),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('Native signing fixture timed out')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  await s.request('portfolio.pause', { id: group.portfolio.id, revision: 1 });
  release();
  const result = await transaction;
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.ok(['failed', 'cancelled'].includes(result.status));
  assert.ok(!f.writes.includes('eth_sendRawTransaction'));
  const resumed = await f.reopen(),
    snapshot = await resumed.request('portfolio.get', { id: group.portfolio.id });
  assert.equal(snapshot.state, 'paused');
  assert.equal(snapshot.usage.transactions, 1);
  assert.equal(snapshot.usage.valueWei, '1000000000000000');
  assert.equal(resumed.isUnlocked(f.wallet.id), false);
});
