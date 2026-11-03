/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Actual native scheduler -> encrypted signer -> local EVM contract transfers.
// Fixture contracts are synthetic, not Uniswap or a mainnet/fork deployment.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createHash } = require('node:crypto'),
  { spawn } = require('node:child_process'),
  net = require('node:net');
const { Interface, Transaction } = require('ethers');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { deployments } = require('../../src/main/services/quant/base-swap');
const root = path.resolve(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-live-execution-'));
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/quant/ExecutionFixture.json'), 'utf8'),
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(
  sha(fs.readFileSync(path.join(root, 'tests/fixtures/quant/ExecutionFixture.sol'))),
  fixture.sourceSha256,
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let chain,
  host,
  endpoint,
  project,
  wallet,
  logs = '';
const rpc = async (method, params = []) => {
  const body = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json());
  if (body.error) throw Error(JSON.stringify(body.error));
  return body.result;
};
const call = (action, input = {}) =>
  host.dispatch({ method: 'quant:request', args: [action, input] });
const walletCall = (action, input = {}) =>
  host.dispatch({ method: 'wallet:request', args: [action, input] });
async function until(check, { mine = false } = {}) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    if (mine) await rpc('anvil_mine', ['0x4', '0x0']);
    await pause(100);
  }
  throw Error('Live execution condition timed out: ' + logs);
}
async function grant() {
  const challenge = await walletCall('policy.challenge', {
    id: wallet.id,
    chains: [8453],
    limits: {
      tokens: [
        {
          chainId: 8453,
          address: CHAINS.base.usdc,
          symbol: 'USDC',
          decimals: 6,
          maxAmount: '10',
          maxSignedAmount: '100',
          maxApprovalAmount: '10',
          recipients: [wallet.address],
          spenders: [deployments.base.router],
        },
        {
          chainId: 8453,
          address: CHAINS.base.weth,
          symbol: 'WETH',
          decimals: 18,
          maxAmount: '1',
          maxSignedAmount: '10',
          maxApprovalAmount: '1',
          recipients: [wallet.address],
          spenders: [deployments.base.router],
        },
      ],
    },
  });
  await walletCall('policy.grant', {
    challengeId: challenge.id,
    ack: 'ALLOW LIVE',
    confirmed: true,
  });
}
async function create(operationId, extra = {}, agentContext) {
  const input = {
    id: project.id,
    operationId,
    walletId: wallet.id,
    side: 'buy',
    totalInput: '2.5',
    slices: 2,
    intervalMs: 1000,
    maxEstimatedFeeEth: '0.01',
    ...extra,
  };
  return agentContext
    ? host.runtime.quantService.request('execution.create', input, { agentContext })
    : call('execution.create', input);
}
const inspect = (runId) => call('execution.get', { id: project.id, runId });
const token = new Interface(fixture.contracts.Token.abi),
  router = new Interface(fixture.contracts.Router.abi);
const balance = async (to, address) =>
  BigInt(
    token.decodeFunctionResult(
      'balanceOf',
      await rpc('eth_call', [
        { to, data: token.encodeFunctionData('balanceOf', [address]) },
        'latest',
      ]),
    )[0],
  );
const executed = async () =>
  BigInt(
    router.decodeFunctionResult(
      'executed',
      await rpc('eth_call', [
        { to: deployments.base.router, data: router.encodeFunctionData('executed') },
        'latest',
      ]),
    )[0],
  );
