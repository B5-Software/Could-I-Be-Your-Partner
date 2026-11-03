/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Wallet, keccak256, Transaction } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
async function fixture(t, { realSigner = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-wallet-'));
  const account = Wallet.createRandom(),
    calls = [],
    mode = { timeout: false, mined: false };
  const storeId = 'a'.repeat(64),
    receipts = new Map();
  let generation = 0;
  const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    let result;
    switch (body.method) {
      case 'eth_chainId':
        result = '0x2105';
        break;
      case 'eth_getTransactionCount':
        result = mode.nonce || '0x0';
        break;
      case 'eth_gasPrice':
        result = '0x989680';
        break;
      case 'eth_maxPriorityFeePerGas':
        result = '0xf4240';
        break;
      case 'eth_getBalance':
        result = '0x8ac7230489e80000';
        break;
      case 'eth_estimateGas':
        result = '0x5208';
        break;
      case 'eth_call':
        result = word(1000000000000n);
        break;
      case 'eth_getBlockByNumber':
        result = {
          number: body.params[0] === 'finalized' ? '0x80' : '0x100',
          hash: '0x' + 'a'.repeat(64),
          timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        };
        break;
      case 'eth_getTransactionReceipt':
        result = mode.mined
          ? { blockNumber: '0x90', blockHash: '0x' + 'a'.repeat(64), status: '0x1' }
          : null;
        break;
      case 'eth_sendRawTransaction':
        if (mode.send) {
          result = await mode.send(body, options);
          break;
        }
        if (mode.timeout) throw new Error('fixture timeout after network write');
        result = keccak256(body.params[0]);
        break;
      default:
        throw new Error('Unexpected RPC ' + body.method);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const signer = realSigner
    ? undefined
    : async (action, input) => {
        if (action === 'create')
          return {
            address: account.address,
            keystore: JSON.stringify({ encrypted: 'test-only-fixture-not-a-real-keystore' }),
          };
        if (action === 'unlock') return { address: account.address, until: 0 };
        if (action === 'lock') return { locked: true };
        if (action === 'authority.revoke') return { ok: true, generation: ++generation };
        if (action === 'authority.grant') return { ok: true, storeId };
        if (action === 'operation.approve' || action === 'operation.deny') return { ok: true };
        if (action === 'nonce.inspect') return { hash: null };
        if (action === 'scope.ensure')
          return {
            scope: input.scope,
            rootSubject: input.scope.subject,
            path: [input.id],
            ready: true,
          };
        if (action === 'receipt.status') return { version: 1, storeId };
        if (action === 'receipt.get') {
          if (input.storeId !== storeId) throw Error('WALLET_RECEIPT_STORE_CHANGED');
          return receipts.has(input.operationId)
            ? { found: true, receipt: receipts.get(input.operationId) }
            : { found: false, version: 1, storeId };
        }
        if (action === 'sign') {
          const raw = await account.signTransaction(input.transaction);
          const receipt = {
            version: 1,
            storeId,
            operationId: input.operationId,
            walletId: input.id,
            address: account.address,
            hash: keccak256(raw),
            unsignedHash: keccak256(Transaction.from(input.transaction).unsignedSerialized),
            chainId: input.transaction.chainId,
            nonce: input.transaction.nonce,
          };
          receipts.set(input.operationId, receipt);
          return { raw, receipt };
        }
        throw new Error('Unexpected signer command');
      };
  const service = new WalletService({ directory, fetcher, signer });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = await service.request('create', {
    password: 'fixture-password-which-is-not-real',
    name: 'Test-only wallet',
  });
  await service.request('unlock', {
    id: wallet.id,
    password: 'fixture-password-which-is-not-real',
    minutes: 0,
  });
  const input = {
    walletId: wallet.id,
    commandId: 'payment-1',
    to: '0x' + '1'.repeat(40),
    value: '0.001',
  };
  return { service, directory, wallet, input, calls, mode, account };
}
async function stopLive(service) {
  const state = await service.request('emergency.status');
  return service.request('emergency.halt', { expectedGeneration: state.generation });
}
async function resetLive(service) {
  const challenge = await service.request('emergency.challenge');
  return service.request('emergency.reset', {
    challengeId: challenge.id,
    ack: 'RESET LIVE',
    confirmed: true,
  });
}
test('global live stop interrupts a delayed signature, revokes authority and never sends the signed transaction', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const signer = service.signerOverride;
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  service.signerOverride = async (action, data) => {
    const result = await signer(action, data);
    if (action === 'sign') {
      entered();
      await gate;
    }
    return result;
  };
  const pending = service.transact({ venue: 'base' }, input, { actor: 'agent' });
  await ready;
  const status = await stopLive(service);
  assert.equal(status.halted, true);
  assert.equal(service.isUnlocked(wallet.id), false);
  assert.equal(service.policy(service.wallet(wallet.id), 'base'), null);
  release();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
});
test('global live stop survives restart and human reset leaves wallets locked, permissions manual and old intents unusable', async (t) => {
  const { service, directory, wallet, input } = await fixture(t);
  await grant(service, wallet);
  const old = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  const stopped = await stopLive(service);
  await service.emergencySweep;
  service.dispose();
  const reopened = new WalletService({ directory });
  t.after(() => reopened.dispose());
  assert.equal((await reopened.request('emergency.status')).latchId, stopped.latchId);
  await assert.rejects(
    reopened.request('unlock', { id: wallet.id, password: 'not-a-secret' }),
    /EMERGENCY_STOPPED/,
  );
  const first = await reopened.request('emergency.challenge');
  await assert.rejects(
    reopened.request('emergency.reset', { challengeId: first.id, ack: 'RESET LIVE' }),
    /CONFIRMATION_REQUIRED/,
  );
  assert.equal((await reopened.request('emergency.status')).halted, true);
  const reset = await resetLive(reopened);
  assert.equal(reset.halted, false);
  assert.equal(reopened.publicWallet(reopened.wallet(wallet.id)).policy.mode, 'manual');
  assert.equal(reopened.isUnlocked(wallet.id), false);
  assert.equal((await reopened.request('intent.inspect', { id: old.id })).status, 'cancelled');
  await assert.rejects(
    reopened.request('emergency.halt', { expectedGeneration: 'initial' }),
    /EMERGENCY_CHANGED/,
  );
});
test('a live stop does not claim accepted broadcasts are cancelled and reconciliation stays available', async (t) => {
  const { service, wallet, input, calls, mode } = await fixture(t);
  await grant(service, wallet);
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  mode.send = async (body) => {
    entered();
    await gate;
    return keccak256(body.params[0]);
  };
  const pending = service.transact({ venue: 'base' }, input, { actor: 'agent' });
  await ready;
  await stopLive(service);
  release();
  const result = await pending;
  assert.ok(result.hash);
  assert.equal(result.submissionMayHaveOccurred, true);
  assert.notEqual(result.status, 'cancelled');
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
  assert.equal((await service.request('emergency.status')).needsReconciliation, 1);
  mode.mined = true;
  const read = await service.request('intent.reconcile', { id: result.id });
  assert.ok(['included', 'safe', 'finalized'].includes(read.status));
});
test('the emergency barrier bypasses a busy wallet queue and a delayed grant cannot survive it', async (t) => {
  const { service, wallet } = await fixture(t);
  const challenge = await service.request('policy.challenge', { id: wallet.id, chains: [8453] });
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const ordinary = service.mutate(async () => {
    entered();
    await gate;
  });
  await ready;
  const grantAttempt = service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  const failed = assert.rejects(grantAttempt, /EMERGENCY/);
  const stopped = await stopLive(service);
  assert.equal(stopped.halted, true);
  release();
  await ordinary;
  await failed;
  await service.emergencySweep;
  await resetLive(service);
  assert.equal(service.publicWallet(service.wallet(wallet.id)).policy.mode, 'manual');
});
test('storage failure keeps live sending disabled; a retry persists the same latch and corrupt records fail closed', async (t) => {
  const { service, directory, wallet } = await fixture(t);
  const write = service.emergency.write;
  service.emergency.write = () => {
    throw Error('fixture full disk');
  };
  await assert.rejects(stopLive(service), /EMERGENCY_STORAGE_FAILED/);
  assert.equal(service.isUnlocked(wallet.id), false);
  const memory = await service.request('emergency.status');
  assert.ok(memory.storageError);
  assert.equal(memory.halted, true);
  await assert.rejects(service.request('emergency.challenge'), /EMERGENCY_CHANGED/);
  service.emergency.write = write;
  const retry = await service.request('emergency.halt', { expectedGeneration: memory.generation });
  assert.equal(retry.latchId, memory.latchId);
  assert.equal(retry.storageError, null);
  await service.emergencySweep;
  service.dispose();
  fs.writeFileSync(service.emergency.file, '{"record":{},"sha256":"tampered"}');
  assert.throws(() => new WalletService({ directory }), /EMERGENCY_STORE_CORRUPT/);
});

test('a delayed unlock and an older reset challenge cannot survive another live-stop boundary', async (t) => {
  const { service, wallet } = await fixture(t);
  const signer = service.signerOverride;
  let entered, release;
  const ready = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  service.signerOverride = async (action, input) => {
    const result = await signer(action, input);
    if (action === 'unlock') {
      entered();
      await gate;
    }
    return result;
  };
  const unlocking = service.request('unlock', {
    id: wallet.id,
    password: 'fixture-password-which-is-not-real',
    minutes: 0,
  });
  const rejected = assert.rejects(unlocking, /UNLOCK_CHANGED|EMERGENCY/);
  await ready;
  await stopLive(service);
  const stale = await service.request('emergency.challenge');
  await resetLive(service);
  release();
  await rejected;
  assert.equal(service.isUnlocked(wallet.id), false);
  await stopLive(service);
  await assert.rejects(
    service.request('emergency.reset', {
      challengeId: stale.id,
      ack: 'RESET LIVE',
      confirmed: true,
    }),
    /CONFIRMATION|EMERGENCY_CHANGED/,
  );
  assert.equal((await service.request('emergency.status')).halted, true);
});

test('restoring an older wallet state cannot restore a grant from before the durable global stop', async (t) => {
  const { service, directory, wallet } = await fixture(t);
  await grant(service, wallet);
  const oldState = fs.readFileSync(service.file, 'utf8');
  await stopLive(service);
  await resetLive(service);
  service.dispose();
  fs.writeFileSync(service.file, oldState);
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal((await restored.request('emergency.status')).halted, false);
  assert.equal(restored.policy(restored.wallet(wallet.id), 'base'), null);
  assert.equal(restored.publicWallet(restored.wallet(wallet.id)).policy.mode, 'manual');
});

test('a delayed native hold must finish before human reset and a failed pause can be retried without a new latch', async (t) => {
  const { service } = await fixture(t);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  service.onEmergencyHalt = () => gate;
  const initial = await stopLive(service);
  assert.equal(initial.nativePausePending, true);
  await assert.rejects(service.request('emergency.challenge'), /NATIVE_PAUSE_PENDING/);
  release();
  await service.emergencyPause;
  await resetLive(service);
  service.onEmergencyHalt = async () => {
    throw Error('fixture disconnected engine');
  };
  const failed = await stopLive(service);
  await service.emergencyPause;
  assert.ok((await service.request('emergency.status')).nativePauseError);
  await assert.rejects(service.request('emergency.challenge'), /NATIVE_PAUSE_FAILED/);
  service.onEmergencyHalt = () => undefined;
  const retried = await stopLive(service);
  assert.equal(retried.latchId, failed.latchId);
  assert.equal(retried.nativePauseError, null);
  await resetLive(service);
});

test('native signer encrypts keys, unlocks locally and does not persist passwords or phrases', async (t) => {
  const { service, directory, wallet } = await fixture(t, { realSigner: true });
  const files =
    fs.readFileSync(path.join(directory, 'keystores', wallet.id + '.json'), 'utf8') +
    fs.readFileSync(service.file, 'utf8');
  assert.equal(wallet.mnemonic.split(' ').length, 24);
  assert.ok(!files.includes(wallet.mnemonic));
  assert.ok(!files.includes('fixture-password-which-is-not-real'));
  assert.ok(service.isUnlocked(wallet.id));
  await service.request('lock', { id: wallet.id });
  assert.equal(service.isUnlocked(wallet.id), false);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { walletId: wallet.id, commandId: 'locked', to: '0x' + '1'.repeat(40), value: '0' },
    ),
    /LOCKED/,
  );
});
test('password rotation upgrades authenticated encryption, revokes local authority and stays locked across restart', async (t) => {
  const { service, directory, wallet } = await fixture(t, { realSigner: true });
  const challenge = await service.request('policy.challenge', {
    id: wallet.id,
    chains: [8453],
    hours: 1,
    maxFeeEth: '0.01',
  });
  await service.request('policy.grant', {
    challengeId: challenge.id,
    confirmed: true,
    ack: 'ALLOW LIVE',
  });
  const before = (await service.request('keystore.export', { id: wallet.id })).text;
  await assert.rejects(
    service.request('password.change', {
      id: wallet.id,
      password: 'wrong password',
      newPassword: 'new-test-only-password',
    }),
    /AUTHENTICATION/,
  );
  assert.equal((await service.request('keystore.export', { id: wallet.id })).text, before);
  assert.equal(service.isUnlocked(wallet.id), false);
  await service.request('password.change', {
    id: wallet.id,
    password: 'fixture-password-which-is-not-real',
    newPassword: 'new-test-only-password',
  });
  assert.equal(service.isUnlocked(wallet.id), false);
  const data = await service.request('list');
  assert.equal(data.wallets[0].policy.mode, 'manual');
  const after = (await service.request('keystore.export', { id: wallet.id })).text;
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).header.kdf.name, 'argon2id');
  assert.ok(!after.includes('new-test-only-password'));
  await assert.rejects(
    service.request('unlock', { id: wallet.id, password: 'fixture-password-which-is-not-real' }),
    /AUTHENTICATION/,
  );
  await service.dispose();
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal(restored.isUnlocked(wallet.id), false);
  await restored.request('unlock', {
    id: wallet.id,
    password: 'new-test-only-password',
    minutes: 0,
  });
  assert.equal(restored.isUnlocked(wallet.id), true);
  await restored.dispose();
});

