/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { Wallet, Transaction, keccak256, Interface } = require('ethers');
const { NativeSigner } = require('../../src/main/services/wallet/native-signer');
const { WalletService } = require('../../src/main/services/wallet');
const key = '0x' + '01'.padStart(64, '0'),
  password = 'public-fixture-only-password';
const transaction = {
  type: 2,
  chainId: 8453,
  nonce: 0,
  to: '0x' + '2'.repeat(40),
  value: '1',
  data: '0x',
  gasLimit: '21000',
  maxFeePerGas: '1000000000',
  maxPriorityFeePerGas: '1000000',
};
class Client {
  constructor(directory) {
    this.signer = new NativeSigner(directory);
    this.pending = new Map();
    this.signer.on('message', (message) => {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      message.error ? call.reject(Error(message.error)) : call.resolve(message.result);
    });
    const lost = (error) => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(error || Error('signer exited'));
      }
      this.pending.clear();
    };
    this.signer.on('error', lost);
    this.signer.on('exit', () => lost());
  }
  call(action, input = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error('fixture timeout'));
        }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.signer.send({ id, action, input: { id: 'test-wallet', ...input } }, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }
  async close() {
    if (this.signer.process.exitCode !== null || this.signer.process.signalCode !== null) return;
    const exited = once(this.signer.process, 'exit');
    this.signer.kill();
    await exited;
  }
}
function temporary(t, close = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-receipt-integration-'));
  t.after(async () => {
    await close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const calls = [];
async function fetcher(_url, options) {
  const body = JSON.parse(options.body);
  calls.push(body.method);
  const result = {
    eth_chainId: '0x2105',
    eth_getTransactionCount: '0x0',
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
  assert.notEqual(
    result,
    undefined,
    'No writes or unrecognized RPC in recovery fixture: ' + body.method,
  );
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}
async function worker(directory) {
  const service = new WalletService({ directory, fetcher });
  const wallet = await service.request('import', {
    kind: 'privateKey',
    secret: key,
    password,
    name: 'Public fixture wallet',
  });
  await service.request('unlock', { id: wallet.id, password, minutes: 0 });
  const challenge = await service.request('policy.challenge', { id: wallet.id, chains: [8453] });
  await service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  const original = service.signer.bind(service);
  service.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') {
      // A real native signature has committed. Exit the backend before its
      // broadcast function receives the result or persists a host-side hash.
      const exited = once(service.child.process, 'exit');
      service.child.kill();
      await exited;
      process.exit(0);
    }
    return result;
  };
  await service.transact(
    { venue: 'base' },
    { walletId: wallet.id, commandId: 'crash-fixture', to: transaction.to, value: '0.001' },
    { actor: 'agent' },
  );
  throw Error('fixture never reached signature');
}
if (process.argv.includes('--host-worker')) {
  worker(process.argv.at(-1)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  const test = require('node:test');
  test('actual signer commits before an unreadable reply, restarts locked and rejects ID reuse', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const imported = await client.call('import', { kind: 'privateKey', secret: key, password });
    await client.call('unlock', { keystore: imported.keystore, password, minutes: 0 });
    const { storeId } = await client.call('receipt.status'),
      operationId = randomUUID();
    const groupId = randomUUID();
    await client.call('portfolio.create', {
      id: groupId,
      portfolio: {
        id: groupId,
        name: 'Reply-loss fixture budget',
        chainId: 8453,
        members: [{ walletId: 'test-wallet', address: imported.address }],
        limits: { maxTransactions: 1 },
        maxFeeWei: '0',
        expiresAt: 0,
      },
    });
    const input = {
      storeId,
      operationId,
      transaction,
      expiresAt: Date.now() + 60000,
      feeReserveWei: String(BigInt(transaction.gasLimit) * BigInt(transaction.maxFeePerGas)),
    };
    await client.call('operation.approve', input);
    // Closing the read end causes the native reply to fail after commit.
    const exited = once(client.signer.process, 'exit');
    client.signer.process.stdout.destroy();
    client.signer.send(
      { id: randomUUID(), action: 'sign', input: { id: 'test-wallet', ...input } },
      () => {},
    );
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error('native process did not exit after broken reply pipe')),
          10000,
        );
        timer.unref();
      }),
    ]);
    client = new Client(directory);
    assert.equal((await client.call('portfolio.get', { id: groupId })).usage.transactions, 1);
    const result = await client.call('receipt.get', { storeId, operationId });
    const expected = await new Wallet(key).signTransaction(transaction);
    assert.equal(result.found, true);
    assert.equal(result.receipt.hash, keccak256(expected));
    assert.equal(
      result.receipt.unsignedHash,
      keccak256(Transaction.from(transaction).unsignedSerialized),
    );
    assert.equal(result.receipt.raw, undefined);
    assert.ok(
      !fs
        .readFileSync(path.join(directory, 'signer-receipts/receipts.sqlite'))
        .includes(Buffer.from(expected)),
      'The broadcastable signature must be encrypted at rest',
    );
    await assert.rejects(client.call('sign', input), /LOCKED/);
    await client.call('unlock', { keystore: imported.keystore, password, minutes: 0 });
    await assert.rejects(client.call('sign', input), /APPROVAL_REQUIRED/);
    await client.call('operation.approve', input);
    assert.equal((await client.call('sign', input)).raw, expected);
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, value: '2' } }),
      /RECEIPT_CONFLICT/,
    );
    await assert.rejects(
      client.call('receipt.get', { ...input, storeId: 'f'.repeat(64) }),
      /STORE_CHANGED/,
    );
    await client.call('lock');
    assert.equal((await client.call('receipt.get', { storeId, operationId })).found, true);
    assert.equal(
      (await client.call('receipt.get', { storeId, operationId: 'unused' })).found,
      false,
    );
  });
  test('a real backend crash after native signing recovers the exact hash while locked without rebroadcast', async (t) => {
    let service;
    const directory = temporary(t, () => service?.dispose());
    const child = fork(__filename, ['--host-worker', directory], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let errors = '';
    child.stderr.on('data', (data) => (errors += data));
    const timer = setTimeout(() => child.kill(), 15000);
    const [code] = await once(child, 'exit');
    clearTimeout(timer);
    assert.equal(code, 0, errors);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    const before = saved.intents[0];
    assert.equal(before.status, 'signing');
    assert.equal(before.hash, undefined);
    assert.ok(before.nativeSigning.storeId);
    service = new WalletService({ directory, fetcher });
    assert.equal(service.state.intents[0].status, 'signing-unknown');
    assert.equal(service.isUnlocked(before.walletId), false);
    const result = await service.reconcile(before.id);
    assert.equal(result.status, 'submit-unknown');
    assert.equal(result.submissionMayHaveOccurred, true);
    assert.equal(result.nativeSigning, undefined);
    assert.equal(result.hash, keccak256(await new Wallet(key).signTransaction(before.transaction)));
    await service.monitor();
    assert.ok(!calls.includes('eth_sendRawTransaction'));
    assert.equal(service.isUnlocked(before.walletId), false);
    const retried = await service.transact(
      { venue: 'base' },
      { walletId: before.walletId, commandId: 'crash-fixture', to: transaction.to, value: '0.001' },
      { actor: 'agent' },
    );
    assert.equal(retried.id, before.id);
    assert.equal(retried.hash, result.hash);
  });
  test('replacing the native ledger after a crash keeps the operation unresolved', async (t) => {
    let service;
    const directory = temporary(t, () => service?.dispose());
    const child = fork(__filename, ['--host-worker', directory], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let errors = '';
    child.stderr.on('data', (data) => (errors += data));
    const timer = setTimeout(() => child.kill(), 15000);
    const [code] = await once(child, 'exit');
    clearTimeout(timer);
    assert.equal(code, 0, errors);
    fs.renameSync(path.join(directory, 'signer-receipts'), path.join(directory, 'saved-ledger'));
    service = new WalletService({ directory, fetcher });
    const intent = service.state.intents[0];
    await assert.rejects(service.reconcile(intent.id), /WALLET_RECEIPT_STORE_CHANGED/);
    assert.equal(service.state.intents[0].status, 'signing-unknown');
    assert.equal(service.state.intents[0].submissionMayHaveOccurred, undefined);
    assert.equal(service.emergencyStatus().needsReconciliation, 1);
    assert.ok(!calls.includes('eth_sendRawTransaction'));
  });
  async function account(client, id = 'test-wallet', secret = key) {
    const imported = await client.call('import', { id, kind: 'privateKey', secret, password });
    await client.call('unlock', { id, keystore: imported.keystore, password, minutes: 0 });
    const store = await client.call('receipt.status');
    return { ...imported, ...store };
  }
  function signing(store, nonce = 0) {
    return {
      storeId: store.storeId,
      operationId: randomUUID(),
      transaction: { ...transaction, nonce },
      expiresAt: Date.now() + 60000,
      feeReserveWei: '21000000000000',
    };
  }
  async function permission(client, store, generation, limits = {}) {
    generation ??= (await client.call('authority.revoke')).generation;
    const grant = {
      authorityVersion: 2,
      limits,
      generation,
      policyId: randomUUID(),
      walletId: 'test-wallet',
      address: store.address,
      chains: [8453],
      expiresAt: Date.now() + 60000,
      maxFeeWei: '42000000000000',
    };
    await client.call('authority.grant', { grant });
    return grant;
  }
  test('native manual approval binds the full transaction and unlock session; denial prevents replay', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client),
      input = signing(store);
    await assert.rejects(client.call('sign', input), /APPROVAL_REQUIRED/);
    await client.call('operation.approve', input);
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, value: '9' } }),
      /APPROVAL_REQUIRED/,
    );
    await assert.rejects(
      client.call('sign', { ...input, feeReserveWei: '22000000000000' }),
      /APPROVAL_REQUIRED/,
    );
    const result = await client.call('sign', input);
    assert.match(result.raw, /^0x02/);
    await client.call('lock');
    await client.call('unlock', { keystore: store.keystore, password, minutes: 0 });
    await assert.rejects(client.call('sign', input), /APPROVAL_REQUIRED/);
    await client.call('operation.approve', input);
    assert.equal((await client.call('sign', input)).raw, result.raw);
    await client.call('operation.deny', input);
    await assert.rejects(client.call('sign', input), /AUTH_REQUIRED/);
  });
  test('native grants enforce chain, fees, expiry, persistent generations and explicit nonce replacement', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client),
      grant = await permission(client, store);
    const input = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, chainId: 84532 } }),
      /AUTH_REQUIRED/,
    );
    await assert.rejects(
      client.call('sign', { ...input, feeReserveWei: '42000000000001' }),
      /FEE_LIMIT/,
    );
    await assert.rejects(client.call('sign', { ...input, feeReserveWei: '1' }), /FEE_LIMIT/);
    await assert.rejects(
      client.call('sign', { ...input, expiresAt: Date.now() - 1 }),
      /INTENT_EXPIRED/,
    );
    const signed = await client.call('sign', input);
    assert.equal((await client.call('sign', input)).raw, signed.raw);
    const replacement = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(client.call('sign', replacement), /NONCE_CONFIRMATION/);
    delete replacement.policyId;
    await client.call('operation.approve', replacement);
    await assert.rejects(client.call('sign', replacement), /NONCE_CONFIRMATION/);
    const explicit = {
      ...replacement,
      operationId: randomUUID(),
      replacementOf: signed.receipt.hash,
    };
    await client.call('operation.approve', explicit);
    await client.call('sign', explicit);
    const { generation } = await client.call('authority.revoke');
    await assert.rejects(
      client.call('sign', { ...signing(store, 1), policyId: grant.policyId }),
      /AUTH_REQUIRED/,
    );
    await assert.rejects(permission(client, store, generation - 1), /AUTH_CHANGED/);
    const fresh = await permission(client, store, generation);
    await client.call('sign', { ...signing(store, 1), policyId: fresh.policyId });
    const wrongAddress = { ...fresh, policyId: randomUUID(), address: '0x' + '3'.repeat(40) };
    await client.call('authority.grant', { grant: wrongAddress });
    await assert.rejects(
      client.call('sign', { ...signing(store, 2), policyId: wrongAddress.policyId }),
      /AUTH_REQUIRED/,
    );
    const short = { ...fresh, policyId: randomUUID(), expiresAt: Date.now() + 1000 };
    await client.call('authority.grant', { grant: short });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await assert.rejects(
      client.call('sign', { ...signing(store, 2), policyId: short.policyId }),
      /AUTH_REQUIRED/,
    );
  });
  test('native grant limits retain signed value, fees and count across restart without charging a replay', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    const grant = await permission(client, store, undefined, {
      maxValueWei: '1',
      maxTotalValueWei: '2',
      maxTotalFeeWei: '0',
      maxTransactions: 0,
    });
    const first = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(
      client.call('sign', { ...first, transaction: { ...transaction, value: '2' } }),
      /SCOPE_LIMIT/,
    );
    const raw = await client.call('sign', first);
    assert.equal((await client.call('sign', first)).raw, raw.raw);
    await client.close();
    client = new Client(directory);
    await client.call('unlock', { keystore: store.keystore, password, minutes: 0 });
    await client.call('sign', { ...signing(store, 1), policyId: grant.policyId });
    const denied = { ...signing(store, 2), policyId: grant.policyId };
    await assert.rejects(client.call('sign', denied), /SCOPE_LIMIT/);
    assert.equal((await client.call('receipt.get', denied)).found, false);
    const feeGrant = await permission(client, store, undefined, {
      maxTotalFeeWei: '21000000000000',
    });
    await client.call('sign', { ...signing(store, 2), policyId: feeGrant.policyId });
    await assert.rejects(
      client.call('sign', { ...signing(store, 3), policyId: feeGrant.policyId }),
      /SCOPE_LIMIT/,
    );
  });
  test('native target and outer method limits reject forbidden calls before producing a signature', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    let grant = await permission(client, store, undefined, {
      targets: [transaction.to],
      allowCalldata: false,
    });
    let input = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, to: '0x' + '3'.repeat(40) } }),
      /TARGET_LIMIT/,
    );
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, data: '0xa9059cbb' } }),
      /CALLDATA_LIMIT/,
    );
    grant = await permission(client, store, undefined, { selectors: ['0xa9059cbb'] });
    input = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(
      client.call('sign', { ...input, transaction: { ...transaction, data: '0x095ea7b3' } }),
      /CALLDATA_LIMIT/,
    );
    await client.call('sign', { ...input, transaction: { ...transaction, data: '0xa9059cbb' } });
  });
  test('explicit automatic replacement permission still requires the latest hash and consumes the shared budget', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    const grant = await permission(client, store, undefined, {
      allowReplacement: true,
      maxTransactions: 2,
    });
    const input = { ...signing(store), policyId: grant.policyId };
    const original = await client.call('sign', input);
    const next = {
      ...signing(store),
      policyId: grant.policyId,
      transaction: { ...transaction, value: '2' },
    };
    await assert.rejects(client.call('sign', next), /NONCE_CONFIRMATION/);
    await assert.rejects(
      client.call('sign', { ...next, replacementOf: '0x' + 'f'.repeat(64) }),
      /NONCE_CONFIRMATION/,
    );
    const signed = await client.call('sign', { ...next, replacementOf: original.receipt.hash });
    await assert.rejects(
      client.call('sign', {
        ...signing(store),
        policyId: grant.policyId,
        replacementOf: signed.receipt.hash,
      }),
      /SCOPE_LIMIT/,
    );
  });
  const tokenAddress = '0x' + '3'.repeat(40),
    otherToken = '0x' + '4'.repeat(40),
    recipient = '0x' + '5'.repeat(40),
    router = '0x2626664c2603336e57b271c5c0b26f421741e481';
  const tokenAbi = new Interface([
    'function transfer(address,uint256)',
    'function approve(address,uint256)',
    'function transferFrom(address,address,uint256)',
  ]);
  const swapAbi = new Interface([
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params)',
    'function multicall(uint256 deadline,bytes[] data)',
  ]);
  const tokenRule = (changes = {}) => ({
    chainId: 8453,
    address: tokenAddress,
    symbol: 'TEST',
    decimals: 6,
    maxAmountAtoms: '20',
    maxSignedAtoms: '30',
    maxApprovalAtoms: '20',
    allowApprovals: true,
    recipients: [recipient],
    spenders: [router],
    ...changes,
  });
  const tokenInput = (store, grant, method, args, nonce = 0) => ({
    ...signing(store, nonce),
    policyId: grant.policyId,
    transaction: {
      ...transaction,
      nonce,
      to: tokenAddress,
      value: '0',
      data: tokenAbi.encodeFunctionData(method, args),
    },
  });
  test('native token budgets account approval plus transfer exactly, survive restart, and never recharge a receipt replay', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client),
      grant = await permission(client, store, undefined, { tokens: [tokenRule()] });
    const input = tokenInput(store, grant, 'transfer', [recipient, 10]);
    const result = await client.call('sign', input);
    assert.equal((await client.call('sign', input)).raw, result.raw);
    await client.call('sign', tokenInput(store, grant, 'approve', [router, 20], 1));
    await client.call('lock');
    let snapshot = await client.call('authority.inspect', {
      storeId: store.storeId,
      policyId: grant.policyId,
    });
    assert.deepEqual(snapshot.usage.tokens['eip155:8453/erc20:' + tokenAddress], {
      transferAtoms: '10',
      approvalAtoms: '20',
      signatures: 2,
    });
    await client.close();
    client = new Client(directory);
    snapshot = await client.call('authority.inspect', {
      storeId: store.storeId,
      policyId: grant.policyId,
    });
    assert.equal(snapshot.usage.transactions, 2);
    await client.call('unlock', { keystore: store.keystore, password, minutes: 0 });
    const denied = tokenInput(store, grant, 'transfer', [recipient, 1], 2);
    await assert.rejects(client.call('sign', denied), /TOKEN_LIMIT/);
    assert.equal((await client.call('receipt.get', denied)).found, false);
    await assert.rejects(
      client.call('authority.inspect', {
        id: 'other-wallet',
        storeId: store.storeId,
        policyId: grant.policyId,
      }),
      /AUTH_REQUIRED/,
    );
    await client.call('authority.revoke');
    assert.equal(
      (await client.call('authority.inspect', { storeId: store.storeId, policyId: grant.policyId }))
        .revoked,
      true,
    );
  });
  test('native token scope rejects unknown ABI, noncanonical encoding, recipients, spenders and external transferFrom owners', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    let grant = await permission(client, store, undefined, { tokens: [tokenRule()] });
    for (const [method, args, error] of [
      ['transfer', [recipient, 21], 'TOKEN_LIMIT'],
      ['transfer', [router, 1], 'TOKEN_RECIPIENT'],
      ['approve', [recipient, 1], 'TOKEN_SPENDER'],
      ['transferFrom', [recipient, recipient, 1], 'TOKEN_UNCLASSIFIED'],
    ])
      await assert.rejects(
        client.call('sign', tokenInput(store, grant, method, args)),
        new RegExp(error),
      );
    const normal = tokenInput(store, grant, 'transfer', [recipient, 1]);
    for (const change of [
      { data: normal.transaction.data + '00' },
      { data: '0xa9059cbb' },
      { data: '0xdeadbeef' },
      { data: '0x' },
      { value: '1' },
      { to: otherToken },
    ])
      await assert.rejects(
        client.call('sign', { ...normal, transaction: { ...normal.transaction, ...change } }),
        /TOKEN_(UNCLASSIFIED|SCOPE)/,
      );
    grant = await permission(client, store, undefined, {
      tokens: [tokenRule({ allowApprovals: false })],
    });
    await assert.rejects(
      client.call('sign', tokenInput(store, grant, 'approve', [router, 1])),
      /TOKEN_APPROVAL/,
    );
    await client.call('sign', tokenInput(store, grant, 'approve', [recipient, 0]));
  });
  test('native Uniswap adapter decodes canonical batches and aggregates all swap inputs before the signature', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client),
      grant = await permission(client, store, undefined, {
        tokens: [tokenRule({ recipients: [store.address] }), tokenRule({ address: otherToken })],
      });
    const swap = (amount, changes = {}) =>
      swapAbi.encodeFunctionData('exactInputSingle', [
        {
          tokenIn: tokenAddress,
          tokenOut: otherToken,
          fee: 3000,
          recipient: store.address,
          amountIn: amount,
          amountOutMinimum: 1,
          sqrtPriceLimitX96: 0,
          ...changes,
        },
      ]);
    const batch = (calls) =>
      swapAbi.encodeFunctionData('multicall', [Math.floor(Date.now() / 1000) + 60, calls]);
    const input = (data) => ({
      ...signing(store),
      policyId: grant.policyId,
      transaction: { ...transaction, value: '0', to: router, data },
    });
    const analysis = await client.call('transaction.inspect', {
      transaction: input(batch([swap(5)])).transaction,
    });
    assert.equal(analysis.classified, true);
    assert.equal(analysis.effects[0].amountAtoms, '5');
    await assert.rejects(client.call('sign', input(batch([swap(11), swap(11)]))), /TOKEN_LIMIT/);
    for (const data of [
      swap(0),
      swap(1, { amountOutMinimum: 0 }),
      swap(1, { recipient }),
      swap(1, { tokenOut: recipient }),
      batch([batch([swap(1)])]),
      batch([tokenAbi.encodeFunctionData('approve', [router, 1])]),
      batch([swap(1)]) + '00',
    ])
      await assert.rejects(client.call('sign', input(data)), /TOKEN_(UNCLASSIFIED|SCOPE)/);
    const canonical = input(batch([swap(10), swap(10)]));
    const bytes = Buffer.from(canonical.transaction.data.slice(2), 'hex');
    bytes.fill(255, 36, 68);
    await assert.rejects(
      client.call('sign', input('0x' + bytes.toString('hex'))),
      /TOKEN_UNCLASSIFIED/,
    );
    await client.call('sign', canonical);
    const snapshot = await client.call('authority.inspect', {
      storeId: store.storeId,
      policyId: grant.policyId,
    });
    assert.equal(snapshot.usage.tokens['eip155:8453/erc20:' + tokenAddress].transferAtoms, '20');
  });
  const portfolio = (members, limits = {}) => ({
    id: randomUUID(),
    name: 'Public fixture portfolio',
    chainId: 8453,
    members,
    limits,
    maxFeeWei: '42000000000000',
    expiresAt: Date.now() + 60000,
  });
  test('native portfolio shares counters between wallets and manual/Agent signing, survives restart and wallet reauthorization', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const one = await account(client),
      two = await account(client, 'second-wallet', '0x' + '02'.padStart(64, '0'));
    const group = portfolio(
      [
        { walletId: 'test-wallet', address: one.address },
        { walletId: 'second-wallet', address: two.address },
      ],
      { maxTotalValueWei: '2', maxTransactions: 2 },
    );
    await client.call('portfolio.create', { id: group.id, portfolio: group });
    const first = signing(one);
    await client.call('operation.approve', first);
    const signed = await client.call('sign', first);
    assert.equal((await client.call('sign', first)).raw, signed.raw);
    const second = { ...signing(two), id: 'second-wallet' };
    await client.call('operation.approve', second);
    await client.call('sign', second);
    let snapshot = await client.call('portfolio.get', { id: group.id });
    assert.equal(snapshot.usage.valueWei, '2');
    assert.equal(snapshot.usage.transactions, 2);
    const grant = await permission(client, one),
      third = { ...signing(one, 1), policyId: grant.policyId };
    await assert.rejects(client.call('sign', third), /PORTFOLIO_LIMIT/);
    assert.equal((await client.call('receipt.get', third)).found, false);
    assert.equal(
      (await client.call('authority.inspect', { storeId: one.storeId, policyId: grant.policyId }))
        .usage.transactions,
      0,
    );
    await client.close();
    client = new Client(directory);
    snapshot = await client.call('portfolio.get', { id: group.id });
    assert.equal(snapshot.usage.transactions, 2);
    assert.equal(
      (await client.call('portfolio.create', { id: group.id, portfolio: group })).usage
        .transactions,
      2,
    );
    await assert.rejects(
      client.call('portfolio.create', { id: group.id, portfolio: { ...group, name: 'changed' } }),
      /PORTFOLIO_CHANGED/,
    );
    await client.call('unlock', { keystore: one.keystore, password, minutes: 0 });
    await assert.rejects(client.call('sign', third), /PORTFOLIO_LIMIT/);
  });
  test('native portfolio membership cannot be omitted or aliased and old signatures cannot bypass a new group', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    const before = signing(store);
    await client.call('operation.approve', before);
    await client.call('sign', before);
    const group = portfolio([{ walletId: 'test-wallet', address: store.address }]);
    await client.call('portfolio.create', { id: group.id, portfolio: group });
    await assert.rejects(client.call('sign', before), /PORTFOLIO_OLD_SIGNATURE/);
    const other = portfolio(group.members);
    await assert.rejects(
      client.call('portfolio.create', { id: other.id, portfolio: other }),
      /MEMBER_BUSY/,
    );
    await account(client, 'same-key-alias');
    const alias = { ...signing(store, 1), id: 'same-key-alias' };
    await client.call('operation.approve', alias);
    await assert.rejects(client.call('sign', alias), /MEMBER_CHANGED/);
    await client.call('portfolio.state', { id: group.id, kind: 'paused', expectedRevision: 1 });
    const next = signing(store, 1);
    await client.call('operation.approve', next);
    await assert.rejects(client.call('sign', next), /PORTFOLIO_PAUSED/);
    await assert.rejects(
      client.call('portfolio.state', { id: group.id, kind: 'active', expectedRevision: 1 }),
      /PORTFOLIO_CHANGED/,
    );
    await client.call('portfolio.state', { id: group.id, kind: 'active', expectedRevision: 2 });
    await client.call('sign', next);
    const removed = await client.call('portfolio.state', {
      id: group.id,
      kind: 'removed',
      expectedRevision: 3,
    });
    assert.equal(removed.usage.transactions, 1);
    await assert.rejects(
      client.call('portfolio.state', { id: group.id, kind: 'active', expectedRevision: 4 }),
      /PORTFOLIO_CHANGED/,
    );
    assert.equal((await client.call('portfolio.list')).total, 1);
    const replacement = portfolio(group.members);
    await client.call('portfolio.create', { id: replacement.id, portfolio: replacement });
    await assert.rejects(client.call('sign', next), /PORTFOLIO_OLD_SIGNATURE/);
  });
  test('native portfolio token budget aggregates different wallets and a denied signature leaves both ledgers unchanged', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const one = await account(client),
      two = await account(client, 'second-wallet', '0x' + '02'.padStart(64, '0'));
    const group = portfolio(
      [
        { walletId: 'test-wallet', address: one.address },
        { walletId: 'second-wallet', address: two.address },
      ],
      { tokens: [tokenRule()] },
    );
    await client.call('portfolio.create', { id: group.id, portfolio: group });
    const grant = await permission(client, one);
    await client.call('sign', tokenInput(one, grant, 'approve', [router, 20]));
    const second = {
      ...signing(two),
      id: 'second-wallet',
      transaction: {
        ...transaction,
        to: tokenAddress,
        value: '0',
        data: tokenAbi.encodeFunctionData('transfer', [recipient, 10]),
      },
    };
    await client.call('operation.approve', second);
    await client.call('sign', second);
    const bad = tokenInput(one, grant, 'transfer', [recipient, 1], 1);
    await assert.rejects(client.call('sign', bad), /TOKEN_LIMIT/);
    assert.equal((await client.call('receipt.get', bad)).found, false);
    const snapshot = await client.call('portfolio.get', { id: group.id });
    assert.equal(snapshot.usage.transactions, 2);
    assert.deepEqual(snapshot.usage.tokens['eip155:8453/erc20:' + tokenAddress], {
      transferAtoms: '10',
      approvalAtoms: '20',
      signatures: 2,
    });
    assert.equal(
      (await client.call('authority.inspect', { storeId: one.storeId, policyId: grant.policyId }))
        .usage.transactions,
      1,
    );
  });
  test('native scoped grants reject omitted or forged identity and cannot replay a signature under another leaf', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client),
      grant = await permission(client, store);
    grant.requireAgentScope = true;
    grant.policyId = randomUUID();
    await client.call('authority.grant', { grant });
    const root = {
      id: 'agent-root',
      subject: 'quant:fixture',
      label: 'Root',
      parentId: null,
      chainId: 8453,
      walletIds: ['test-wallet'],
      limits: { maxTransactions: 2 },
      maxFeeWei: '42000000000000',
      expiresAt: Date.now() + 60000,
    };
    const leaf = {
      ...root,
      id: 'agent-leaf',
      subject: 'native-sub-fixture',
      label: 'Child',
      parentId: root.id,
      limits: { maxTransactions: 1 },
    };
    await client.call('scope.ensure', { id: root.id, scope: root });
    await client.call('scope.ensure', { id: leaf.id, scope: leaf });
    const operation = { ...signing(store), policyId: grant.policyId };
    await assert.rejects(client.call('sign', operation), /AGENT_SCOPE_REQUIRED/);
    await assert.rejects(
      client.call('sign', { ...operation, agentScopeId: leaf.id, agentSubject: 'forged' }),
      /AGENT_SCOPE_FORBIDDEN/,
    );
    const scoped = { ...operation, agentScopeId: leaf.id, agentSubject: leaf.subject },
      signed = await client.call('sign', scoped);
    assert.equal((await client.call('sign', scoped)).raw, signed.raw);
    assert.equal((await client.call('scope.get', { id: root.id })).usage.transactions, 1);
    await assert.rejects(
      client.call('sign', { ...scoped, agentScopeId: root.id, agentSubject: root.subject }),
      /AGENT_SCOPE_OLD_SIGNATURE/,
    );
    await client.call('scope.state', {
      id: root.id,
      kind: 'paused',
      expectedRevision: 1,
      agentScopeId: root.id,
    });
    await assert.rejects(client.call('sign', scoped), /AGENT_SCOPE_PAUSED/);
    await assert.rejects(
      client.call('scope.state', {
        id: root.id,
        kind: 'active',
        expectedRevision: 2,
        agentScopeId: root.id,
      }),
      /FORBIDDEN/,
    );
    await client.close();
    client = new Client(directory);
    assert.equal((await client.call('scope.get', { id: leaf.id })).ready, false);
    assert.equal((await client.call('scope.get', { id: leaf.id })).usage.transactions, 1);
  });
  test('the native plan fee ledger survives restart and cannot reset through a new grant or scope', async (t) => {
    let client;
    const directory = temporary(t, () => client?.close());
    client = new Client(directory);
    const store = await account(client);
    let grant = await permission(client, store);
    const execution = {
      planId: 'execution:fee-ledger',
      scopeHash: 'a'.repeat(64),
      feeBudgetWei: '42000000000000',
    };
    const one = { ...signing(store), policyId: grant.policyId, execution };
    await client.call('sign', one);
    await client.close();
    client = new Client(directory);
    await client.call('unlock', { keystore: store.keystore, password, minutes: 0 });
    const two = { ...signing(store, 1), policyId: grant.policyId, execution };
    await client.call('sign', two);
    assert.equal((await client.call('sign', two)).receipt.operationId, two.operationId);
    const three = { ...signing(store, 2), policyId: grant.policyId, execution };
    await assert.rejects(client.call('sign', three), /PLAN_BUDGET/);
    assert.equal((await client.call('receipt.get', three)).found, false);
    await assert.rejects(
      client.call('sign', {
        ...three,
        execution: { ...execution, feeBudgetWei: '90000000000000' },
      }),
      /PLAN_CHANGED/,
    );
    grant = await permission(client, store);
    await assert.rejects(
      client.call('sign', { ...three, policyId: grant.policyId }),
      /PLAN_BUDGET/,
    );
  });
}
