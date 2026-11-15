/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Interface, keccak256 } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const { portfolioCapital, requiresRecovery } = require('../../src/main/services/wallet/capital');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { BASE_FEEDS, feedAbi } = require('../../src/main/services/quant/portfolio-valuation');
const abi = new Interface([
  'function transfer(address,uint256) returns(bool)',
  'function approve(address,uint256) returns(bool)',
]);
const password = 'public-capital-fixture-password';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-capital-'));
  const mode = { balance: 10000000n, minedNonce: 0, pendingNonce: 0 },
    writes = [];
  const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const fetcher = async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'eth_chainId') result = '0x2105';
    else if (method === 'eth_getBlockByNumber')
      result = {
        number: '0x123',
        hash: '0x' + 'a'.repeat(64),
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
      };
    else if (method === 'eth_getTransactionCount') {
      if (typeof params[1] === 'object') {
        assert.deepEqual(params[1], { blockHash: '0x' + 'a'.repeat(64), requireCanonical: true });
        if (mode.nonceFailure) throw Error('fixture unavailable canonical nonce');
        result = '0x' + mode.minedNonce.toString(16);
      } else result = '0x' + mode.pendingNonce.toString(16);
    } else if (method === 'eth_gasPrice') result = '0x989680';
    else if (method === 'eth_maxPriorityFeePerGas') result = '0xf4240';
    else if (method === 'eth_getBalance') result = '0x8ac7230489e80000';
    else if (method === 'eth_estimateGas') result = '0x5208';
    else if (method === 'eth_getCode') {
      assert.equal(params[1].requireCanonical, true);
      result = mode.recipientCode || '0x';
    } else if (method === 'eth_call') {
      const target = params[0].to.toLowerCase();
      const feed = ['eth', 'usdc'].find((key) => BASE_FEEDS[key].address.toLowerCase() === target);
      const sequencer = BASE_FEEDS.sequencer.toLowerCase() === target;
      if (feed || sequencer) {
        assert.equal(params[1].requireCanonical, true);
        const now = Math.floor(Date.now() / 1000);
        const answer = sequencer
          ? mode.sequencerDown
            ? 1n
            : 0n
          : feed === 'eth'
            ? (mode.ethPrice ?? 200000000000n)
            : 100000000n;
        result =
          params[0].data === feedAbi.getFunction('decimals').selector
            ? word(8)
            : feedAbi.encodeFunctionResult('latestRoundData', [
                1,
                answer,
                now - (sequencer ? 7200 : 60),
                now - 30,
                1,
              ]);
      } else result = word(target === CHAINS.base.usdc ? mode.balance : 0n);
    } else if (method === 'eth_getTransactionReceipt') result = null;
    else if (method === 'eth_sendRawTransaction') {
      writes.push(params[0]);
      result = keccak256(params[0]);
      mode.pendingNonce++;
    } else throw Error('Unexpected fixture RPC ' + method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  let service = new WalletService({ directory, fetcher });
  const wallet = await service.request('import', {
    name: 'Public capital fixture',
    kind: 'privateKey',
    secret: '0x' + '01'.padStart(64, '0'),
    password,
  });
  await service.request('unlock', { id: wallet.id, password, minutes: 0 });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const input = (commandId, amount, recipient = '0x' + '2'.repeat(40)) => ({
    walletId: wallet.id,
    commandId,
    to: CHAINS.base.usdc,
    value: '0',
    data: abi.encodeFunctionData('transfer', [recipient, amount]),
  });
  return {
    get service() {
      return service;
    },
    wallet,
    mode,
    writes,
    input,
    async reopen() {
      await service.dispose();
      service = new WalletService({ directory, fetcher });
    },
    async holdings() {
      return portfolioCapital(
        {
          chainId: 8453,
          members: [
            {
              walletId: wallet.id,
              ...(await service.market.tokenHoldings(
                { venue: 'base' },
                { address: wallet.address },
                { includeNonce: true },
              )),
            },
          ],
          assets: [],
        },
        service.state.intents,
      );
    },
  };
}

