/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Transaction, keccak256, Interface } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const password = 'public-custom-network-fixture-password';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-wallet-networks-'));
  const mode = { id: 1337, genesis: '0x' + 'a'.repeat(64), type2: true },
    calls = [],
    writes = [];
  const fetcher = async (url, options) => {
    const { method, params } = JSON.parse(options.body);
    calls.push({ url, method, params });
    let result;
    if (method === 'eth_chainId') result = '0x' + mode.id.toString(16);
    else if (method === 'eth_getBlockByNumber')
      result = {
        number: params[0] === '0x0' ? '0x0' : '0x10',
        hash: params[0] === '0x0' ? mode.genesis : '0x' + 'b'.repeat(64),
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        ...(mode.type2 ? { baseFeePerGas: '0x1' } : {}),
      };
    else if (method === 'eth_getTransactionCount') result = '0x0';
    else if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') result = '0x1';
    else if (method === 'eth_getBalance') result = '0x8ac7230489e80000';
    else if (method === 'eth_estimateGas') result = '0x5208';
    else if (method === 'eth_call') {
      assert.notEqual(
        params[0].to.toLowerCase(),
        '0x420000000000000000000000000000000000000f',
        'A generic EVM network must not call the Base fee oracle',
      );
      result =
        '0x' + (params[0].data === '0x313ce567' ? 6n : 5000000n).toString(16).padStart(64, '0');
    } else if (method === 'eth_sendRawTransaction') {
      writes.push(Transaction.from(params[0]));
      result = keccak256(params[0]);
    } else if (method === 'eth_getTransactionReceipt') result = null;
    else throw Error('Unexpected RPC ' + method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  let service = new WalletService({ directory, fetcher });
  t.after(async () => {
    await service.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-wallet-networks-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const input = {
    id: 1337,
    name: 'Local EVM',
    nativeSymbol: 'TEST',
    nativeDecimals: 18,
    rpc: 'http://127.0.0.1:8545/private-provider-path',
    additionalFeeNative: '0.00002',
  };
  return {
    get service() {
      return service;
    },
    directory,
    mode,
    calls,
    writes,
    input,
    async save(extra = {}) {
      const c = await service.request('network.challenge', { ...input, ...extra });
      return service.request('network.confirm', {
        challengeId: c.id,
        ack: 'SAVE NETWORK',
        confirmed: true,
      });
    },
    async wallet() {
      const w = await service.request('import', {
        name: 'Public network fixture',
        kind: 'privateKey',
        secret: '0x' + '01'.padStart(64, '0'),
        password,
      });
      await service.request('unlock', { id: w.id, password, minutes: 0 });
      return w;
    },
    async reopen() {
      await service.dispose();
      service = new WalletService({ directory, fetcher });
    },
  };
}
test('custom networks verify identity, freeze review, hide provider paths and persist capabilities', async (t) => {
  const f = await fixture(t),
    s = f.service;
  const c = await s.request('network.challenge', f.input);
  f.input.name = 'Changed after review';
  assert.equal(c.profile.name, 'Local EVM');
  assert.equal(c.profile.rpc, undefined);
  assert.equal(c.profile.rpcOrigin, 'http://127.0.0.1:8545');
  await assert.rejects(
    s.request('network.confirm', { challengeId: c.id, ack: 'wrong', confirmed: true }),
    /CONFIRMATION_REQUIRED/,
  );
  const profile = await f.save();
  assert.equal(profile.key, 'evm-1337');
  assert.equal(profile.revision, 1);
  assert.equal(profile.capabilities.signType2, true);
  assert.equal(profile.capabilities.autonomous, true);
  assert.ok(f.calls.every((c) => c.method !== 'eth_sendRawTransaction'));
  await assert.rejects(f.save({ revision: 0 }), /WALLET_NETWORK_CHANGED/);
  await f.reopen();
  assert.equal((await f.service.request('network.list')).items.length, 3);
  assert.equal((await f.service.request('network.config', { key: profile.key })).rpc, f.input.rpc);
  f.mode.genesis = '0x' + 'c'.repeat(64);
  await assert.rejects(f.save({ revision: 1 }), /WALLET_NETWORK_GENESIS/);
});
test('real native signing supports reviewed type-2 custom EVM transfers with the configured additional reserve', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  const proposal = await s.request('transaction.prepare', {
    id: w.id,
    chain: p.key,
    to: '0x' + '2'.repeat(40),
    value: '0.001',
  });
  assert.equal(proposal.status, 'approval-required');
  assert.equal(proposal.transaction.chainId, 1337);
  assert.equal(proposal.nativeSymbol, 'TEST');
  assert.equal(proposal.l1FeeEstimateWei, '0');
  assert.equal(proposal.additionalFeeReserveWei, '20000000000000');
  assert.equal(f.writes.length, 0);
  const sent = await s.request('intent.approve', { id: proposal.id, digest: proposal.digest });
  assert.equal(sent.status, 'submitted');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].chainId, 1337n);
  assert.equal(f.writes[0].value, 1000000000000000n);
  assert.equal(f.writes[0].from, w.address);
  const manual = await s.prepare(
    { venue: p.key },
    { walletId: w.id, commandId: 'not-implicit-auto', to: w.address, value: '0.001' },
    { actor: 'agent' },
  );
  assert.equal(manual.status, 'approval-required');
  assert.equal(manual.authorization.mode, 'manual');
  const challenge = await s.request('policy.challenge', { id: w.id, chains: [1337] });
  assert.deepEqual(challenge.networkRevisions, { 'evm-1337': 1 });
});
test('custom ERC-20 tracking uses the same block-bound balance and signing path', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service,
    token = '0x' + '3'.repeat(40);
  await s.request('asset.track', { id: w.id, chain: p.key, token });
  const snapshot = await s.request('assets', { id: w.id, chain: p.key });
  assert.equal(snapshot.assets.length, 2);
  assert.equal(snapshot.assets[0].symbol, 'TEST');
  assert.equal(snapshot.assets[1].amount, '5');
  const abi = new Interface(['function transfer(address,uint256) returns(bool)']);
  const proposal = await s.request('transaction.prepare', {
    id: w.id,
    chain: p.key,
    to: token,
    value: '0',
    data: abi.encodeFunctionData('transfer', ['0x' + '4'.repeat(40), 1000000n]),
  });
  assert.equal(
    (await s.request('intent.approve', { id: proposal.id, digest: proposal.digest })).status,
    'submitted',
  );
  assert.equal(f.writes.length, 1);
  await f.reopen();
  assert.deepEqual((await f.service.request('list')).wallets[0].trackedTokens[p.key], [token]);
});
test('configuration edits fence old approvals and archive stops only the affected network', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  const proposal = await s.request('transaction.prepare', {
    id: w.id,
    chain: p.key,
    to: '0x' + '2'.repeat(40),
    value: '0.001',
  });
  await s.decide(proposal.id, true, proposal.digest);
  const base = new AbortController(),
    custom = new AbortController();
  s.inFlight.set('base', { network: 'base', controller: base });
  s.inFlight.set('custom', { network: p.key, controller: custom });
  const edited = await f.save({ revision: 1, name: 'Updated local EVM' });
  assert.equal(base.signal.aborted, false);
  assert.equal(custom.signal.aborted, true);
  const result = await s.broadcast(proposal.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WALLET_NETWORK_CHANGED');
  assert.equal(f.writes.length, 0);
  const archived = await s.request('network.archive', { key: p.key, revision: edited.revision });
  assert.equal(archived.capabilities.signType2, false);
  await assert.rejects(
    s.request('transaction.prepare', { id: w.id, chain: p.key, to: w.address, value: '0.001' }),
    /WALLET_CHAIN_UNAVAILABLE/,
  );
});
test('RPC chain and genesis mismatches or missing type-2 support cannot reach signing', async (t) => {
  const f = await fixture(t);
  f.mode.id = 1;
  await assert.rejects(f.save(), /CHAIN_ID_MISMATCH/);
  f.mode.id = 1337;
  const p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  f.mode.genesis = '0x' + 'd'.repeat(64);
  await assert.rejects(
    s.request('transaction.prepare', { id: w.id, chain: p.key, to: w.address, value: '0.001' }),
    /WALLET_NETWORK_GENESIS/,
  );
  f.mode.genesis = '0x' + 'a'.repeat(64);
  f.mode.type2 = false;
  await assert.rejects(
    s.request('transaction.prepare', { id: w.id, chain: p.key, to: w.address, value: '0.001' }),
    /WALLET_NETWORK_TYPE/,
  );
  assert.equal(s.state.intents.length, 0);
  assert.equal(f.writes.length, 0);
});

