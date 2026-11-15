/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { Transaction, keccak256 } = require('ethers');
const { WalletService } = require('../../src/main/services/wallet');
const {
  attachWalletProvider,
  installProvider,
} = require('../../src/main/services/wallet/browser-provider');
const recipient = '0x' + '2'.repeat(40);
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-wallet-app-'));
  const writes = [];
  const service = new WalletService({
    directory,
    fetcher: async (_url, options) => {
      const { method, params } = JSON.parse(options.body);
      let result;
      if (method === 'eth_sendRawTransaction') {
        writes.push(Transaction.from(params[0]));
        result = keccak256(params[0]);
      } else
        result = {
          eth_chainId: '0x2105',
          eth_getTransactionCount: '0x0',
          eth_gasPrice: '0x1',
          eth_maxPriorityFeePerGas: '0x1',
          eth_getBalance: '0x8ac7230489e80000',
          eth_estimateGas: '0x5208',
          eth_call: '0x' + '0'.repeat(64),
          eth_getBlockByNumber: {
            number: '0x12',
            hash: '0x' + 'a'.repeat(64),
            timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
          },
        }[method];
      assert.notEqual(result, undefined, method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    },
  });
  t.after(async () => {
    await service.dispose();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cibyp-wallet-app-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const wallet = await service.request('import', {
    kind: 'privateKey',
    secret: '0x' + '01'.padStart(64, '0'),
    password: 'public-wallet-app-fixture-password',
  });
  await service.request('unlock', {
    id: wallet.id,
    password: 'public-wallet-app-fixture-password',
    minutes: 0,
  });
  const session = service.apps.createSession({
    url: 'https://dapp.example/app',
    valid: () => true,
  });
  async function connect(s = session) {
    const pending = s.request({ method: 'eth_requestAccounts' });
    const request = service.apps.list().pending[0];
    assert.ok(request);
    await service.request('app.allow', {
      id: request.id,
      walletId: wallet.id,
      chain: 'base',
      confirmed: true,
    });
    assert.deepEqual(await pending, [wallet.address]);
    return s;
  }
  return { service, wallet, session, connect, directory, writes };
}
async function pendingIntent(service) {
  for (let i = 0; i < 100; i++) {
    const intent = service.state.intents.find((i) => i.status === 'approval-required');
    if (intent) return intent;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Expected a manual site transaction');
}

test('site connection exposes only the human-selected account; JSON actions cannot create a trusted session', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.session.request({ method: 'eth_accounts' }), []);
  await assert.rejects(
    f.service.request('app.createSession', { origin: 'https://dapp.example' }),
    /UNKNOWN_WALLET_ACTION/,
  );
  await assert.rejects(
    f.session.request({ method: 'eth_sign', params: ['secret'] }),
    (e) => e.code === 4200,
  );
  const pending = f.session.request({
    method: 'eth_requestAccounts',
    origin: 'https://forged.example',
  });
  const request = f.service.apps.list().pending[0];
  assert.equal(request.origin, 'https://dapp.example');
  await assert.rejects(
    f.service.request('app.allow', { id: request.id, walletId: f.wallet.id, chain: 'base' }),
    /CONFIRMATION_REQUIRED/,
  );
  await f.service.request('app.deny', { id: request.id });
  await assert.rejects(pending, (e) => e.code === 4001);
  await f.connect();
  assert.deepEqual(await f.session.request({ method: 'eth_accounts' }), [f.wallet.address]);
  assert.equal(f.writes.length, 0);
  assert.throws(
    () => f.service.apps.createSession({ url: 'http://evil.example', valid: () => true }),
    (e) => e.code === 4100,
  );
});

test('closing the requesting document aborts its network probe and prevents a late save', async (t) => {
  const { service, session } = await fixture(t);
  const rejected = assert.rejects(
    session.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x539',
          chainName: 'Fixture EVM',
          nativeCurrency: { name: 'Test coin', symbol: 'TEST', decimals: 18 },
          rpcUrls: ['https://suggested.invalid/fixture'],
        },
      ],
    }),
    (e) => e.code === 4001,
  );
  const { id } = service.apps.list().pending[0];
  const { promise: contacted, resolve: reached } = Promise.withResolvers();
  service.networks.fetcher = (url, { signal }) => {
    assert.equal(url, 'https://owner.invalid/');
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      reached(signal);
    });
  };
  const probe = assert.rejects(
    service.request('app.probeNetwork', { id, rpc: 'https://owner.invalid' }),
    /WALLET_APP_CHANGED/,
  );
  const signal = await contacted;
  session.close();
  await Promise.all([rejected, probe]);
  assert.equal(signal.aborted, true);
  assert.equal(service.apps.list().pending.length, 0);
  assert.equal(service.networks.has('evm-1337'), false);
  await assert.rejects(
    service.request('app.addNetwork', { id, confirmed: true }),
    /WALLET_APP_CHANGED/,
  );
});

