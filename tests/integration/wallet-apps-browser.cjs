/* SPDX-License-Identifier: GPL-3.0-or-later */
// All pages and transactions are isolated local fixtures; no public-chain writes.
'use strict';
/* global ethereum, document, window, location, __cibypWalletProviderV1, indexedDB */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const http = require('node:http'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const { verifyMessage, verifyTypedData, hexlify, toUtf8Bytes } = require('ethers');
const { attachWalletProvider } = require('../../src/main/services/wallet/browser-provider');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-app-browser-'));
let host, chain, browser, context, site, rpcUrl;
const extension = process.env.CIBYP_TEST_WALLET_EXTENSION === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw Error('Wallet browser fixture timed out');
}
async function rpc(method, params = []) {
  const result = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  if (result.error) throw Error('Local chain error ' + result.error.code);
  return result.result;
}
const call = (action, input = {}) =>
  host.dispatch({ method: 'wallet:request', args: [action, input] });
async function open() {
  host = await require(
    process.env.CIBYP_TEST_NODE_BACKEND || require.resolve('../../src/agent/node-host'),
  ).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      features: { quant: true },
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
    },
  });
}
async function main() {
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  rpcUrl = 'http://127.0.0.1:' + port;
  const binary =
    process.env.CIBYP_TEST_ANVIL || (await require('../../scripts/test-quant-chain.cjs').prepare());
  chain = spawn(
    binary,
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1337', '--silent'],
    { stdio: 'ignore', windowsHide: true, cwd: profile },
  );
  chain.on('error', () => {});
  await until(async () => {
    try {
      return (await rpc('eth_chainId')) === '0x539';
    } catch {
      return false;
    }
  });
  await open();
  const wallet = await call('import', {
    kind: 'privateKey',
    name: 'Browser fixture wallet',
    secret: '0x' + '01'.padStart(64, '0'),
    password: 'public-browser-wallet-fixture-password',
  });
  await call('unlock', {
    id: wallet.id,
    password: 'public-browser-wallet-fixture-password',
    minutes: 0,
  });
  await rpc('anvil_setBalance', [wallet.address, '0xde0b6b3a7640000']);
  let expectedLogin,
    loginUsed = false;
  site = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/verify-login') {
      let body = '';
      req.on('data', (b) => {
        body += b;
        if (body.length > 8192) req.destroy();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          assert.equal(loginUsed, false);
          assert.equal(data.message, expectedLogin);
          assert.equal(verifyMessage(data.message, data.signature), wallet.address);
          loginUsed = true;
          res.setHeader(
            'set-cookie',
            'fixture_session=authenticated; HttpOnly; SameSite=Strict; Path=/',
          );
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ authenticated: true }));
        } catch {
          res.writeHead(403);
          res.end('{}');
        }
      });
      return;
    }
    if (req.url === '/account') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          authenticated: !!req.headers.cookie?.includes('fixture_session=authenticated'),
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Isolated CIBYP DApp fixture</title><h1>Local wallet integration</h1><script>window.discovered=[];addEventListener("eip6963:announceProvider",e=>discovered.push(e.detail));dispatchEvent(new Event("eip6963:requestProvider"));</script>',
    );
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + site.address().port;
  let client, firstParty;
  if (extension) {
    const extensionPath = await require('../../scripts/build-wallet-browser.cjs').build(
      path.join(profile, 'extension'),
    );
    context = await require('playwright').chromium.launchPersistentContext(
      path.join(profile, 'chromium'),
      {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      },
    );
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    const popup = await context.newPage();
    await popup.goto(worker.url().replace(/\/background\.js$/, '/popup.html'));
    const offer = await call('browser.pair');
    await popup.locator('#pair-uri').fill(offer.uri);
    await popup.locator('#browser-name').fill('Isolated Chromium fixture');
    await popup.locator('#pair').click();
    const pending = await until(async () => {
      const current = await call('browser.status');
      if (
        await popup
          .locator('#status')
          .textContent()
          .then((s) => s.includes('incomplete'))
      )
        throw Error('Extension pairing failed: ' + (await popup.locator('#status').textContent()));
      return current.pending[0];
    });
    assert.equal(
      pending.origin,
      new URL(worker.url()).protocol + '//' + new URL(worker.url()).hostname,
    );
    assert.equal(pending.name, 'Isolated Chromium fixture');
    assert.equal(await popup.locator('#client-fingerprint').textContent(), pending.fingerprint);
    assert.equal(host.runtime.walletService.apps.sessions.size, 0);
    await assert.rejects(
      call('browser.confirm', { id: pending.id, digest: pending.digest }),
      /CONFIRMATION_REQUIRED/,
    );
    const paired = await call('browser.confirm', {
      id: pending.id,
      digest: pending.digest,
      confirmed: true,
    });
    client = paired.clients[0];
    await popup.locator('#connection').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(
      await worker.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open('cibyp-wallet-browser-v1', 1);
            open.onerror = reject;
            open.onsuccess = () => {
              const db = open.result;
              const get = db.transaction('keys').objectStore('keys').get('identity');
              get.onerror = reject;
              get.onsuccess = () => {
                resolve({
                  extractable: get.result.privateKey.extractable,
                  type: get.result.privateKey.type,
                });
                db.close();
              };
            };
          }),
      ),
      { extractable: false, type: 'private' },
    );
    fs.mkdirSync('.cache/previews', { recursive: true });
    await popup.locator('body').screenshot({ path: '.cache/previews/wallet-browser-popup.png' });
    const protectedIdentity = JSON.parse(
      fs.readFileSync(path.join(profile, 'wallet', 'browser-identity.json'), 'utf8'),
    );
    assert.equal(
      protectedIdentity.protection,
      process.platform === 'win32' ? 'dpapi' : 'safe-storage',
    );
    assert.equal(JSON.stringify(protectedIdentity).includes('PRIVATE KEY'), false);
    await popup.close();
  } else {
    browser = await require('playwright').chromium.launch({ headless: true });
    context = await browser.newContext();
    await attachWalletProvider(context, {
      enabled: () => true,
      getWallet: async () => {
        await call('list');
        return host.runtime.walletService;
      },
    });
  }
  const page = await context.newPage();
  await page.goto(origin);
  if (extension)
    await page.evaluate(() => {
      window.walletFixtureRequests = {};
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (e.source === window && d?.channel === 'cibyp-wallet-v1' && d.direction === 'request')
          window.walletFixtureRequests[d.input.method] = d.input;
      });
    });
  const discovered = await page.evaluate(() => ({
    name: discovered[0].info.name,
    uuid: discovered[0].info.uuid,
    frozen: Object.isFrozen(ethereum),
    accounts: null,
  }));
  assert.equal(discovered.name, 'Could I Be Your Partner');
  assert.match(discovered.uuid, /^[\da-f-]{36}$/);
  assert.equal(discovered.frozen, true);
  const chainProposal = {
    chainId: '0x539',
    chainName: 'Local DApp chain',
    nativeCurrency: { name: 'Test ether', symbol: 'TEST', decimals: 18 },
    rpcUrls: ['https://suggested-node.invalid/site-key-fixture'],
  };
  assert.equal(
    await page.evaluate(() =>
      ethereum
        .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x539' }] })
        .then(
          () => null,
          (e) => e.code,
        ),
    ),
    4902,
  );
  const add = (proposal) =>
    page.evaluate(
      (network) =>
        ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [network],
        }),
      proposal,
    );
  await assert.rejects(add({ ...chainProposal, rpcUrls: [rpcUrl] }), /HTTPS/);
  const inspected = [];
  host.runtime.walletService.networks.fetcher = (url, options) => {
    inspected.push(url);
    assert.equal(new URL(url).origin, rpcUrl);
    return fetch(url, options);
  };
  const requested = add(chainProposal);
  const proposed = await until(async () => (await call('app.list')).pending[0]);
  assert.equal(proposed.origin, origin);
  assert.deepEqual(proposed.network, {
    id: 1337,
    name: 'Local DApp chain',
    nativeSymbol: 'TEST',
    rpcOrigins: ['https://suggested-node.invalid'],
  });
  assert.deepEqual(inspected, []);
  assert.ok(!(await call('network.list')).items.some((p) => p.id === 1337));
  const proof = await call('app.probeNetwork', { id: proposed.id, rpc: rpcUrl });
  assert.ok(inspected.length >= 3);
  assert.match(proof.profile.genesisHash, /^0x[\da-f]{64}$/);
  assert.equal(proof.profile.id, 1337);
  await assert.rejects(
    call('app.addNetwork', { id: proposed.id, reviewId: proof.id }),
    /CONFIRMATION_REQUIRED/,
  );
  assert.ok(!(await call('network.list')).items.some((p) => p.id === 1337));
  await call('app.addNetwork', {
    id: proposed.id,
    reviewId: proof.id,
    confirmed: true,
    rpc: 'https://replacement.invalid',
  });
  assert.equal(await requested, null);
  assert.equal(await add(chainProposal), null);
  assert.equal((await call('network.config', { key: 'evm-1337' })).rpc, new URL(rpcUrl).href);
  assert.equal(await page.evaluate(() => ethereum.request({ method: 'eth_chainId' })), '0x2105');
  if (extension) {
    firstParty = host.runtime.walletService.apps.createSession({ url: origin, valid: () => true });
    const asking = firstParty.request({ method: 'eth_requestAccounts' }),
      first = (await call('app.list')).pending[0];
    await call('app.allow', {
      id: first.id,
      walletId: wallet.id,
      chain: 'evm-1337',
      confirmed: true,
    });
    await asking;
  }
  assert.deepEqual(await page.evaluate(() => ethereum.request({ method: 'eth_accounts' })), []);
  const connecting = page.evaluate(() => ethereum.request({ method: 'eth_requestAccounts' }));
  const request = await until(() => host.runtime.walletService.apps.list().pending[0]);
  assert.equal(request.origin, origin);
  if (extension) assert.equal(request.clientId, client.id);
  await call('app.allow', {
    id: request.id,
    walletId: wallet.id,
    chain: 'evm-1337',
    confirmed: true,
  });
  assert.deepEqual(await connecting, [wallet.address]);
  assert.equal(await page.evaluate(() => ethereum.request({ method: 'eth_chainId' })), '0x539');
  expectedLogin = `${origin} wants you to sign in with your Ethereum account:\n${wallet.address}\n\nIsolated browser login\n\nURI: ${origin}/login\nVersion: 1\nChain ID: 1337\nNonce: public123456\nIssued At: ${new Date().toISOString()}`;
  const login = page.evaluate(
    ({ data, address }) => ethereum.request({ method: 'personal_sign', params: [data, address] }),
    { data: hexlify(toUtf8Bytes(expectedLogin)), address: wallet.address },
  );
  const loginRecord = await until(() =>
    host.runtime.walletService.messages.items.find((r) => r.status === 'approval-required'),
  );
  assert.equal(loginRecord.login.origin, origin);
  if (extension) assert.equal(loginRecord.sourceBrowser.clientId, client.id);
  await call('message.approve', {
    id: loginRecord.id,
    digest: loginRecord.reviewDigest,
    confirmed: true,
  });
  const loginSignature = await login;
  assert.equal(verifyMessage(expectedLogin, loginSignature), wallet.address);
  const authenticated = await page.evaluate(
    async (data) =>
      (
        await fetch('/verify-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        })
      ).json(),
    { message: expectedLogin, signature: loginSignature },
  );
  assert.equal(authenticated.authenticated, true);
  assert.equal(
    await page.evaluate(async () => (await fetch('/account')).json().then((r) => r.authenticated)),
    true,
  );
  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Order: [
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'memo', type: 'string' },
      ],
    },
    primaryType: 'Order',
    domain: { name: 'Isolated public fixture', chainId: 1337 },
    message: {
      recipient: '0x' + '2'.repeat(40),
      amount: '123456789012345678901234567890',
      memo: 'Manual typed signature',
    },
  };
  const signingTyped = page.evaluate(
    ({ address, data }) =>
      ethereum.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(data)] }),
    { address: wallet.address, data: typedData },
  );
  const typedRecord = await until(() =>
    host.runtime.walletService.messages.items.find((r) => r.status === 'approval-required'),
  );
  assert.equal(typedRecord.message.origin, origin);
  await call('message.approve', {
    id: typedRecord.id,
    digest: typedRecord.reviewDigest,
    confirmed: true,
  });
  assert.equal(
    verifyTypedData(
      typedData.domain,
      { Order: typedData.types.Order },
      typedData.message,
      await signingTyped,
    ),
    wallet.address,
  );
  const unsupported = await page.evaluate(() =>
    ethereum.request({ method: 'eth_sign', params: ['0x01'] }).then(
      () => null,
      (e) => e.code,
    ),
  );
  assert.equal(unsupported, 4200);
  const recipient = '0x' + '2'.repeat(40);
  const payment = page.evaluate(
    ({ from, to }) =>
      ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from, to, value: '0x38d7ea4c68000' }],
      }),
    { from: wallet.address, to: recipient },
  );
  const intent = await until(() =>
    host.runtime.walletService.state.intents.find((i) => i.status === 'approval-required'),
  );
  assert.equal(intent.sourceApp.origin, origin);
  if (extension) assert.equal(intent.sourceApp.clientId, client.id);
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 0n);
  await call('intent.approve', { id: intent.id, digest: intent.digest });
  const hash = await payment;
  assert.match(hash, /^0x[\da-f]{64}$/);
  assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 1000000000000000n);
  const frame = await page.evaluateHandle(() => {
    const n = document.createElement('iframe');
    n.src = '/child';
    document.body.append(n);
    return n;
  });
  const child = await until(async () => {
    const f = await frame.asElement().contentFrame();
    return f?.url().endsWith('/child') ? f : null;
  });
  if (extension) assert.equal(await child.evaluate(() => typeof ethereum), 'undefined');
  else
    assert.equal(
      (await child.evaluate(() => __cibypWalletProviderV1({ method: 'eth_accounts', params: [] })))
        .error.code,
      4100,
    );
  const switching = page.evaluate(() =>
    ethereum
      .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] })
      .then(
        () => null,
        (e) => e.code,
      ),
  );
  const switchRequest = await until(() => host.runtime.walletService.apps.list().pending[0]);
  assert.equal(switchRequest.desiredChain, 'base');
  await call('app.deny', { id: switchRequest.id });
  assert.equal(await switching, 4001);
  assert.equal(await page.evaluate(() => ethereum.request({ method: 'eth_chainId' })), '0x539');
  await page.evaluate(() => {
    window.fixtureChains = [];
    ethereum.on('chainChanged', (chain) => window.fixtureChains.push(chain));
  });
  const resend = (method) =>
    page.evaluate(
      (method) =>
        new Promise((resolve) => {
          const input = window.walletFixtureRequests[method];
          const id = crypto.randomUUID();
          const finish = (e) => {
            if (e.source !== window || e.data?.id !== id || e.data.direction !== 'response') return;
            window.removeEventListener('message', finish);
            resolve(e.data.value);
          };
          window.addEventListener('message', finish);
          window.postMessage(
            { channel: 'cibyp-wallet-v1', direction: 'request', id, input },
            location.origin,
          );
        }),
      method,
    );
  for (const [chainId, key] of [
    ['0x2105', 'base'],
    ['0x539', 'evm-1337'],
  ]) {
    const switched = page.evaluate(
      (chainId) =>
        ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }),
      chainId,
    );
    const pending = await until(async () => (await call('app.list')).pending[0]);
    assert.equal(pending.walletId, wallet.id);
    assert.equal(pending.desiredChain, key);
    await call('app.allow', { id: pending.id, walletId: wallet.id, chain: key, confirmed: true });
    assert.equal(await switched, null);
    assert.equal(await page.evaluate(() => ethereum.request({ method: 'eth_chainId' })), chainId);
    if (extension && key === 'base') {
      const oldRequest = await resend('eth_sendTransaction');
      assert.equal(oldRequest.ok, false);
      assert.equal(oldRequest.error.code, 4901);
      assert.equal((await call('history')).total, 1);
    }
  }
  assert.deepEqual(await page.evaluate(() => window.fixtureChains), ['0x2105', '0x539']);
  if (extension) {
    // Capture the document's original request IDs, then explicitly resend after
    // a transport reconnect. Neither signing nor broadcasting may run again.
    const before = await call('browser.status');
    await call('browser.stop');
    assert.equal((await call('browser.start')).endpoint, before.endpoint);
    const resendPayment = await resend('eth_sendTransaction');
    assert.equal(resendPayment.ok, true);
    assert.equal(resendPayment.value, hash);
    assert.equal((await call('history')).total, 1);
    assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 1000000000000000n);
    const resendLogin = await resend('personal_sign');
    assert.equal(resendLogin.ok, false);
    assert.equal(resendLogin.error.code, 4001);
    assert.match(resendLogin.error.message, /already exists/);
    assert.equal((await call('message.list')).total, 2);
    const navigating = page
      .evaluate(() =>
        ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }),
      )
      .catch(() => null);
    await until(() => host.runtime.walletService.apps.list().pending[0]);
    await page.reload();
    await navigating;
    await until(async () => (await call('app.list')).pending.length === 0);
    await host.api.setSettings({ language: 'en' });
    assert.equal((await call('browser.status')).state, 'listening');
    await host.api.setSettings({ features: { quant: false } });
    assert.equal((await call('browser.status')).state, 'listening');
    await call('browser.stop');
    assert.equal((await call('browser.status')).state, 'stopped');
    assert.equal((await call('browser.start')).state, 'listening');
  }
  await host.close();
  firstParty = null;
  host = null;
  await open();
  await call('list');
  if (extension) await until(async () => (await call('browser.status')).state === 'listening');
  await page.reload();
  assert.deepEqual(await page.evaluate(() => ethereum.request({ method: 'eth_accounts' })), [
    wallet.address,
  ]);
  assert.equal((await call('list')).wallets[0].unlocked, false);
  assert.equal((await call('message.list', { status: 'history' })).total, 2);
  assert.equal((await call('message.reconcile', { id: loginRecord.id })).signature, undefined);
  if (extension) {
    await call('browser.revoke', { id: client.id, revision: client.revision });
    const failure = await page.evaluate(() =>
      ethereum.request({ method: 'eth_accounts' }).then(
        () => null,
        (e) => e.code,
      ),
    );
    assert.equal(failure, 4900);
    assert.equal((await call('app.list')).connections.length, 1);
    await host.close();
    host = null;
    await open();
    await until(async () => (await call('browser.status')).state === 'listening');
    assert.equal(
      (await call('browser.status')).clients.find((c) => c.id === client.id).revoked,
      true,
    );
    assert.equal((await call('app.list')).connections.length, 1);
    await page.reload();
    assert.equal(
      await page.evaluate(() =>
        ethereum.request({ method: 'eth_accounts' }).then(
          () => null,
          (e) => e.code,
        ),
      ),
      4900,
    );
  } else {
    const c = (await call('app.list')).connections[0];
    await call('app.revoke', { id: c.id, revision: c.revision });
    assert.deepEqual(await page.evaluate(() => ethereum.request({ method: 'eth_accounts' })), []);
    assert.equal(await page.evaluate(() => ethereum.request({ method: 'eth_chainId' })), '0x539');
  }
  console.log(
    'PASS: real Chromium discovery, host-verified origin, manual SIWE signing and server-verified login cookie, typed-data signing, manual native payment, iframe denial, chain review, locked signing-history recovery and disconnection; ' +
      (process.env.CIBYP_TEST_NODE_BACKEND ? 'bundled' : 'source') +
      ' backend' +
      (extension ? ' with installed browser extension.' : '.'),
  );
}
main()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await context?.close();
    await browser?.close();
    if (site) await new Promise((r) => site.close(r));
    if (host) await host.close();
    if (chain && chain.exitCode === null) {
      chain.kill();
      await Promise.race([new Promise((r) => chain.once('exit', r)), sleep(2000)]);
    }
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('cibyp-app-browser-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