test('two concurrent plans cannot reserve the same ERC-20 balance and denying an unsigned intent releases only its reserve', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const result = await Promise.allSettled([
    s.prepare({ venue: 'base' }, f.input('one', 6000000n)),
    s.prepare({ venue: 'base' }, f.input('two', 5000000n)),
  ]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.match(result[1].reason.message, /WALLET_TOKEN_CAPITAL_RESERVED/);
  assert.equal(s.state.intents.length, 1);
  const held = (await f.holdings()).members[0].assets[1].capital;
  assert.equal(held.reservedAtomic, '6000000');
  assert.equal(held.availableAtomic, '4000000');
  await s.request('intent.deny', { id: result[0].value.id, digest: result[0].value.digest });
  await s.prepare({ venue: 'base' }, f.input('three', 5000000n));
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '5000000');
  assert.equal(f.writes.length, 0);
});

test('approval amounts are not cash reservations and a changed balance is rechecked before signing', async (t) => {
  const f = await fixture(t),
    s = f.service;
  await s.prepare(
    { venue: 'base' },
    {
      ...f.input('allowance', 1n),
      data: abi.encodeFunctionData('approve', ['0x' + '3'.repeat(40), (1n << 256n) - 1n]),
    },
  );
  const transfer = await s.prepare({ venue: 'base' }, f.input('spend', 10000000n));
  const snapshot = await f.holdings();
  assert.equal(snapshot.capital.approvalCount, 1);
  assert.equal(snapshot.members[0].assets[1].capital.reservedAtomic, '10000000');
  // The approval occupies nonce 0. Test the approved transfer when it becomes next.
  f.mode.minedNonce = f.mode.pendingNonce = 1;
  await s.decide(transfer.id, true, transfer.digest);
  f.mode.balance = 9000000n;
  const result = await s.broadcast(transfer.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WALLET_TOKEN_CAPITAL_RESERVED');
  assert.equal(f.writes.length, 0);
  const store = await s.signer('receipt.status', { id: f.wallet.id });
  assert.equal(
    (
      await s.signer('receipt.get', {
        id: f.wallet.id,
        storeId: store.storeId,
        operationId: transfer.id,
      })
    ).found,
    false,
  );
});

test('portfolio equity requires native-bound evidence, accounts for reserves and rechecks after signing', async (t) => {
  const f = await fixture(t);
  const s = f.service;
  const input = {
    operation: 'create',
    name: 'Equity floor fixture',
    chainId: 8453,
    walletIds: [f.wallet.id],
    equityFloorUsd: '20005',
  };
  await assert.rejects(
    s.request('portfolio.challenge', { ...input, chainId: 84532 }),
    /EQUITY_INVALID/,
  );
  const challenge = await s.request('portfolio.challenge', input);
  assert.equal(challenge.portfolio.equityFloorUsdAtomic, '2000500000000');
  const { portfolio } = await s.request('portfolio.confirm', {
    challengeId: challenge.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  const overview = await s.request('portfolio.equity', { id: portfolio.id });
  assert.equal(overview.availableUsd, '20010');
  assert.equal(overview.status, 'satisfied');
  const big = await s.prepare({ venue: 'base' }, f.input('too-much', 6000000n));
  await s.decide(big.id, true, big.digest);
  const denied = await s.broadcast(big.id);
  assert.equal(denied.error, 'WALLET_PORTFOLIO_EQUITY_LOW');
  assert.equal(denied.portfolioRisk.phase, 'sign');
  assert.ok(
    BigInt(denied.portfolioRisk.availableUsdAtomic) < BigInt(denied.portfolioRisk.floorUsdAtomic),
  );
  const store = await s.signer('receipt.status', { id: f.wallet.id });
  const receipt = (intent) =>
    s.signer('receipt.get', { id: f.wallet.id, storeId: store.storeId, operationId: intent.id });
  assert.equal((await receipt(big)).found, false);
  const contractRecipient = await s.prepare(
    { venue: 'base' },
    {
      walletId: f.wallet.id,
      commandId: 'opaque-native-call',
      to: '0x' + '5'.repeat(40),
      value: '0.001',
    },
  );
  f.mode.recipientCode = '0x6000';
  await s.decide(contractRecipient.id, true, contractRecipient.digest);
  assert.equal((await s.broadcast(contractRecipient.id)).error, 'WALLET_PORTFOLIO_EQUITY_UNKNOWN');
  assert.equal((await receipt(contractRecipient)).found, false);
  f.mode.recipientCode = '0x';

  const small = await s.prepare({ venue: 'base' }, f.input('small', 1000000n));
  await s.decide(small.id, true, small.digest);
  const raw = s.state.intents.find((i) => i.id === small.id);
  await assert.rejects(
    s.signer('sign', {
      id: f.wallet.id,
      transaction: raw.transaction,
      storeId: store.storeId,
      operationId: small.id,
      expiresAt: raw.expiresAt,
      feeReserveWei: raw.feeReserveWei,
    }),
    /EQUITY_REQUIRED/,
  );
  assert.equal((await receipt(small)).found, false);
  const successful = await s.broadcast(small.id);
  assert.equal(successful.status, 'submitted');
  assert.equal(successful.portfolioRisk.phase, 'broadcast');
  assert.equal(f.writes.length, 1);
  f.mode.minedNonce = 1;
  f.mode.balance -= 1000000n;
  const late = await s.prepare(
    { venue: 'base' },
    f.input('after-price-drop', 1000000n, '0x' + '4'.repeat(40)),
  );
  await s.decide(late.id, true, late.digest);
  const signer = s.signer.bind(s);
  s.signer = async (action, params) => {
    const result = await signer(action, params);
    if (action === 'sign') f.mode.ethPrice = 190000000000n;
    return result;
  };
  const blocked = await s.broadcast(late.id);
  assert.equal(blocked.error, 'WALLET_PORTFOLIO_EQUITY_LOW');
  assert.equal(blocked.portfolioRisk.phase, 'broadcast');
  assert.equal(blocked.submissionMayHaveOccurred, false);
  assert.equal((await receipt(late)).found, true);
  assert.equal(f.writes.length, 1);
  await f.reopen();
  assert.equal((await f.service.request('portfolio.equity', { id: portfolio.id })).status, 'below');
  assert.equal(
    (await f.service.request('portfolio.get', { id: portfolio.id })).portfolio.equityFloorUsdAtomic,
    '2000500000000',
  );
  f.mode.sequencerDown = true;
  const unavailable = await f.service.request('portfolio.equity', { id: portfolio.id });
  assert.equal(unavailable.error, 'WALLET_PORTFOLIO_EQUITY_UNAVAILABLE');
  const remove = await f.service.request('portfolio.challenge', {
    operation: 'edit',
    id: portfolio.id,
    revision: 1,
    equityFloorUsd: '',
    limits: {},
  });
  assert.equal(
    (await f.service.request('portfolio.equity', { id: portfolio.id })).status,
    'unavailable',
  );
  await f.service.request('portfolio.confirm', {
    challengeId: remove.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  assert.equal(
    (await f.service.request('portfolio.equity', { id: portfolio.id })).status,
    'disabled',
  );
});

test('opaque pending calls and unavailable canonical nonce prevent false token availability', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const opaque = await s.prepare(
    { venue: 'base' },
    { ...f.input('opaque', 1n), data: '0x12345678' },
  );
  await assert.rejects(
    s.prepare({ venue: 'base' }, f.input('after-opaque', 1n)),
    /WALLET_CAPITAL_UNKNOWN_CALL/,
  );
  assert.equal((await f.holdings()).members[0].assets[1].capital.availableAtomic, null);
  await s.request('intent.deny', { id: opaque.id, digest: opaque.digest });
  f.mode.nonceFailure = true;
  await assert.rejects(
    s.prepare({ venue: 'base' }, f.input('without-nonce', 1n)),
    /WALLET_CAPITAL_UNAVAILABLE/,
  );
  assert.equal(f.writes.length, 0);
});

test('a cancelled but committed signature retains token capital through restart, recovery and nonce reorg', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const intent = await s.prepare({ venue: 'base' }, f.input('signed-but-stopped', 6000000n));
  await s.decide(intent.id, true, intent.digest);
  const controller = new AbortController(),
    original = s.signer.bind(s);
  s.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') controller.abort();
    return result;
  };
  const stopped = await s.broadcast(intent.id, controller.signal);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.hash, undefined);
  assert.equal(requiresRecovery(s.state.intents[0]), true);
  assert.equal(s.emergencyStatus().needsReconciliation, 1);
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '6000000');
  const replacement = await s.prepare(
    { venue: 'base' },
    f.input('same-nonce-alternative', 8000000n),
  );
  assert.ok(replacement.replacementOf);
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '8000000');
  await s.request('intent.deny', { id: replacement.id, digest: replacement.digest });
  await f.reopen();
  assert.equal(f.service.isUnlocked(f.wallet.id), false);
  const recovered = await f.service.reconcile(intent.id);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.submissionMayHaveOccurred, false);
  assert.match(recovered.hash, /^0x[\da-f]{64}$/);
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '6000000');
  f.mode.minedNonce = f.mode.pendingNonce = 1;
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '0');
  await f.service.request('unlock', { id: f.wallet.id, password, minutes: 0 });
  const next = await f.service.prepare(
    { venue: 'base' },
    f.input('after-consumed-cancelled-nonce', 1n),
  );
  await f.service.request('intent.deny', { id: next.id, digest: next.digest });
  f.mode.minedNonce = 0;
  assert.equal((await f.holdings()).members[0].assets[1].capital.reservedAtomic, '6000000');
  assert.equal(f.writes.length, 0);
});