test('an older password-rotation reply cannot overwrite a newer unlock or grant', async (t) => {
  for (const change of ['unlock', 'grant'])
    await t.test(change, async (t) => {
      const { service, wallet } = await fixture(t, { realSigner: true });
      const before = (await service.request('keystore.export', { id: wallet.id })).text;
      const original = service.signer.bind(service);
      let begin, finish;
      const entered = new Promise((resolve) => (begin = resolve)),
        release = new Promise((resolve) => (finish = resolve));
      service.signer = async (action, input) => {
        const result = await original(action, input);
        if (action === 'reencrypt') {
          begin();
          await release;
        }
        return result;
      };
      const rotating = service.request('password.change', {
        id: wallet.id,
        password: 'fixture-password-which-is-not-real',
        newPassword: 'test-new-password-only',
      });
      const rejection = assert.rejects(
        rotating,
        change === 'unlock' ? /UNLOCK_CHANGED/ : /AUTHORIZATION_CHANGED/,
      );
      await entered;
      if (change === 'unlock')
        await service.request('unlock', {
          id: wallet.id,
          password: 'fixture-password-which-is-not-real',
          minutes: 0,
        });
      else {
        const challenge = await service.request('policy.challenge', {
          id: wallet.id,
          chains: [8453],
          hours: 1,
          maxFeeEth: '0.01',
        });
        await service.request('policy.grant', {
          challengeId: challenge.id,
          confirmed: true,
          ack: 'ALLOW LIVE',
        });
      }
      finish();
      await rejection;
      assert.equal((await service.request('keystore.export', { id: wallet.id })).text, before);
      if (change === 'unlock') assert.equal(service.isUnlocked(wallet.id), true);
    });
});