async function main() {
  const anvil = process.env.CIBYP_TEST_ANVIL;
  assert.ok(anvil && fs.existsSync(anvil));
  const listener = net.createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  endpoint = 'http://127.0.0.1:' + port;
  chain = spawn(
    anvil,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      '8453',
      '--slots-in-an-epoch',
      '1',
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  chain.stderr.on('data', (bytes) => {
    logs = (logs + bytes).slice(-1000);
  });
  await until(async () => {
    try {
      return await rpc('eth_chainId');
    } catch {
      return false;
    }
  });
  const chainInfo = CHAINS.base,
    addresses = {
      Token: [chainInfo.usdc, chainInfo.weth],
      Factory: [chainInfo.factory],
      Pool: ['0x1111111111111111111111111111111111111111'],
      Quoter: [deployments.base.quoter],
      Router: [deployments.base.router],
    };
  for (const [name, targets] of Object.entries(addresses)) {
    const contract = fixture.contracts[name];
    assert.equal(sha(Buffer.from(contract.runtime.slice(2), 'hex')), contract.sha256);
    for (const address of targets) await rpc('anvil_setCode', [address, contract.runtime]);
  }
  await rpc('anvil_setCode', [
    '0x420000000000000000000000000000000000000f',
    '0x600060005260206000f3',
  ]);
  process.env.CIBYP_QUANT_ENGINE_BIN =
    process.env.CIBYP_QUANT_TEST_BINARY ||
    require('../../src/main/services/quant/native-binary').developmentBinary(root);
  const entry = process.env.CIBYP_TEST_NODE_BACKEND || require.resolve('../../src/agent/node-host');
  host = await require(entry).createNodeRuntime({
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
  wallet = await walletCall('create', {
    name: 'Local execution fixture',
    password: 'local-execution-fixture-password',
  });
  await rpc('anvil_setBalance', [wallet.address, '0x8ac7230489e80000']);
  await walletCall('unlock', {
    id: wallet.id,
    password: 'local-execution-fixture-password',
    minutes: 0,
  });
  const secondWallet = await walletCall('create', {
    name: 'Second local fixture wallet',
    password: 'second-local-fixture-password',
  });
  const portfolioChallenge = await walletCall('portfolio.challenge', {
    operation: 'create',
    name: 'Shared local-chain budget',
    chainId: 8453,
    walletIds: [wallet.id, secondWallet.id],
    limits: { maxTotalValueEth: '0.05', maxTotalFeeEth: '0.5', maxTransactions: 64 },
  });
  const portfolio = await walletCall('portfolio.confirm', {
    challengeId: portfolioChallenge.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  await rpc('anvil_setBalance', [secondWallet.address, '0x8ac7230489e80000']);
  await walletCall('unlock', {
    id: secondWallet.id,
    password: 'second-local-fixture-password',
    minutes: 0,
  });
  const secondary = await host.runtime.walletService.prepare(
    { venue: 'base', rpcUrl: endpoint },
    {
      walletId: secondWallet.id,
      commandId: 'cross-wallet-signature',
      to: wallet.address,
      value: '0.001',
    },
  );
  const secondarySent = await walletCall('intent.approve', {
    id: secondary.id,
    digest: secondary.digest,
  });
  assert.ok(secondarySent.hash);
  await until(async () => !!(await rpc('eth_getTransactionReceipt', [secondarySent.hash])));
  assert.equal(
    (await walletCall('portfolio.get', { id: portfolio.portfolio.id })).usage.transactions,
    1,
  );
  await grant();
  const [funded] = await rpc('eth_accounts');
  for (const [address, to, amount] of [
    [chainInfo.usdc, wallet.address, 10000000000n],
    [chainInfo.weth, deployments.base.router, 10n ** 19n],
  ]) {
    const mintHash = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to: address,
        data: token.encodeFunctionData('mint', [to, amount]),
        gas: '0x100000',
      },
    ]);
    await until(async () => {
      const receipt = await rpc('eth_getTransactionReceipt', [mintHash]);
      if (!receipt) return false;
      assert.equal(receipt.status, '0x1');
      return true;
    });
  }
  project = await call('workspace.create', { name: 'Local continuous execution', venue: 'base' });
  await call('workspace.update', { id: project.id, market: { rpcUrl: endpoint } });
  const { rootContext, deriveChild } = require('../../src/main/services/wallet/agent-scopes');
  const delegated = deriveChild(rootContext(project.id), 'native-sub-local-chain', {
    walletIds: [wallet.id],
    chains: [8453],
    limits: { maxTransactions: 4 },
  });
  const before = await balance(chainInfo.usdc, wallet.address),
    run = await create('two-slices', {}, delegated);
  assert.equal(run.plan.agent_scope.subject, 'native-sub-local-chain');
  await call('execution.start', { id: project.id, runId: run.plan.id });
  await until(async () => (await inspect(run.plan.id)).run.phase === 'completed', { mine: true });
  assert.equal(await balance(chainInfo.usdc, wallet.address), before - 2500000n);
  assert.equal(await balance(chainInfo.weth, wallet.address), 1250000000000000n);
  assert.equal(await executed(), 2n);
  const history = await call('execution.commands', { id: project.id, runId: run.plan.id });
  assert.equal(history.total, 2);
  assert.ok(history.items.every((i) => i.stage === 'finalized'));
  const usage = await inspect(run.plan.id);
  assert.ok(BigInt(usage.feeUsage.reservedEstimateWei) > 0n);
  assert.equal(usage.feeUsage.chainEnforced, false);
  const walletService = host.runtime.walletService;
  const records = walletService.state.intents.filter((i) => i.execution?.planId === run.plan.id);
  assert.equal(records.length, 4);
  assert.ok(records.every((i) => i.status === 'finalized'));
  assert.equal(new Set(records.map((i) => i.hash)).size, 4);
  assert.ok(records.every((i) => i.agentScope.id === run.plan.agent_scope.id));
  const delegatedUsage = await walletCall('scope.get', { id: run.plan.agent_scope.id });
  assert.equal(delegatedUsage.usage.transactions, 4);
  assert.equal(
    (await walletCall('scope.get', { id: delegatedUsage.path[1] })).usage.transactions,
    4,
  );
  const nativeUsage = await walletCall('policy.usage', { id: wallet.id });
  const tokenUsage = nativeUsage.usage.tokens['eip155:8453/erc20:' + chainInfo.usdc];
  assert.equal(tokenUsage.transferAtoms, '2500000');
  assert.equal(tokenUsage.approvalAtoms, '2500000');
  assert.equal(nativeUsage.usage.transactions, 4);
  const portfolioUsage = await walletCall('portfolio.get', { id: portfolio.portfolio.id });
  assert.equal(portfolioUsage.usage.transactions, 5);
  assert.equal(portfolioUsage.usage.valueWei, '1000000000000000');
  assert.ok(BigInt(portfolioUsage.usage.feeWei) > BigInt(nativeUsage.usage.feeWei));
  const nonce = BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest']));
  await call('execution.start', { id: project.id, runId: run.plan.id }).then(
    () => assert.fail('completed run cannot restart'),
    () => {},
  );
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), nonce);
  for (const kind of ['stop', 'revoke', 'pause', 'config', 'emergency']) {
    const next = await create('during-signature-' + kind, { slices: 1, totalInput: '1' });
    const signer = walletService.signer.bind(walletService);
    let release, ready;
    const held = new Promise((r) => {
        ready = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    walletService.signer = async (action, input) => {
      const result = await signer(action, input);
      if (action === 'sign' && input.transaction.to.toLowerCase() === deployments.base.router) {
        ready();
        await gate;
      }
      return result;
    };
    await call('execution.start', { id: project.id, runId: next.plan.id });
    await Promise.race([
      held,
      pause(15000).then(() => {
        throw Error('Swap signature was not reached');
      }),
    ]);
    const balanceBefore = await balance(chainInfo.usdc, wallet.address);
    if (kind === 'stop') await call('execution.stop', { id: project.id, runId: next.plan.id });
    else if (kind === 'pause') await call('native.control', { method: 'pause', params: {} });
    else if (kind === 'config')
      await call('workspace.update', { id: project.id, market: { poolFee: 3000 } });
    else if (kind === 'emergency') {
      const status = await walletCall('emergency.status');
      await walletCall('emergency.halt', { expectedGeneration: status.generation });
    } else {
      await walletCall('policy.revoke', { id: wallet.id });
      await grant();
    }
    release();
    walletService.signer = signer;
    await until(
      async () => {
        const current = await inspect(next.plan.id);
        return !current.run.pending && ['stopped', 'paused'].includes(current.run.phase);
      },
      { mine: true },
    );
    assert.equal(await balance(chainInfo.usdc, wallet.address), balanceBefore);
    assert.equal(await executed(), 2n);
    const commands = await call('execution.commands', { id: project.id, runId: next.plan.id });
    assert.ok(['aborted', 'unsent'].includes(commands.items[0].stage));
    if (kind === 'config')
      await call('workspace.update', { id: project.id, market: { poolFee: 500 } });
    if (kind === 'emergency') {
      assert.equal((await walletCall('emergency.status')).halted, true);
      const reset = await walletCall('emergency.challenge');
      await walletCall('emergency.reset', {
        challengeId: reset.id,
        ack: 'RESET LIVE',
        confirmed: true,
      });
      assert.equal(walletService.isUnlocked(wallet.id), false);
      assert.equal((await inspect(next.plan.id)).run.phase, 'paused');
      await walletCall('unlock', {
        id: wallet.id,
        password: 'local-execution-fixture-password',
        minutes: 0,
      });
      await grant();
    }
    // A usable signature may exist even though its broadcast was stopped.
    // The native ledger must retain that nonce. A fake human explicitly
    // confirms a zero-value self replacement before this fixture starts the
    // next independent plan; no autonomous plan may silently recycle it.
    const replacement = await walletService.prepare(
      { venue: 'base', rpcUrl: endpoint },
      {
        walletId: wallet.id,
        commandId: 'human-resolves-signed-nonce-' + kind,
        to: wallet.address,
        value: '0',
      },
      { actor: 'frontend' },
    );
    assert.match(replacement.replacementOf, /^0x[a-f0-9]{64}$/);
    await assert.rejects(
      walletCall('intent.approve', { id: replacement.id, digest: replacement.digest }),
      /NONCE_CONFIRMATION/,
    );
    const resolved = await walletCall('intent.approve', {
      id: replacement.id,
      digest: replacement.digest,
      replacementOf: replacement.replacementOf,
    });
    assert.equal(resolved.status, 'submitted');
    await until(async () => (await walletService.reconcile(resolved.id)).status === 'finalized', {
      mine: true,
    });
  }
  const feeNonce = BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest']));
  const feeLimited = await create('estimated-fee-budget', {
    slices: 1,
    totalInput: '2.5',
    maxEstimatedFeeEth: '0.000000000000000001',
  });
  await call('execution.start', { id: project.id, runId: feeLimited.plan.id });
  await until(async () => (await inspect(feeLimited.plan.id)).run.phase === 'paused');
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), feeNonce);
  assert.equal((await inspect(feeLimited.plan.id)).lastError, 'WALLET_EXECUTION_FEE_BUDGET');
  const unknown = await create('unknown-acknowledgement', { slices: 1, totalInput: '1' });
  const originalRpc = walletService.market.rpc.bind(walletService.market),
    originalReconcile = walletService.reconcile.bind(walletService);
  let hidden = false,
    offline = true,
    dispatches = 0;
  walletService.market.rpc = async (...args) => {
    const result = await originalRpc(...args);
    if (
      args[2] === 'eth_sendRawTransaction' &&
      Transaction.from(args[3][0]).to.toLowerCase() === deployments.base.router
    ) {
      dispatches++;
      hidden = true;
      throw Error('fixture hides actual accepted swap acknowledgement');
    }
    return result;
  };
  walletService.reconcile = async (id, ...args) => {
    if (
      offline &&
      hidden &&
      walletService.state.intents.find((i) => i.id === id)?.commandId.endsWith(':swap')
    )
      throw Error('FIXTURE_RPC_OFFLINE');
    return originalReconcile(id, ...args);
  };
  await call('execution.start', { id: project.id, runId: unknown.plan.id });
  await until(async () => hidden && (await inspect(unknown.plan.id)).run.phase === 'paused');
  assert.equal(dispatches, 1);
  assert.equal(await executed(), 3n);
  const uncertainCommands = await call('execution.commands', {
    id: project.id,
    runId: unknown.plan.id,
  });
  assert.equal(uncertainCommands.items[0].stage, 'uncertain');
  const liveSafety = await walletCall('emergency.status');
  await walletCall('emergency.halt', { expectedGeneration: liveSafety.generation });
  await call('execution.start', { id: project.id, runId: unknown.plan.id }).then(
    () => assert.fail('unknown outcome cannot resume'),
    () => {},
  );
  const nativeChild = host.runtime.quantService.native.child;
  const nativeExited = nativeChild
    ? new Promise((resolve) => nativeChild.once('exit', resolve))
    : Promise.resolve();
  await host.close();
  await nativeExited;
  host = null;
  host = await require(entry).createNodeRuntime({
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
  assert.equal((await inspect(unknown.plan.id)).run.phase, 'paused');
  assert.equal((await walletCall('emergency.status')).halted, true);
  assert.equal(host.runtime.walletService.isUnlocked(wallet.id), false);
  await assert.rejects(
    call('execution.start', { id: project.id, runId: unknown.plan.id }),
    /WALLET_LOCKED/,
  );
  offline = false;
  await until(
    async () => {
      await call('execution.reconcile', { id: project.id, runId: unknown.plan.id });
      return (await inspect(unknown.plan.id)).run.phase === 'completed';
    },
    { mine: true },
  );
  assert.equal(await executed(), 3n);
  assert.equal(dispatches, 1);
  assert.equal(
    (await call('execution.commands', { id: project.id, runId: unknown.plan.id })).total,
    1,
  );
  assert.equal(host.runtime.quantService.liveExecution.active.size, 0);
  const restoredPortfolio = await walletCall('portfolio.get', { id: portfolio.portfolio.id });
  assert.ok(restoredPortfolio.usage.transactions >= 5);
  assert.equal(restoredPortfolio.usage.valueWei, '1000000000000000');
  console.log(
    '[quant-live-execution] PASS: native scheduling, actual two-wallet portfolio budget shared across manual ETH and planned token signatures, real encrypted signer with token/recipient/spender budgets, actual approval/token transfers and durable usage, finality, stop/revoke/global pause/config/emergency changes during signature, durable global stop with human-only reset and no restart, lost acknowledgement and stopped/locked-wallet restart reconciliation, estimated fee budget',
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
    assert.ok(path.basename(profile).startsWith('cibyp-live-execution-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