test('capital analysis is part of the immutable human approval', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const intent = await s.prepare({ venue: 'base' }, f.input('immutable-analysis', 1n));
  await s.mutate((state) => {
    state.intents[0].capital.effects[0].amountAtoms = '0';
  });
  await assert.rejects(s.decide(intent.id, true, intent.digest), /WALLET_INTENT_CHANGED/);
  assert.equal(f.writes.length, 0);
});

test('portfolio free amounts never use another wallet balance to hide a member shortfall', async (t) => {
  const f = await fixture(t),
    s = f.service;
  await s.prepare({ venue: 'base' }, f.input('committed-before-external-spend', 6000000n));
  f.mode.balance = 5000000n;
  const one = (await f.holdings()).members[0];
  const two = {
    ...one,
    walletId: 'other',
    address: '0x' + '4'.repeat(40),
    assets: one.assets.map((a) => ({
      ...a,
      ...(a.address?.toLowerCase() === CHAINS.base.usdc ? { amountAtomic: '10000000' } : {}),
    })),
  };
  const result = portfolioCapital(
    { chainId: 8453, members: [one, two], assets: one.assets },
    s.state.intents,
  );
  assert.equal(result.assets[1].capital.reservedAtomic, '6000000');
  assert.equal(result.assets[1].capital.availableAtomic, '10000000');
  assert.equal(result.assets[1].capital.shortfallAtomic, '1000000');
  assert.equal(result.members[0].assets[1].capital.availableAtomic, '0');
  assert.equal(result.members[1].assets[1].capital.availableAtomic, '10000000');
});

