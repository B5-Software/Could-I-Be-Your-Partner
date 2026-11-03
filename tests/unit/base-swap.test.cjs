/* SPDX-License-Identifier: GPL-3.0-or-later */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AbiCoder, Interface } = require('ethers');
const { executeBaseSwap, deployments } = require('../../src/main/services/quant/base-swap');
const { CHAINS } = require('../../src/main/services/quant/market-data');
const { decodeCall } = require('../../src/main/services/wallet');
// Independent reference ABI: Router02 omits the old SwapRouter tuple's deadline.
const router = new Interface([
  'function multicall(uint256 deadline,bytes[] calls) payable returns(bytes[])',
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns(uint256)',
]);
const token = new Interface(['function approve(address,uint256) returns(bool)']);
const coder = AbiCoder.defaultAbiCoder();
const pool = '0x' + 'b'.repeat(40);
const owner = '0x' + 'c'.repeat(40);
function fixture(options = {}) {
  const calls = [],
    sequence = [],
    intents = [];
  let quotes = 0;
  const chain = CHAINS.base;
  const wallet = { id: 'native-wallet', address: owner };
  const walletService = {
    state: { intents },
    wallet: () => wallet,
    publicIntent: structuredClone,
    async transact(_config, input, context) {
      sequence.push(input.commandId.endsWith(':approve') ? 'approve' : 'swap');
      calls.push(input);
      const record = {
        ...input,
        id: String(calls.length),
        workflowDigest: context.workflowDigest,
        status:
          options.approvalStatus && input.commandId.endsWith(':approve')
            ? options.approvalStatus
            : 'submitted',
        hash: '0x' + 'a'.repeat(64),
      };
      intents.push(record);
      return structuredClone(record);
    },
    async waitForInclusion(id) {
      sequence.push('included');
      return { ...intents.find((i) => i.id === id), status: options.inclusionStatus || 'included' };
    },
  };
  const market = {
    async base() {
      sequence.push('pool');
      return { pool: options.pool || pool, time: Math.floor(Date.now() / 1000) };
    },
    async rpc(_venue, _url, method, params) {
      if (method === 'eth_chainId') return '0x2105';
      assert.equal(method, 'eth_call');
      const { to, data } = params[0];
      if (to === chain.factory) return coder.encode(['address'], [pool]);
      if (to === deployments.base.quoter) {
        sequence.push('quote');
        return coder.encode(
          ['uint256', 'uint160', 'uint32', 'uint256'],
          [
            options.quote === undefined ? BigInt(++quotes) * 10n ** 15n : options.quote,
            0,
            0,
            100000,
          ],
        );
      }
      assert.equal(to, chain.usdc);
      if (data.startsWith('0x70a08231')) return coder.encode(['uint256'], [10n ** 12n]);
      assert.ok(data.startsWith('0xdd62ed3e'));
      return coder.encode(['uint256'], [options.allowance || 0]);
    },
  };
  const request = {
    market,
    walletService,
    config: { venue: 'base' },
    input: { walletId: wallet.id, side: 'buy', amountIn: '2.5' },
    commandId: 'stable-operation',
    workspaceId: 'project',
  };
  return { request, calls, sequence, intents };
}
test('swap validates canonical deployment and viable protection before any token approval', async () => {
  for (const [options, error] of [
    [{ pool: owner }, /NOT_CANONICAL/],
    [{ quote: 0n }, /NO_QUOTE/],
    [{ quote: 1n }, /TOO_SMALL_FOR_PROTECTION/],
  ]) {
    const f = fixture(options);
    await assert.rejects(executeBaseSwap(f.request), error);
    assert.equal(f.calls.length, 0);
  }
});
test('swap approves only the exact amount and requotes after inclusion with a fresh deadline', async () => {
  const f = fixture(),
    before = Math.floor(Date.now() / 1000);
  const result = await executeBaseSwap(f.request);
  assert.deepEqual(f.sequence, ['pool', 'quote', 'approve', 'included', 'pool', 'quote', 'swap']);
  const approval = token.parseTransaction({ data: f.calls[0].data });
  assert.equal(approval.args[0].toLowerCase(), deployments.base.router);
  assert.equal(approval.args[1], 2500000n);
  assert.equal(f.calls[1].data.slice(0, 10), '0x5ae401dc');
  const outer = router.parseTransaction({ data: f.calls[1].data });
  assert.ok(outer.args[0] >= BigInt(before + 120));
  assert.equal(outer.args[1].length, 1);
  assert.equal(outer.args[1][0].slice(0, 10), '0x04e45aaf');
  const args = router.parseTransaction({ data: outer.args[1][0] }).args[0];
  assert.equal(args[0].toLowerCase(), CHAINS.base.usdc);
  assert.equal(args[1].toLowerCase(), CHAINS.base.weth);
  assert.equal(args[2], 500n);
  assert.equal(args[3].toLowerCase(), owner);
  assert.equal(args[4], 2500000n);
  assert.equal(args[5], 1990000000000000n);
  assert.equal(f.calls[1].validUntil, Number(outer.args[0]) * 1000);
  assert.equal(result.submitted, true);
  assert.equal(result.complete, false);
});
test('an existing allowance needs one fresh quote; denied or unknown approvals never proceed to swap', async () => {
  const ready = fixture({ allowance: 2500000n });
  await executeBaseSwap(ready.request);
  assert.deepEqual(ready.sequence, ['pool', 'quote', 'swap']);
  for (const options of [
    { approvalStatus: 'denied' },
    { approvalStatus: 'submit-unknown' },
    { inclusionStatus: 'submit-unknown' },
  ]) {
    const f = fixture(options),
      result = await executeBaseSwap(f.request);
    assert.equal(result.complete, false);
    assert.equal(f.calls.length, 1);
  }
});
test('retry after a submitted swap returns durable outcome without another quote or payment', async () => {
  const f = fixture({ allowance: 2500000n });
  await executeBaseSwap(f.request);
  const sequence = structuredClone(f.sequence),
    result = await executeBaseSwap(f.request);
  assert.equal(result.resumed, true);
  assert.deepEqual(f.sequence, sequence);
  assert.equal(f.calls.length, 1);
  f.request.input.slippageBps = 100;
  await assert.rejects(executeBaseSwap(f.request), /COMMAND_CONFLICT/);
  assert.equal(f.calls.length, 1);
});
test('human approval decodes actual swap amounts only for the supported official router call', async () => {
  const f = fixture({ allowance: 2500000n });
  await executeBaseSwap(f.request);
  const transaction = f.calls[0],
    meaning = decodeCall(transaction.to, transaction.data, 0n, 8453);
  assert.equal(meaning.kind, 'uniswap-v3-swap');
  assert.equal(meaning.amountIn, '2.5');
  assert.equal(meaning.minimumAmountOut, '0.000995');
  assert.equal(meaning.tokenIn, 'USDC');
  assert.equal(meaning.tokenOut, 'WETH');
  assert.equal(decodeCall(owner, transaction.data, 0n, 8453).kind, 'contract-call');
  const outer = router.parseTransaction({ data: transaction.data });
  const extra = router.encodeFunctionData('multicall', [
    outer.args[0],
    [outer.args[1][0], outer.args[1][0]],
  ]);
  assert.equal(decodeCall(transaction.to, extra, 0n, 8453).kind, 'contract-call');
  const approval = token.encodeFunctionData('approve', [transaction.to, 2500000n]);
  assert.equal(decodeCall(CHAINS.base.usdc, approval, 0n, 8453).tokenAmount, '2.5');
  const unknown = decodeCall(owner, approval, 0n, 8453);
  assert.equal(unknown.deploymentRecognized, false);
  assert.equal(unknown.calldata, approval);
});