test('default live execution waits for dedicated approval; generic auto-approve does nothing', async (t) => {
  const { service, input, calls } = await fixture(t);
  const pending = await service.transact({ venue: 'base' }, input, {
    actor: 'agent',
    returnPending: true,
    autoApprove: true,
  });
  assert.equal(pending.status, 'approval-required');
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
  const [result] = await Promise.all([
    service.request('intent.approve', { id: pending.id, digest: pending.digest }),
    service.request('intent.approve', { id: pending.id, digest: pending.digest }),
  ]);
  assert.ok(['signing', 'submit-unknown', 'submitted'].includes(result.status));
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
  const signed = Transaction.from(
    calls.find((c) => c.method === 'eth_sendRawTransaction').params[0],
  );
  assert.equal(signed.chainId, 8453n);
  assert.equal(signed.to.toLowerCase(), input.to.toLowerCase());
  const repeat = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(repeat.id, pending.id);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
});
test('autonomous scope requires two explicit confirmations, is wallet/network scoped and is revocable', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await assert.rejects(
    service.request('policy.grant', {
      challengeId: 'invented',
      ack: 'ALLOW LIVE',
      confirmed: true,
    }),
    /CONFIRMATION/,
  );
  const challenge = await service.request('policy.challenge', {
    id: wallet.id,
    chains: [8453],
    hours: 1,
    maxFeeEth: '0.01',
  });
  await service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  assert.ok(service.policy(service.wallet(wallet.id), 'base'));
  assert.equal(service.policy(service.wallet(wallet.id), 'base-sepolia'), null);
  const intent = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(intent.status, 'submitted');
  assert.equal(intent.authorization.mode, 'autonomous');
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
  await service.request('policy.revoke', { id: wallet.id });
  const next = await service.transact(
    { venue: 'base' },
    { ...input, commandId: 'payment-2', value: '0.002' },
    { actor: 'agent', returnPending: true },
  );
  assert.equal(next.status, 'approval-required');
});
test('lost broadcast acknowledgements persist the signed hash and never submit twice', async (t) => {
  const { service, wallet, input, calls, mode, directory } = await fixture(t);
  const challenge = await service.request('policy.challenge', { id: wallet.id, chains: [8453] });
  await service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  mode.timeout = true;
  const result = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(result.status, 'submit-unknown');
  assert.match(result.hash, /^0x[\da-f]{64}$/);
  assert.ok(
    !fs
      .readFileSync(service.file, 'utf8')
      .includes(calls.find((c) => c.method === 'eth_sendRawTransaction').params[0]),
  );
  const again = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(again.id, result.id);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { ...input, commandId: 'retry-with-new-key', value: '0.002' },
    ),
    /RECONCILE/,
  );
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal(restored.isUnlocked(wallet.id), false);
  assert.equal(restored.state.intents[0].hash, result.hash);
  assert.equal(restored.state.intents[0].status, 'submit-unknown');
  mode.mined = true;
  const reconciled = await service.reconcile(result.id);
  assert.equal(reconciled.status, 'safe');
});
test('a lost signature reply retains reservations and recovers a matching receipt without a broadcast', async (t) => {
  const { service, wallet, input, calls, mode } = await fixture(t);
  await grant(service, wallet);
  const original = service.signerOverride;
  service.signerOverride = async (action, data) => {
    const result = await original(action, data);
    if (action === 'sign') throw Error('WALLET_SIGNER_EXIT');
    return result;
  };
  const result = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(result.status, 'signing-unknown');
  assert.equal(result.hash, undefined);
  assert.equal(result.submissionMayHaveOccurred, undefined);
  assert.equal(result.nativeSigning, undefined);
  await assert.rejects(
    service.prepare({ venue: 'base' }, { ...input, commandId: 'another-payment', value: '0.002' }),
    /RECONCILE/,
  );
  service.signerOverride = original;
  mode.mined = true;
  const recovered = await service.reconcile(result.id);
  assert.equal(recovered.status, 'safe');
  assert.match(recovered.hash, /^0x[a-f0-9]{64}$/);
  assert.ok(!calls.some((c) => c.method === 'eth_sendRawTransaction'));
});