test('built-in Base RPC edits preserve protocol addresses, fees and identity through restart', async (t) => {
  const f = await fixture(t);
  f.mode.id = 8453;
  const p = await f.save({ id: 8453, name: 'Base', nativeSymbol: 'ETH', revision: 1 });
  assert.equal(p.key, 'base');
  assert.equal(p.builtin, true);
  assert.equal(p.revision, 2);
  assert.equal(p.feeModel, 'op-stack');
  assert.equal(p.capabilities.autonomous, true);
  const original = require('../../src/main/services/quant/market-data').CHAINS.base;
  assert.equal(p.usdc, original.usdc);
  assert.equal(p.factory, original.factory);
  await f.reopen();
  assert.equal(f.service.networks.profile('base').rpc, f.input.rpc);
  assert.equal((await f.service.request('network.list')).items.length, 2);
});

test('an edit blocks an obsolete manual confirmation and missing or duplicate network records fail closed', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  const intent = await s.request('transaction.prepare', {
    id: w.id,
    chain: p.key,
    to: w.address,
    value: '0',
  });
  await f.save({ revision: p.revision, name: 'Edited' });
  assert.equal((await s.request('intent.inspect', { id: intent.id })).networkBlocked, true);
  await assert.rejects(s.decide(intent.id, true, intent.digest), /WALLET_NETWORK_CHANGED/);
  const stored = JSON.parse(fs.readFileSync(s.networks.file, 'utf8'));
  stored.profiles.push(structuredClone(stored.profiles[0]));
  fs.writeFileSync(s.networks.file, JSON.stringify(stored));
  assert.throws(
    () => new WalletService({ directory: f.directory }),
    /WALLET_NETWORK_STORE_CORRUPT/,
  );
  fs.unlinkSync(s.networks.file);
  assert.throws(
    () => new WalletService({ directory: f.directory }),
    /WALLET_NETWORK_STORE_CORRUPT/,
  );
  assert.equal(f.writes.length, 0);
});

