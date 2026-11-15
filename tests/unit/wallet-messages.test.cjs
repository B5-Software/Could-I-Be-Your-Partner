/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  Wallet,
  verifyMessage,
  verifyTypedData,
  TypedDataEncoder,
  hexlify,
  toUtf8Bytes,
  getBytes,
} = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const { normalize } = require('../../src/main/services/wallet/messages');
const secret = '0x' + '01'.padStart(64, '0'),
  password = 'public-message-fixture-password';
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-wallet-message-'));
  let service = new WalletService({ directory });
  const wallet = await service.request('import', { kind: 'privateKey', secret, password });
  await service.request('unlock', { id: wallet.id, password, minutes: 0 });
  const session = service.apps.createSession({
    url: 'https://dapp.example/start',
    valid: () => true,
  });
  const connecting = session.request({ method: 'eth_requestAccounts' }),
    request = service.apps.list().pending[0];
  await service.request('app.allow', {
    id: request.id,
    walletId: wallet.id,
    chain: 'base',
    confirmed: true,
  });
  await connecting;
  t.after(async () => {
    await service.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-wallet-message-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    wallet,
    session,
    directory,
    async reopen() {
      await service.dispose();
      service = new WalletService({ directory });
      return service;
    },
  };
}
async function waiting(f) {
  for (let n = 0; n < 100; n++) {
    const r = f.service.messages.items.find((r) => r.status === 'approval-required');
    if (r) return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected a message approval');
}
const request = (f, text, id = randomUUID()) =>
  f.session.request({
    id,
    method: 'personal_sign',
    params: [hexlify(toUtf8Bytes(text)), f.wallet.address],
  });
const approve = (f, r) =>
  f.service.request('message.approve', { id: r.id, digest: r.reviewDigest, confirmed: true });
function typed(chain = 8453) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Person: [
        { name: 'name', type: 'string' },
        { name: 'wallet', type: 'address' },
      ],
      Mail: [
        { name: 'from', type: 'Person' },
        { name: 'to', type: 'Person[]' },
        { name: 'contents', type: 'string' },
        { name: 'amounts', type: 'uint256[]' },
      ],
    },
    primaryType: 'Mail',
    domain: {
      name: 'Public fixture',
      version: '1',
      chainId: chain,
      verifyingContract: '0x' + '2'.repeat(40),
    },
    message: {
      from: { name: 'Alice', wallet: new Wallet(secret).address },
      to: [{ name: 'Bob', wallet: '0x' + '3'.repeat(40) }],
      contents: 'Hello <script> & 世界',
      amounts: [
        '1',
        '115792089237316195423570985008687907853269984665640564039457584007913129639935',
      ],
    },
  };
}
test('personal signatures require frozen human approval, match ethers, persist without plaintext signatures and survive locked restart', async (t) => {
  const f = await fixture(t),
    text = 'Hello 钱包 👋\nMessage fixture',
    id = 'stable-personal';
  const signing = request(f, text, id),
    r = await waiting(f);
  assert.equal((await f.service.request('list')).intents.length, 0);
  assert.equal((await f.service.request('message.list')).items[0].message.payload, undefined);
  await assert.rejects(
    f.service.request('message.approve', { id: r.id, digest: r.reviewDigest }),
    /CONFIRMATION_REQUIRED/,
  );
  await assert.rejects(
    f.service.request('message.approve', { id: r.id, digest: 'changed', confirmed: true }),
    /MISMATCH/,
  );
  await approve(f, r);
  const signature = await signing;
  assert.equal(verifyMessage(text, signature), f.wallet.address);
  assert.equal(signature, await new Wallet(secret).signMessage(text));
  assert.equal(await request(f, text, id), signature);
  const raw = fs.readFileSync(path.join(f.directory, 'messages.json'), 'utf8');
  assert.equal(raw.includes(signature), false);
  assert.equal(f.service.messages.items.length, 1);
  const db = fs.readFileSync(path.join(f.directory, 'signer-receipts', 'receipts.sqlite'));
  assert.equal(db.includes(Buffer.from(signature)), false);
  assert.equal(db.includes(Buffer.from(getBytes(signature))), false);
  await f.reopen();
  assert.equal(f.service.isUnlocked(f.wallet.id), false);
  const restored = await f.service.request('message.get', { id: r.id });
  assert.equal(restored.status, 'signed');
  assert.equal(restored.signature, undefined);
  assert.equal((await f.service.request('message.reconcile', { id: r.id })).status, 'signed');
});
test('typed nested arrays and full-width integers are independently hashed and signed by the native process', async (t) => {
  const f = await fixture(t),
    data = typed(),
    types = { ...data.types };
  delete types.EIP712Domain;
  const signing = f.session.request({
    id: 'typed-one',
    method: 'eth_signTypedData_v4',
    params: [f.wallet.address, JSON.stringify(data)],
  });
  const r = await waiting(f);
  assert.equal(r.digest, TypedDataEncoder.hash(data.domain, types, data.message));
  assert.equal(r.preview.primaryType, 'Mail');
  await approve(f, r);
  const signature = await signing;
  assert.equal(verifyTypedData(data.domain, types, data.message, signature), f.wallet.address);
  assert.equal(signature, await new Wallet(secret).signTypedData(data.domain, types, data.message));
  await assert.rejects(
    f.session.request({
      id: 'wrong-chain',
      method: 'eth_signTypedData_v4',
      params: [f.wallet.address, typed(1)],
    }),
    (e) => e.code === -32602,
  );
  const extra = typed();
  extra.types.EIP712Domain.push({ name: 'hidden', type: 'string' });
  extra.domain.hidden = 'ignored?';
  await assert.rejects(
    f.session.request({
      id: 'hidden-domain',
      method: 'eth_signTypedData_v4',
      params: [f.wallet.address, extra],
    }),
    (e) => e.code === -32602,
  );
  const ignored = typed();
  ignored.primaryType = 'EIP712Domain';
  await assert.rejects(
    f.session.request({
      id: 'ignored-body',
      method: 'eth_signTypedData_v4',
      params: [f.wallet.address, ignored],
    }),
    (e) => e.code === -32602,
  );
  const bomb = typed();
  bomb.types.Mail[0].type = 'Person' + '[]'.repeat(1000);
  await assert.rejects(
    f.session.request({
      id: 'array-bomb',
      method: 'eth_signTypedData_v4',
      params: [f.wallet.address, bomb],
    }),
    (e) => e.code === -32602,
  );
  await assert.rejects(
    f.service.signer('message.inspect', {
      id: f.wallet.id,
      message: {
        kind: 'typed',
        payload: JSON.stringify(bomb),
        origin: 'https://dapp.example',
        connectionId: randomUUID(),
        chainId: 8453,
      },
    }),
    /WALLET_MESSAGE_INVALID/,
  );
  assert.equal(f.service.isUnlocked(f.wallet.id), true);
});
test('native message authority cannot be substituted by transaction grants, altered payloads, new unlock sessions or denied operations', async (t) => {
  const f = await fixture(t),
    store = await f.service.signer('receipt.status', { id: f.wallet.id });
  const spec = normalize('personal', '0x68656c6c6f', {
    address: f.wallet.address,
    origin: 'https://dapp.example',
    connectionId: randomUUID(),
    chainId: 8453,
  });
  const input = {
    id: f.wallet.id,
    operationId: randomUUID(),
    storeId: store.storeId,
    expiresAt: Date.now() + 300000,
    message: spec.message,
  };
  await assert.rejects(f.service.signer('message.sign', input), /MESSAGE_APPROVAL/);
  await assert.rejects(
    f.service.signer('message.sign', { ...input, policyId: 'any-grant' }),
    /MESSAGE_APPROVAL/,
  );
  await f.service.signer('message.approve', input);
  await assert.rejects(
    f.service.signer('message.sign', {
      ...input,
      message: { ...input.message, payload: '0x6869' },
    }),
    /MESSAGE_APPROVAL/,
  );
  await assert.rejects(
    f.service.signer('message.sign', {
      ...input,
      message: { ...input.message, origin: 'https://other.example' },
    }),
    /MESSAGE_APPROVAL/,
  );
  const signed = await f.service.signer('message.sign', input);
  await f.service.request('lock', { id: f.wallet.id });
  await f.service.request('unlock', { id: f.wallet.id, password, minutes: 0 });
  await assert.rejects(f.service.signer('message.sign', input), /MESSAGE_APPROVAL/);
  await f.service.signer('message.approve', input);
  assert.equal((await f.service.signer('message.sign', input)).signature, signed.signature);
  await f.service.signer('operation.deny', { id: f.wallet.id, operationId: input.operationId });
  await assert.rejects(f.service.signer('message.sign', input), /MESSAGE_APPROVAL/);
});
test('rejection remains in history and no generic JSON endpoint can prepare or release a signature', async (t) => {
  const f = await fixture(t),
    signing = request(f, 'Please reject');
  const outcome = signing.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    r = await waiting(f);
  await f.service.request('message.deny', { id: r.id, digest: r.reviewDigest });
  assert.equal((await outcome).error.code, 4001);
  assert.equal((await f.service.request('message.get', { id: r.id })).status, 'rejected');
  await assert.rejects(f.service.request('message.prepare', {}), /UNKNOWN_WALLET_ACTION/);
  await assert.rejects(f.service.request('message.sign', {}), /UNKNOWN_WALLET_ACTION/);
});
test('disconnect during a delayed real native reply withholds the signature and locked reconciliation recovers metadata only', async (t) => {
  const f = await fixture(t),
    original = f.service.signer.bind(f.service),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.service.signer = async (action, input) => {
    const value = await original(action, input);
    if (action === 'message.sign') {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  const signing = request(f, 'Do not release after disconnect'),
    outcome = signing.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    r = await waiting(f);
  await approve(f, r);
  await entered.promise;
  try {
    const c = f.service.apps.list().connections[0];
    await f.service.request('app.revoke', { id: c.id, revision: c.revision });
  } finally {
    release.resolve();
  }
  assert.ok((await outcome).error);
  await f.service.request('lock', { id: f.wallet.id });
  const restored = await f.service.request('message.reconcile', { id: r.id });
  assert.equal(restored.status, 'signed-withheld');
  assert.match(restored.signatureHash, /^0x[\da-f]{64}$/);
  assert.equal(restored.signature, undefined);
});
test('SIWE validates actual origin, account, chain, nonce and time before creating any approval', async (t) => {
  const f = await fixture(t),
    message = `https://dapp.example wants you to sign in with your Ethereum account:\n${f.wallet.address}\n\nPublic fixture login\n\nURI: https://dapp.example/login\nVersion: 1\nChain ID: 8453\nNonce: public123456\nIssued At: ${new Date().toISOString()}`;
  for (const invalid of [
    message.replace('https://dapp.example wants', 'https://forged.example wants'),
    message.replace('Chain ID: 8453', 'Chain ID: 1'),
    message.replace('Nonce: public123456', 'Nonce: bad'),
    message + '\nExpiration Time: 2020-01-01T00:00:00Z',
    message.replace(/Issued At: .+$/, 'Issued At: 2026-02-31T00:00:00Z'),
  ])
    await assert.rejects(request(f, invalid), (e) => e.code === -32602);
  assert.equal(f.service.messages.items.length, 0);
  const signing = request(f, message),
    r = await waiting(f);
  assert.equal(r.login.origin, 'https://dapp.example');
  await approve(f, r);
  assert.equal(verifyMessage(message, await signing), f.wallet.address);
});

test('global live stop cancels pending message requests without granting or signing', async (t) => {
  const f = await fixture(t),
    signing = request(f, 'Stop before signing'),
    outcome = signing.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const r = await waiting(f);
  await f.service.request('emergency.halt', { expectedGeneration: f.service.emergency.generation });
  assert.equal((await outcome).error.code, 4001);
  const record = await f.service.request('message.get', { id: r.id });
  assert.equal(record.status, 'cancelled');
  assert.equal(record.signatureHash, undefined);
});

test('amplified structured schemas are rejected before hashing or native signing', () => {
  const types = { EIP712Domain: [], T0: [{ name: 'n', type: 'uint256' }] };
  for (let n = 1; n < 20; n++)
    types['T' + n] = [
      { name: 'a', type: 'T' + (n - 1) },
      { name: 'b', type: 'T' + (n - 1) },
    ];
  assert.throws(
    () =>
      normalize(
        'typed',
        { types, domain: {}, message: {}, primaryType: 'T19' },
        {
          address: new Wallet(secret).address,
          origin: 'https://example.com',
          connectionId: randomUUID(),
          chainId: 8453,
        },
      ),
    /MESSAGE_INVALID/,
  );
});

test('a missing host message history cannot conceal existing native signatures as an empty history', async (t) => {
  const f = await fixture(t),
    signing = request(f, 'Keep the evidence'),
    r = await waiting(f);
  await approve(f, r);
  await signing;
  await f.service.dispose();
  const file = path.join(f.directory, 'messages.json'),
    backup = fs.readFileSync(file);
  fs.unlinkSync(file);
  await f.reopen();
  await assert.rejects(f.service.request('message.list'), /WALLET_MESSAGE_STORE/);
  fs.writeFileSync(file, backup, { mode: 0o600 });
  await f.reopen();
  assert.equal((await f.service.request('message.list')).total, 1);
});
