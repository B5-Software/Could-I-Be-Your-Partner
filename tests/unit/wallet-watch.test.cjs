/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WalletService } = require('../../src/main/services/wallet');

test('watch accounts persist without a signer or keystore and reject every signing entry point', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-watch-'));
  let service;
  let signerCalls = 0;
  const options = {
    directory,
    signer: async () => {
      signerCalls++;
      throw Error('signer must not run');
    },
  };
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  service = new WalletService(options);
  const address = '0x' + '2'.repeat(40);
  const account = await service.request('watch.add', { name: 'Public account', address });
  assert.equal(account.kind, 'watch');
  assert.equal(account.unlocked, false);
  assert.ok(!fs.existsSync(path.join(directory, 'keystores')));
  await assert.rejects(service.request('watch.add', { address }), /ALREADY_IMPORTED/);
  await service.request('asset.track', {
    id: account.id,
    chain: 'base',
    token: '0x' + '3'.repeat(40),
  });
  await service.request('asset.track', {
    id: account.id,
    chain: 'base',
    token: '0x' + '3'.repeat(40),
  });
  await service.dispose();
  service = new WalletService(options);
  const restored = (await service.request('list')).wallets[0];
  assert.equal(restored.id, account.id);
  assert.deepEqual(restored.trackedTokens.base, ['0x' + '3'.repeat(40)]);
  for (const action of [
    'unlock',
    'password.change',
    'keystore.export',
    'policy.challenge',
    'policy.revoke',
  ])
    await assert.rejects(service.request(action, { id: account.id }), /WALLET_WATCH_ONLY/);
  await assert.rejects(
    service.prepare(
      { venue: 'base' },
      { walletId: account.id, commandId: 'watch-cannot-pay', to: address, value: '0' },
      { actor: 'agent' },
    ),
    /WALLET_WATCH_ONLY/,
  );
  await assert.rejects(
    service.request('portfolio.challenge', {
      operation: 'create',
      name: 'Forbidden watch budget',
      chainId: 8453,
      walletIds: [account.id],
    }),
    /WALLET_WATCH_ONLY/,
  );
  assert.equal(signerCalls, 0);
  assert.equal(service.child, undefined);
  await service.request('asset.untrack', {
    id: account.id,
    chain: 'base',
    token: '0x' + '3'.repeat(40),
  });
  assert.deepEqual((await service.request('list')).wallets[0].trackedTokens.base, []);
  assert.deepEqual(await service.request('watch.remove', { id: account.id }), { removed: true });
  assert.deepEqual(await service.request('watch.remove', { id: account.id }), { removed: false });
  assert.equal((await service.request('list')).wallets.length, 0);
});

test('real key import upgrades the matching watch account, preserves metadata and unlocks under the original ID after restart', async (t) => {
  const { Wallet } = require('ethers');
  const key = '0x' + '11'.repeat(32),
    otherKey = '0x' + '22'.repeat(32);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-watch-native-'));
  let service = new WalletService({ directory });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const watch = await service.request('watch.add', {
    name: 'Original watch',
    address: new Wallet(key).address,
  });
  const token = '0x' + '3'.repeat(40);
  await service.request('asset.track', { id: watch.id, chain: 'base', token });
  const input = {
    kind: 'privateKey',
    secret: key,
    password: 'test-watch-import-password',
    name: 'Incoming import name',
  };
  await assert.rejects(
    service.request('watch.import', { ...input, id: watch.id, secret: otherKey }),
    /ADDRESS_MISMATCH/,
  );
  assert.equal((await service.request('list')).wallets[0].kind, 'watch');
  const imported = await service.request('import', input);
  assert.equal(imported.id, watch.id);
  assert.equal(imported.createdAt, watch.createdAt);
  assert.equal(imported.name, watch.name);
  assert.equal(imported.kind, 'local');
  assert.equal(imported.unlocked, false);
  assert.equal(imported.policy.mode, 'manual');
  assert.deepEqual(imported.trackedTokens.base, [token]);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'keystores')), [watch.id + '.json']);
  await assert.rejects(
    service.request('watch.remove', { id: watch.id }),
    /WALLET_WATCH_REMOVE_LOCAL/,
  );
  await service.dispose();
  service = new WalletService({ directory });
  const unlocked = await service.request('unlock', {
    id: watch.id,
    password: input.password,
    minutes: 0,
  });
  assert.equal(unlocked.address, watch.address);
  assert.equal(unlocked.unlocked, true);
  const saved = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert.ok(!saved.includes(key.slice(2)) && !saved.includes(input.password));
});

test('removing a watch during import prevents resurrection and state-write rollback cannot delete a later successful import', async (t) => {
  const address = '0x' + '2'.repeat(40);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-watch-race-'));
  let entered,
    release,
    count = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let delayed = true;
  const service = new WalletService({
    directory,
    signer: async () => {
      if (delayed) {
        entered();
        await gate;
      }
      return { address, keystore: JSON.stringify({ testCipher: ++count }) };
    },
  });
  t.after(async () => {
    await service.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const watch = await service.request('watch.add', { address });
  const input = {
    password: 'test-import-password',
    secret: 'test-only',
    kind: 'privateKey',
    id: watch.id,
  };
  const pending = service.request('watch.import', input);
  const rejected = assert.rejects(pending, /WALLET_WATCH_CHANGED/);
  await started;
  await service.request('watch.remove', { id: watch.id });
  release();
  await rejected;
  assert.equal((await service.request('list')).wallets.length, 0);
  assert.ok(!fs.existsSync(path.join(directory, 'keystores')));
  delayed = false;
  const retryWatch = await service.request('watch.add', { address });
  const rename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = (from, to) => {
    if (to === service.file && failOnce) {
      failOnce = false;
      throw Error('fixture state-write failure');
    }
    return rename(from, to);
  };
  try {
    const failed = service.request('watch.import', { ...input, id: retryWatch.id });
    const failure = assert.rejects(failed, /fixture state-write failure/);
    const next = service.request('watch.import', { ...input, id: retryWatch.id });
    await failure;
    assert.equal((await next).kind, 'local');
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(directory, 'keystores', retryWatch.id + '.json')))
      .testCipher,
    3,
  );
  assert.equal((await service.request('list')).wallets[0].id, retryWatch.id);
});