test('a connected site still needs exact manual approval despite wallet automatic authority; retries do not pay twice', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const grant = await f.service.request('policy.challenge', { id: f.wallet.id, chains: [8453] });
  await f.service.request('policy.grant', {
    challengeId: grant.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  const input = {
    id: 'payment-one',
    method: 'eth_sendTransaction',
    params: [{ from: f.wallet.address, to: recipient, value: '0x38d7ea4c68000' }],
  };
  const sending = f.session.request(input),
    intent = await pendingIntent(f.service);
  assert.equal(intent.authorization.mode, 'manual');
  assert.equal(intent.sourceApp.origin, 'https://dapp.example');
  assert.equal(f.writes.length, 0);
  const approved = await f.service.request('intent.approve', {
    id: intent.id,
    digest: intent.digest,
  });
  assert.equal(approved.status, 'approved');
  const hash = await sending;
  assert.match(hash, /^0x[\da-f]{64}$/);
  assert.equal(f.writes.length, 1);
  assert.equal(await f.session.request(input), hash);
  assert.equal(f.writes.length, 1);
  await assert.rejects(
    f.session.request({ ...input, params: [{ ...input.params[0], value: '0x1' }] }),
    (e) => e.code === -32602,
  );
  await assert.rejects(
    f.session.request({
      ...input,
      id: 'wrong-sender',
      params: [{ ...input.params[0], from: recipient }],
    }),
    (e) => e.code === 4100,
  );
  await assert.rejects(
    f.session.request({ method: 'eth_sendRawTransaction', params: ['0x00'] }),
    (e) => e.code === 4200,
  );
});

test('revocation while a real native signature reply is delayed stops dispatch and preserves the signature receipt', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    original = f.service.signer.bind(f.service);
  f.service.signer = async (action, input) => {
    const result = await original(action, input);
    if (action === 'sign') {
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  const sending = f.session.request({
    id: 'late-payment',
    method: 'eth_sendTransaction',
    params: [{ from: f.wallet.address, to: recipient, value: '0x1' }],
  });
  const outcome = sending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const intent = await pendingIntent(f.service);
  await f.service.request('intent.approve', { id: intent.id, digest: intent.digest });
  await entered.promise;
  try {
    const c = f.service.apps.list().connections[0];
    await f.service.request('app.revoke', { id: c.id, revision: c.revision });
  } finally {
    release.resolve();
  }
  assert.ok((await outcome).error);
  assert.equal(f.writes.length, 0);
  await f.service.request('lock', { id: f.wallet.id });
  const recovered = await f.service.reconcile(intent.id);
  assert.equal(recovered.submissionMayHaveOccurred, false);
  assert.match(recovered.hash, /^0x[\da-f]{64}$/);
});

test('disconnect after durable hash storage but before dispatch does not report a successful submission', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    original = f.service.mutate.bind(f.service);
  let gated = false;
  f.service.mutate = async (fn) => {
    const result = await original(fn);
    if (!gated && f.service.state.intents.some((i) => i.status === 'submit-unknown' && i.hash)) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
    return result;
  };
  const sending = f.session.request({
    id: 'durable-not-dispatched',
    method: 'eth_sendTransaction',
    params: [{ from: f.wallet.address, to: recipient, value: '0x1' }],
  });
  const outcome = sending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const intent = await pendingIntent(f.service);
  await f.service.request('intent.approve', { id: intent.id, digest: intent.digest });
  await entered.promise;
  try {
    const c = f.service.apps.list().connections[0];
    await f.service.request('app.revoke', { id: c.id, revision: c.revision });
  } finally {
    release.resolve();
  }
  assert.equal((await outcome).error?.code, 4001);
  assert.equal(f.writes.length, 0);
  const saved = f.service.state.intents.find((i) => i.id === intent.id);
  assert.match(saved.hash, /^0x[\da-f]{64}$/);
  assert.equal(saved.submissionMayHaveOccurred, false);
});

test('host browser binding rejects frames and late document changes and derives origin independently of page input', async (t) => {
  const f = await fixture(t),
    page = new EventEmitter();
  let url = 'https://real.example/start',
    closed = false,
    binding;
  const frame = { url: () => url };
  page.mainFrame = () => frame;
  page.isClosed = () => closed;
  const context = {
    exposeBinding: async (_name, fn) => {
      binding = fn;
    },
    addInitScript: async (fn) => assert.equal(fn, installProvider),
  };
  await attachWalletProvider(context, { enabled: () => true, getWallet: async () => f.service });
  assert.equal(
    (await binding({ page, frame: { url: () => url } }, { method: 'eth_accounts' })).error.code,
    4100,
  );
  const pending = binding(
    { page, frame },
    { method: 'eth_requestAccounts', params: [], origin: 'https://forged.example' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const request = f.service.apps.list().pending[0];
  assert.equal(request.origin, 'https://real.example');
  url = 'https://other.example/';
  page.emit('framenavigated', frame);
  assert.equal((await pending).error.code, 4001);
  assert.equal(f.service.apps.list().connections.length, 0);
  closed = true;
  page.emit('close');
});

test('browser binding retries transient owner startup and discards sessions from a replaced document', async (t) => {
  const f = await fixture(t),
    page = new EventEmitter();
  let url = 'https://real.example/start',
    binding,
    attempts = 0;
  const frame = { url: () => url };
  page.mainFrame = () => frame;
  page.isClosed = () => false;
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  await attachWalletProvider(
    {
      exposeBinding: async (_name, fn) => {
        binding = fn;
      },
      addInitScript: async () => {},
    },
    {
      enabled: () => true,
      getWallet: async () => {
        attempts++;
        if (attempts === 1) throw Error('WALLET_APP_OWNER_UNAVAILABLE');
        if (attempts === 3) {
          entered.resolve();
          await release.promise;
        }
        return f.service;
      },
    },
  );
  const source = { page, frame },
    input = { method: 'eth_accounts' };
  assert.equal((await binding(source, input)).ok, false);
  assert.deepEqual((await binding(source, input)).value, []);
  page.emit('framenavigated', frame);
  const obsolete = binding(source, input);
  await entered.promise;
  url = 'https://other.example/';
  page.emit('framenavigated', frame);
  release.resolve();
  assert.equal((await obsolete).error.code, 4900);
  assert.equal(f.service.apps.sessions.size, 1); // Only the fixture's independent session.
  assert.deepEqual((await binding(source, input)).value, []);
  page.emit('close');
});
