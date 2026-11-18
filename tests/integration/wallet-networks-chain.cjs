/* SPDX-License-Identifier: GPL-3.0-or-later */
// All writes target an isolated local Anvil chain (1337), never a public chain.
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const { Interface, parseEther } = require('ethers');
const root = path.resolve(__dirname, '../..'),
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-network-chain-'));
const fixture = require('../fixtures/quant/ExecutionFixture.json'),
  token = new Interface(fixture.contracts.Token.abi);
let chain, host, endpoint;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params = []) {
  const body = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  if (body.error) throw Error('Local RPC ' + body.error.code);
  return body.result;
}
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await pause(60);
  }
  throw Error('Local network test timed out');
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
  const server = net.createServer();
  await new Promise((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  endpoint = 'http://127.0.0.1:' + port;
  const binary =
    process.env.CIBYP_TEST_ANVIL || (await require('../../scripts/test-quant-chain.cjs').prepare());
  chain = spawn(
    binary,
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1337', '--silent'],
    { stdio: 'ignore', windowsHide: true, cwd: profile },
  );
  chain.on('error', () => {});
  await until(async () => {
    if (chain.exitCode !== null) throw Error('Local Anvil exited');
    try {
      return (await rpc('eth_chainId')) === '0x539';
    } catch {
      return false;
    }
  });
  await open();
  const input = {
    id: 1337,
    name: 'Isolated local EVM',
    nativeSymbol: 'TEST',
    nativeDecimals: 18,
    rpc: endpoint,
    additionalFeeNative: '0.000001',
  };
  const review = await call('network.challenge', input),
    network = await call('network.confirm', {
      challengeId: review.id,
      ack: 'SAVE NETWORK',
      confirmed: true,
    });
  assert.equal(network.capabilities.signType2, true);
  assert.equal(network.capabilities.autonomous, true);
  const wallet = await call('import', {
    name: 'Public isolated fixture',
    kind: 'privateKey',
    secret: '0x' + '01'.padStart(64, '0'),
    password: 'public-local-network-test-password',
  });
  await call('unlock', {
    id: wallet.id,
    password: 'public-local-network-test-password',
    minutes: 0,
  });
  const [funded, recipient] = await rpc('eth_accounts');
  const funding = await rpc('eth_sendTransaction', [
    { from: funded, to: wallet.address, value: '0x' + parseEther('0.1').toString(16) },
  ]);
  await until(() => rpc('eth_getTransactionReceipt', [funding]));
  const before = BigInt(await rpc('eth_getBalance', [recipient, 'latest']));
  const proposal = await call('transaction.prepare', {
    id: wallet.id,
    chain: network.key,
    to: recipient,
    value: '0.01',
  });
  assert.equal(proposal.status, 'approval-required');
  assert.equal(BigInt(await rpc('eth_getBalance', [recipient, 'latest'])), before);
  const sent = await call('intent.approve', { id: proposal.id, digest: proposal.digest });
  assert.equal(sent.status, 'submitted');
  const receipt = await until(() => rpc('eth_getTransactionReceipt', [sent.hash]));
  assert.equal(receipt.status, '0x1');
  const tx = await rpc('eth_getTransactionByHash', [sent.hash]);
  assert.equal(tx.chainId, '0x539');
  assert.equal(tx.type, '0x2');
  assert.equal(
    BigInt(await rpc('eth_getBalance', [recipient, 'latest'])) - before,
    parseEther('0.01'),
  );
  assert.ok(
    ['included', 'safe', 'finalized'].includes(
      (await call('intent.reconcile', { id: sent.id })).status,
    ),
  );
  const contract = '0x' + '3'.repeat(40),
    code = fixture.contracts.Token;
  assert.equal(
    require('node:crypto')
      .createHash('sha256')
      .update(Buffer.from(code.runtime.slice(2), 'hex'))
      .digest('hex'),
    code.sha256,
  );
  await rpc('anvil_setCode', [contract, code.runtime]);
  const minted = await rpc('eth_sendTransaction', [
    {
      from: funded,
      to: contract,
      data: token.encodeFunctionData('mint', [wallet.address, 1000000n]),
      gas: '0x100000',
    },
  ]);
  await until(() => rpc('eth_getTransactionReceipt', [minted]));
  await call('asset.track', { id: wallet.id, chain: network.key, token: contract });
  const assets = await call('assets', { id: wallet.id, chain: network.key });
  assert.equal(assets.assets.length, 2);
  assert.equal(assets.assets[0].symbol, 'TEST');
  assert.equal(assets.assets[1].amountAtomic, '1000000');
  const transfer = await call('transaction.prepare', {
    id: wallet.id,
    chain: network.key,
    to: contract,
    value: '0',
    data: token.encodeFunctionData('transfer', [recipient, 500000n]),
  });
  const transferred = await call('intent.approve', { id: transfer.id, digest: transfer.digest });
  assert.equal(
    (await until(() => rpc('eth_getTransactionReceipt', [transferred.hash]))).status,
    '0x1',
  );
  const recipientTokens = await rpc('eth_call', [
    { to: contract, data: token.encodeFunctionData('balanceOf', [recipient]) },
    'latest',
  ]);
  assert.equal(token.decodeFunctionResult('balanceOf', recipientTokens)[0], 500000n);
  const scan = { id: wallet.id, chain: network.key };
  const walletNonce = await rpc('eth_getTransactionCount', [wallet.address, 'latest']);
  await rpc('anvil_mine', ['0x41', '0x0']);
  await call('asset.untrack', { ...scan, token: contract });
  const discovery = await call('asset.discover', scan);
  assert.equal(discovery.chainId, 1337);
  assert.equal(discovery.total, 1);
  assert.equal(discovery.items[0].token.toLowerCase(), contract);
  assert.equal(discovery.items[0].sent, 1);
  assert.equal(discovery.items[0].amountAtomic, '500000');
  assert.equal(discovery.items[0].tracked, false);
  assert.equal(discovery.items[0].transactionHash, transferred.hash);
  assert.equal((await call('assets', scan)).trackedTokens.length, 0);
  await call('asset.track', {
    ...scan,
    token: contract,
    expectedNetworkRevision: discovery.networkRevision,
  });
  assert.equal((await call('assets', scan)).assets[1].amountAtomic, '500000');
  assert.equal(await rpc('eth_getTransactionCount', [wallet.address, 'latest']), walletNonce);
  const project = await host.dispatch({
    method: 'quant:request',
    args: ['workspace.create', { name: 'Registered EVM Agent fixture', venue: 'base' }],
  });
  const quant = host.runtime.quantService;
  const { rootContext, deriveChild } = require('../../src/main/services/wallet/agent-scopes');
  const parent = deriveChild(rootContext(project.id, undefined, [1337]), 'network-parent', {
    chains: [1337],
    walletIds: [wallet.id],
    limits: { maxTransactions: 2 },
  });
  function agent(context) {
    const a = {
      stopped: false,
      executeTool: async () => {
        throw Error('Unscoped fallback');
      },
      stop() {},
      sendMessage: async () => {},
      loadFromHistory: async () => {},
      _withGoalToolSchemas: (value) => value,
      getGoalSnapshot: () => null,
      getGoalSteeringSection: () => '',
      saveToHistory: async () => {},
      host: { api: { historySave: async () => {} } },
    };
    require('../../src/main/services/quant/agent-tools').decorateQuantTools(
      a,
      () => quant,
      project.id,
      { agentContext: context, isSubagent: true },
    );
    return a;
  }
  const nativeAgent = agent(
    deriveChild(parent, 'network-native', { limits: { maxTransactions: 1 } }),
  );
  const observed = await nativeAgent.executeTool('quant_base_inspect', {
    chainId: 1337,
    assets: true,
    address: wallet.address,
    tokens: [contract],
  });
  assert.equal(observed.chainId, 1337);
  assert.equal(observed.assets[1].amountAtomic, '500000');
  const incoming = await nativeAgent.executeTool('quant_base_inspect', {
    chainId: 1337,
    address: recipient,
    discoverAssets: true,
  });
  assert.equal(incoming.items[0].received, 1);
  assert.equal(incoming.items[0].amountAtomic, '500000');
  const list = await nativeAgent.executeTool('quant_wallets');
  assert.equal(list.networks.find((n) => n.id === 1337).rpc, undefined);
  assert.equal(list.networks.find((n) => n.id === 1337).capabilities.autonomous, true);
  const createPortfolio = await call('portfolio.challenge', {
    operation: 'create',
    name: 'Custom EVM shared budget',
    chainId: 1337,
    walletIds: [wallet.id],
    limits: { maxTransactions: 2, maxTotalValueEth: '0.001' },
  });
  const portfolio = await call('portfolio.confirm', {
    challengeId: createPortfolio.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  async function grant(limits) {
    const review = await call('policy.challenge', { id: wallet.id, chains: [1337], limits });
    assert.deepEqual(review.networkRevisions, { 'evm-1337': 1 });
    return call('policy.grant', { challengeId: review.id, ack: 'ALLOW LIVE', confirmed: true });
  }
  await grant({
    maxTransactions: 1,
    maxValueEth: '0.001',
    maxTotalValueEth: '0.001',
    allowCalldata: false,
    targets: [recipient],
  });
  const nativeRequest = {
    walletId: wallet.id,
    chainId: 1337,
    operationId: 'native-one',
    to: recipient,
    value: '0.001',
  };
  const automatic = await nativeAgent.executeTool('quant_live_transaction', nativeRequest, {
    callId: 'one',
  });
  assert.equal(automatic.status, 'submitted', automatic.error);
  await until(() => rpc('eth_getTransactionReceipt', [automatic.hash]));
  await call('intent.reconcile', { id: automatic.id });
  assert.equal(
    (await nativeAgent.executeTool('quant_live_transaction', nativeRequest, { callId: 'retry' }))
      .id,
    automatic.id,
  );
  const rules = {
    maxTransactions: 3,
    targets: [contract],
    selectors: ['0xa9059cbb'],
    tokens: [
      {
        chainId: 1337,
        address: contract,
        symbol: 'TEST TOKEN',
        decimals: 6,
        maxAmount: '0.1',
        maxSignedAmount: '0.2',
        allowApprovals: false,
        recipients: [recipient],
      },
    ],
  };
  await grant(rules);
  const tokenAgent = agent(deriveChild(parent, 'network-token'));
  const encoded = await tokenAgent.executeTool('quant_contract', {
    chainId: 1337,
    action: 'encode',
    to: contract,
    abi: ['function transfer(address,uint256) returns(bool)'],
    function: 'transfer',
    args: [recipient, '100000'],
  });
  assert.equal(encoded.chainId, 1337);
  const sentToken = await tokenAgent.executeTool('quant_live_transaction', {
    walletId: wallet.id,
    chainId: 1337,
    operationId: 'token-one',
    callId: encoded.callId,
  });
  assert.equal(sentToken.status, 'submitted', sentToken.error);
  await until(() => rpc('eth_getTransactionReceipt', [sentToken.hash]));
  await call('intent.reconcile', { id: sentToken.id });
  const decodedBalance = await tokenAgent.executeTool('quant_contract', {
    chainId: 1337,
    action: 'read',
    to: contract,
    abi: ['function balanceOf(address) view returns(uint256)'],
    function: 'balanceOf',
    args: [recipient],
  });
  assert.deepEqual(JSON.parse(decodedBalance.text), ['600000']);
  const shared = await call('portfolio.get', { id: portfolio.portfolio.id });
  assert.equal(shared.usage.transactions, 2);
  const scope = await host.runtime.walletService.agentScopes.ensure(parent, 1337);
  assert.equal(scope.snapshot.usage.transactions, 2);
  const excess = await tokenAgent.executeTool('quant_live_transaction', {
    walletId: wallet.id,
    chainId: 1337,
    operationId: 'excess-token',
    callId: encoded.callId,
  });
  assert.equal(excess.status, 'signing-unknown', excess.error);
  assert.match(excess.error, /LIMIT/);
  const absent = await call('intent.reconcile', { id: excess.id });
  assert.equal(absent.nativeSignatureAbsent, true);
  assert.equal(absent.submissionMayHaveOccurred, false);
  assert.equal((await call('portfolio.get', { id: portfolio.portfolio.id })).usage.transactions, 2);
  const holdings = await call('portfolio.holdings', { id: portfolio.portfolio.id });
  assert.equal(holdings.chainId, 1337);
  assert.equal(holdings.assets[0].symbol, 'TEST');
  const stale = await call('transaction.prepare', {
    id: wallet.id,
    chain: network.key,
    to: recipient,
    value: '0.001',
  });
  const edit = await call('network.challenge', {
    ...input,
    name: 'Reviewed node update',
    revision: network.revision,
  });
  const edited = await call('network.confirm', {
    challengeId: edit.id,
    ack: 'SAVE NETWORK',
    confirmed: true,
  });
  assert.equal((await call('intent.inspect', { id: stale.id })).networkBlocked, true);
  assert.equal(
    host.runtime.walletService.policy(host.runtime.walletService.wallet(wallet.id), network.key),
    null,
  );
  await assert.rejects(
    call('intent.approve', { id: stale.id, digest: stale.digest }),
    /WALLET_NETWORK_CHANGED/,
  );
  await call('network.archive', { key: network.key, revision: edited.revision });
  assert.ok(
    ['included', 'safe', 'finalized'].includes(
      (await call('intent.reconcile', { id: transferred.id })).status,
    ),
  );
  await host.close();
  host = null;
  await open();
  const archivedRead = await host.dispatch({
    method: 'quant:request',
    args: ['contract', { id: project.id, action: 'result', ref: decodedBalance.ref, maxChars: 0 }],
  });
  assert.equal(archivedRead.text, '["600000"]');
  assert.equal(archivedRead.blockHash, decodedBalance.blockHash);
  assert.equal(
    (await call('network.list')).items.find((p) => p.key === network.key).archived,
    true,
  );
  assert.equal((await call('list')).wallets[0].unlocked, false);
  assert.equal(
    (await call('assets', { id: wallet.id, chain: network.key })).assets[1].amountAtomic,
    '400000',
  );
  await assert.rejects(
    call('transaction.prepare', {
      id: wallet.id,
      chain: network.key,
      to: recipient,
      value: '0.001',
    }),
    /WALLET_CHAIN_UNAVAILABLE/,
  );
  console.log(
    'PASS: isolated chain 1337, manual and human-granted autonomous native/ERC-20 transfers through actual Agent tools, inherited/portfolio budgets, stable operation retry, ABI read/encode, revision fencing, archived read-only recovery and locked restart; ' +
      (process.env.CIBYP_TEST_NODE_BACKEND ? 'bundled' : 'source') +
      ' backend.',
  );
}
main()
  .catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (host) await host.close();
    if (chain && chain.exitCode === null) {
      chain.kill();
      await Promise.race([new Promise((r) => chain.once('exit', r)), pause(2000)]);
    }
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profile).startsWith('cibyp-network-chain-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
