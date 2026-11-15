/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Interface, Transaction, keccak256 } = require('ethers');
const { historicalFee } = require('../../src/main/services/quant/amm-replay-cost');
const { deployments, routerAbi } = require('../../src/main/services/quant/base-swap');
const { CHAINS } = require('../../src/main/services/quant/market-data');

const abi = new Interface(['function getL1Fee(bytes)', 'function getOperatorFee(uint256)']);
const blockHash = '0x' + 'ab'.repeat(32);
const pool = '0x' + 'cd'.repeat(20);
const word = (n) => n.toString(16).padStart(64, '0');

test('historical replay fees pin L1 data, operator and spot conversion to the execution block', async () => {
  const chain = CHAINS.base;
  let envelope;
  let operatorCalls = 0;
  const data = {
    group: { blockHash, time: 1746806401 },
    header: { baseFeePerGas: '0x10', gasLimit: '0x200000' },
    chain,
    deployment: deployments.base,
    pool,
    token0: chain.weth,
    fee: 500,
    config: { routerOverheadGas: 55000, tipGwei: '0.000000001' },
    quote: {
      gas: 100000n,
      tokenIn: chain.usdc,
      tokenOut: chain.weth,
      amountIn: 1234567n,
      amountOut: 987654n,
    },
    rpc: async (method, [call, tag]) => {
      assert.equal(method, 'eth_call');
      assert.deepEqual(tag, { blockHash, requireCanonical: true });
      if (call.to === pool) return '0x' + word(2n ** 86n) + '0'.repeat(6 * 64);
      assert.equal(call.to, '0x420000000000000000000000000000000000000f');
      const decoded = abi.parseTransaction({ data: call.data });
      if (decoded.name === 'getL1Fee') {
        envelope = decoded.args[0];
        return '0x' + word(200001n);
      }
      assert.equal(decoded.args[0], 155000n);
      operatorCalls++;
      return '0x' + word(100003n);
    },
  };
  const cost = await historicalFee(data);
  assert.equal(cost.gasUnits, '155000');
  assert.equal(cost.l2Wei, '2635000');
  assert.equal(cost.totalWei, '2935004');
  assert.equal(cost.usdcAtoms, '3');
  assert.equal(cost.unsignedTxHash, keccak256(envelope));
  const tx = Transaction.from(envelope);
  assert.equal(tx.signature, null);
  assert.equal(tx.chainId, 8453n);
  assert.equal(tx.to.toLowerCase(), deployments.base.router);
  const [deadline, calls] = routerAbi.decodeFunctionData('multicall', tx.data);
  assert.equal(deadline, BigInt(data.group.time + 180));
  const [swap] = routerAbi.decodeFunctionData('exactInputSingle', calls[0]);
  assert.equal(swap.amountIn, 1234567n);
  assert.equal(swap.amountOutMinimum, 987654n);
  assert.equal(operatorCalls, 1);

  data.group.time--;
  const earlier = await historicalFee(data);
  assert.equal(earlier.operatorActive, false);
  assert.equal(earlier.operatorWei, '0');
  assert.equal(operatorCalls, 1);
  data.header.baseFeePerGas = undefined;
  await assert.rejects(historicalFee(data), /AMM_REPLAY_FEE_HEADER/);
  data.header = { baseFeePerGas: '0x1', gasLimit: '0x1' };
  await assert.rejects(historicalFee(data), /AMM_REPLAY_FEE_GAS_LIMIT/);
});