test('absence releases a reservation only from the original healthy native store', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const original = service.signerOverride;
  service.signerOverride = (action, data) => {
    if (action === 'sign') throw Error('WALLET_SIGNER_EXIT');
    return original(action, data);
  };
  const result = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(result.status, 'signing-unknown');
  service.signerOverride = async (action, data) =>
    action === 'receipt.get'
      ? { found: false, version: 1, storeId: 'b'.repeat(64) }
      : original(action, data);
  await assert.rejects(service.reconcile(result.id), /RECEIPT_MISMATCH/);
  assert.equal(service.state.intents[0].status, 'signing-unknown');
  service.signerOverride = original;
  const recovered = await service.reconcile(result.id);
  assert.equal(recovered.status, 'expired');
  assert.equal(recovered.submissionMayHaveOccurred, false);
  await service.prepare(
    { venue: 'base' },
    { ...input, commandId: 'fresh-operation', value: '0.002' },
  );
  assert.ok(!calls.some((c) => c.method === 'eth_sendRawTransaction'));
});

test('legacy interrupted signatures remain unresolved across restart', async (t) => {
  const { service, wallet, input, directory } = await fixture(t);
  const pending = await service.prepare({ venue: 'base' }, input);
  await service.mutate((state) => {
    state.intents[0].status = 'signing';
  });
  await service.dispose();
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal(restored.state.intents[0].status, 'signing-unknown');
  await assert.rejects(restored.reconcile(pending.id), /RECEIPT_UNAVAILABLE/);
  assert.equal(restored.state.intents[0].status, 'signing-unknown');
  assert.equal(restored.emergencyStatus().needsReconciliation, 1);
  assert.equal(restored.isUnlocked(wallet.id), false);
});

