/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Actual local EVM + actual encrypted signer + shared Node backend + Agent loop.
// No fork, public RPC, user credentials, provider charges or real assets.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const root = path.resolve(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-quant-chain-'));
const originalFetch = global.fetch;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chain,
  modelServer,
  host,
  steps = 0,
  wallet,
  project,
  fixtureLogs = '';
const recipient = '0x1111111111111111111111111111111111111111';
const counter = '0x2222222222222222222222222222222222222222';
const counterAbi = ['function increment()', 'function value() view returns(uint256)'];
let encodedCallId;
const request = (method, ...args) => host.dispatch({ method, args });
async function main() {
  const binary =
    process.env.CIBYP_TEST_ANVIL ||
    path.join(root, '.cache/quant-tools', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  assert.ok(fs.existsSync(binary), 'Set CIBYP_TEST_ANVIL to a verified official Anvil executable');
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const endpoint = 'http://127.0.0.1:' + port;
  const environment = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH'])
    if (process.env[key]) environment[key] = process.env[key];
  chain = spawn(
    binary,
    ['--silent', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '8453'],
    { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chain.on('error', (error) => {
    fixtureLogs += error.message;
  });
  chain.stderr.on('data', (bytes) => {
    fixtureLogs = (fixtureLogs + bytes).slice(-4000);
  });
  const rpc = async (method, params = []) => {
    const response = await originalFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    if (response.error) throw Error(response.error.message);
    return response.result;
  };
  const until = async (fn, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await fn()) return;
      } catch {}
      await pause(30);
    }
    throw Error('Local-chain condition timed out: ' + fixtureLogs);
  };
  await until(() => rpc('eth_chainId').then((id) => id === '0x2105'));
  // A local chain has no L1 fee; this development-only oracle returns zero.
  await rpc('anvil_setCode', [
    '0x420000000000000000000000000000000000000f',
    '0x600060005260206000f3',
  ]);
  const selector = new (require('ethers').Interface)(counterAbi)
    .getFunction('value')
    .selector.slice(2);
  // Development-only counter: increment storage slot zero, or return it for value().
  await rpc('anvil_setCode', [
    counter,
    '0x60003560e01c63' + selector + '14601957600054600101600055005b60005460005260206000f3',
  ]);
  const respond = (request) => {
    let message = { role: 'assistant', content: 'Local chain transaction' },
      finish = 'stop';
    if (request.tools?.length) {
      steps++;
      const operation = {
        operationId: 'requested-transfer',
        walletId: wallet.id,
        to: recipient,
        value: '0.001',
      };
      if (steps === 7) {
        const output = JSON.parse(
          request.messages.filter((message) => message.role === 'tool').at(-1).content,
        );
        encodedCallId = output.callId;
        assert.match(encodedCallId, /^[\da-f]{64}$/);
      }
      const contractOperation = {
        operationId: 'increment-once',
        walletId: wallet.id,
        callId: encodedCallId,
      };
      const calls = {
        1: ['quant_inspect', {}],
        2: ['quant_wallets', {}],
        3: ['quant_live_transaction', operation],
        4: ['quant_live_transaction', operation],
        5: ['quant_live_status', { intentId: host.runtime.walletService.state.intents[0]?.id }],
        6: [
          'quant_contract',
          { action: 'encode', to: counter, abi: counterAbi, function: 'increment' },
        ],
        7: ['quant_live_transaction', contractOperation],
        8: ['quant_live_transaction', contractOperation],
        9: [
          'quant_contract',
          { action: 'read', to: counter, abi: counterAbi, function: 'value', maxChars: 0 },
        ],
        10: [
          'quant_live_status',
          {
            intentId: host.runtime.walletService.state.intents.find(
              (intent) => intent.transaction.to.toLowerCase() === counter,
            )?.id,
          },
        ],
        11: [
          'goalComplete',
          {
            summary:
              'The authorized transfer and custom contract call are mined. Duplicate retries reused each durable operation. The counter increased exactly once and both receipts were reconciled.',
          },
        ],
      };
      if (calls[steps]) {
        const [name, args] = calls[steps];
        message = {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'different-tool-call-' + steps,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        };
        finish = 'tool_calls';
      } else message.content = 'The local-chain transfer is complete and verified.';
    }
    return {
      choices: [{ message, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    };
  };
  // Exercise real loopback HTTP and the production proxy initializer. Replacing
  // global.fetch or patching one copy of net-proxy masks packaged-module errors.
  modelServer = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.method, 'POST');
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 1024 * 1024) throw Error('Fixture request limit');
        chunks.push(chunk);
      }
      const body = respond(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(body));
    } catch (error) {
      outgoing.writeHead(400, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const modelEndpoint = 'http://127.0.0.1:' + modelServer.address().port + '/v1';
  const runtimeEntry =
    process.env.CIBYP_TEST_NODE_BACKEND || require.resolve('../../src/agent/node-host');
  host = await require(runtimeEntry).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      features: { quant: true },
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
      llm: {
        provider: 'openai-compat',
        apiUrl: modelEndpoint,
        apiKey: 'fixture',
        model: 'Local-chain fixture',
        streamResponses: false,
        pool: [],
      },
      toolExposure: { mode: 'all' },
    },
  });
  wallet = await request('wallet:request', 'create', {
    password: 'local-chain-fixture-password',
    name: 'Local EVM test wallet',
  });
  await rpc('anvil_setBalance', [wallet.address, '0x8ac7230489e80000']);
  await request('wallet:request', 'unlock', {
    id: wallet.id,
    password: 'local-chain-fixture-password',
    minutes: 0,
  });
  const challenge = await request('wallet:request', 'policy.challenge', {
    id: wallet.id,
    chains: [8453],
  });
  await request('wallet:request', 'policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  project = await request('quant:request', 'workspace.create', {
    name: 'Local EVM fixture',
    venue: 'base',
  });
  await request('quant:request', 'workspace.update', {
    id: project.id,
    market: { rpcUrl: endpoint },
  });
  const chat = await request('quant:request', 'chat.open', { id: project.id });
  const simulation = await request('quant:request', 'contract', {
    id: project.id,
    action: 'simulate',
    to: counter,
    from: wallet.address,
    abi: counterAbi,
    function: 'increment',
  });
  assert.equal(simulation.readOnly, true);
  assert.equal(
    BigInt(await rpc('eth_getStorageAt', [counter, '0x0', 'latest'])),
    0n,
    'Simulation must not change contract state',
  );
  const key = chat.key || 'quant:' + project.id;
  await host.runtime.goalCommand(
    key,
    'set',
    'Transfer exactly 0.001 ETH from the selected test wallet to ' +
      recipient +
      ' on the configured local development chain. Then increment the counter at ' +
      counter +
      ' exactly once using its provided increment()/value() ABI. Verify both receipts and the counter value. A repeated tool call is a retry, not another operation.',
  );
  await until(
    () =>
      host.runtime.getSession(key)?.goal?.status === 'complete' &&
      !host.runtime.getSession(key)?.busy,
    40000,
  );
  const records = (await request('wallet:request', 'history', { workspaceId: project.id })).items;
  assert.equal(
    records.length,
    2,
    'Exactly two distinct requested operations; retries cannot become additional payments',
  );
  assert.ok(records.every((record) => ['included', 'safe', 'finalized'].includes(record.status)));
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 1000000000000000n);
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), 2n);
  assert.equal(BigInt(await rpc('eth_getStorageAt', [counter, '0x0', 'latest'])), 1n);
  assert.equal((await rpc('eth_getTransactionReceipt', [records[0].hash])).status, '0x1');
  const transfer = records.find((record) => record.transaction.to.toLowerCase() === recipient);
  const transaction = await rpc('eth_getTransactionByHash', [transfer.hash]);
  assert.equal(transaction.from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(transaction.to.toLowerCase(), recipient);
  assert.equal(BigInt(transaction.chainId), 8453n);
  assert.ok(!JSON.stringify(records).includes(wallet.mnemonic));
  const history = host.runtime.quantService.loadConversation(project.id);
  assert.equal(history.goal.status, 'complete');
  assert.ok(history.quantOperationNamespace.startsWith('goal:'));
  assert.ok(!JSON.stringify(history).includes('local-chain-fixture-password'));
  // Real encrypted signer and local chain: revocation before dispatch must stop
  // the signature; revocation after dispatch cannot undo an accepted payment.
  const walletService = host.runtime.walletService;
  const signer = walletService.signer.bind(walletService);
  let releaseSignature, signatureReady;
  const signed = new Promise((resolve) => {
    signatureReady = resolve;
  });
  const signatureGate = new Promise((resolve) => {
    releaseSignature = resolve;
  });
  walletService.signer = async (action, input) => {
    const result = await signer(action, input);
    if (action === 'sign') {
      signatureReady();
      await signatureGate;
    }
    return result;
  };
  const config = { venue: 'base', rpcUrl: endpoint };
  const fencedInput = {
    walletId: wallet.id,
    commandId: 'revoked-during-real-signature',
    to: recipient,
    value: '0.0002',
  };
  const executionContext = { actor: 'agent', workspaceId: project.id };
  const fencedOperation = walletService.transact(config, fencedInput, executionContext);
  await until(() => walletService.inFlight.size === 1);
  await signed;
  await walletService.request('policy.revoke', { id: wallet.id });
  releaseSignature();
  const fenced = await fencedOperation;
  assert.equal(fenced.status, 'cancelled');
  assert.equal(fenced.submissionMayHaveOccurred, false);
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), 2n);
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 1000000000000000n);
  walletService.signer = signer;
  const renewed = await walletService.request('policy.challenge', {
    id: wallet.id,
    chains: [8453],
  });
  await walletService.request('policy.grant', {
    challengeId: renewed.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
  assert.equal((await walletService.transact(config, fencedInput, executionContext)).id, fenced.id);
  const networkRpc = walletService.market.rpc.bind(walletService.market);
  let dispatched = 0;
  walletService.market.rpc = async (...args) => {
    const result = await networkRpc(...args);
    if (args[2] === 'eth_sendRawTransaction') {
      dispatched++;
      await walletService.request('policy.revoke', { id: wallet.id });
      throw Error('fixture hides the acknowledgement after the real node accepted it');
    }
    return result;
  };
  const uncertainInput = { ...fencedInput, commandId: 'revoked-after-real-dispatch' };
  const replacement = await walletService.transact(config, uncertainInput, {
    ...executionContext,
    returnPending: true,
  });
  assert.equal(replacement.status, 'approval-required');
  assert.match(replacement.replacementOf, /^0x[a-f0-9]{64}$/);
  await assert.rejects(
    walletService.request('intent.approve', { id: replacement.id, digest: replacement.digest }),
    /NONCE_CONFIRMATION/,
  );
  const uncertain = await walletService.request('intent.approve', {
    id: replacement.id,
    digest: replacement.digest,
    replacementOf: replacement.replacementOf,
  });
  assert.equal(uncertain.status, 'submit-unknown');
  assert.equal(uncertain.submissionMayHaveOccurred, true);
  assert.match(uncertain.hash, /^0x[a-f0-9]{64}$/);
  await walletService.transact(config, uncertainInput, executionContext);
  assert.equal(dispatched, 1);
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), 3n);
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), 1200000000000000n);
  const reconciled = await walletService.reconcile(uncertain.id);
  assert.ok(['included', 'safe', 'finalized'].includes(reconciled.status));
  assert.equal((await rpc('eth_getTransactionReceipt', [uncertain.hash])).status, '0x1');
  walletService.market.rpc = networkRpc;
  await host.close();
  host = null;
  const restored = new (require('../../src/main/services/wallet').WalletService)({
    directory: path.join(profile, 'wallet'),
  });
  try {
    assert.equal(restored.isUnlocked(wallet.id), false);
    const read = await restored.request('history');
    assert.ok(read.items.some((item) => item.hash === records[0].hash));
    assert.ok(read.items.some((item) => item.hash === uncertain.hash));
    assert.equal(read.items.find((item) => item.id === fenced.id).submissionMayHaveOccurred, false);
  } finally {
    restored.dispose();
  }
  console.log(
    '[quant-local-chain] PASS: encrypted signer, real transfer and custom contract call, read-only simulation, paged reads, Agent Goal, stable retries, authority revocation before/after real dispatch and restart recovery',
  );
}
main()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    global.fetch = originalFetch;
    if (host) await host.close();
    if (modelServer?.listening) {
      modelServer.closeAllConnections();
      await new Promise((resolve) => modelServer.close(resolve));
    }
    if (chain && chain.exitCode === null) {
      chain.kill();
      await Promise.race([new Promise((resolve) => chain.once('exit', resolve)), pause(2000)]);
    }
    if (
      path.dirname(profile) !== path.resolve(os.tmpdir()) ||
      !path.basename(profile).startsWith('cibyp-quant-chain-')
    )
      throw Error('Unsafe fixture path');
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  });
