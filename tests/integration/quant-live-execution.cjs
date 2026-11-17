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
const { Interface, MaxUint256, Transaction, toBeHex } = require('ethers');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { deployments, routerAbi } = require('../../src/main/services/quant/base-swap');
const { PERMIT2, permit2 } = require('../../src/main/services/quant/permit2');
const { BASE_FEEDS } = require('../../src/main/services/quant/portfolio-valuation');
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
async function verifyAllowance(chainInfo) {
  const spender = '0x3333333333333333333333333333333333333333';
  const params = { id: wallet.id, chain: 'base', token: chainInfo.usdc, spender };
  // Model an existing allowance established outside CIBYP.
  await rpc('anvil_impersonateAccount', [wallet.address]);
  let allowanceHash;
  try {
    allowanceHash = await rpc('eth_sendTransaction', [
      {
        from: wallet.address,
        to: chainInfo.usdc,
        data: token.encodeFunctionData('approve', [spender, 2500000n]),
        gas: '0x100000',
      },
    ]);
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [wallet.address]);
  }
  await until(
    async () => (await rpc('eth_getTransactionReceipt', [allowanceHash]))?.status === '0x1',
  );
  const market = host.runtime.walletService.market;
  const originalRpc = market.rpc;
  market.rpc = (venue, _url, method, args, options) =>
    originalRpc.call(market, venue, endpoint, method, args, options);
  try {
    const observation = await walletCall('allowance.inspect', params);
    assert.equal(observation.amountAtomic, '2500000');
    assert.equal(observation.amount, '2.5');
    assert.equal(observation.symbol, 'USDC');
    assert.match(observation.blockHash, /^0x[a-f0-9]{64}$/);
    const discovered = await walletCall('allowance.discover', {
      id: wallet.id,
      chain: 'base',
      blocks: 10,
    });
    assert.equal(discovered.total, 1);
    assert.equal(discovered.items[0].transactionHash, allowanceHash);
    assert.equal(discovered.items[0].token.toLowerCase(), chainInfo.usdc);
    assert.equal(discovered.items[0].spender, spender);
    assert.equal(discovered.items[0].eventAmountAtomic, '2500000');
    const prepare = { ...params, commandId: observation.commandId };
    const readRpc = market.rpc;
    market.rpc = (...args) =>
      args[2] === 'eth_call' && args[3]?.[0]?.data?.startsWith('0x095ea7b3')
        ? Promise.resolve('0x' + '0'.repeat(64))
        : readRpc(...args);
    try {
      await assert.rejects(
        walletCall('allowance.revoke.prepare', prepare),
        /WALLET_ALLOWANCE_SIMULATION_FAILED/,
      );
    } finally {
      market.rpc = readRpc;
    }
    const intent = await walletCall('allowance.revoke.prepare', prepare);
    assert.equal(intent.status, 'approval-required');
    assert.equal(intent.authorization.mode, 'manual');
    assert.equal(intent.transaction.value, '0');
    assert.equal(intent.transaction.data, token.encodeFunctionData('approve', [spender, 0n]));
    assert.equal((await walletCall('allowance.revoke.prepare', prepare)).id, intent.id);
    assert.equal((await walletCall('allowance.inspect', params)).amountAtomic, '2500000');
    const sent = await walletCall('intent.approve', { id: intent.id, digest: intent.digest });
    assert.ok(sent.hash);
    await until(
      async () => (await walletCall('intent.reconcile', { id: intent.id })).status === 'finalized',
      { mine: true },
    );
    assert.equal((await walletCall('allowance.inspect', params)).amountAtomic, '0');
    const after = await walletCall('allowance.discover', {
      id: wallet.id,
      chain: 'base',
      blocks: 10,
    });
    assert.equal(after.total, 1);
    assert.equal(after.items[0].transactionHash, sent.hash);
    assert.equal(after.items[0].eventAmountAtomic, '0');
    assert.equal((await walletCall('allowance.revoke.prepare', prepare)).id, intent.id);
  } finally {
    market.rpc = originalRpc;
  }
  return spender;
}
async function verifyPermit2(chainInfo) {
  const testWallet = await walletCall('create', {
    name: 'Permit2 fixture wallet',
    password: 'local-permit2-fixture-password',
  });
  const spender = '0x3333333333333333333333333333333333333333';
  const expiredSpender = '0x4444444444444444444444444444444444444444';
  const params = {
    id: testWallet.id,
    chain: 'base',
    token: chainInfo.usdc,
    spender,
    protocol: 'permit2',
  };
  const fixtureAbi = new Interface(fixture.contracts.Permit2Fixture.abi);
  await rpc('anvil_setBalance', [testWallet.address, '0x8ac7230489e80000']);
  const time = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
  await rpc('anvil_impersonateAccount', [testWallet.address]);
  try {
    for (const [to, data] of [
      [chainInfo.usdc, token.encodeFunctionData('approve', [PERMIT2, 1500000n])],
      [
        PERMIT2,
        fixtureAbi.encodeFunctionData('approve', [
          chainInfo.usdc,
          expiredSpender,
          500000n,
          time - 1n,
        ]),
      ],
      [
        PERMIT2,
        fixtureAbi.encodeFunctionData('recordPermit', [
          chainInfo.usdc,
          spender,
          2500000n,
          time + 3600n,
          6n,
        ]),
      ],
    ]) {
      const hash = await rpc('eth_sendTransaction', [
        { from: testWallet.address, to, data, gas: '0x100000' },
      ]);
      await until(async () => (await rpc('eth_getTransactionReceipt', [hash]))?.status === '0x1');
    }
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [testWallet.address]);
  }
  const service = host.runtime.walletService,
    market = service.market;
  const originalRpc = market.rpc;
  market.rpc = (venue, _url, method, args, options) =>
    originalRpc.call(market, venue, endpoint, method, args, options);
  try {
    const read = await walletCall('allowance.inspect', params);
    assert.equal(read.amount, '2.5');
    assert.equal(read.permit2.tokenAllowance, '1.5');
    assert.equal(read.permit2.effectiveAmount, '1.5');
    assert.equal(read.permit2.nonce, '7');
    const expired = await walletCall('allowance.inspect', { ...params, spender: expiredSpender });
    assert.equal(expired.permit2.expired, true);
    assert.equal(expired.permit2.effectiveAmountAtomic, '0');
    const scan = {
      id: testWallet.id,
      chain: 'base',
      token: chainInfo.usdc,
      protocol: 'permit2',
      blocks: 10,
    };
    const before = await walletCall('allowance.discover', scan);
    assert.deepEqual(
      before.items.map((item) => item.event),
      ['Permit', 'Approval'],
    );
    const prepare = { ...params, commandId: read.commandId };
    await assert.rejects(walletCall('allowance.revoke.prepare', prepare), /WALLET_LOCKED/);
    await walletCall('unlock', {
      id: testWallet.id,
      password: 'local-permit2-fixture-password',
      minutes: 0,
    });
    const localRpc = market.rpc;
    market.rpc = (...args) =>
      args[2] === 'eth_getCode' ? Promise.resolve('0x') : localRpc(...args);
    try {
      await assert.rejects(
        walletCall('allowance.revoke.prepare', prepare),
        /WALLET_ALLOWANCE_SIMULATION_FAILED/,
      );
    } finally {
      market.rpc = localRpc;
    }
    const intent = await walletCall('allowance.revoke.prepare', prepare);
    assert.equal(intent.authorization.mode, 'manual');
    assert.equal(intent.status, 'approval-required');
    assert.equal(intent.transaction.to, PERMIT2);
    assert.equal(
      intent.transaction.data,
      permit2.encodeFunctionData('lockdown', [[[chainInfo.usdc, spender]]]),
    );
    assert.equal(intent.description.kind, 'permit2-lockdown');
    const inspect = (transaction) =>
      service.signer('transaction.inspect', { id: testWallet.id, transaction });
    const native = await inspect(intent.transaction);
    assert.equal(native.adapter, 'uniswap-permit2');
    assert.deepEqual(
      native.effects.map(({ kind, token, amountAtoms, spender }) => ({
        kind,
        token,
        amountAtoms,
        spender,
      })),
      [{ kind: 'approval', token: chainInfo.usdc, amountAtoms: '0', spender }],
    );
    for (const transaction of [
      { ...intent.transaction, to: chainInfo.usdc },
      { ...intent.transaction, data: intent.transaction.data + '00' },
      { ...intent.transaction, value: '1' },
    ])
      assert.equal((await inspect(transaction)).classified, false);
    assert.equal((await walletCall('allowance.inspect', params)).amountAtomic, '2500000');
    const sent = await walletCall('intent.approve', { id: intent.id, digest: intent.digest });
    await until(
      async () => (await walletCall('intent.reconcile', { id: intent.id })).status === 'finalized',
      { mine: true },
    );
    const after = await walletCall('allowance.inspect', params);
    assert.equal(after.amountAtomic, '0');
    assert.equal(after.permit2.nonce, '7');
    assert.equal(after.permit2.expiration, read.permit2.expiration);
    assert.equal(after.permit2.tokenAllowanceAtomic, '1500000');
    const history = await walletCall('allowance.discover', scan);
    assert.equal(history.items[0].event, 'Lockdown');
    assert.equal(history.items[0].transactionHash, sent.hash);
    assert.equal(history.items[0].eventAmountAtomic, '0');
    const confirm = async (pending) => {
      assert.equal(pending.status, 'approval-required');
      assert.equal(pending.authorization.mode, 'manual');
      await walletCall('intent.approve', { id: pending.id, digest: pending.digest });
      await until(
        async () =>
          (await walletCall('intent.reconcile', { id: pending.id })).status === 'finalized',
        { mine: true },
      );
    };
    const orderedInput = {
      ...params,
      spender: expiredSpender,
      nonce: expired.permit2.nonce,
      commandId: expired.commandId + ':nonce',
    };
    await assert.rejects(
      walletCall('permit2.ordered.prepare', { ...orderedInput, nonce: '5' }),
      /WALLET_PERMIT2_NONCE_CHANGED/,
    );
    const ordered = await walletCall('permit2.ordered.prepare', orderedInput);
    assert.equal(ordered.description.kind, 'permit2-allowance-invalidate');
    assert.equal(ordered.description.nextNonce, '1');
    assert.equal((await inspect(ordered.transaction)).classified, true);
    await confirm(ordered);
    const orderedAfter = await walletCall('allowance.inspect', {
      ...params,
      spender: expiredSpender,
    });
    assert.equal(orderedAfter.permit2.nonce, '1');
    assert.equal(orderedAfter.amountAtomic, '500000');
    assert.equal(orderedAfter.permit2.expiration, expired.permit2.expiration);
    assert.equal(orderedAfter.permit2.tokenAllowanceAtomic, '1500000');
    const signatureInput = {
      id: testWallet.id,
      chain: 'base',
      nonce: '0x' + MaxUint256.toString(16),
    };
    const signatureRead = await walletCall('permit2.signature.inspect', signatureInput);
    assert.equal(signatureRead.nonce, String(MaxUint256));
    assert.equal(signatureRead.unavailable, false);
    const signaturePrepare = { ...signatureInput, commandId: signatureRead.commandId };
    const signature = await walletCall('permit2.signature.prepare', signaturePrepare);
    assert.equal(signature.description.kind, 'permit2-signature-invalidate');
    assert.equal(signature.description.permitNonce, String(MaxUint256));
    assert.equal((await inspect(signature.transaction)).adapter, 'uniswap-permit2-signature-nonce');
    const multiBit = permit2.encodeFunctionData('invalidateUnorderedNonces', [0, 3]);
    assert.equal((await inspect({ ...signature.transaction, data: multiBit })).classified, false);
    await confirm(signature);
    assert.equal((await walletCall('permit2.signature.inspect', signatureInput)).unavailable, true);
    assert.equal(
      (
        await walletCall('permit2.signature.inspect', {
          ...signatureInput,
          nonce: String(MaxUint256 - 1n),
        })
      ).unavailable,
      false,
    );
    assert.equal(
      (await walletCall('permit2.signature.prepare', signaturePrepare)).id,
      signature.id,
    );
    await assert.rejects(
      walletCall('permit2.signature.prepare', { ...signaturePrepare, commandId: 'second-attempt' }),
      /WALLET_PERMIT2_NONCE_UNAVAILABLE/,
    );
    return { address: testWallet.address, token: chainInfo.usdc, spender, protocol: 'permit2' };
  } finally {
    market.rpc = originalRpc;
  }
}
async function verifyWatchAssets(chainInfo) {
  const address = '0x5555555555555555555555555555555555555555';
  const custom = '0x6666666666666666666666666666666666666666';
  await rpc('anvil_setCode', [custom, fixture.contracts.Token.runtime]);
  await rpc('anvil_setBalance', [address, '0xde0b6b3a7640000']);
  const [funded] = await rpc('eth_accounts');
  for (const [to, amount] of [
    [chainInfo.usdc, 1250000n],
    [custom, 10n ** 19n],
  ]) {
    const hash = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to,
        data: token.encodeFunctionData('mint', [address, amount]),
        gas: '0x100000',
      },
    ]);
    await until(async () => (await rpc('eth_getTransactionReceipt', [hash]))?.status === '0x1');
  }
  const watch = await walletCall('watch.add', { name: 'Local public-address fixture', address });
  await walletCall('asset.track', { id: watch.id, chain: 'base', token: custom });
  const market = host.runtime.walletService.market,
    originalRpc = market.rpc;
  market.rpc = (venue, _url, method, args, options) =>
    originalRpc.call(market, venue, endpoint, method, args, options);
  try {
    const snapshot = await walletCall('assets', { id: watch.id, chain: 'base' });
    assert.equal(snapshot.assets[0].amount, '1');
    assert.equal(snapshot.assets[1].amount, '1.25');
    assert.equal(snapshot.assets[3].amount, '10');
    assert.equal(snapshot.assets[3].symbol, null);
    assert.equal((await walletCall('list')).wallets.find((w) => w.id === watch.id).kind, 'watch');
    await assert.rejects(
      walletCall('unlock', { id: watch.id, password: 'irrelevant-watch-only' }),
      /WALLET_WATCH_ONLY/,
    );
    return { address, custom };
  } finally {
    market.rpc = originalRpc;
  }
}
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
      '--timestamp',
      String(Math.floor(Date.now() / 1000) - 420),
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
      Permit2Fixture: [PERMIT2],
      PriceFeedFixture: [BASE_FEEDS.eth.address, BASE_FEEDS.usdc.address, BASE_FEEDS.sequencer],
      Factory: [chainInfo.factory],
      Pool: ['0x1111111111111111111111111111111111111111'],
      Quoter: [deployments.base.quoter],
      Router: [deployments.base.router],
      GasOracleFixture: ['0x420000000000000000000000000000000000000f'],
    };
  for (const [name, targets] of Object.entries(addresses)) {
    const contract = fixture.contracts[name];
    assert.equal(sha(Buffer.from(contract.runtime.slice(2), 'hex')), contract.sha256);
    for (const address of targets) await rpc('anvil_setCode', [address, contract.runtime]);
  }
  process.env.CIBYP_QUANT_ENGINE_BIN =
    process.env.CIBYP_QUANT_TEST_BINARY ||
    require('../../src/main/services/quant/native-binary').developmentBinary(root);
  const entry = process.env.CIBYP_TEST_NODE_BACKEND || require.resolve('../../src/agent/node-host');
  host = await require(entry).createNodeRuntime({
    dataDir: profile,
    workspaceRoot: path.join(profile, 'workspaces'),
    settings: {
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
    },
  });
  project = await call('workspace.create', { name: 'Local continuous execution', venue: 'base' });
  await call('workspace.update', { id: project.id, market: { rpcUrl: endpoint } });
  const [funded] = await rpc('eth_accounts');
  const pool = new Interface(fixture.contracts.Pool.abi);
  const gasOracle = new Interface(fixture.contracts.GasOracleFixture.abi);
  const updateOracle = async (method, value) => {
    const hash = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to: addresses.GasOracleFixture[0],
        data: gasOracle.encodeFunctionData(method, [value]),
        gas: '0x100000',
      },
    ]);
    assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
  };
  const anchor = Math.floor(Date.now() / 1000) - 1;
  const historyEnd = Math.floor(anchor / 60) * 60 - 60;
  const recordSwap = async (time, weth, usdc) => {
    await rpc('evm_setNextBlockTimestamp', [time]);
    const hash = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to: addresses.Pool[0],
        data: pool.encodeFunctionData('recordSwap', [weth * 10n ** 18n, usdc * 10n ** 6n]),
        gas: '0x100000',
      },
    ]);
    const receipt = await until(() => rpc('eth_getTransactionReceipt', [hash]));
    assert.equal(receipt.status, '0x1');
    return hash;
  };
  await rpc('evm_setNextBlockTimestamp', [historyEnd - 180]);
  await updateOracle('setL1Fee', 1234567n);
  const archivedTrade = await recordSwap(historyEnd - 150, 2n, -4100n);
  await recordSwap(historyEnd - 90, 2n, -4200n);
  await recordSwap(historyEnd - 30, 2n, -4300n);
  for (const [offset, amount] of [
    [-50, 1n],
    [-38, -3n],
    [-32, -1n],
    [-20, 3n],
  ])
    await recordSwap(anchor + offset, amount, -amount * 2000n);
  await rpc('evm_setNextBlockTimestamp', [anchor]);
  await rpc('anvil_mine', ['0x4', '0x0']);
  const profileShape = { id: project.id, slices: 3, intervalMs: 6000 };
  const volume = await call('execution.profile', profileShape);
  assert.equal(volume.pool, addresses.Pool[0]);
  assert.equal(volume.swapCount, 4);
  assert.deepEqual(volume.wethVolumeAtoms, ['2000000000000000000', '0', '6000000000000000000']);
  assert.deepEqual(
    await call('execution.profile.get', { id: project.id, profileId: volume.id }),
    volume,
  );
  await assert.rejects(
    call('execution.profile', { ...profileShape, slices: 2, intervalMs: 1000 }),
    /EXECUTION_PROFILE_EMPTY/,
  );
  await assert.rejects(
    call('execution.profile', { ...profileShape, slices: 1 }),
    /EXECUTION_PROFILE_INVALID/,
  );
  const historyMarket = host.runtime.quantService.market;
  const normalRpc = historyMarket.rpc.bind(historyMarket);
  historyMarket.rpc = async (...args) => {
    const result = await normalRpc(...args);
    if (args[2] === 'eth_getLogs' && result.length)
      return [{ ...result[0], blockHash: '0x' + 'a'.repeat(64) }, ...result.slice(1)];
    return result;
  };
  try {
    await assert.rejects(call('execution.profile', profileShape), /EXECUTION_PROFILE_CHANGED/);
  } finally {
    historyMarket.rpc = normalRpc;
  }
  await call('workspace.update', { id: project.id, market: { interval: 60 } });
  const tapeInput = { id: project.id, count: 4, endTime: historyEnd };
  const tape = await call('base.history.capture', tapeInput);
  assert.equal(tape.amm.swapCount, 3);
  assert.deepEqual(await call('base.history.capture', tapeInput), tape);
  const getTape = { id: project.id, datasetId: tape.id };
  const data = await call('dataset.get', getTape);
  assert.deepEqual(
    data.candles,
    [2050, 2100, 2150].map((price, index) => ({
      time: historyEnd - (3 - index) * 60,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 2,
    })),
  );
  assert.equal(data.amm.trades, undefined);
  assert.deepEqual(data.amm.volumes[0], {
    time: historyEnd - 180,
    wethVolumeAtoms: '2000000000000000000',
    usdcVolumeAtoms: '4100000000',
    count: 1,
  });
  const tapeRows = await call('base.history.trades', { ...getTape, limit: 1 });
  assert.equal(tapeRows.total, 3);
  assert.equal(tapeRows.items[0].transactionHash, archivedTrade);
  assert.deepEqual((await call('base.history.trades', { ...getTape, offset: 3 })).items, []);
  const tapeBacktest = await call('run.backtest', { ...getTape, config: { strategy: 'buy-hold' } });
  assert.equal(tapeBacktest.provenance.pool, addresses.Pool[0]);
  assert.equal(tapeBacktest.dataSource, 'base-finalized-uniswap-v3-swaps');
  assert.equal(tapeBacktest.datasetId, tape.id);
  const validationDataset = await call('dataset.import', {
    id: project.id,
    text: JSON.stringify(
      Array.from({ length: 14 }, (_, i) => {
        const price = 100 + i * 10;
        return {
          time: (i + 1) * 60,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1,
        };
      }),
    ),
  });
  const validation = await call('run.walk-forward', {
    id: project.id,
    datasetId: validationDataset.id,
    config: { trainBars: 8, testBars: 3, folds: 2, fastPeriods: [2, 3], slowPeriods: [4, 5] },
  });
  assert.equal(validation.codeVersion, 'candle-walk-forward-1');
  assert.equal(validation.metrics.bars, 6);
  assert.equal(validation.metrics.fills, 1);
  assert.deepEqual(
    await call('run.walk-forward.fold', {
      id: project.id,
      runId: validation.id,
      fold: 2,
    }),
    validation.walkForward.windows[1],
  );
  const ammReplay = await call('run.amm', {
    ...getTape,
    config: { initialCash: '100', fixedFeeUsdc: '1', allocationBps: 2500 },
  });
  assert.equal(ammReplay.codeVersion, 'base-amm-replay-1');
  assert.equal(ammReplay.metrics.cash, '74.25');
  assert.equal(ammReplay.metrics.position, '0.012375');
  assert.equal(ammReplay.metrics.fees, '1.0');
  assert.equal(ammReplay.metrics.fills, 1);
  const quotePage = await call('run.amm.attempts', {
    id: project.id,
    runId: ammReplay.id,
    limit: 1,
  });
  assert.equal(quotePage.items[0].signal.transactionHash, archivedTrade);
  assert.ok(quotePage.items[0].execution.block > quotePage.items[0].signal.block);
  assert.equal(quotePage.items[0].amountInAtoms, '24750000');
  assert.equal(quotePage.items[0].quoteGasEstimate, '100000');
  await updateOracle('setL1Fee', 0n);
  const historyCostConfig = {
    initialCash: '100',
    feeMode: 'historical',
    networkFeeCapUsdc: '1',
    tipGwei: '1',
    routerOverheadGas: 55000,
  };
  const historicalRun = await call('run.amm', { ...getTape, config: historyCostConfig });
  assert.equal(historicalRun.codeVersion, 'base-amm-replay-2');
  const [historicalQuote] = historicalRun.ammReplay.attempts;
  assert.equal(historicalQuote.status, 'filled');
  const historicalCost = historicalQuote.networkFee;
  const executionBlock = await rpc('eth_getBlockByHash', [
    historicalQuote.execution.blockHash,
    false,
  ]);
  assert.equal(historicalCost.l1Wei, '1234567');
  assert.equal(historicalCost.operatorWei, String(155000n * 500n + 7n));
  assert.equal(
    historicalCost.l2Wei,
    String(155000n * (BigInt(executionBlock.baseFeePerGas) + 1000000000n)),
  );
  assert.equal(historicalRun.ammReplay.networkFees.totalWei, historicalCost.totalWei);
  assert.ok(BigInt(historicalCost.usdcAtoms) > 0n);
  const tooExpensive = await call('run.amm', {
    ...getTape,
    config: { ...historyCostConfig, networkFeeCapUsdc: '0.000001' },
  });
  assert.equal(tooExpensive.metrics.fills, 0);
  assert.equal(tooExpensive.metrics.cash, '100.0');
  assert.equal(tooExpensive.ammReplay.networkFees.totalWei, '0');
  assert.ok(
    tooExpensive.ammReplay.attempts.every((quote) => quote.status === 'network-cost-limit'),
  );
  const nextTape = await call('base.history.capture', {
    id: project.id,
    afterDatasetId: tape.id,
    count: 1,
  });
  assert.equal(nextTape.start, tape.end);
  assert.equal(nextTape.end, tape.end + 60);
  const other = await call('workspace.create', { venue: 'base' });
  await assert.rejects(
    call('base.history.trades', { id: other.id, datasetId: tape.id }),
    /DATASET_NOT_IN_WORKSPACE/,
  );
  await call('workspace.update', { id: project.id, market: { interval: 300 } });
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
  const revokedSpender = await verifyAllowance(chainInfo);
  const permit2Pair = await verifyPermit2(chainInfo);
  const watchAssets = await verifyWatchAssets(chainInfo);
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
  const allowance = await call('base.inspect', {
    id: project.id,
    address: wallet.address,
    token: chainInfo.usdc,
    spender: revokedSpender,
  });
  assert.equal(allowance.amountAtomic, '0');
  const approvalHistory = await call('base.inspect', {
    id: project.id,
    address: wallet.address,
    approvalHistory: true,
    blocks: 100,
  });
  assert.equal(approvalHistory.items[0].spender, revokedSpender);
  assert.equal(approvalHistory.items[0].eventAmountAtomic, '0');
  const permit2Allowance = await call('base.inspect', { id: project.id, ...permit2Pair });
  assert.equal(permit2Allowance.permit2.nonce, '7');
  assert.equal(permit2Allowance.amountAtomic, '0');
  const permit2History = await call('base.inspect', {
    id: project.id,
    address: permit2Pair.address,
    protocol: permit2Pair.protocol,
    approvalHistory: true,
    blocks: 100,
  });
  assert.equal(permit2History.items[0].event, 'Lockdown');
  const signatureStatus = await call('base.inspect', {
    id: project.id,
    address: permit2Pair.address,
    signatureNonce: String(MaxUint256),
  });
  assert.equal(signatureStatus.unavailable, true);
  const holdings = await call('base.inspect', {
    id: project.id,
    address: watchAssets.address,
    assets: true,
    tokens: [watchAssets.custom],
  });
  assert.equal(holdings.assets[1].amount, '1.25');
  assert.equal(holdings.assets[3].amount, '10');
  const { rootContext, deriveChild } = require('../../src/main/services/wallet/agent-scopes');
  const delegated = deriveChild(rootContext(project.id), 'native-sub-local-chain', {
    walletIds: [wallet.id],
    chains: [8453],
    limits: { maxTransactions: 4 },
  });
  const walletService = host.runtime.walletService;
  const cancelledArrival = await create('stop-during-arrival', { slices: 1 });
  const quoteMarket = host.runtime.quantService.market;
  const readBase = quoteMarket.base.bind(quoteMarket);
  let enteredArrival, releaseArrival;
  const inArrival = new Promise((resolve) => {
    enteredArrival = resolve;
  });
  const arrivalGate = new Promise((resolve) => {
    releaseArrival = resolve;
  });
  quoteMarket.base = async (config, options) => {
    if (options?.priceEvidence) {
      enteredArrival();
      await arrivalGate;
    }
    return readBase(config, options);
  };
  const startWhileReading = call('execution.start', {
    id: project.id,
    runId: cancelledArrival.plan.id,
  });
  const didStop = assert.rejects(startWhileReading, /WALLET_EXECUTION_STOPPED/);
  try {
    await Promise.race([
      inArrival,
      pause(15000).then(() => {
        throw Error('Arrival quote not reached');
      }),
    ]);
    await call('execution.stop', { id: project.id, runId: cancelledArrival.plan.id });
  } finally {
    releaseArrival();
    quoteMarket.base = readBase;
  }
  await didStop;
  const cancelledView = (await inspect(cancelledArrival.plan.id)).run;
  assert.equal(cancelledView.phase, 'stopped');
  assert.equal(cancelledView.arrival, undefined);
  assert.equal(cancelledView.commands_created, 0);
  const blocked = await create('price-below-limit', {
    totalInput: '1',
    slices: 1,
    minimumTotalOutput: '0.000500000000000001',
  });
  const priceNonce = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
  await call('execution.start', { id: project.id, runId: blocked.plan.id });
  const priceStop = await until(async () => {
    const result = await inspect(blocked.plan.id);
    return result.run.reason === 'SWAP_PRICE_LIMIT' && result;
  });
  assert.equal(priceStop.run.phase, 'paused');
  assert.equal(priceStop.run.completed_slices, 0);
  assert.equal(await rpc('eth_getTransactionCount', [wallet.address, 'pending']), priceNonce);
  assert.equal(
    walletService.state.intents.some((i) => i.execution?.planId === blocked.plan.id),
    false,
  );
  assert.equal(await executed(), 0n);
  const before = await balance(chainInfo.usdc, wallet.address),
    run = await create('two-slices', { minimumTotalOutput: '0.001249000000000001' }, delegated);
  assert.equal(run.plan.agent_scope.subject, 'native-sub-local-chain');
  assert.equal(run.plan.min_total_output_atoms, '1249000000000001');
  await assert.rejects(
    create('two-slices', { minimumTotalOutput: '0.0012' }, delegated),
    /EXECUTION_PLAN_CONFLICT/,
  );
  await call('execution.start', { id: project.id, runId: run.plan.id });
  await until(async () => (await inspect(run.plan.id)).run.phase === 'completed', { mine: true });
  assert.equal(await balance(chainInfo.usdc, wallet.address), before - 2500000n);
  assert.equal(await balance(chainInfo.weth, wallet.address), 1250000000000000n);
  assert.equal(await executed(), 2n);
  const history = await call('execution.commands', { id: project.id, runId: run.plan.id });
  assert.equal(history.total, 2);
  assert.ok(history.items.every((i) => i.stage === 'finalized'));
  assert.ok(history.items.every((i) => i.min_output_atoms === '624500000000001'));
  const usage = await inspect(run.plan.id);
  assert.ok(BigInt(usage.feeUsage.reservedEstimateWei) > 0n);
  assert.equal(usage.feeUsage.chainEnforced, false);
  const records = walletService.state.intents.filter((i) => i.execution?.planId === run.plan.id);
  assert.equal(records.length, 4);
  assert.ok(records.every((i) => i.status === 'finalized'));
  assert.equal(new Set(records.map((i) => i.hash)).size, 4);
  assert.ok(records.every((i) => i.agentScope.id === run.plan.agent_scope.id));
  for (const record of records.filter((i) => i.commandId.endsWith(':swap'))) {
    const transaction = await rpc('eth_getTransactionByHash', [record.hash]);
    const outer = routerAbi.decodeFunctionData('multicall', transaction.input);
    const [swap] = routerAbi.decodeFunctionData('exactInputSingle', outer[1][0]);
    assert.equal(swap.amountOutMinimum, 624500000000001n);
  }
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
  const performance = await walletCall('portfolio.performance', {
    id: portfolio.portfolio.id,
    walletId: wallet.id,
  });
  assert.equal(performance.totals.buyCount, 2);
  assert.equal(performance.totals.openWeth.atomic, '1250000000000000');
  assert.equal(performance.totals.openCostUsdc.atomic, '2500000');
  assert.equal(performance.totals.missingCount, 0);
  assert.equal(performance.fees.finalizedTransactions, 4);
  assert.ok(
    performance.items.every((item) => records.some((record) => item.txHash === record.hash)),
  );
  const nonce = BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest']));
  const memberMarket = host.runtime.walletService.market;
  const originalMemberRpc = memberMarket.rpc;
  memberMarket.rpc = (venue, _url, method, params, options) =>
    originalMemberRpc.call(memberMarket, venue, endpoint, method, params, options);
  try {
    const holdings = await walletCall('portfolio.holdings', { id: portfolio.portfolio.id });
    assert.equal(holdings.members.length, 2);
    assert.ok(holdings.members.every((member) => member.blockHash === holdings.blockHash));
    assert.equal(
      holdings.assets[1].amountAtomic,
      String(await balance(chainInfo.usdc, wallet.address)),
    );
    assert.equal(
      holdings.assets[2].amountAtomic,
      String(await balance(chainInfo.weth, wallet.address)),
    );
    assert.equal(holdings.complete, true);
    assert.equal(
      holdings.assets[0].amountAtomic,
      String(
        holdings.members.reduce((sum, member) => sum + BigInt(member.assets[0].amountAtomic), 0n),
      ),
    );
    const valued = await walletCall('portfolio.holdings', {
      id: portfolio.portfolio.id,
      valuation: true,
    });
    assert.equal(valued.valuation.complete, true);
    assert.equal(valued.valuation.prices.eth.address, BASE_FEEDS.eth.address);
    assert.equal(valued.valuation.prices.usdc.price, '0.98');
    assert.equal(valued.valuation.prices.eth.ageSeconds, 30);
    const feeInput = { id: portfolio.portfolio.id, walletId: wallet.id };
    const prices = await walletCall('portfolio.performance.priceFees', { ...feeInput, limit: 2 });
    assert.deepEqual(prices, { total: 4, next: 2, saved: 2, unavailable: 0, errors: [] });
    const remainingPrices = await walletCall('portfolio.performance.priceFees', {
      ...feeInput,
      offset: prices.next,
      limit: 2,
    });
    assert.deepEqual(remainingPrices, {
      total: 4,
      next: null,
      saved: 2,
      unavailable: 0,
      errors: [],
    });
    const priced = await walletCall('portfolio.performance', feeInput);
    assert.notEqual(priced.snapshotId, performance.snapshotId);
    assert.ok(priced.items.every((row) => row.feeQuote?.blockHash === row.blockHash));
    assert.ok(priced.items.every((row) => row.feeQuote?.usdc.price === '0.98'));
    assert.equal((await walletCall('portfolio.performance.priceFees', feeInput)).saved, 0);
    assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), nonce);
    const expected = valued.members.reduce(
      (sum, member) =>
        sum + (BigInt(member.assets[0].amountAtomic) * 200000000000n) / 1000000000000000000n,
      0n,
    );
    assert.equal(valued.assets[0].valuation.valueAtomic, String(expected));
    assert.equal(
      valued.valuation.valueAtomic,
      String(
        valued.members.reduce((sum, member) => sum + BigInt(member.valuation.valueAtomic), 0n),
      ),
    );
    assert.ok(holdings.members.every((member) => member.minedNonce !== null));
    assert.equal(holdings.assets[1].capital.reservedAtomic, '0');
    const actualBalance = await balance(chainInfo.usdc, wallet.address);
    const reserveAmount = (actualBalance * 3n) / 4n;
    const reservation = await host.runtime.walletService.prepare(
      { venue: 'base', rpcUrl: endpoint },
      {
        walletId: wallet.id,
        commandId: 'local-capital-reserve',
        to: chainInfo.usdc,
        value: '0',
        data: token.encodeFunctionData('transfer', [funded, reserveAmount]),
      },
    );
    assert.equal(reservation.status, 'approval-required');
    await assert.rejects(
      host.runtime.walletService.prepare(
        { venue: 'base', rpcUrl: endpoint },
        {
          walletId: wallet.id,
          commandId: 'local-capital-overlap',
          to: chainInfo.usdc,
          value: '0',
          data: token.encodeFunctionData('transfer', [funded, actualBalance / 2n]),
        },
      ),
      /WALLET_TOKEN_CAPITAL_RESERVED/,
    );
    const reserved = await walletCall('portfolio.holdings', { id: portfolio.portfolio.id });
    assert.equal(reserved.assets[1].capital.reservedAtomic, String(reserveAmount));
    assert.equal(reserved.assets[1].capital.availableAtomic, String(actualBalance - reserveAmount));
    await walletCall('intent.deny', { id: reservation.id, digest: reservation.digest });
    assert.equal(
      (await walletCall('portfolio.holdings', { id: portfolio.portfolio.id })).assets[1].capital
        .reservedAtomic,
      '0',
    );
    assert.equal(await balance(chainInfo.usdc, wallet.address), actualBalance);
  } finally {
    memberMarket.rpc = originalMemberRpc;
  }
  await call('execution.start', { id: project.id, runId: run.plan.id }).then(
    () => assert.fail('completed run cannot restart'),
    () => {},
  );
  assert.equal(BigInt(await rpc('eth_getTransactionCount', [wallet.address, 'latest'])), nonce);
  for (const kind of [
    'stop',
    'revoke',
    'pause',
    'config',
    'emergency',
    'price',
    'arrival-limit',
    'operator-fee',
    'l1-fee',
    'window',
  ]) {
    const next = await create('during-signature-' + kind, {
      slices: 1,
      totalInput: '1',
      ...(kind === 'price' ? { minimumTotalOutput: '0.000499' } : {}),
      ...(kind === 'arrival-limit' ? { maxArrivalCostBps: 25 } : {}),
      ...(kind === 'window' ? { schedule: 'fixed-window', intervalMs: 4000 } : {}),
    });
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
    const nonceBefore = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
    if (kind === 'stop') await call('execution.stop', { id: project.id, runId: next.plan.id });
    else if (kind === 'pause') await call('native.control', { method: 'pause', params: {} });
    else if (kind === 'config')
      await call('workspace.update', { id: project.id, market: { poolFee: 3000 } });
    else if (kind === 'price')
      await rpc('anvil_setStorageAt', [deployments.base.router, toBeHex(1, 32), toBeHex(2100, 32)]);
    else if (kind === 'arrival-limit')
      await rpc('anvil_setStorageAt', [deployments.base.router, toBeHex(1, 32), toBeHex(2008, 32)]);
    else if (kind === 'operator-fee') await updateOracle('setScalar', 100000000n);
    else if (kind === 'l1-fee') await updateOracle('setL1Fee', 10n ** 16n);
    else if (kind === 'window') {
      const end = Number(BigInt((await inspect(next.plan.id)).run.fixed.end_at_ns) / 1000000n);
      await until(() => Date.now() > end + 50);
    } else if (kind === 'emergency') {
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
        return !current.run.pending && ['stopped', 'paused', 'expired'].includes(current.run.phase);
      },
      { mine: true },
    );
    assert.equal(await balance(chainInfo.usdc, wallet.address), balanceBefore);
    assert.equal(await rpc('eth_getTransactionCount', [wallet.address, 'pending']), nonceBefore);
    assert.equal(await executed(), 2n);
    const commands = await call('execution.commands', { id: project.id, runId: next.plan.id });
    assert.ok(['aborted', 'unsent'].includes(commands.items[0].stage));
    if (kind === 'price' || kind === 'arrival-limit') {
      assert.equal(commands.items[0].reason, 'WALLET_SWAP_SIMULATION_FAILED');
      const swap = walletService.state.intents.find(
        (i) => i.execution?.planId === next.plan.id && i.commandId.endsWith(':swap'),
      );
      assert.equal(swap.submissionMayHaveOccurred, false);
      if (kind === 'arrival-limit') {
        assert.equal(commands.items[0].min_arrival_output_atoms, '498753117206983');
        assert.equal(swap.description.minimumAmountOut, '0.000498753117206983');
      }
      assert.equal((await inspect(next.plan.id)).run.reason, 'WALLET_SWAP_SIMULATION_FAILED');
      await rpc('anvil_setStorageAt', [deployments.base.router, toBeHex(1, 32), toBeHex(0, 32)]);
    }
    if (kind === 'operator-fee' || kind === 'l1-fee') {
      const swap = walletService.state.intents.find(
        (intent) => intent.execution?.planId === next.plan.id && intent.commandId.endsWith(':swap'),
      );
      assert.equal(swap.error, 'WALLET_FEE_RESERVE_EXCEEDED');
      assert.equal(swap.submissionMayHaveOccurred, false);
      assert.equal(commands.items[0].reason, 'WALLET_FEE_RESERVE_EXCEEDED');
      assert.equal((await inspect(next.plan.id)).lastError, 'WALLET_FEE_RESERVE_EXCEEDED');
      await updateOracle(kind === 'operator-fee' ? 'setScalar' : 'setL1Fee', 0);
    }
    if (kind === 'window') {
      assert.equal(commands.items[0].reason, 'EXECUTION_WINDOW_EXPIRED');
      const expired = (await inspect(next.plan.id)).run;
      assert.equal(expired.phase, 'expired');
      assert.equal(expired.fixed.skipped_input_atoms, '1000000');
    }
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
  const fixed = await create('fixed-window-twap', {
    schedule: 'fixed-window',
    slices: 3,
    intervalMs: 4500,
    totalInput: '3',
    minimumTotalOutput: '0.001498',
  });
  assert.equal(fixed.fixed, undefined);
  const originalFixedReconcile = walletService.reconcile;
  walletService.reconcile = function (id, ...args) {
    const i = this.state.intents.find((i) => i.id === id);
    if (i?.execution?.planId === fixed.plan.id && i.commandId.endsWith(':swap'))
      return Promise.resolve(this.publicIntent(i));
    return originalFixedReconcile.call(this, id, ...args);
  };
  try {
    await call('execution.start', { id: project.id, runId: fixed.plan.id });
    await until(async () => (await executed()) === 3n);
    await until(async () => (await inspect(fixed.plan.id)).run.fixed.skipped_slices === 1);
  } finally {
    walletService.reconcile = originalFixedReconcile;
  }
  await rpc('anvil_mine', ['0x4', '0x0']);
  await call('execution.reconcile', { id: project.id, runId: fixed.plan.id });
  const fixedResult = await until(
    async () => {
      const current = (await inspect(fixed.plan.id)).run;
      return current.phase === 'expired' && current;
    },
    { mine: true },
  );
  assert.equal(fixedResult.completed_slices, 2);
  assert.equal(fixedResult.allocated_input_atoms, '2000000');
  assert.equal(fixedResult.fixed.skipped_input_atoms, '1000000');
  const fixedHistory = await call('execution.commands', { id: project.id, runId: fixed.plan.id });
  assert.deepEqual(fixedHistory.items.map((c) => c.ordinal).sort(), [1, 3]);
  assert.ok(fixedHistory.items.every((c) => c.stage === 'finalized'));
  for (const command of fixedHistory.items) {
    const hash = command.hashes.at(-1);
    const transaction = await rpc('eth_getTransactionByHash', [hash]);
    const [deadline] = routerAbi.decodeFunctionData('multicall', transaction.input);
    assert.ok(deadline * 1000000000n < BigInt(command.window.closes_at_ns));
  }
  const weightedInput = {
    schedule: 'vwap',
    profileId: volume.id,
    slices: volume.slices,
    intervalMs: volume.intervalMs,
    totalInput: '4.000001',
    minimumTotalOutput: '0.001999',
    maxArrivalCostBps: 200,
  };
  await assert.rejects(
    create('mismatched-profile', { ...weightedInput, slices: 2 }),
    /EXECUTION_PROFILE_INVALID/,
  );
  await assert.rejects(
    create('unverified-profile', { ...weightedInput, profileId: 'a'.repeat(64) }),
    /EXECUTION_PROFILE_REQUIRED/,
  );
  const weighted = await create('historical-vwap', weightedInput);
  assert.equal(weighted.plan.template, 'base-vwap-fixed-v1');
  assert.deepEqual(weighted.plan.vwap.weth_volume_atoms, volume.wethVolumeAtoms);
  const evidenceFile = path.join(
    host.runtime.quantService.directory,
    'execution-profiles',
    volume.id + '.json',
  );
  const evidence = fs.readFileSync(evidenceFile, 'utf8');
  fs.writeFileSync(evidenceFile, JSON.stringify({ ...JSON.parse(evidence), swapCount: 5 }));
  try {
    await assert.rejects(
      call('execution.start', { id: project.id, runId: weighted.plan.id }),
      /EXECUTION_PROFILE_REQUIRED/,
    );
  } finally {
    fs.writeFileSync(evidenceFile, evidence);
  }
  const beforeWeighted = await balance(chainInfo.usdc, wallet.address);
  const beforeWeightedWeth = await balance(chainInfo.weth, wallet.address);
  const setArrivalPrice = await rpc('eth_sendTransaction', [
    {
      from: funded,
      to: addresses.Pool[0],
      data: pool.encodeFunctionData('setSqrtPrice', [3520976558767282464819376n]),
      gas: '0x100000',
    },
  ]);
  assert.equal(
    (await until(() => rpc('eth_getTransactionReceipt', [setArrivalPrice]))).status,
    '0x1',
  );
  const tooFar = await create('arrival-limit-before-approval', {
    slices: 1,
    maxArrivalCostBps: 100,
  });
  const beforeLimitNonce = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
  await call('execution.start', { id: project.id, runId: tooFar.plan.id });
  await until(async () => (await inspect(tooFar.plan.id)).run.reason === 'EXECUTION_ARRIVAL_LIMIT');
  assert.equal(await rpc('eth_getTransactionCount', [wallet.address, 'pending']), beforeLimitNonce);
  assert.ok(
    !walletService.state.intents.some((intent) => intent.execution?.planId === tooFar.plan.id),
  );
  await call('execution.start', { id: project.id, runId: weighted.plan.id });
  const arrived = await inspect(weighted.plan.id);
  assert.equal(arrived.run.arrival.pool, addresses.Pool[0]);
  assert.equal(arrived.run.arrival.sqrt_price_x96, '3520976558767282464819376');
  assert.equal(arrived.arrivalComparison.referencePriceAtoms, '1975000000');
  await until(async () => (await inspect(weighted.plan.id)).run.completed_slices === 1, {
    mine: true,
  });
  await assert.rejects(
    call('execution.benchmark', { id: project.id, runId: weighted.plan.id }),
    /EXECUTION_BENCHMARK_NOT_READY/,
  );
  for (const [weth, usdc] of [
    [1n, -1900n],
    [-3n, 5900n],
  ]) {
    const hash = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to: addresses.Pool[0],
        data: pool.encodeFunctionData('recordSwap', [weth * 10n ** 18n, usdc * 10n ** 6n]),
        gas: '0x100000',
      },
    ]);
    assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
  }
  const weightedResult = await until(
    async () => {
      const { run } = await inspect(weighted.plan.id);
      return run.phase === 'completed' && run;
    },
    { mine: true },
  );
  assert.equal(weightedResult.fixed.skipped_slices, 1);
  assert.equal(weightedResult.fixed.skipped_input_atoms, '0');
  assert.equal(weightedResult.allocated_input_atoms, '4000001');
  assert.equal(beforeWeighted - (await balance(chainInfo.usdc, wallet.address)), 4000001n);
  const weightedHistory = await call('execution.commands', {
    id: project.id,
    runId: weighted.plan.id,
  });
  assert.deepEqual(weightedHistory.items.map((row) => [row.ordinal, row.input_atoms]).sort(), [
    [1, '1000000'],
    [3, '3000001'],
  ]);
  const actualOutput = (await balance(chainInfo.weth, wallet.address)) - beforeWeightedWeth;
  assert.equal(actualOutput, 2000000500000000n);
  let expectedGas = 0n;
  let expectedOperator = 0n;
  let expectedReceipts = 0;
  for (const command of weightedHistory.items) {
    assert.equal(command.settlement.fill.observed, 1);
    assert.equal(command.settlement.fill.inputAtoms, command.input_atoms);
    for (const hash of command.hashes) {
      const receipt = await rpc('eth_getTransactionReceipt', [hash]);
      expectedGas += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      expectedOperator += BigInt(receipt.gasUsed) * 500n + 7n;
      expectedReceipts++;
      const intent = walletService.state.intents.find((record) => record.hash === hash);
      assert.equal(
        BigInt(intent.operatorFeeEstimateWei),
        BigInt(intent.transaction.gasLimit) * 500n + 7n,
      );
      assert.equal(
        BigInt(intent.feeReserveWei),
        BigInt(intent.executionFeeMaxWei) + 10000000000000n + BigInt(intent.operatorFeeEstimateWei),
      );
    }
  }
  const weightedSettlement = await until(
    async () => {
      const snapshot = (await inspect(weighted.plan.id)).settlement;
      return snapshot.fees.l2Receipts === expectedReceipts && snapshot;
    },
    { mine: true },
  );
  assert.deepEqual(weightedSettlement.fill, {
    inputAtoms: '4000001',
    outputAtoms: String(actualOutput),
    observed: 2,
    finalized: 2,
  });
  assert.equal(weightedSettlement.fees.l2GasWei, String(expectedGas));
  assert.equal(weightedSettlement.fees.totalWei, null);
  const compareInput = { id: project.id, runId: weighted.plan.id };
  const comparison = await call('execution.benchmark', compareInput);
  assert.equal(comparison.pool, addresses.Pool[0]);
  assert.equal(comparison.swapCount, 2);
  assert.equal(comparison.excludedTransactions, 2);
  assert.equal(comparison.marketWethAtoms, '4000000000000000000');
  assert.equal(comparison.marketUsdcAtoms, '7800000000');
  assert.equal(comparison.costBpsHundredths, '25641');
  assert.deepEqual((await inspect(weighted.plan.id)).benchmark, comparison);
  const arrivalComparison = {
    referencePriceAtoms: '1975000000',
    costUsdcAtoms: '50000',
    costBpsHundredths: '12658',
  };
  assert.deepEqual((await inspect(weighted.plan.id)).arrivalComparison, arrivalComparison);
  await updateOracle('setScalar', 99);
  // Emulate an intent recorded before receipt accounting was added.
  await walletService.mutate((state) => {
    const historical = state.intents.find(
      (intent) =>
        intent.execution?.planId === weighted.plan.id && intent.commandId.endsWith(':swap'),
    );
    delete historical.executionReceipt;
  });
  const partial = (await inspect(weighted.plan.id)).settlement;
  assert.equal(partial.fill.observed, 1);
  assert.equal(partial.fill.finalized, 2);
  assert.equal(partial.receiptsMissing, 1);
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
  assert.equal(await executed(), 7n);
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
  const recordingProject = await call('workspace.create', {
    venue: 'base',
    name: 'Restartable on-chain recording',
  });
  const recordingId = recordingProject.id;
  await call('workspace.update', { id: recordingId, market: { interval: 60, rpcUrl: endpoint } });
  const seed = await call('base.history.capture', {
    ...tapeInput,
    id: recordingId,
    endTime: historyEnd - 120,
  });
  await call('base.history.record.start', { id: recordingId, count: 1, afterDatasetId: seed.id });
  const firstRecording = await until(() => {
    const state = host.runtime.quantService.workspace(recordingId).baseRecorder;
    return state.batches ? state : null;
  });
  assert.equal(firstRecording.endTime, seed.end + 60);
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
      onboardingCompleted: true,
      language: 'en',
      runtime: { location: 'host' },
      automaticMemory: { enabled: false },
      decision: { enabled: false },
    },
  });
  const restoredPerformance = await walletCall('portfolio.performance', {
    id: portfolio.portfolio.id,
    walletId: wallet.id,
  });
  const restoredQuotes = restoredPerformance.items.filter((row) =>
    performance.items.some((original) => original.txHash === row.txHash),
  );
  assert.equal(restoredQuotes.length, 2);
  assert.ok(restoredQuotes.every((row) => row.feeQuote?.blockHash === row.blockHash));
  const recorded = await until(() => {
    const service = host.runtime.quantService;
    const state = service?.workspace(recordingId).baseRecorder;
    return state?.batches > firstRecording.batches ? state : null;
  });
  assert.ok(recorded.endTime > firstRecording.endTime);
  const saved = (await call('workspace.get', { id: recordingId })).datasets;
  assert.equal(saved[1].start, seed.end);
  assert.equal(
    (await call('dataset.get', { id: recordingId, datasetId: saved[1].id })).amm.previousDatasetId,
    seed.id,
  );
  const resumedSegment = saved.find((dataset) => dataset.start === firstRecording.endTime);
  assert.equal(
    (await call('dataset.get', { id: recordingId, datasetId: resumedSegment.id })).amm
      .previousDatasetId,
    firstRecording.datasetId,
  );
  assert.equal((await call('base.history.record.stop', { id: recordingId })).phase, 'paused');
  const series = await call('base.history.series', {
    id: recordingId,
    datasetId: resumedSegment.id,
    windows: 6,
  });
  assert.equal(series.series.segmentCount, 3);
  assert.equal(series.series.slots, 6);
  const seriesData = await call('dataset.get', { id: recordingId, datasetId: series.id });
  assert.deepEqual(
    seriesData.series.segments.map((segment) => segment.id),
    [seed.id, firstRecording.datasetId, resumedSegment.id],
  );
  assert.equal((await inspect(unknown.plan.id)).run.phase, 'paused');
  const restoredFixed = (await inspect(fixed.plan.id)).run;
  assert.equal(restoredFixed.phase, 'expired');
  assert.deepEqual(restoredFixed.fixed, fixedResult.fixed);
  assert.deepEqual((await inspect(weighted.plan.id)).profile, volume);
  assert.deepEqual(await call('dataset.get', getTape), data);
  assert.deepEqual(await call('base.history.trades', { ...getTape, limit: 1 }), tapeRows);
  assert.deepEqual(await call('run.get', { id: project.id, runId: ammReplay.id }), ammReplay);
  assert.deepEqual(
    await call('run.get', { id: project.id, runId: historicalRun.id }),
    historicalRun,
  );
  assert.equal((await inspect(weighted.plan.id)).run.phase, 'completed');
  assert.deepEqual((await inspect(weighted.plan.id)).settlement.fill, partial.fill);
  assert.equal((await inspect(weighted.plan.id)).benchmark, undefined);
  assert.equal((await inspect(blocked.plan.id)).lastError, 'SWAP_PRICE_LIMIT');
  assert.equal((await inspect(run.plan.id)).run.plan.min_total_output_atoms, '1249000000000001');
  assert.equal((await walletCall('emergency.status')).halted, true);
  assert.equal(host.runtime.walletService.isUnlocked(wallet.id), false);
  const reconciliationNonce = await rpc('eth_getTransactionCount', [wallet.address, 'pending']);
  await call('execution.reconcile', { id: project.id, runId: weighted.plan.id });
  assert.equal(
    await rpc('eth_getTransactionCount', [wallet.address, 'pending']),
    reconciliationNonce,
  );
  const settled = (await inspect(weighted.plan.id)).settlement;
  assert.equal(settled.receiptsMissing, 0);
  assert.deepEqual(settled.fill, weightedSettlement.fill);
  assert.deepEqual((await inspect(weighted.plan.id)).benchmark, comparison);
  const restoredArrival = await inspect(weighted.plan.id);
  assert.deepEqual(restoredArrival.run.arrival, arrived.run.arrival);
  assert.deepEqual(restoredArrival.arrivalComparison, arrivalComparison);
  assert.deepEqual(settled.fees, {
    l2GasWei: String(expectedGas),
    l1DataFeeWei: null,
    operatorFeeWei: String(expectedOperator),
    totalWei: null,
    l2Receipts: expectedReceipts,
    l1Receipts: 0,
    operatorReceipts: expectedReceipts,
    finalizedTransactions: expectedReceipts,
  });
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
  assert.equal(await executed(), 7n);
  assert.equal(dispatches, 1);
  assert.equal(
    (await call('execution.commands', { id: project.id, runId: unknown.plan.id })).total,
    1,
  );
  assert.equal(host.runtime.quantService.liveExecution.active.size, 0);
  const restoredPortfolio = await walletCall('portfolio.get', { id: portfolio.portfolio.id });
  assert.ok(restoredPortfolio.usage.transactions >= 5);
  assert.equal(restoredPortfolio.usage.valueWei, '1000000000000000');
  await until(async () => !(await walletCall('emergency.status')).nativePausePending);
  const resetRiskFixture = await walletCall('emergency.challenge');
  await walletCall('emergency.reset', {
    challengeId: resetRiskFixture.id,
    ack: 'RESET LIVE',
    confirmed: true,
  });
  const equityPassword = 'isolated-equity-fixture-password';
  const riskWallet = await walletCall('import', {
    name: 'Isolated equity control',
    kind: 'privateKey',
    secret: toBeHex(87, 32),
    password: equityPassword,
  });
  await rpc('anvil_setBalance', [riskWallet.address, toBeHex(200000000000000000n)]);
  const mintRisk = await rpc('eth_sendTransaction', [
    {
      from: funded,
      to: chainInfo.usdc,
      data: token.encodeFunctionData('mint', [riskWallet.address, 10000000n]),
      gas: '0x30000',
    },
  ]);
  assert.equal((await until(() => rpc('eth_getTransactionReceipt', [mintRisk]))).status, '0x1');
  await walletCall('unlock', { id: riskWallet.id, password: equityPassword, minutes: 0 });
  const floorChallenge = await walletCall('portfolio.challenge', {
    operation: 'create',
    name: 'Base USD floor',
    chainId: 8453,
    walletIds: [riskWallet.id],
    equityFloorUsd: '405',
  });
  const riskPortfolio = await walletCall('portfolio.confirm', {
    challengeId: floorChallenge.id,
    ack: 'ALLOW PORTFOLIO',
    confirmed: true,
  });
  const riskService = host.runtime.walletService;
  const prepareRisk = async (commandId, amount, recipient) => {
    const record = await riskService.prepare(
      { venue: 'base', rpcUrl: endpoint },
      {
        walletId: riskWallet.id,
        commandId,
        to: chainInfo.usdc,
        value: '0',
        data: token.encodeFunctionData('transfer', [recipient, amount]),
      },
    );
    await riskService.decide(record.id, true, record.digest);
    return record;
  };
  const beforeRiskNonce = await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']);
  const riskRecipient = '0x' + '7'.repeat(40);
  const recipientBefore = await balance(chainInfo.usdc, riskRecipient);
  const tooLarge = await prepareRisk('exceeds-equity', 6000000n, riskRecipient);
  const rejectedRisk = await riskService.broadcast(tooLarge.id);
  assert.equal(rejectedRisk.error, 'WALLET_PORTFOLIO_EQUITY_LOW');
  assert.equal(rejectedRisk.portfolioRisk.phase, 'sign');
  assert.equal(
    await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']),
    beforeRiskNonce,
  );
  const allowedRisk = await prepareRisk('within-equity', 1000000n, riskRecipient);
  const sentRisk = await riskService.broadcast(allowedRisk.id);
  assert.equal(sentRisk.status, 'submitted');
  assert.equal(
    (await until(() => rpc('eth_getTransactionReceipt', [sentRisk.hash]))).status,
    '0x1',
  );
  assert.equal(await balance(chainInfo.usdc, riskRecipient), recipientBefore + 1000000n);
  const riskNonce = await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']);
  const duringRisk = await prepareRisk('equity-drops-during-sign', 2000000n, riskRecipient);
  const realSign = riskService.signer.bind(riskService);
  riskService.signer = async (action, input) => {
    const result = await realSign(action, input);
    if (action === 'sign' && input.id === riskWallet.id) {
      await rpc('anvil_setBalance', [riskWallet.address, toBeHex(100000000000000000n)]);
      await rpc('evm_mine');
    }
    return result;
  };
  try {
    const stoppedRisk = await riskService.broadcast(duringRisk.id);
    assert.equal(stoppedRisk.error, 'WALLET_PORTFOLIO_EQUITY_LOW');
    assert.equal(stoppedRisk.portfolioRisk.phase, 'broadcast');
    assert.equal(stoppedRisk.submissionMayHaveOccurred, false);
    assert.equal(await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']), riskNonce);
    assert.equal(await balance(chainInfo.usdc, riskRecipient), recipientBefore + 1000000n);
    assert.equal(
      (await walletCall('portfolio.get', { id: riskPortfolio.portfolio.id })).usage.transactions,
      2,
    );
  } finally {
    riskService.signer = realSign;
  }
  await rpc('anvil_impersonateAccount', [riskWallet.address]);
  try {
    const approve = async (to, data) => {
      const hash = await rpc('eth_sendTransaction', [
        { from: riskWallet.address, to, data, gas: '0x40000' },
      ]);
      assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
    };
    const expiry = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp) + 300n;
    await approve(chainInfo.usdc, token.encodeFunctionData('approve', [riskRecipient, 3000000n]));
    await approve(chainInfo.usdc, token.encodeFunctionData('approve', [PERMIT2, 5000000n]));
    const grantInner = new Interface(['function approve(address,address,uint160,uint48)']);
    await approve(
      PERMIT2,
      grantInner.encodeFunctionData('approve', [chainInfo.usdc, riskRecipient, 2000000n, expiry]),
    );
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [riskWallet.address]);
  }
  const riskMarket = riskService.market;
  const realRiskRpc = riskMarket.rpc.bind(riskMarket);
  riskMarket.rpc = (chainKey, _url, method, params, options) =>
    realRiskRpc(chainKey, endpoint, method, params, options);
  try {
    await walletCall('lock', { id: riskWallet.id });
    const nonce = await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']);
    const id = riskPortfolio.portfolio.id;
    const report = await walletCall('portfolio.allowances.scan', {
      id,
      token: chainInfo.usdc,
      blocks: 25,
    });
    assert.equal(report.coverage.scanIncomplete, false);
    assert.equal(report.coverage.scannedRanges.length, 1);
    assert.equal(report.totals[0].balance.amount, '9');
    assert.equal(report.totals[0].measured.amount, '5');
    assert.equal(report.totals[0].includingPermit2.amount, '8');
    assert.ok(
      report.items.some(
        (row) =>
          row.protocol === 'permit2' && row.source === 'events' && row.spendable.amount === '2',
      ),
    );
    const stored = await walletCall('portfolio.allowances.get', { id, reportId: report.reportId });
    assert.deepEqual(stored.totals, report.totals);
    assert.equal(await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']), nonce);
    await walletCall('portfolio.allowanceMonitor.start', {
      id,
      reportId: report.reportId,
      expectedRevision: 0,
    });
    const spender = '0x' + '8'.repeat(40);
    await rpc('anvil_impersonateAccount', [riskWallet.address]);
    try {
      const hash = await rpc('eth_sendTransaction', [
        {
          from: riskWallet.address,
          to: chainInfo.usdc,
          data: token.encodeFunctionData('approve', [spender, 1000000n]),
          gas: '0x40000',
        },
      ]);
      assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
    } finally {
      await rpc('anvil_stopImpersonatingAccount', [riskWallet.address]);
    }
    const afterApprove = await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']);
    await riskService.portfolios.allowanceMonitor.tick(Number.MAX_SAFE_INTEGER);
    const monitor = await walletCall('portfolio.allowanceMonitor.get', { id });
    assert.equal(monitor.status, 'watching');
    assert.equal(monitor.notices.length, 1);
    assert.equal(monitor.notices[0].pairs[0].spender, spender);
    assert.equal(monitor.notices[0].increases[0].after.amount, '6');
    assert.equal(
      await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']),
      afterApprove,
    );
    const evidence = await walletCall('portfolio.allowanceMonitor.get', {
      id,
      includeReport: true,
    });
    assert.equal(
      evidence.report.coverage.monitoredRange.fromBlock,
      String(BigInt(report.block) + 1n),
    );
    assert.equal(evidence.report.blockHash, monitor.notices[0].blockHash);
    await walletCall('portfolio.allowanceMonitor.stop', { id, expectedRevision: monitor.revision });

    const capChallenge = await walletCall('portfolio.challenge', {
      operation: 'allowance-ceiling',
      id,
      revision: riskPortfolio.revision,
      ceiling: { reportId: report.reportId, token: chainInfo.usdc, amount: '10' },
    });
    const capRevision = await walletCall('portfolio.confirm', {
      challengeId: capChallenge.id,
      ack: 'ALLOW PORTFOLIO',
      confirmed: true,
    });
    assert.equal(capRevision.portfolio.allowanceCeiling.atoms, '10000000');
    const floorOff = await walletCall('portfolio.challenge', {
      operation: 'edit',
      id,
      revision: capRevision.revision,
      limits: {},
      equityFloorUsd: '',
    });
    await walletCall('portfolio.confirm', {
      challengeId: floorOff.id,
      ack: 'ALLOW PORTFOLIO',
      confirmed: true,
    });
    await walletCall('unlock', { id: riskWallet.id, password: equityPassword, minutes: 0 });
    const approveWithApp = async (commandId, spender, value) => {
      const intent = await riskService.prepare(
        { venue: 'base', rpcUrl: endpoint },
        {
          commandId,
          to: chainInfo.usdc,
          value: '0',
          walletId: riskWallet.id,
          data: token.encodeFunctionData('approve', [spender, value]),
        },
      );
      await riskService.decide(intent.id, true, intent.digest);
      return riskService.broadcast(intent.id);
    };
    const nextSpender = '0x' + '6'.repeat(40);
    const overCap = await approveWithApp('over-ceiling', nextSpender, 2000000n);
    assert.equal(overCap.error, 'WALLET_PORTFOLIO_ALLOWANCE_EXCEEDED');
    assert.equal(overCap.portfolioAllowanceRisk.phase, 'sign');
    assert.equal(overCap.portfolioAllowanceRisk.projected, '11');
    assert.equal(
      await rpc('eth_getTransactionCount', [riskWallet.address, 'latest']),
      afterApprove,
    );
    riskService.signer = async (action, input) => {
      const response = await realSign(action, input);
      if (action === 'sign' && input.id === riskWallet.id) {
        await rpc('anvil_impersonateAccount', [riskWallet.address]);
        try {
          const hash = await rpc('eth_sendTransaction', [
            {
              from: riskWallet.address,
              to: chainInfo.usdc,
              data: token.encodeFunctionData('approve', [riskRecipient, 4000000n]),
              gas: '0x40000',
            },
          ]);
          assert.equal((await until(() => rpc('eth_getTransactionReceipt', [hash]))).status, '0x1');
        } finally {
          await rpc('anvil_stopImpersonatingAccount', [riskWallet.address]);
        }
      }
      return response;
    };
    try {
      const raced = await approveWithApp('race-ceiling', nextSpender, 1000000n);
      assert.equal(raced.error, 'WALLET_PORTFOLIO_ALLOWANCE_EXCEEDED');
      assert.equal(raced.portfolioAllowanceRisk.phase, 'broadcast');
      assert.equal(raced.submissionMayHaveOccurred, false);
    } finally {
      riskService.signer = realSign;
    }
    const reduction = await approveWithApp('reduce-ceiling', riskRecipient, 3000000n);
    assert.equal(reduction.status, 'submitted');
    assert.equal(
      (await until(() => rpc('eth_getTransactionReceipt', [reduction.hash]))).status,
      '0x1',
    );
    const withinCap = await approveWithApp('within-ceiling', nextSpender, 1000000n);
    assert.equal(withinCap.status, 'submitted');
    assert.equal(withinCap.portfolioAllowanceRisk.projected, '10');
    assert.equal(
      (await until(() => rpc('eth_getTransactionReceipt', [withinCap.hash]))).status,
      '0x1',
    );
  } finally {
    riskMarket.rpc = realRiskRpc;
  }
  // Replace contracts only after live execution assertions on this disposable chain.
  for (const [name, targets] of Object.entries({
    ScenarioToken: [chainInfo.weth, chainInfo.usdc],
    ScenarioPool: addresses.Pool,
    ScenarioRouter: addresses.Router,
    ScenarioQuoter: addresses.Quoter,
  })) {
    const artifact = fixture.contracts[name];
    assert.equal(sha(Buffer.from(artifact.runtime.slice(2), 'hex')), artifact.sha256);
    for (const address of targets) await rpc('anvil_setCode', [address, artifact.runtime]);
  }
  await rpc('anvil_setStorageAt', [
    addresses.Pool[0],
    '0x' + '0'.repeat(64),
    '0x' + '0'.repeat(64),
  ]);
  const scenarioPool = new Interface(fixture.contracts.ScenarioPool.abi);
  const installPool = async (method) => {
    const tx = await rpc('eth_sendTransaction', [
      {
        from: funded,
        to: addresses.Pool[0],
        data: scenarioPool.encodeFunctionData(method),
        gas: '0xf4240',
      },
    ]);
    const receipt = await until(() => rpc('eth_getTransactionReceipt', [tx]));
    assert.equal(receipt.status, '0x1');
    return receipt;
  };
  await installPool('seed');
  const scenarioAnchor = await installPool('record');
  const anchorHeader = await rpc('eth_getBlockByHash', [scenarioAnchor.blockHash, false]);
  const scenarioEnd = Math.floor(Number(anchorHeader.timestamp) / 60) * 60 + 60;
  await rpc('evm_setNextBlockTimestamp', [scenarioEnd]);
  await rpc('anvil_mine', ['0x4', '0x1']);
  const scenarioProject = await call('workspace.create', {
    venue: 'base',
    name: 'Stateful local AMM',
  });
  await call('workspace.update', {
    id: scenarioProject.id,
    market: { interval: 60, rpcUrl: endpoint },
  });
  const scenarioTape = await call('base.history.capture', {
    id: scenarioProject.id,
    count: 1,
    endTime: scenarioEnd,
  });
  const args = { id: scenarioProject.id, datasetId: scenarioTape.id };
  const legs = [
    { side: 'sell', amountIn: '0.25' },
    { side: 'sell', amountIn: '0.25' },
    { side: 'buy', amountIn: '10' },
  ];
  const canonicalPool = () =>
    rpc('eth_call', [
      { to: addresses.Pool[0], data: scenarioPool.encodeFunctionData('slot0') },
      'latest',
    ]);
  const beforeScenario = await canonicalPool();
  const scenario = await call('run.amm.scenario', {
    ...args,
    config: { initialWeth: '1', legs, anchorBlock: Number(scenarioAnchor.blockNumber) },
  });
  const [a, b, c] = scenario.ammScenario.legs;
  assert.equal(scenario.ammScenario.anchor.blockHash, scenarioAnchor.blockHash);
  assert.equal(scenario.ammScenario.status, 'completed');
  assert.equal(a.deltaOutAtoms, '0');
  assert.equal(b.sqrtBeforeX96, a.sqrtAfterX96);
  assert.equal(a.timestamp, Number(anchorHeader.timestamp) + 2);
  assert.equal(b.timestamp, a.timestamp + 2);
  assert.ok(BigInt(b.deltaOutAtoms) < 0n);
  assert.ok(BigInt(c.deltaOutAtoms) > 0n);
  assert.equal(await canonicalPool(), beforeScenario);
  const savedScenario = await call('run.amm.scenario.get', {
    id: scenarioProject.id,
    runId: scenario.id,
  });
  assert.deepEqual(savedScenario.legs, scenario.ammScenario.legs);
  assert.deepEqual(await call('run.get', { id: scenarioProject.id, runId: scenario.id }), scenario);
  const failedScenario = await call('run.amm.scenario', {
    ...args,
    config: { initialWeth: '1', legs: [legs[0], { ...legs[1], minimumOut: '10000' }, legs[2]] },
  });
  assert.equal(failedScenario.ammScenario.status, 'stopped-on-revert');
  assert.equal(failedScenario.ammScenario.legs.length, 2);
  assert.equal(failedScenario.ammScenario.legs[1].status, 'reverted');
  assert.equal(await canonicalPool(), beforeScenario);
  console.log(
    '[quant-live-execution] PASS: native scheduling and signing, execution benchmarks and reconciliation, stateful AMM simulation and canonical isolation',
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