test('a tampered receipt never authorizes broadcasting a valid raw signature', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const original = service.signerOverride;
  service.signerOverride = async (action, data) => {
    const result = await original(action, data);
    if (action === 'sign') result.receipt.unsignedHash = '0x' + '0'.repeat(64);
    return result;
  };
  const result = await service.transact({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(result.error, 'WALLET_RECEIPT_MISMATCH');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.ok(!calls.some((c) => c.method === 'eth_sendRawTransaction'));
});

test('manual approval detects changes to nonce, fees and deadlines after the user saw the intent', async (t) => {
  for (const field of ['nonce', 'maxFeePerGas', 'expiresAt'])
    await t.test(field, async (t) => {
      const { service, input, calls } = await fixture(t);
      const pending = await service.prepare({ venue: 'base' }, input);
      await service.mutate((state) => {
        const record = state.intents[0];
        if (field === 'expiresAt') record.expiresAt -= 1000;
        else if (field === 'nonce') record.transaction.nonce++;
        else record.transaction.maxFeePerGas = String(BigInt(record.transaction.maxFeePerGas) + 1n);
      });
      await assert.rejects(
        service.request('intent.approve', { id: pending.id, digest: pending.digest }),
        /INTENT_CHANGED/,
      );
      assert.ok(!calls.some((c) => c.method === 'eth_sendRawTransaction'));
    });
});
test('native permission controls cannot be invoked through the frontend wallet action dispatcher', async (t) => {
  const { service, wallet } = await fixture(t);
  for (const action of [
    'authority.grant',
    'authority.revoke',
    'operation.approve',
    'operation.deny',
    'sign',
  ])
    await assert.rejects(service.request(action, { id: wallet.id }), /UNKNOWN_WALLET_ACTION/);
});
test('old host-only automatic grants require human renewal before native execution', async (t) => {
  const { service, wallet, input } = await fixture(t);
  await service.mutate(
    (state) => (state.wallets[0].policy = { id: 'old-grant', mode: 'autonomous', chains: [8453] }),
  );
  assert.equal(service.publicWallet(service.wallet(wallet.id)).policy.renewalRequired, true);
  assert.equal(service.policy(service.wallet(wallet.id), 'base'), null);
  const intent = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(intent.status, 'approval-required');
});

test('approval changes and unknown outcomes cannot be bypassed by another command or account', async (t) => {
  const { service, input } = await fixture(t);
  const pending = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  await assert.rejects(
    service.request('intent.approve', { id: pending.id, digest: 'different' }),
    /CHANGED/,
  );
  await assert.rejects(
    service.prepare({ venue: 'base' }, { ...input, value: '0.003' }),
    /COMMAND_CONFLICT/,
  );
  const denied = await service.request('intent.deny', { id: pending.id, digest: pending.digest });
  assert.equal(denied.status, 'denied');
});
test('an external nonce change after approval cannot silently replace another transaction', async (t) => {
  const { service, input, calls, mode } = await fixture(t);
  const intent = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  mode.nonce = '0x1';
  const result = await service.request('intent.approve', { id: intent.id, digest: intent.digest });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WALLET_NONCE_CHANGED');
  assert.ok(!result.hash);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
});
test('expired approvals wake waiters and remain visible in durable paginated history', async (t) => {
  const { service, input } = await fixture(t);
  const intent = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  const waiting = service.awaitApproval(intent.id);
  service.state.intents[0].expiresAt = Date.now() - 1;
  await service.monitor();
  assert.equal((await waiting).status, 'expired');
  const history = await service.request('history', { limit: 1 });
  assert.equal(history.items[0].status, 'expired');
  assert.equal(history.total, 1);
  assert.equal(history.next, null);
  assert.equal(JSON.parse(fs.readFileSync(service.file, 'utf8')).intents[0].status, 'expired');
});
test('stopping an Agent while signing prevents a later broadcast', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  const challenge = await service.request('policy.challenge', { id: wallet.id, chains: [8453] });
  await service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  const abort = new AbortController(),
    original = service.signerOverride;
  service.signerOverride = async (action, value) => {
    const result = await original(action, value);
    if (action === 'sign') abort.abort();
    return result;
  };
  const result = await service.transact({ venue: 'base' }, input, {
    actor: 'agent',
    signal: abort.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.equal(result.error, 'WALLET_OPERATION_CANCELLED');
  assert.ok(!result.hash);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
});

async function grant(service, wallet, limits) {
  const challenge = await service.request('policy.challenge', {
    id: wallet.id,
    chains: [8453],
    limits,
  });
  return service.request('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
}
test('explicit replacement authority can complete a fresh operation after a known-unsent signature', async (t) => {
  const { service, wallet, input, calls } = await fixture(t, { realSigner: true });
  await grant(service, wallet);
  const original = service.signer.bind(service),
    controller = new AbortController();
  service.signer = async (action, data) => {
    const result = await original(action, data);
    if (action === 'sign') controller.abort();
    return result;
  };
  const stopped = await service.transact({ venue: 'base' }, input, {
    actor: 'agent',
    signal: controller.signal,
  });
  assert.equal(stopped.submissionMayHaveOccurred, false);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
  service.signer = original;
  await grant(service, wallet, { allowReplacement: true, maxTransactions: 1 });
  const sent = await service.transact(
    { venue: 'base' },
    { ...input, commandId: 'authorized-replacement', value: '0.002' },
    { actor: 'agent' },
  );
  assert.equal(sent.status, 'submitted');
  assert.match(sent.replacementOf, /^0x[a-f0-9]{64}$/);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
});

function holdSigning(service) {
  let release, started;
  const ready = new Promise((r) => {
      started = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  const signer = service.signer.bind(service);
  service.signer = async (action, input) => {
    if (action === 'sign') {
      started();
      await gate;
    }
    return signer(action, input);
  };
  return { ready, release };
}
test('revocation and replacement of a grant during signing cannot authorize the old transaction', async (t) => {
  for (const replacement of [false, true])
    await t.test(replacement ? 'new grant' : 'revocation', async (t) => {
      const { service, wallet, input, calls } = await fixture(t);
      await grant(service, wallet);
      const gate = holdSigning(service),
        operation = service.transact({ venue: 'base' }, input);
      await gate.ready;
      await service.request('policy.revoke', { id: wallet.id });
      if (replacement) await grant(service, wallet);
      gate.release();
      const result = await operation;
      assert.equal(result.status, 'cancelled');
      assert.equal(result.error, 'WALLET_AUTHORIZATION_CHANGED');
      assert.equal(result.submissionMayHaveOccurred, false);
      assert.ok(!result.hash);
      assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
      assert.equal(service.inFlight.size, 0);
    });
});
test('locking and unlocking while a manual approval is signing cannot revive its old unlock session', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  const prepared = await service.prepare({ venue: 'base' }, input),
    gate = holdSigning(service);
  const operation = service.request('intent.approve', { id: prepared.id, digest: prepared.digest });
  await gate.ready;
  await service.request('lock', { id: wallet.id });
  await service.request('unlock', {
    id: wallet.id,
    password: 'fixture-password-which-is-not-real',
    minutes: 0,
  });
  gate.release();
  const result = await operation;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WALLET_LOCKED');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.equal(service.isUnlocked(wallet.id), true);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
});
test('an intent expiring during signing is not sent', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const gate = holdSigning(service),
    operation = service.transact({ venue: 'base' }, input);
  await gate.ready;
  const now = Date.now;
  try {
    Date.now = () => now() + 360000;
    gate.release();
    const result = await operation;
    assert.equal(result.status, 'expired');
    assert.equal(result.error, 'WALLET_INTENT_EXPIRED');
    assert.equal(result.submissionMayHaveOccurred, false);
    assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
  } finally {
    Date.now = now;
  }
});
test('a revocation after persisting the signed hash but before dispatch records a known unsent cancellation', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const mutate = service.mutate.bind(service);
  let revocation;
  service.mutate = (fn) =>
    mutate(async (state) => {
      const result = await fn(state);
      if (!revocation && state.intents.some((i) => i.status === 'submit-unknown' && i.hash))
        revocation = service.request('policy.revoke', { id: wallet.id });
      return result;
    });
  const result = await service.transact({ venue: 'base' }, input);
  await revocation;
  assert.match(result.hash, /^0x[a-f0-9]{64}$/);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
  const reads = calls.length;
  await service.reconcile(result.id);
  assert.equal((await service.waitForInclusion(result.id)).status, 'cancelled');
  assert.equal(calls.length, reads);
});
test('a cancelled network request after dispatch preserves an unknown outcome and never retries', async (t) => {
  const { service, wallet, input, calls, mode } = await fixture(t);
  await grant(service, wallet);
  let revocation,
    accepted = false;
  mode.send = async (_body, options) => {
    accepted = true;
    const aborted = new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
    );
    revocation = service.request('policy.revoke', { id: wallet.id });
    return aborted;
  };
  const result = await service.transact({ venue: 'base' }, input);
  await revocation;
  assert.equal(accepted, true);
  assert.equal(result.status, 'submit-unknown');
  assert.equal(result.submissionMayHaveOccurred, true);
  assert.match(result.hash, /^0x[a-f0-9]{64}$/);
  await service.transact({ venue: 'base' }, input);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 1);
  mode.mined = true;
  assert.equal((await service.reconcile(result.id)).status, 'safe');
});
test('a revocation fences authority before queued store work completes and survives restart', async (t) => {
  const { service, wallet, directory } = await fixture(t);
  await grant(service, wallet);
  let release;
  const blocked = service.mutate(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await new Promise((r) => setTimeout(r, 1));
  const revoked = service.request('policy.revoke', { id: wallet.id });
  assert.equal(service.policy(service.wallet(wallet.id), 'base'), null);
  assert.equal(JSON.parse(fs.readFileSync(service.file)).wallets[0].policy.mode, 'autonomous');
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal(restored.policy(restored.wallet(wallet.id), 'base'), null);
  assert.equal(restored.publicWallet(restored.wallet(wallet.id)).policy.suspended, true);
  release();
  await blocked;
  await revoked;
  assert.deepEqual(JSON.parse(fs.readFileSync(service.authorityFile)).fences, {});
});
test('failed policy persistence keeps the independent revocation fence after restart', async (t) => {
  const { service, wallet, directory } = await fixture(t);
  await grant(service, wallet);
  service.mutate = async () => {
    throw Error('fixture storage unavailable');
  };
  await assert.rejects(service.request('policy.revoke', { id: wallet.id }), /storage unavailable/);
  const restored = new WalletService({ directory });
  t.after(() => restored.dispose());
  assert.equal(restored.policy(restored.wallet(wallet.id), 'base'), null);
});
test('a late successful native unlock cannot restore authority after a newer lock', async (t) => {
  const { service, wallet } = await fixture(t, { realSigner: true });
  await service.request('lock', { id: wallet.id });
  const signer = service.signer.bind(service);
  let ready, release;
  const started = new Promise((r) => {
      ready = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  service.signer = async (action, input) => {
    const result = await signer(action, input);
    if (action === 'unlock') {
      ready();
      await gate;
    }
    return result;
  };
  const unlocking = service.request('unlock', {
    id: wallet.id,
    password: 'fixture-password-which-is-not-real',
    minutes: 0,
  });
  await started;
  await service.request('lock', { id: wallet.id });
  release();
  await assert.rejects(unlocking, /WALLET_UNLOCK_CHANGED/);
  assert.equal(service.isUnlocked(wallet.id), false);
});
test('rejecting an old unlock callback preserves a newer valid native unlock session', async (t) => {
  const { service, wallet } = await fixture(t, { realSigner: true });
  const signer = service.signer.bind(service);
  let ready,
    release,
    held = false;
  const started = new Promise((r) => {
      ready = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  service.signer = async (action, input) => {
    const result = await signer(action, input);
    if (action === 'unlock' && !held) {
      held = true;
      ready();
      await gate;
    }
    return result;
  };
  const input = { id: wallet.id, password: 'fixture-password-which-is-not-real', minutes: 0 };
  const first = service.request('unlock', input);
  await started;
  await service.request('unlock', input);
  release();
  await assert.rejects(first, /WALLET_UNLOCK_CHANGED/);
  assert.equal(service.isUnlocked(wallet.id), true);
});
test('invalid authorization fence records fail closed on restart', async (t) => {
  for (const payload of [
    'not json',
    JSON.stringify({ version: 1, fences: { missing: '00000000-0000-0000-0000-000000000000' } }),
  ])
    await t.test(payload.startsWith('{') ? 'unknown wallet' : 'invalid JSON', async (t) => {
      const { service, directory } = await fixture(t);
      fs.writeFileSync(service.authorityFile, payload);
      assert.throws(() => new WalletService({ directory }), /WALLET_AUTHORIZATION_STORE_CORRUPT/);
    });
});
test('denying an already approved intent never triggers a broadcast', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  const intent = await service.prepare({ venue: 'base' }, input, { actor: 'agent' });
  assert.equal(
    (await service.request('intent.deny', { id: intent.id, digest: intent.digest })).status,
    'denied',
  );
  assert.equal((await service.transact({ venue: 'base' }, input)).status, 'denied');
  assert.equal(calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 0);
});
test('native execution binds the original grant and enforces one cumulative estimated fee budget', async (t) => {
  const { service, wallet, input } = await fixture(t);
  await grant(service, wallet);
  const probe = await service.prepare({ venue: 'base' }, { ...input, commandId: 'fee-probe' });
  await service.request('intent.deny', { id: probe.id, digest: probe.digest });
  const fee = BigInt(probe.feeReserveWei);
  const context = {
    actor: 'agent',
    workspaceId: 'execution-project',
    expectedPolicyId: service.wallet(wallet.id).policy.id,
    checkAuthority: () => {},
    execution: {
      planId: 'execution:budget',
      commandId: 'live:' + 'a'.repeat(64),
      scopeHash: 'e'.repeat(64),
      feeBudgetWei: String(fee * 2n),
    },
  };
  for (const [index, digit] of ['a', 'b'].entries()) {
    const commandId = 'live:' + digit.repeat(64);
    await service.prepare(
      { venue: 'base' },
      { ...input, commandId: commandId + ':swap', value: '0.00' + (index + 1) },
      { ...context, execution: { ...context.execution, commandId } },
    );
  }
  const count = service.state.intents.length,
    commandId = 'live:' + 'c'.repeat(64);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { ...input, commandId: commandId + ':swap', value: '0.003' },
      { ...context, execution: { ...context.execution, commandId } },
    ),
    /EXECUTION_FEE_BUDGET/,
  );
  assert.equal(service.state.intents.length, count);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { ...input, commandId: commandId + ':swap', value: '0.004' },
      {
        ...context,
        execution: { ...context.execution, commandId, feeBudgetWei: String(fee * 3n) },
      },
    ),
    /SCOPE_CHANGED/,
  );
  await service.request('policy.revoke', { id: wallet.id });
  await grant(service, wallet);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { ...input, commandId: commandId + ':swap', value: '0.005' },
      { ...context, execution: { ...context.execution, commandId } },
    ),
    /AUTHORIZATION_CHANGED/,
  );
});
test('a native owner guard is checked after signing and cannot be bypassed by manual approval', async (t) => {
  const { service, wallet, input, calls } = await fixture(t);
  await grant(service, wallet);
  let permitted = true;
  const commandId = 'live:' + 'd'.repeat(64),
    gate = holdSigning(service);
  const context = {
    actor: 'agent',
    expectedPolicyId: service.wallet(wallet.id).policy.id,
    checkAuthority: () => {
      if (!permitted) throw Error('WALLET_EXECUTION_STOPPED');
    },
    execution: {
      planId: 'execution:guard',
      commandId,
      scopeHash: 'f'.repeat(64),
      feeBudgetWei: '10000000000000000',
    },
  };
  const sending = service.transact(
    { venue: 'base' },
    { ...input, commandId: commandId + ':swap' },
    context,
  );
  await gate.ready;
  permitted = false;
  gate.release();
  const result = await sending;
  assert.equal(result.error, 'WALLET_EXECUTION_STOPPED');
  assert.equal(result.submissionMayHaveOccurred, false);
  assert.equal(calls.filter((c) => c.method === 'eth_sendRawTransaction').length, 0);
  await assert.rejects(
    service.request('intent.approve', { id: result.id, digest: result.digest }),
    /OWNER_REQUIRED/,
  );
});
for (const phase of ['eth_getTransactionCount', 'eth_sendRawTransaction'])
  test(
    'explicit cancellation during wallet RPC preserves the broadcast boundary: ' + phase,
    async (t) => {
      const { service, wallet, input } = await fixture(t);
      await grant(service, wallet);
      const rpc = service.market.rpc.bind(service.market);
      let ready;
      const started = new Promise((r) => {
        ready = r;
      });
      service.market.rpc = (chain, url, method, params, options) => {
        if (method === phase && options?.signal && service.inFlight.size) {
          ready();
          return new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            }),
          );
        }
        return rpc(chain, url, method, params, options);
      };
      const controller = new AbortController();
      const operation = service.transact({ venue: 'base' }, input, {
        actor: 'agent',
        signal: controller.signal,
      });
      await started;
      controller.abort(Error('fixture user cancellation'));
      const result = await operation;
      assert.equal(result.error, 'WALLET_OPERATION_CANCELLED');
      assert.equal(
        result.status,
        phase === 'eth_sendRawTransaction' ? 'submit-unknown' : 'cancelled',
      );
      assert.equal(result.submissionMayHaveOccurred, phase === 'eth_sendRawTransaction');
    },
  );