test('capital reading failure during preparation cannot outlive a lock and create a new approval', async (t) => {
  const f = await fixture(t),
    s = f.service,
    original = s.market.tokenHoldings.bind(s.market);
  let entered, release;
  const started = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  s.market.tokenHoldings = async (...args) => {
    const value = await original(...args);
    entered();
    await gate;
    return value;
  };
  const pending = s.prepare({ venue: 'base' }, f.input('locked-during-capital-read', 1n));
  const rejected = assert.rejects(pending, /WALLET_UNLOCK_CHANGED/);
  await started;
  await s.request('lock', { id: f.wallet.id });
  release();
  await rejected;
  assert.equal(s.state.intents.length, 0);
  assert.equal(f.writes.length, 0);
});

test('capital display supports all ERC-20 decimal values and keeps unavailable decimals in atomic units', () => {
  const asset = {
    kind: 'erc20',
    address: '0x' + '3'.repeat(40),
    symbol: null,
    amountAtomic: '1',
    decimals: 255,
  };
  const snapshot = {
    chainId: 8453,
    assets: [asset],
    members: [
      { walletId: 'one', address: '0x' + '1'.repeat(40), minedNonce: '0', assets: [asset] },
    ],
  };
  const value = portfolioCapital(snapshot, []).assets[0].capital;
  assert.equal(value.availableAtomic, '1');
  assert.equal(value.available, '0.' + '0'.repeat(254) + '1');
  asset.decimals = null;
  const raw = portfolioCapital(snapshot, []).assets[0].capital;
  assert.equal(raw.complete, true);
  assert.equal(raw.available, null);
  assert.equal(raw.availableAtomic, '1');
});