test('a network edit after native signing blocks broadcast and retains locked receipt recovery across restart', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  const intent = await s.request('transaction.prepare', {
    id: w.id,
    chain: p.key,
    to: '0x' + '2'.repeat(40),
    value: '0.001',
  });
  const review = await s.request('network.challenge', {
    ...f.input,
    revision: p.revision,
    name: 'Edited while signature reply is delayed',
  });
  const signed = Promise.withResolvers(),
    release = Promise.withResolvers(),
    original = s.signer.bind(s);
  s.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') {
      signed.resolve();
      await release.promise;
    }
    return result;
  };
  const sending = s.request('intent.approve', { id: intent.id, digest: intent.digest });
  try {
    await Promise.race([
      signed.promise,
      sending.then(() => {
        throw Error('Expected to reach native signing');
      }),
    ]);
    await s.request('network.confirm', {
      challengeId: review.id,
      ack: 'SAVE NETWORK',
      confirmed: true,
    });
  } finally {
    release.resolve();
  }
  const stopped = await sending;
  s.signer = original;
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error, 'WALLET_NETWORK_CHANGED');
  assert.equal(stopped.submissionMayHaveOccurred, false);
  assert.equal(stopped.networkBlocked, true);
  assert.equal(f.writes.length, 0);
  await s.request('lock', { id: w.id });
  const recovered = await s.reconcile(intent.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.submissionMayHaveOccurred, false);
  assert.match(recovered.hash, /^0x[\da-f]{64}$/);
  await f.reopen();
  const persisted = await f.service.request('intent.inspect', { id: intent.id });
  assert.equal(persisted.hash, recovered.hash);
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.submissionMayHaveOccurred, false);
  assert.equal(f.service.isUnlocked(w.id), false);
  assert.equal(f.writes.length, 0);
});

test('human automatic authority freezes registered network revisions and an edit requires a fresh grant', async (t) => {
  const f = await fixture(t),
    p = await f.save(),
    w = await f.wallet(),
    s = f.service;
  await assert.rejects(
    s.request('policy.challenge', { id: w.id, chains: [999] }),
    /CHAIN_UNAVAILABLE/,
  );
  await assert.rejects(
    s.request('policy.challenge', { id: w.id, chains: [1337, 1337] }),
    /CHAIN_UNAVAILABLE/,
  );
  const review = await s.request('policy.challenge', { id: w.id, chains: [1337] });
  await f.save({ revision: p.revision, name: 'Updated before grant' });
  await assert.rejects(
    s.request('policy.grant', { challengeId: review.id, ack: 'ALLOW LIVE', confirmed: true }),
    /WALLET_NETWORK_CHANGED/,
  );
  const current = await s.request('policy.challenge', {
    id: w.id,
    chains: [1337],
    limits: { maxTransactions: 1 },
  });
  const granted = await s.request('policy.grant', {
    challengeId: current.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  assert.deepEqual(granted.policy.networkRevisions, { 'evm-1337': 2 });
  const approved = await s.prepare(
    { venue: p.key },
    { walletId: w.id, commandId: 'custom-auto-reviewed', to: w.address, value: '0' },
    { actor: 'agent' },
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.authorization.mode, 'autonomous');
  assert.ok(approved.agentScope);
  await f.save({ revision: 2, name: 'Updated after grant' });
  const pending = await s.prepare(
    { venue: p.key },
    { walletId: w.id, commandId: 'custom-auto-stale', to: '0x' + '2'.repeat(40), value: '0' },
    { actor: 'agent' },
  );
  assert.equal(pending.status, 'approval-required');
  assert.equal(pending.authorization.mode, 'manual');
  assert.equal(s.policy(s.wallet(w.id), p.key), null);
  const displayed = (await s.request('list')).wallets[0];
  assert.equal(displayed.policy.mode, 'manual');
  assert.deepEqual(displayed.policy.inactiveNetworks, [1337]);
  await f.reopen();
  assert.equal(f.service.policy(f.service.wallet(w.id), p.key), null);
  assert.equal(f.writes.length, 0);
});

test('a saved grant requires its network identity even before the first transaction', async (t) => {
  const f = await fixture(t);
  await f.save();
  const w = await f.wallet(),
    s = f.service;
  const c = await s.request('policy.challenge', { id: w.id, chains: [1337] });
  await s.request('policy.grant', { challengeId: c.id, ack: 'ALLOW LIVE', confirmed: true });
  assert.equal(s.state.intents.length, 0);
  fs.unlinkSync(s.networks.file);
  assert.throws(
    () => new WalletService({ directory: f.directory }),
    /WALLET_NETWORK_STORE_CORRUPT/,
  );
});
